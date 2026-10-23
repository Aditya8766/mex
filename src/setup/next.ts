/**
 * `mex setup next`: the one-paste setup for agents MEX cannot launch itself.
 *
 * The user pastes one short prompt into their agent: run `mex setup next` and
 * do what it prints, until it says setup is complete. Each call:
 *
 * 1. settles the unit the previous call handed out: MEX applies the batch file
 *    the unit wrote, in-process, through the same path as background setup
 *    (`wiki apply --apply`, one atomic batch, replay per opId), or hands back
 *    that unit's fix task with the refusal diagnostics and candidates;
 * 2. records the progress in the stored setup plan;
 * 3. hands out the next unit as a task file (the shared files, one subsystem,
 *    the final pass, or for small repositories the whole population), with the
 *    exact next command; after the last unit it finalizes Graph and Wiki and
 *    prints the completion summary.
 *
 * Every call is safe to repeat: the unit handed out last is recorded, batches
 * replay by opId, an unchanged refused batch is not counted as a second try,
 * and a crashed or abandoned chat continues where the stored plan says.
 */
import { createHash } from "node:crypto";
import {
  existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { loadConfiguredAiTools } from "../config.js";
import { describeGroundingDrift } from "../graph/grounding-failures.js";
import { SetupError } from "./errors.js";
import { runHeadlessSetup } from "./headless.js";
import { isScaffoldPopulated, setupCommitCheckpointCommands, SetupFinalizationError, type ProjectState, type SetupMode } from "./index.js";
import { buildSetupPopulationPrompt, buildSetupGraph, resolveSetupMode } from "./phases.js";
import {
  POPULATION_FINISH,
  SHARED_CONTEXT_FILES,
  buildBatchFixPrompt,
  buildFinalPassPrompt,
  buildSharedFilesPrompt,
  buildSubsystemPrompt,
  type SubsystemPromptEntry,
} from "./prompts.js";
import { createSetupBatchApplier, type BatchApplyOutcome, type BatchProblem, type BatchScope, type SetupBatchApplier } from "./subsystem-apply.js";
import { renderPlanProgress, SETUP_PLAN_VIEW_FILE, shouldRunPerSubsystem } from "./subsystem-runs.js";
import {
  SHARED_UNIT_SLUG,
  createPlanState,
  loadPlanState,
  savePlanState,
  subsystemWikiFile,
  unitBatchFile,
  type QueueUnitId,
  type SetupPlanState,
  type SubsystemUnit,
} from "./subsystem-state.js";
import { computeSubsystemPlan, type SubsystemPlan } from "./subsystems.js";
import { SETUP_NEXT_COMMAND, countSetupUnits, syncSetupNotice, unfinishedSetupLine } from "./unfinished.js";

/** Task files `mex setup next` hands out, ignored by Git with the rest of `.mex/local/`. */
export const SETUP_NEXT_DIRECTORY = ".mex/local/setup-next";
const LOCK_FILE = ".mex/local/setup-next.lock";
const BRIEF_FILE = ".mex/local/setup-next/brief.json";
/** A lock older than this is from a call that can no longer be running. */
const LOCK_STALE_MS = 6 * 60 * 60_000;
/** The same instructions are printed again this many times before a unit without a batch is skipped. */
const MISSING_BATCH_LIMIT = 3;

export interface SetupNextOptions {
  readonly projectRoot: string;
  readonly signal?: AbortSignal;
  readonly env?: NodeJS.ProcessEnv;
  /** Progress lines while MEX works (preparing, applying, finalizing); the result carries the instructions. */
  readonly onProgress?: (line: string) => void;
  /** Test seams. */
  readonly applier?: () => SetupBatchApplier;
  readonly refreshGraph?: () => Promise<void>;
  readonly now?: () => number;
}

export interface SetupNextResult {
  /** `task`: a unit was handed out; `complete`: setup finished; `blocked`: nothing can proceed until the printed problem is fixed. */
  readonly status: "task" | "complete" | "blocked";
  /** What to print, ending with the exact next command. */
  readonly output: string;
  readonly exitCode: number;
  readonly progress: { readonly done: number; readonly total: number } | null;
  /** The task file handed out, relative to the project root. */
  readonly taskFile?: string;
}

interface Unit {
  readonly id: QueueUnitId;
  readonly kind: "shared" | "subsystem" | "final" | "single";
  readonly label: string;
  readonly progress: { state: string; reason?: string; facts?: number; applied?: boolean; runs: unknown[] };
  readonly batchFile?: string;
  readonly scope?: BatchScope;
  readonly subsystem?: SubsystemUnit;
}

function opIdPrefix(slug: string): string {
  return `setup_${slug.replace(/-/gu, "_")}_`;
}

function folder(path: string, remainder?: boolean): string {
  return `${path}/${remainder ? " (own files)" : ""}`;
}

/** Run one step of the one-paste setup. Never throws for an expected problem: the output says what to do. */
export async function runSetupNext(options: SetupNextOptions): Promise<SetupNextResult> {
  const root = resolve(options.projectRoot);
  const mexDir = resolve(root, ".mex");
  const progress = (line: string) => { try { options.onProgress?.(line); } catch { /* observation only */ } };
  let mode: SetupMode;
  try { mode = resolveSetupMode(mexDir); }
  catch (error) { return blocked(error instanceof SetupError ? error.userMessage : String(error)); }
  if (mode === "code-repo" && !existsSync(resolve(root, ".git"))) {
    return blocked("No Git repository found. Run `git init` first, then run `mex setup next` again.");
  }
  mkdirSync(resolve(root, ".mex", "local"), { recursive: true });
  const release = acquireLock(root, options.now ?? Date.now);
  if (release === null) {
    return blocked(`Another \`${SETUP_NEXT_COMMAND}\` is running in this project. Wait for it to finish, then run \`${SETUP_NEXT_COMMAND}\` again.`);
  }
  try {
    return await step(root, mexDir, mode, options, progress);
  } catch (error) {
    const message = error instanceof SetupError ? error.userMessage : error instanceof Error ? error.message : String(error);
    return blocked(`${message} Fix the problem, then run \`${SETUP_NEXT_COMMAND}\` again; finished work is kept.`);
  } finally {
    release();
  }
}

async function step(
  root: string, mexDir: string, savedMode: SetupMode, options: SetupNextOptions, progress: (line: string) => void,
): Promise<SetupNextResult> {
  const notes: string[] = [];
  const loaded = loadPlanState(root);
  if (loaded.notice) notes.push(`Warning: ${loaded.notice}`);
  let state = loaded.state;
  let mode = savedMode;
  if (state !== null && state.queue === undefined) {
    // Background sessions stopped part-way: this flow continues the same plan.
    state.queue = { mode: "units" };
  }
  if (state === null) {
    // A stored plan that could not be used was set aside: plan again, even over filled shared files.
    const started = await startQueue(root, mexDir, options, progress, loaded.notice !== undefined);
    state = started.state;
    mode = started.mode;
  }
  const queue = state.queue!;
  const save = () => {
    savePlanState(root, state!, new Date((options.now ?? Date.now)()));
    try {
      mkdirSync(dirname(resolve(root, SETUP_PLAN_VIEW_FILE)), { recursive: true });
      writeFileSync(resolve(root, SETUP_PLAN_VIEW_FILE), renderPlanProgress(state!), "utf8");
    } catch { /* the JSON state is the record */ }
  };
  if (queue.finalized === true) {
    syncSetupNotice(root, null);
    return { status: "complete", exitCode: 0, progress: countSetupUnits(state), output: "MEX setup is already complete. There is nothing left to do." };
  }

  const units = listUnits(state);
  let applier: SetupBatchApplier | null = null;
  const apply = async (unit: Unit): Promise<BatchApplyOutcome> => {
    applier ??= (options.applier ?? (() => createSetupBatchApplier(root)))();
    progress(`Applying the batch for ${unit.label}…`);
    let outcome = await applyOnce(applier, unit);
    if (outcome.kind === "refused" && outcome.problems.some(isGraphProblem)) {
      // The code changed since the graph was built (hours can pass between calls): refresh it once and retry.
      progress("The code graph is out of date; refreshing it…");
      await (options.refreshGraph ?? (() => buildSetupGraph(root, { signal: options.signal })))();
      await applier.close().catch(() => undefined);
      applier = (options.applier ?? (() => createSetupBatchApplier(root)))();
      outcome = await applyOnce(applier, unit);
    }
    return outcome;
  };

  try {
    // 1. Settle the unit handed out last.
    const awaiting = queue.awaiting;
    if (awaiting !== undefined && awaiting.unit !== "finalize") {
      const unit = units.find((candidate) => candidate.id === awaiting.unit);
      if (unit === undefined || unit.progress.state === "done" || unit.progress.state === "skipped") {
        delete queue.awaiting;
      } else {
        const settled = await settle(root, mexDir, state, unit, awaiting, apply, notes);
        save();
        if (settled !== null) {
          // A task file that went missing (deleted, or a crash before it was written) is written again.
          const prompt = settled.prompt !== "" || settled.kind === "fix" ? settled.prompt : await writePrompt(root, state, unit, mode);
          return handOut(root, state, unit, settled.kind, prompt, notes, settled.note);
        }
      }
    }

    // 2. Hand out the next unit that is not settled. A batch an earlier run left
    //    on disk is applied first (replay by opId makes this safe).
    let next = units.find((unit) => unit.progress.state !== "done" && unit.progress.state !== "skipped");
    while (next !== undefined && next.batchFile !== undefined && next.progress.applied !== true && existsSync(resolve(root, next.batchFile))) {
      const outcome = await apply(next);
      if (outcome.kind !== "applied" || (next.kind === "shared" && !isScaffoldPopulated(mexDir))) break;
      next.progress.state = "done";
      next.progress.facts = outcome.facts;
      next.progress.applied = true;
      notes.push(`Applied the batch an earlier run left for ${next.label}: ${outcome.facts} fact${outcome.facts === 1 ? "" : "s"}.`);
      save();
      next = units.find((unit) => unit.progress.state !== "done" && unit.progress.state !== "skipped");
    }
    if (next !== undefined) {
      if (next.kind === "final" && !isScaffoldPopulated(mexDir)) {
        next.progress.state = "skipped";
        next.progress.reason = "the shared files are not filled yet";
        notes.push("Skipped the final pass: the shared files still have required placeholders.");
      } else {
        const prompt = await writePrompt(root, state, next, mode);
        queue.awaiting = {
          unit: next.id, kind: "write", repeats: 0,
          ...(next.kind === "final" ? { scaffoldHash: scaffoldHash(mexDir) } : {}),
        };
        next.progress.state = "running";
        save();
        return handOut(root, state, next, "write", prompt, notes);
      }
    }

    // 3. Everything is settled: finalize.
    save();
    return await finish(root, mexDir, mode, state, queue, notes, progress, save, options);
  } finally {
    if (applier !== null) await (applier as SetupBatchApplier).close().catch(() => undefined);
    if (state.queue?.finalized !== true) {
      syncSetupNotice(root, countSetupUnits(state));
      // A half-finished setup leaves a valid, readable Wiki (never `migration_required`); agent memory has none.
      const warning = mode === "code-repo" ? await ensureWikiIndexUsable(root) : null;
      if (warning !== null) progress(`Warning: ${warning}`);
    }
  }
}

/** Prepare once (scaffold, identity, scan, graph) and store a new plan for this flow. */
async function startQueue(
  root: string, mexDir: string, options: SetupNextOptions, progress: (line: string) => void, replacing: boolean,
): Promise<{ state: SetupPlanState; mode: SetupMode }> {
  progress("Preparing setup (scaffold, project scan and code graph); this runs once…");
  let lastGraphLine = 0;
  const prepared = await runHeadlessSetup({
    projectRoot: root,
    tools: existsSync(resolve(mexDir, "config.json")) ? loadConfiguredAiTools(mexDir) : [],
    confirmPopulation: true,
    stopBeforePopulation: true,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    onProgress: (update) => progress(`${update.label}${update.detail ? ` — ${update.detail}` : ""}`),
    onMessage: progress,
    onGraphProgress: (graph) => {
      const now = Date.now();
      if (now - lastGraphLine < 5_000) return;
      lastGraphLine = now;
      progress(`Building the code graph: ${graph.phase}${graph.total ? ` ${graph.completed ?? 0}/${graph.total}` : ""}`);
    },
  });
  const state = createQueueState(root, {
    mode: prepared.mode,
    projectState: prepared.preparation?.state ?? "existing",
    scannerBrief: prepared.preparation?.scannerBrief ?? null,
    ...(options.env === undefined ? {} : { env: options.env }),
    replacing,
  });
  return { state, mode: prepared.mode };
}

interface QueueStart {
  readonly mode: SetupMode;
  readonly projectState: ProjectState;
  readonly scannerBrief: string | null;
  readonly env?: NodeJS.ProcessEnv;
  /** An earlier plan was set aside: batches on disk replay, so plan subsystems even over filled shared files. */
  readonly replacing?: boolean;
}

/** Store a new plan for this flow: per-subsystem units for larger code repositories, else one unit. */
function createQueueState(root: string, start: QueueStart): SetupPlanState {
  const mexDir = resolve(root, ".mex");
  writeText(resolve(root, BRIEF_FILE), JSON.stringify({ state: start.projectState, brief: start.scannerBrief }));
  const populated = isScaffoldPopulated(mexDir);
  let state: SetupPlanState | null = null;
  if (start.mode === "code-repo" && start.projectState !== "fresh" && (!populated || start.replacing === true)) {
    const plan = computePlan(root);
    if (plan !== null && shouldRunPerSubsystem({ plan, resuming: false, ...(start.env === undefined ? {} : { env: start.env }) })) {
      state = createPlanState(plan);
      state.queue = { mode: "units" };
    }
  }
  if (state === null) {
    // Small or fresh repositories and agent memory: the whole population is one unit.
    state = createPlanState(EMPTY_PLAN);
    state.queue = { mode: "single" };
    state.final.state = "done";
    if (populated) state.shared.state = "done";
  }
  savePlanState(root, state);
  return state;
}

/**
 * When `mex setup` pauses with no agent to run, record the plan for `mex setup
 * next` (unless one is stored already) and put the managed block in place.
 * Returns the status line.
 */
export async function prepareSetupQueue(projectRoot: string, start: QueueStart): Promise<{ line: string; done: number; total: number }> {
  const root = resolve(projectRoot);
  let state = loadPlanState(root).state;
  if (state !== null && state.queue === undefined) {
    // Background sessions stopped part-way: `mex setup next` continues the same plan.
    state.queue = { mode: "units" };
    savePlanState(root, state);
  }
  if (state === null || state.queue?.finalized === true) state = createQueueState(root, start);
  const counts = countSetupUnits(state);
  syncSetupNotice(root, counts);
  if (start.mode === "code-repo") await ensureWikiIndexUsable(root);
  return { ...counts, line: unfinishedSetupLine(counts.done, counts.total, "queue") };
}

/** A plan with no subsystems, for the single-unit form (the real plan is computed when the prompt is written). */
const EMPTY_PLAN: SubsystemPlan = { source: "tree", ranking: "size", sourceFiles: 0, target: { min: 0, max: 0 }, candidates: [] };

function listUnits(state: SetupPlanState): Unit[] {
  if (state.queue?.mode === "single") {
    return [{ id: "single", kind: "single", label: "the scaffold population", progress: state.shared }];
  }
  return [
    {
      id: "shared", kind: "shared", label: "the shared files", progress: state.shared,
      batchFile: unitBatchFile(SHARED_UNIT_SLUG), scope: { opIdPrefix: opIdPrefix(SHARED_UNIT_SLUG), files: [...SHARED_CONTEXT_FILES] },
    },
    ...state.subsystems.map((unit): Unit => ({
      id: `subsystem:${unit.slug}`, kind: "subsystem", label: `subsystem ${folder(unit.path, unit.remainder)}`, progress: unit, subsystem: unit,
      batchFile: unitBatchFile(unit.slug), scope: { opIdPrefix: opIdPrefix(unit.slug), files: [subsystemWikiFile(unit.slug)] },
    })),
    { id: "final", kind: "final", label: "patterns, routing rows and edges", progress: state.final },
  ];
}

async function applyOnce(applier: SetupBatchApplier, unit: Unit): Promise<BatchApplyOutcome> {
  try {
    return await applier.apply(unit.batchFile!, unit.scope!);
  } catch (error) {
    return { kind: "refused", problems: [{ code: "SETUP_APPLY_FAILED", message: error instanceof Error ? error.message : String(error) }] };
  }
}

/** Refusals that come from the code graph, not from the batch. */
function isGraphProblem(problem: BatchProblem): boolean {
  return /^(?:GRAPH_|CODE_GRAPH_)/u.test(problem.code) || problem.code === "GROUNDING_STALE"
    || (problem.code === "SETUP_APPLY_FAILED" && /\bgraph\b/iu.test(problem.message));
}

type Settled = { kind: "write" | "fix"; prompt: string; note?: string } | null;

/**
 * Settle the unit handed out last. Returns the instructions to hand out again
 * (a fix task, or the same task when nothing arrived), or `null` when the unit
 * is settled (done or skipped) and the next one can go out.
 */
async function settle(
  root: string, mexDir: string, state: SetupPlanState, unit: Unit,
  awaiting: NonNullable<NonNullable<SetupPlanState["queue"]>["awaiting"]>,
  apply: (unit: Unit) => Promise<BatchApplyOutcome>, notes: string[],
): Promise<Settled> {
  const queue = state.queue!;
  const done = (facts?: number, note?: string) => {
    unit.progress.state = "done";
    delete unit.progress.reason;
    if (facts !== undefined) unit.progress.facts = facts;
    if (unit.batchFile !== undefined) unit.progress.applied = true;
    delete queue.awaiting;
    removeTaskFile(root, unit.id);
    if (note) notes.push(note);
  };
  const skip = (reason: string) => {
    unit.progress.state = "skipped";
    unit.progress.reason = reason;
    delete queue.awaiting;
    removeTaskFile(root, unit.id);
    notes.push(`Warning: Skipped ${unit.label}: ${reason}. The rest continues.`);
  };
  const again = (note: string): Settled => {
    awaiting.repeats += 1;
    return { kind: awaiting.kind, prompt: readTaskFile(root, unit.id) ?? "", note };
  };

  if (unit.kind === "single") {
    if (isScaffoldPopulated(mexDir)) {
      done(undefined, "The scaffold is populated.");
      return null;
    }
    return again(`Required placeholders remain in ${placeholderFiles(mexDir).join(", ") || "the scaffold"}. The task is not finished yet.`);
  }

  if (unit.kind === "final") {
    if (scaffoldHash(mexDir) === awaiting.scaffoldHash && awaiting.repeats < 1) {
      return again("MEX sees no change in .mex/ since this task was handed out. Do the task below; if it truly needs no change, run `mex setup next` once more.");
    }
    done(undefined, "Patterns, routing rows and edges are recorded.");
    return null;
  }

  const batchPath = resolve(root, unit.batchFile!);
  const outcome = await apply(unit);
  if (outcome.kind === "applied") {
    if (unit.kind === "shared" && !isScaffoldPopulated(mexDir)) {
      unit.progress.applied = true;
      return again(`The shared facts are applied, but required placeholders remain in ${placeholderFiles(mexDir).join(", ")}. Fill them as the task describes.`);
    }
    done(outcome.facts, `Applied ${unit.label}: ${outcome.facts} fact${outcome.facts === 1 ? "" : "s"}${outcome.replayed ? " (already applied earlier)" : ""}.`);
    return null;
  }
  if (outcome.kind === "missing") {
    if (unit.kind === "shared" && isScaffoldPopulated(mexDir)) {
      done(0, "The shared files are filled (no facts batch was written).");
      return null;
    }
    if (awaiting.repeats + 1 >= MISSING_BATCH_LIMIT) {
      skip(`no batch file was written at ${unit.batchFile} after ${MISSING_BATCH_LIMIT} tries`);
      return null;
    }
    return again(`MEX found no batch file at ${unit.batchFile}. The task is not finished yet.`);
  }
  // Refused: one fix task with the refusal and candidates; a second refusal skips the unit.
  const hash = fileHash(batchPath);
  if (awaiting.kind === "fix") {
    if (hash === awaiting.batchHash && awaiting.repeats < 1) {
      return again("The batch file has not changed since the fix task was handed out. Do the fix task below.");
    }
    const first = outcome.problems[0];
    skip(`its batch was refused twice (${first?.code ?? "refused"}: ${(first?.message ?? "").slice(0, 200)})`);
    return null;
  }
  const prompt = buildBatchFixPrompt({
    label: unit.label,
    batchFile: unit.batchFile!,
    wikiFiles: unit.scope!.files,
    opIdPrefix: unit.scope!.opIdPrefix,
    diagnostics: outcome.problems,
  });
  queue.awaiting = { unit: unit.id, kind: "fix", repeats: 0, ...(hash === null ? {} : { batchHash: hash }) };
  return { kind: "fix", prompt, note: `MEX could not apply the batch for ${unit.label}; nothing from it was written. Fix it as the task below says.` };
}

async function writePrompt(root: string, state: SetupPlanState, unit: Unit, mode: SetupMode): Promise<string> {
  const entry = (subsystem: SubsystemUnit): SubsystemPromptEntry => ({
    path: subsystem.path,
    ...(subsystem.remainder ? { remainder: true } : {}),
    budget: subsystem.budget,
    wikiFile: subsystemWikiFile(subsystem.slug),
    batchFile: unitBatchFile(subsystem.slug),
    opIdPrefix: opIdPrefix(subsystem.slug),
  });
  const brief = readBrief(root);
  switch (unit.kind) {
    case "single": {
      const prompt = await buildSetupPopulationPrompt(mode, brief.state, brief.brief, root);
      // The agent was not launched by setup: `mex setup next` checks and finalizes, not `mex setup`.
      return prompt.replace(POPULATION_FINISH, QUEUE_POPULATION_FINISH);
    }
    case "shared":
      return buildSharedFilesPrompt({
        briefJson: brief.brief,
        batchFile: unitBatchFile(SHARED_UNIT_SLUG),
        opIdPrefix: opIdPrefix(SHARED_UNIT_SLUG),
        subsystems: state.subsystems.map(entry),
      });
    case "subsystem": {
      const subsystem = unit.subsystem!;
      const nested = subsystem.remainder
        ? state.subsystems.filter((other) => other !== subsystem && other.path.startsWith(`${subsystem.path}/`)).map((other) => other.path)
        : [];
      return buildSubsystemPrompt({ subsystem: entry(subsystem), nested });
    }
    case "final":
      return buildFinalPassPrompt({
        written: state.subsystems.filter((subsystem) => subsystem.state === "done").map(entry),
        skipped: state.subsystems.filter((subsystem) => subsystem.state !== "done"),
      });
  }
}

/** The single population prompt's closing paragraph in this flow. */
export const QUEUE_POPULATION_FINISH = `Finish: Do not commit .mex/ until setup has finalized Graph and Wiki.
When you are done, stop. \`mex setup next\` then checks the result and finalizes Graph and Wiki.`;

/** Write the task file and the short instructions that point at it. */
function handOut(
  root: string, state: SetupPlanState, unit: Unit, kind: "write" | "fix", prompt: string, notes: string[], note?: string,
): SetupNextResult {
  const relative = taskFile(unit.id);
  if (prompt !== "") writeText(resolve(root, relative), prompt);
  const counts = countSetupUnits(state);
  const lines = [
    `MEX setup ${counts.done}/${counts.total}: ${kind === "fix" ? `fix the batch for ${unit.label}` : unit.label}`,
    ...notes,
    ...(note ? [note] : []),
    "",
    `Next task: its instructions are in ${relative}.`,
    `- If you can start a subagent, start one with this task, in a fresh context, and wait for it to finish: "Read ${relative} and follow it exactly."`,
    "- Otherwise, read that file and follow it yourself, here.",
    `When the task is done, run \`${SETUP_NEXT_COMMAND}\`. Repeat until it prints that setup is complete.`,
  ];
  return { status: "task", exitCode: 0, progress: counts, taskFile: relative, output: lines.join("\n") };
}

async function finish(
  root: string, mexDir: string, mode: SetupMode, state: SetupPlanState, queue: NonNullable<SetupPlanState["queue"]>,
  notes: string[], progress: (line: string) => void, save: () => void, options: SetupNextOptions,
): Promise<SetupNextResult> {
  const counts = countSetupUnits(state);
  if (!isScaffoldPopulated(mexDir)) {
    // Only reachable when the shared unit was skipped: hand it out again rather than finalize a template scaffold.
    state.shared.state = "pending";
    delete state.shared.reason;
    save();
    return blocked([...notes, "The shared scaffold files still have required placeholders, so setup cannot finalize yet. "
      + `Run \`${SETUP_NEXT_COMMAND}\` to get that task again.`].join("\n"), counts);
  }
  let groundingNotice = "";
  if (mode === "code-repo") {
    progress("Finalizing: capturing grounding baselines and indexing the Wiki…");
    const { finalizeCodeRepoSetup } = await import("./index.js");
    const messages: string[] = [];
    try {
      const outcome = await finalizeCodeRepoSetup(root, mexDir, {
        selectedTools: [],
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        onMessage: (message) => { messages.push(message); progress(message); },
      });
      groundingNotice = [
        outcome.dropped.length > 0
          ? `Dropped ${outcome.dropped.length} unverifiable reference${outcome.dropped.length === 1 ? "" : "s"}.`
          : "",
        describeGroundingDrift(outcome.drift),
      ].filter(Boolean).join(" ");
    } catch (error) {
      if (!(error instanceof SetupFinalizationError)) throw error;
      const { buildSetupRepairPrompt } = await import("./finalize-repair.js");
      const prompt = buildSetupRepairPrompt(error.groundingFailures ?? [], error.wikiDiagnostics ?? []);
      writeText(resolve(root, taskFile("finalize")), prompt);
      queue.awaiting = { unit: "finalize", kind: "fix", repeats: 0 };
      save();
      return {
        status: "task", exitCode: 0, progress: counts, taskFile: taskFile("finalize"),
        output: [
          `MEX setup ${counts.done}/${counts.total}: finalize found problems`,
          ...notes,
          error.userMessage,
          "",
          `Next task: its instructions are in ${taskFile("finalize")}.`,
          "- Read that file and follow it yourself, here (it names `mex` commands to run).",
          `When the task is done, run \`${SETUP_NEXT_COMMAND}\` to finalize again.`,
        ].join("\n"),
      };
    }
  }
  queue.finalized = true;
  state.finalizedAt = new Date((options.now ?? Date.now)()).toISOString();
  delete queue.awaiting;
  removeTaskFile(root, "finalize");
  save();
  syncSetupNotice(root, null);
  const skipped = state.subsystems.filter((unit) => unit.state === "skipped");
  const covered = state.subsystems.filter((unit) => unit.state === "done");
  const facts = (state.shared.facts ?? 0) + covered.reduce((sum, unit) => sum + (unit.facts ?? 0), 0);
  const coverage = queue.mode === "units"
    ? `Subsystems covered: ${covered.length} of ${state.subsystems.length}, ${facts} facts written.`
      + (skipped.length === 0 ? "" : ` Skipped: ${skipped.map((unit) => `${unit.path}/ (${unit.reason ?? "skipped"})`).join("; ")}.`)
    : "";
  const tools = existsSync(resolve(mexDir, "config.json")) ? loadConfiguredAiTools(mexDir) : [];
  const commit = mode === "code-repo" ? setupCommitCheckpointCommands(tools) : [];
  return {
    status: "complete",
    exitCode: 0,
    progress: countSetupUnits(state),
    output: [
      ...notes,
      `MEX setup is complete.${coverage ? ` ${coverage}` : ""}${groundingNotice ? ` ${groundingNotice}` : ""}`,
      ...(mode === "code-repo"
        ? ["Graph and Wiki are ready. Ask the user to review and commit the MEX files:", ...commit.map((command) => `  ${command}`)]
        : ["Agent memory is ready."]),
      "There is nothing left to run; you can stop here.",
    ].join("\n"),
  };
}

function blocked(message: string, progress: { done: number; total: number } | null = null): SetupNextResult {
  return { status: "blocked", exitCode: 1, progress, output: message };
}

// ── Files ──

function taskFile(id: QueueUnitId): string {
  return `${SETUP_NEXT_DIRECTORY}/${id.replace(":", "-")}.md`;
}

function readTaskFile(root: string, id: QueueUnitId): string | null {
  try { return readFileSync(resolve(root, taskFile(id)), "utf8"); } catch { return null; }
}

function removeTaskFile(root: string, id: QueueUnitId): void {
  rmSync(resolve(root, taskFile(id)), { force: true });
}

function writeText(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, "utf8");
}

