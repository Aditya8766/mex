# Benchmark gap implementation — 2026-10-12

## Boundary and baseline

Work is isolated on `codex/benchmark-gap-fixes`, based on
`a86f9b6e2db1ea044ba5134cc5bf4a55831fe937` (`codex/release-0.8.4`).
The original checkout is untouched. Its starting changes were installed
`.agents/skills/{mex-inbox,mex-relay}` and `.claude/skills/{mex-inbox,mex-relay}`
SKILL/managed metadata files, `.mex/config.json`,
`.mex/patterns/release-readme-visuals.md`, and untracked
`docs/diagrams/readme/mex-discord.svg`, `mascot/mex-discord-black-shell.svg`,
`mascot/mex-discord.svg`. No stash or reset was used. Commit/push and a draft PR
for this isolated branch were separately authorized after implementation;
release publication remains outside this work. Existing dependencies were reused through a temporary symlink
without installation/downloads; that symlink is removed before delivery.

The three supplied documents are historical evidence, not proof of the current
implementation. Source identities (SHA-256):

| Input | SHA-256 |
|---|---|
| BENCHMARK-GAPS (2).md | `c8ec8c5ed133ebdf674a0bd6dbee2f9fa597783086a403d24c5bcc1ca7dc807a` |
| knowledge bench (2).md | `c5e47d8de30b2f2038e4c047cd4ec05e75bbca789b2124954bb462495dafe569` |
| README-BENCHMARKS-DRAFT (1).md | `1e47ceec9f3493ec51b61e0aa5ad2afbc7246e2c10640aa7393192916586ac86` |
| supplied implementation brief | `691063fe6aedde099561708cb72f91df187c188ea935ef6ee2d2b427e79779ce` |

Reference keys below: **A** = gaps 2026-09-22 CRG; **N** = gaps
2026-09-22 native baseline; **B** = gaps 2026-09-23 incremental;
**B2** = gaps 2026-09-30 incremental; **Q** = gaps 2026-10-02 graph quality;
**W** = gaps 2026-10-03 Wiki retrieval; **C** = gaps 2026-10-03 #232;
**K** = gaps 2026-10-04 knowledge/addendum; **L** = later knowledge bench
2026-10-07, build `65d2f2f`, sections 5/9.

The supplied results reference raw inputs under the benchmark owner's
`bench/` directory; their current availability is unverified. The Hono knowledge subject is pinned from
`e3bf8c89` to `52febbcc`, 367 first-parent commits, checkpoints
0/73/147/220/294/367. Coarse original MEX build is `8fdff8b`; later fine
deterministic and AI-assisted runs use `65d2f2f`. Do not combine these modes or
relabel claims. The later report replaced raw accuracy with balanced accuracy;
its stale-served and fresh-retention definitions are unchanged.

## Consolidated inventory

Classification describes the historical finding; completion describes the
work/verification actually achieved here. Small passing fixtures establish
behavior within that scope, not a new benchmark score.

