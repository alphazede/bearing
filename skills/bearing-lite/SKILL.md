---
name: bearing-lite
description: Bearing Lite Router. Use only on explicit Bearing Lite invocation. Do not use for ordinary work, an assigned role packet, model selection, implementation, or publication.
---

Do not ask for another start confirmation. The Router alone writes Journey
planning state; no `.bearing` or hidden ledger. plugin hosts are partial;
skill-copy is skills-only.

1. Say `Gathering Supplies for this Journey.` Inventory visible nonterminal Journeys;
   acquire or resume one generation-bound checkout lease before any planning write or dispatch.
   Same-checkout live other Journey returns `WAITING_ON` with the sanitized competing
   Journey and controller. Distinct explicitly approved compatible worktrees may proceed.
2. New Journey: recommend one route; ask exactly: `What Journey shall
   we Embark on—an Explorer Journey or an Expedition?` Explorer=one bounded
   wave; Expedition=dependency-connected waves.
3. Resume: keep the same lease generation; continue at the next incomplete
   planning stage unless owner intent is missing. Authorized same-Journey
   candidate progress whose parent is the current leased revision refreshes
   candidate_revision on the same generation. Never replay accepted stages or
   duplicate a dispatch.
4. If `~/.agents/bearing-lite/default-role-lineup.md` is absent, create a
   proposed copy from `templates/default-role-lineup.md` and confirm one role at
   a time. Never infer identity values.
5. Invoke one missing stage in order: Repository Fit → Set Bearings → Gather
   Supplies → Map the Route; integrate return.
6. Before implementation, display every role's primary/fallback, model,
   reasoning, and active/standby/unused state. Ask `Is this a
   good lineup for the roles on this Journey?`; never choose.
7. Ask `How often would you like an independent review—per slice, per round, or
   at the end?` Record `per-slice`, `per-round`, or `at-end` in global config and
   the Journey snapshot.
8. Record lineup, cadence, and route; that recorded snapshot is authoritative for this Journey.
   Later edits to
   `~/.agents/bearing-lite/default-role-lineup.md` have no effect on it. Replace
   through an explicit owner-confirmed dated visible amendment. Dispatch only
   ready nodes. Every node gets a fresh session with lineup identity from the recorded snapshot.

Return `READY`, `WAITING_ON`, `OWNER_DECISION_REQUIRED`, or `COMPLETE`. Fallback
after verified primary unavailability; both failing returns to the owner. Three
corrections. `max_assurance_rounds` is 3 per candidate lineage. Router on the
Direct route checks `assurance_rounds`; Navigator is not required. Bound returns
`OWNER_DECISION_REQUIRED` naming the candidate and count; a new candidate lineage resets.
On `COMPLETE` or `CANCELLED`, release the checkout lease exactly once. Recover by
explicit recorded generation increment that cannot steal a live lease. Process
discovery cannot replace the durable lease. Never implement, self-assure, select
models, or publish.
