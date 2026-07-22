---
type: design
name: lets-add-a-bbear-image-by-the-bearing-title-in-the-task-bar-on-the-top-l
status: complete
date: 2026-07-21
applies_to: bearing
plan_spec: ./plan-spec.md
lenses_applied: [BizDD, CDD, SecDD]
lenses_skipped: [DDD, EDD, RDD, ODD, PDD, GDD]
---

## Synthesis

**DES-1.** Replace the CSS diamond with one generated, repository-local PNG title mark.
The existing `Bearing` text remains visible and is the accessible product name;
the image is decorative. `src/server/local-session.ts` remains the sole owner
of embedded shell markup, styling, asset loading, and explicit asset routing.

**CONTRACT-1.** The selected lenses do not disturb the plan-spec stance. They sharpen it:
the change must be a bounded local visual asset, served only from the existing
local session boundary with no remote fetch, no user input, no new state, and
no change to navigation or workflow behavior.

## Use Cases and Communication Flows

### UC-1 — Desktop title mark

**Trigger:** An owner opens Bearing at a desktop width.
**Flow:** Browser requests `/` → local-session renders the journey rail → the
rail brand renders the decorative bear image plus visible `Bearing` text.
**Outcome:** The bear image replaces the diamond while rail controls retain
their current labels, dimensions, and behavior.

### UC-2 — Narrow-screen title mark

**Trigger:** The viewport reaches the existing narrow breakpoint and the
responsive workspace header becomes visible.
**Flow:** Browser uses the same loaded document → responsive CSS reveals the
workspace brand → the same decorative bear image appears beside `Bearing`.
**Outcome:** The mobile-menu control remains reachable and the visible text
continues to name the product.

### UC-3 — Local asset retrieval

**Trigger:** The browser resolves the title-mark image URL.
**Flow:** Browser → authenticated local-session HTTP handler → explicit
`/assets/<title-mark>.png` branch → PNG response with fixed content type,
content length, no-cache, and `nosniff` headers.
**Alternate:** An unknown path continues to receive the existing 404 behavior;
no generic filesystem exposure is added.

```text
Browser GET / ──> local-session template
                       │
                       ├── desktop rail: [decorative bear] Bearing
                       └── narrow header: [decorative bear] Bearing

Browser GET /assets/bearing-title-mark.png
                  └──> explicit local-session route ──> image/png response
```

Text equivalent: the page and the local image request have separate flows. The
same static local asset is referenced by both title locations; only the
explicit route may return its bytes.

## Test Strategy

### Stance (pre-lens)

Prefer focused server-template and HTTP-response regression tests over a broad
browser-suite expansion. The key questions are whether both title renderings
share the decorative asset safely and whether the new URL remains an explicit,
correctly typed local response.

### Stance revisions

No revision. CDD and SecDD confirm that exact markup/route assertions plus a
narrow responsive visual check provide sufficient proof for this static asset
change.

### Per-slice approach

| Slice | Type | Design lenses | Verification approach |
| --- | --- | --- | --- |
| 1. Generate title-mark asset | manual | BizDD | Inspect the committed PNG at title-mark scale against the approved Bearing visual constraints. |
| 2. Serve and render title mark | /tdd | CDD, SecDD | Add/update focused `local-session` assertions for both title renderings and the explicit PNG response headers. |
| 3. Responsive regression proof | manual | BizDD, CDD | Check desktop and narrow app-shell views; confirm text label, menu control, focus behavior, and no diamond remain. |

### Cross-cutting

- Run TypeScript type checking and the focused local-session test file.
- Confirm the asset is repository-local and no remote image URL, dependency,
  secret, or filesystem-derived request path was introduced.
- Inspect desktop and narrow layouts with reduced-motion behavior unchanged.

## BizDD

**Outcome.** The product title gains a recognizable Bear visual cue without
altering the owner’s control-room workflow.

**User and job.** A Bearing owner scanning the control room can recognize the
product mark at the left edge while retaining the readable product name.

**Why now.** The owner explicitly requested the bear image in place of the
current diamond.

**Risks and cost envelope.** A poorly composed tiny image could look noisy or
reduce legibility; a narrow local asset and markup change is easy to revert.
There is no runtime service, data, or operational cost.

**Owner / on-call / cost owner.** Existing local-session ownership remains
unchanged; no new on-call or vendor obligation is created.

**Definition of done.** A reviewer can see the generated bear mark before
`Bearing` on desktop and narrow layouts, verify the text remains visible, and
confirm the asset is served locally.

**Notable omissions.** Marketing, conversion, billing, and product-wide brand
refresh are deliberately out of scope.

## CDD

**Surfaces touched.** The embedded app-shell brand markup/CSS and one explicit
local static-asset HTTP path.

