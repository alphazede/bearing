---
type: seit
name: lets-add-a-bbear-image-by-the-bearing-title-in-the-task-bar-on-the-top-l
status: complete
date: 2026-07-21
applies_to: bearing
plan_spec: ./plan-spec.md
design: ./design.md
---

# Validation — Add Bear Title Mark

## Scope

Validate the generated local title-mark asset, its explicit local-session PNG
route, both app-shell title renderings, and responsive/accessibility regression
behavior. This excludes a general artwork refresh, browser favicon changes,
remote image delivery, and unrelated workflow behavior.

## Required References

- `plan-spec.md` — owner-approved scope and acceptance criteria.
- `design.md` — selected CDD/SecDD contract and OOPDSA proof obligations.
- `src/server/local-session.ts:35-38,147,156,161-162,1152-1169` — current
  asset, app-shell, and response patterns.
- `test/local-session.test.ts:227-233,268-274,434-451` — existing template,
  rail, and static-PNG response assertions.
- `DESIGN.md:270-290` — Bearing visual, accessibility, and asset constraints.
- `package.json` — `typecheck` and `test` command families.

## Required Commands

- **CMD-TYPECHECK** — `pnpm typecheck`
- **CMD-FOCUSED-TEST** — `pnpm test -- test/local-session.test.ts`
- **PROC-ASSET-INSPECTION** — Inspect the committed PNG at its rendered title-mark scale against the approved Bearing visual constraints.
- **PROC-RESPONSIVE** — Inspect desktop and narrow title areas for the decorative mark, visible product label, and usable controls.

The focused test command is mandatory for this narrow route/template change.
Run the full `pnpm test` only if the focused test or shared template behavior
shows a regression requiring wider evidence.

## CI Stage Inventory

No `tools/ci/` scripts or Jenkins-stage inventory is present in the supplied
repository map. For this plan, the package-script equivalents are active:

| Stage | Status | Repository command | Purpose |
| --- | --- | --- | --- |
| TypeScript type check | active | `pnpm typecheck` | Proves the server and asset declarations compile. |
| Focused local-session regression | active | `pnpm test -- test/local-session.test.ts` | Proves template and explicit image-route behavior. |
| Full test suite | conditional | `pnpm test` | Run only when focused evidence reveals shared regression risk. |

## Integration Test Procedures

1. Start the repository’s local-session test harness through the focused Vitest
   command.
2. Request `/` through its existing session-aware helper and assert the desktop
   rail and responsive-header title markup each reference the same fixed title
   mark, keep visible `Bearing` text, and no longer render the diamond.
3. Request the literal title-mark asset path and assert 200, `image/png`, a
   positive content length, `no-cache`, and `nosniff`.
4. Request an unrelated path and preserve the existing 404 expectation,
   demonstrating that no generic filesystem-serving behavior was introduced.
5. At desktop and narrow widths, inspect the title area: the mark is compact,
   decorative, visually compatible with Bearing, and does not hide the menu or
   status controls.

## Traceability Matrix

| SEIT row ID | Acceptance/risk ID | Design/contract ID | Boundary/test layer | Positive case | Negative/failure case | Command/procedure ID | Evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| SEIT-1 | AC-1, RISK-1, RISK-2 | DES-1, CONTRACT-1 | asset/manual inspection | One local PNG is legible and visually compatible at title scale. | The asset is missing, empty, externally sourced, visually unsuitable, or expands the authorized brand scope. | PROC-ASSET-INSPECTION | Asset path and image-inspection record. |
| SEIT-2 | AC-2, AC-3, AC-4 | DES-1, CONTRACT-2 | template/focused regression | Both title locations share the decorative image and preserve visible `Bearing` text. | A diamond remains, title locations diverge, or the image replaces the accessible text label. | CMD-TYPECHECK, CMD-FOCUSED-TEST | Typecheck and focused Vitest output. |
| SEIT-3 | AC-5, RISK-2 | DES-2, CONTRACT-3 | HTTP route/security boundary | The literal asset route returns the fixed PNG with the required defensive headers. | An unknown path resolves, headers weaken, or user-controlled filesystem resolution is introduced. | CMD-FOCUSED-TEST | Focused HTTP assertion output. |
| SEIT-4 | AC-6 | DES-1, CONTRACT-2 | responsive/manual browser check | Desktop and narrow layouts retain readable title text and usable controls. | The mark obscures text or reduces menu, focus, contrast, or touch-target usability. | PROC-RESPONSIVE | Desktop and narrow screenshot or inspection record. |

## Per-slice Verification and Validation Matrix

| Slice | Verification | Validation | Evidence |
| --- | --- | --- | --- |
| 1. Generate title-mark asset | Confirm a single PNG exists in `assets/`, contains no embedded remote dependency, and remains legible at rendered size. | Owner-visible bear cue matches existing Bearing visual style without a broader rebrand. | Asset path, image inspection record, source diff. |
| 2. Serve and render title mark | Focused test asserts both title references and exact PNG response headers; `pnpm typecheck` passes. | The title is recognizable and still text-labelled; fixed local delivery works in the control room. | Focused Vitest output, typecheck output, HTTP assertion output. |
| 3. Responsive regression proof | Verify narrow CSS/title markup retains reachable toggle and visible `Bearing`; unknown routes still 404. | Desktop and mobile owners can recognize Bearing without losing navigation usability. | Desktop/narrow screenshots or browser inspection notes, focused test output. |

## Cross-cutting Checks

- Verify the image is decorative (`alt=""` or equivalent) and the visible text
  remains the accessible name.
- Verify only a literal local asset route is added; reject a generic asset path,
  remote URL, runtime image generation, or third-party dependency.
- Verify the new response uses `image/png`, `Content-Length`, `no-cache`, and
  `X-Content-Type-Options: nosniff` consistently with existing assets.
- Verify the existing four asset routes, status badges, rail collapse control,
  and narrow menu control retain their behavior.
- Inspect the generated art against `DESIGN.md`: compact, restrained, readable,
  no controls/text over the artwork, and no new interactive color semantics.

## Optional / Unavailable Tools

- `tools/ci/` scripts: unavailable in this repository — advisory-only for this
  plan — nearest local equivalents: `pnpm typecheck` and focused Vitest.
- Automated visual-regression runner: not identified in the supplied repository
  map — advisory-only — nearest local equivalent: manual desktop/narrow browser
  inspection after focused tests.

## Gate Evidence

Before the design is considered implemented, retain:

- the generated asset’s repository path and visual inspection result;
- `pnpm typecheck` output;
- focused `test/local-session.test.ts` output covering the title mark and PNG
  response contract;
- desktop and narrow presentation evidence; and
- a self-review confirming no generic file-serving route, remote image URL, or
  unrelated UI change was added.
