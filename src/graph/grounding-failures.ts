import YAML from "yaml";
import { parseDocument } from "../wiki/markdown/parse.js";

/** Parse entity ownership once per document; reference failures remain exact and bounded. */
export function groundingFailureEntities(content: string): (node: string) => string | null {
  const parsed = parseDocument(content);
  let rootId: string | null = null;
  const owners = new Map<string, string | null>();
  try {
    const root = parsed.frontmatter ? YAML.parse(parsed.frontmatter.text) : null;
    if (typeof root?.mex?.id === "string") rootId = root.mex.id;
    for (const entry of [...(Array.isArray(root?.grounds_to) ? root.grounds_to : []),
      ...(Array.isArray(root?.mex?.grounds_to) ? root.mex.grounds_to : [])]) {
      if (typeof entry?.node === "string") owners.set(entry.node, rootId);
    }
    const blocks = parsed.htmlBlocks.filter(block => block.isEntityMarker).map(block => {
      let id: string | null = null;
      try { const value: unknown = YAML.parse(block.yamlText)?.id; if (typeof value === "string") id = value; } catch { /* validation owns malformed blocks */ }
      return { end: block.end, id };
    });
    for (const link of parsed.links) {
      if (!owners.has(link.nodeId)) owners.set(link.nodeId, blocks.filter(block => block.end <= link.start).at(-1)?.id ?? rootId);
    }
  } catch { /* validation owns malformed metadata */ }
  return node => owners.get(node) ?? rootId;
}
