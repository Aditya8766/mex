import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { loadConfiguredSetupMode } from "../config.js";

/** Locate the checkout without requiring or creating a MEX scaffold. */
export function findSetupProjectRoot(startDir: string = process.cwd()): string {
  let current = resolve(startDir);
  while (true) {
    if (existsSync(resolve(current, ".git"))) return current;
    const parent = dirname(current);
    if (parent === current) return resolve(startDir);
    current = parent;
  }
}

/** Report completed setup; retain the Hub's recovery surfaces for missing indexes. */
export async function resolveDefaultEntry(
  projectRoot: string = findSetupProjectRoot(),
): Promise<"setup" | "hub"> {
  const scaffoldRoot = resolve(projectRoot, ".mex");
  if (loadConfiguredSetupMode(scaffoldRoot) !== "code-repo"
    || !existsSync(resolve(scaffoldRoot, "ROUTER.md"))) return "setup";
  // New workspaces do not need to load the Hub or inspect Graph/Wiki state.
  const { hasCommittedHubIdentity } = await import("../hub/setup/readiness.js");
  if (!await hasCommittedHubIdentity(projectRoot)) return "setup";
  const { assessSetupHealth } = await import("./health.js");
  const { describeUnfinishedSetup } = await import("./unfinished.js");
  if (describeUnfinishedSetup(projectRoot) !== null || (await assessSetupHealth(projectRoot)).healthy) return "setup";
  return "hub";
}
