import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { POPULATION_FILES, auditPopulation, fillPopulationPlaceholders, populationWarning } from "../population-audit.js";
import { runHeadlessSetup } from "../headless.js";
import { runSetupNext } from "../next.js";
import { createPlanState, loadPlanState, savePlanState } from "../subsystem-state.js";
import { createSetupScaffold } from "../phases.js";
import { isScaffoldPopulated, runSetup } from "../index.js";
import { HubSetupRunner } from "../../hub/setup/runner.js";
import * as population from "../headless-population.js";
import * as graph from "../../graph/status.js";
const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function write(root: string, file: string, text: string) {
  const path = join(root, ".mex", file); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text);
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "mex-population-audit-")); roots.push(root);
  for (const file of POPULATION_FILES) write(root, file, "---\nname: fixture\n---\n# Authored knowledge\n\nRetain this project guidance.\n");
  return root;
}
function leftover(root: string) { write(root, "context/stack.md", "---\nname: stack\nlast_updated: [YYYY-MM-DD]\n---\n# Stack\n\nThe router uses a typed handler.\n"); }
describe("template population and finalization", () => {
  it("names missing patterns, grounded facts and structural links", () => {
    const root = fixture(); expect(auditPopulation(join(root, ".mex"), true)).toEqual([expect.stringContaining("project patterns"), "code-linked fact entities", "section-to-document refines links"]);
  });
  it("does not demand facts or links without indexed source coverage", async () => {
    const root = fixture(); write(root, "patterns/restart.md", "# Restart\n\nStop, then start.\n");
    vi.spyOn(graph, "inspectGraphStatus").mockResolvedValue({ parseHealth: { ok: 0, partial: 0 } } as Awaited<ReturnType<typeof graph.inspectGraphStatus>>);
    expect(await populationWarning(root, join(root, ".mex"), "code-repo")).toBeNull();
  });
  it.each(["code-repo", "agent-memory"] as const)("recognizes untouched %s templates even with dates and names filled", mode => {
    const root = mkdtempSync(join(tmpdir(), "mex-template-population-")); roots.push(root);
    if (mode === "code-repo") execFileSync("git", ["init", "-q"], { cwd: root });
    createSetupScaffold({ projectRoot: root, mode }); const mex = join(root, ".mex");
    expect(isScaffoldPopulated(mex)).toBe(false);
    for (const file of POPULATION_FILES) { const path = join(mex, file); writeFileSync(path, readFileSync(path, "utf8").replaceAll("[Project Name]", "Project").replaceAll("[YYYY-MM-DD]", "2026-10-26")); }
    expect(isScaffoldPopulated(mex)).toBe(false);
    for (const file of POPULATION_FILES) {
      const path = join(mex, file);
      const stamped = readFileSync(path, "utf8").replace(/\r\n/gu, "\n")
        .replace(/\n---\n/u, "\nmex:\n  id: mx_01M1M0CJ9460AT00V8TH0QCKAC\n  type: document\n---\n")
        .replace(/^# /mu, "<!-- mex:entity\nid: mx_01M1M0CJ8E6KNBAMXBK7GBCGPM\ntype: section\n-->\n# ");
      writeFileSync(path, stamped);
    }
    expect(isScaffoldPopulated(mex)).toBe(false);
    for (const file of POPULATION_FILES) writeFileSync(join(mex, file), readFileSync(join(mex, file), "utf8") + "\nProject-specific guidance.\n");
    expect(isScaffoldPopulated(mex)).toBe(true);
  });
  it("fills all known tokens, preserves CRLF and prose, and is idempotent", () => {
    const root = fixture(); leftover(root);
    const before = "---\r\nname: architecture\r\nlast_updated: [YYYY-MM-DD]\r\n---\r\n# [Project Name]\r\nRetain [TO DETERMINE] and authored facts.\r\n";
    write(root, "context/architecture.md", before); const untouched = readFileSync(join(root, ".mex/context/setup.md"));
    expect(fillPopulationPlaceholders(root, join(root, ".mex"))).toEqual([expect.stringContaining("context/architecture.md"), expect.stringContaining("context/stack.md")]);
    expect(readFileSync(join(root, ".mex/context/architecture.md"), "utf8")).toBe(before.replaceAll("[YYYY-MM-DD]", new Date().toISOString().slice(0, 10)).replaceAll("[Project Name]", basename(root)));
    expect(readFileSync(join(root, ".mex/context/setup.md"))).toEqual(untouched); expect(fillPopulationPlaceholders(root, join(root, ".mex"))).toEqual([]);
  });
  it("refuses hard-linked files before replacing their bytes", () => {
    const root = fixture(); leftover(root); const path = join(root, ".mex/context/stack.md"), outside = join(root, "outside.md"); linkSync(path, outside); const bytes = readFileSync(outside);
    expect(() => fillPopulationPlaceholders(root, join(root, ".mex"))).toThrow("Unsafe setup file"); expect(readFileSync(outside)).toEqual(bytes);
  });
  for (const mode of ["code-repo", "agent-memory"] as const) for (const completedPlan of [false, true]) {
    it.each(["engine", "terminal", "Hub", "next"])(`finalizes authored ${mode} through %s without agents or a new plan (stored=${completedPlan})`, async driver => {
      const root = fixture(); leftover(root); write(root, "config.json", JSON.stringify({ setupMode: mode, aiTools: [] }));
      if (mode === "code-repo") { execFileSync("git", ["init", "-q"], { cwd: root }); writeFileSync(join(root, "index.ts"), "export function ready() { return true; }\n"); }
      if (completedPlan) {
        const state = createPlanState({ source: "tree", ranking: "size", sourceFiles: 1, target: { min: 0, max: 0 }, candidates: [] });
        state.shared.state = "done"; state.final.state = "done"; state.queue = { mode: "single", finalized: true }; state.finalizedAt = "2026-10-25T00:00:00Z"; savePlanState(root, state);
      }
      const plan = join(root, ".mex/local/setup-plan.json"), planBytes = existsSync(plan) ? readFileSync(plan) : null;
      const launch = vi.spyOn(population, "launchHeadlessSetupPopulation").mockRejectedValue(new Error("must not launch an agent"));
      const findAgent = vi.spyOn(population, "findAvailableSetupAgent").mockRejectedValue(new Error("must not discover an agent"));
      const run = async () => {
        if (driver === "terminal") {
          const lines: string[] = [];
          vi.spyOn(process, "cwd").mockReturnValue(root);
          vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => lines.push(args.map(String).join(" ")));
          const result = await runSetup({ yes: true, mode, tools: [], openBrowser: false });
          expect(result.outcome).toBe("complete"); return lines.join("\n");
        }
        if (driver === "next") { const result = await runSetupNext({ projectRoot: root }); expect(result.status).toBe("complete"); expect(result.taskFile).toBeUndefined(); return result.output; }
        if (driver === "Hub") {
          const runner = new HubSetupRunner({ projectRoot: root });
          try { runner.start({ mode, tools: [] }); await vi.waitFor(() => expect(runner.snapshot().status).not.toBe("running"), { timeout: 30_000 }); expect(runner.snapshot().status).not.toBe("failed"); return runner.snapshot().message; }
          finally { await runner.shutdown(); }
        }
        const result = await runHeadlessSetup({ projectRoot: root, mode, tools: [] }); expect(result.ready).toBe(true); return result.message;
      };
      expect(await run()).toContain("context/stack.md"); expect(readFileSync(join(root, ".mex/context/stack.md"), "utf8")).not.toContain("[YYYY-MM-DD]");
      expect(await run()).toContain("project patterns"); expect(launch).not.toHaveBeenCalled(); expect(findAgent).not.toHaveBeenCalled();
      expect(existsSync(plan) ? readFileSync(plan) : null).toEqual(planBytes); expect(loadPlanState(root).state?.subsystems ?? []).toEqual([]);
    }, 60_000);
  }
});
