# VEX design system: V10 "Sepia Counter"

Status: v1, 2026-10-08. Owner pick: round 2 variant V10. This file is the single source of truth for every builder agent. Copy strings live in the copy deck and the facts in the fact canon; this file only decides how things look and behave. Strings shown here are quoted from the copy deck or the round 2 spec; the copy deck wins if they ever differ.

Source of the language: the tweet `reference-images/04-source-tweet-HSA7.jpg` (sepia hills, blue italic `(5000)`, white pixel horse with dithered trails, `AGENTIC  CAPITAL  MARKET` spread along the bottom). Reference builds: `reference-images/01-v10-hero.jpg`, `02-v10-structure.jpg`, `03-v10-cloud.jpg`.

Read section 9 (open decisions) before you build the hero.

This file is the website. The apps (VEX Desktop and VEX Cloud `/app`) follow R3 Minimal, built from `ELEMENTS.md` (every element) and `APP-R3.md` (the layout); where the apps differ from this file (two rooms, no pixel font, no spread caption, trading colours on trading values), those files say so and win for the apps.

> **October 2026 update (owner, 2026-10-17 and 18): no animals.** The eagle, the flock, the birds and the horse are gone from every page. Where this file describes pixel animals (principle 3, section 4.7, section 5, the page templates, the asset lists), read it as history: the scene layer now holds halftone dot clouds, the home holds Vex K2 rising from the vx token, `/token` holds the 3D vx token, and product cards carry dot screen emblems drawn in code (the cloud, a desktop computer, the Vex Inc. office tower; Vex Inc. replaces Arena). The current rules are `SKILL.md` sections 1.1, 5, 9, 11 to 13.

---

## 1. Principles

1. **Sepia photographs are the ground.** Heroes and chapter openers are soft, warm, scratched landscape prints; the warmth lives only inside photographs, the paper of the page stays cool.
2. **One blue for type and counters.** `#0000C0` (the logo blue) sets every blue word and line, `#0000FF` (the tweet blue) is reserved for giant counters and figures; blue sits only on pale sky or on paper.
3. **White pixel animals carry the motion.** A bird, a dot cloud, a horse, rebuilt as white blocks with 4x4 Bayer dither and dithered motion trails, always over a photograph, always in the band between sky and ground. Photographs never move; only animals move.
4. **A giant italic parenthetical counter opens each section; on photographs a mono caps caption spread in three groups closes it.** `(01)` top left, huge; three caption groups left, centre, right along the bottom edge.
5. **Status is shown by fill, never by color.** Solid = LIVE, dot screen = BETA, hatch = IN DEVELOPMENT, target = NEXT, empty = PLANNED.

---

## 2. Tokens

### 2.1 Theme decision: one committed light theme, no dark mode

V10 is a print on paper. A sepia print has no dark mode, and the page already contains its own darks: every photograph's ground zone is the night of the page, and that is where white type lives. A dark theme would force one of two failures: `#0000C0` on a night ground is 1.6:1 (illegible), so all blue type would have to switch to periwinkle, which breaks "one blue"; or the photographs would sit in a dark frame and lose the paper/print contrast that makes the sepia read as a print. So: `color-scheme: light` only, no `prefers-color-scheme` branch, `<meta name="theme-color" content="#F3F4F7">`.

### 2.2 Measured contrast (sampled from the V10 renders)

| Ground (sampled) | Hex | `#0000C0` | `#0000FF` | ink `#0A0D18` | white |
|---|---|---|---|---|---|
| Paper | `#F3F4F7` | 10.6:1 | 7.6:1 | 17.2:1 | 1.1:1 |
| Sky zone behind hero headline | `#D5CCC3` | 7.5:1 | 5.4:1 | 12.2:1 | 1.6:1 |
| Sky zone, defocused CLOUD crop | `#BCB3AA` | 5.8:1 | 4.2:1 | 9.4:1 | 2.1:1 |
| Far hills haze | `#C4B3A1` | 5.8:1 | 4.2:1 | 9.5:1 | 2.0:1 |
| Mid hills (hero status row) | `#9E744E` | 2.1:1 | 2.0:1 | 4.7:1 | **4.2:1 (fails small text)** |
| Dark hills (hero caption) | `#714E35` | 1.6:1 | 1.2:1 | 2.6:1 | 7.4:1 |

Two failures in the reference build that this system fixes (section 3.4): the hero status row (13px white on mid hills, 4.2:1) and the CLOUD parameter rows and `00:00 UTC` dial label (white on 3.9:1 and 2.4:1).

### 2.3 The token block

