/**
 * Subsystem candidates for the setup coverage target.
 *
 * Setup asks the population agent to cover a repository's major code areas, not
 * just the first few it happens to read. MEX proposes the areas so the agent
 * confirms a ranked list instead of inventing one: top-level and second-level
 * source folders ranked by size and by how much the rest of the code depends on
 * them. Everything here is cheap and bounded: one pair of graph queries (file
 * paths and file-to-file edges, no source parsing), or a bounded file listing
 * when the graph is unavailable.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { openGraphDatabase } from "../graph/db/database.js";

export interface SubsystemCandidate {
  /** Repo-relative folder with `/` separators. */
  readonly path: string;
  readonly files: number;
  /** Distinct files outside the folder with an edge into it; `null` when no graph was read. */
  readonly fanIn: number | null;
}

export interface SubsystemTarget {
  readonly min: number;
  readonly max: number;
}

export interface SubsystemPlan {
  /** Where the numbers came from: the built graph, or a listing of the source tree. */
  readonly source: "graph" | "tree";
  /** Source files counted after test, fixture, generated, vendored and docs exclusions. */
  readonly sourceFiles: number;
  readonly target: SubsystemTarget;
  /** Ranked best first; about twice the target maximum, fewer when the repository has fewer areas. */
  readonly candidates: readonly SubsystemCandidate[];
}

/** Folders whose files never make a subsystem. Matched against any path segment, case-insensitively. */
export const EXCLUDED_FOLDER_NAMES: ReadonlySet<string> = new Set([
  "test", "tests", "__tests__", "__test__", "__mocks__", "__snapshots__", "spec", "specs", "e2e", "integration-tests",
  "fixture", "fixtures", "testdata", "test-data", "testing", "mocks", "mock", "stubs", "snapshots",
  "generated", "__generated__", "gen", "codegen", "migrations",
  "vendor", "vendored", "third_party", "third-party", "thirdparty", "external", "node_modules", "bower_components",
  "dist", "build", "out", "target", "coverage", ".next", ".nuxt", ".turbo", ".cache", "__pycache__", "venv", ".venv",
  "docs", "doc", "documentation", "examples", "example", "samples", "sample", "demo", "demos", "benchmarks", "benchmark",
]);

const EXCLUDED_FILE_PATTERNS: readonly RegExp[] = [
  /\.(test|spec)\.[a-z0-9]+$/iu, /(^|\/)test_[^/]*\.py$/iu, /_test\.(go|py|rs|rb|exs?)$/iu, /\.d\.ts$/iu,
  /\.min\.(js|css)$/iu, /\.(generated|gen)\.[a-z0-9]+$/iu, /\.pb\.go$/iu, /_pb2(_grpc)?\.py$/iu, /(^|\/)conftest\.py$/iu,
];

const SOURCE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".rs", ".go", ".java", ".kt", ".kts", ".cs", ".rb", ".php",
  ".swift", ".c", ".h", ".cc", ".cpp", ".hpp", ".scala", ".dart", ".ex", ".exs", ".lua", ".vue", ".svelte",
]);

/** A folder needs this many files to be proposed on its own. */
const MIN_FOLDER_FILES = 3;
/** Never descend below this many path segments when splitting a large folder. */
const MAX_DEPTH = 4;
/** A top-level folder is split into its children when they hold at least this share of its files. */
const SPLIT_COVERAGE = 0.6;
/** A folder holding more than this share of all files is split further even below the top level. */
const DOMINANT_SHARE = 0.4;

/** Bounds on the fallback listing and the graph read, so setup never stalls on a huge repository. */
export const SUBSYSTEM_LIMITS = Object.freeze({
  treeEntries: 40_000,
  treeDepth: 8,
  graphFiles: 200_000,
  graphEdgeRows: 1_500_000,
  gitListBytes: 32 * 1024 * 1024,
});

/** How many subsystems to cover, by the number of source files. */
export function subsystemTarget(sourceFiles: number): SubsystemTarget {
  if (sourceFiles < 300) return { min: 3, max: 4 };
  if (sourceFiles <= 3000) return { min: 5, max: 8 };
  return { min: 8, max: 12 };
}

