---
type: plan-spec
name: lets-add-a-bbear-image-by-the-bearing-title-in-the-task-bar-on-the-top-l
status: draft
date: 2026-07-21
applies_to: bearing
---

## Problem

The Bearing title is preceded by a CSS-drawn lavender diamond in the desktop
journey rail and responsive header. The owner wants a bear image there instead.

## Goal

Replace that diamond with one newly generated, compact bear title mark that
matches the existing Bearing visual style and is displayed beside the Bearing
title wherever that title is rendered in the app shell.

## Scope

In scope:

- generate and add one repository-local bear image asset for the title mark;
- serve the asset through the local session server; and
- replace the CSS diamond in the desktop journey rail and responsive mobile
  header with the image while preserving the `Bearing` text label.

Out of scope:

- changing the existing office, expedition, or route-card artwork;
- changing the rest of the app-shell layout, navigation, product name, or
  browser favicon; and
- downloading a third-party image or adding an external image service at
  runtime.

## Current behavior

`local-session.ts` embeds the app-shell CSS and renders `.brand-mark` as a
12px rotated, accent-colored square. The rail title uses that mark, and the
responsive header contains the same mark before the visible `Bearing` text.
The server currently reads and serves the four existing local PNG assets only.

## Target behavior

A newly generated local bear title-mark image replaces the diamond before the
Bearing label in both app-shell title locations. The mark is decorative because
the adjacent visible product name supplies the accessible name. It remains
compact, does not obscure controls or text, and retains readable layout and
touch/focus behavior at the existing responsive breakpoint.

## Use cases

1. **Desktop workspace:** When the owner opens Bearing at a desktop width, the
   left journey rail shows the generated bear mark next to `Bearing`; collapse
   and navigation controls continue to work.
2. **Narrow workspace:** When the responsive header is shown, it displays the
   same bear mark beside `Bearing` without reducing the mobile menu control or
   runtime-status usability.
3. **Asset request:** When the local browser requests the new asset, the server
   returns the repository-local PNG with the same defensive response headers
   used for the existing artwork.

## Components

- `assets/`: destination for the generated, repository-local title-mark PNG.
- `src/server/local-session.ts`: owns asset loading, the local asset route,
  app-shell markup, and the title-mark styling.
- `DESIGN.md`: constrains the generated mark to Bearing's restrained dark UI,
  lavender-blue accent, accessible presentation, and non-ornamental visual
  language.

## Acceptance criteria

- **AC-1.** A newly generated bear PNG exists locally under `assets/`; it is designed as
  a compact title mark in the existing Bearing visual style.
- **AC-2.** No CSS diamond is rendered before the `Bearing` label in either the desktop
  rail or responsive header.
- **AC-3.** Both title locations render the same bear image and retain the visible
  `Bearing` text.
- **AC-4.** The image is decorative (`alt=""` or equivalent) and does not become the
  sole accessible product label.
- **AC-5.** The local session server serves the new image as `image/png` with the same
  no-cache and `X-Content-Type-Options: nosniff` posture as its existing image
  routes.
- **AC-6.** Desktop and narrow layouts preserve the existing control access, readable
  contrast, focus behavior, and minimum touch-target constraints.

## Risks and open questions

- **RISK-1.** The image must be generated during implementation; no external source image
  was supplied. The generated output therefore needs visual inspection against
  the existing Bearing assets before it is committed.
- **RISK-2.** The image is an intentionally narrow visual change. No alternate brand,
  favicon, or broader illustration refresh is authorized.

## Owner decisions

- The workspace does not contain a supplied title-mark source image; generate
  one instead of retaining the diamond.
- Generate the bear image in the same style as the existing Bearing visuals.
- Use it beside the Bearing title in both the desktop rail and responsive
  header.
- No additional requirements were supplied.

## Sequencing

1. Generate and inspect the compact local bear title-mark asset.
2. Add its server-side loading and explicit local asset route.
3. Replace the shared title diamond with the asset in both app-shell title
   renderings, then verify desktop and narrow layouts.

## Evidence consulted

- `docs/plans/2026-07-21-lets-add-a-bbear-image-by-the-bearing-title-in-the-task-bar-on-the-top-l/prompts/repository-map.md`: bounded inventory confirming the existing asset and server surfaces.
- `src/server/local-session.ts:35-38`: existing local PNG loading pattern.
- `src/server/local-session.ts:147,156,161-162`: CSS diamond definition and the desktop/mobile Bearing title renderings.
- `src/server/local-session.ts:1152-1169`: existing explicit PNG-serving response pattern.
- `DESIGN.md:270-290`: applicable compact, restrained, accessible Bearing visual constraints.

## Handoff to design-driven-build

Design pressure is a recognizable bear at title-mark scale without introducing
an ornamental illustration, changing the app's sole interactive accent, or
weakening the text label's accessibility. Design should specify the generated
asset's compact composition, transparent/background treatment, rendered size,
and responsive presentation. OOPDSA impact is limited to the local asset
loading/routing boundary; SEIT/VnV should cover the asset response plus visual
desktop and narrow-layout checks.

## See also

- `DESIGN.md`
- `src/server/local-session.ts`
