import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { closeSync, constants, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { resolve } from "node:path";
import { SetupError } from "./errors.js";

/** Checkout-local, inside the directory setup's ignore protection keeps out of Git. */
export const SETUP_LOCK_FILE = "local/setup.lock";

/** How long an unreadable lock may be a lock still being written by its owner. */
const UNREADABLE_LOCK_GRACE_MS = 10_000;

interface SetupLockOwner {
  readonly pid: number;
  readonly host: string;
  readonly token: string;
  readonly startedAt: string;
}

export interface SetupLock {
  release(): void;
}

const activeSetup = new AsyncLocalStorage<{ mexDir: string; lock: SetupLock }>();

/** A queue call may prepare through the shared engine while keeping its lease. */
export async function withSetupLock<T>(mexDir: string, run: () => Promise<T>): Promise<T> {
  const root = resolve(mexDir);
  if (activeSetup.getStore()?.mexDir === root) return run();
  const lock = acquireSetupLock(root);
  try { return await activeSetup.run({ mexDir: root, lock }, run); }
  finally { lock.release(); }
}

/**
 * Hold this checkout's setup for one run (#310).
 *
 * Without it two setups (a terminal and a Hub, two terminals) ran side by side:
 * both placed and stamped the scaffold, and when the graph was current both
 * launched a population agent over the same files. The graph's maintenance
 * lease stopped the second run only when a build happened to be in progress.
 *
 * The lock is a file created exclusively. A lock whose owner is gone — same
 * host, process no longer running — is reclaimed, so a crashed or killed run
 * never blocks the next one. A lock from another host is never reclaimed: its
 * process cannot be checked from here, and the message says how to clear it.
 */
export function acquireSetupLock(mexDir: string, now: () => Date = () => new Date()): SetupLock {
  assertRegularDirectory(mexDir);
  const localDir = resolve(mexDir, "local");
  assertRegularDirectory(localDir);
  mkdirSync(localDir, { recursive: true });
  assertRegularDirectory(mexDir);
  assertRegularDirectory(localDir);
  const path = resolve(mexDir, SETUP_LOCK_FILE);
  const owner: SetupLockOwner = { pid: process.pid, host: hostname(), token: randomUUID(), startedAt: now().toISOString() };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let fd: number | null = null;
    try {
      const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
      fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow, 0o600);
      writeFileSync(fd, `${JSON.stringify(owner)}\n`, "utf8");
      fsyncSync(fd);
      closeSync(fd);
      fd = null;
      return { release: () => releaseSetupLock(path, owner.token) };
    } catch (error) {
      if (fd !== null) closeSync(fd);
      if (errorCode(error) !== "EEXIST") throw error;
      const existing = readOwner(path);
      if (attempt === 0 && isAbandoned(path, existing, now())) {
        reclaim(path, owner.token);
        continue;
      }
      throw busy(existing);
    }
  }
  throw busy(readOwner(path));
}

function releaseSetupLock(path: string, token: string): void {
  // Only our own lock: never remove one a later run took after reclaiming.
  if (readOwner(path)?.token !== token) return;
  try {
    unlinkSync(path);
  } catch {
    // Already gone; a later run reclaims a leftover the same way.
  }
}

function isAbandoned(path: string, owner: SetupLockOwner | null, now: Date): boolean {
  if (owner === null) {
    // A run that has just created its lock may not have written it yet.
    try {
      return now.getTime() - lstatSync(path).mtimeMs > UNREADABLE_LOCK_GRACE_MS;
    } catch {
      return true;
    }
  }
  return owner.host === hostname() && !processRunning(owner.pid);
}

function reclaim(path: string, token: string): void {
  // Renaming first means two runs reclaiming the same leftover cannot both
  // succeed: the loser's rename fails and its retry meets the winner's lock.
  const aside = `${path}.abandoned-${token}`;
  try {
    renameSync(path, aside);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return;
    throw error;
  }
  try {
    unlinkSync(aside);
  } catch {
    // A leftover aside file is inert.
  }
}

function busy(owner: SetupLockOwner | null): SetupError {
  const where = owner === null ? "" : owner.host === hostname()
    ? ` (process ${owner.pid}, started ${owner.startedAt})`
    : ` on ${owner.host} (process ${owner.pid}, started ${owner.startedAt})`;
  const clear = owner !== null && owner.host !== hostname()
    ? ` If no setup is running there, delete .mex/${SETUP_LOCK_FILE}.`
    : "";
  return new SetupError(
    `Another MEX setup is already running in this checkout${where}. Wait for it to finish or stop it, then rerun setup.${clear}`,
  );
}

function readOwner(path: string): SetupLockOwner | null {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4_096) return null;
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return null;
    const { pid, host, token, startedAt } = parsed as Record<string, unknown>;
    if (!Number.isSafeInteger(pid) || (pid as number) <= 0 || typeof host !== "string" || typeof token !== "string"
      || typeof startedAt !== "string") return null;
    return { pid: pid as number, host, token, startedAt };
  } catch {
    return null;
  }
}

function processRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it exists and belongs to someone else.
    return errorCode(error) === "EPERM";
  }
}

function assertRegularDirectory(path: string): void {
  let stats: ReturnType<typeof lstatSync> | undefined;
  try {
    stats = lstatSync(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return;
    throw error;
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new SetupError(".mex/local must be a regular directory. Replace it, then rerun setup.");
  }
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error ? String((error as NodeJS.ErrnoException).code) : undefined;
}