function normalizePath(path: string): string {
  return path.replace(/\\/gu, "/").replace(/^\.\//u, "");
}

/** Whether a repo-relative file path belongs to tests, fixtures, generated, vendored or docs code. */
export function isExcludedSourcePath(path: string): boolean {
  const normalized = normalizePath(path);
  const segments = normalized.split("/");
  if (segments.slice(0, -1).some((segment) => EXCLUDED_FOLDER_NAMES.has(segment.toLowerCase()))) return true;
  return EXCLUDED_FILE_PATTERNS.some((pattern) => pattern.test(normalized));
}

export interface SubsystemInputs {
  /** Every indexed or listed source file, repo-relative. */
  readonly files: readonly string[];
  /** Distinct (from file, to file) dependency pairs; omit when no graph was read. */
  readonly fileEdges?: ReadonlyArray<readonly [string, string]>;
}

interface Unit {
  path: string;
  files: string[];
}

function folderOf(file: string, depth: number): string | null {
  const segments = file.split("/");
  if (segments.length - 1 < depth) return null;
  return segments.slice(0, depth).join("/");
}

function groupByFolder(files: readonly string[], depth: number): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const file of files) {
    const folder = folderOf(file, depth);
    if (folder === null) continue;
    const bucket = groups.get(folder);
    if (bucket === undefined) groups.set(folder, [file]);
    else bucket.push(file);
  }
  return groups;
}

/**
 * Split a folder into its qualifying children, descending through single-child
 * wrappers (`packages/core/src`), or keep it whole when it has no real parts.
 */
function expand(unit: Unit, depth: number, totalFiles: number): Unit[] {
  if (depth >= MAX_DEPTH) return [unit];
  const children = [...groupByFolder(unit.files, depth + 1)]
    .filter(([, files]) => files.length >= MIN_FOLDER_FILES)
    .map(([path, files]): Unit => ({ path, files }));
  const covered = children.reduce((sum, child) => sum + child.files.length, 0);
  const dominant = unit.files.length > totalFiles * DOMINANT_SHARE;
  if (children.length === 1 && children[0]!.files.length >= unit.files.length * 0.8 && (depth < 2 || dominant)) {
    // A wrapper such as `src/` or `lib/`: look through it, but only below the second level when the folder dominates.
    return expand(children[0]!, depth + 1, totalFiles);
  }
  const worthSplitting = children.length >= 2 && covered >= unit.files.length * SPLIT_COVERAGE;
  if (!worthSplitting || !dominant) return [unit];
  return children.flatMap((child) => expand(child, depth + 1, totalFiles));
}

/**
 * Rank candidate subsystems. Pure: the graph or tree listing is read elsewhere.
 *
 * Top-level folders become candidates. A folder holding a large share of the
 * repository (the `src/` wrapper, a `packages/` monorepo) is replaced by its
 * children, and any child that is still large is split again, so one area does
 * not swallow everything. Ranking is by size
 * plus twice the distinct outside files that depend on the folder.
 */
export function rankSubsystemCandidates(inputs: SubsystemInputs): SubsystemPlan & { source: "graph" | "tree" } {
  const files = [...new Set(inputs.files.map(normalizePath))].filter((file) => !isExcludedSourcePath(file)).sort();
  const total = files.length;
  const top = [...groupByFolder(files, 1)]
    .filter(([, group]) => group.length >= MIN_FOLDER_FILES)
    .map(([path, group]): Unit => ({ path, files: group }));
  // A flat repository (everything in the root, or in one folder with no parts) has no real parts to propose.
  const units = top.flatMap((unit) => expand(unit, 1, total));

  const fanIn = new Map<string, number>();
  if (inputs.fileEdges !== undefined) {
    const owner = new Map<string, string>();
    for (const unit of units) for (const file of unit.files) owner.set(file, unit.path);
    const sources = new Map<string, Set<string>>();
    for (const [from, to] of inputs.fileEdges) {
      const target = owner.get(normalizePath(to));
      if (target === undefined || owner.get(normalizePath(from)) === target) continue;
      const set = sources.get(target) ?? new Set<string>();
      set.add(normalizePath(from));
      sources.set(target, set);
    }
    for (const unit of units) fanIn.set(unit.path, sources.get(unit.path)?.size ?? 0);
  }

  const hasGraph = inputs.fileEdges !== undefined;
  const ranked = units
    .map((unit): SubsystemCandidate => ({ path: unit.path, files: unit.files.length, fanIn: hasGraph ? fanIn.get(unit.path) ?? 0 : null }))
    .sort((a, b) => (b.files + 2 * (b.fanIn ?? 0)) - (a.files + 2 * (a.fanIn ?? 0)) || a.path.localeCompare(b.path));
  const target = subsystemTarget(total);
  return { source: hasGraph ? "graph" : "tree", sourceFiles: total, target, candidates: ranked.slice(0, target.max * 2) };
}

