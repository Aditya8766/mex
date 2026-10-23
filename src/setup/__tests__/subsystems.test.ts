import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openGraphDatabase } from "../../graph/db/database.js";
import {
  computeSubsystemPlan,
  isExcludedSourcePath,
  rankSubsystemCandidates,
  readGraphSubsystemInputs,
  renderSubsystemCandidates,
  subsystemTarget,
} from "../subsystems.js";

const roots: string[] = [];
function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "mex-subsystems-"));
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function filesIn(folder: string, count: number, ext = "ts"): string[] {
  return Array.from({ length: count }, (_, index) => `${folder}/file${index}.${ext}`);
}

describe("subsystemTarget", () => {
  it.each([
    [0, 3, 4], [120, 3, 4], [299, 3, 4], [300, 5, 8], [3000, 5, 8], [3001, 8, 12], [10_000, 8, 12],
  ])("%i source files -> %i to %i subsystems", (files, min, max) => {
    expect(subsystemTarget(files)).toEqual({ min, max });
  });
});

describe("isExcludedSourcePath", () => {
  it.each([
    "src/__tests__/a.ts", "tests/unit/a.py", "src/api/user.test.ts", "pkg/foo_test.go", "pkg/test_user.py",
    "fixtures/app/main.ts", "vendor/lib/x.go", "third_party/a.c", "docs/conf.py", "src/generated/api.ts",
    "src/types/api.d.ts", "dist/index.js", "examples/basic/app.ts", "proto/user_pb2.py", "web/Tests/a.ts",
  ])("excludes %s", (path) => expect(isExcludedSourcePath(path)).toBe(true));

  it.each(["src/api/user.ts", "app/models.py", "lib/core.rb", "cmd/server/main.go"])(
    "keeps %s", (path) => expect(isExcludedSourcePath(path)).toBe(false));

  it("tolerates backslashes and a leading ./", () => {
    expect(isExcludedSourcePath(".\\tests\\a.ts")).toBe(true);
  });
});

