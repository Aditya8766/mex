import { spawnSync } from "node:child_process";
import { relative, resolve } from "node:path";
import { extractGroundings, findMexAnchors } from "../markdown.js";

/** A grounding held by a block-level Wiki entity (`<!-- mex:entity ... -->`). */
export interface BlockEntityGrounding {
  entity: string;
  grounding: { node: string; fingerprint: string; bodyHash?: string; codeHash?: string };
}

/**
 * How baseline capture reads Wiki structure in a scaffold document: groundings
 * held by block entities, and which entity owns a reference. The graph never
 * imports the Wiki, so the Wiki supplies this and callers pass it in. Without
 * one, block entities are not read and failures name no entity.
 */
export interface GroundingDocumentReader {
  blockGroundings(content: string): readonly BlockEntityGrounding[];
  failureEntities(content: string): (node: string) => string | null;
}

/**
 * Why a reference could not be verified.
 *
 * `new` is a reference written since the last recorded state: nothing in the
 * Markdown or the baseline cache vouches for it and the committed file never
 * had it, so it is an authoring mistake that can be repaired or dropped.
 * `drift` is recorded knowledge whose code changed, moved or disappeared. It is
 * a normal consequence of editing code, belongs to `mex sync`, and must never
 * be repaired by setup, dropped, or allowed to fail it.
 */
export type GroundingFailureKind = "new" | "drift";

/** Answer for "did the committed version of this file already hold this node?". */
export type CommittedReferenceLookup = (nodeId: string) => boolean | "unknown";

const GIT_READ_LIMIT_BYTES = 8 * 1024 * 1024;

function git(projectRoot: string, args: string[]) {
  return spawnSync("git", ["--no-optional-locks", "-C", projectRoot, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 10_000,
    maxBuffer: GIT_READ_LIMIT_BYTES,
    env: { ...process.env, LC_ALL: "C" },
  });
}

/**
 * Lazily read a scaffold file's HEAD version and answer whether it already
 * referenced a node, in `grounds_to` (either store) or as an inline anchor.
 *
 * An untracked file, a repository without a commit, or no repository at all has
 * nothing recorded, so every node is `false`. When Git cannot answer for any
 * other reason the lookup returns `"unknown"`, and callers treat that as
 * recorded: the cost of a wrong guess is an authoritative fact deleted.
 */
export function committedReferenceLookup(
  projectRoot: string, absoluteFile: string, reader?: GroundingDocumentReader,
): CommittedReferenceLookup {
  let ids: ReadonlySet<string> | "unknown" | null | undefined;
  const load = (): ReadonlySet<string> | "unknown" | null => {
    const shown = git(projectRoot, ["show", `HEAD:./${relativeToRoot(projectRoot, absoluteFile)}`]);
    if (shown.status === 0 && typeof shown.stdout === "string") {
      const found = new Set<string>();
      try {
        for (const grounding of extractGroundings(shown.stdout)) found.add(grounding.node);
        for (const anchor of findMexAnchors(shown.stdout)) found.add(anchor.nodeId);
        for (const { grounding } of reader?.blockGroundings(shown.stdout) ?? []) found.add(grounding.node);
      } catch { return "unknown"; }
      return found;
    }
    if ((shown.error as NodeJS.ErrnoException | undefined)?.code) return "unknown";
    const head = git(projectRoot, ["rev-parse", "--verify", "--quiet", "HEAD"]);
    if ((head.error as NodeJS.ErrnoException | undefined)?.code) return "unknown";
    if (head.status === 128) return null; // not a repository: nothing was ever committed
    if (head.status === 1) return null; // no commit yet
    if (head.status !== 0) return "unknown";
    const listed = git(projectRoot, ["ls-tree", "HEAD", "--", `./${relativeToRoot(projectRoot, absoluteFile)}`]);
    return listed.status === 0 && listed.stdout === "" ? null : "unknown";
  };
  return (nodeId) => {
    ids ??= load();
    if (ids === "unknown") return "unknown";
    return ids === null ? false : ids.has(nodeId);
  };
}

function relativeToRoot(projectRoot: string, absoluteFile: string): string {
  return relative(resolve(projectRoot), resolve(absoluteFile)).replaceAll("\\", "/");
}

export interface GroundingDriftSummary {
  /** Distinct grounded entities (or files' root, when a reference has none) that changed. */
  entities: number;
  /** Exact number of drifted references. */
  references: number;
  /** True when the exact lists were bounded and `entities` is a lower bound. */
  atLeast: boolean;
  /** A few scaffold files holding drift, for the message. */
  files: string[];
  fileCount: number;
}

const DRIFT_EXAMPLE_FILES = 3;

export function summarizeGroundingDrift(
  failures: readonly { kind: GroundingFailureKind; file: string; node: string; entity: string | null }[],
  driftCount: number,
): GroundingDriftSummary | null {
  const drift = failures.filter(failure => failure.kind === "drift");
  if (driftCount <= 0) return null;
  const entities = new Set(drift.map(failure => `${failure.file}\u0000${failure.entity ?? failure.node}`));
  const files = [...new Set(drift.map(failure => failure.file))];
  return {
    entities: entities.size,
    references: driftCount,
    atLeast: drift.length < driftCount,
    files: files.slice(0, DRIFT_EXAMPLE_FILES),
    fileCount: files.length,
  };
}

/** One bounded sentence for terminal and Hub; the recovery is always `mex sync`. */
export function describeGroundingDrift(summary: GroundingDriftSummary | null): string {
  if (!summary) return "";
  const count = summary.entities || summary.references;
  const noun = count === 1 ? "grounded entity has" : "grounded entities have";
  const bound = summary.atLeast ? "At least " : "";
  const more = summary.fileCount - summary.files.length;
  const where = summary.files.length === 0 ? "" : ` (${summary.files.join(", ")}${more > 0 ? `, and ${more} more file${more === 1 ? "" : "s"}` : ""})`;
  return `${bound}${count} ${noun} changed since they were recorded${where}. They were left as written; run \`mex sync\` to review them.`;
}
