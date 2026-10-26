import { existsSync, lstatSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { inventoryScaffold } from "../wiki/migration/inventory.js";

export const POPULATION_FILES = ["AGENTS.md", "ROUTER.md", "context/architecture.md", "context/stack.md", "context/conventions.md", "context/decisions.md", "context/setup.md"] as const;
const PLACEHOLDERS = ["[Project Name]", "[YYYY-MM-DD]"] as const;

/** One forgotten marker in otherwise authored knowledge needs only a file repair. */
export function targetedPlaceholderFile(mexDir: string, templatesDir: string, mode: "code-repo" | "agent-memory"): string | null {
  let target: string | null = null;
  for (const file of POPULATION_FILES) {
    const path = resolve(mexDir, file);
    if (!existsSync(path)) return null;
    let cursor = mexDir;
    for (const part of ["", ...file.split("/")]) {
      if (part) cursor = resolve(cursor, part);
      const stat = lstatSync(cursor);
      if (stat.isSymbolicLink() || (cursor === path && (!stat.isFile() || stat.size > 1_048_576))) return null;
    }
    const text = readFileSync(path, "utf8");
    const count = PLACEHOLDERS.reduce((sum, marker) => sum + text.split(marker).length - 1, 0);
    if (count === 0) continue;
    if (count !== 1 || target !== null) return null;
    const memory = resolve(templatesDir, "agent-memory", file);
    const template = mode === "agent-memory" && existsSync(memory) ? memory : resolve(templatesDir, file);
    const normalize = (value: string) => value.replace(/\r\n/gu, "\n").replace(/^(---\n[\s\S]*?)^mex:\n(?:[ \t].*\n|\n)*/mu, "$1");
    if (existsSync(template) && normalize(text) === normalize(readFileSync(template, "utf8"))) return null;
    target = file;
  }
  return target;
}

export function targetedPlaceholderPrompt(file: string): string {
  return `Repair the single remaining setup placeholder in .mex/${file}.\nRead that file and the code or project guidance needed to resolve [Project Name] or [YYYY-MM-DD]. Change only that placeholder, preserving authored prose, facts, ids and links. Do not repopulate the scaffold or edit other files. If the value cannot be verified, explain what the user must supply. This is one targeted pass; do not repeat it.\n`;
}

/** A bounded, parser-based post-population audit. Unsupported languages need no code facts. */
export function auditPopulation(mexDir: string, codeKnowledge: boolean): string[] {
  const inventory = inventoryScaffold({ scaffoldRoot: mexDir });
  if (inventory.diagnostics.some(entry => entry.severity === "error") || inventory.files.some(file => file.parsed.diagnostics.some(entry => entry.severity === "error"))) throw new Error("Population inventory is incomplete");
  const files = inventory.files;
  const entities = files.flatMap(file => file.parsed.entities.map(entry => entry.entity));
  const missing: string[] = [];
  if (!files.some(file => file.path.startsWith("patterns/") && !["patterns/README.md", "patterns/INDEX.md"].includes(file.path))) missing.push("project patterns in .mex/patterns/ (README.md and INDEX.md do not count)");
  if (codeKnowledge && !entities.some(entity => entity.type === "fact" && entity.groundsTo.length > 0)) missing.push("code-linked fact entities");
  const sections = files.flatMap(file => file.parsed.entities.filter(entry => entry.metadataKind === "comment"));
  if (codeKnowledge && (sections.length === 0 || sections.some(entry => !entry.entity.relations.some(relation => relation.type === "refines")))) missing.push("section-to-document refines links");
  return missing;
}

export async function populationWarning(projectRoot: string, mexDir: string, mode: "code-repo" | "agent-memory"): Promise<string | null> {
  try {
  let codeKnowledge = false;
  if (mode === "code-repo") {
    const { inspectGraphStatus } = await import("../graph/status.js");
    const { parseHealth } = await inspectGraphStatus({ projectRoot });
    codeKnowledge = parseHealth.ok + parseHealth.partial > 0;
  }
    const missing = auditPopulation(mexDir, codeKnowledge);
    return missing.length ? `Warning: Population finished without ${missing.join("; ")}. Review the knowledge with mex check; setup will not repopulate it automatically.` : null;
  } catch {
    return "Warning: Population could not be audited. Run mex wiki validate to inspect the scaffold.";
  }
}