| ID | References | Finding / acceptance | Current classification / completion |
|---|---|---|---|
| G01 | A1,4,5,7; N1,3,5,6; Q2,5 | Retrieval must retain relevant production anchors at bounded k | Already implemented priors/concept/source/flow diversity in scope.ts and retrieval/query.ts; major verification pending. Blind numeric sorting can undo deliberate selection; further ranking changes require held-out evidence |
| G02 | A2; N2; W2 | Lexical meaning gaps | Product/architectural decision: embeddings or query rewriting; no new dependency/service authorized |
| G03 | A3; N4 | Callback calls / enclosing function navigation | Implemented bounded enclosingSymbol navigation; factory/closure attribution fixture passes. Real Express failure not reproduced: external excluded callees cannot become resolved by name; owner raw refs needed |
| G04 | A6 | Auth/database questions return nothing | Hypothesis: repos may contain no relevant code; no relaxation without gold evidence |
| G05 | A8; Q4,6,11 | Output cap must expose useful impact evidence and truthful truncation | Implemented and verified in small default-cap fixtures: file callers before definitions, one multi-source BFS, truthful unique counts/truncation. Major impact/response-size/source-span measurement pending; caps frozen |
| G06 | A9 | Error JSONL must exit nonzero | Implemented; 3 focused tests pass / packaged CLI smoke pending |
| G07 | A10; Q12 | Forward dependencies/test reach | Implemented opt-in callers/callees/both over proven calls with default equivalence, depth/cap/invalid-option fixtures. Test/import/override recall remains open without raw misses; no invented edges |
| G08 | A11; N7; Q15 | Query latency | Already implemented improvements require verification / owner latency run pending |
| G09 | B1; B2.1,2 | Incremental refresh/no-op/importer work | Already implemented, requiring verification / owner convergence and timing replay pending |
| G10 | B2 | Checkout-neutral TypeScript identities | Already implemented portableCheckerText/canonical paths; existing cross-directory fixture requires owner execution |
| G11 | B3 | No-op refresh must advance indexedHead | Already resolved in source: recordUnchangedRefresh advances unchanged HEAD transactionally; maintenance.test.ts docs-only commit fixture is an owner gate |
| G12 | B2.3 | Compiler peak memory | Open; no large local reproductions / owner profiling required before a causal fix |
| G13 | B2.4; Q16 | Compact fingerprint/index footprint | Already implemented, requiring verification / owner on-disk measurement pending |
| G14 | Q1 | Unsupported Go/Java/PHP/C/Ruby | Product scope decision; grammar/resolver/oracle work is not an established bug fix |
| G15 | Q3 | Source region recall | Hypothesis / requires oracle and unchanged-budget experiment |
| G16 | Q7,8 | C#/Rust/Python call resolution | Implemented unique lexical recursion and preserved Rust receivers; 27 resolver/Rust fixtures pass. Remaining receiver types/traits/dynamic Python overrides need qualified-key/raw-ref evidence and binding semantics |
| G17 | Q9 | Declaration taxonomy vs SCIP | Hypothesis/oracle mismatch; do not remove legitimate declarations for a score |
| G18 | Q10 | LF/CRLF extraction portability | Implemented syntax/token/evidence EOL normalization; multiline compiler and Python fixtures pass. Semantic IDs/edges/sketches portable; exact file hashes/physical rows intentionally differ. Real clone gate pending |
| G19 | Q13 | Assignment-defined functions and file:line targets | Implemented static assignment names/checker aliases and narrowest exact location lookup, including computed/tied abstention and assigned recursion; focused fixtures pass |
| G20 | Q14 | Serilog seed missing from corpus | Not reproduced from supplied evidence; exact seed path/revision needed |
| W01 | W1 | Root description/triggers must improve FTS with explicit legacy rebuild | Implemented derived file-level hints and schema v5; 3 metadata/negative/parity/explicit-summary/rebuild-refusal fixtures pass |
| W02 | W3,4,5; K7; L9 | Partial/inflected/title-body retrieval and missed facts | Existing strict-before-broader ranking retained; metadata lever implemented and new fixture negatives pass. Broad admission not relaxed; title-coverage tuning and 30–40 per-subject holdout require owner corpus |
| W03 | W6 | Agents must discover bounded Wiki query | Implemented source-managed bounded discovery and pure query permission for headless Claude; 13 instruction + 2 focused launcher tests pass. Installed copies untouched; owner agent-arm measurement pending |
| W04 | C synthesis | Synthesis must use immutable verified Graph evidence | Implemented strict immutable source bridge, revoked accessors, exact atomic publication, completed-ID replay and incomplete-intent refusal; small publication/recovery tests pass. Full adapter/resource gates pending |
| W05 | C CLI/backfill/alias/neighbors | Check/Wiki/Hub grounding agreement | Shared resolver already present; alias/no-baseline/move/changed-current-evidence safety repaired. validate is intentionally structure-only; check owns code verdicts. Focused agreement passes, full integrations pending |
| K01 | K1,2; L3/5 | One fact per entity; expose per-link health | Granularity/all-dependency setup/GROW guidance, upgrade and link-sections already present. Implemented per-link CLI/service query health (25/hit) without displacing ranked hits; 7 health/budget fixtures pass |
| K02 | K3,4,5; C comment/rename | Layout/comment/move tolerance without hiding real changes | Implemented committed-baseline comparison after moves, grammar-only declaration rename, safer layout grammar/semicolon handling, no read-time caching, private contained cache writes. 31 precision + 22 resolver fixtures pass; canonical ASI/indent limit remains a format decision |
| K03 | K6,11; L5 h018 | Nearby/review semantics must protect defaults/complete lists/negative facts | Implemented conservative phrase/control-flow/scanner guards and exact-set/dependency review guidance; actual-Graph h018 and rename-plus-literal tests pass. AI review not validated here; nearby remains a heuristic, never a semantic proof |
| K04 | K8 | Property declaration fingerprints | Already resolved by BODY_KINDS property/field; tiny public/private property bodyHash/sketch regression passes |
| K05 | K9; C freshness | Unverified graph evidence must remain visible; ordinary reads cannot refresh | Contract constraint; no inline maintenance. Owner must explicitly maintain Graph at checkpoints |
| K06 | K10 | Scripted setup | Already implemented `--yes --tool` preparation and documented population checkpoint; auto-launch in CI is a separate product decision |
| K07 | K12; L9 | Complete dependency coverage, including doc/config | Already implemented all-supporting-symbol guidance; new canonical non-code grounding needs product design/evidence |
| K08 | L5/9 h013/h036 | Missing router groundings | Benchmark-scaffold review, not automatic product rebind; current subject files required |
| K09 | L8/9 | Native Windows oversized sync brief | Implemented private-file transport, 20 focused transport/setup tests pass; native Windows gate pending |
| K10 | C inline anchors | Wiki does not treat inline anchors as authored claim groundings | Product/ownership decision: arbitrary link text does not establish claim ownership. Structure/check support remains; no implicit canonical grounding rewrite |
| H01 | N harness | BigInt/specs/source-record grader bugs | Implemented exact 64-bit rows, production specs path correction, source-only ID/span grading including alternates/prohibited IDs. Unknown IDs occupy rank; gold denominators and metric definitions unchanged; self-tests pass |
| H02 | N harness; C migrate/reset | Synthetic first build identity and retained operation logs | Implemented exact synthetic generated-ignore exclusion (canonical .mex content still hashed). Completed migration replay is intentional; owner resets must use disposable copies and retain source/audit consistency |
| H03 | A/B/Q/W/K harness notes | Oracle paths, cap/file order, competitor launch/storage, versions, AI labels | Harness/evidence limitation; preserve in owner verification, no product/scoring workaround |