**CONTRACT-3.** `GET /assets/bearing-title-mark.png` returns the fixed
repository-local PNG with `Content-Type: image/png`, accurate `Content-Length`,
`Cache-Control: no-cache`, and `X-Content-Type-Options: nosniff`. Both title
renderings use that fixed URL and render the image as decorative.

**CONTRACT-2.** Existing four asset routes and all public API
routes retain their behavior. The `Bearing` text remains in both title
locations, so the product label and responsive control contract do not change.

**Versioning strategy.** No versioned API or generated schema is introduced;
the asset path is an internal static-route contract covered by a focused test.

**Interface option input.** The new asset URL is a meaningful route seam and
is resolved in the Interface Option Check.

**Validation and tests.** Extend the established HTML and PNG-response test
style in `test/local-session.test.ts`; retain the unknown-route check.

**Generated code provenance.** None. The image is generated once and committed
as a repository asset; runtime does not generate or fetch it.

**Notable omissions.** No public API, CLI flag, schema, or client-configurable
asset name is added.

## SecDD

**Threat model.** A local browser user or malformed request may request routes
that are not intended to expose files. The change must not turn `/assets/` into
a path-derived file server.

**Trust boundaries and validation.** The browser crosses into the local HTTP
handler only through the existing session/origin protections. The asset path is
a literal route selected by code, not a decoded user-supplied filename.

**Authn / authz.** Existing local-session controls remain unchanged; the new
route follows the same handler boundary as the existing static PNG routes.

**Secrets and sensitive data.** The generated image contains no secrets, user
data, or external credentials. No new logs or telemetry are introduced.

**Audit trail.** Source diff, focused test output, and visual review are the
required evidence; no runtime audit event is needed for a static image.

**Abuse cases.** Prevent path traversal and content-sniffing by using an
explicit literal route, `image/png`, and `nosniff`; do not add a catch-all asset
route or remote image proxy.

**Notable omissions.** No new authentication, authorization, storage, or
third-party dependency is required.

## Interface Option Check

### Options

1. **CSS/data-URI mark:** embed image bytes in the HTML/CSS template. This
   avoids a route but duplicates binary data in a source string and bypasses
   the established asset-serving pattern.
2. **Explicit local PNG route (selected):** load a committed PNG once and add
   a literal `/assets/bearing-title-mark.png` handler beside existing PNG
   routes.
3. **Generic asset route:** map a requested filename to disk. This is rejected
   because it expands the request surface and weakens the explicit-route
   boundary.

**DES-2.** Option 2 reuses the existing local asset contract,
keeps the generated asset inspectable in `assets/`, gives both title locations
one stable URL, and avoids user-controlled filesystem resolution.

## OOPDSA Implementation Design

### Requirement trace and ownership

| Requirement | Owner/boundary | Proof obligation |
| --- | --- | --- |
| Generated bear replaces diamond in two title locations | `assets/` and the app-shell template in `local-session.ts` | Both markup locations reference the same decorative image; the diamond styling is removed or no longer rendered. |
| Asset remains locally and safely served | `local-session.ts` asset constants and request handler | Exact PNG route returns required headers; unknown routes remain 404. |
| Responsive/accessibility contract remains intact | App-shell CSS and visible `Bearing` text | Desktop and narrow visual checks show readable text and reachable controls. |

### Interface-option consumption

Adopt Interface Option 2: one fixed asset constant and one literal route. The
template owns presentation references; the handler owns bytes and headers.

### Pattern and plain-code decisions

- **P-1 Explicit static-resource branch:** extend the existing repeated
  literal-route pattern. A registry or generic router is not justified for one
  additional asset.
- **P-2 Shared class contract:** use one title-mark class for rendered image
  sizing in both locations; do not retain a CSS-drawn fallback diamond.

### DSA decisions

- **D-1 Fixed-byte asset:** store the generated PNG as a fixed binary asset and
  load it once with the same `Buffer` pattern as the existing artwork. Lookup is
  constant-time through the literal handler branch; no collection, cache, or
  dynamic filename algorithm is needed.

### Edge cases and invariants

- The image path is literal and does not include a request parameter.
- The visible `Bearing` label remains adjacent to the decorative image.
- Both desktop rail and mobile header use the same asset, not divergent copies.
- No remote request, generic file read, or external dependency is introduced.
- Existing asset routes and unknown-route behavior remain unchanged.

### SEIT proof obligations

- V-1: inspect the generated PNG at its rendered size and verify it matches the
  restrained existing Bearing style.
- V-2: focused tests prove two image references, absence of the diamond, and
  the exact local PNG response contract.
- V-3: typecheck plus desktop/narrow visual checks prove the presentation
  change does not regress shell controls or accessibility labeling.
