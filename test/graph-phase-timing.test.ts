import { appendFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, appendFileSync: vi.fn() };
});

import { flushGraphPhaseTimings, recordGraphPhase } from "../src/graph/phase-timing.js";

describe("MEX_GRAPH_PHASE_TIMINGS", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.mocked(appendFileSync).mockClear();
    vi.restoreAllMocks();
  });

  it("appends a record to the named file", () => {
    vi.stubEnv("MEX_GRAPH_PHASE_TIMINGS", "/tmp/mex-phase-timings.jsonl");
    recordGraphPhase("scan", 5);
    flushGraphPhaseTimings("update");
    expect(appendFileSync).toHaveBeenCalledOnce();
    expect(vi.mocked(appendFileSync).mock.calls[0]?.[0]).toBe("/tmp/mex-phase-timings.jsonl");
  });

  it.each(["1", "true", "TRUE", "on"])("does not write a file named %j", (value) => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    vi.stubEnv("MEX_GRAPH_PHASE_TIMINGS", value);
    recordGraphPhase("scan", 5);
    flushGraphPhaseTimings("update");
    expect(appendFileSync).not.toHaveBeenCalled();
    stderr.mockRestore();
  });
});