## Checks actually run

All tests run sequentially with one worker and no concurrent build/indexing.

The following groups passed (repeated runs are not cumulative test totals).
Use `npx vitest run <listed files> --maxWorkers=1 --no-file-parallelism`:

| Files / selection | Result |
|---|---|
| test/sync.test.ts; src/setup/__tests__/population.test.ts | 20 passed |
| test/graph-cli-exit.test.ts | 3 passed, including real TARGET_NOT_FOUND propagation |
| src/setup/__tests__/headless-population.test.ts: `-t 'pre-approves\|retains interactive'` | 2 passed, 32 intentionally unselected; Wiki query permitted, mutation commands still excluded |
| src/graph/__tests__/{cli-agent,resolver-lexical-recursion,extractor-rust,engine-rust,protocol-v3-golden}.test.ts | 81 passed |
| src/wiki/service/__tests__/{synthesis,grounding-health,reground-safety}.test.ts; src/wiki/query/__tests__/authored-metadata.test.ts; src/wiki/grounding/__tests__/{resolve,drift-precision}.test.ts | 91 passed |
| src/drift/__tests__/grounding-unverified.test.ts; src/sync/__tests__/brief-safety.test.ts; test/graph-grounding-fingerprint-encoding.test.ts (with resolver/precision rerun) | 59 passed in that invocation; includes 6 legacy encoding compatibility tests |
| src/wiki/cli/__tests__/commands.test.ts; src/wiki/synthesis/__tests__/context.test.ts; src/wiki/query/__tests__/search-plan.test.ts; src/agent-skills/__tests__/instructions.test.ts | 84 passed across the corresponding seven-file initial Wiki run; its other two failures were repaired and rerun above |
| compiler-extraction, extraction-regression, engine, engine-rust, application-adapter and grounding-verdict-agreement: `-t 'property-assigned\|dynamic assignment\|factory calls\|LF and CRLF\|LF or CRLF\|properties\|receiver\|recursive\|h018\|rename\|synthesis'` | 13 passed, 71 intentionally unselected; one Rust case overlaps the full suite above |

- Final `node --test --test-concurrency=1 evaluate/graph/test/*.test.mjs`:
  **46 passed**, including all 7 new harness regressions.
- TypeScript syntax/transpile diagnostics over **63 changed TS files**: zero
  syntax errors, at a 256 MiB old-space cap. This is not typechecking.
- `NODE_OPTIONS=--max-old-space-size=256 npx tsc --noEmit --skipLibCheck --module NodeNext --moduleResolution NodeNext --target ES2022 src/agent-prompt.ts src/graph-cli-output.ts`:
  passed for those two isolated helpers only.
