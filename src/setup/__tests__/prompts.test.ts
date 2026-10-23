import { describe, expect, it } from "vitest";
import {
  SETUP_OPS_DIRECTORY,
  SETUP_PROGRESS_FILE,
  buildAgentMemoryPrompt,
  buildCoverageSection,
  buildExistingNoBriefPrompt,
  buildExistingWithBriefPrompt,
  buildFreshPrompt,
} from "../prompts.js";
import { rankSubsystemCandidates, type SubsystemPlan } from "../subsystems.js";

const PLAN: SubsystemPlan = rankSubsystemCandidates({
  files: [
    ...Array.from({ length: 30 }, (_, i) => `src/router/r${i}.ts`),
    ...Array.from({ length: 12 }, (_, i) => `src/http/h${i}.ts`),
    ...Array.from({ length: 6 }, (_, i) => `src/util/u${i}.ts`),
  ],
  fileEdges: [["src/http/h0.ts", "src/router/r0.ts"], ["src/util/u0.ts", "src/router/r1.ts"]],
});

const EXISTING: ReadonlyArray<readonly [string, () => string]> = [
  ["existing with brief", () => buildExistingWithBriefPrompt("{\"brief\":true}", PLAN)],
  ["existing without brief", () => buildExistingNoBriefPrompt(PLAN)],
  ["existing with brief and no candidates", () => buildExistingWithBriefPrompt("{}", null)],
  ["existing without brief and no candidates", () => buildExistingNoBriefPrompt()],
];

describe("population completion guidance", () => {
  it.each([buildFreshPrompt, buildExistingNoBriefPrompt, () => buildExistingWithBriefPrompt("{}")])(
    "ends with conditional manual finalization and defers commits", (build) => {
      const finish = build().slice(build().lastIndexOf("Finish:"));
      expect(finish).toContain("Do not commit .mex/ until setup has finalized Graph and Wiki.");
      expect(finish).toContain("by hand (setup did not launch you)");
      expect(finish).toContain("rerun `mex setup`");
      expect(finish).toMatch(/Otherwise, return to setup; do not run it yourself\.$/);
    },
  );

  it.each([buildFreshPrompt, ...EXISTING.map(([, build]) => build)])("asks for a validate self-check before the finish", (build) => {
    const prompt = build();
    const check = prompt.indexOf("SELF-CHECK");
    expect(check).toBeGreaterThan(0);
    expect(prompt.slice(check, prompt.lastIndexOf("Finish:"))).toContain("`mex wiki validate`");
  });
});

