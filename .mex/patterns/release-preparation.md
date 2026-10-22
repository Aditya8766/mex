---
name: release-preparation
description: Audit a MEX release candidate against current main, CI, published versions, and packaged contents before publication.
triggers:
  - "release preparation"
  - "release readiness"
edges:
  - target: "context/conventions.md"
    condition: "when verifying release changes"
  - target: "release-performance-gate.md"
    condition: "when a pinned performance gate fails"
  - target: "release-readme-visuals.md"
    condition: "when changing release README content or visuals"
last_updated: 2026-10-14
---

# Release Preparation

## Context

Load the current version's `docs/design/<version>-release-plan.md`, package
metadata, changelog, release notes, and compatibility guide. Treat prior
verification records as history; check the intended release commit directly.

## Steps

1. Inspect Git status and preserve unrelated edits before switching or pulling
   an authorized branch. Record any preservation stash so it can be recovered.
2. Compare current main with the last published GitHub tag and npm dist-tag.
   A version in package metadata does not establish publication.
3. Check CI on the exact intended commit, including Node 22/24, platform,
   browser, packed-install, evaluator, and pinned performance coverage.
4. Reconcile changes merged after the preparation PR into the release scope.
   Move applicable Unreleased entries into the selected version, preserve older
   release records, and use the intended publication date.
5. Verify actual Graph/Wiki schema versions and extractor identities against
   upgrade prose. Update the English README and the translations' upgrade
   paragraphs together. Preserve whole-team fingerprint compatibility guidance.
6. Build and inspect a package in an isolated temporary copy with its own
   dependencies. Build workspace contracts before typechecking a source archive
   without generated declarations. Keep the original `dist/` intact for running
   setup/Hub processes.
7. Record verification and pending actions in the release plan. Leave tagging,
   npm publication, and GitHub release creation pending until authorized.
8. End release notes with verified contributors from commits/merged PRs since
   the previous tag. Resolve relative documentation links to pinned repository
   URLs in the GitHub release body. An authorized npm dry run on the built
   tarball does not authorize actual npm publication.

## Gotchas

- Preparation PR CI does not cover changes merged afterward.
- Later Wiki index changes can invalidate an earlier "schemas unchanged" claim.
- Rebuilding the original `dist/` can remove chunks a running Hub still needs.
- Git switching, documentation preparation, commit/push, and public publication
  have distinct authorization and sharing boundaries.

## Verify

- Check version pins, release scope, dates, compatibility, and historical records.
- Check CLI version, public entry points, packed assets, templates, and skills.
- Run the applicable conventions checklist and `git diff --check`.
- Ensure generated state and preserved unrelated edits stay out of the release.

## Debug

For a failed gate, inspect its job steps and retained evidence before retrying.
Use the performance pattern for budget failures; do not widen limits to publish.

## Update Scaffold

- Update the release plan and Router with verified current state and pending work.
- Keep this pattern in the index; do not invent code groundings for this workflow.