describe("rankSubsystemCandidates", () => {
  it("splits a src wrapper into its folders, ranked by size", () => {
    const files = [...filesIn("src/router", 20), ...filesIn("src/http", 12), ...filesIn("src/utils", 5), ...filesIn("scripts", 3)];
    const plan = rankSubsystemCandidates({ files });
    expect(plan.candidates.map((c) => [c.path, c.files])).toEqual([
      ["src/router", 20], ["src/http", 12], ["src/utils", 5], ["scripts", 3],
    ]);
    expect(plan.sourceFiles).toBe(40);
    expect(plan.target).toEqual({ min: 3, max: 4 });
    expect(plan.source).toBe("tree");
    expect(plan.candidates.every((c) => c.fanIn === null)).toBe(true);
  });

  it("keeps top-level folders that are not dominant", () => {
    const files = [...filesIn("api", 10), ...filesIn("core", 10), ...filesIn("web", 10), ...filesIn("web/inner", 4)];
    expect(rankSubsystemCandidates({ files }).candidates.map((c) => c.path).sort()).toEqual(["api", "core", "web"]);
  });

  it("splits a dominant monorepo folder and looks through single-child wrappers", () => {
    const files = [
      ...filesIn("packages/core/src/parser", 15), ...filesIn("packages/core/src/render", 10),
      ...filesIn("packages/cli/src", 8), ...filesIn("tools", 3),
    ];
    const paths = rankSubsystemCandidates({ files }).candidates.map((c) => c.path);
    expect(paths).toContain("packages/core/src/parser");
    expect(paths).toContain("packages/core/src/render");
    expect(paths).toContain("packages/cli");
    expect(paths).not.toContain("packages/cli/src");
    expect(paths).not.toContain("packages");
  });

  it("does not look through a wrapper below the second level unless the folder dominates", () => {
    const files = [...filesIn("app/dashboard/components", 17), ...filesIn("app/dashboard", 3), ...filesIn("lib", 20), ...filesIn("ui", 12)];
    expect(rankSubsystemCandidates({ files }).candidates.map((c) => c.path).sort()).toEqual(["app/dashboard", "lib", "ui"]);
  });

  it("splits an oversized child again but never below the depth cap", () => {
    const files = [...filesIn("src/big/alpha", 20), ...filesIn("src/big/beta", 20), ...filesIn("src/small", 4)];
    const paths = rankSubsystemCandidates({ files }).candidates.map((c) => c.path);
    expect(paths).toEqual(expect.arrayContaining(["src/big/alpha", "src/big/beta", "src/small"]));
    const deep = rankSubsystemCandidates({ files: [...filesIn("a/b/c/d/e/x", 10), ...filesIn("a/b/c/d/e/y", 10), ...filesIn("z", 3)] });
    expect(deep.candidates.every((c) => c.path.split("/").length <= 4)).toBe(true);
  });

  it("excludes tests, fixtures, generated, vendored and docs code from counts and candidates", () => {
    const files = [
      ...filesIn("src/auth", 6), ...filesIn("tests", 30), ...filesIn("src/auth/__tests__", 9), ...filesIn("fixtures", 12),
      ...filesIn("src/generated", 20), ...filesIn("vendor/lib", 40), ...filesIn("docs", 10), "src/auth/login.test.ts", "src/api.d.ts",
    ];
    const plan = rankSubsystemCandidates({ files });
    expect(plan.candidates.map((c) => c.path)).toEqual(["src/auth"]);
    expect(plan.sourceFiles).toBe(6);
  });

  it("drops folders below the minimum size and files directly in the root", () => {
    const plan = rankSubsystemCandidates({ files: ["main.ts", "util.ts", ...filesIn("tiny", 2), ...filesIn("real", 5)] });
    expect(plan.candidates.map((c) => c.path)).toEqual(["real"]);
  });

  it("ranks by fan-in as well as size, counting each outside file once", () => {
    const files = [...filesIn("lib/big", 10), ...filesIn("lib/core", 6), ...filesIn("lib/leaf", 4), ...filesIn("app", 12)];
    const fileEdges: Array<[string, string]> = [];
    for (let i = 0; i < 6; i++) for (const target of ["lib/core/file0.ts", "lib/core/file1.ts"]) fileEdges.push([`app/file${i}.ts`, target]);
    fileEdges.push(["lib/big/file0.ts", "lib/big/file1.ts"], ["lib/leaf/file0.ts", "lib/core/file2.ts"]);
    const plan = rankSubsystemCandidates({ files, fileEdges });
    const byPath = new Map(plan.candidates.map((c) => [c.path, c]));
    expect(plan.source).toBe("graph");
    expect(byPath.get("lib/core")!.fanIn).toBe(7);
    expect(byPath.get("lib/big")!.fanIn).toBe(0);
    expect(byPath.get("lib/leaf")!.fanIn).toBe(0);
    expect(plan.candidates[0]!.path).toBe("lib/core");
  });

  it("breaks ties by path and is deterministic", () => {
    const files = [...filesIn("b", 4), ...filesIn("a", 4), ...filesIn("c", 4)];
    const first = rankSubsystemCandidates({ files });
    expect(first.candidates.map((c) => c.path)).toEqual(["a", "b", "c"]);
    expect(rankSubsystemCandidates({ files: [...files].reverse() })).toEqual(first);
  });

  it("proposes about twice the target and no more", () => {
    const files = Array.from({ length: 12 }, (_, i) => filesIn(`mod${String(i).padStart(2, "0")}`, 5)).flat();
    const plan = rankSubsystemCandidates({ files });
    expect(plan.target).toEqual({ min: 3, max: 4 });
    expect(plan.candidates).toHaveLength(8);
  });

  it("scales the target with the number of source files", () => {
    const medium = Array.from({ length: 10 }, (_, i) => filesIn(`area${i}`, 60)).flat();
    expect(rankSubsystemCandidates({ files: medium }).target).toEqual({ min: 5, max: 8 });
    const large = Array.from({ length: 12 }, (_, i) => filesIn(`area${i}`, 300)).flat();
    const plan = rankSubsystemCandidates({ files: large });
    expect(plan.target).toEqual({ min: 8, max: 12 });
    expect(plan.candidates).toHaveLength(12);
  });

  it("returns no candidates for an empty or flat repository", () => {
    expect(rankSubsystemCandidates({ files: [] }).candidates).toEqual([]);
    expect(rankSubsystemCandidates({ files: ["a.ts", "b.ts", "c.ts", "d.ts"] }).candidates).toEqual([]);
  });
});

