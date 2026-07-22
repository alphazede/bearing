---
type: implementation
name: lets-add-a-bbear-image-by-the-bearing-title-in-the-task-bar-on-the-top-l
status: draft
date: 2026-07-21
plan_spec: ./plan-spec.md
design: ./design.md
seit: ./seit.md
---

# Implementation — Add Bear Title Mark

## Dependency waves

- Wave 1: Slice 1.1 generates and approves the fixed local asset.
- Wave 2: Slice 1.2 consumes the approved asset and adds the server/rendering behavior.
- Wave 3: Slice 1.3 verifies the integrated route and responsive presentation.

## Phase 1 — Create and deliver the local title mark

### Slice 1.1 — Generate the compact bear title-mark asset

**Goal.** Add one generated repository-local PNG that reads as a compact bear
mark at title scale and matches the approved existing Bearing visual style.

**Requirement IDs.** AC-1, RISK-1, RISK-2

**Design IDs.** DES-1, CONTRACT-1

**SEIT proof rows.** SEIT-1

**Issue severity.** n/a

**Type.** manual

**Design lenses.** BizDD

**OOPDSA contract.** Requirement trace: generated bear replaces the diamond;
owner/boundary: `assets/` owns fixed artwork; pattern P-1 is not applicable;
DSA D-1 requires one fixed PNG only; invariant: no remote source, runtime
generation, or duplicate title-mark asset; SEIT proof row V-1.

**Implementation role.** Visual Designer

**Agent model route.** codex / gpt-5.6-terra

**Agent reasoning level.** medium

**Ponytail mode.** off

**Review path.** Harness-native reviewer when available; otherwise the
read-only Surveyor fallback.

**Required VnV references.** `seit.md` — Scope, Per-slice Matrix slice 1,
Cross-cutting Checks, and Gate Evidence.

**Required lint/static-analysis.** Image inspection at rendered title-mark
scale; no lint/static-analysis command applies to a PNG-only slice.

**Self-review record required?** no

**Files.** `assets/bearing-title-mark.png` (new).

**Acceptance.** One local PNG exists, is visually suitable at title scale,
matches the restrained Bearing style, contains no text/controls, and does not
alter existing artwork.

### 1.1 execution manifest

**Write set.** `assets/bearing-title-mark.png` only.

**Command IDs.** PROC-ASSET-INSPECTION

**Commands.** Verify the generated PNG exists and has content.

```bash
test -s assets/bearing-title-mark.png
```

**Stop condition.** Stop if the image is missing, empty, or fails visual
inspection at title scale.

**Human decision.** The owner must approve the generated title mark before
Slice 1.2 begins.

### Slice 1.2 — Serve and render the shared title mark

**Goal.** Load and serve the fixed PNG through the existing local-session
pattern, and replace the CSS diamond with the same decorative image in both
desktop rail and responsive header title renderings.

**Requirement IDs.** AC-2, AC-3, AC-4, AC-5, RISK-2

**Design IDs.** DES-1, DES-2, CONTRACT-2, CONTRACT-3

**SEIT proof rows.** SEIT-2, SEIT-3

**Issue severity.** n/a

**Type.** /tdd

**Design lenses.** CDD, SecDD

**OOPDSA contract.** Requirement trace: local route and two title renderings;
owner/boundary: `src/server/local-session.ts` owns byte loading, literal HTTP
route, markup, and styling; consume Interface Option 2; patterns P-1 explicit
static-resource branch and P-2 shared class contract; DSA D-1 fixed-byte asset;
invariants: literal path, decorative image, visible `Bearing` text, unchanged
existing routes, no generic filesystem serving; SEIT proof rows V-2 and V-3.

**Implementation role.** Frontend Engineer

**Agent model route.** codex / gpt-5.6-terra

**Agent reasoning level.** medium

**Ponytail mode.** full

**Review path.** Harness-native reviewer when available; otherwise the
read-only Surveyor fallback.

**Required VnV references.** `seit.md` — Integration Test Procedures,
Per-slice Matrix slice 2, Cross-cutting Checks, and Gate Evidence.

**Required lint/static-analysis.** `pnpm typecheck`; focused Vitest test from
the next slice must pass before this slice is complete.

**Self-review record required?** no

**Files.** `src/server/local-session.ts`.

**Acceptance.** Both title locations render the same decorative local image
beside visible `Bearing` text; the diamond is absent; the literal route returns
the PNG with required headers; no generic route or remote URL is introduced.

### 1.2 execution manifest

**Write set.** `src/server/local-session.ts` only.

**Command IDs.** CMD-TYPECHECK

**Commands.** Run deterministic type validation.

```bash
pnpm typecheck
```

**Stop condition.** Stop if the approved asset contract cannot be implemented
through the existing explicit local-session route and shared title markup.

**Human decision.** None after the owner approves the Slice 1.1 asset.

### Slice 1.3 — Prove route, markup, and responsive regression behavior

**Goal.** Extend focused local-session coverage and record desktop/narrow
inspection evidence for the title-mark change.

**Requirement IDs.** AC-2, AC-3, AC-4, AC-5, AC-6, RISK-2

**Design IDs.** DES-1, DES-2, CONTRACT-2, CONTRACT-3

**SEIT proof rows.** SEIT-2, SEIT-3, SEIT-4

**Issue severity.** n/a

**Type.** /tdd

**Design lenses.** BizDD, CDD, SecDD

**OOPDSA contract.** Requirement trace: proof of local delivery and usable
title presentation; owner/boundary: `test/local-session.test.ts` covers the
template and route contract; patterns P-1/P-2 and DSA D-1 are verified;
invariants: shared fixed URL, visible label, defensive response headers, and
unknown-route behavior; SEIT proof rows V-2 and V-3.

**Implementation role.** QA Engineer

**Agent model route.** codex / gpt-5.6-terra

**Agent reasoning level.** medium

**Ponytail mode.** full

**Review path.** Harness-native reviewer when available; otherwise the
read-only Surveyor fallback.

**Required VnV references.** `seit.md` — Required Commands, Integration Test
Procedures, Per-slice Matrix slice 3, Cross-cutting Checks, and Gate Evidence.

**Required lint/static-analysis.** `pnpm typecheck`;
`pnpm exec vitest run test/local-session.test.ts`.

**Self-review record required?** no

**Files.** `test/local-session.test.ts`.

**Acceptance.** Focused assertions prove both title references, decorative
accessibility treatment, PNG response headers, and retained 404 behavior.
Desktop and narrow inspection confirms controls remain usable and no diamond
remains.

### 1.3 execution manifest

**Write set.** `test/local-session.test.ts` only.

**Command IDs.** CMD-FOCUSED-TEST, CMD-TYPECHECK, PROC-RESPONSIVE

**Commands.** Run the focused regression test and type validation.

```bash
pnpm exec vitest run test/local-session.test.ts
pnpm typecheck
```

**Stop condition.** Stop if focused assertions, type validation, or desktop and
narrow visual inspection expose a route, accessibility, or layout regression.

**Human decision.** The owner confirms the final desktop and narrow title-mark
presentation before release.

## Execution boundary

This document is a draft only. Do not generate the image, edit source/tests,
run the listed commands, or begin a review until the owner approves the
regenerated route review.
