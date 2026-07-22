# Bearing Agent Instructions

This dedicated repository is the canonical source and development checkout for
Bearing.

## Product boundary

Bearing is a local browser control room for bounded planning-agent work, owner
decisions, execution recovery, validation, and evidence. Keep changes within
that product boundary unless the owner explicitly approves a design change.

Use the shared AlphaZede planning and orchestration skills from the
`Alphazedehq` repository. Do not duplicate their schemas or routing rules here;
the current shared instructions remain authoritative for those workflows.

## Repository and data boundaries

- Never commit credentials, tokens, content from non-public repositories,
  customer data, raw agent-session history, private plans, or unredacted
  browser evidence.
- Keep private plans and release evidence outside tracked repository content
  unless the owner explicitly selects a redacted artifact for publication.
- Treat public prompts, screenshots, videos, npm contents, and release notes as
  deliberate exports that require a data-spill review.
- Do not create a release tag or publish npm without an explicit owner
  checkpoint.

## Implementation rules

- Preserve unrelated work and inspect every diff before committing.
- Prefer the smallest change that satisfies the approved contract.
- Add a deterministic failing regression test before repairing a verified bug.
- Treat optional agent output as recoverable when the authoritative result is
  valid; surface a specific diagnostic instead of an opaque fatal error.
- Do not weaken authentication, repository containment, filesystem safety,
  output escaping, validation, or security gates.
- Do not add dependencies or change the lockfile without explicit approval.

## Validation

Run focused tests while implementing. Before an integrated release candidate,
run from the repository root:

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm test:integration
pnpm build
pnpm eval:native
pnpm audit --audit-level=moderate
git diff --check
```

After deterministic checks pass, run one native read-only Codex review against
the integrated diff. Resolve only verified findings and rerun the affected
checks.

## Release flow

1. Complete development, validation, and review here.
2. Check the release diff for private data and unintended package contents.
3. Wait for every hosted check to pass on the exact commit.
4. Obtain owner approval for immutable tag creation and publication.

Never report a release as ready while required validation or security checks
are failing.
