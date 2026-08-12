## What this changes

<!-- One or two sentences describing the observable behavior change. -->

## Why

<!-- Link the issue or explain the user-facing need. -->

## Verification

<!-- List exact commands and observed results. -->

```text

```

## Checklist

- [ ] `pnpm install --frozen-lockfile` passes
- [ ] `node --test test/*.test.mjs` passes
- [ ] `npm pack --dry-run --json` reports exactly 35 approved files
- [ ] `pnpm audit --audit-level=moderate` passes
- [ ] No CLI, MCP, server, hidden runtime state, provider route, or credential lookup was added
- [ ] No credentials, private paths, raw sessions, proprietary prompts/data, or unrelated evidence enters the diff

[CONTRIBUTING.md](CONTRIBUTING.md) explains the contribution process.

