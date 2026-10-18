---
name: vex-sepia-design
description: Design and build VEX websites, sections, mockups, social graphics, token explainers and app screens. The website speaks V10 "Sepia Counter" (antique sepia prints as ground, one blue, giant italic parenthetical counters like (01), Departure Mono spread captions, status by fill, halftone dot clouds, Vex K2 rising from the vx token on the home, the 3D vx token on /token, no animals). The apps, VEX Desktop and VEX Cloud /app, speak R3 Minimal (a calm three column agent chat: left sidebar, centred transcript, Vex sidebar with the K2 hologram, "Needs you", state as a fill plus a word, complete approval cards, Instrument Sans words, JetBrains Mono figures, no pixel font). Use when the user says "w stylu VEX", "w stylu V10", "sepia counter", "R3", "zaprojektuj w tym stylu", "jak landing VEX", "design like the VEX site", asks for a VEX page, app screen, deck slide, tweet graphic or animation, or wants any product designed with this aesthetic. Mandatory before any UI, UX or copy-layout work on VEX Desktop or VEX Cloud: the element catalogue is references/ELEMENTS.md and the app layout is references/APP-R3.md.
argument-hint: [what to design, e.g. "app screen", "landing section", "tweet graphic"]
---

> **Public copy for VEX Desktop.** This is the public copy of the `vex-sepia-design` skill, kept in the VEX Desktop repo (Vex-Foundation/Vex, branch `design/r3-minimal`). It carries the same rules, the same element catalogue and the same R3 Minimal layout as the full skill, which lives with the VEX Cloud team. What depends on private material is left out: the reference images of the unreleased VEX Cloud web app, the image generation scripts, and the code of the VEX Cloud web app, which this copy only names as "the VEX Cloud web app (private)".

# VEX design system: the V10 website and the R3 Minimal apps

## Step 0: read before any UI work (mandatory, always)

ALWAYS, before any UI, UX or copy-layout work (a screen, a component, a state, a layout, a chart, an icon, a string's placement, a review of someone else's UI), and before briefing a subagent to do it:

