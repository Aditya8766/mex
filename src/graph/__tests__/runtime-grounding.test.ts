import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { refreshGroundingBaselines, type GroundingRuntime } from "../runtime.js";
it("retains exact bounded failure details for authored entries and links", () => {
  const root = mkdtempSync(join(tmpdir(), "grounding-detail-"));
  mkdirSync(join(root, ".mex"));
  const file = join(root, ".mex/test.md");
  writeFileSync(file, '---\ngrounds_to:\n  - node: function:wrong\n    fingerprint: pending\n---\n[link](mex://function:missing)\n');
  const runtime = { graph: { getNode: () => null }, reconciler: { getFingerprint: () => null }, fingerprints: { getGroundedSource: () => null } } as unknown as GroundingRuntime;
  try {
    expect(refreshGroundingBaselines({ projectRoot: root, scaffoldRoot: join(root, ".mex"), aiTools: [] }, [file], runtime)).toMatchObject({ captured: 0, skipped: 2, failures: [
      { file: ".mex/test.md", entity: null, node: "function:wrong", reason: "Node is unavailable or has no verifiable body." },
      { file: ".mex/test.md", entity: null, node: "function:missing", reason: "Node is unavailable or has no verifiable body." },
    ] });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
