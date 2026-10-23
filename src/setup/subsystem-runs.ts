/**
 * Per-subsystem population: one agent session per planned subsystem.
 *
 * On a larger code repository one long population session runs out of context
 * or stalls halfway, and an agent's judgment decides what is finished. Here MEX
 * drives the work from its stored plan instead:
 *
 * 1. one session fills the shared scaffold files;
 * 2. one fresh, small session per subsystem (up to three at once, as free memory
 *    allows) reads that subsystem's code with file tools, runs no `mex` command,
 *    writes one batch file and exits; MEX applies each batch in-process, one at a
 *    time, and marks the subsystem done;
 * 3. one last session writes patterns, routing rows and edges.
 *
 * A refused batch gets one short fix session; if it is refused again, or a
 * session fails, that subsystem is skipped with a warning and the rest go on.
 * Failures that are not a subsystem's fault (cancel, sign-in, usage limit, a
 * missing or broken agent CLI) stop the phase with a message saying a rerun of
 * `mex setup` continues. Every step is recorded, so a rerun keeps what is done.
 */
import { freemem } from "node:os";
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { AiTool } from "../types.js";
import type { BackgroundAgentTool } from "../agent-command.js";
import { isScaffoldPopulated } from "./index.js";
import {
  HeadlessPopulationError,
  launchHeadlessSetupPopulation,
  type HeadlessPopulationActivity,
  type HeadlessPopulationOptions,
  type HeadlessPopulationTranscript,
} from "./headless-population.js";
import { SetupPopulationError } from "./population.js";
import type { HeadlessPopulationLaunchResult } from "./headless-population.js";
import type { PopulationAgentUsage } from "./population-activity.js";
import {
  buildBatchFixPrompt,
  buildFinalPassPrompt,
  buildSharedFilesPrompt,
  buildSubsystemPrompt,
  SHARED_CONTEXT_FILES,
  type SubsystemPromptEntry,
} from "./prompts.js";
import { createSetupBatchApplier, type BatchApplyOutcome, type BatchProblem, type BatchScope, type SetupBatchApplier } from "./subsystem-apply.js";
import { ScopeGuard } from "./subsystem-scope.js";
import {
  SHARED_UNIT_SLUG,
  savePlanState,
  subsystemWikiFile,
  unitBatchFile,
  type SetupPlanState,
  type SubsystemUnit,
  type UnitRunRecord,
  type UnitState,
} from "./subsystem-state.js";
import type { SubsystemPlan } from "./subsystems.js";

/** Below this many indexed source files (the plan's size tier) one session is enough. */
export const PER_SUBSYSTEM_MIN_SOURCE_FILES = 300;
export const DEFAULT_PARALLEL_RUNS = 3;
export const MAX_PARALLEL_RUNS = 8;
/** Estimated memory one agent session uses at its peak (the CLI, its shells and search tools). */
export const AGENT_RUN_FOOTPRINT_BYTES = 1.5 * 1024 ** 3;
/** Never start a second or third session that would leave less free memory than this. */
export const FREE_MEMORY_FLOOR_BYTES = 2 * 1024 ** 3;
/** A session younger than this may still be growing; its full footprint stays reserved. */
const RAMP_UP_MS = 60_000;
/** This many sessions failing in a row, with no success between, is not the subsystems' fault. */
const CONSECUTIVE_FAILURE_LIMIT = 3;

/** A readable copy of the stored plan's progress (not Markdown, so the Wiki never indexes it). */
export const SETUP_PLAN_VIEW_FILE = ".mex/local/setup-plan.txt";

/** Environment switches: the per-subsystem path, and the session limit. */
export const PER_SUBSYSTEM_ENV = "MEX_SETUP_PER_SUBSYSTEM";
export const PARALLEL_RUNS_ENV = "MEX_SETUP_PARALLEL_RUNS";

/**
 * `force` takes the per-subsystem path even below the size tier (used to test it
 * on a small repository); `off` keeps the single session; `auto` decides by size.
 */
export function perSubsystemSwitch(env: NodeJS.ProcessEnv = process.env): "force" | "off" | "auto" {
  const value = env[PER_SUBSYSTEM_ENV]?.trim().toLowerCase();
  if (value === "1" || value === "force" || value === "on" || value === "true") return "force";
  if (value === "0" || value === "off" || value === "false") return "off";
  return "auto";
}

