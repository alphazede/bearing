# CLAUDE.md — Bearing (private dev checkout)

**You are Claude Code** — implementer and reviewer for Bearing.

> Claude Code does **not** auto-load `AGENTS.md`. Open `AGENTS.md` on session
> start; it is the canonical source for this repo and this file is the
> Claude-Code lens over it.

This **private** repository is the canonical development checkout for Bearing.
`alphazede/bearing` is the clean public product export — not the place for
private plans, session history, or release evidence. Develop and review Bearing
changes here. Use the shared AlphaZede planning and orchestration skills from
the `Alphazedehq` repository; do not duplicate their schemas or routing rules.

## Product boundary

Bearing is a local browser control room for bounded planning-agent work, owner
decisions, execution recovery, validation, and evidence. Keep changes within
that boundary unless the owner explicitly approves a design change.

## Key rules (full detail in `AGENTS.md`)

- **Upstream authority.** This repo is the authoritative development base; make
  every product change here first. `alphazede/bearing` is a downstream export
  synced only from here and must never be ahead. Run `pnpm drift-guard` before any
  sync/release — it fails closed if the public repo is ahead or has content dev
  lacks.
- **Data boundaries.** Never commit credentials, tokens, non-public-repo
  content, customer data, raw agent-session history, private plans, or
  unredacted browser evidence. Keep private plans and release evidence out of
  tracked content unless the owner selects a redacted artifact. Synchronize only
  an owner-approved, reviewed snapshot to `alphazede/bearing`.
- **Implementation.** Preserve unrelated work and inspect every diff before
  committing. Prefer the smallest change that satisfies the approved contract.
  Add a deterministic failing regression test before repairing a verified bug.
  Never weaken auth, repository containment, filesystem safety, output escaping,
  validation, or security gates. No new dependencies or lockfile changes without
  explicit approval.
- **Commits.** No `Co-Authored-By` AI-model lines or proprietary model/prompt
  details in commit messages or repository files.

## Validation

Run focused tests while implementing. Before an integrated release candidate,
from the repository root:

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm typecheck:test
pnpm test
pnpm test:integration
pnpm build
pnpm dist-guard
pnpm eval:native
pnpm audit --audit-level=moderate
pnpm drift-guard
pnpm bran-guard
git diff --check
```

`pnpm bran-guard` self-contains both publication checks: npm's pack semantics
define the package surface and Git-tracked Markdown defines the public-export
surface. It fails closed on incomplete enumeration or unreadable files and
rejects `okf_status` or `public_boundary`, while permitting the legitimate bare
`type: design` plan field. `.bran/` is excluded only from the tracked export;
accidentally packaging it still fails. Full rationale is in `AGENTS.md`.

`pnpm dist-guard` rebuilds and fails closed if the committed `dist/` no longer
matches the current `src/` — including newly emitted output that was never added.
Git-based plugin installs run the tracked `dist/cli.js` with no build step, so
stale build output ships as product behavior. Unlike `drift-guard` (dev-only
governance, excluded from the public export), `dist-guard` belongs in **both**
this repo and `alphazede/bearing`, which also tracks `dist/`.

## Release flow

1. Complete development, validation, and review here.
2. Confirm `pnpm dist-guard` passes (commit any refreshed build output) and
   `pnpm drift-guard` passes before syncing.
3. Produce a bounded, reviewed public-export diff and check it for private data
   and unintended package contents.
4. Push the approved snapshot to a branch in `alphazede/bearing` and open a
   pull request to protected `main`; a direct push to public `main` is not
   possible.
5. Wait for `quality`, `Semgrep scan`, `Analyze (javascript-typescript)`,
   `Analyze (actions)`, and `CodeQL` to pass on the exact pull-request commit
   and resolve every review conversation. These are CodeQL default-setup job
   names; a stale required context that never reports blocks the merge with all
   checks green.
6. Merge the pull request into public `main` with a merge commit, preserving its
   individual commits. Do not squash: each commit carries its own issue
   reference and root-cause message, and that history is the release's audit
   trail.
7. Obtain owner approval for immutable tag creation and publication.

Never report a release as ready while required validation or security checks are
failing.