- Full `NODE_OPTIONS=--max-old-space-size=768 npm run typecheck`: first found a
  new assertion line-break syntax error (repaired); the next run exhausted the
  local 768 MiB old-space cap during root tsc (exit 134). Contracts completed;
  root typecheck/Hub typecheck have no completed result. No larger-cap retry,
  full build, full suite, subject-scale indexes or benchmark replays ran here.
  This does not establish whether whole-tree typechecking passes on the owner machine.
- `mex impact` on changed files: isolated checkout reports `GRAPH_INDEX_MISSING`;
  source navigation used instead. No local index was created.
- Reproduced implementation/test failures were repaired rather than suppressed:
  assigned-call binding, replay created IDs, metadata fixture API usage, and
  framing-reserve accounting. The optional-detail and cache tests retain the
  original hit IDs, source bytes and successful canonical apply assertions.
- A final metadata-bound regression exposed SQLite TEXT length stopping at
  embedded NUL separators in identity keys. Its corrected byte-bound check and
  final rerun passed **3 synthesis adapter tests**, 16 intentionally unselected.
  The fixture verifies a real >32 MiB/NUL-containing stored value and refusal
  before materialization; the 32 MiB limit was not raised.

## Implementation details and compatibility

The sources grouped in the test table contain adjacent small regression fixtures.
Main changes are in `src/graph/{cli-agent,extraction/compiler,extraction/index,
resolution/resolver,grounding-evidence,code-hash,application-adapter}.ts`,
`src/wiki/{grounding,query,index,service,cli,synthesis}`, managed instruction
sources/templates, `src/agent-prompt.ts`, `src/sync/{index,brief-builder}.ts`,
`src/graph-cli-output.ts`, `src/cli.ts`, and `evaluate/{core,graders,graph/lib}`.
No package-root export or required public argument changed. No models,
dependencies, persistent service, canonical grounding format, or production
resource budgets were introduced/increased.

- Graph engine identities are TypeScript extractor v6/tree-sitter v4/resolver
  v3. Explicitly refresh an old valid graph while preserving it for aliases;
  follow status recovery for an incompatible/damaged store. Wiki index schema
  v5 requires explicit rebuild. Canonical Markdown/Graph schema v4 remain intact.
- Optional impact direction walks calls only. `both` can mix incoming/outgoing
  hops; its `dependency` records are reachability, not proof of co-change or
  test necessity. Original default callers/depth 2/10 nodes/1,500 tokens remain.
- Missing committed/current baselines are unverified. Current body evidence is
  required for reviewed reground; never reconstruct historical source from the
  new body. Optional private caches cannot mutate a read or undo a completed write.
- Synthesis plans an exact atomic batch under fresh immutable source/Graph
  evidence. Completed operations retain original IDs. Incomplete intents refuse
  with recovery instructions instead of reminting; recover the original exact
  reviewed envelope/saved plan through the existing Wiki recovery path. Never
  remove audit records or renew hashes to bypass that refusal.
- Root descriptions/triggers are FTS hints only, not canonical summary changes
  or child-entity aliases. Per-link explanations use remaining query budget;
  global truncation remains visible even when a per-hit marker cannot fit.

## Consolidated owner verification

Implementation is not blocked by these missing major results. All commands
below run sequentially from the isolated worktree after the owner installs its
normal dependencies (`npm ci` on that machine). No performance improvement or
benchmark-wide correctness has been measured here.

1. **Whole-tree and packaging gates** (highest priority after the local cap):

   ```sh
   npm run typecheck
   npm test -- --maxWorkers=1 --no-file-parallelism
   npm run eval:test
   npm run build
   npm run test:hub:package
   ```

   Then run the existing Windows/macOS, Node 22/24, Hub/browser, and consumer
   conformance CI at this exact final working tree/commit. Check immutable
   reads, explicit maintenance, source/config races, rollback, stable error
   codes/cursors/protocol goldens and package-root declarations. A passing syntax
   check or small fixture is not this typecheck/build result.