/** The session limit: the option, else the environment, else 3; always 1 to 8. */
export function resolveParallelRuns(option?: number, env: NodeJS.ProcessEnv = process.env): number {
  const raw = option ?? (env[PARALLEL_RUNS_ENV] === undefined ? undefined : Number(env[PARALLEL_RUNS_ENV]));
  if (raw === undefined || !Number.isFinite(raw)) return DEFAULT_PARALLEL_RUNS;
  return Math.max(1, Math.min(MAX_PARALLEL_RUNS, Math.floor(raw)));
}

/** Whether population takes the per-subsystem path. */
export function shouldRunPerSubsystem(input: {
  readonly plan: SubsystemPlan | null;
  readonly resuming: boolean;
  readonly env?: NodeJS.ProcessEnv;
}): boolean {
  const mode = perSubsystemSwitch(input.env);
  if (mode === "off") return false;
  if (input.resuming) return true;
  if (input.plan === null || input.plan.candidates.length === 0) return false;
  return mode === "force" || input.plan.sourceFiles >= PER_SUBSYSTEM_MIN_SOURCE_FILES;
}

export interface SetupCoverageProgress {
  readonly phase: "shared" | "subsystems" | "final" | "complete";
  readonly total: number;
  readonly done: number;
  readonly skipped: number;
  readonly subsystems: ReadonlyArray<{ readonly path: string; readonly state: UnitState }>;
}

export interface SubsystemPopulationOptions {
  readonly projectRoot: string;
  /** The stored or new plan state; updated and saved as work happens. */
  readonly state: SetupPlanState;
  readonly selectedTools: readonly AiTool[];
  /** The agent every session of this phase runs (MEX chose it once); otherwise each launch chooses. */
  readonly tool?: BackgroundAgentTool;
  readonly scannerBrief: string | null;
  readonly signal?: AbortSignal;
  readonly parallelRuns?: number;
  readonly onMessage?: (message: string) => void;
  readonly onCoverage?: (coverage: SetupCoverageProgress) => void;
  readonly onActivity?: (activity: HeadlessPopulationActivity) => void;
  readonly onTranscript?: (entry: HeadlessPopulationTranscript) => void;
  /** Test seams; production uses the headless agent launcher, `os.freemem` and the in-process applier. */
  readonly launch?: (input: HeadlessPopulationOptions) => Promise<HeadlessPopulationLaunchResult>;
  readonly applier?: SetupBatchApplier;
  readonly freeMemory?: () => number;
  readonly now?: () => number;
  /** Watch tracked source files for out-of-scope edits (default true). */
  readonly trackSource?: boolean;
}

export interface SubsystemPopulationOutcome {
  readonly tool: BackgroundAgentTool | null;
  /** The shared files are filled (no required placeholder remains). */
  readonly sharedDone: boolean;
  readonly covered: number;
  readonly total: number;
  readonly facts: number;
  readonly skipped: ReadonlyArray<{ readonly path: string; readonly reason: string }>;
  /** One sentence or two for the final setup message. */
  readonly summary: string;
}

/** Population stopped for a reason that is not one subsystem's fault; a rerun continues. */
export class SubsystemPhaseStoppedError extends SetupPopulationError {
  constructor(message: string, readonly category: string) {
    super(message);
    this.name = "SubsystemPhaseStoppedError";
  }
}

/** The agent launcher found no agent CLI it can run in the background. */
class MissingAgentError extends Error {}

const STOPPING_CATEGORIES: ReadonlySet<string> = new Set(["cancelled", "authentication", "usage_limit", "launch", "arguments", "prompt"]);

type UnitKind = "shared" | "subsystem" | "final";

interface WorkUnit {
  readonly kind: UnitKind;
  readonly label: string;
  readonly progress: { state: UnitState; reason?: string; facts?: number; applied?: boolean; runs: UnitRunRecord[] };
  readonly subsystem?: SubsystemUnit;
  readonly batchFile?: string;
  readonly scope?: BatchScope;
  readonly transcriptTag?: string;
  writePrompt(): string;
  allowed(path: string): boolean;
}

