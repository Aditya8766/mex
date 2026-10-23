/**
 * In-process application of the batch files per-subsystem setup sessions write.
 *
 * MEX applies each batch exactly as `mex wiki apply <file> --apply --json` would
 * (same command function: parsing, the Inbox Spec boundary, one atomic batch,
 * replay per opId), with two differences that make it cheap:
 *
 * - one freshness proof for the whole population phase: the code graph is
 *   opened once through its fresh grounding snapshot and held until the phase
 *   ends, instead of re-walking the repository for every apply. Agents of this
 *   phase write only under `.mex/`, and finalize verifies every reference against
 *   a refreshed graph afterwards, so nothing here can make an unverified claim
 *   stick;
 * - applies are serialized: two batches never apply at once.
 *
 * Before applying, MEX checks the batch stays in its lane: create-entry
 * operations only, every opId under the unit's prefix (so one unit can never
 * replay another's), and every target file one the unit may write.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { findConfig } from "../config.js";

/** One problem with a batch, in the form the fix prompt and the state file use. */
export interface BatchProblem {
  readonly code: string;
  readonly message: string;
}

export type BatchApplyOutcome =
  | { readonly kind: "applied"; readonly facts: number; readonly operations: number; readonly replayed: boolean; readonly warnings: readonly BatchProblem[] }
  | { readonly kind: "refused"; readonly problems: readonly BatchProblem[] }
  | { readonly kind: "missing" };

export interface BatchScope {
  /** Every opId must start with this. */
  readonly opIdPrefix: string;
  /** The Wiki files (relative to `.mex/`) the batch may write into. */
  readonly files: readonly string[];
}

export interface SetupBatchApplier {
  apply(batchFile: string, scope: BatchScope): Promise<BatchApplyOutcome>;
  /** Release the held graph snapshot. `changed` is true when sources moved during the phase. */
  close(): Promise<{ readonly changed: boolean }>;
}

/** A minimal structural view of the grounding snapshot the Wiki apply consumes. */
type GroundingSnapshot = Parameters<Parameters<import("../wiki/cli/grounding.js").WikiCliGroundingBridge["withFreshGroundingSnapshot"]>[0]>[0];

const MAX_PROBLEMS = 200;

function problem(code: string, message: string): BatchProblem {
  return { code, message: message.slice(0, 2_000) };
}

