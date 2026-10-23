import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";
import YAML from "yaml";
import { replaceGroundingDocument, type GroundingBaselineFailure } from "../graph/runtime.js";
import { GRAPH_CORPUS_LIMITS } from "../graph/corpus-policy.js";
import { parseDocument, type YamlRegion } from "../wiki/markdown/parse.js";
import { applyEdits, type PatchEdit } from "../wiki/markdown/patch.js";
import { SetupFinalizationError } from "./index.js";

/** Delete only selected sequence items and link syntax; never render a YAML store. */
export function dropReferenceText(content: string, nodes: ReadonlySet<string>): string {
  const parsed = parseDocument(content);
  const edits: PatchEdit[] = [];
  const regions: YamlRegion[] = [
    ...(parsed.frontmatter ? [parsed.frontmatter] : []),
    ...parsed.htmlBlocks.filter(block => block.isEntityMarker),
  ];
  for (const region of regions) {
    const doc = YAML.parseDocument(region.text);
    if (doc.errors.length) continue; // malformed metadata belongs to the repair turn
    for (const path of [["grounds_to"], ["mex", "grounds_to"]]) {
      const seq = doc.getIn(path, true);
      if (!YAML.isSeq(seq) || !seq.range) continue;
      const selected = seq.items.map(item => YAML.isMap(item) && nodes.has(String(item.get("node"))));
      if (!selected.some(Boolean)) continue;
      const add = (start: number, end: number, text = "") => edits.push({ start: region.innerStart + start, end: region.innerStart + end, text, label: "unverifiable grounding" });
      if (selected.every(Boolean)) {
        let end = seq.range[1];
        while (end > seq.range[0] && /\s/.test(region.text[end - 1]!)) end--;
        add(seq.range[0], end, "[]");
        continue;
      }
      for (let i = 0; i < selected.length; i++) {
        if (!selected[i]) continue;
        const first = i;
        while (i + 1 < selected.length && selected[i + 1]) i++;
        const begin = (seq.items[first] as YAML.Node).range![0];
        const end = (seq.items[i] as YAML.Node).range![2];
        if (seq.flow) {
          if (i + 1 < selected.length) add(begin, (seq.items[i + 1] as YAML.Node).range![0]);
          else {
            const previousEnd = (seq.items[first - 1] as YAML.Node).range![1];
            const comma = region.text.indexOf(",", previousEnd);
            if (comma < 0 || comma >= begin) throw new Error("Cannot locate grounding separator safely.");
            add(comma, end);
          }
        } else {
          const startLine = region.text.lastIndexOf("\n", begin - 1) + 1;
          if (!/^[ \t]*-[ \t]+/.test(region.text.slice(startLine, begin))) throw new Error("Cannot locate grounding item safely.");
          add(startLine, end);
        }
      }
    }
  }
  for (const link of parsed.links) {
    if (!nodes.has(link.nodeId)) continue;
    const raw = content.slice(link.start, link.end);
    const label = raw.startsWith("<") && raw.endsWith(">")
      ? raw.slice(1, -1) : /^\[([\s\S]*)\]\s*\(/.exec(raw)?.[1];
    if (label === undefined) throw new Error("Cannot locate grounding link text safely.");
    edits.push({ start: link.start, end: link.end, text: label, label: "unverifiable link" });
  }
  return applyEdits(content, edits).text;
}

/**
 * Remove references the graph cannot verify. Only `new` failures are ever
 * removed: a drift entry is recorded knowledge, and is left byte for byte as written.
 *
 * Every document is checked and rewritten in memory first, so a document that
 * cannot be edited safely stops the pass before any file changes. Each failure
 * names the file and the next step, and a rerun of setup picks up from the files.
 */
export function dropSetupReferences(projectRoot: string, mexDir: string, all: readonly GroundingBaselineFailure[]): void {
  const failures = all.filter(f => f.kind === "new");
  const config = { projectRoot, scaffoldRoot: mexDir, aiTools: [] };
  const stop = (message: string): never => { throw new SetupFinalizationError(message); };
  const pending: { path: string; content: string; next: string }[] = [];
  for (const file of new Set(failures.map(f => f.file))) {
    const nodes = failures.filter(f => f.file === file).map(f => f.node);
    const path = resolve(projectRoot, file);
    let content: string;
    try {
      if (statSync(path).size > GRAPH_CORPUS_LIMITS.maxSourceFileBytes) {
        stop(`${file} is too large for setup to edit. Remove the unverifiable reference ${nodes[0]} by hand, then rerun \`mex setup\`.`);
      }
      content = readFileSync(path, "utf8");
    } catch (error) {
      if (error instanceof SetupFinalizationError) throw error;
      return stop(`${file} could not be read to remove the unverifiable reference ${nodes[0]} (${error instanceof Error ? error.message : String(error)}). Restore or fix the file, then rerun \`mex setup\`.`);
    }
    const digest = createHash("sha256").update(content).digest("hex");
    if (failures.some(f => f.file === file && f.contentHash !== undefined && f.contentHash !== digest)) {
      stop(`${file} was edited while setup was checking it, so nothing was removed from it. Rerun \`mex setup\`.`);
    }
    let next: string;
    try { next = dropReferenceText(content, new Set(nodes)); }
    catch (error) {
      return stop(`Setup could not safely remove the unverifiable reference ${nodes[0]} from ${file} (${error instanceof Error ? error.message : String(error)}). Delete that grounds_to entry or mex:// link by hand, then rerun \`mex setup\`.`);
    }
    if (content === next) {
      stop(`Setup could not find the unverifiable reference ${nodes[0]} in ${file} to remove it. Delete that grounds_to entry or mex:// link by hand (or fix its YAML), then rerun \`mex setup\`.`);
    }
    pending.push({ path, content, next });
  }
  for (const { path, content, next } of pending) {
    try { replaceGroundingDocument(config, path, content, next, GRAPH_CORPUS_LIMITS.maxSourceFileBytes); }
    catch (error) {
      stop(`${relative(projectRoot, path).replaceAll("\\", "/")} changed while setup was removing unverifiable references (${error instanceof Error ? error.message : String(error)}). Rerun \`mex setup\`.`);
    }
  }
}