1. Read this file, `SKILL.md`, in full.
2. For app work (VEX Desktop, VEX Cloud `/app`): read `references/APP-R3.md` (the R3 Minimal layout: rooms, type, three columns, breakpoints, top bar, sidebars, welcome, brand moments, phone) and `references/ELEMENTS.md` (how to build every element: anatomy, sizes and tokens, states, light and dark, widths, accessibility, do and don't, the reference implementation: the desktop code in this repo, the web code private).
3. Open the reference images with the Read tool: `reference-images/app/` for the apps (index `reference-images/app/INDEX.md`: the R3 desktop mockups, the kit and real captures of the built desktop app), and the website images of section 0 below. For website work also read `references/DESIGN.md`.

No exceptions for small changes. Every subagent brief repeats this step and the rules in section 10. Builders who have not looked at the pictures do not build.

> The sources of truth for the apps are `vex-app/docs/design/R3-MINIMAL.md` and the renderer `vex-app/src/renderer/` in this repo; the VEX Cloud web app (private) has its own spec. The references here quote them and the shipped code. The full skill, and the other copies kept in sync with it, live with the VEX Cloud team.

**Two languages, one family.** The website (owner pick V10, 2026-10-08) is the sepia print language: it grows out of the tweet `reference-images/04-source-tweet-HSA7.jpg` and nothing else in crypto looks like it. The apps (owner approval of R3 Minimal, 2026-10-17; built 2026-10-18) keep V10's paper, ink, one blue, Night Ledger, radius 0 and status by fill, but drop the spread, the pixel font and the animals for a calm agent chat, because users found the V10 Spread app hard to read and nobody understood the pixel eagle.

Live reference build: VEX Desktop, `vex-app/src/renderer/` in this repo (branch `design/r3-minimal`). The website and the VEX Cloud web app (private) speak the same language. Reuse the desktop code instead of rewriting it (section 6).

## 0. Look first (mandatory, every time)

Before designing or writing a line of code, open with the Read tool:
1. `reference-images/01-v10-hero.jpg`, `02-v10-structure.jpg`, `03-v10-cloud.jpg` (the approved website mockups) and `reference-images/04-source-tweet-HSA7.jpg` (the source of the language).
2. The built website pieces closest to your task: `05` hero, `06` structure map, `07` whitepaper chapter, `08` fee scene, `09` burn ledger, `10` product hero, `11` footer, `12` art contact sheet, `13` type pairing. **The animals in these pictures are retired** (the owner removed the eagle, the flock and the horse on 2026-10-17): read their prints, counters, captions and type, never their birds.
3. The home and the token page as they ship now: `reference-images/site-home/` (`INDEX.md`: real captures of the home with Vex K2 on her token, the token toggle, `/token` with the 3D vx token, plus the H1v2 card states and the News page).
4. The single website components you will touch: `reference-images/elements/` (`INDEX.md` lists each crop and when to pass it to an image model as `--ref`).
5. For app screens (VEX Desktop, VEX Cloud `/app`): `reference-images/app/` (`INDEX.md` says which mockup or capture serves which screen: welcome, chat, Vex hidden, approval, Needs you, portfolio, Lighter, wake and unlock, system states, the kit).
If you delegate to subagents, every prompt starts with "open these images first" and ends with "render your work, open the render next to the reference, fix until it looks like the same designer made it". The owner's rule: builders who have not looked at the pictures do not build.

## 1. Principles

### 1.1 The website (V10 Sepia Counter)

1. **Sepia photographs are the ground.** Hero and chapter openers are soft, warm, scratched antique landscape prints (hills, plains, coast, sky). Warmth lives only inside photographs; the page paper stays cool `#F3F4F7`.
2. **One blue for type and counters.** `#0000C0` for blue words, lines, buttons; `#0000FF` only for giant counters and key figures. Type on a print is white in both themes on a darkroom burn (`DESIGN.md` section 3); never a blue wash over a photo.
3. **Motion comes from halftone dot clouds**, and on the home only from Vex K2 rising from the vx token. White round dots on a hex screen drift slowly over the print (46% white at night), never under text. Photos never move. **No animals on any page**: no eagle, flock, birds or horse.
4. **A giant italic parenthetical counter opens each section** (`(01)`, `(06)`, or a key number like `$1`) in Instrument Serif italic, top left, huge; on photographs a three-group spread caption in mono caps closes it along the bottom edge (`MODEL PROPOSES / RUNTIME ENFORCES / YOU DECIDE`).
5. **Status is shown by fill, never by colour.** Solid square = LIVE, dot screen = BETA, hatch = IN DEVELOPMENT, target = NEXT, empty outline = PLANNED. No green, amber or red on the site.

### 1.2 The apps (R3 Minimal)

1. **Calm, three columns, one job each.** Left: where you are (nav and chats by name). Centre: the conversation or one page (transcript max 760). Right: Vex (256, collapses to zero width). Almost nothing else on screen, one blue fill per view.
2. **Every state is a fill and a word.** "This chat: Ready", "Working 0:02", "Waiting for approval", "1 mission running"; never a fill alone, never a colour. Missing data reads "Not available", never a sample.
3. **Vex is the face of the agent.** The K2 halftone hologram rising from the vx token, her mood following the agent's state; the welcome is hers; her token chip in the top bar toggles her sidebar.
4. **Decisions are complete and inline.** "Needs you · N" on every screen; approval cards with a plain sentence, the money lines, REAL FUNDS, Reject first and an action named button ("Approve bridge"). No veils.
5. **Type for reading.** Instrument Sans words in sentence case, JetBrains Mono figures, Instrument Serif only for display. No pixel font. Trading green and red only on trading values.

## 2. Tokens and type

- Full token block: `references/tokens.css`: the website tokens (colours, sepia ramp for grading only, ice `#A6FEFF` only for "renewing" points, fluid clamp() type scale 375 to 1920, 8px spacing, 12/8/4 column grid, radius 0, motion) and the app block (R3 rooms, trading pair, app type, geometry). Font faces: `references/fonts.css`; files in `fonts/` (all OFL).
- **Website type** (owner pick "P2"): **Instrument Serif** 400 roman and italic for display, h2, h3, counters, figures (never bold, never below 32px); **Instrument Sans** (variable wght 400 to 700) for body, leads, nav, buttons; **Departure Mono** (pixel mono, one weight 400) for eyebrows, chips, status rows, data, flow labels, spread captions (never 500+, never faux bold; crispest at 11, 22, 33px).
- **App type** (R3): Instrument Sans for every word, JetBrains Mono (tabular) for every figure, address, time and duration, Instrument Serif 400 at display sizes only (greeting 52, page head 40, wake 56). No Departure Mono in the apps: desktop removed the face, web rebinds its mono token to JetBrains Mono inside `[data-vx-app]` so the site keeps Departure Mono.
- Uppercase via `text-transform`, never typed caps in the source. English number formatting. No em dash or en dash anywhere.
- **Rooms.** The website is one light print on paper with a night print for dark (`DESIGN.md` 2.1). The apps have Celeris (light: paper `#F3F4F7`, ink `#0A0D18`, blue `#0000C0`) and Chronos ("Night Ledger": night paper `#1B1412`, paper type, blue lifted to periwinkle `#A3ABFF` for type, true `#0000C0` kept as the action fill with a periwinkle edge). **Trading colours** in the apps, only on trading values: up `#10763A`, down `#C2272E` (night `#4CD685`, `#FF7B7B`); candles keep their own pair inside the chart. Values and selectors: `references/APP-R3.md` section 1.

## 3. Components

### 3.1 The apps: R3 Minimal (VEX Desktop and VEX Cloud `/app`)

Both apps share R3. Layout in `references/APP-R3.md`, every element in `references/ELEMENTS.md`. The essentials:

- **Left sidebar** 264 on desktop (web 248; R3b allows 240 to 264), 224 at 1280, a 56 rail at 1024 with an explicit "Chats" key: the vx and the collapse key, New chat, Search, the nav (desktop Chat, Missions, Portfolio, Board, Lighter, Studio, Settings; web Chat, Strategies, Missions, Markets, Portfolio, Activity, Settings), chats by name grouped by day, the account row. Calm line icons (16 grid, stroke 1.5, square caps), never the px sprite.
- **Centre**: a centred transcript, max 760, the composer docked under it; pages for money and work (Portfolio, Board, Lighter, Studio, Markets, Strategies, Settings).
- **Vex sidebar** 256 (240, 224), hidden is zero width: the state ("This chat: Ready" with its swatch and a timer), one line of narration from real parts, the background work ("1 mission running · {title}"), "Needs you · N", then her 280 portrait plate on the print, "Show avatar" at the foot. Open in chats and approvals, hidden by default on table pages.
- **Top bar** 44: the title and mode at the left; at the right "Needs you · N" (on every screen, independent of Vex), page keys or the web's network and Pause all, then the **token chip** (the flat vx token, the swatch, the word, the timer, "1 mission running"), which toggles the Vex sidebar ("Hide Vex" / "Show Vex"; desktop Cmd/Ctrl+Shift+Period, web Cmd/Ctrl+Shift+B).
- **Welcome**: no Vex sidebar; Vex centred on her token with **no state word under her**, the serif greeting in blue, the 720 composer, four task rows ("Check wallet balances", "Review the market", "Create a mission", then "Trade perps on Lighter" on desktop or "Analyze BTC 4h" on web). Her token toggles her into the upright coin and back.
- **Transcript**: the user block right anchored on a 2px blue rule; Vex's turn hangs off the flat token; finished tool steps fold into one quiet row; a live row always has a word and a timer; result lines state scope, currency and freshness; failures are an ink callout, never red.
- **Composer**: one options control "{model} · Reasoning: {effort}", the permission as its promise "Funds require approval", a labelled meter ("Context 21%", web "Daily budget"), the send key (dotted outline empty, the one blue fill with text), named Stop keys; the ink frame and a "Waiting for approval" tag while an approval waits.
- **Approval card**: inline, a 1.5px ink frame with a hatch band, "Approval needed", the expiry, REAL FUNDS and risk tags, the plain sentence, the source wallet and its available balance, the money lines (You send, You receive, Minimum receipt, Costs, Total debit; "Not available" when missing), plain risk sentences, "All signed fields" closed, Reason, Reject (first focus) and the action named button ("Approve bridge", "Approve order", "Approve swap", "Approve transfer"); the 4 s armed second click for high risk.
- **Status by fill plus a word** (outline Ready, dot screen Listening, hatch Thinking, solid Working and Done, target Waiting for approval in blue, ink hatch Concerned, ink cross Error, dotted outline Sleeping). Trading green and red only on trading values, with the tuned values above.
- **Overlays without veils**: inline cards, sheets and panels over the centre with both sidebars standing, flat popovers with ink frames, toasts top centre; the flat paper scrim (62%, night 66%) only when a dialog must block.
- **Phone** (web under 768): a 52 high top bar with Needs you and the token chip, a bottom tab bar with four tabs (Chat, Portfolio, Markets, More), Vex as a compact bottom sheet from the token, approvals straight to the decision, 44 px targets.
- **Brand moments only where there is room**: the welcome, the desktop wake and unlock (a 720 print plate with Vex), the wizard, the sidebar plate, the web boot and loading (the turning 3D vx token), sign in and error plates. Working views are paper and type.

### 3.2 The website (anatomy in `references/DESIGN.md` section 4)

Nav (transparent over hero, sticky paper bar after; the home's compact nav is only the vx and a mini "Ask Vex..." field) · Counter · Section header (counter + eyebrow + serif title + lead) · Spread caption · Status chip / strip / legend · Buttons (solid blue, paper, ghost; square, no radius, no shadow) · Photo frame (grain, develop-in) · Photo plate with a dot cloud or token scene · **Product card** (sepia plate + a dot screen emblem drawn in code + serif name + chip: the cloud for VEX Cloud, a desktop computer for VEX Desktop, an office tower for Vex Inc.; the planned Mobile card keeps its bracket frame) · Flow diagram (orthogonal blue hairlines with arrowheads, cause label in ink above the line, result in blue below; planned flows dotted; never curved, diagonal or animated ants) · Parameter table (paper, on-photo, ledger variants; PROPOSED / OPEN tags) · Milestone timeline (status swatch per stop on a hairline, NOW marker) · Release card row (sepia crops) · Download tiles · FAQ rows (`<details>`, dotted blue rules) · Chapter layout (sticky counter rail with chapter index, 68ch body, data blocks with big italic figures) · Risk callout (ink frame, never blue) · Footer (dark dusk print, serif column heads, ghost vx assembling from pixels) · the home card, tiles and News stack (`ELEMENTS.md` section 26).

## 4. Art pipeline (images)

- Generate prints with an image model (**Nano Banana 2.1** at 4K was used for the site, about $0.12 an image; Nano Banana Pro when 2.1 is rate limited; FLUX 3 is the alternative for photoreal skies), passing the master print and the tweet as references. The generation scripts are not part of this copy.
- Prompt templates that worked: `prompts/*.txt` (heroes, chapters, tiles, footer). Photos: "antique sepia silver gelatin print, about 1900, soft focus, lifted brown blacks, cream highlights, fine grain, dust and hairline scratches", strict three zones (calm sky top 55%, band 55 to 80%, dark ground bottom 20%), no people, animals, buildings, roads, text or borders. Pass the master print (`reference-images/12-art-contact-sheet.jpg`) and the tweet as references.
- **No animal art.** The animal sprite sheets are retired with the animals (their prompts are gone from `prompts/`). Motion and emblems are drawn in code: dot clouds from a density field (`densityField`, `dotCloudPoints`), product emblems as dot screens of plain silhouettes (the VEX Cloud web app (private)).
- **Vex and the token are not regenerated.** Vex is the K2 drawing (maps generated once, on the owner's approval); the 3D vx token is pre-rendered frames (two turn sheets of 110 frames, 400 and 300 px). Never ask an image model for her face or the coin.
- Grade every photo through one tone curve so all prints match: `scripts/grade-sepia.mjs` + `grade-sepia.config.json` (luminance, auto levels, print range, 9 stop sepia gradient map, softening, neutral exposure, legibility burn for the ground zone, bottom corner vignette, q92 masters 3840x2160 and 2160x2700).
- Logo and every letter are always real (vx SVG path + web fonts). Image models never draw text or the logo. Full-page mockups from an image model are only for direction; production composes art + HTML.

## 5. Motion

- **Dot clouds** (the site's living sky): white round dots on a hex screen re-screened from a cumulus density, drifting slowly, keeping out of type (keep-out boxes), 46% white at night; canvas, 30fps cap, pause offscreen and on a hidden tab, stop on Save-Data, `prefers-reduced-motion` = one still frame identical to the composition. Reference: `scripts/v10-pixel-reference.js` (rng, BAYER, densityField, dotCloud, cloudGlyph); the shipped engine is in the VEX Cloud web app (private).
- **Vex K2 on the home**: she rises from her vx token, looks at you by default, glances, blinks, has wind in her hair and an idle pool (blow, bird, blush, whistle, hum); episodes at 30 fps, idle at 10 fps; her token toggles her into the upright coin and back (section 12).
- **The 3D vx token on `/token`**: the coin floats face on and turns frame by frame from a 110 frame turn sheet (one frame a step, 30 fps, 11 s a lap, no blending, no three.js at runtime) over a halftone light; a pointer pulls the turn toward it by the short way round, and the turn goes on 2.5 s after the pointer stops. Reduced motion, Save-Data and `?still` paint frame 0.
- **Token scenes** (three.js, orthographic camera, square point sprites, no glow or bloom): CLOUD allowance dot cloud inside a 24-tick dial on the real UTC clock, fee to buyback-and-burn grains on orthogonal lines, burn ledger at true scale (zoom fields of 1,000 dots, live RPC read), Mint Rate staircase curve, ghost vx assembling from pixels.
- Native scroll only, reveals once via IntersectionObserver, content readable without JS.
- **App motion** is for a state change, spatial continuity or attention once; durations 100, 150, 240, 300 ms on three curves; the Vex column eases on toggle (desktop 300ms, web 240ms), never on resize; reduced motion collapses all of it (`APP-R3.md` section 3, `ELEMENTS.md` law 9).

## 6. Reusable code

- **The website and the VEX Cloud web app** (the home, the landing chapters, the product pages, the emblems, the dot clouds, Vex K2 and the token toggle): the VEX Cloud web app (private). Their tokens and fonts are in `references/tokens.css` and `references/fonts.css`; their components are described in `references/ELEMENTS.md` and `references/DESIGN.md`.
- **VEX Desktop** (`vex-app/src/renderer/`): `features/appShell/`, `features/vex/`, `components/vex/k2/`, `components/icons/line/`, `components/ui/`, `styles/global-css/` (`tokens.css`, `type.css`, `title-bar.css`, `left-sidebar.css`, `vex-sidebar.css`, `composer.css`, `approval.css`).

## 7. Workflow that produced the site and the apps (repeat it)

1. Facts first: a canon file with sources; copy written only from it, open questions shown as an `OPEN` tag (site) or an owner question (app), never invented.
2. Mock in HTML with real fonts and the real logo (render with Playwright at 1920x1080 and DPR 2; Chromium flags `--disable-lcd-text --font-render-hinting=none`), compare variants side by side, let the owner pick (R3 came from three directions A, B, C and one minimal round).
3. Freeze the spec (`DESIGN.md`, `R3-MINIMAL.md`, the VEX Cloud web spec (private)) and the copy.
4. Fan out in waves: one builder per work package, exclusive file ownership, ONE shared dev server; builders only implement and run their own tests by path.
5. Coordinator integrates, runs the gates centrally (typecheck, lint, tests, build) in an isolated copy, reviews every render, then the owner clicks through.

## 8. Designing a change to the website

The repeatable loop for any change to the VEX site (a new section, a reworked component, a page, a link preview). The website lives in a private repo; this copy keeps the loop.

1. **Look.** Open the reference images (section 0) and the live page you are changing at 1920 and at 390. Open the element crops you will touch in `reference-images/elements/`.
2. **Explore fast with an image model.** Two to four direction sketches, passing the element crops whose look must carry over as references. Sketches are for layout direction only: never ship their text, numbers or logo, never trace a generated page. Say so in the prompt ("layout study, placeholder text, real type is set in HTML").
3. **Build it for real** with the tokens, the exact copy strings and canon facts, the existing components first, dot clouds and scenes through the existing engines (never new animal images).
4. **Render and compare** at desktop 1920 x 1080 and mobile 390 x 844 and 375 x 667, in Chromium AND WebKit (Playwright `webkit`: Safari and every iOS browser and in-app view are WebKit). Put each render next to its reference and fix until the same designer could have made it: counters inside the box on phones, no horizontal scroll, no text in the band, no animals, dot clouds never under text, no em or en dash.
   WebKit gotcha: WebKit is the only engine that applies `hanging-punctuation`. With `hanging-punctuation: first last` on `html`, the opening paren of every giant counter hung a full glyph out of its box and off the screen on iPhones, while Chromium looked perfect. The site sets none and the counter pins `hanging-punctuation: none`; never add it back, and always check counters in WebKit at 375.
5. **Gate and ship in the website repo (private):** typecheck, lint and build clean, then the test deploy only when the owner asks. When a change touches a hero title, a status, the art or the counter, re-render the link preview cards. Production is deployed from the team repo (private); never push to it directly.

## 9. Never (full website list: `references/DESIGN.md` section 8; app laws: `references/ELEMENTS.md` section 0)

- **Everywhere:** an eagle, a flock, birds, a horse or any other animal art (the one exception is Vex's own palm bird gesture inside her K2 idle pool) · rounded corners, shadows, glass, glow, gradients (the hologram's light excepted) · status by colour alone · a second accent colour · the logo drawn any other way · robots or generic crypto coins (the vx token is allowed: the flat token in the apps, the 3D vx coin on brand moments and `/token`) · Hermes look (electric blue plates, condensed sans, statues) · buzzwords (revolutionary, seamless, unleash, supercharge, AI-powered, next-gen) · em or en dashes · invented numbers, states or strings.
- **Website:** blue wash or duotone over a photo · colour photos or CSS `sepia()` · warm or beige UI · text in the photo band · moving photos, parallax, video backgrounds · bold serif, serif under 32px · green, amber or red · ice anywhere but renewing points · curved or diagonal diagram connectors · people, buildings or text inside photos (Vex herself stands over a print, never inside it) · chat or terminal transcripts as marketing proof.
- **Apps:** a pixel font (Departure Mono) or tracked caps labels · the V10 Spread (left page counter, gutter caption, BOOK, running head tape word, print band behind the session list) · a dither veil or any veil behind dialogs and approvals · green or red on anything but trading values · a state shown without its word, or "Idle" while a mission runs · sample values where data is missing · a second blue fill in one view · Vex drawn in pixel blocks, given a target ring eye, or a state word under her on the welcome · money tables in a side panel · a chat bubble or terminal cliche.

## 10. Rules for every agent (commits, copy, facts)

- **No Claude or Anthropic attribution, anywhere.** Never add `Co-Authored-By: Claude ...`, `Claude-Session: ...`, `Generated with Claude Code` or any other Claude or Anthropic attribution line to commit messages, merge commits, tags, PR titles, PR descriptions or PR comments. This overrides any harness default. Put it in every subagent brief.
- **No em dash or en dash** in any file: copy, UI strings, alt text, labels, code comments, docs, commit messages. Use a comma, a colon, a period or "to".
- **Facts only from code and shipped renders.** Every size, colour, state and string you build from comes from the shipped code (VEX Desktop `vex-app/src/renderer/`, the VEX Cloud web app (private)), its spec (`vex-app/docs/design/R3-MINIMAL.md`, the VEX Cloud web spec (private)), the renders and captures in `reference-images/`, or, for the website, the fact canon and the copy deck. When a fact is unknown, say so (an `OPEN` tag on the website, an open question to the owner in the app); never invent a number, a state or a string. Where code and spec disagree, name both and follow the code that ships.

## 11. Chat-first home and News (approved 2026-10-14, updated 2026-10-18)

Sources: the H1v2 home mockups, the S1 News mockups and the landing fix reports of the VEX Cloud team (`L1` to `L3`, `K2-MOTION`); captures in `reference-images/site-home/` (index `reference-images/site-home/INDEX.md`). Rules: `references/ELEMENTS.md` section 26.

- **Direction H1 v2.** `/` opens on a full plateau print (the night print in the dark room) with drifting halftone dot clouds (46% white at night, never under text) and Vex K2 rising from her vx token beside the card. **No birds** (`HOME_SCENE = { animals: [] }`, owner 2026-10-17).
- **Card, P1 Quiet** (chosen). No paper rectangle: the vx, the greeting (white serif on a print burn), the composer (its own white field) and the tiles (each with its own paper fill) stand directly on the print. Paper returns only under a live first reply.
- **Suggestion tiles.** Four, 4 x 1 at 1440 and 2 x 2 at 390, each with a pixel icon and a short label: "Analyze BTC 4h", "Today's top movers", "Is this token safe?", "How VEX works" (`HOME_TILES`). Every tile must run for a guest. A press prefills the full prompt and never sends it. A guest on the `/app` welcome gets the same four; a member there gets the R3 task rows.
- **Budget figures are never typed into copy.** The guest line, the sign-in sheet, `/cloud` and every page state the figures the server enforces (owner, 2026-10-16).
- **Top right:** Sign in and Get started (a member sees Open app). **Compact nav after scroll:** ONLY the vx logo at the top left, plus a mini "Ask Vex..." field.
- **"Learn more about VEX ↓"** leads from the card into the landing chapters below.
- **News is one hub** with three kinds: Releases, Announcements and Posts. At the landing it shows as a dismissible stack at the bottom right (an owner exception to the top centre toast rule).
- **Guests.** A guest chats from the first Enter, and the guest account is created on that first Enter, never on page view. The sign-in sheet keeps the pending prompt for 15 minutes ("Held for sign-in · kept 15 min").
- **Light and dark** both, following the system (stored choice wins); each has its own print.

## 12. Vex, the character (K2 from the token)

- **Who.** Vex is a woman: anime line style, long wavy, tousled black hair, pale skin, the vx on her tee. She is the face of the agent in both apps and on the home. She is NOT an eagle; the eagle and the flock are gone.
- **How she is drawn: K2.** A halftone portrait on a hex dot screen (about 7,000 dots) in her own three inks (white, ink, blue; periwinkle at night), projected from the vx token on a beam of the same dots as the sky's clouds. Source: the K2 modules of the VEX Cloud web app (private); the desktop port is `vex-app/src/renderer/components/vex/k2/`. The old 59 x 128 pixel B sprite and the chibi rounds are retired.
- **The exception.** The owner allows Vex herself, and only her, as a figure over a print or on paper, against the "no people" laws. Those laws still hold for the photographs: no people inside a print.
- **Behaviour.** She looks at you by default and now and then glances away; she blinks; her hair moves in the wind; a long hover makes her blush, a click makes her giggle; her idle pool plays one action at a time (blow a small dot cloud, a small bird from her palm, blush, whistle, hum), only at rest. She wakes from the token (the coin presses and lies flat, the beam rises, she assembles asleep, yawns, rubs an eye, smiles) and sleeps when the app locks. Episodes (wake, close, reopen, gestures) run at 30 fps, idle life at 10 fps; nothing paints offscreen; reduced motion is one still frame.
- **Moods per agent state** (apps): Ready calm and looking at you, Listening eyes on the composer, Thinking finger on her chin, Working narrowed eyes, Waiting for approval brows up and her palm toward the card, Done the grin and the peace sign, Concerned worried brows, Error a pout, Sleeping head lowered and dimmed, Waking up the wake. Gestures never play during approval, working or error. The word always stands beside her (the chip, the sidebar), except on the welcome, where no state word sits under her.
- **The token toggle.** Her token is a button ("Hide Vex"): pressed, she closes into the upright coin; pressed again, she wakes from it (home: `vx:vex-token-only`; app welcome: desktop `welcomeVexShown`, web the Show avatar choice).
- **Avatar optional.** "Show avatar" (on by default): off, no hologram anywhere; the flat token stands for her (desktop with a thin state ring) and the word, the narration and Needs you stay.
- **Where.** The home `/` beside the card (hovering her shows the four products on an arc: VEX DESKTOP, VEX CLOUD, $VEX, CLOUD), the app welcome (centre), the Vex sidebar plate, the desktop wake, unlock, first run and wizard, the web sign in and error plates. Not on the `/desktop` and `/cloud` heroes (owner, 2026-10-18: fewer is better).

## 13. The site in October 2026 (what changed)

- **No animals on any page** (owner, 2026-10-17): the eagle, the flock and the far birds left the home, the product heroes, the closing bands, the products strip and the structure map. Motion is the halftone dot clouds; the closing bands carry drifting dot clouds.
- **The home** carries Vex K2 rising from the vx token, with the token toggle (section 12).
- **`/token`** shows the 3D vx token: the coin floats face on and turns over a halftone light, frame by frame from a dense 110 frame turn sheet (two sheets, 400 and 300 px frames, rendered from the three.js prototype at 2x; owner, 2026-10-18: the earlier blend of four poses looked like 5 fps). It is the only product hero with art.
- **`/desktop` and `/cloud` heroes** carry no Vex and no art layer (owner, 2026-10-18); the print, the type and one dot cloud each hold them (from 640 px wide, low in the sky under the counter, out of the type; none on phones).
- **Product cards** carry dot screen emblems drawn in code in the Cloud emblem's language, on the home products strip and on the product cards of the (01) structure map, so every card of a product shows the same emblem: the cloud (VEX Cloud), a desktop computer (VEX Desktop: a solid bezel round a screen of small dots with two glints, the neck, the foot and a keyboard slab) and an office tower (Vex Inc.: lit window dots on a wall of small dots, a setback crown and a mast, a lower wing at its right). Plain rectangle silhouettes on whole cells of the dot screen, the cloud's own pitch and dot size. No image model, no text, no logo inside an emblem. Code: the VEX Cloud web app (private). Capture: `reference-images/site-home/real-products-strip-light-1440.jpg`.
- **Vex Inc.** (the AI-run company product, the new name of the Arena card, its horse retired) is described only as: a company run entirely by AI. A board of three models gets real money to hire agents, trade and buy VEX with its profits as equity. No human steps in, and every move is shown live. Status: In development (chip IN DEVELOPMENT, meta line "Coming soon"). The copy gives no fixed duration and no date; never add one. The name is changed in user-visible text only: route paths, slugs, ids and data keys still say arena.
- The landing fix reports (heroes without birds, home birds off, the token toggle, K2 motion at 30 fps, the token turn sheet, the heroes without Vex, the emblems and Vex Inc., all done by 2026-10-18) are kept by the VEX Cloud team. Captures of the products strip and `/token` are in `reference-images/site-home/`.
