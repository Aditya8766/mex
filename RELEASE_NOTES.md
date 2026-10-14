# mex 0.8.4 — Terminal setup and clearer knowledge checks

October 14, 2026.

MEX 0.8.4 makes terminal setup the default, adds a native interactive agent
handoff, and reports setup progress and failures more clearly. It also includes
the graph, Wiki search, and grounding improvements merged since 0.8.3.

## Terminal setup by default

Run `mex setup` to open the keyboard-driven HUD and ASCII banner. Choose a tool
with the arrow keys and Enter; Space selects additional integrations. Selection
happens before setup writes. An available selected Claude Code or Codex CLI
receives the real terminal, including normal keyboard interaction. Exit the
agent to return to MEX; incomplete population offers retry, a manual prompt,
file checks, or Finish later.

Graph work shows actual phase/file counts and elapsed time. Setup distinguishes
complete, paused, failed, and cancelled outcomes. Expected failures carry
recovery instructions; bounded worker diagnostics remain available in the
terminal, while browser errors expose only safe messages. Completing or checking
setup without agent output no longer creates an empty background-session panel.
Press `d` to review retained setup notices and diagnostics; `l` on the finishing
screen shows a clean copyable Hub link, including in a narrow terminal. Finish
later remains a paused outcome after an agent failure, and the final message
reflects a setup commit completed in the browser. On Windows, returning from
the manual prompt or the Hub link view no longer leaves the HUD without input.

After interactive preparation, the browser handles setup-file review, the
explicit local commit checkpoint, and completion. MEX never pushes. Use
`mex setup --browser` to select browser setup directly; `--cli` remains an alias
for terminal setup. Bare `mex` opens terminal setup for an incomplete project
and Hub for an established code project. `mex hub` and `mex tui` remain explicit
browser and terminal-dashboard entry points.

For scripts, use `mex setup --yes --tool <name>` or `--tool none`. Piped input/output
and CI also use plain output, reuse saved choices where available, and never
launch an agent or long-lived Hub. Exit codes are `0` for completed preparation
or a successful dry run, `2` for pending population, `1` for failure, and
`130`/`143` for interruption. `--dry-run` remains read-only.

## Faster graphs, smaller fingerprints

- Refresh avoids re-extracting importers whose dependency declaration signatures
  did not change and shares compiler resolution work across projects. The first
  refresh after upgrading re-extracts the corpus once for the new internal cache
  format; subsequent work can reuse it. The inferred-program fallback now agrees
  with a clean build after changes outside every `tsconfig`.
- Scope tokenizes each node once per query, avoiding repeated work on large type
  signatures while preserving the output.
- New grounding fingerprints use lossless `mh2:` encoding, substantially reducing
  committed Markdown size. Existing `mh:` values remain readable and are not
  rewritten by reads. `mex graph compact-fingerprints --dry-run` previews an
  optional explicit conversion; omit `--dry-run` to apply it.

**Upgrade every collaborator before committing `mh2:` groundings. MEX 0.8.3 and
earlier cannot read that encoding.**

## Knowledge checks and Wiki maintenance

- `mex check`, Wiki queries, and Hub views share fact-aware grounding verdicts.
  Proven comment-only and formatting-only edits stay fresh; changes away from
  everything a fact names are distinguished from changes that may invalidate it.
  Missing or ambiguous links remain flagged. Class properties and fields now
  receive body hashes and fingerprints too.
- `mex sync` reviews flagged Wiki facts in the same agent session. After review,
  `mex wiki reground <id> --apply` can re-record a still-valid fact's links;
  changed text or uncertain links require the corresponding review. Index
  rebuild and another check follow. Baselines are not silently accepted.
- `mex wiki validate` checks structure. Use `mex check` for code-link health.
  Graph-aware Wiki maintenance uses a revalidated snapshot. An unrelated
  incomplete parse permits exact grounding from fully parsed files; targets
  in incomplete files remain unverified with named remediation. Source or
  configuration drift still blocks grounding, and missing targets are not
  reconciled against an incomplete corpus. `mex check` applies the same rule:
  one unparseable file no longer skips every grounding check.
- Natural-language Wiki queries ignore question/stop words, rank exact-term
  answers ahead of broader matches, and explain partial or empty results. Hub
  search uses the same ranking and identifies unchecked health.
- Migration adopts `context/stack.md` and knowledge files with an explicit usable
  entity type. Check and validate name eligible or untyped files left outside
  the Wiki; pattern creation joins an existing Wiki through migration.
- `mex wiki link-sections` previews missing section-to-parent relationships;
  `--apply` records them. `mex wiki upgrade` previews a bounded review of broad
  code-linked facts, with an agent or manual prompt for explicit application.
  It requires a fresh graph and refuses flagged candidate links.
- Staleness counts commits affecting referenced paths, and script/dependency
  checks avoid brace-expansion and command-prose false positives. Dependency
  checks find nested `package.json` and `pyproject.toml` manifests, and Yarn or
  pnpm built-in commands are no longer reported as dead scripts. CLI discovery
  verifies MEX rather than trusting an executable's name. Hub groups repeated
  Wiki diagnostics with expandable detail.

