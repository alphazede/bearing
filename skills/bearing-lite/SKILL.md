---
name: bearing-lite
description: Bearing Lite Router for Journeys. Not for ordinary work, assigned packets, implementation, or publication.
---

The Router alone writes Journey planning state, owns owner conversation and owns Expedition
sequencing; planning nodes return owner questions. Plugin hosts are partial; skill-copy is skills-only.

1. Say `Preparing this Journey.` Acquire or resume a generation-bound checkout lease before
   planning or dispatch. A live same-checkout competitor returns `WAITING_ON` with sanitized identity.
2. Resume the next incomplete stage in the same generation; refresh `candidate_revision`
   for same-Journey progress. Never replay accepted stages or duplicate dispatch. Released,
   stale, forged, or branch/HEAD-drifted leases fail closed.
3. If `~/.agents/bearing-lite/default-role-lineup.md` is absent, create a proposed copy
   from `templates/default-role-lineup.md`; never infer identity values; recorded
   snapshot is authoritative for this Journey after approval. Later edits to
   `~/.agents/bearing-lite/default-role-lineup.md` have no effect on it except through an
   explicit owner-confirmed dated visible amendment. Dispatch uses lineup identity from the recorded snapshot.
4. Run missing stages in order: Repository Fit → Set Bearings → Gather Supplies.
   Gather Supplies is a Router-led interview, never dispatched. Its unresolved
   material intent blocks Map the Route.
5. Invoke Map the Route after settled intent. Do not ask for lineup or route
   before it: carry the owner-supplied lineup and `review_cadence: at-end` as
   proposals. No per-slice/per-round.
6. When `PLAN_REVIEW_READY` returns all five artifacts, show one integrated
   approval-or-change gate for outcome, design, route, lineup, role states,
   reasoning, cadence, and plan. Record the approved Journey type and snapshot;
   if any proposal changes, regenerate affected artifacts and return to the same
   gate. Never add a staged lineup or route-review gate. Dispatch only after approval.
7. Dispatch with recorded snapshot identity. Crewmate and Explorer may continue in-wave unchanged.
   Validate the lease at wave start, after drift, and before commit; use the visible wave receipt and
   update implementation and review once per wave.

Return `READY`, `WAITING_ON`, `OWNER_DECISION_REQUIRED`, or `COMPLETE`. Three
evidence-changing corrections outside assurance.
`max_assurance_rounds` is 1 per Journey; Direct route checks `assurance_rounds`, never
dispatch Navigator, and one review may authorize one repair. Verify repair
deterministically without another review; failed repair/scope change returns
`OWNER_DECISION_REQUIRED` naming the candidate and count. Only a separately scoped,
materially changed new Journey resets review allowance. `COMPLETE` ends Bearing assurance.
Authorized deployment keeps checks without reopening review.
Release the lease once: release the checkout lease exactly once on `COMPLETE` or `CANCELLED`; recovery needs explicit recorded generation increment and cannot steal a live lease.
Never implement, self-assure, select models, or publish.
