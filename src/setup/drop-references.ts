import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import YAML from "yaml";
import { replaceGroundingDocument, type GroundingBaselineFailure } from "../graph/runtime.js";
import { GRAPH_CORPUS_LIMITS } from "../graph/corpus-policy.js";
import { parseDocument, type YamlRegion } from "../wiki/markdown/parse.js";
import { applyEdits, type PatchEdit } from "../wiki/markdown/patch.js";

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

export function dropSetupReferences(projectRoot: string, mexDir: string, failures: readonly GroundingBaselineFailure[]): void {
  const config = { projectRoot, scaffoldRoot: mexDir, aiTools: [] };
  for (const file of new Set(failures.map(f => f.file))) {
    const path = resolve(projectRoot, file);
    if (statSync(path).size > GRAPH_CORPUS_LIMITS.maxSourceFileBytes) throw new Error("Grounding document exceeds the bounded read limit.");
    const content = readFileSync(path, "utf8");
    const digest = createHash("sha256").update(content).digest("hex");
    if (failures.some(f => f.file === file && f.contentHash !== undefined && f.contentHash !== digest)) {
      throw new Error("Grounding document changed after verification; retry setup.");
    }
    const next = dropReferenceText(content, new Set(failures.filter(f => f.file === file).map(f => f.node)));
    if (content === next) throw new Error("Unverifiable references changed before removal; retry setup.");
    replaceGroundingDocument(config, path, content, next, GRAPH_CORPUS_LIMITS.maxSourceFileBytes);
  }
}