## Graph navigation and Wiki search fixes

- File impact lists external callers before the file's own definitions at the
  existing default limits. `mex impact --direction callers|callees|both` walks
  proven call edges; the default remains callers. Impact and targeted Graph
  queries accept an indexed `file:line` target.
- C# resolves types and static calls through enclosing namespaces and `using`
  directives. Rust resolves crate paths and sibling workspace libraries. Outside
  C#, recursive calls link to themselves only when lexical evidence proves it.
- JS/TS assignments such as `app.init = function` become named nodes. CRLF
  sources produce the same graph as LF sources, and Graph error records now
  cause a nonzero executable exit.
- Wiki index v5 includes authored `description` and `triggers` in search text;
  run `mex wiki rebuild-index` after upgrading. Query hits expose cached health
  for each code link. Managed instructions point agents to bounded Wiki queries
  for project-knowledge questions.
- A grounding that matches only by structure and has no committed body hash
  remains unverified until reviewed regrounding. When this checkout has the old
  body, a moved symbol is judged
  against it, so a rename that edits a literal is reported as changed.
- Wiki synthesis uses a fresh immutable Graph snapshot. Long sync briefs use
  private prompt files, avoiding Windows command-line limits.

## Upgrade an existing project

Once 0.8.4 is available on npm, install the pinned release and preserve your existing graph:

```bash
npm install -g mex-agent@0.8.4
mex graph refresh
mex check
mex sync
mex wiki rebuild-index
```

Review grounding decisions and scaffold changes before committing through Git.
Do not delete a working graph as the first upgrade step. For a damaged or
incompatible store, follow `mex graph status`'s explicit recovery action. Projects
skipping 0.8.3 must also follow its one-time TypeScript identity guidance in the
[compatibility guide](COMPATIBILITY.md#upgrading-to-084).

Use `mex wiki migrate --dry-run` to preview newly adoptable knowledge, review
its proposed changes, and run `mex wiki migrate` when ready to apply them.
For MEX-managed integrations, preview with `mex skills sync --dry-run`, resolve
conflicts, then run `mex skills sync` and start a new agent session. Standalone
skills are an alternative installer; do not overlay them on managed copies.
A completed setup does not need to run again solely for this package upgrade.

Node.js 22.5 or newer with SQLite FTS5 remains required. Graph schema stays v4;
the disposable Wiki index advances to v5 and requires an explicit rebuild.
Canonical Markdown and Relay artifact versions are unchanged. Public `DriftIssue`
adds optional fields and `IssueCode` adds cases; exhaustive consumers should
review [the API compatibility notes](COMPATIBILITY.md#additive-api-changes-in-084).

## Known limitations

Dependency-rich TypeScript/JavaScript builds can still exhaust Node's heap. A
924-source disposable MEX copy with installed dependencies failed, and a
compiler-only probe reproduced exhaustion during signature rendering before
persistence. Progress, diagnostics, and process isolation contain and explain
that failure; they do not fix its memory requirement.

The browser's completion readiness still uses limited placeholder and
index-presence checks after restart, so a failed final validation can later
appear commit-ready. Oversized population prompts can exceed the Hub run-response
contract. These are separate follow-ups; this release does not claim every
setup or completion path is reliable.

**Full changelog:** [v0.8.3…v0.8.4](https://github.com/mex-memory/mex/compare/v0.8.3...v0.8.4).

## Contributors

Thanks to everyone who contributed code, tests, documentation, and integration
work since 0.8.3:

- @theyashasvipandey — graph refresh and Scope performance, compact fingerprints, Wiki search and adoption, grounding verdicts and maintenance, Windows setup fixes, and release integration ([#252](https://github.com/mex-memory/mex/pull/252), [#254](https://github.com/mex-memory/mex/pull/254), [#255](https://github.com/mex-memory/mex/pull/255), [#257](https://github.com/mex-memory/mex/pull/257), [#258](https://github.com/mex-memory/mex/pull/258), [#259](https://github.com/mex-memory/mex/pull/259), [#260](https://github.com/mex-memory/mex/pull/260), [#263](https://github.com/mex-memory/mex/pull/263), [#266](https://github.com/mex-memory/mex/pull/266), [#271](https://github.com/mex-memory/mex/pull/271), [#274](https://github.com/mex-memory/mex/pull/274)).
- @MEETNANDA8107 — nested dependency-manifest discovery and checker false-positive fixes ([#250](https://github.com/mex-memory/mex/pull/250), [#251](https://github.com/mex-memory/mex/pull/251)).
- @jamalkamaladdin — brace-expanded script names and command dependency claims ([#249](https://github.com/mex-memory/mex/pull/249)).
- @nitesh32 — verified MEX CLI discovery instead of trusting an executable's name ([#262](https://github.com/mex-memory/mex/pull/262)).
- @theDakshJaitly — terminal setup redesign, failure reporting, grounding/Wiki/Graph benchmark fixes, release verification, and finalization ([#271](https://github.com/mex-memory/mex/pull/271), [#274](https://github.com/mex-memory/mex/pull/274)).
