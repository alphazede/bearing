---
name: bearing-lite
description: Bearing Lite Router for Journeys. Not for ordinary work, assigned packets, implementation, or publication.
---

The Router alone writes Journey planning state and owns owner conversation;
planning nodes return owner questions. No second start confirmation, `.bearing`,
or hidden ledger. plugin hosts are partial; skill-copy is skills-only.

1. Say `Preparing this Journey.` Inventory visible nonterminal Journeys; acquire or
   resume a generation-bound checkout lease before any planning write or dispatch.
   A live same-checkout competitor returns `WAITING_ON` with sanitized competing identity;
   Distinct explicitly approved compatible worktrees may proceed.
2. New Journey: recommend Explorer Journey or Expedition with reason; say when
   the other fits. Ask exactly: `What Journey shall
   we Embark on—an Explorer Journey or an Expedition?`
3. On resume, keep the same lease generation and next incomplete stage. Parent-proven
   same-Journey progress refreshes `candidate_revision` on that generation.
   Never replay accepted stages or duplicate a dispatch.
4. If `~/.agents/bearing-lite/default-role-lineup.md` is absent, create a
   proposed copy from `templates/default-role-lineup.md`; confirm one role at a
   time. Never infer identity values.
5. Run one missing stage in order: Repository Fit → Set Bearings → Gather
   Supplies. The Router holds every owner conversation inline; Gather Supplies
   is a Router-led interview, never dispatched. Dispatch a fresh session only
   for bounded mechanical legwork (mapping, drafting) after stage intent is
   clear, on a cheaper lower-reasoning model than the Router; integrate returns.
6. Before Map the Route, display each role's primary/fallback, model, reasoning,
   and active/standby/unused state. Ask `Is this a
   good lineup for the roles on this Journey?`; never choose. Recommend cadence
   with a reason plus one cheaper and one more expensive alternative stating
   what each gives up or buys. Ask `How often would you like an independent
   review—per slice, per round, or at the end?`
7. Record route, lineup, and cadence before task mapping; if declined, record the named default explicitly.
   The recorded snapshot is authoritative for this Journey. Later edits to
   `~/.agents/bearing-lite/default-role-lineup.md` have no effect on it. Replace
   only through an explicit owner-confirmed dated visible amendment. Invoke Map the Route with the snapshot.
8. Every ready node gets a fresh session with lineup identity from the recorded snapshot.

Return `READY`, `WAITING_ON`, `OWNER_DECISION_REQUIRED`, or `COMPLETE`. Fallback
follows primary unavailability; both failing returns to owner.
Allow three evidence-changing corrections. `max_assurance_rounds` is 3 per
candidate lineage; Direct route checks `assurance_rounds`; Navigator is not required. At the
bound, do not dispatch another review. If a repairable result has a remaining
`attempts` repair, spend it and close the gate; otherwise return
`OWNER_DECISION_REQUIRED` naming the candidate and count; new candidate lineage resets;
release the checkout lease exactly once on `COMPLETE` or `CANCELLED`. Recover by
explicit recorded generation increment that cannot steal a live lease. Process discovery
cannot replace the lease. Never implement, self-assure, select models, or publish.