function readBrief(root: string): { state: ProjectState; brief: string | null } {
  try {
    const parsed = JSON.parse(readFileSync(resolve(root, BRIEF_FILE), "utf8")) as { state?: unknown; brief?: unknown };
    const state = parsed.state === "fresh" || parsed.state === "partial" ? parsed.state : "existing";
    return { state, brief: typeof parsed.brief === "string" ? parsed.brief : null };
  } catch {
    return { state: "existing", brief: null };
  }
}

function fileHash(path: string): string | null {
  try { return createHash("sha256").update(readFileSync(path)).digest("hex"); } catch { return null; }
}

/** A hash of the canonical scaffold (everything in `.mex/` but `local/` and the databases). */
function scaffoldHash(mexDir: string): string {
  const hash = createHash("sha256");
  const visit = (relative: string) => {
    let entries;
    try { entries = readdirSync(resolve(mexDir, relative), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)); }
    catch { return; }
    for (const entry of entries) {
      const path = relative === "" ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!(relative === "" && entry.name === "local")) visit(path);
      } else if (entry.isFile() && !/\.db(?:-[a-z]+)?$/iu.test(entry.name)) {
        hash.update(path);
        try { hash.update(readFileSync(resolve(mexDir, path))); } catch { hash.update("unreadable"); }
      }
    }
  };
  visit("");
  return hash.digest("hex");
}

