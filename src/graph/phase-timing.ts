import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Opt-in per-phase wall-clock timing for graph maintenance.
 *
 * Disabled unless `MEX_GRAPH_PHASE_TIMINGS` is set to a truthy value. When
 * enabled, each flush appends one JSON line of accumulated phase totals to
 * the target file. Nothing is ever printed, and no path or source content
 * enters a record: phase names are fixed labels and values are milliseconds
 * or counts.
 *
 * The value selects the target file:
 * - `0`, `false`, `no`, or `off` keeps timing disabled. These used to be
 *   read as paths, so setting the flag to switch it off wrote to a file named
 *   after the value instead.
 * - `1`, `true`, `on`, or `yes` selects the default sink
 *   `.mex/local/graph-phase-timings.jsonl`: checkout-local and ignored by
 *   `.mex/.gitignore`, so the usual "turn the flag on" spelling cannot
 *   create a stray file at the repository root.
 * - anything else is taken verbatim as a path to append to.
 */
const PHASE_TIMINGS_ENV = "MEX_GRAPH_PHASE_TIMINGS";
const DEFAULT_TIMINGS_DIR = join(".mex", "local");
const DEFAULT_TIMINGS_FILE = join(DEFAULT_TIMINGS_DIR, "graph-phase-timings.jsonl");

const totals = new Map<string, number>();

/**
 * Resolves the `MEX_GRAPH_PHASE_TIMINGS` value to the file timings are
 * appended to, or null when the flag means "disabled". An empty value and
 * the flag-off spellings stay off; a bare flag-on spelling picks the
 * checkout-local default sink; any other non-empty value is the operator's
 * path, taken as written.
 */
export function resolvePhaseTimingsFile(value: string | undefined): string | null {
  if (typeof value !== "string") return null;
  const raw = value;
  if (raw.trim() === "") return null;
  const flag = raw.trim().toLowerCase();
  if (flag === "0" || flag === "false" || flag === "no" || flag === "off") return null;
  if (flag === "1" || flag === "true" || flag === "on" || flag === "yes") {
    return DEFAULT_TIMINGS_FILE;
  }
  return raw;
}

/** Whether phase timings are switched on for this run. */
export function phaseTimingsEnabled(): boolean {
  return resolvePhaseTimingsFile(process.env[PHASE_TIMINGS_ENV]) !== null;
}

export function recordGraphPhase(phase: string, milliseconds: number): void {
  if (!phaseTimingsEnabled()) return;
  totals.set(phase, (totals.get(phase) ?? 0) + milliseconds);
}

export function timeGraphPhase<T>(phase: string, run: () => T): T {
  if (!phaseTimingsEnabled()) return run();
  const started = performance.now();
  try {
    return run();
  } finally {
    recordGraphPhase(phase, performance.now() - started);
  }
}

export async function timeGraphPhaseAsync<T>(phase: string, run: () => Promise<T>): Promise<T> {
  if (!phaseTimingsEnabled()) return run();
  const started = performance.now();
  try {
    return await run();
  } finally {
    recordGraphPhase(phase, performance.now() - started);
  }
}

/** Append the accumulated totals under one fixed label, then reset them. */
export function flushGraphPhaseTimings(label: string): void {
  const file = resolvePhaseTimingsFile(process.env[PHASE_TIMINGS_ENV]);
  if (file === null) {
    totals.clear();
    return;
  }
  const phases = Object.fromEntries([...totals.entries()].map(([phase, ms]) => [phase, Math.round(ms * 10) / 10]));
  totals.clear();
  try {
    // The default sink sits in a checkout-local directory that may not exist
    // yet. Diagnostics must never change the outcome of a maintenance
    // operation, so both this and the append swallow failures.
    if (file === DEFAULT_TIMINGS_FILE) {
      mkdirSync(DEFAULT_TIMINGS_DIR, { recursive: true });
    }
    appendFileSync(file, `${JSON.stringify({ label, pid: process.pid, phases })}\n`);
  } catch {
    // Diagnostics must never change the outcome of a maintenance operation.
  }
}