2. **Grounding/knowledge safety**:

   ```sh
   npx vitest run test/grounding-verdict-agreement.test.ts src/wiki/grounding/__tests__/integration.test.ts test/graph-grounding-body-hash.test.ts test/graph-grounding-comment-drift.test.ts test/graph-grounding-source-drift.test.ts --maxWorkers=1 --no-file-parallelism
   npx vitest run src/graph/__tests__/application-adapter.test.ts src/wiki/service/__tests__/synthesis.test.ts src/wiki/cli/__tests__/commands.test.ts --maxWorkers=1 --no-file-parallelism
   ```

   Cover root/migrated/section links, multiple facts and mixed grounding health,
   bodyless/missing baselines, missing old-source caches, parse-only degradation
   and unavailable graph, rename+constant change, comment/layout/ASI cases,
   incomplete-intent recovery before/after canonical rename, and read-only cache
   behavior. Delete only disposable indexes/caches in fresh scratch subjects;
   mismatched committed hashes must keep warnings and reads must not recreate caches.

   Re-run Hono knowledge in separate deterministic and actual `mex sync` arms.
   Inputs: `claims/claims.jsonl`, `claims/checkpoints.json`,
   `answer-key/{labels.jsonl,blind-audit.jsonl,overrides.jsonl}`, original fine
   scaffold `mex-fine:805dd233` (coarse setup `7199b09f`/facts `85c98151`), and
   Hono T0/T1/checkpoints listed above. Maintain Graph then rebuild Wiki explicitly
   at every checkpoint. Preserve all 132 facts/titles, gold labels and the
   existing matching/warning definitions; do not change what unverified means
   to the scorer. Compare fine deterministic C5 retention 56.9%, balanced
   accuracy 68.4%, code recall 83.0%, stale-served **20.0%**. Require no increase
   in stale-served; inspect every nearby downgrade and h018 renewal. AI-assisted
   historical 23.3% stale-served failed that gate despite 89.2% retention/82.9%
   balanced accuracy. A no-op successful agent must not accept a baseline.

3. **Graph convergence, targeting and quality**:

   ```sh
   npx vitest run src/graph/__tests__/compiler-extraction.test.ts src/graph/__tests__/incremental-refresh.test.ts src/graph/__tests__/maintenance.test.ts src/graph/__tests__/engine.test.ts src/graph/__tests__/engine-rust.test.ts src/graph/__tests__/engine-csharp.test.ts --maxWorkers=1 --no-file-parallelism
   ```

   Use disposable clean subjects, dependencies pinned as in retained manifests,
   and output directories outside the subjects. Hono's exact native revision is
   in `subject.revision`; MEX's current native suite intentionally uses the active
   checkout. Run current MEX gates against a disposable copy of the final
   implementation, and historical comparisons against their archived suite/gold
   at `2f074dc` (do not combine different tasks/subjects as the same measurement).
   Synthetic source is `evaluate/fixtures/repositories/graph-synthetic`; copy it into scratch
   before the command. Validate fixtures before indexing:

   ```sh
   node evaluate/graph/index.mjs --all --suite evaluate/suites/native/graph/synthetic.json --repo /ABS/scratch-synthetic --output /ABS/results/synthetic
   node evaluate/graph/index.mjs --all --suite evaluate/suites/native/graph/mex.json --repo /ABS/mex-final-scratch --output /ABS/results/mex
   node evaluate/graph/index.mjs --all --suite evaluate/suites/native/graph/hono.json --repo /ABS/hono-at-0293343dbf8f0bca52b210a98bcef31cc61395ee --output /ABS/results/hono
   ```

   Compare current frozen suite gates and corrected historical MEX R@5 .6,
   MRR .4325/source recall .8333; Hono R@5 .9286/MRR .7917. Do not use the old
   source-blind grader or undocumented MEX .65 expectation. Exact incremental
   versus clean semantic convergence remains required for E16/EJ/E80, as do
   docs-only indexedHead advancement, cross-directory IDs/signatures and LF/CRLF
   semantic edges/sketches. Physical file hashes intentionally remain exact.

   For CRG/SWE-Explore/SCIP/co-change, restore original
   `bench/crg-suite/20260922T080102Z`, graph-quality `runs/B-pending`, and Step B
   inputs/manifests. Keep the 200 impact seeds, original default/raised arms,
   unsupported-language strata, qualified-key taxonomy and scoring unchanged.
   Compare impact F1 .009/default and .157/raised and existing retrieval gates.
   Report new opt-in directions separately. Inspect real Express unresolved
   external/assigned calls and the exact cc-serilog-05 seed before classifying.

4. **Retrieval and agent discovery**: run new 30–40 held-out questions per
   actual subject, frozen title/keyword/NL variants and the original 24-question
   off-topic gate (historically 6 broad hits; a rejected relaxation produced 14).
   New fixture wording/negatives here are not a statistical holdout dataset.
   Re-run the agent-arm loop for bounded Wiki discovery and managed skill
   installation in scratch copies only. Verify description/triggers are not
   copied to children and optional per-link details never reduce ranked hits.