function opIdPrefix(slug: string): string {
  return `setup_${slug.replace(/-/gu, "_")}_`;
}

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const stop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("; "));
  return `${stop > max / 2 ? cut.slice(0, stop + 1) : cut.trimEnd()}…`;
}

function folder(path: string, remainder?: boolean): string {
  return `${path}/${remainder ? " (own files)" : ""}`;
}

function shortReason(error: unknown): string {
  if (error instanceof HeadlessPopulationError) return `the session failed (${error.category.replace("_", " ")})`;
  return "the session failed";
}

function failureCategory(error: unknown): string {
  if (error instanceof HeadlessPopulationError) return error.category;
  if (error instanceof MissingAgentError) return "missing_tool";
  return "unexpected";
}

function stopsPhase(error: unknown): boolean {
  if (error instanceof HeadlessPopulationError) return STOPPING_CATEGORIES.has(error.category);
  // A missing CLI, or an error MEX did not expect, is never a subsystem's fault.
  return true;
}

/** A readable view of the stored plan, next to it in `.mex/local/`. */
export function renderPlanProgress(state: SetupPlanState): string {
  const line = (label: string, unit: { state: UnitState; reason?: string; facts?: number }) =>
    `- [${unit.state === "done" ? "x" : " "}] ${label} — ${unit.state}${unit.facts === undefined ? "" : `, ${unit.facts} facts`}${unit.reason ? ` (${unit.reason})` : ""}`;
  return [
    "# MEX setup progress",
    "",
    `Written by MEX from ${".mex/local/setup-plan.json"}; do not edit. Rerun \`mex setup\` to continue.`,
    "",
    line("shared files", state.shared),
    ...state.subsystems.map((unit) => line(`${folder(unit.path, unit.remainder)} -> .mex/${subsystemWikiFile(unit.slug)}`, unit)),
    line("patterns, routing rows and edges", state.final),
    "",
  ].join("\n");
}