function insertNode(db: ReturnType<typeof openGraphDatabase>, id: string, file: string): void {
  db.prepare(`INSERT INTO nodes (id, kind, name, qualified_name, identity_key, file_path, language, start_line, end_line,
    start_column, end_column, updated_at) VALUES (?, 'function', ?, ?, ?, ?, 'typescript', 1, 2, 0, 0, 0)`).run(id, id, id, id, file);
}

function buildFixtureGraph(root: string, files: string[], edges: Array<[string, string]>): void {
  const mex = join(root, ".mex");
  mkdirSync(mex, { recursive: true });
  const db = openGraphDatabase(join(mex, "graph.db"));
  try {
    const insertFile = db.prepare("INSERT INTO files (path, content_hash, language, size, modified_at, indexed_at) VALUES (?, 'h', 'typescript', 1, 0, 0)");
    for (const file of files) {
      insertFile.run(file);
      insertNode(db, `fn:${file}`, file);
    }
    const insertEdge = db.prepare("INSERT INTO edges (source, target, kind) VALUES (?, ?, ?)");
    for (const [from, to] of edges) insertEdge.run(`fn:${from}`, `fn:${to}`, "calls");
    // A structural edge must not count as a dependency.
    insertEdge.run(`fn:${files[0]}`, `fn:${files[files.length - 1]}`, "contains");
  } finally {
    db.close();
  }
}

describe("graph-backed plan", () => {
  it("reads files and distinct cross-file edges from the built graph", () => {
    const root = tempRoot();
    const files = [...filesIn("src/a", 4), ...filesIn("src/b", 4)];
    buildFixtureGraph(root, files, [["src/a/file0.ts", "src/b/file0.ts"], ["src/a/file1.ts", "src/b/file0.ts"], ["src/a/file0.ts", "src/a/file1.ts"]]);
    const inputs = readGraphSubsystemInputs(root)!;
    expect([...inputs.files].sort()).toEqual([...files].sort());
    expect(inputs.fileEdges).toHaveLength(3);
    const plan = computeSubsystemPlan(root)!;
    expect(plan.source).toBe("graph");
    expect(plan.candidates.find((c) => c.path === "src/b")!.fanIn).toBe(2);
    expect(plan.candidates.find((c) => c.path === "src/a")!.fanIn).toBe(0);
  });

  it("returns null when the graph is missing or unreadable", () => {
    const root = tempRoot();
    expect(readGraphSubsystemInputs(root)).toBeNull();
    mkdirSync(join(root, ".mex"), { recursive: true });
    writeFileSync(join(root, ".mex", "graph.db"), "not a database");
    expect(readGraphSubsystemInputs(root)).toBeNull();
  });
});

describe("source-tree fallback", () => {
  function write(root: string, path: string): void {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), "x");
  }

  it("lists source files from the tree when no graph exists, skipping excluded folders", () => {
    const root = tempRoot();
    for (const path of [...filesIn("src/core", 5), ...filesIn("src/web", 4), ...filesIn("node_modules/dep", 30), ...filesIn("tests", 9)]) write(root, path);
    write(root, "src/core/readme.md");
    const plan = computeSubsystemPlan(root)!;
    expect(plan.source).toBe("tree");
    expect(plan.candidates.map((c) => [c.path, c.files, c.fanIn])).toEqual([["src/core", 5, null], ["src/web", 4, null]]);
  });

  it("uses the Git listing when available, so ignored folders stay out", () => {
    const root = tempRoot();
    execFileSync("git", ["init", "-q"], { cwd: root });
    writeFileSync(join(root, ".gitignore"), "generated-out/\n");
    for (const path of [...filesIn("src/core", 5), ...filesIn("generated-out", 20)]) write(root, path);
    const plan = computeSubsystemPlan(root)!;
    expect(plan.candidates.map((c) => c.path)).toEqual(["src/core"]);
  });

  it("returns null for a project with no source", () => {
    const root = tempRoot();
    write(root, "README.md");
    expect(computeSubsystemPlan(root)).toBeNull();
  });
});

describe("renderSubsystemCandidates", () => {
  it("prints path, files and fan-in, omitting fan-in without a graph", () => {
    const withGraph = rankSubsystemCandidates({ files: filesIn("src/a", 4), fileEdges: [] });
    expect(renderSubsystemCandidates(withGraph)).toBe(" 1. src/a/ — 4 files, fan-in 0");
    expect(renderSubsystemCandidates(rankSubsystemCandidates({ files: filesIn("src/a", 4) }))).toBe(" 1. src/a/ — 4 files");
  });
});
