---
name: map-the-route
description: Build Bearing's complete validated route from an approved plan specification, including design, SEIT, and implementation slices, when the journey enters Map the Route.
---

# Map the Route

Follow the substep and artifact boundary supplied by Bearing; do not advance
into execution or invoke another planning skill.

For the design substep, resolve an owner decision only when it blocks honest
design, then write complete `design.md` and `seit.md`. Stop at Bearing's
design-and-SEIT validation checkpoint without drafting `implementation.md`.

For the implementation-drafting substep, reuse the validated design and SEIT.
Write `implementation.md` with traceable, bounded slices and execution manifests
that satisfy Bearing's supplied schema. Do not execute a slice or invoke another
planning skill.

Bearing owns deterministic `review.html` generation. Never hand-edit, summarize,
or replace it. The final review must embed the complete current `plan-spec.md`,
`design.md`, `seit.md`, and `implementation.md` sources with working artifact
links before the owner is asked to approve execution.
