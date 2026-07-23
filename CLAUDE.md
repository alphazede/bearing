# Bearing Contributor Instructions

This repository is the public source for Bearing.

## Product boundary

Bearing is a local browser control room for bounded planning-agent work, owner
decisions, execution recovery, validation, and reviewable results. Keep changes
within that boundary unless the owner explicitly approves a design change.

## Data safety

- Never commit credentials, tokens, customer data, or content from non-public
  repositories.
- Treat screenshots, videos, npm contents, and release notes as deliberate
  public exports that require a data-spill review.
- Do not place provider credentials in CLI flags or repository state.

## Implementation rules

- Preserve unrelated work and inspect every diff before committing.
- Prefer the smallest change that satisfies the approved contract.
- Add a deterministic failing regression test before repairing a verified bug.
- Never weaken authentication, repository containment, filesystem safety,
  output escaping, validation, or security gates.
- Do not add dependencies or change the lockfile without explicit approval.

## Validation

Run focused tests while implementing. Before an integrated release candidate,
from the repository root:

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

After deterministic checks pass, perform one read-only review of the integrated
diff. Resolve only verified findings and rerun affected checks.

## Release flow

1. Complete development, validation, and review here.
2. Check the release diff for private data and unintended package contents.
3. Wait for every hosted check to pass on the exact commit.
4. Obtain owner approval for immutable tag creation and publication.

Never report a release as ready while required validation or security checks are
failing.