describe.each(EXISTING)("%s prompt", (_name, build) => {
  const prompt = build();

  it("teaches reading code with file tools and keeps graph commands optional", () => {
    expect(prompt).toContain("Understand the code by reading it");
    expect(prompt).toContain("optional helper");
    expect(prompt).toContain("READ BROAD, GROUND TIGHT");
    expect(prompt).not.toContain("Do not walk the source tree");
    expect(prompt).not.toContain("do NOT explore the filesystem");
  });

  it("teaches the batched wiki apply interface", () => {
    expect(prompt).toContain("mex wiki apply .mex/local/setup-ops/<subsystem>.json --apply");
    expect(prompt).toContain("array");
    expect(prompt).toContain("all of it or none");
    expect(prompt).toContain('"type": "create-entry"');
    expect(prompt).toContain('"groundsTo": [{"file": "src/x.ts", "symbol": "parseBody"}]');
    expect(prompt).toContain('{"file": "src/x.ts", "line": 120}');
    expect(prompt).toContain('{"node": "<id>"}');
    expect(prompt).toContain('"aliases"');
    expect(prompt).toContain("apply the whole file again");
    expect(prompt).toContain("One code-linked claim per entity");
    expect(prompt).toContain("grounds_to: []");
  });

  it("keeps operation files and progress out of tracked folders", () => {
    expect(SETUP_OPS_DIRECTORY).toBe(".mex/local/setup-ops");
    expect(prompt).toContain(`${SETUP_OPS_DIRECTORY}/`);
    expect(prompt).toContain("Never put operation files in\nthe repository root or in a tracked .mex/ folder");
    expect(prompt).toContain("ignored by Git");
  });

  it("asks for a progress checklist that survives context compaction", () => {
    expect(SETUP_PROGRESS_FILE).toBe(".mex/local/setup-progress.md");
    expect(prompt).toContain(`create \`${SETUP_PROGRESS_FILE}\``);
    expect(prompt).toContain("after your\ncontext was compacted");
    expect(prompt).toContain("COMPLETE");
  });

  it("asks for 8 to 15 facts per subsystem, an overview and a routing row, without padding", () => {
    expect(prompt).toContain("8 to 15 facts");
    expect(prompt).toContain("`type: component`");
    expect(prompt).toContain("routing row");
    expect(prompt).toContain("No padding");
    expect(prompt).toContain("fewer real behaviors");
  });

  it("tells the agent to run one mex command per shell call", () => {
    expect(prompt).toContain("Run one `mex` command per shell call");
    expect(prompt).toContain("`&&`, `;`");
  });

  it("no longer asks for graph plumbing", () => {
    expect(prompt).not.toContain("scope");
    expect(prompt).not.toContain("--fingerprint");
    expect(prompt).not.toContain("link-sections");
    expect(prompt).not.toContain("mex graph get");
    expect(prompt).not.toMatch(/mex:\/\/</);
  });
});

describe("coverage target in the prompt", () => {
  it("embeds the ranked candidates and the target count", () => {
    const prompt = buildExistingWithBriefPrompt("{}", PLAN);
    expect(prompt).toContain("about 48 indexed source files");
    expect(prompt).toContain("cover 3 to 4 major subsystems");
    expect(prompt).toContain(" 1. src/router/ — 30 files, fan-in 2");
    expect(prompt).toContain(" 2. src/http/ — 12 files, fan-in 0");
    expect(prompt).toContain("Confirm or adjust this list");
    expect(prompt).toContain("code graph by size and fan-in");
  });

  it("says the list came from the source tree, without fan-in, when no graph was read", () => {
    const tree = rankSubsystemCandidates({ files: Array.from({ length: 5 }, (_, i) => `core/c${i}.ts`) });
    const section = buildCoverageSection(tree);
    expect(section).toContain("from the source tree by size");
    expect(section).toContain(" 1. core/ — 5 files");
    expect(section).not.toContain("fan-in");
  });

  it("falls back to the size rule when candidates are unavailable", () => {
    for (const prompt of [buildExistingWithBriefPrompt("{}"), buildExistingNoBriefPrompt(null)]) {
      expect(prompt).toContain("Choose the major subsystems yourself");
      expect(prompt).toContain("under\n300 source files, 3 to 4; up to 3,000, 5 to 8; more, 8 to 12");
    }
  });

  it("scales the stated target with the plan", () => {
    const large = rankSubsystemCandidates({ files: Array.from({ length: 12 }, (_, i) => Array.from({ length: 300 }, (_, j) => `m${i}/f${j}.ts`)).flat() });
    expect(buildCoverageSection(large)).toContain("cover 8 to 12 major subsystems");
  });
});

describe("fresh and agent-memory variants", () => {
  it.each([buildFreshPrompt, buildAgentMemoryPrompt])("carry no coverage target or fact-batching instructions", (build) => {
    const prompt = build();
    expect(prompt).not.toContain("COVERAGE");
    expect(prompt).not.toContain(SETUP_PROGRESS_FILE);
    expect(prompt).not.toContain("wiki apply");
    expect(prompt).not.toContain("link-sections");
  });
});

describe("prompt size", () => {
  it("stays compact", () => {
    for (const [name, build] of EXISTING) expect(build().length, name).toBeLessThan(17_000);
  });
});