/** The required scaffold files that still hold a template placeholder. */
function placeholderFiles(mexDir: string): string[] {
  return ["AGENTS.md", "ROUTER.md", ...SHARED_CONTEXT_FILES].filter((file) => {
    try {
      const content = readFileSync(resolve(mexDir, file), "utf8");
      return content.includes("[Project Name]") || content.includes("[YYYY-MM-DD]");
    } catch {
      return true;
    }
  }).map((file) => `.mex/${file}`);
}

/** One `mex setup next` at a time per project; a lock from a dead or very old call is taken over. */
function acquireLock(root: string, now: () => number): (() => void) | null {
  const path = resolve(root, LOCK_FILE);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      writeFileSync(path, JSON.stringify({ pid: process.pid, at: now() }), { encoding: "utf8", flag: "wx" });
      return () => { rmSync(path, { force: true }); };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let stale = true;
      try {
        const held = JSON.parse(readFileSync(path, "utf8")) as { pid?: unknown; at?: unknown };
        const age = typeof held.at === "number" ? now() - held.at : Number.POSITIVE_INFINITY;
        stale = age > LOCK_STALE_MS || typeof held.pid !== "number" || !isAlive(held.pid);
      } catch {
        stale = (() => { try { return now() - statSync(path).mtimeMs > 60_000; } catch { return true; } })();
      }
      if (!stale) return null;
      rmSync(path, { force: true });
    }
  }
  return null;
}

function isAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

function computePlan(root: string): SubsystemPlan | null {
  try { return computeSubsystemPlan(root); } catch { return null; }
}

/**
 * Keep the Wiki usable while setup is unfinished. Without an index, a scaffold
 * whose files are not yet migrated reads as `migration_required` (#268), which
 * blocks Wiki reads and the Hub. Rebuilding the disposable index over the
 * current files makes it valid and fresh without migrating templates the
 * agents are still filling; finalize migrates and indexes for real. Returns a
 * warning when the index could not be rebuilt.
 */
export async function ensureWikiIndexUsable(projectRoot: string): Promise<string | null> {
  const root = resolve(projectRoot);
  try {
    const { findConfig } = await import("../config.js");
    const { createWikiEngine } = await import("../wiki/service.js");
    const config = findConfig(root);
    const engine = createWikiEngine({
      scaffoldRoot: config.scaffoldRoot,
      ...(config.wiki?.exclude === undefined ? {} : { exclude: config.wiki.exclude }),
      ...(config.wiki?.readOnly === undefined ? {} : { readOnly: config.wiki.readOnly }),
    });
    const rebuilt = await engine.rebuildIndex();
    const error = rebuilt.diagnostics.find((entry) => entry.severity === "error");
    return error === undefined ? null : `The Wiki index could not be rebuilt (${error.code}); finalize rebuilds it.`;
  } catch (error) {
    return `The Wiki index could not be rebuilt (${error instanceof Error ? error.message : String(error)}); finalize rebuilds it.`;
  }
}
