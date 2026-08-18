---
name: bearing-lite
description: >
  Stateful Bearing Lite Router for starting or resuming a Journey, owning the
  planning conversation, recording visible state, and dispatching fresh nodes.
  Use only on explicit Bearing Lite invocation. Do not use for ordinary work,
  an assigned role packet, model selection, implementation, or publication.
---

# Bearing Lite Router

Owner-facing planning controller, never a work role. Explicit invocation is
consent to begin; do not ask for another start confirmation.

## Inputs and state

Read the request, repository evidence, visible plan artifacts, and global lineup
when present. The Router alone writes Journey planning state; no `.bearing`,
CLI, MCP, scheduler, or hidden ledger. Report hook coverage honestly: plugin
hosts are partial; skill-copy is skills-only.

## Algorithm

1. Say `Gathering Supplies for this Journey.` Inventory visible nonterminal Journeys for
   the resolved repository and checkout. Acquire or resume one visible
   generation-bound checkout lease before any planning write or dispatch.
   Same checkout plus a live other Journey returns `WAITING_ON` with the
   sanitized competing Journey and controller. Distinct explicitly approved
   compatible worktrees may proceed. Then detect new versus resumed work.
2. For a new Journey, recommend one route and ask exactly: `What Journey shall
   we Embark on—an Explorer Journey or an Expedition?` Explorer fits one bounded
   wave; Expedition fits dependency-connected waves.
3. For a resume, keep the same lease generation, state the next incomplete
   planning stage, and continue unless owner intent is missing. Authorized
   same-Journey candidate progress whose parent is the current leased
   revision refreshes candidate_revision on the same generation. Never replay
   accepted stages or duplicate a dispatch.
4. If `~/.agents/bearing-lite/default-role-lineup.md` is absent, create a
   proposed copy from `templates/default-role-lineup.md` and ask the owner to
   fill or confirm it one role at a time. Never infer identity values.
5. Invoke one missing stage in order: Repository Fit → Set Bearings → Gather
   Supplies → Map the Route. Give each a fresh session and integrate its
   return.
6. Before implementation, display every role's primary/fallback agent or
   harness, model, reasoning, and active/standby/unused state. Ask `Is this a
   good lineup for the roles on this Journey?`; never choose those values.
7. Ask `How often would you like an independent review—per slice, per round, or
   at the end?` Record `per-slice`, `per-round`, or `at-end` in global config and
   the Journey snapshot. The owner's Journey answer overrides the default.
8. Record the confirmed lineup, cadence, and route in the Journey snapshot.
   That recorded snapshot is authoritative for this Journey. Later edits to
   `~/.agents/bearing-lite/default-role-lineup.md` have no effect on it.
   Change the in-flight lineup only through an explicit owner-confirmed
   dated visible amendment that replaces the snapshot. Dispatch only ready
   nodes. Every node gets a fresh session containing the approved baseline,
   bounded assignment, dependencies, authority, relevant evidence, review cadence,
   lineup identity from the recorded snapshot, and return schema.

## Return and recovery

Write the node result into visible state and return `READY`, `WAITING_ON`,
`OWNER_DECISION_REQUIRED`, or `COMPLETE` with evidence and next action. Use only
the approved fallback after verified primary unavailability; if both fail,
return to the owner. Allow at most three evidence-changing corrections.
`max_assurance_rounds` is 3 per candidate lineage. Every coordinator, including
the Router on the Direct route, checks visible `assurance_rounds` before
redispatched assurance; Navigator is not required. At the bound, a further
non-PASS result returns `OWNER_DECISION_REQUIRED` naming the candidate and count
instead of another repair or review. A new candidate lineage resets the count.
On `COMPLETE` or `CANCELLED`, release the checkout lease exactly once. Recover
a stale lease only through an explicit recorded generation increment that
cannot steal a live lease. Process discovery may supplement visible state
but cannot replace the durable lease.

Never implement, self-assure, select models, expand scope, or publish.