5. **Native Windows launcher**: repeat a >8 KiB actual sync brief through the
   installed Claude/Codex/OpenCode `.cmd` wrappers, including quotes/Unicode/CRLF,
   errors/timeouts, workspace confinement, prompt cleanup and unchanged prose.
   Confirm argv contains only the short private-file instruction. The old
   workaround AI run does not establish native Windows support for this branch.

6. **Resources**:

   ```sh
   npm run benchmark:release
   npm run benchmark:graph-status
   ```

   Use the pinned Ubuntu 24.04/Node 22 release runner and original Step B
   manifest commands. Track cold p50/p95, no-change sync, importer re-capture,
   full-build aggregate peak RSS, graph bytes/source bytes, and convergence.
   Time/memory budgets remain frozen. Historical TS builds measured roughly
   1.3–2.0 GB peak; that is historical evidence, not a measurement here or a
   current minimum. On-disk improvement needs new actual measurements after
   compact fingerprints; synthetic BFS counts do not establish latency wins.

**Missing external inputs:** this checkout has no `bench/` directory or raw
knowledge/graph-quality harness. The teammate did not know its entry commands
and will ask the owner. Exact custom rerun commands must come from those saved
MANIFESTs/harness entry points; do not guess them. This blocks only those
benchmark runs/corpus repairs, not the implementation completed here.

## Remaining decisions and limits

- **Durable grammar-aware change baseline:** whitespace-collapsed bodyHash and
  existing token-spelling codeHash can miss ASI-only newline/Python indentation
  semantics before the resolver sees a mismatch. Recommendation: design an
  optional versioned grammar-aware hash, dual-read compatibility, explicit
  migration/review and old-client behavior. A new canonical format was not
  authorized as an ordinary implementation choice and is not silently added.
- **Fact-aware meaning:** guarded nearby remains syntactic, can miss ungrounded
  cross-symbol/data dependencies, and cannot prove arbitrary prose. Full trap/
  true-flip review is required. LLM review guidance is implemented, but no AI
  benchmark was run and h018 safety must be verified through actual sync.
- **Embeddings/warm daemon/new languages:** concrete support/resource/privacy
  scope and oracles are required. Keep lexical+graph and certain-only bindings
  until held-out/raw-ref evidence justifies a bounded optional design; timing
  summaries alone do not justify narrower semantic importer closure or type inference.
- **Doc/config and inline anchors:** no implicit canonical claim ownership or
  non-code grounding format. Review actual supporting files/claims and design
  coverage explicitly; h013/h036 and six stale-clean facts need original Hono
  scaffold/evidence/current-source review. No speculative corpus relinking occurred.
- **Publication caveats:** claims/labels are AI-audited and enriched, maintainer
  spot-check still pending, one repo/no stale decisions, competitors' AI update
  modes untested, and Windows/subject versions differ. README draft and old
  projections are not current scores or a release/publication authorization.

## Repository Verify Checklist

- Public `src/index.ts` surface: unchanged; full emitted declarations/build pending owner.
- Ordinary reads/explicit writes: focused nonmutation, containment, revision,
  snapshot and atomic-publication tests pass; full adversarial/platform gates pending.
- Bounds/order: unchanged defaults, exact optional-detail accounting and bounded
  source/link/callback/materialization guards covered by small fixtures.
- Focused tests: results above; full typecheck exceeded local cap and is pending owner.
- Packaging/evaluator: protocol goldens/self-tests pass within stated scope;
  full build/eval comparison/release checks pending owner.
- Diff hygiene: `git diff --check` passes; no generated databases are included;
  temporary dependency symlink removed before delivery; original work preserved.
- Protocol/health: source-backed targeted regressions pass; major compatibility
  and benchmark gates remain explicitly pending. No claim that all gaps are fixed.

## Sharing boundary

On 2026-10-12, the user separately authorized committing these fixes, pushing
`codex/benchmark-gap-fixes`, and opening a draft PR against `codex/release-0.8.4`.
This report, code, tests and MEX upkeep are scoped to that branch. The draft PR
is the review and owner-verification checkpoint; it does not establish passing
whole-tree checks or authorize a merge or release publication.
No changes have been applied to the original checkout.
MEX upkeep changed only `.mex/ROUTER.md` and the existing
`durable-change-signal.md`/`safe-graph-snapshot-evolution.md` patterns, retaining
their grounding baselines. These are canonical repository artifacts shared
with the code through the branch push; installed skills, local configuration
and disposable indexes from the original checkout are excluded.
