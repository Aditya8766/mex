import { describe, expect, it } from "vitest";
import { buildExistingNoBriefPrompt, buildExistingWithBriefPrompt, buildFreshPrompt } from "../prompts.js";

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
});
