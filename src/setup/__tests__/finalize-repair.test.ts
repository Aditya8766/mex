import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ capture: vi.fn(), wiki: vi.fn() }));
vi.mock("../../graph/runtime.js", async original => ({ ...await original(), captureGroundingBaselines: mocks.capture }));
vi.mock("../wiki-finalize.js", () => ({ finalizeSetupWiki: mocks.wiki }));
vi.mock("../../config.js", async original => ({ ...await original(), findConfig: () => ({ wiki: {} }) }));
import { finalizeCodeRepoSetup } from "../index.js";
const bad = { captured: 0, skipped: 1, failures: [{ file: ".mex/test.md", entity: null, node: "function:wrong", reason: "Unavailable node" }] };
beforeEach(() => { vi.resetAllMocks(); mocks.wiki.mockResolvedValue({ ready: true, indexedEntities: 1 }); });
it("gives the supplied population adapter one exact repair turn", async () => {
  mocks.capture.mockResolvedValueOnce(bad).mockResolvedValue({ captured: 0, skipped: 0 });
  const populate = vi.fn(async input => {
    expect(input.prompt).toContain('"node":"function:wrong"');
    expect(input.prompt).toContain("mex graph scope");
    expect(input.prompt).toContain("No other edits. Do not commit.");
    return { tool: "codex" as const, completed: true };
  });
  await expect(finalizeCodeRepoSetup("/project", "/project/.mex", { selectedTools: ["codex"], populate, onMessage: () => {} })).resolves.toEqual([]);
  expect(populate).toHaveBeenCalledOnce(); expect(mocks.capture).toHaveBeenCalledTimes(2);
});
it("retains a non-droppable Wiki error after one repair", async () => {
  mocks.capture.mockResolvedValue({ captured: 0, skipped: 0 });
  mocks.wiki.mockResolvedValue({ ready: false, stage: "plan", reason: "Malformed entity", diagnostics: [{ code: "ENTITY_BLOCK_MALFORMED", severity: "error", file: "test.md", entityId: "broken", message: "Bad YAML" }] });
  const populate = vi.fn(async input => { expect(input.prompt).toContain("Bad YAML"); return { tool: "codex" as const, completed: true }; });
  await expect(finalizeCodeRepoSetup("/project", "/project/.mex", { selectedTools: ["codex"], populate, onMessage: () => {} })).rejects.toThrow("Malformed entity");
  expect(populate).toHaveBeenCalledOnce();
});
it("cancels during repair without another finalization", async () => {
  mocks.capture.mockResolvedValue(bad);
  const controller = new AbortController();
  const populate = vi.fn(async () => { controller.abort(); return { tool: "codex" as const, completed: false }; });
  await expect(finalizeCodeRepoSetup("/project", "/project/.mex", { selectedTools: ["codex"], populate, signal: controller.signal, onMessage: () => {} })).rejects.toThrow("cancelled");
  expect(mocks.capture).toHaveBeenCalledOnce();
});
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { dropReferenceText } from "../drop-references.js";
it.each([true, false])("drops remaining exact failures (repair available=%s)", async available => {
  const root = mkdtempSync(join(tmpdir(), "repair-fallback-"));
  const mex = join(root, ".mex"); mkdirSync(mex);
  const original = '---\r\n# keep\r\ngrounds_to:\r\n  - node: function:wrong\r\n    fingerprint: pending\r\n---\r\nBefore [label](mex://function:wrong) after.\r\n';
  writeFileSync(join(mex, "test.md"), original);
  mocks.capture.mockResolvedValueOnce(bad);
  if (available) mocks.capture.mockResolvedValueOnce(bad);
  mocks.capture.mockResolvedValue({ captured: 0, skipped: 0 });
  const populate = vi.fn(async () => ({ tool: "codex" as const, completed: false }));
  const messages: string[] = [];
  try {
    await expect(finalizeCodeRepoSetup(root, mex, { selectedTools: available ? ["codex"] : [], populate, onMessage: m => messages.push(m) })).resolves.toEqual(bad.failures);
    expect(populate).toHaveBeenCalledTimes(available ? 1 : 0);
    expect(readFileSync(join(mex, "test.md"), "utf8")).toBe('---\r\n# keep\r\ngrounds_to:\r\n  []\r\n---\r\nBefore label after.\r\n');
    expect(messages.join("\n")).toContain("Dropped unverifiable reference");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
it.each(["\n", "\r\n"])("keeps valid entries and every surrounding byte (%j)", eol => {
  const original = ['---', 'mex:', '  grounds_to:', '    - node: bad', '      fingerprint: pending', '    - node: good # keep', '      fingerprint: unchanged', 'grounds_to: [{node: good, fingerprint: x}, {node: bad, fingerprint: x}]', '---', '[good](mex://good) [**bad**](mex://bad)', ''].join(eol);
  const expected = ['---', 'mex:', '  grounds_to:', '    - node: good # keep', '      fingerprint: unchanged', 'grounds_to: [{node: good, fingerprint: x}]', '---', '[good](mex://good) **bad**', ''].join(eol);
  expect(dropReferenceText(original, new Set(["bad"]))).toBe(expected);
});
it("stops before dropping a document changed after verification", async () => {
  const root = mkdtempSync(join(tmpdir(), "repair-revision-"));
  const mex = join(root, ".mex"); mkdirSync(mex);
  const content = '[fixed](mex://function:wrong)\r\n';
  writeFileSync(join(mex, "test.md"), content);
  mocks.capture.mockResolvedValue({ ...bad, failures: bad.failures.map(f => ({ ...f, contentHash: "old-revision" })) });
  try {
    await expect(finalizeCodeRepoSetup(root, mex, { onMessage: () => {} })).rejects.toThrow("changed after verification");
    expect(readFileSync(join(mex, "test.md"), "utf8")).toBe(content);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
it("drops remaining failures when the repair adapter throws", async () => {
  const root = mkdtempSync(join(tmpdir(), "repair-thrown-"));
  const mex = join(root, ".mex"); mkdirSync(mex);
  writeFileSync(join(mex, "test.md"), '[label](mex://function:wrong)\n');
  mocks.capture.mockResolvedValueOnce(bad).mockResolvedValueOnce(bad).mockResolvedValue({ captured: 0, skipped: 0 });
  try {
    await expect(finalizeCodeRepoSetup(root, mex, { selectedTools: ["codex"], populate: async () => { throw new Error("repair failed"); }, onMessage: () => {} })).resolves.toEqual(bad.failures);
    expect(readFileSync(join(mex, "test.md"), "utf8")).toBe('label\n');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
it("drops bounded batches until all remaining failures are gone", async () => {
  const root = mkdtempSync(join(tmpdir(), "repair-batches-"));
  const mex = join(root, ".mex"); mkdirSync(mex);
  writeFileSync(join(mex, "test.md"), '[first](mex://function:wrong) <mex://function:other>\n');
  const other = { ...bad.failures[0]!, node: "function:other" };
  mocks.capture.mockResolvedValueOnce({ ...bad, skipped: 2 }).mockResolvedValueOnce({ ...bad, failures: [other] }).mockResolvedValue({ captured: 0, skipped: 0 });
  try {
    await expect(finalizeCodeRepoSetup(root, mex, { onMessage: () => {} })).resolves.toEqual([...bad.failures, other]);
    expect(readFileSync(join(mex, "test.md"), "utf8")).toBe('first mex://function:other\n');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