/** Read and scope-check a batch file before the Wiki engine sees it. */
export function checkBatchFile(path: string, scope: BatchScope): { ok: true; envelopes: unknown[] } | { ok: false; problems: BatchProblem[] } | { ok: "missing" } {
  if (!existsSync(path)) return { ok: "missing" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { ok: false, problems: [problem("MALFORMED_OPERATION", `The batch file is not valid JSON: ${reason}. Write one JSON array of operation envelopes.`)] };
  }
  const envelopes = Array.isArray(parsed) ? parsed : [parsed];
  const problems: BatchProblem[] = [];
  const allowed = new Set(scope.files);
  for (const [index, envelope] of envelopes.entries()) {
    const raw = typeof envelope === "object" && envelope !== null ? envelope as Record<string, unknown> : null;
    const opId = typeof raw?.["opId"] === "string" ? raw["opId"] : null;
    const label = `Operation ${index}${opId === null ? "" : ` (${opId})`}`;
    if (raw === null) {
      problems.push(problem("SETUP_BATCH_SCOPE", `${label}: is not an operation envelope object.`));
      continue;
    }
    if (raw["type"] !== "create-entry") {
      problems.push(problem("SETUP_BATCH_SCOPE", `${label}: setup batches hold create-entry operations only; found "${String(raw["type"])}".`));
    }
    if (opId === null || !opId.startsWith(scope.opIdPrefix) || opId.length === scope.opIdPrefix.length) {
      problems.push(problem("SETUP_BATCH_SCOPE", `${label}: every opId must start with "${scope.opIdPrefix}" and be unique.`));
    }
    const payload = typeof raw["payload"] === "object" && raw["payload"] !== null ? raw["payload"] as Record<string, unknown> : null;
    const file = typeof payload?.["file"] === "string" ? payload["file"].replace(/\\/gu, "/").replace(/^\.mex\//u, "") : null;
    if (file === null || !allowed.has(file)) {
      problems.push(problem("SETUP_BATCH_SCOPE", `${label}: "file" must be ${[...allowed].map((entry) => `"${entry}"`).join(" or ")}; found ${file === null ? "none" : `"${file}"`}.`));
    }
    if (problems.length >= MAX_PROBLEMS) break;
  }
  const ids = envelopes.map((envelope) => (envelope as Record<string, unknown> | null)?.["opId"]).filter((id) => typeof id === "string");
  const duplicate = ids.find((id, index) => ids.indexOf(id) !== index);
  if (duplicate !== undefined) problems.push(problem("SETUP_BATCH_SCOPE", `opId "${String(duplicate)}" is used twice; every opId must be unique.`));
  return problems.length > 0 ? { ok: false, problems } : { ok: true, envelopes };
}

function factCount(envelopes: readonly unknown[], statuses: readonly { index: number; status: string }[]): number {
  const written = new Set(statuses.filter((entry) => ["applied", "replayed", "resumed"].includes(entry.status)).map((entry) => entry.index));
  return envelopes.filter((envelope, index) => written.has(index)
    && ((envelope as { payload?: { type?: unknown } } | null)?.payload?.type === "fact")).length;
}

/**
 * Create the applier for one population phase. The graph snapshot is opened on
 * the first apply and held until `close`; if it cannot be opened, each apply
 * proves freshness itself (slower, never wrong).
 */
export function createSetupBatchApplier(projectRoot: string): SetupBatchApplier {
  const root = resolve(projectRoot);
  let queue: Promise<unknown> = Promise.resolve();
  let pinned: {
    readonly bridge: import("../wiki/cli/grounding.js").WikiCliGroundingBridge;
    readonly release: () => void;
    readonly settled: Promise<boolean>;
  } | null | undefined;

  const open = async (): Promise<NonNullable<typeof pinned> | null> => {
    if (pinned !== undefined) return pinned;
    const { createRepositoryGraphPort } = await import("../graph/application-adapter.js");
    const port = createRepositoryGraphPort(root);
    let release!: () => void;
    const released = new Promise<void>((done) => { release = done; });
    let ready!: (snapshot: GroundingSnapshot) => void;
    const opened = new Promise<GroundingSnapshot | null>((done) => { ready = done; });
    let wasOpened = false;
    const settled = port.withFreshGroundingSnapshot(async (snapshot) => {
      wasOpened = true;
      ready(snapshot as GroundingSnapshot);
      await released;
    }).then(() => false, () => {
      if (!wasOpened) ready(null as unknown as GroundingSnapshot);
      // The snapshot failed its final proof: sources or graph moved during the phase.
      return wasOpened;
    });
    const snapshot = await opened;
    if (snapshot === null) {
      pinned = null;
      return null;
    }
    pinned = {
      release,
      settled,
      bridge: {
        withFreshGroundingSnapshot: async (callback) => callback(snapshot),
        withFreshGroundingPublication: async (prepare) => {
          const prepared = await prepare(snapshot);
          try { await prepared.preflight(); }
          catch (error) {
            try { await prepared.discard(); } catch { /* keep the preflight failure */ }
            throw error;
          }
          return prepared.commit();
        },
      },
    };
    return pinned;
  };

  const applyNow = async (batchFile: string, scope: BatchScope): Promise<BatchApplyOutcome> => {
    const path = resolve(root, batchFile);
    const checked = checkBatchFile(path, scope);
    if (checked.ok === "missing") return { kind: "missing" };
    if (checked.ok === false) return { kind: "refused", problems: checked.problems };
    if (checked.envelopes.length === 0) return { kind: "applied", facts: 0, operations: 0, replayed: false, warnings: [] };
    const held = await open();
    const bridge = held?.bridge ?? (await import("../graph/application-adapter.js")).createRepositoryGraphPort(root);
    const config = findConfig(root);
    const lines: string[] = [];
    const { runApply } = await import("../wiki/cli/commands.js");
    await runApply({
      write: (line) => { lines.push(line); },
      setExitCode: () => undefined,
      scaffoldRoot: config.scaffoldRoot,
      projectRoot: config.projectRoot,
      ...(config.wiki?.exclude === undefined ? {} : { exclude: config.wiki.exclude }),
      ...(config.wiki?.readOnly === undefined ? {} : { readOnly: config.wiki.readOnly }),
      enforceInboxSpecBoundary: true,
      groundingBridge: bridge,
    }, path, { apply: true, json: true });
    let envelope: {
      ok?: boolean;
      data?: { applied?: boolean; replayed?: boolean; operations?: Array<{ index: number; status: string }> };
      diagnostics?: Array<{ code?: string; severity?: string; message?: string }>;
    };
    try {
      envelope = JSON.parse(lines.join("\n"));
    } catch {
      return { kind: "refused", problems: [problem("SETUP_APPLY_OUTPUT", "MEX could not read the result of applying this batch.")] };
    }
    const diagnostics = (envelope.diagnostics ?? []).map((entry) => ({
      severity: entry.severity ?? "error",
      problem: problem(entry.code ?? "UNKNOWN", entry.message ?? ""),
    }));
    const operations = Array.isArray(envelope.data?.operations) ? envelope.data!.operations! : [];
    if (envelope.ok === true && (envelope.data?.applied === true || envelope.data?.replayed === true)) {
      return {
        kind: "applied",
        facts: factCount(checked.envelopes, operations),
        operations: checked.envelopes.length,
        replayed: envelope.data?.applied !== true,
        warnings: diagnostics.filter((entry) => entry.severity === "warning").map((entry) => entry.problem),
      };
    }
    const errors = diagnostics.filter((entry) => entry.severity === "error").map((entry) => entry.problem);
    return {
      kind: "refused",
      problems: errors.length > 0 ? errors.slice(0, MAX_PROBLEMS)
        : [problem("SETUP_APPLY_REFUSED", "The batch was not written, and the Wiki engine gave no reason.")],
    };
  };

  return {
    apply(batchFile, scope) {
      const result = queue.then(() => applyNow(batchFile, scope));
      queue = result.catch(() => undefined);
      return result;
    },
    async close() {
      await queue.catch(() => undefined);
      if (!pinned) return { changed: false };
      pinned.release();
      return { changed: await pinned.settled };
    },
  };
}
