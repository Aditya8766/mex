/**
 * Graph freshness for the many small applies of one setup population phase.
 *
 * Every Wiki apply reads the code graph through a fresh grounding snapshot.
 * Proving that snapshot fresh walks the whole repository (about a minute on a
 * 10k-file monorepo), which one phase would otherwise pay once per batch.
 *
 * Here the full proof runs once. MEX then records what identifies that proven
 * database: the graph file's identity as the graph reader already binds it
 * (device, inode, size, modification and change times) and Git HEAD. Each later
 * apply opens the database for that apply only, after re-checking just that
 * identity; nothing stays open between applies, so the user's own `mex graph`,
 * a refresh or the Hub can run in between. If the identity changed (the graph
 * was rebuilt or refreshed, or HEAD moved), the next apply takes a full proof
 * again before it reads anything.
 *
 * Source edits made during setup are not re-proved here: agents of this phase
 * write only under `.mex/`, and finalize verifies every reference against a
 * refreshed graph afterwards.
 */
import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { resolve } from "node:path";
import {
  loadFreshGraphReadSession,
  openImmutableGraphReadSession,
  type InternalFreshGraphReadResult,
  type InternalFreshGraphReadSession,
  type LoadFreshGraphReadSessionOptions,
} from "../graph/read-session.js";

interface Proof {
  readonly identity: string;
  readonly session: Pick<InternalFreshGraphReadSession, "graphStatus" | "degradations" | "driftedSources">;
}

export interface SetupGraphFreshness {
  /** A drop-in for the graph's fresh-session loader. */
  readonly loadFresh: typeof loadFreshGraphReadSession;
  /** Full proofs taken (the first, plus one for every identity change). */
  readonly fullProofs: number;
  /** Applies that only re-checked the identity. */
  readonly quickChecks: number;
}

/** The proven database's identity: the graph file as the reader binds it, and Git HEAD. */
export function graphIdentity(projectRoot: string, dbPath = resolve(projectRoot, ".mex", "graph.db")): string | null {
  let file: string;
  try {
    const stats = statSync(dbPath);
    file = JSON.stringify([stats.dev, stats.ino, stats.size, stats.mtimeMs, stats.ctimeMs]);
  } catch {
    return null;
  }
  let head = "none";
  try {
    head = execFileSync("git", ["rev-parse", "--verify", "-q", "HEAD"], {
      cwd: projectRoot, encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"], windowsHide: true,
    }).trim() || "none";
  } catch { /* an unborn branch has no HEAD; that is an identity too */ }
  return `${file}|${head}`;
}

export function createSetupGraphFreshness(projectRoot: string, dependencies: {
  readonly loadFull?: typeof loadFreshGraphReadSession;
  readonly openQuick?: typeof openImmutableGraphReadSession;
} = {}): SetupGraphFreshness {
  const root = resolve(projectRoot);
  const loadFull = dependencies.loadFull ?? loadFreshGraphReadSession;
  const openQuick = dependencies.openQuick ?? openImmutableGraphReadSession;
  let proof: Proof | null = null;
  let fullProofs = 0;
  let quickChecks = 0;

  /** The session's own final check: still the database and HEAD that were proven, and still readable. */
  const cheapRevalidation = (session: InternalFreshGraphReadSession, identity: string, dbPath: string) => async () => {
    const validation = session.validate();
    if (!validation.valid) return { ...validation, graphStatus: session.graphStatus };
    if (graphIdentity(root, dbPath) !== identity) {
      return {
        valid: false,
        code: "GRAPH_INDEX_READER_SNAPSHOT_CHANGED",
        message: "The graph database or HEAD changed while a setup batch was being applied.",
        graphStatus: session.graphStatus,
      };
    }
    return { valid: true, graphStatus: session.graphStatus };
  };

  const loadFresh = async (projectRootArg: string, options: LoadFreshGraphReadSessionOptions = {}): Promise<InternalFreshGraphReadResult> => {
    const dbPath = options.dbPath ?? resolve(projectRootArg, ".mex", "graph.db");
    const identity = graphIdentity(projectRootArg, dbPath);
    if (proof !== null && identity !== null && identity === proof.identity && options.loadSession !== false) {
      // The proven database is still in place: open it for this apply only.
      try {
        const base = await openQuick(projectRootArg, dbPath, { inspectSidecars: options.inspectSidecars });
        quickChecks += 1;
        const session: InternalFreshGraphReadSession = {
          ...base,
          graphStatus: proof.session.graphStatus,
          degradations: proof.session.degradations,
          driftedSources: proof.session.driftedSources,
          revalidateFreshness: async () => ({ valid: false, graphStatus: proof!.session.graphStatus }),
        };
        session.revalidateFreshness = cheapRevalidation(session, identity, dbPath);
        return { graphStatus: proof.session.graphStatus, session };
      } catch {
        // A writer is active or the file moved: fall through to a full proof.
      }
    }
    proof = null;
    fullProofs += 1;
    const loaded = await loadFull(projectRootArg, options);
    const session = loaded.session;
    if (session === null) return loaded;
    // Bind the identity the full proof just covered; if it already moved, the next apply proves again.
    const proven = graphIdentity(projectRootArg, dbPath);
    if (proven !== null) {
      proof = { identity: proven, session: { graphStatus: session.graphStatus, degradations: session.degradations, driftedSources: session.driftedSources } };
      session.revalidateFreshness = cheapRevalidation(session, proven, dbPath);
    }
    return loaded;
  };

  return {
    loadFresh: loadFresh as typeof loadFreshGraphReadSession,
    get fullProofs() { return fullProofs; },
    get quickChecks() { return quickChecks; },
  };
}
