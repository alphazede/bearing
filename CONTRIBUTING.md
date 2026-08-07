# Contributing to Bearing

Thanks for the interest. This page covers how the project works and what helps
most.

## How this repository works

This repository is a public export. Development happens in a private repository,
and each release is copied here as a reviewed snapshot. A guard fails the build
if this repository ever gets ahead of the development one.

That has one practical consequence: **pull requests here cannot be merged
directly.** They are read as proposals. If a change is accepted, it is
implemented in the development repository, arrives in the next sync, and the
pull request is closed with a reference to the commit that carried it. Your name
stays in the discussion and the reason for the change stays in the history.

If that trade is not worth your time, open an issue instead. Issues are the most
useful contribution to this project right now.

## Reporting a bug

Open a bug report and include the Bearing version, how you installed it, your
operating system and Node version, and which harness you selected. If Bearing
printed a receipt or an error code, paste it. A receipt tells us more than a
description does.

Never report a security problem in a public issue. Use the [private
vulnerability reporting
form](https://github.com/alphazede/bearing/security/advisories/new).
[SECURITY.md](SECURITY.md) covers what to include and what to leave out.

## Proposing a change

Open a feature request that states the problem before the solution. Bearing is a
bounded product: local, single user, no telemetry, no hosted service, and no
agent that certifies its own work. A proposal that crosses one of those lines is
likely to be declined, and hearing that early saves you the work.

## Working on the code

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm typecheck
pnpm typecheck:test
pnpm test
pnpm build
```

`dist/` is committed, because a Git plugin install runs it with no build step. If
you change `src/`, run `pnpm build` and commit the result. `node
scripts/check-dist-freshness.mjs` fails if you forget.

Two more things worth knowing. Dependencies and the lockfile do not change
without a specific reason. A repair to a real bug starts with a test that fails
before the fix and passes after it.

## What gets reviewed hardest

Anything touching approval, containment, filesystem safety, output escaping,
validation, or a security gate. Those are the product rather than details of it,
so expect questions and expect to be asked for a test that proves the repair.
