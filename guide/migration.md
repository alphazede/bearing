# Existing-run migration and distribution checkpoints

How to retire a deep Bearing run without importing hidden runtime state, hand
work off in a project-local readable record, and resume with Bearing Lite.
Repository rename and npm deprecation remain separate owner-authorized release
checkpoints; this guide documents them only and does not perform remote actions.

Bearing Lite does **not** import `.bearing` data, Focus session state, MCP
runtime state, or CLI journey ledgers. Resume uses a verified human-readable
handoff, the existing approved plan, Bearing Lite, and native agent tools.

## Existing-run migration

For each project that still has deep Bearing run data, complete these steps in
order:

1. **Retire the old run read-only.** Leave historical `.bearing/`,
   `bearing-<plan>/`, Focus, MCP, and CLI runtime data in place. Do not mutate,
   import, or rewrite it as Lite input.
2. **Write a project-local human-readable handoff** in the affected repository
   (for example under that project's planning docs). Fill every field in the
   checklist below from visible plan text, Git history, and recorded evidence —
   not from hidden runtime stores.
3. **Verify the handoff** against the project tree and the current candidate
   revision: every field is present, paths exist or are intentionally listed as
   deleted, blockers and dependencies match the plan, and the next action is
   actionable without deep runtime state.
4. **Resume through Bearing Lite** using the existing approved plan plus native
   agent tools. Do not require `.bearing` import, Focus resume, MCP session
   restore, or CLI ledger continuity to continue work.
5. **Keep legacy runtime data read-only** until the handoff is verified. Archive
   or remove retired run data only as a later, separate owner-authorized action.

Stop if migration would require importing hidden runtime state as Lite resume
input. That is out of scope for Bearing Lite; produce a fuller handoff from
visible sources instead.

## Project-local handoff checklist

Use one handoff record per existing run (or per coherent plan-bound workspace).
Every field is required for a complete handoff:

| Field | What to record |
|---|---|
| **Approved plan** | Path and identity of the owner-approved plan the run was executing (title, date, or plan directory). |
| **Completed work** | Slices, waves, or deliverables already finished and accepted, with enough detail that a new agent does not re-implement them. |
| **Changed paths** | Exact repository paths modified by completed work (added, edited, or intentionally removed). |
| **Commands / evidence** | Commands run, test or validation results, review verdicts, and other durable proof that completed work actually landed. |
| **Blockers** | Open blockers, refusals, or owner decisions still required; write `none` only when none remain. |
| **Dependencies** | Incomplete prerequisites, external packages, environment needs, or cross-slice dependencies that still gate progress. |
| **Next action** | The single concrete next step for the receiving agent or owner, scoped so Lite can resume without deep runtime state. |

### Representative handoff template

Copy into the affected project and fill every section:

```markdown
# Migration handoff — <project or plan name>

## Approved plan
- Plan path:
- Plan identity / date:

## Completed work
- [ ] <slice or deliverable>: summary

## Changed paths
- `path/to/file` — added | edited | removed

## Commands / evidence
- Command or review: result / artifact path

## Blockers
- none | <blocker and owner>

## Dependencies
- none | <dependency and why it still gates work>

## Next action
- <one concrete next step for Bearing Lite + native tools>
```

### Handoff review (PROC-MIGRATION-01)

Before treating the handoff as verified, confirm:

- [ ] Approved plan is named and locatable in the project.
- [ ] Completed work is enumerated without relying on `.bearing` or other hidden state.
- [ ] Changed paths are explicit and match the tree or intentional removals.
- [ ] Commands and evidence are durable and inspectable.
- [ ] Blockers are stated (or explicitly `none`).
- [ ] Dependencies are stated (or explicitly `none`).
- [ ] Next action is sufficient to resume with Bearing Lite and native tools only.
- [ ] No step requires importing `.bearing`, Focus, MCP, or CLI runtime state.

A handoff that omits blockers, dependencies, or next action is incomplete. A
migration that imports hidden runtime state as Lite input is rejected.

## Read-only legacy retirement

Until the handoff is verified:

- Treat `.bearing/`, plan-bound `bearing-<plan>/` workspaces, Focus contexts,
  MCP session artifacts, and CLI journey ledgers as **read-only historical
  evidence**.
- Do not delete, rewrite, or “upgrade” those stores into Lite state.
- Do not point Bearing Lite at them as an import or resume source.

After the handoff is verified, archive or remove retired run data only under
explicit repository-owner authorization as a separate action. Permanent deletion
is never implied by writing the handoff.

## Distribution checkpoints (documentation only)

These steps are **owner-authorized release checkpoints**. Document them here so
operators know the approved sequence. This guide does **not** rename a
repository, publish or deprecate an npm package, mutate remotes, or perform any
other registry or network publish action.

Approved sequence (PROC-DISTRIBUTION-01 — verify before any remote action):

1. **Repository rename (in place).** Rename the existing public repository from
   `alphazede/bearing` to `alphazede/bearing-lite` so public Git history remains
   intact. Do not create a replacement repository that discards history.
2. **Package identity.** Publish future Lite releases only as
   `@alphazede/bearing-lite`, and only after exact package and native-client
   validation plus explicit owner approval.
3. **Deprecate the old package.** Deprecate `@alphazede/bearing` with a message
   that directs users to Bearing Lite. Do not republish Lite under the old
   identity.
4. **Link and evidence hygiene.** Update public repository, issue, security,
   marketplace, package, and documentation links to the Lite identity. Keep
   historical public evidence clearly historical rather than rewriting it as
   current Lite behavior.
5. **Protected settings and authorization.** Confirm protected branch or
   repository settings, registry credentials, and owner authorization before any
   remote mutation. Remote action without that checkpoint is blocked.

### Pre-remote owner checklist

Before any rename, publish, or deprecation command:

- [ ] Owner has explicitly approved the repository rename
      `alphazede/bearing` → `alphazede/bearing-lite`.
- [ ] Owner has explicitly approved publishing `@alphazede/bearing-lite` (not the
      old package name).
- [ ] Owner has explicitly approved deprecating `@alphazede/bearing` with a
      migration message pointing at Lite.
- [ ] Package identity on the candidate is `@alphazede/bearing-lite`.
- [ ] Protected settings and release authority are confirmed.
- [ ] No remote or registry action is performed from documentation-only work.

Repository rename, npm deprecation, and publication remain separate protected
owner actions. Completing this migration guide does not authorize them.

## What Bearing Lite does not do

- Import or migrate `.bearing` / Focus / MCP / CLI runtime state as resume input.
- Automatically rewrite deep run data into Lite task records.
- Perform repository rename, npm publish, npm deprecation, or other remote
  release actions from ordinary product use.
- Depend on another Bearing product's runtime, state store, or release gate to
  resume work.

Resume authority is the verified project-local handoff, the approved plan, and
native tools under Bearing Lite.

[Back to the README](../README.md)
