import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  POPULATION_FILES,
  auditPopulation,
  populationWarning,
  targetedPlaceholderFile,
} from "../population-audit.js";
import { runHeadlessSetup } from "../headless.js";
import { runSetupNext } from "../next.js";
import { loadPlanState } from "../subsystem-state.js";
import { setupTemplatesDirectory } from "../phases.js";
import * as graph from "../../graph/status.js";
const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "mex-population-audit-"));
  roots.push(root);
  for (const file of POPULATION_FILES)
    write(
      root,
      file,
      "---\nname: fixture\n---\n# Authored knowledge\n\nRetain this project guidance.\n",
    );
  return root;
}
function write(root: string, file: string, text: string) {
  const p = join(root, ".mex", file);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text);
}
function leftover(root: string) {
  write(
    root,
    "context/architecture.md",
    "---\nname: architecture\nlast_updated: [YYYY-MM-DD]\n---\n# Architecture\n\nThe router resolves a handler.\n",
  );
}
describe("population audit on the shared plan", () => {
  it("names missing patterns, grounded facts and structural links", () => {
    const root = fixture();
    expect(auditPopulation(join(root, ".mex"), true)).toEqual([
      expect.stringContaining("project patterns"),
      "code-linked fact entities",
      "section-to-document refines links",
    ]);
  });
  it("does not demand facts or links without indexed source coverage", async () => {
    const root = fixture();
    write(root, "patterns/restart.md", "# Restart\n\nStop, then start.\n");
    vi.spyOn(graph, "inspectGraphStatus").mockResolvedValue({
      parseHealth: { ok: 0, partial: 0 },
    } as Awaited<ReturnType<typeof graph.inspectGraphStatus>>);
    expect(
      await populationWarning(root, join(root, ".mex"), "code-repo"),
    ).toBeNull();
  });
  it("runs one targeted pass and preserves every other authored file", async () => {
    const root = fixture();
    leftover(root);
    const other = readFileSync(join(root, ".mex/context/stack.md"), "utf8");
    const populate = vi.fn(async (input: { prompt: string }) => {
      expect(input.prompt).toContain(".mex/context/architecture.md");
      expect(input.prompt).not.toContain(".mex/context/stack.md");
      write(
        root,
        "context/architecture.md",
        "# Architecture\n\nThe router resolves a handler.\n",
      );
      return { tool: "codex" as const, completed: true };
    });
    const result = await runHeadlessSetup({
      projectRoot: root,
      mode: "agent-memory",
      tools: [],
      populate,
    });
    expect(result.ready).toBe(true);
    expect(populate).toHaveBeenCalledOnce();
    expect(readFileSync(join(root, ".mex/context/stack.md"), "utf8")).toBe(
      other,
    );
    expect(loadPlanState(root).state?.placeholderRepair).toEqual({
      file: "context/architecture.md",
      attempted: true,
    });
  }, 60_000);
  it("does not launch another pass after an unsuccessful targeted repair", async () => {
    const root = fixture();
    leftover(root);
    const populate = vi.fn(async () => ({
      tool: "codex" as const,
      completed: true,
    }));
    await runHeadlessSetup({
      projectRoot: root,
      mode: "agent-memory",
      tools: [],
      populate,
    });
    await runHeadlessSetup({
      projectRoot: root,
      mode: "agent-memory",
      tools: [],
      populate,
    });
    expect(populate).toHaveBeenCalledOnce();
  });
  it("keeps a plan-less older authored scaffold complete", async () => {
    const root = fixture();
    const populate = vi.fn(async () => ({
      tool: "codex" as const,
      completed: true,
    }));
    const result = await runHeadlessSetup({
      projectRoot: root,
      mode: "agent-memory",
      tools: [],
      populate,
    });
    expect(result.ready).toBe(true);
    expect(populate).not.toHaveBeenCalled();
  });
  it("gives one-paste setup a targeted task and blocks a failed pass instead of looping", async () => {
    const root = fixture();
    leftover(root);
    write(
      root,
      "config.json",
      JSON.stringify({ setupMode: "agent-memory", aiTools: [] }),
    );
    const first = await runSetupNext({ projectRoot: root });
    expect(first.status).toBe("task");
    expect(readFileSync(join(root, first.taskFile!), "utf8")).toContain(
      "Repair the single remaining setup placeholder",
    );
    const second = await runSetupNext({ projectRoot: root, start: true });
    expect(second.status).toBe("blocked");
    expect(second.output).toContain("Resolve it manually");
  }, 60_000);
  it("resumes a single-session plan interrupted after filling placeholders", async () => {
    const root = fixture();
    for (const file of POPULATION_FILES)
      write(root, file, "# Draft\n[Project Name] [YYYY-MM-DD]\n");
    const populate = vi.fn(async () => {
      for (const file of POPULATION_FILES)
        write(root, file, "# Authored knowledge\nRetain this work.\n");
      return {
        tool: "codex" as const,
        completed: populate.mock.calls.length > 1,
      };
    });
    expect(
      await runHeadlessSetup({
        projectRoot: root,
        mode: "agent-memory",
        tools: [],
        populate,
      }),
    ).toMatchObject({ ready: false });
    expect(loadPlanState(root).state?.shared.state).not.toBe("done");
    const resumed = await runHeadlessSetup({
      projectRoot: root,
      mode: "agent-memory",
      tools: [],
      populate,
    });
    expect(resumed.ready).toBe(true);
    expect(resumed.message).toContain(
      "Population finished without project patterns",
    );
    expect(populate).toHaveBeenCalledTimes(2);
  });

  it("recognizes only a single authored marker", () => {
    const root = fixture();
    leftover(root);
    expect(
      targetedPlaceholderFile(
        join(root, ".mex"),
        setupTemplatesDirectory(),
        "agent-memory",
      ),
    ).toBe("context/architecture.md");
    write(root, "context/stack.md", "# Stack\n[Project Name]\n");
    expect(
      targetedPlaceholderFile(
        join(root, ".mex"),
        setupTemplatesDirectory(),
        "agent-memory",
      ),
    ).toBeNull();
  });
});