/** Indexed files and distinct file-to-file edges from the built graph; `null` when the graph cannot be read. */
export function readGraphSubsystemInputs(projectRoot: string): SubsystemInputs | null {
  const databasePath = resolve(projectRoot, ".mex", "graph.db");
  if (!existsSync(databasePath)) return null;
  let database: ReturnType<typeof openGraphDatabase> | undefined;
  try {
    database = openGraphDatabase(databasePath, { readOnly: true });
    const files = (database.prepare("SELECT path FROM files LIMIT ?").allArrays(SUBSYSTEM_LIMITS.graphFiles) as string[][])
      .map((row) => row[0]!);
    if (files.length === 0) return null;
    const fileEdges = database.prepare(
      `SELECT DISTINCT s.file_path, t.file_path FROM edges e
         JOIN nodes s ON s.id = e.source JOIN nodes t ON t.id = e.target
        WHERE e.kind <> 'contains' AND s.file_path <> t.file_path LIMIT ?`,
    ).allArrays(SUBSYSTEM_LIMITS.graphEdgeRows) as Array<[string, string]>;
    return { files, fileEdges };
  } catch {
    return null;
  } finally {
    try { database?.close(); } catch { /* a close failure changes nothing */ }
  }
}

function isSourceFile(path: string): boolean {
  const dot = path.lastIndexOf(".");
  return dot > path.lastIndexOf("/") && SOURCE_EXTENSIONS.has(path.slice(dot).toLowerCase());
}

/** Source files listed by Git (so ignore rules apply), or `null` outside a usable repository. */
function listFilesWithGit(projectRoot: string): string[] | null {
  try {
    const output = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
      cwd: projectRoot, encoding: "utf8", maxBuffer: SUBSYSTEM_LIMITS.gitListBytes, timeout: 15_000, stdio: ["ignore", "pipe", "ignore"],
    });
    return output.split("\0").filter((path) => path !== "" && isSourceFile(path));
  } catch {
    return null;
  }
}

/** Bounded directory walk for a checkout Git cannot list. Excluded folders are never entered. */
function walkSourceTree(projectRoot: string): string[] {
  const found: string[] = [];
  let entries = 0;
  const visit = (relative: string, depth: number): void => {
    if (depth > SUBSYSTEM_LIMITS.treeDepth || entries > SUBSYSTEM_LIMITS.treeEntries) return;
    let children;
    try {
      children = readdirSync(resolve(projectRoot, relative), { withFileTypes: true });
    } catch {
      return;
    }
    for (const child of children) {
      entries += 1;
      if (entries > SUBSYSTEM_LIMITS.treeEntries) return;
      const path = relative === "" ? child.name : `${relative}/${child.name}`;
      if (child.isDirectory()) {
        if (!child.name.startsWith(".") && !EXCLUDED_FOLDER_NAMES.has(child.name.toLowerCase())) visit(path, depth + 1);
      } else if (child.isFile() && isSourceFile(path)) {
        found.push(path);
      }
    }
  };
  visit("", 0);
  return found;
}

/**
 * The coverage plan for a project, or `null` when no source files can be found.
 * Never throws: setup must still produce a prompt when this cannot help.
 */
export function computeSubsystemPlan(projectRoot: string): SubsystemPlan | null {
  try {
    const graph = readGraphSubsystemInputs(projectRoot);
    const inputs = graph ?? { files: listFilesWithGit(projectRoot) ?? walkSourceTree(projectRoot) };
    const plan = rankSubsystemCandidates(inputs);
    return plan.candidates.length === 0 ? null : plan;
  } catch {
    return null;
  }
}

/** The candidate table embedded in the prompt, one line per folder. */
export function renderSubsystemCandidates(plan: SubsystemPlan): string {
  const lines = plan.candidates.map((candidate, index) =>
    `${String(index + 1).padStart(2)}. ${candidate.path}/ — ${candidate.files} files`
    + (candidate.fanIn === null ? "" : `, fan-in ${candidate.fanIn}`));
  return lines.join("\n");
}
