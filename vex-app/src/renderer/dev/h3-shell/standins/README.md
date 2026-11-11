# Kimm stand-ins

Dev-only art for the H3 shell harness, so her section can be built before her
real art arrives.

- **What they are:** crops of the H3 design mockup captures (round 3,
  3 Nov 2026). They are not her art files.
- **Low resolution:** the captures are 1600 px images of a 1440 px page, so
  each stand-in has about 1.1 image pixels per CSS pixel and looks soft on a
  2x screen. They were cut at the captures' own resolution, never upscaled or
  resampled, and saved as lossless WebP with no metadata. Each file matches its
  box in the capture pixel for pixel.
- **For the harness only:** nothing outside `src/renderer/dev/h3-shell/` may
  import them. Use `manifest.ts`, which maps each mood to its file.
- **They must never ship:** the build check (`scripts/check-build-artifacts.mjs`)
  refuses them in `dist/`. Every file name starts with `kimm-standin-`, and Vite
  keeps that prefix in its hashed asset names.
- **They are replaced in plan row S4-18:** her real files go in
  `public/art/kimm/` and are registered in `BRAND_ASSETS` with size limits. S4
  can't merge to `main` while these stand-ins are in use. Delete this directory
  when the real art lands.

## Files

Boxes are in source pixels as (left, top, right, bottom). Right and bottom are
excluded. The sources are in the mockup's `r3/` capture set.

| File | Source | Box | Size |
| --- | --- | --- | --- |
| `kimm-standin-portrait-hi.webp` | `landing-r3__plate-key-moods.webp` | 23, 131, 106, 214 | 83 x 83 |
| `kimm-standin-portrait-think.webp` | `landing-r3__plate-key-moods.webp` | 282, 131, 365, 214 | 83 x 83 |
| `kimm-standin-portrait-offer.webp` | `landing-r3__plate-key-moods.webp` | 540, 131, 623, 214 | 83 x 83 |
| `kimm-standin-portrait-held.webp` | `landing-r3__plate-key-moods.webp` | 800, 131, 883, 214 | 83 x 83 |
| `kimm-standin-portrait-refused.webp` | `landing-r3__plate-key-moods.webp` | 1060, 131, 1143, 214 | 83 x 83 |
| `kimm-standin-portrait-rest.webp` | `landing-r3__plate-key-moods.webp` | 1319, 131, 1402, 214 | 83 x 83 |
| `kimm-standin-section-hi.webp` | `h3-merged__welcome-open-1440.webp` | 276, 294, 754, 919 | 478 x 625 |
| `kimm-standin-section-offer.webp` | `h3-merged__approval-open-1440.webp` | 276, 294, 754, 919 | 478 x 625 |
| `kimm-standin-section-rest.webp` | `h3-merged__portfolio-open-1440.webp` | 276, 294, 754, 919 | 478 x 625 |
| `kimm-standin-strip-field.webp` | `h3-merged__welcome-closed-1440.webp` | 276, 294, 590, 355 | 314 x 61 |

- **Portraits:** these are the larger top-row key cells of the key-moods plate.
  The key cell is 76 CSS px.
- **Sections:** these are her open section over the Vex column (432 x 563 CSS
  px). The column's right-hand rule is left out.
- **Strip:** this is the closed strip's glyph field, without the figure. It
  stops where the Show Vex cell starts, so it covers the strip's first 283 CSS
  px. The cell takes the other 149.

## What the captures drew over her

A crop keeps any UI the mockup drew on top of her:

- **Hide Vex cell:** every section has it in the top-right corner, at image
  pixels 326, 0, 478, 62 (138 x 56 CSS px, flush top and right). The harness
  can draw the real cell over it.
- **Running square:** the think portrait has it at image pixels 0, 0, 16, 16.
- **Held:** this portrait is the offer pose with the mockup's dimming already
  applied. Don't dim it again.

The header portraits in the `h3-merged__*-closed-1440` captures are framed
differently from the key-moods plate. They have a darker ground and a tighter
face, and their offer pose has an open mouth. The plate is used here because it
is the only source with all six moods in the same framing.