export async function runSubsystemPopulation(options: SubsystemPopulationOptions): Promise<SubsystemPopulationOutcome> {
  const projectRoot = resolve(options.projectRoot);
  const mexDir = resolve(projectRoot, ".mex");
  const { state } = options;
  const now = options.now ?? Date.now;
  const freeMemory = options.freeMemory ?? freemem;
  const launch = options.launch ?? launchHeadlessSetupPopulation;
  const limit = resolveParallelRuns(options.parallelRuns);
  const message = (text: string) => { try { options.onMessage?.(text); } catch { /* observation only */ } };
  const phase = new AbortController();
  const onAbort = () => phase.abort();
  options.signal?.addEventListener("abort", onAbort, { once: true });
  if (options.signal?.aborted) phase.abort();
  const applier = options.applier ?? createSetupBatchApplier(projectRoot);
  let lastTool: BackgroundAgentTool | null = null;
  let stopError: unknown = null;
  let consecutiveFailures = 0;
  let coveragePhase: SetupCoverageProgress["phase"] = "shared";
  const running = new Set<WorkUnit>();
  const startedAt = new Map<WorkUnit, number>();
  let finalNeeded = state.final.state !== "done";

  const save = () => {
    try {
      savePlanState(projectRoot, state, new Date(now()));
      const view = resolve(projectRoot, SETUP_PLAN_VIEW_FILE);
      mkdirSync(dirname(view), { recursive: true });
      writeFileSync(view, renderPlanProgress(state), "utf8");
    } catch (error) {
      // Losing the record must not lose the work: the batches on disk are replayed by opId.
      message(`Warning: Could not save setup progress (${error instanceof Error ? error.message : String(error)}). A rerun recognizes applied batches.`);
    }
  };
  const coverage = () => {
    const subsystems = state.subsystems.map((unit) => ({ path: unit.path, state: unit.state }));
    try {
      options.onCoverage?.({
        phase: coveragePhase,
        total: subsystems.length,
        done: subsystems.filter((unit) => unit.state === "done").length,
        skipped: subsystems.filter((unit) => unit.state === "skipped").length,
        subsystems,
      });
    } catch { /* observation only */ }
  };

  const nestedOf = (unit: SubsystemUnit) => unit.remainder
    ? state.subsystems.filter((other) => other !== unit && other.path.startsWith(`${unit.path}/`)).map((other) => other.path)
    : [];
  const promptEntry = (unit: SubsystemUnit): SubsystemPromptEntry => ({
    path: unit.path,
    ...(unit.remainder ? { remainder: true } : {}),
    budget: unit.budget,
    wikiFile: subsystemWikiFile(unit.slug),
    batchFile: unitBatchFile(unit.slug),
    opIdPrefix: opIdPrefix(unit.slug),
  });

  const sharedUnit: WorkUnit = {
    kind: "shared",
    label: "the shared files",
    progress: state.shared,
    batchFile: unitBatchFile(SHARED_UNIT_SLUG),
    scope: { opIdPrefix: opIdPrefix(SHARED_UNIT_SLUG), files: [...SHARED_CONTEXT_FILES] },
    writePrompt: () => buildSharedFilesPrompt({
      briefJson: options.scannerBrief,
      batchFile: unitBatchFile(SHARED_UNIT_SLUG),
      opIdPrefix: opIdPrefix(SHARED_UNIT_SLUG),
      subsystems: state.subsystems.map(promptEntry),
    }),
    allowed: (path) => [".mex/AGENTS.md", ".mex/ROUTER.md", ...SHARED_CONTEXT_FILES.map((file) => `.mex/${file}`)].includes(path),
  };
  const subsystemUnits: WorkUnit[] = state.subsystems.map((unit) => ({
    kind: "subsystem",
    label: `subsystem ${folder(unit.path, unit.remainder)}`,
    progress: unit,
    subsystem: unit,
    batchFile: unitBatchFile(unit.slug),
    scope: { opIdPrefix: opIdPrefix(unit.slug), files: [subsystemWikiFile(unit.slug)] },
    transcriptTag: unit.slug,
    writePrompt: () => buildSubsystemPrompt({ subsystem: promptEntry(unit), nested: nestedOf(unit) }),
    allowed: () => false,
  }));
  const finalUnit: WorkUnit = {
    kind: "final",
    label: "patterns, routing rows and edges",
    progress: state.final,
    writePrompt: () => buildFinalPassPrompt({
      written: state.subsystems.filter((unit) => unit.state === "done").map(promptEntry),
      skipped: state.subsystems.filter((unit) => unit.state !== "done"),
    }),
    allowed: (path) => path === ".mex/ROUTER.md" || /^\.mex\/context\/[^/]+\.md$/u.test(path) || path.startsWith(".mex/patterns/"),
  };

  let guard: ScopeGuard | null = null;
  try { guard = new ScopeGuard(projectRoot, { trackSource: options.trackSource !== false }); }
  catch { guard = null; }
  const reportScope = (changed: readonly string[], suspects: readonly WorkUnit[]) => {
    const unexpected = changed.filter((path) => !(suspects.length === 1 && suspects[0]!.allowed(path)));
    if (unexpected.length === 0) return;
    const who = suspects.length === 0
      ? "while no MEX session was running"
      : suspects.length === 1
        ? `by the session for ${suspects[0]!.label}, which may write only ${suspects[0]!.batchFile ?? "its own scaffold files"}${suspects[0]!.kind === "shared" ? " and the shared files" : ""}`
        : `while sessions for ${suspects.map((unit) => unit.label).join(", ")} were running`;
    const shown = unexpected.slice(0, 8).join(", ") + (unexpected.length > 8 ? `, and ${unexpected.length - 8} more` : "");
    message(`Warning: Files changed outside the expected scope ${who}: ${shown}. MEX did not revert anything; review these changes before committing.`);
  };

  let applyChain: Promise<unknown> = Promise.resolve();
  const applyUnit = (unit: WorkUnit): Promise<BatchApplyOutcome> => {
    const run = applyChain.then(async () => {
      if (guard) reportScope(guard.take(), [...running].filter((other) => other !== unit));
      const started = now();
      let outcome: BatchApplyOutcome;
      try {
        outcome = await applier.apply(unit.batchFile!, unit.scope!);
      } catch (error) {
        // An apply that throws (a lock held elsewhere, a disk error) is reported like a refusal.
        outcome = { kind: "refused", problems: [{ code: "SETUP_APPLY_FAILED", message: error instanceof Error ? error.message : String(error) }] };
      } finally {
        // What MEX itself just wrote is never blamed on a session.
        guard?.take();
      }
      if (outcome.kind !== "missing") {
        unit.progress.runs.push({
          kind: "apply", startedAt: new Date(started).toISOString(), durationMs: Math.max(0, now() - started),
          outcome: outcome.kind === "applied" ? "applied" : "refused",
          ...(outcome.kind === "refused" ? { failure: outcome.problems[0]?.code ?? "refused" } : {}),
        });
      }
      return outcome;
    });
    applyChain = run.catch(() => undefined);
    return run;
  };

  const runAgent = async (unit: WorkUnit, prompt: string, kind: "write" | "fix"): Promise<{ ok: true } | { ok: false; error: unknown }> => {
    const started = now();
    startedAt.set(unit, started);
    let usage: PopulationAgentUsage | undefined;
    let tool: BackgroundAgentTool | null = null;
    const record = (outcome: UnitRunRecord["outcome"], failure?: string) => {
      unit.progress.runs.push({
        kind, startedAt: new Date(started).toISOString(), durationMs: Math.max(0, now() - started), outcome, tool,
        ...(failure === undefined ? {} : { failure }), ...(usage === undefined ? {} : { usage }),
      });
    };
    try {
      const tag = unit.transcriptTag;
      const result = await launch({
        selectedTools: options.selectedTools,
        ...(options.tool === undefined ? {} : { tool: options.tool }),
        prompt,
        projectRoot,
        signal: phase.signal,
        ...(options.onActivity ? { onActivity: options.onActivity } : {}),
        ...(options.onTranscript ? {
          onTranscript: tag === undefined ? options.onTranscript : (entry) => options.onTranscript!({ ...entry, text: `[${tag}] ${entry.text}` }),
        } : {}),
        onUsage: (reported) => { usage = reported; },
      });
      tool = result.tool;
      if (result.tool === null) throw new MissingAgentError();
      if (!result.completed) throw new HeadlessPopulationError("protocol", result.tool);
      lastTool = result.tool;
      record("completed");
      return { ok: true };
    } catch (error) {
      const cancelled = phase.signal.aborted;
      record(cancelled ? "stopped" : "failed", cancelled ? "stopped" : failureCategory(error));
      return { ok: false, error: cancelled && !(error instanceof HeadlessPopulationError && error.category === "cancelled")
        ? new HeadlessPopulationError("cancelled") : error };
    }
  };

  const stopWith = (error: unknown) => {
    if (stopError === null) stopError = error;
    phase.abort();
  };

  const done = (unit: WorkUnit, facts: number | undefined, note?: string) => {
    unit.progress.state = "done";
    delete unit.progress.reason;
    if (facts !== undefined) unit.progress.facts = facts;
    if (unit.batchFile !== undefined) unit.progress.applied = true;
    consecutiveFailures = 0;
    if (unit.kind === "subsystem") finalNeeded = true;
    if (note) message(note);
  };
  const skip = (unit: WorkUnit, reason: string) => {
    unit.progress.state = "skipped";
    unit.progress.reason = reason;
    message(`Warning: Skipped ${unit.label}: ${reason}. Rerun \`mex setup\` to try it again; the rest continues.`);
  };

  /** A session failed: stop the phase, or record the failure and keep whatever valid batch it left. */
  const sessionFailed = async (unit: WorkUnit, error: unknown, after: "write" | "fix"): Promise<void> => {
    if (stopsPhase(error) || phase.signal.aborted) {
      unit.progress.state = "pending";
      stopWith(error);
      return;
    }
    // A session that failed after writing a valid batch still did its job.
    if (unit.batchFile !== undefined && after === "write" && existsSync(resolve(projectRoot, unit.batchFile))) {
      const outcome = await applyUnit(unit);
      if (outcome.kind === "applied") {
        done(unit, outcome.facts, `Warning: The session for ${unit.label} did not finish cleanly (${shortReason(error)}), but the batch it wrote was valid and is applied.`);
        return;
      }
    }
    consecutiveFailures += 1;
    if (consecutiveFailures >= CONSECUTIVE_FAILURE_LIMIT) {
      unit.progress.state = "pending";
      stopWith(new SubsystemPhaseStoppedError(
        `${CONSECUTIVE_FAILURE_LIMIT} agent sessions in a row failed (${error instanceof Error ? error.message : String(error)}), so this is not one subsystem's problem.`
          + " Check the agent CLI works on its own (sign-in, version, network).",
        failureCategory(error),
      ));
      return;
    }
    skip(unit, shortReason(error));
  };

  const archiveAppliedBatch = (unit: WorkUnit) => {
    const path = resolve(projectRoot, unit.batchFile!);
    if (!unit.progress.applied || !existsSync(path)) return;
    try { renameSync(path, path.replace(/\.json$/u, `.applied-${now()}.json`)); } catch { /* replay keeps a rewrite safe */ }
    unit.progress.applied = false;
  };

  const runUnit = async (unit: WorkUnit): Promise<void> => {
    running.add(unit);
    unit.progress.state = "running";
    delete unit.progress.reason;
    save();
    coverage();
    try {
      let problems: readonly BatchProblem[] | null = null;
      const batchPath = unit.batchFile === undefined ? null : resolve(projectRoot, unit.batchFile);
      // A batch an earlier run wrote but never applied is applied first; replay by opId makes this safe.
      if (batchPath !== null && !unit.progress.applied && existsSync(batchPath)) {
        const outcome = await applyUnit(unit);
        if (outcome.kind === "applied" && (unit.kind !== "shared" || isScaffoldPopulated(mexDir))) {
          done(unit, outcome.facts, `Applied the batch an earlier run left for ${unit.label}.`);
          return;
        }
        if (outcome.kind === "applied") unit.progress.applied = true;
        if (outcome.kind === "refused") problems = outcome.problems;
      }
      if (problems === null) {
        if (batchPath !== null) archiveAppliedBatch(unit);
        const written = await runAgent(unit, unit.writePrompt(), "write");
        if (guard) reportScope(guard.take(), running.size === 1 ? [unit] : [...running]);
        if (!written.ok) {
          await sessionFailed(unit, written.error, "write");
          return;
        }
        consecutiveFailures = 0;
        if (unit.batchFile === undefined) {
          done(unit, undefined);
          return;
        }
        const outcome = await applyUnit(unit);
        if (outcome.kind === "applied" || (outcome.kind === "missing" && unit.kind === "shared")) {
          done(unit, outcome.kind === "applied" ? outcome.facts : 0);
          return;
        }
        if (outcome.kind === "missing") {
          skip(unit, `the session wrote no batch file at ${unit.batchFile}`);
          return;
        }
        problems = outcome.problems;
      }
      // One short fix session with only the refusal and the file.
      const fixed = await runAgent(unit, buildBatchFixPrompt({
        label: unit.label,
        batchFile: unit.batchFile!,
        wikiFiles: unit.scope!.files,
        opIdPrefix: unit.scope!.opIdPrefix,
        diagnostics: problems,
      }), "fix");
      if (guard) reportScope(guard.take(), running.size === 1 ? [unit] : [...running]);
      if (!fixed.ok) {
        await sessionFailed(unit, fixed.error, "fix");
        return;
      }
      consecutiveFailures = 0;
      const outcome = await applyUnit(unit);
      if (outcome.kind === "applied") {
        done(unit, outcome.facts, `Fixed and applied the batch for ${unit.label}.`);
        return;
      }
      const first = outcome.kind === "refused" ? outcome.problems[0] : undefined;
      skip(unit, first === undefined
        ? "the fix session removed its batch file"
        : `its batch was refused twice (${first.code}: ${clip(first.message, 200)})`);
    } catch (error) {
      unit.progress.state = "pending";
      stopWith(error);
    } finally {
      running.delete(unit);
      if (unit.kind === "shared" && (unit.progress.state as UnitState) === "done" && !isScaffoldPopulated(mexDir)) {
        skip(unit, "required scaffold placeholders remain in the shared files");
      }
      save();
      coverage();
    }
  };

  const canStartAnother = (): boolean => {
    if (running.size === 0) return true;
    if (running.size >= limit) return false;
    // A running session younger than the ramp-up window may still be growing: keep its full footprint reserved.
    const ramping = [...running].filter((unit) => now() - (startedAt.get(unit) ?? 0) < RAMP_UP_MS).length;
    return freeMemory() - AGENT_RUN_FOOTPRINT_BYTES * (1 + ramping) >= FREE_MEMORY_FLOOR_BYTES;
  };

  try {
    save();
    // The shared files come first: every subsystem session reads them for context.
    if (state.shared.state !== "done" || !isScaffoldPopulated(mexDir)) {
      coveragePhase = "shared";
      await runUnit(sharedUnit);
    }
    if (stopError === null) {
      coveragePhase = "subsystems";
      coverage();
      const queue = subsystemUnits.filter((unit) => unit.progress.state !== "done");
      const active = new Map<WorkUnit, Promise<void>>();
      let warnedMemory = false;
      while (stopError === null && (queue.length > 0 || active.size > 0)) {
        while (stopError === null && queue.length > 0 && running.size < limit) {
          if (!canStartAnother()) {
            if (!warnedMemory) {
              warnedMemory = true;
              message(`Free memory is low (${(freeMemory() / 1024 ** 3).toFixed(1)} GB), so MEX runs fewer subsystem sessions at once.`);
            }
            break;
          }
          const unit = queue.shift()!;
          const settled = runUnit(unit).finally(() => { active.delete(unit); });
          active.set(unit, settled);
        }
        if (active.size === 0) break;
        await Promise.race(active.values());
      }
      await Promise.allSettled(active.values());
    }
    if (stopError === null && finalNeeded) {
      coveragePhase = "final";
      // Patterns and routes need the shared files filled; refused shared facts alone do not stop this.
      if (!isScaffoldPopulated(mexDir)) {
        state.final.state = "skipped";
        state.final.reason = "the shared files are not filled yet";
      } else {
        await runUnit(finalUnit);
      }
    }
    coveragePhase = stopError === null ? "complete" : coveragePhase;
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
    let changed = false;
    try { changed = (await applier.close()).changed; } catch { /* nothing held */ }
    if (changed) message("The code graph or Git HEAD changed during population, so MEX proved graph freshness again before the next apply; finalize verifies every reference against a refreshed graph.");
    save();
    coverage();
  }

  const doneUnits = state.subsystems.filter((unit) => unit.state === "done");
  const covered = doneUnits.length;
  const total = state.subsystems.length;
  const facts = (state.shared.facts ?? 0) + doneUnits.reduce((sum, unit) => sum + (unit.facts ?? 0), 0);
  const skipped = state.subsystems.filter((unit) => unit.state === "skipped")
    .map((unit) => ({ path: unit.path, reason: unit.reason ?? "skipped" }));

  if (stopError !== null) {
    // The user's cancel: every session was stopped and the progress is saved.
    if (options.signal?.aborted) throw new HeadlessPopulationError("cancelled");
    const base = stopError instanceof MissingAgentError
      ? "No supported agent CLI is available, so MEX could not start the subsystem sessions. Install or sign in to one, or run `mex setup next` in your agent's chat."
      : stopError instanceof Error ? stopError.message : String(stopError);
    throw new SubsystemPhaseStoppedError(
      `${base} Population stopped with ${covered} of ${total} subsystems done; rerun \`mex setup\` to continue where it stopped (done subsystems are kept).`,
      failureCategory(stopError),
    );
  }

  const skippedText = skipped.length === 0 ? "" : ` Skipped ${skipped.length}: ${skipped.slice(0, 4)
    .map((entry) => `${entry.path}/ (${entry.reason})`).join("; ")}${skipped.length > 4 ? "; …" : ""}. Rerun \`mex setup\` to try ${skipped.length === 1 ? "it" : "them"} again.`;
  return {
    tool: lastTool,
    sharedDone: state.shared.state === "done" && isScaffoldPopulated(mexDir),
    covered,
    total,
    facts,
    skipped,
    summary: `Subsystems covered: ${covered} of ${total}, ${facts} facts written.${skippedText}`,
  };
}
