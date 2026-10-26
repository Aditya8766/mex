import { existsSync, lstatSync, readFileSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { basename, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { resolveSetupMode, setupTemplatesDirectory } from "./phases.js";
import { inventoryScaffold } from "../wiki/migration/inventory.js";

export const POPULATION_FILES = [
  "AGENTS.md",
  "ROUTER.md",
  "context/architecture.md",
  "context/stack.md",
  "context/conventions.md",
  "context/decisions.md",
  "context/setup.md",
] as const;
const PLACEHOLDERS = /\[Project Name\]|\[YYYY-MM-DD\]/gu;

/** Seven fixed files, bounded reads, and no redirected scaffold directories. */
function populationFile(mexDir: string, file: string): string {
  const path = resolve(mexDir, file);
  let cursor = mexDir;
  for (const part of ["", ...file.split("/")]) {
    if (part) cursor = resolve(cursor, part);
    const stat = lstatSync(cursor);
    if (stat.isSymbolicLink() || (cursor === path
      ? !stat.isFile() || stat.size > 1_048_576 || stat.nlink > 1
      : !stat.isDirectory())) throw new Error(`Unsafe setup file: .mex/${file}`);
  }
  return path;
}

function normalizeTemplate(text: string): string {
  return text.replace(/\r\n/gu, "\n")
    .replace(/^(---\n[\s\S]*?)^mex:\n(?:[ \t].*\n|\n)*/mu, "$1")
    .replace(/<!-- mex:entity\n[\s\S]*?-->\n?/gu, "")
    .split("\n").map(line => line.trimEnd()).filter(line => line.trim() !== "").join("\n").trim();
}

/** Placeholder values and setup's Wiki stamps are not evidence of authored knowledge. */
export function isTemplatePopulationFile(mexDir: string, file: typeof POPULATION_FILES[number], text: string): boolean {
  const templates = setupTemplatesDirectory();
  const memory = resolve(templates, "agent-memory", file);
  const template = resolveSetupMode(mexDir) === "agent-memory" && existsSync(memory)
    ? memory : resolve(templates, file);
  const parts = normalizeTemplate(readFileSync(template, "utf8")).split(PLACEHOLDERS);
  const pattern = parts.map(part => part.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")).join("[^\\n]*?");
  return new RegExp(`^${pattern}$`, "u").test(normalizeTemplate(text));
}

export function scaffoldIsAuthored(mexDir: string): boolean {
  return POPULATION_FILES.every(file => {
    try {
      const text = readFileSync(populationFile(mexDir, file), "utf8");
      return !isTemplatePopulationFile(mexDir, file, text);
    } catch { return false; }
  });
}

export function populationPlaceholderFiles(mexDir: string): string[] {
  return POPULATION_FILES.filter(file => /\[Project Name\]|\[YYYY-MM-DD\]/u.test(readFileSync(populationFile(mexDir, file), "utf8")));
}

/** Explicit finalization only: replace known tokens, never ask an agent or create a plan. */
export function fillPopulationPlaceholders(projectRoot: string, mexDir: string, onMessage?: (message: string) => void): string[] {
  const today = new Date().toISOString().slice(0, 10);
  const projectName = basename(projectRoot);
  const messages: string[] = [];
  for (const file of POPULATION_FILES) {
    const path = populationFile(mexDir, file);
    const before = readFileSync(path, "utf8");
    if (isTemplatePopulationFile(mexDir, file, before)) continue;
    const after = before.replace(PLACEHOLDERS, marker => marker === "[YYYY-MM-DD]" ? today : projectName);
    if (after === before) continue;
    const temp = `${path}.setup-${randomUUID()}.tmp`;
    const stat = lstatSync(path);
    try {
      writeFileSync(temp, after, { flag: "wx", mode: stat.mode });
      populationFile(mexDir, file);
      if (readFileSync(path, "utf8") !== before) throw new Error(`Setup file changed: .mex/${file}`);
      renameSync(temp, path);
    } finally { rmSync(temp, { force: true }); }
    const message = `Filled setup placeholders in .mex/${file}.`;
    messages.push(message);
    onMessage?.(message);
  }
  return messages;
}

/** A bounded, parser-based post-population audit. Unsupported languages need no code facts. */
export function auditPopulation(
  mexDir: string,
  codeKnowledge: boolean,
): string[] {
  const inventory = inventoryScaffold({ scaffoldRoot: mexDir });
  if (
    inventory.diagnostics.some((entry) => entry.severity === "error") ||
    inventory.files.some((file) =>
      file.parsed.diagnostics.some((entry) => entry.severity === "error"),
    )
  )
    throw new Error("Population inventory is incomplete");
  const files = inventory.files;
  const entities = files.flatMap((file) =>
    file.parsed.entities.map((entry) => entry.entity),
  );
  const missing: string[] = [];
  if (
    !files.some(
      (file) =>
        file.path.startsWith("patterns/") &&
        !["patterns/README.md", "patterns/INDEX.md"].includes(file.path),
    )
  )
    missing.push(
      "project patterns in .mex/patterns/ (README.md and INDEX.md do not count)",
    );
  if (
    codeKnowledge &&
    !entities.some(
      (entity) => entity.type === "fact" && entity.groundsTo.length > 0,
    )
  )
    missing.push("code-linked fact entities");
  const sections = files.flatMap((file) =>
    file.parsed.entities.filter((entry) => entry.metadataKind === "comment"),
  );
  if (
    codeKnowledge &&
    (sections.length === 0 ||
      sections.some(
        (entry) =>
          !entry.entity.relations.some(
            (relation) => relation.type === "refines",
          ),
      ))
  )
    missing.push("section-to-document refines links");
  return missing;
}

export async function populationWarning(
  projectRoot: string,
  mexDir: string,
  mode: "code-repo" | "agent-memory",
): Promise<string | null> {
  try {
    let codeKnowledge = false;
    if (mode === "code-repo") {
      const { inspectGraphStatus } = await import("../graph/status.js");
      const { parseHealth } = await inspectGraphStatus({ projectRoot });
      codeKnowledge = parseHealth.ok + parseHealth.partial > 0;
    }
    const missing = auditPopulation(mexDir, codeKnowledge);
    return missing.length
      ? `Warning: Population finished without ${missing.join("; ")}. Review the knowledge with mex check; setup will not repopulate it automatically.`
      : null;
  } catch {
    return "Warning: Population could not be audited. Run mex wiki validate to inspect the scaffold.";
  }
}
