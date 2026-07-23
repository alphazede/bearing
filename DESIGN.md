# Bearing Design System

A near-black local control room built around `#010102`, light gray text, and one restrained lavender-blue accent. The system reads as precise expedition software: dense, technical, calm, and quietly luxurious. Native system fonts keep it portable.

## Colors

| Token | Value | Use |
|---|---|---|
| `--canvas` | `#010102` | Page and chrome background |
| `--s1` | `#0f1011` | Card and panel surfaces |
| `--s2` | `#141516` | Elevated cards, hover states |
| `--s3` | `#18191a` | Deepest lifted surface |
| `--line` | `#23252a` | Hairline borders and dividers |
| `--line2` | `#34343a` | Stronger borders, input edges |
| `--ink` | `#f7f8f8` | Headlines and emphasized body |
| `--muted` | `#d0d6e0` | Secondary body, labels, meta |
| `--subtle` | `#8a8f98` | Tertiary type, badges, footnotes |
| `--accent` | `#5e6ad2` | Primary actions, focus rings, brand mark |
| `--hover` | `#828fff` | Primary button hover |
| `--success` | `#27a644` | Semantic success indicators only |

Lavender-blue (`--accent`) is the sole interactive accent. It appears on the brand mark, primary buttons, focus rings, and active journey-progress elements. It is never used as a section background or decorative fill. Semantic success, warning, and failure colors appear only when they communicate real state.

## Typography

The system uses the native system font stack: `system-ui, -apple-system, Segoe UI, sans-serif` for body and `ui-monospace, SFMono-Regular, Consolas, monospace` for code and badges. No external fonts are downloaded.

| Role | Size | Weight | Tracking | Use |
|---|---|---|---|---|
| Display (hero) | 32–54px clamp | 600 | -0.045em | Page heading |
| Section heading | 16–22px | 600 | -0.02em | Panel titles, card titles |
| Body | 14px | 400 | -0.01em | Default prose, form labels |
| Caption | 11–12px | 400 | 0 | Badges, meta, status text |
| Eyebrow | 12px | 400 | 0.1em | Uppercase section labels |
| Mono | 12–13px | 400 | 0 | Status tokens, phase labels, file paths |

## Layout

- Max content width: 1180px for main, 900px for intro panels, 780px for the repository panel.
- Header: 56px sticky status bar. The desktop brand is in the journey rail; the header brand appears on narrow layouts.
- Journey rail: 228px persistent left sidebar on desktop (62px collapsed), overlays on mobile.
- Cards use 12px border radius (`border-radius: 12px`). Buttons and inputs use 8px.
- Panel interiors use 16–20px padding. Section spacing is driven by `margin-top: 16px` between panels.
- The repository panel uses a three-column grid: repo card, browse button, signature image.

## Components

**Buttons.** Primary buttons use `--accent` background with white text and 8px radius. Secondary buttons use `--s2` background with a `--line2` border. Disabled buttons use `--s1` background with muted text. Standard controls carry `min-height: 40px` (44px on touch layouts); compact utility controls are explicit 28–34px exceptions.

**Cards.** Elevated surfaces use `--s1` or `--s2` backgrounds with 1px `--line` borders and 12px radius. Mode selection cards use 2px `--line2` borders that shift to `--accent` with a subtle glow on selection.

**Forms.** Text inputs and selects use `--s1` background with `--line2` borders, 8px radius, and full-width layout within their containers. Focus rings are 3px solid `--accent`.

**Badges.** Pill-shaped status markers (`border-radius: 999px`) with `--s1` background and `--subtle` text in monospace.

**Setup sheets.** Modal-like panels (`position: fixed`) centered in the workspace area with backdrop-filter blur and elevated shadow. The journey surface panels use a translucent `--s1` background with backdrop blur.

**Journey rail.** Sticky left sidebar with translucent dark background, journey dot indicators (green for running, amber for paused, lavender for complete), and scrollable history list.

**Wait indicator.** An indeterminate animated trail bar in `--accent` with elapsed time, activity status, and honest helper text. No invented percentages or ETA.

## Elevation

Depth is carried by the surface ladder (`--canvas` → `--s1` → `--s2` → `--s3`) and hairline borders. The system resists drop shadows on dark backgrounds. Setup sheets use `box-shadow` for modal layering.

## Artwork

- **Bearing at desk** (`bearing-office.png`): The signature visual, placed in a framed panel on the repository chooser. Alt text: "A bear in sunglasses working at a tidy office desk."
- **Expedition background** (`bearing-expedition.png`): Used as a fixed CSS background on the body with a dark overlay for contrast. Positioned right on narrow screens.
- **Explorer card** (`bearing-explorer-card.png`): Mode selection illustration, 190px height in cards.
- **Expedition card** (`bearing-expedition-card.png`): Parallel-execution illustration.
- **Title mark** (`bearing-title-mark.png`): 28px square decorative brand icon in the rail and narrow-layout header.

All artwork is served as PNG with `no-cache` and `nosniff` headers. Informative foreground images use meaningful alt text. Title marks are decorative with empty alt text; the fixed background is decorative behind contrast scrims and surfaces. No controls or essential text overlay artwork.

## Responsive behavior

- Breakpoint at 760px: rail collapses to overlay, grids go single-column, padding reduces to 16px.
- Breakpoint at 960px: repository panel drops the signature image column.
- Display heading scales from 54px to 32px via `clamp()`.
- Standard touch targets expand to 44px minimum on narrow layouts; compact 28–34px utility controls remain explicit exceptions.
- The expedition background shifts right on mobile to keep the content-safe dark area aligned.

## Accessibility

- Focus-visible outlines are 3px solid `--accent` with 3px offset on all interactives.
- `prefers-reduced-motion` disables all animations, transitions, and the indeterminate trail.
- The journey rail toggle and collapsed state are ARIA-labeled.
- Status regions use `role="status"` and `aria-live="polite"`.
- Progress indicators use `role="progressbar"` with descriptive labels.
- Forms use proper labels, required attributes, and `autocomplete` hints.
- The demo panel progress list uses `aria-current="step"`.
- Dialog elements use the native `<dialog>` element with `aria-labelledby`.
- Color is never the sole differentiator; badges, dots, and status text pair color with text labels.