Paste as the whole of `app/tokens.css` on the phase 2 branch (the old file's cobalt, radius and status tokens are retired).

```css
:root {
  color-scheme: light;

  /* ---------- color: paper and ink (UI grounds are always cool) ---------- */
  --paper: #F3F4F7;          /* page ground, label boxes on photos, secondary buttons */
  --paper-2: #E8EAF2;        /* table stripes, code, pressed paper button */
  --ink: #0A0D18;            /* body text on paper and on the sky zone */
  --ink-2: #3A3E52;          /* secondary text, leads on paper (10.5:1) */
  --muted: #565C78;          /* tertiary text, group counts (6.0:1) */

  /* ---------- color: the one blue (two values of one hue, never a third) ---------- */
  --blue: #0000C0;           /* logo blue: every blue word, button, chip text, hairline flow */
  --blue-hi: #0000FF;        /* tweet blue: giant counters, figures, primary hover. Never body text */

  /* ---------- color: on photographs (ground zone only) ---------- */
  --on-photo: #FFFFFF;               /* captions, status rows, parameter values, pixel animals */
  --on-photo-2: rgba(255,255,255,.78); /* parameter keys, secondary lines on the ground zone */
  --rule-photo: rgba(255,255,255,.42); /* the hairline above a spread caption */
  --rule-photo-2: rgba(255,255,255,.34); /* parameter table rows on a photo */
  --label-box: #F3F4F7;              /* chips and buttons that sit on a photo get a paper box */

  /* ---------- color: lines on paper ---------- */
  --rule: rgba(0,0,192,.22);  /* chip outlines, quiet dividers */
  --rule-blue: #0000C0;       /* flows, brackets, timeline line, FAQ dotted rules */
  --rule-ink: #0A0D18;        /* risk callout frame only */

  /* ---------- color: sepia ramp. ONLY for photo grading LUTs and image placeholders ---------- */
  /* sampled from shared/art/hills-sepia.jpg, luma 32 to 236 in 9 even steps */
  --sepia-900: #282020;
  --sepia-800: #49352C;
  --sepia-700: #6C4D38;
  --sepia-600: #8D6647;
  --sepia-500: #A87F5A;
  --sepia-400: #BC997A;
  --sepia-300: #C7B6A6;
  --sepia-200: #DBD0C6;
  --sepia-100: #F3E9DF;

  /* ---------- color: ice. ONLY renewing points in the CLOUD scene, under 1% of a frame ---------- */
  --ice: #A6FEFF;

  /* ---------- color: textures ---------- */
  --dotmap: rgba(10,13,24,.08); /* world dot map dots on paper */
  --focus: #0000FF;             /* focus ring on paper and sky */
  --focus-on-photo: #FFFFFF;    /* focus ring on the ground zone */

  /* ---------- type families (self-hosted, app/fonts.css) ---------- */
  --serif: 'Instrument Serif', Georgia, 'Times New Roman', serif;      /* 400 + italic only */
  --sans: 'Instrument Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif; /* variable wght 400 to 700, wdth 75 to 100 */
  --mono: 'Departure Mono', 'SF Mono', Consolas, 'Liberation Mono', monospace; /* pixel mono, ONE weight (400): never set 500/600, never faux bold. Crispest at 11, 22, 33px */

  /* ---------- fluid type scale: min at 375px, max at 1920px, linear between ---------- */
  --fs-counter-xl: clamp(12.5rem, 7.949rem + 19.4175vw, 31.25rem); /* 200 to 500: hero and photo chapter counters */
  --fs-counter-l:  clamp(8rem, 5.3908rem + 11.1327vw, 18.75rem);   /* 128 to 300: paper chapter counters */
  --fs-counter-s:  clamp(2.5rem, 2.2573rem + 1.0356vw, 3.5rem);    /* 40 to 56: inline counter in a label */
  --fs-figure:     clamp(4rem, 3.1505rem + 3.6246vw, 7.5rem);      /* 64 to 120: key figures in data blocks */
  --fs-display:    clamp(3rem, 2.0291rem + 4.1424vw, 7rem);        /* 48 to 112: h1 */
  --fs-h2:         clamp(2.5rem, 1.7718rem + 3.1068vw, 5.5rem);    /* 40 to 88: section and chapter titles */
  --fs-h3:         clamp(2rem, 1.8786rem + 0.5178vw, 2.5rem);      /* 32 to 40: product names, card titles, FAQ */
  --fs-lead:       clamp(1.125rem, 1.0947rem + 0.1294vw, 1.25rem); /* 18 to 20 */
  --fs-body:       clamp(1rem, 0.9697rem + 0.1294vw, 1.125rem);    /* 16 to 18 */
  --fs-body-s:     clamp(0.875rem, 0.8598rem + 0.0647vw, 0.9375rem); /* 14 to 15 */
  --fs-nav:        clamp(0.9375rem, 0.9223rem + 0.0647vw, 1rem);   /* 15 to 16 */
  --fs-label:      clamp(0.75rem, 0.7197rem + 0.1294vw, 0.875rem); /* 12 to 14: mono caps eyebrows */
  --fs-chip:       clamp(0.6875rem, 0.6723rem + 0.0647vw, 0.75rem); /* 11 to 12 */
  --fs-data:       clamp(0.8125rem, 0.7822rem + 0.1294vw, 0.9375rem); /* 13 to 15: params, flow labels, dates */
  --fs-caption:    clamp(1rem, 0.7269rem + 1.165vw, 2.125rem);     /* 16 to 34: spread caption */

  /* line heights */
  --lh-counter: .86;  --lh-display: .9;  --lh-h2: .94;  --lh-h3: 1;
  --lh-lead: 1.45;    --lh-body: 1.6;    --lh-label: 1.2; --lh-data: 1.4; --lh-caption: 1.1;

  /* tracking */
  --tr-counter: -.02em;  --tr-counter-money: -.04em;
  --tr-display: -.014em; --tr-h2: -.012em; --tr-h3: -.005em; --tr-lead: -.003em;
  --tr-eyebrow: .18em;   --tr-status: .14em; --tr-chip: .12em; --tr-caps-data: .1em;
  --tr-data: .02em;      --tr-caption: .06em;

  /* ---------- spacing: 8px base (4px only for optical nudges) ---------- */
  --sp-half: 4px;  --sp-1: 8px;   --sp-2: 16px;  --sp-3: 24px;  --sp-4: 32px;
  --sp-5: 40px;    --sp-6: 48px;  --sp-8: 64px;  --sp-10: 80px; --sp-12: 96px;
  --sp-16: 128px;  --sp-20: 160px; --sp-24: 192px; --sp-30: 240px;
  --section-y: clamp(6rem, 5.0291rem + 4.1424vw, 10rem);  /* 96 to 160: paper section padding */
  --stack-l:   clamp(3rem, 2.2718rem + 3.1068vw, 6rem);   /* 48 to 96: between blocks inside a section */
  --stack-m:   clamp(1.5rem, 1.1359rem + 1.5534vw, 3rem); /* 24 to 48 */

  /* ---------- grid: 12 / 8 / 4 columns ---------- */
  --cols: 4;                                               /* 8 at >=640px, 12 at >=1024px (media queries below) */
  --gutter: clamp(1.25rem, 0.5825rem + 2.8479vw, 4rem);   /* 20 to 64: outer margin */
  --gap: clamp(1rem, 0.7573rem + 1.0356vw, 2rem);         /* 16 to 32: column gap */
  --max: 1792px;                                          /* content width at 1920 = 12 x 120 + 11 x 32 */
  --measure: 68ch;                                        /* whitepaper body */
  --nav-h: clamp(4rem, 3.3932rem + 2.589vw, 6.5rem);      /* 64 to 104 */
  --nav-h-sticky: 64px;

  /* ---------- shape ---------- */
  --radius: 0;            /* everything. No exceptions, focus rings included */
  --hair: 1px;            /* rules, chip outlines */
  --flow: 1.25px;         /* diagram flows and brackets */
  --frame: 1.5px;         /* planned swatch, risk callout */

  /* ---------- motion ---------- */
  --dur-1: 80ms;          /* press */
  --dur-2: 160ms;         /* hover color */
  --dur-3: 240ms;         /* toggles, FAQ open, sticky nav, emblem nudge */
  --dur-4: 480ms;         /* sheet, section reveal */
  --dur-develop: 1200ms;  /* photo develops in on first load */
  --frame-step: 200ms;    /* pixel sprite frame swap */
  --ease-out: cubic-bezier(.2,.7,.1,1);
  --ease-inout: cubic-bezier(.65,0,.35,1);
  --ease-step: steps(4, end); /* dither reveals: four Bayer thresholds */

  /* ---------- z-index ---------- */
  --z-photo: 0;  --z-grain: 1;  --z-counter: 2;  --z-animals: 3;  --z-content: 4;
  --z-nav: 50;   --z-sheet: 60; --z-toast: 70;   --z-skip: 100;
}
@media (min-width: 640px)  { :root { --cols: 8; } }
@media (min-width: 1024px) { :root { --cols: 12; } }
@media (prefers-reduced-motion: reduce) {
  :root { --dur-1: 0ms; --dur-2: 0ms; --dur-3: 0ms; --dur-4: 0ms; --dur-develop: 0ms; }
}
```

Breakpoints (literal, CSS variables cannot be used in media queries): `640px` (8 col), `1024px` (12 col, desktop nav), `1440px`, `1920px` (scale tops out; above it content centers at `--max`, photos stay full bleed).

Grid utility every section uses:

```css
.grid { display: grid; grid-template-columns: repeat(var(--cols), minmax(0, 1fr));
        column-gap: var(--gap); padding-inline: var(--gutter);
        max-width: calc(var(--max) + 2 * var(--gutter)); margin-inline: auto; }
```

At 1920 the column starts are 64, 216, 368, 520, 672, 824, 976, 1128, 1280, 1432, 1584, 1736 and the right edge is 1856 (same as `v10.css`). All desktop placements below are given as column spans.

### 2.4 Type roles

| Role | Face | Size | Weight / style | Color | Notes |
|---|---|---|---|---|---|
| Counter | Instrument Serif | `--fs-counter-xl` / `-l` / `-s` | 400 italic | `--blue-hi` | `font-variant-numeric: lining-nums`, nowrap, `aria-hidden` |
| Figure | Instrument Serif | `--fs-figure` | 400 italic | `--blue-hi` | key numbers in data blocks (`0.25%`, `85%`, `50,000`) |
| Display (h1) | Instrument Serif | `--fs-display` | 400 roman | `--blue` | one per page, `text-wrap: balance` |
| h2 | Instrument Serif | `--fs-h2` | 400 roman | `--blue` | sentence case with a period |
| h3 | Instrument Serif | `--fs-h3` | 400 roman | `--blue` (paper) | never below 32px anywhere |
| Lead | Instrument Sans | `--fs-lead` | 400 | `--ink-2` on paper, `--ink` on sky | max 60ch |
| Body | Instrument Sans | `--fs-body` | 400 | `--ink` | `text-wrap: pretty`, max `--measure` |
| Nav | Instrument Sans | `--fs-nav` | 500 | `--ink` | sentence case |
| Button | Instrument Sans | 17px desktop, 16px mobile | 500 | per variant | |
| Eyebrow | Departure Mono | `--fs-label` | 400 caps | `--ink` | `--tr-eyebrow` |
| Status row / group label | Departure Mono | 13px | 400 caps | white on photo, `--blue` on paper | `--tr-status` |
| Chip | Departure Mono | `--fs-chip` | 400 caps | `--blue` | `--tr-chip` |
| Data | Departure Mono | `--fs-data` | 400 | `--ink` on paper, white on photo | `tabular-nums lining-nums` |
| Spread caption | Departure Mono | `--fs-caption` | 400 caps | white on photo, `--blue` on paper | `--tr-caption` |

Rules: write every caps string in sentence case in the source and uppercase it with `text-transform` (screen readers otherwise spell caps words). Never bold or faux-bold Instrument Serif (`font-synthesis: none` on `html`). Italic serif is only for counters, figures and the inline counter; never for emphasis in text. English number formatting (`1,000`, `$1`, `0.25%`). Dates follow the copy deck: ISO `2026-09-24` in mono in tables, timelines, cards and meta lines; `24 September 2026` in prose. Versions as `v0.2.14`.

---

## 3. Photo treatment

### 3.1 What a V10 photograph is

A landscape (hills, plain, valley, coast, sky) printed as an old warm sepia silver print: soft focus, lifted blacks, cream highlights, fine grain, a few dust specks and hairline scratches. No people, no animals, no buildings, roads, vehicles, signs or text. Every photograph is composed in three horizontal zones:

| Zone | Height (16:9 hero) | Target luminance (WCAG relative L) | What may sit on it |
|---|---|---|---|
| Sky zone | top 0 to 55% | L 0.45 to 0.65 (`--sepia-200` to `--sepia-300`) | counters, blue display, ink body, nav, chips in label boxes, buttons |
| Band | 55 to 80% | L 0.12 to 0.45 (hill crests, haze) | pixel animals only. No text of any size |
| Ground zone | 80 to 100% | L at most 0.10 under every text box | white captions, status rows, parameter tables, white display |

Portrait crops (mobile) keep the same three zones with the sky zone at top 0 to 50%.

### 3.2 Master grading (offline, once per asset)

Write `scripts/grade-sepia.mjs` (sharp, already a devDependency). Steps, in order:

1. **Source.** At least 3840px on the long side. Generated sepia prints and colour photos both go through the same map so the whole site shares one tone curve (for `hills-sepia.jpg` the map is close to identity).
2. **Luminance.** `Y = 0.299R + 0.587G + 0.114B`, then auto-levels with a 1% clip at both ends.
3. **Print range.** Compress `Y` linearly into luma 32 to 236: no pure black, no pure white.
4. **Gradient map.** Map `Y` through the nine sepia stops (linear interpolation in sRGB between stops, stop `i` at luma `32 + i * 25.5`): `#282020, #49352C, #6C4D38, #8D6647, #A87F5A, #BC997A, #C7B6A6, #DBD0C6, #F3E9DF`. This is a tested recipe: prairie, ocean, sky-sea and cumulus photos mapped this way sit in the same family as the hills print.
5. **Softening.** Gaussian blur, sigma 3.2px at 3840 wide (0.083% of width; equals the `blur: 1.6` CSS px at DPR 2 in `v10.js`). Data chapters (a photo carrying a scene or a parameter table, like `(06)`) use a deep defocus: crop-zoom 1.5 then sigma 5px at 3840 (the `zoom: 1.5, blur: 2.5` of the CLOUD render).
6. **Exposure.** Multiply by a neutral grey of 0.85 to 0.91 (the `bright: 218` to `232` of `v10.js`) when a crop is too pale behind white emblems. Neutral only, never a coloured multiply.
7. **Legibility burn (ground zone).** Multiply by a neutral vertical ramp: 1.00 at 60% of the height, 0.62 at 85%, 0.55 at 100%, feathered. Then verify (section 3.4); burn harder locally under a parameter table if needed. The burn is part of the print; it must never read as a visible band.
8. **Vignette.** Bottom corners only, at most 10% darkening. The top left (counter) and the sky zone stay even.
9. **Export.** Master JPEG q92 into `public/art/`: one 16:9 master (3840x2160) and, for heroes, one 4:5 portrait master (2160x2700). Record the focal point (`fx`, `fy` in 0..1) next to each file in `lib/art.ts`.

`v10.js` `photo()` (canvas cover-fit, defocus with overscan, neutral multiply) stays the prototyping tool for mocks only; production never grades photographs at runtime.

### 3.3 Runtime

- `next/image` with `fill`, `sizes="100vw"` (heroes) or the column width (plates), `object-fit: cover`, `object-position: calc(fx * 100%) calc(fy * 100%)`, `priority` on the hero only. Set `images.formats: ['image/avif', 'image/webp']` in `next.config.ts`.
- Placeholder: `background-color: var(--sepia-300)` on the frame plus `placeholder="blur"` from a 16px wide blurred copy. A photo frame never flashes white or grey.
- Grain: one overlay per photo, `position: absolute; inset: 0; z-index: var(--z-grain); pointer-events: none; mix-blend-mode: multiply; opacity: .10`, background = the 220px fractal noise SVG tile from `shared/base.css` (`.grain`). Static. Paper sections carry no grain except the dot map.
- Develop in (first load only, IntersectionObserver once): `opacity 0 to 1` and `filter: contrast(.85) brightness(1.08)` to `none` over `--dur-develop`, `--ease-out`. Reduced motion: shown immediately. This is the only animation a photograph ever gets.

### 3.4 Legibility targets and QA

| Text | Minimum contrast | Measured against |
|---|---|---|
| Text under 24px (body, mono labels, chips outside label boxes, status rows, params) | 4.5:1, aim 7:1 for mono under 14px | the worst decile of photo pixels inside the text box (brightest 10% for white text, darkest 10% for dark text) |
| Text 24px and up (spread caption, display, h2, h3) | 3:1 | same worst decile |
| Counters and figures (decorative, `aria-hidden`) | 3:1 | median of pixels under the glyph box |
| Chips and buttons on a photo | carried by their paper box | box vs text, 7:1 or more |

Add `scripts/check-photo-contrast.mjs` (Playwright, already a devDependency): for each element with `data-on-photo`, screenshot its box with text hidden, compute the decile luminance, assert the table. Run it on 375, 1024 and 1920 widths before every merge.

Placement rules that follow from the zones: nothing but animals in the band. If a layout needs text where the zone is wrong, move the text or change the crop; never add a flat scrim.

**Type on a print is white in both themes (owner, 2026-10-15; this replaces "blue only on the sky zone").** Every block of type on a photograph (a hero title and lead, a closing band, the home greeting) is white, by day and by night, on a darkroom burn: the print under the block is multiplied by a sepia shadow at full strength over the block's box and feathered out on a smooth step (240px to the sides, 160px up and down), so no edge shows. By day the pale sky needs the burn to hold white type at 4.5:1; the night print takes a light one. The flock keeps out of the type (keep-out boxes) and never covers a word. Reference: the `.vx-print-type` and `.vx-print-burn` styles of the VEX Cloud web app (private). Chips and buttons on a print keep their paper boxes.

### 3.5 Never

- A blue tint, duotone, halftone or line screen over a sepia photograph (those are other round 2 variants).
- A colour photograph anywhere, or CSS `filter: sepia()` / `hue-rotate()` / `saturate()` on a colour photograph as a shortcut for the grade.
- A flat dark scrim, a visible gradient band, frosted glass or blur panel behind text.
- Text in the band, white text on an unburned sky, blue text on the ground.
- Ken Burns zoom, photo parallax, autoplaying photo slideshows. Photographs never move.
- Horizon line running through a headline; a vignette under the counter; upscaled or soft-from-compression skies (banding is hidden by the grain overlay; keep AVIF quality at 60 or higher).
- People, animals, buildings, roads, signage or text inside a photograph.

---

## 4. Components

Every component is a React server component with a CSS Module unless it draws on canvas (then `'use client'`, initialised lazily). State lives in `data-*` attributes. Keyframes used by a module are defined in that module (Turbopack localises keyframe names per module). Sizes are given as desktop (1920) / mobile (375).

### 4.1 Nav

**Desktop (at least 1024px).** Height `--nav-h` (104 at 1920). Anatomy, left to right: vx mark (`VxMark`, 60px wide at 1920, 44px at 1024, color `--blue`, top aligned to the eyebrow cap height, link to `/`); four links `Desktop`, `Cloud`, `Arena`, `Whitepaper` (Instrument Sans 500 `--fs-nav`, `--ink`) each starting on a column start: cols 7, 8, 9, 10 at 1280 and up, a flex row with 32px gaps starting at col 6 between 1024 and 1279; primary CTA `Join the Cloud beta` right aligned to the last column, button height 44px, 15px text.

- Over a photo hero the nav is transparent (`position: absolute`), and it always sits in the sky zone.
- States: link hover `--blue` with a 1px underline, offset 6px; `aria-current="page"` gets the same underline at 1.5px permanently; focus ring (section 4.6).
- Sticky: once the hero has scrolled out (IntersectionObserver on the hero), a compact bar slides in: `position: fixed`, height 64px, `background: var(--paper)`, bottom hairline `1px solid var(--rule)`, vx 36px wide, same links and CTA. Slide `translateY(-100%)` to `0` over `--dur-3`; reduced motion: appears without movement. Product pages behave the same.

**Mobile (under 1024px).** Bar height 64px: vx 44px left, a `Menu` text button right (mono 400 13px caps, `--tr-status`, 44x44 hit area). No CTA in the bar.

**Mobile sheet.** `position: fixed; inset: 0; z-index: var(--z-sheet); background: var(--paper)`. Never on a photo.
- Top row repeats the bar; the trigger reads `Close`.
- Products: one row per product, Instrument Serif `--fs-h3` link in `--blue` left, status chip right, hairline `--rule` between rows, row height 72px. Order: Desktop, Cloud, Arena, then Mobile as plain text (no page) with `[PLANNED]`.
- Whitepaper: mono eyebrow, then the ten chapters as rows: inline counter `(01)` in Instrument Serif italic 32px `--blue-hi` plus the chapter label in mono caps 13px `--ink`, two columns at 480px and up.
- Actions pinned to the bottom with 24px padding: primary `Join the Cloud beta` and ghost `Download Desktop`, both full width, 48px high.
- Behaviour: opens with opacity 0 to 1 and `translateY(-8px)` to 0 over `--dur-3`; focus moves to the first link; focus is trapped; `Esc` and `Close` close it and return focus to `Menu`; the rest of the page gets `inert`; body scroll locked. Reduced motion: no transform.

### 4.2 Counter

The giant `(01)`: the hero of every section.

- Anatomy: `(`, two digits, `)` in one span. Instrument Serif 400 italic, `--blue-hi`, `line-height: var(--lh-counter)`, `letter-spacing: var(--tr-counter)`, `white-space: nowrap`, `font-variant-numeric: lining-nums`, `aria-hidden="true"`.
- Sizes: **XL** `--fs-counter-xl` (500 / 200) on photo sections; **L** `--fs-counter-l` (300 / 128) on paper sections and in the chapter rail; **S** `--fs-counter-s` (56 / 40) inline next to an eyebrow.
- Placement: top left of its section, hung optically: left edge at `calc(var(--gutter) - .06em)` (the italic paren overhangs; 34px at 500px in the reference). Top: `calc(var(--nav-h) - 12px)` on heroes (92px at 1920), and the section's top padding on paper. Spans cols 1 to 5 (XL) or 1 to 4 (L). On a photo it must sit entirely in the sky zone.
- Layering: above the photo and grain (`--z-counter`), below animals and content. Animals draw over the counter; text never overlaps it.
- Numbering: every hero carries a giant XL `(01)` (on Home it also reads as `ONE USER. ONE AGENT.`, as in the picked render). On Home, the whitepaper chapters are numbered `(01)` to `(10)` again, introduced by the whitepaper preface; Home sections outside the whitepaper (products strip, preface, releases, FAQ) have no counter. On product pages the sections after the hero continue `(02)`, `(03)`, `(04)`; the closing CTA has none.
- Key-number swap: the giant slot may hold one canon number instead of the section number (`$1` on the CLOUD chapter, `letter-spacing: var(--tr-counter-money)`, size `--fs-counter-xl` x 1.08). The section number then moves inline (S) before the eyebrow. At most one swap per page; the number must be in `00-canon.md` with its status.
- Mobile: L or XL as above, placed above the eyebrow with 8px between, never beside text.
- States: none. Counters do not count up, flip, scramble or animate.
- Accessibility: the chapter number is repeated for screen readers inside the heading: `<h2><span class="visually-hidden">Chapter 6. </span>...</h2>`.

### 4.3 Section header

- Anatomy: counter (L, or S inline when swapped) + eyebrow (mono caps `--fs-label`, `--tr-eyebrow`, `--ink`) + title h2 (`--fs-h2`, `--blue`, `--lh-h2`, `--tr-h2`) + lead (`--fs-lead`, `--lh-lead`, `--ink-2` on paper, `--ink` on sky, max 60ch) + optional group label (mono 400 13px caps `--blue` right aligned on the last column, count in `--muted`, e.g. `PRODUCTS 4`).
- Desktop: counter cols 1 to 4; text block starts col 5 on paper, col 7 on hero photos, col 8 on photo chapters with a swap. Eyebrow to title 16px; title to lead 32px; lead to content `--stack-l`. Titles use manual line breaks at 1024 and up.
- Mobile: single column, counter, then eyebrow, title, lead stacked; title wraps naturally (`text-wrap: balance`).
- Variants: `paper` and `photo` (the photo variant must pass section 3.4).

### 4.4 Spread caption

The tweet device: exactly three groups justified across the content width.

- Anatomy: `<p class="spread">` with three spans, `display: flex; justify-content: space-between`, mono 400 caps `--fs-caption`, `--tr-caption`, `--lh-caption`. Each group is at most three words taken from existing copy (no new copy).
- Placement: bottom of a photo section, baseline `clamp(24px, 3vw, 50px)` from the section bottom, inside the ground zone, white. On heroes a hairline `1px var(--rule-photo)` runs across the content width 36px above the caption, and the status strip sits above that hairline.
- On paper (rare: section closers) the caption is `--blue`.
- Mobile (under 640px): a staircase, three lines: first left aligned, second centred, third right aligned, `--fs-caption` (16px), 4px between lines. Never shrink below 16px to force one line.
- Accessibility: one paragraph; give it `aria-label` with the three groups joined into a sentence.

### 4.5 Status chip and status strip

Five statuses from the canon. The fill of a 10px square swatch carries the meaning; the bracketed word repeats it.

| Status | Swatch (10x10, `box-sizing: border-box`, color `currentColor`) |
|---|---|
| `LIVE` | solid fill |
| `BETA` | 1px border + dot screen inside: `radial-gradient(currentColor 1px, transparent 1.2px) 0 0 / 3px 3px` |
| `IN DEVELOPMENT` | 1px border + 45 degree hatch: `repeating-linear-gradient(45deg, currentColor 0 1px, transparent 1px 3px)` |
| `NEXT` | 1px border + a solid 4x4 centre square |
| `PLANNED` | 1.5px border, empty |

Gradient functions are allowed here only to draw hard-edged patterns, never smooth ramps.

- Chip anatomy: `<span class="chip" data-status="live">` = swatch + `[LIVE]` (brackets in `aria-hidden` spans). Mono 500 `--fs-chip`, caps, `--tr-chip`, padding `6px 10px 6px 8px`, gap 8px, height 24px, `--blue` text and swatch.
- On paper: transparent ground, `outline: 1px solid var(--rule)`. On a photo: paper label box (`background: var(--label-box)`, no outline), like the white label box in the tweets. On a photo a chip may sit in any zone, since it carries its own ground.
- Parameter tag (`PROPOSED PARAMETERS`, `OPEN`): same chip without a swatch, `outline: 1px solid` in the current text color, 11px.
- Neutral labels that are not a status (`done` on Arena milestones, and any label the copy deck adds, such as one for the latest release) use the chip without a swatch and without brackets.
- Ice is never used for status.

**Status legend** (Home preface, tooltip): a two column list, chip left (fixed 180px column) and the one line definition from the copy deck 0.1 right (Instrument Sans 15px `--ink-2`), rows 40px with `--rule` hairlines; the two parameter tags close the list.

**Status strip (hero).** One group per product: product name (mono 400 13px caps, `--tr-status`, white) + chip (on-photo) + optional version (mono 400 13px, `.06em`, white, links to the release note). Groups start on cols 1, 3, 5. Sits in the ground zone above the caption hairline (the burn must bring it to at least 4.5:1, section 3.4). Mobile: one row per product, name left, chip right, 40px rows. Product heroes use a single group (chip + the status note from the copy deck, e.g. `Not public yet. Mainnet is switched off.`, in Instrument Sans 15px white).

**Meta line.** A mono 13px caps line of facts separated by ` · ` (e.g. the Desktop hero meta strip, the footer status line), `--tr-status`, white on the ground zone or `--ink-2` on paper. It may wrap; it is not a spread caption (any number of groups, left aligned).

### 4.6 Buttons

All: Instrument Sans 500, `border-radius: 0`, no shadow, height 56px (desktop) / 48px (mobile, full width when stacked), padding `0 26px` / `0 20px`, 17px / 16px text, `border: 1px solid transparent`, transitions on background and color `--dur-2`.

| Variant | Rest | Hover | Pressed | Where |
|---|---|---|---|---|
| Primary | `--blue` ground, `--paper` text | `--blue-hi` ground | `--blue` ground, `translateY(1px)` | one per viewport |
| Secondary on photo (paper) | `--paper` ground, `--blue` text | `#FFFFFF` ground, `--blue-hi` text | `--paper-2` ground | beside a primary on a photo; download tiles |
| Ghost | transparent, 1px `--blue` border, `--blue` text | `--blue` ground, `--paper` text | as hover, `translateY(1px)` | on paper |
| Ghost on ground zone | transparent, 1px white border, white text | white ground, `--blue` text | as hover | only on the dark ground zone |
| Text link | Instrument Sans, `--blue`, underline 1px offset 3px | `--blue-hi`, underline 1.5px | | in body text |
| Mono link | mono caps 13px `--blue`, trailing `↗` for external | underline | | footers, release rows |

Focus (every interactive element): `outline: 2px solid var(--focus); outline-offset: 3px` on paper and sky, `var(--focus-on-photo)` on the ground zone. Square. No disabled buttons: if something is not available, show its status chip instead.

### 4.7 Photo plate with pixel animal

The unit every photo section is built from.

- Anatomy, bottom to top: frame (`position: relative; overflow: hidden; background: var(--sepia-300)`), graded image (`next/image`), grain overlay, counter (optional), animal canvas (`<canvas aria-hidden="true">`, `--z-animals`, `pointer-events: none`), content layer (`--z-content`).
- Formats: **full bleed section** (100vw x `max(100svh, 640px)`, capped at 1200px, used by heroes and photo chapters); **inset plate** (grid aligned, aspect 3:1 for product strips, 16:9 for chapter plates, 1:1 for tiles, 4:3 for download tiles).
- Props: `src`, `portraitSrc`, `focal: [fx, fy]`, `zones: { skyEnd: .55, groundStart: .80 }`, `animals: Animal[]` with positions in fractions of the plate (section 5).
- Layout: the section is a flex column: sky block (counter, header, buttons), band (`flex: 1`, at least 160px, holds animals), ground block (status strip, caption, tables). `object-position` keeps the horizon in the band at every width.
- States: loading (sepia placeholder), developed (section 3.3), static (reduced motion or off screen: the animal canvas shows one composed frame).

### 4.8 Product card / plate

Used by the `(01)` structure map (compact) and the Home products strip (full).

- Anatomy: frame (photo plate, aspect 3:1 desktop, 2:1 mobile) with one white emblem placed right of centre, product name below (Instrument Serif `--fs-h3`, `--blue`, left), status chip right aligned to the frame edge on the same baseline.
- Two densities. **Compact** (the `(01)` map): frame, name, chip; frame and name are one link to the product page. **Full** (the Home products strip): adds the one-liner (Instrument Sans 16px `--ink-2`, max 5 lines), the meta line (mono 13px caps `--ink-2`) and one or two mono links (`Download`, `How it works`); here only the name and the links are links, the frame is decorative.
- Emblems: **Desktop** = eagle bird (pixel sprite, white, `bird-3` until `src-eagle-soar.png` exists); **Cloud** = dot cloud (`dotCloud`, white points, clipped to the frame); **Arena** = the pixel horse (`pixel-horse-white.png`, raster); **Mobile** = no photo: an unexposed frame, 1.25px `--blue` corner brackets with 14px arms on the frame rectangle, empty inside.
- Exposures: each built product uses a different crop of the graded prints (`v10.js crop()` boxes in `home-structure.html` are the reference), exposure multiply 0.80 to 0.91 so the white emblem reads.
- Sizes: desktop 3 columns each (424 x 140 at 1920), four in a row; tablet two per row; mobile one per row, full width, 2:1.
- States: hover = name underline 1px and the emblem nudges 8px in its direction of travel over `--dur-3` (`--ease-out`); focus = ring around frame and name; reduced motion = underline only. Planned cards are not links (no page yet) and have no hover.

### 4.9 Flow diagram

The `(01)` structure map and any mechanism diagram (fees, mint, copy trading).

- Nodes: product cards (4.8) and economy tiles (1 column square, 120px at 1920: sepia crop with a white mark: vx path for `$VEX`, dotted CLOUD glyph for `CLOUD`; planned tiles are bracket frames, 12px arms). Name below in Instrument Serif 32px `--blue`, chip under it.
- Flows: inline SVG, `stroke: var(--rule-blue)`, `stroke-width: var(--flow)`, orthogonal only (90 degree turns, square corners), never crossing another flow or a label. Solid when the flow exists today (LIVE or BETA); dotted `stroke-dasharray: 1.5 4; stroke-linecap: round` when it is planned.
- Arrowheads: filled triangles, 10px wide, 9px long (`a = 5, b = 9` in `v10.js`), tip touching the target edge with a 2px gap.
- Group bracket: a 1.25px line under a group with 16px legs up at both ends; flows leave from the bracket.
- Labels: mono `--fs-data`, one line each, from copy. **Source** label in `--ink`, **result** label in `--blue`. Horizontal flow: source centred 12px above the rule, result centred 12px below. Vertical flow: both labels to the right, 18px from the line, stacked 30px apart, source nearest the flow's origin, result nearest the arrowhead.
- Group labels (`PRODUCTS 4`, `ECONOMY 5`) right aligned above each group.
- Ground: paper with the world dot map (`dotmap-world.png`, dots `--dotmap`), full section width.
- Mobile (under 1024px): the SVG is replaced by its semantic twin, an ordered list: nodes stack in one column; each flow is a row with a 1.25px vertical rule on the left (24px from the edge) ending in a downward arrowhead, source label above result label beside it. The same list is present in the desktop DOM as visually hidden text; the desktop SVG is `aria-hidden`.
- No animation of flows in V10 (no marching ants, no particles).

### 4.10 Parameter table

- Anatomy: head row (CLOUD glyph 44px or a product emblem + parameter tag), then rows: key left (mono 500 caps `--fs-data`, `--tr-caps-data`), value right (mono caps or a chip). Semantic `<table>` with `<th scope="row">`.
- Row height 36px desktop, 44px mobile; 1px rule on top of every row and below the last.
- On a photo: keys `--on-photo-2`, values `--on-photo`, rules `--rule-photo-2`; the whole table must sit in the ground zone at L 0.10 or lower (burn locally; the reference CLOUD render fails this and must be fixed). On paper: keys `--ink-2`, values `--ink`, rules `--rule`.
- Desktop width: cols 8 to 12 on photo chapters (728 at 1920), cols 5 to 11 on paper.
- Mobile under 480px: value drops under its key, both left aligned, row height auto with 12px padding.
- Every parameter that is not live carries the chapter's parameter tag (`PROPOSED PARAMETERS`) in the head row; a row whose value is not decided shows the `OPEN` tag in the value cell.
- **Ledger variant** (burn ledger in `(05)`, open parameters table in `(10)`): same rules with real columns and a header row (mono 500 12px caps `--ink-2`); numbers right aligned with `tabular-nums`; addresses and hashes shortened in the middle (`0x8Ff9…796b`) with a small ghost `Copy` button (32px high, mono 12px, label turns `Copied` for 1.6s) and a mono `View on explorer ↗` link. Under 768px each row becomes a stacked card: label/value pairs, 1px `--rule` between cards.

### 4.11 Milestone timeline (horizontal)

- Anatomy: a 1px `--rule-blue` baseline across the content width; one stop per milestone at equal spacing (not time proportional); each stop is the status swatch (10px, section 4.5) centred on the line. Above the line: date (mono `--fs-data`, `--ink-2`, ISO `2026-09-24`, ranges as `2026-09-28 to 2026-09-30`, undated as `not set`) and, for releases, version and register number (`v0.2.14 · 017`). Below: the milestone text (Instrument Sans 15px `--ink`, up to 4 lines) and the chip. A `NOW` marker: 1px vertical `--blue-hi` line 48px tall with mono `NOW` above and today's UTC date.
- The line is solid up to `NOW` and dotted (`1.5 4`) after it; `NEXT` and `PLANNED` stops always sit after `NOW`.
- `done` milestones (Arena) have no swatch: a 1px tick 10px tall on the line and the neutral `done` label.
- Desktop: stops are at least 216px wide (fits a date range). Up to 8 fit the 12 columns; longer lists (Desktop has 22) become a horizontal track with `overflow-x: auto`, `scroll-snap-type: x mandatory`, square prev/next buttons (48px, 1px `--blue` border, chevron glyphs) top right, and the track scrolled on load so the `NOW` marker sits two thirds across. The full list is always in the DOM (no lazy paging).
- Mobile: vertical; the line runs down the left at 24px, stops are rows, dates above text.
- Status per stop follows the copy deck. One `NEXT` per product at most.

### 4.12 Release card row

- Anatomy per card: 1:1 image (a graded sepia crop with the no emblem, the sepia crop alone), meta line (mono `--fs-data`: `017` · `v0.2.14` · `2026-09-24`), optional title (Instrument Serif `--fs-h3`, `--blue`, only when the copy deck names the release), the one line from the copy deck (Instrument Sans 16px `--ink`, max 4 lines), mono link `Read the release ↗`. The latest card carries a neutral label only if the copy deck provides one.
- Desktop: cards 3 columns wide, four visible, newest first; the row scrolls horizontally with snap; prev/next square buttons at the right end of the section header. Mobile: cards 80vw wide, snap, the next card peeking.
- Hover: title underline; image does not move. Data comes from the release register (`lib/releases-index.ts`).
- Used on Home only (H14, Desktop releases). Product pages show releases through the milestone timeline instead.

### 4.13 Download tiles (macOS / Windows / Linux)

- Anatomy per tile: inset photo plate 4:3 (desktop) / 16:10 (mobile), each tile a different graded crop with a deep ground zone. Top centre: requirement label in a paper label box (mono 12px caps `--blue`, from the copy deck D2). Centre: OS name in Instrument Serif `clamp(3rem, 2.5rem + 2vw, 4.5rem)` (48 to 72px), white (the tile's centre is ground zone, 3:1 or more). Bottom: one secondary-on-photo button per file, stacked with 8px gaps, each with the OS logo from `@thesvg/react` (18px, `currentColor`) and the file label from the copy deck (`macOS, Apple Silicon (.dmg)`, `macOS, Intel (.dmg)`, `Windows x64 (.exe)`, `Linux x64 (.AppImage)`, `Linux x64 (.deb)`); URLs are built from `LATEST_RELEASE`.
- Row: three tiles, 4 columns each, anchored at `#install`; under the row, centred: mono `v0.2.14 · 2026-09-24` + `[LIVE]` chip and the mono link `All files for v0.2.14 ↗`.
- Detect the visitor's OS (`navigator.userAgentData`, then the UA string) for the hero's OS-detected CTA; the tile order stays macOS, Windows, Linux and no tile is highlighted unless the copy deck adds a label for it.
- Mobile: tiles stack in the same order, buttons full width.
- No pixel animals inside tiles (type-led tiles, the density rule in section 5).

### 4.14 FAQ row

- Anatomy: native `<details>`; `<summary>` holds the question (Instrument Serif `--fs-h3`, `--blue`, max 2 lines on desktop) and a `+` (mono 24px `--blue`) right aligned. Rows separated by dotted rules: `border-bottom: 1px dotted var(--rule-blue)`, first row also on top.
- Row padding 28px top and bottom desktop, 20px mobile; the summary hit area spans the full row.
- Open: answer Instrument Sans `--fs-body` `--ink`, max `--measure`, 32px bottom padding; the `+` rotates 45 degrees into a cross over `--dur-3`.
- Hover: question underline 1px offset 4px. Focus ring on the summary.
- Section layout: section header (no counter on Home) in cols 1 to 4, list in cols 5 to 12.

### 4.15 Footer (with ghost vx)

- Ground: full bleed `footer-dusk.jpg` (the darkest print, whole frame at L 0.08 or lower except a thin pale horizon). The footer is the last ground zone of the page, so everything on it is white.
- Ghost vx: the real `VX_PATH` sampled into 12px white blocks on a canvas (`new Path2D(VX_PATH)`, `isPointInPath` per cell centre, edge cells as 4x4 Bayer dither at 0.5), about 62% of the viewport wide, right aligned on cols 4 to 12, `opacity: .09`, static. Mobile: 90vw, centred behind the columns. It is the only place the mark is built from blocks.
- Content: vx mark (`VxMark`, white, 80px wide) in cols 1 to 3; four link columns `Products`, `Whitepaper`, `Resources`, `Community` (the copy deck 1.16) on cols 5 to 6, 7 to 8, 9 to 10, 11 to 12, with Instrument Serif heads (`--fs-h3`, white) and mono caps links (14px, 32px row pitch, `--on-photo-2`, hover white with underline, external links end in ` ↗`). `VEX Mobile` carries its `[PLANNED]` chip.
- Below the columns: the status line as a meta line (4.5), white.
- Bottom block above `--gutter` bottom padding: 1px `--rule-photo` hairline, then the legal lines in Instrument Sans 14px `--on-photo-2`, `--lh-body`, max 90ch, copyright first (must say source-available, never open source).
- Mobile: link columns in a 2x2 grid (the Whitepaper column spans both columns), bottom block stacked.

### 4.16 Whitepaper chapter layout

- Anatomy: a two column chapter on paper. **Rail** (cols 1 to 3, `position: sticky; top: calc(var(--nav-h-sticky) + 32px)`): counter L (sized down to `min(var(--fs-counter-l), 200px)` in the rail), eyebrow, chapter status chip, then the chapter index (all ten chapters: inline counter 32px italic `--blue-hi` + mono 13px label in `--ink-2`; the current chapter's label turns `--blue` with a solid 10px swatch before it, set by IntersectionObserver). **Body** (cols 5 to 11): h2, lead, body text at `--measure`, h3 subheads (`--fs-h3`) with 64px above and 16px below, lists with square 6px `--blue` bullets.
- Data block: figure (Instrument Serif italic `--fs-figure`, `--blue-hi`) over a mono caps label (`--fs-label`, `--ink`) and an optional chip. Two to four blocks in a row may extend to col 12; they sit on a 1px `--rule` top line. Only canon numbers.
- Plates inside a chapter: an inset 16:9 photo plate may break out to cols 1 to 12, or a full bleed photo opener may start the chapter (the `(06)` pattern: counter XL or the key-number swap, header in the sky zone, scene in the band, parameter table and spread caption in the ground zone).
- Sources: mono 12px list at the chapter end, `--ink-2`, prefixed `SOURCES`.
- Mobile: no rail; counter L above the eyebrow; a sticky mini bar under the nav shows `(06)` + chapter label in mono and opens the chapter index as a sheet (same behaviour as 4.1).
- Anchors: each chapter is a `<section aria-labelledby="...">` with the anchor from the copy deck (`#structure`, `#agent`, `#custody`, `#memory`, `#vex`, `#cloud`, `#staking`, `#copy-trading`, `#roadmap`, `#parameters`); sub-anchors (`#burn-ledger`, `#risks`) sit on their h3. `scroll-margin-top: calc(var(--nav-h-sticky) + 24px)`. Nav `Whitepaper` links to `/#whitepaper` (the preface).
- **Chapter index** (one component, three placements: the preface, the rail, the mobile sheet): ordered list of the ten chapters, inline counter 32px italic `--blue-hi` + label (mono 13px caps in the rail and sheet, Instrument Sans 500 18px `--blue` in the preface, where it sets as a two column list on cols 5 to 12 with dotted `--rule-blue` rows like the FAQ).
- **Whitepaper preface** (the band before `(01)`, paper, no counter): eyebrow, h2, lead (cols 5 to 10), meta line (mono, `--ink-2`), chapter index, status legend (4.5). It is the doorway that tells the reader the numbering restarts as chapters.

### 4.17 Risk callout

- Anatomy: a box on paper, `border: var(--frame) solid var(--rule-ink)`, no fill, padding 24px 32px 24px 48px. Left inside edge: an 8px wide hatch band (ink, 45 degrees, 1px lines at 4px pitch) running the full height. Header: a reversed label box (`--ink` ground, `--paper` text, mono 500 12px caps `RISK`), then the title (Instrument Sans 500 18px `--ink`, `--lh-lead`), body (Instrument Sans 16px `--ink-2`, max `--measure`), optional list.
- Variants: inline (inside a chapter body, at most one per screen) and list (chapter `(10)`, `#risks`: callouts stacked with 16px gaps, each one risk).
- Never blue, never amber or red, never on a photo, never collapsed by default.

### 4.18 Step row ("How it works", 3 steps)

- Anatomy: three nodes in a row, each: inline counter S `(1)`, `(2)`, `(3)` (Instrument Serif italic `--fs-counter-s`, `--blue-hi`), step title (Instrument Serif `--fs-h3`, `--blue`, from the bold lead-in in the copy deck), step body (Instrument Sans `--fs-body`, `--ink`, max 40ch). Between nodes, aligned to the counter's centre line, a horizontal `--flow` hairline with an arrowhead (4.9 rules), 24px clear of both nodes.
- Desktop: 4 columns per step. Under 1024px: vertical, a 1.25px rule on the left with downward arrowheads between steps.
- No photo, no animal, paper only.

### 4.19 Closing CTA band (product pages)

- Paper, `--section-y` padding, top hairline `--rule`. h2 (`--fs-h2`, `--blue`) on cols 1 to 8, body (Instrument Sans `--fs-lead`, `--ink-2`) on cols 1 to 6, then a primary button and a text or mono link. No counter, no photo (the footer photo follows directly).

### 4.20 CLOUD glyph and vx mark (shared marks)

- CLOUD glyph: square with inscribed circle, both strokes as round dots (`v10.js cloudGlyph`, `pathLength` + `stroke-dasharray: 0 2`). Sizes 24 (inline), 44 (table head), 84 (tile). White on photos, `--blue` on paper. Inline SVG, `aria-hidden` unless it stands alone (then `role="img" aria-label="CLOUD"`).
- vx mark: only the shared vx mark component (the `VX_PATH`), `currentColor`, `--blue` on paper and sky, white on the ground zone and on tiles. Clear space a quarter of its width. Never sepia, never stretched, never typed.

---

## 5. Pixel animal system

### 5.1 Roster

| Animal | Meaning | Source today | Render |
|---|---|---|---|
| Bird (flock) | agents; hero of Home | `bird-1.png` to `bird-8.png` (blue + lavender RGBA) | `pixelSprite`, white |
| Eagle bird | VEX Desktop emblem | `bird-3.png`, later `src-eagle-soar.png` | `pixelSprite`, white |
| Dot cloud | VEX Cloud emblem, CLOUD chapter | `dot-cumulus-ink.png` (density source) | `dotCloud`, white points |
| Horse | VEX Arena emblem | `pixel-horse-white.png` (pre-pixelated, trails baked) | raster; later `src-horse-gallop.png` through `pixelSprite` |
| none | VEX Mobile | | unexposed bracket frame |

### 5.2 Rendering (port `v10.js` to `lib/pixel/` in TypeScript, behaviour unchanged)

`rng(seed)` (mulberry32), `BAYER` 4x4, `ditherCell`, `pixelSprite`, `densityField`, `dotCloud`, `cloudGlyph`. Everything is seeded and deterministic: the same seed gives the same bird on every load.

`pixelSprite` pipeline for one sprite at width `w` (CSS px) and cell `c` (CSS px per block):

1. Downsample the source into a `w/c` by `h/c` grid (high quality smoothing). Flip if flying left.
2. Alpha below 0.42: empty. Luminance per cell: for the current blue sprites `L = (R + G) / 510`; for white-on-black sources `alpha = smoothstep(0.08, 0.30, luma)` and `L = luma`.
3. Lattice + natural mode (the tweet look): silhouette edge cells solid; highlights (`L >= 0.40`) solid; shadows open into gaps with probability `shadowOpen` (0.22 near, 0.30 far, hashed per cell) else a 4x4 Bayer dither at density 0.45; dither dot = 0.62 of the sub-cell.
4. Glitch: row tears shift a row one cell against the motion (`tear` 0.04 near, 0.10 far); dropped cells become sparse dither (`drop` 0.025 / 0.05); stray blocks shaken behind the body (`strays` 0.003 / 0.006 of cells); vertical dotted drips above or below columns (`vert` 0.07 / 0.10).
5. Motion trails: for a fraction `trail` of rows (0.30 to 0.50), a horizontal dithered streak behind the trailing edge, length `2 + r^2 * trailLen * 1.6` cells, density falling from 0.70 to 0.12; 35% of streaks are half a block tall.
6. Fill `#FFFFFF` only. Snap `x`, `y` and `c * DPR` to whole device pixels so blocks stay crisp.

`dotCloud`: density field from the ink alpha (blurred 5px), hex offset rows, jitter 0.18 of pitch, radius `rmax * sqrt(density * gain)`, drop radii under 0.55px. Plate: pitch 6, rmax 2.7, gain 1.6. CLOUD chapter: pitch 10, rmax 4.7, gain 1.7. States per point: `on` (white), `spent` (radius x 0.56, `rgba(255,255,255,.66)`), `ice` (`--ice`, only the renewing column on the 00:00 UTC line).

### 5.3 Sizes and cell ladder

Cell = `clamp(3, round(w / 28), 9)` CSS px, so a sprite is 24 to 36 blocks across; far birds may drop to 13 to 17 blocks across at cell 3.

| Depth | Width at 1920 | Cell | Trail / trailLen | Glitch set |
|---|---|---|---|---|
| Near | 226 to 320px | 7 to 9 | 0.45 to 0.50 / 16 to 18 | near |
| Mid | 92 to 180px | 4 to 6 | 0.40 to 0.45 / 10 to 14 | far |
| Far | 38 to 70px | 3 | 0.30 to 0.35 / 6 to 10 | far |
| Emblem in a 3:1 plate | 40% of plate width | 4 | 0.50 / 14 | near |

Widths scale with the plate width (`w = fraction * plateWidth`); the cell is recomputed, never scaled as a bitmap.

### 5.4 Density per viewport

- One animal group per viewport, ever. A group is the hero flock, one emblem, or the CLOUD dot cloud.
- Hero flock: 9 birds at 1440 and up (the reference layout: nearest lower left, smallest on the far hills right), 7 at 1024 to 1439, 5 at 640 to 1023, 3 under 640 (nearest bird 160px wide, cell 5, all below the buttons).
- Animals stay inside the band (55% to 80% of the frame height), keep 24px clear of any text box and of chips, and may overlap the counter's lower edge, never its centre. The largest animal is never taller than the counter.
- Product plates: one emblem each. Download tiles, release cards, footer, nav sheet: none.

### 5.5 Animation (real site)

- Build each sprite frame once into an `ImageBitmap` (OffscreenCanvas when available) per (sprite, cell, seed, frame); animate by drawing bitmaps, never by re-running `pixelSprite` per frame.
- Wing frames: cycle the eight bird sprites (or the generated 8 frame cycle) every `--frame-step` (200ms), each bird with its own phase; frames change discretely, no tweening. Each frame swap re-seeds the trails (`seed + frame`), which gives the tweet's flicker.
- Drift: the flock moves left to right; speed by depth (near 18px/s, mid 11px/s, far 6px/s); a vertical bob of plus or minus 4px over 3.2s with per-bird phase. Birds that leave the right edge re-enter from the left outside the visible frame.
- Horse: 4 frame gallop cycle at 120ms per frame, no drift (it runs in place inside its plate); trails re-seeded per frame.
- Dot cloud: no drift. The dial's now marker and the spent sector follow the real UTC clock (re-render once a minute); the ice column pulses by re-seeding its points every 2s. It is an illustration of the allowance clock and never shows real usage data.
- Emblem hover: 8px nudge (section 4.8), no frame change.
- Loop: `requestAnimationFrame` capped at 30fps (pixel motion reads better stepped), DPR capped at 2, canvas sized to the plate. Pause when off screen (IntersectionObserver), when `document.hidden`, and stop entirely when `navigator.connection.saveData` is true.
- Start after the hero image has loaded and in `requestIdleCallback`; the first painted canvas frame equals the static composition, so nothing jumps.
- Budget: pixel layer JS 8KB gzipped or less, under 2ms per frame on a mid laptop.

### 5.6 Reduced motion

`prefers-reduced-motion: reduce` renders exactly one frame (the composed still, as in the reference renders) and never schedules another; no drift, no frame swaps, no trail flicker, no hover nudge, no photo develop. The dot cloud still shows the current UTC sector, drawn once.

### 5.7 Accessibility

All animal canvases are `aria-hidden="true"` with no focusable content. Meaning carried by an animal (which product) is always also in text next to it.

---

## 6. Page templates

Section order and strings follow the copy deck; this table says which ground and which components each section uses. Rhythm rule: no two full bleed photo sections in a row (inset plates on paper do not count). Every photo section obeys the three zones.

### 6.1 Home `/` (landing + whitepaper on one page)

| # | Section (the copy deck) | Anchor | Ground | Components |
|---|---|---|---|---|
| H0 | Nav | | transparent over the hero, sticky paper bar after | 4.1 |
| H1 | Hero (1.1) | | full bleed `hills-sepia` (portrait master under 640px) | counter XL `(01)`; eyebrow; h1 in three lines on cols 7 to 11; sub (`--fs-lead`, `--ink`, 600px); primary `Download Desktop` + paper `Join the Cloud beta`; optional helper meta line under the buttons (`--ink-2`, sky zone); hero flock (5.4); status strip (4.5); hairline; spread caption `MODEL PROPOSES / RUNTIME ENFORCES / YOU DECIDE` |
| H2 | Products strip (1.2) | | paper | section header without counter (eyebrow + h2); four full product cards (4.8) on 3 columns each: Desktop, Cloud, Mobile (unexposed frame), Arena |
| H3 | Whitepaper preface (1.3) | `#whitepaper` | paper | preface (4.16): eyebrow, h2, lead, meta line, chapter index, status legend |
| H4 | (01) The whole structure (1.4) | `#structure` | paper + world dot map | counter L `(01)` + eyebrow `THE WHOLE STRUCTURE` (the label `(01) THE WHOLE STRUCTURE` is split tweet style: number in the counter, words in the eyebrow), h2, lead, group labels, flow diagram (4.9) with compact product cards and economy tiles, six labelled flows |
| H5 | (02) The agent (1.5) | `#agent` | paper | chapter layout (4.16), data blocks |
| H6 | (03) Custody and execution (1.6) | `#custody` | paper | chapter layout, small flow diagram (model proposes, runtime enforces, you decide), inline risk callout |
| H7 | (04) Memory and privacy (1.7) | `#memory` | paper with one inset 16:9 plate (`chapter-fog-valley`) | chapter layout, data blocks |
| H8 | (05) $VEX (1.8) | `#vex`, `#burn-ledger` | full bleed opener (`chapter-coast`), then paper | opener: counter XL `(05)`, eyebrow and h2 in the sky zone, nothing else on the photo; paper part: chapter layout, data blocks (`0.25%`, `85%`), flow diagram (fee to buyback and burn), burn ledger (4.10 ledger variant) |
| H9 | (06) CLOUD (1.9) | `#cloud` | full bleed opener (`hills-sepia`, zoom 1.5, fx .42, fy .9, deep defocus), then paper | opener as the reference render: key-number swap `$1`, inline `(06)` + `CLOUD`, h2, body (`--ink`, sky zone), dot cloud + 24 tick dial in the band (dial label `00:00 UTC` in `--ink` on the sky part, never white), parameter table in the burned ground zone with the status chip the copy deck gives, spread caption `STAKE 1 CLOUD / $1 OF AI A DAY / RESETS AT 00:00 UTC`; paper part: chapter body, mint and exit flow diagram, the short risk list as risk callouts |
| H10 | (07) Staking (1.10) | `#staking` | paper | chapter layout, parameter table `PROPOSED PARAMETERS` |
| H11 | (08) Copy trading and vaults (1.11) | `#copy-trading` | paper | chapter layout, flow diagram (creators publish, followers copy), parameter table `PROPOSED PARAMETERS` |
| H12 | (09) Roadmap (1.12) | `#roadmap` | paper | chapter layout with one milestone timeline (4.11) per product |
| H13 | (10) Open parameters, risks and disclosures (1.13) | `#parameters`, `#risks` | paper | chapter layout, open parameters table (4.10 ledger variant, `PROPOSED` / `OPEN` tags), risk callouts list (4.17) |
| H14 | Releases strip (1.14) | `#releases` | paper | section header without counter, release card row (4.12) with the latest four, caption, mono links |
| H15 | FAQ (1.15) | `#faq` | paper | section header without counter (cols 1 to 4), FAQ rows (4.14) on cols 5 to 12 |
| H16 | Footer (1.16) | | full bleed `footer-dusk` | 4.15 |

Full bleed photographs on Home: H1, H8 opener, H9 opener, H16. H8's paper part always separates the two openers.

### 6.2 Product template `/desktop`, `/cloud`, `/arena`

One template, three configurations (the copy deck sections 2, 3, 4).

| # | Section | Anchor | Ground | Components |
|---|---|---|---|---|
| P0 | Nav | | as Home | 4.1 with `aria-current` on the product |
| P1 | Hero | | full bleed product photo | counter XL `(01)`, eyebrow (product name in caps), h1, sub, primary + secondary buttons, one animal group (5.4), single product status strip, optional meta line (Desktop) in the ground zone |
| P2 | (02) How it works | | paper | section header (counter L), step row (4.18) |
| P3 | (03) Docs | `#docs` | paper | chapter layout (4.16) without the whitepaper index; the rail lists this page's doc sub-sections (`D1`, `D2`, ... in mono) instead; sub-sections as h3 with their anchors; lists, statements, notes, tables (4.10), risk callouts where the copy deck has warnings |
| P4 | (04) Milestones | `#milestones` | paper | section header (counter L), milestone timeline (4.11), caption |
| P5 | Closing CTA | | paper | 4.19 |
| P6 | Footer | | full bleed `footer-dusk` | 4.15 |

Per product:

| | `/desktop` | `/cloud` | `/arena` |
|---|---|---|---|
| Hero photo | `desktop-hero-plateau` | `cloud-hero-sky` | `arena-hero-plain` |
| Animal group | eagle bird plus two far birds | dot cloud (no dial: the dial belongs to chapter `(06)`) | galloping horse |
| Primary CTA | OS-detected `Download for macOS` (Windows, Linux) to `#install` | `Join the Cloud beta` | `Follow on X ↗` (primary, external) |
| Secondary CTA | paper button `Read the docs` | paper button `How signing works` | paper button `Read the rules` |
| Docs extras | `#install` holds the download tiles (4.13); optional launch film plate (section 9, item 1) | wallet and signer statement as a pull quote: Instrument Serif `--fs-h3`, `--blue`, cols 5 to 11 | rules as a parameter table on paper |
| Timeline | 22 stops (scrolling track) | 8 stops | 10 stops with `done` ticks |

---

## 7. Assets

### 7.1 (a) Already available

Shared art is kept with the website repo (private); copy what is used into `public/art/` after grading.

| File | Subject | Size / aspect | Use | Note |
|---|---|---|---|---|
| `hills-sepia.jpg` | bare rolling hills, sepia print with scratches | 3840x2143, 16:9 | Home hero; `(06)` opener (zoom crop); product card frames and economy tiles (crops); release card crops | the reference print; the gradient map is derived from it |
| `paper-dotmap.jpg` | white paper with a ghost halftone world map | 3840x2143 | source for `dotmap-world.png` | has a baked light patch; derive a clean transparent dot layer (7.2) |
| `bird-1.png` to `bird-8.png` | pixel birds, blue + lavender, different wing phases | 868 to 1321px wide, RGBA | hero flock; Desktop emblem (`bird-3`) | recoloured to white by `pixelSprite` |
| `dot-cumulus-ink.png` | halftone cumulus, `#0000FF` ink, alpha = density | 2154x1190 RGBA | Cloud emblem; `(06)` dot cloud | density source only, never shown as is |
| `pixel-horse-white.png` | white pixel horse with dithered trails | 4264x2533 RGBA | Arena emblem and Arena hero until the gallop cycle exists | already pixelated: place as raster, do not re-pixelate |
| `prairie-wide.jpg` | grassland with motion blur | 3840x1650, 21:9 | after the sepia grade: Arena chapter plate, a download tile | colour: must go through 3.2 |
| `ocean-wide.jpg` | open ocean from a cliff | 3840x2143 | after grade: `(05)` opener fallback, a download tile | colour |
| `sky-sea-wide.jpg` | summer sky over sea, headland | 3840x1629, 21:9 | after grade: chapter plate with a tall sky zone | colour |
| `cumulus-photo.jpg` | white cumulus on blue sky | 3840x2143 | after grade: a dark sky with a pale cloud; Cloud product plate fallback | colour; the dark graded sky is a ground zone |
| `dusk-sea.jpg` | blue hour over sea | 3840x2143 | after grade + burn: footer fallback | colour |
| `sky-motion.jpg`, `ascii-sky.jpg` | pale streaked skies | 3840x2162 | after grade: sky-only plates | colour |
| `pasture-overcast.jpg` | pasture with cows | 3840x2143 | do not use (animals in a photograph) | |
| `engraving-*-ink.png` | ink engravings | | not part of V10 | |
| the vx path (`VX_PATH`) and the mark component | the vx mark | 824x658 | nav, footer, ghost vx, `$VEX` tile | in the repo |
| `public/fonts/*.woff2` | Instrument Serif, Instrument Sans, Departure Mono | | all type | in the repo (owner pick P2, 2026-10-08) |

### 7.2 Derived in code (no image model)

- `dotmap-world.png`: threshold `paper-dotmap.jpg` to its dots, redraw as round dots in `--dotmap` on transparency on a 12px grid (6px dots at 1920), so the paper colour stays CSS and the light patch disappears.
- `grain` tile: the existing fractal noise SVG data URI.
- Ghost vx canvas: from `VX_PATH` at runtime.
- Product frame crops, economy tiles, release crops: crops of graded masters (`sharp().extract()`), 2x the display size.
- Link preview cards `public/og/{home,desktop,cloud,arena}.jpg`, 1200x630: the route `/lab/og/<card>` composes each page's hero (print, counter, h1, animal, ground row) at that size; `scripts/render-og.mjs` (`pnpm og`) screenshots it with Playwright; metadata and alt text in `lib/og.ts`.

### 7.3 (b) To generate

Model: `google/gemini-nano-banana-2.1` at 4K through an image model, reference images: `hills-sepia.jpg` (tone) and the source tweet (mood) for photographs; no reference for animals except the pose notes. Every photograph then goes through the grade in 3.2 so all prints match. Never generate text, logos, frames or UI.

| File | Subject | Aspect / size | Use |
|---|---|---|---|
| `hills-portrait.jpg` | the hero hills as a portrait print | 4:5, 2160x2700 | Home hero on mobile |
| `desktop-hero-plateau.jpg` | a high plateau with one lone rock outcrop | 16:9 + 4:5 | `/desktop` hero |
| `cloud-hero-sky.jpg` | a vast pale sky over a low distant ridge | 16:9 + 4:5 | `/cloud` hero |
| `arena-hero-plain.jpg` | a flat dry plain with a faint worn track | 16:9 + 4:5 | `/arena` hero |
| `chapter-fog-valley.jpg` | valley of layered ridges in morning fog | 16:9 | `(04)` plate |
| `chapter-coast.jpg` | high coast, cliffs falling into dark sea | 16:9 | `(05)` opener |
| `tile-dunes.jpg`, `tile-ridge.jpg`, `tile-shore.jpg` | three dark ground landscapes | 4:3 | download tiles |
| `footer-dusk.jpg` | hills after sunset, almost night | 21:9, 3840x1646 | footer |
| `src-eagle-soar.png` | soaring eagle, white on pure black | 1:1, 2048 | Desktop emblem, lead hero bird |
| `src-bird-cycle-1.png` to `-8.png` | one bird, eight wing phases, white on pure black | 3:2, 1536x1024 each | hero flock animation |
| `src-horse-gallop-1.png` to `-4.png` | one horse, four gallop phases, white on pure black | 3:2, 2048x1365 each | Arena hero and emblem animation |

Generation prompts (one paragraph each):

**`hills-portrait.jpg`.** A vertical 4:5 antique sepia silver gelatin print of bare rolling grass hills under a wide, even, pale cream sky, photographed on a large format camera around 1900: warm brown monochrome only, soft lens with slight overall defocus, lifted blacks (the darkest tone is dark brown, never black), cream highlights (never pure white), fine film grain, a few dust specks and two or three faint hairline scratches. Composition: the top 55% is open smooth sky with no clouds or birds, a layered line of distant hills in haze at about 58% height, nearer hill slopes rising from the bottom so the lowest 20% falls into deep shadowed earth. No people, no animals, no buildings, no roads, no fences, no text, no border, no frame edges, no vignette in the top half.

**`desktop-hero-plateau.jpg`.** A wide 16:9 antique sepia silver gelatin print of a high, empty grass plateau with a single weathered rock outcrop standing alone on the right third of the horizon, photographed around 1900 on a large format camera: warm brown monochrome, soft focus, lifted brown blacks, cream highlights, fine grain, sparse dust and hairline scratches. The horizon sits at 60% of the height; the top half is a smooth, even, pale sky with no clouds; the bottom quarter falls into dark foreground grass in shadow. Keep the composition readable when cropped to a centred 4:5 portrait. No people, animals, buildings, roads, trees in the foreground, text or borders.

**`cloud-hero-sky.jpg`.** A wide 16:9 antique sepia print of an immense pale sky above a low, distant, dark ridge line, photographed around 1900: warm brown monochrome, very soft focus, gentle tonal gradation from cream at the top to a warmer beige near the horizon, one or two very faint thin cloud wisps only, fine grain, a few dust specks. The ridge sits at 78% of the height and the foreground below it is deep brown shadow. The sky must be calm and even so a large dot cloud graphic and type can sit on it. No people, animals, buildings, roads, text, sun disc or borders.

**`arena-hero-plain.jpg`.** A wide 16:9 antique sepia print of a flat, dry, open plain stretching to a far horizon, with a faint worn dirt track curving across the middle distance like an old racecourse, light dust hanging in the air, photographed around 1900: warm brown monochrome, soft focus, slight motion blur in the foreground grass, lifted brown blacks, cream sky, fine grain, sparse scratches. Horizon at 58%, smooth empty sky above, darker foreground in the bottom 20%. Keep it readable when cropped to a centred 4:5. No horses, no people, no fences, no posts, no stands, no buildings, no text.

**`chapter-fog-valley.jpg`.** A wide 16:9 antique sepia print of a deep valley seen from above, with five or six layered ridges receding into morning fog, each layer paler than the one before it, photographed around 1900: warm brown monochrome, soft focus, lifted blacks, cream fog, fine grain, a few dust specks. The nearest ridge is dark and fills the bottom 20%; the top 40% is fog and pale sky. No people, animals, buildings, roads, text or borders.

**`chapter-coast.jpg`.** A wide 16:9 antique sepia print of a high, bare coastline: grassy cliff tops on the left falling into a wide dark sea that fills the lower third, a pale even sky above a flat horizon at 45% height, photographed around 1900 from the cliff edge: warm brown monochrome, soft focus, lifted brown blacks, cream sky, gentle texture of waves, fine grain, faint scratches. No boats, lighthouses, people, birds, buildings, text or borders.

**`tile-dunes.jpg`, `tile-ridge.jpg`, `tile-shore.jpg`.** Three separate 4:3 antique sepia prints made as a matching set, each a dark, low-key landscape: (1) wind-shaped dunes with deep shadowed troughs, (2) a single long grassy ridge against a dim sky at dusk, (3) a rocky shoreline with dark wet stones and a pale strip of sea. Same warm brown monochrome, soft focus, lifted brown blacks, fine grain and faint scratches on all three; in each, the central 60% of the frame is dark (deep brown) and calm so large white type and a small light button can sit on it, with only a narrow paler band of sky at the top. No people, animals, buildings, text or borders.

**`footer-dusk.jpg`.** A very wide 21:9 antique sepia print of rolling hills just after sunset, almost night: the whole frame is deep brown and near-black brown, with only a thin pale cream line of afterglow along the horizon at 30% height and the faint silhouettes of the hills below it, photographed around 1900: warm brown monochrome, soft focus, fine grain, a few dust specks. The lower 70% must be very dark and nearly flat so white text reads anywhere on it. No stars, moon, people, animals, buildings, text or borders.

**`src-eagle-soar.png`.** A single eagle soaring with wings fully spread, seen from slightly below in three quarter view, flying to the right, rendered as a clean white silhouette with soft grey internal shading that describes the feathers, on a pure flat black `#000000` background, centred with at least 15% black margin on every side: high contrast, crisp outer edge, smooth shapes (not pixel art, the pixelation is done later in code), no ground, no sky, no shadow, no texture or noise on the background, no text.

**`src-bird-cycle-1.png` to `-8.png`.** Eight separate images of the same small bird of prey in side view flying to the right, one image per phase of a single wing beat (1 wings fully up, 3 level, 5 fully down, 7 level on the upstroke, the others in between), white silhouette with soft grey internal shading on a pure flat black `#000000` background, identical scale, identical body position and identical framing in all eight so they can be played as an animation, at least 15% black margin, crisp edges, smooth shapes (not pixel art), no background texture, no text. Generate as eight calls sharing one seed and the first frame as a reference.

**`src-horse-gallop-1.png` to `-4.png`.** Four separate images of the same horse in full gallop in side view running to the right, one image per phase of the gallop stride (gathered, extended forward, all hooves off the ground, landing), white silhouette with soft grey internal shading for the muscles and mane, on a pure flat black `#000000` background, identical scale and ground line in all four, at least 15% black margin, crisp edges, smooth shapes (not pixel art), no rider, no saddle, no ground shadow, no text. Use the first frame as the reference for the other three.

Extraction for every `src-*` file: `alpha = smoothstep(0.08, 0.30, luma)`, discard everything else, trim to the alpha bounds plus 4%, save RGBA PNG; then feed `pixelSprite` (5.2).

---

## 8. Anti-patterns (what breaks V10)

1. Blue over sepia: a blue wash, duotone, halftone or line screen on a photograph, or a blue field section. Blue is type, counters and hairlines only.
2. Colour photographs, CSS `sepia()` shortcuts, or two different sepia tones on one page (every print goes through the one gradient map).
3. Warm UI: beige or cream paper, sepia cards, sepia buttons, sepia text. Warmth only inside photographs.
4. Text in the band, white text on the sky, blue text on the ground zone, any dark scrim or gradient band to rescue legibility.
5. Moving photographs: Ken Burns, parallax, scroll zoom, video backgrounds graded to sepia.
6. Animals in blue or colour, smooth (unpixelated) animals, animals on paper, outlined animals, animals over text or chips, two animal groups in one viewport, an animal larger than the counter.
7. Counter misuse: two giant counters in one viewport, a roman or bold counter, a counter in sans or mono, a counter on the ground zone, count-up or flip animations, a number that is not a section number or a canon figure.
8. Spread caption with two or four groups, new words, a serif or sans face, or a single centred line.
9. Status by colour (green, amber, red, grey dots), status by word alone without a fill, ice used for status or text.
10. Ice anywhere but the renewing points of the CLOUD scene.
11. Rounded corners, drop shadows, glass, glow, bloom, smooth gradients, pill buttons.
12. Diagram faults: crossing flows, diagonal or curved connectors, labels on the wrong side (source must be ink and near the origin, result blue and near the arrow), animated marching flows.
13. Type faults: bold or faux-bold Instrument Serif, serif below 32px, serif body text, italic serif as emphasis, Doto or any other dot-matrix font (Departure Mono is the only pixel face, and only in the mono roles), Hermes-style condensed caps.
14. Photos with people, animals, buildings, roads or text; a horizon through a headline; a vignette under the counter.
15. Terminal or chat transcripts, app screenshots, robots, brains, circuit boards, coins.
16. The logo drawn any way but `VX_PATH`, recoloured sepia, or rebuilt from blocks anywhere except the footer ghost.
17. Mixing in other round 2 languages: engraving inks (V2), electric plates (V5), tilted stickers (V11), pixel sorting (V12).
18. Em dash or en dash characters anywhere in copy, alt text, labels or code comments that ship.

---

## 9. Owner decisions (resolved 2026-10-08)

1. **No launch film anywhere.** The hero is the V10 sepia photograph with the live pixel flock. The film is not used on `/desktop` either.
2. **Home hero keeps the giant `(01)`** of the picked render. Every hero carries `(01)`.
3. **CLOUD status is `[PLANNED]`** as in the copy deck (the DIEM style mechanism is not built yet).
4. **Typography: P2.** Instrument Serif (display, counters, figures), Instrument Sans (all reading text, nav, buttons), Departure Mono (every mono role: eyebrows, chips, status rows, data, spread captions, flow labels). Departure Mono has one weight: keep everything at 400; where the reference used 500 for emphasis, use size or color instead. Prefer 11, 22 or 33px for small mono so the pixel grid stays crisp; 13 to 15px is allowed for data.
5. **Release cards** use sepia landscape crops only (the old release emblems were deleted with the old site).
6. **Join the Cloud beta** points to a Telegram channel that does not exist yet: use the constant `TELEGRAM_URL` from `lib/site.ts` with the placeholder value `https://t.me/` + `TODO` and keep the button working.
