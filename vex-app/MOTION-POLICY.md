# Motion / animation / runtime-styling policy (Phase 1)

This file has two halves. The **motion vocabulary** below says what may move,
for how long, and on what curve. Everything from "CSP precise semantics"
onwards says how a moving thing is allowed to be implemented under the
renderer's strict CSP. Both are binding.

## Motion vocabulary

Owner: `src/renderer/styles/global-css/tokens.css` (the CSS custom properties)
and `src/renderer/lib/motion/` (their JS mirror). The two are asserted against
each other by `styles/global-css/__tests__/motion-tokens.test.ts`; neither may
move alone.

### The duration scale

| Token | JS mirror | Value | For |
|---|---|---|---|
| `--vex-duration-instant` | `DURATION_INSTANT_MS` | 0ms | the reduced-motion resting value |
| `--vex-duration-fast` | `DURATION_FAST_MS` | 100ms | micro-feedback under the pointer: hover tints, the resize seam |
| `--vex-duration-base` | `DURATION_BASE_MS` | 150ms | the default: one component changing state |
| `--vex-duration-slow` | `DURATION_SLOW_MS` | 240ms | a modal or overlay taking the screen |
| `--vex-duration-reveal` | `DURATION_REVEAL_MS` | 300ms | a full-surface reveal: the shell column tracks (the Vex sidebar opening and hiding) |

New motion picks a step; it does not invent a number. The values are the ones
the app already shipped, so applying a token is a substitution and never a
retune.

Named exceptions, each with a reason, and the list is closed - anything not
here is a defect:

- `.vex-expand` (220ms) - the open/close primitive's own budget, one value for
  both directions, stated at its declaration.
- `TOAST_EXIT_MS` (200ms) and the notification enter (160ms) - the exit is a
  JS-owned pair (`lib/notifications/notification-model.ts` removes the node
  when it elapses), so its duration is a behaviour of the notification model
  rather than a style choice; retuning it is a notification change, not a
  motion change.
- The transcript keyframes (180ms / 260ms / 280ms) and the landing motifs -
  authored against the landing's own timing and out of scope for the desktop
  scale.
- Kimm's section, 720ms to open (`--vex-duration-vex-open`,
  `DURATION_VEX_OPEN_MS`) and 420ms to close (`--vex-duration-vex-close`,
  `DURATION_VEX_CLOSE_MS`), both on the push curve - printed on the H3
  mockup's strips (`docs/design/H3-DESKTOP.md` section 3.1) and shared with
  VEX Cloud, so they are a cross-app contract rather than a style step. They
  are hers alone: nothing else may borrow them. Her wipe animates clip-path,
  transform and opacity only, never a size, so the money card beside her
  never moves (section 3.6); reduced motion and Save-Data land her at once.
- The running blink, 600ms a cycle (`--vex-duration-blink`,
  `DURATION_BLINK_MS`) on `steps(2, end)`: a running square's opacity steps
  from 1 to 0.25 and back (PD-06, `docs/design/H3-DESKTOP.md` section 2.2).
  It is VEX Cloud's built `--vx-blink`, a cross-app contract like Kimm's
  timings. It is the drawing of a live state, not decoration: it runs only
  while the running, working or pending state lasts, and every running square
  in view blinks in phase (`StateSquare` pins its animation to document time
  zero). Reduced motion and Save-Data hold it still as half a square, so it
  never reads as the solid Filled square (`ui-primitives/marks.css`).

### The easing family

One family, four curves, no fifth. All four are declared in `tokens.css`
and mirrored in `lib/motion/index.ts`:

| Token | JS mirror | For |
|---|---|---|
| `--vex-ease-standard` | `EASE_STANDARD` | movement BETWEEN two resting states: crossfades, staggers, tints |
| `--vex-ease-out` | `EASE_OUT` | ENTRANCES: a surface arriving from nothing |
| `--vex-ease-inout` | `EASE_INOUT` | full-surface reveals |
| `--vex-ease-push` | `EASE_PUSH` | Kimm's section opening and closing, and nothing else |

The fourth curve, `cubic-bezier(0.22, 1, 0.36, 1)`, is derived rather than
chosen: the H3 mockup prints her section's clip inset at 120, 240 and 480ms
while opening and at 120 and 240ms while closing, and this curve reproduces
all five to the printed digits (`motion-tokens.test.ts` replays them). The
review sheet's own `--ease`, `cubic-bezier(0.625, 0.05, 0, 1)`, is the review
page's curve, not the app's, and misses those frames by up to about 315px.

A hardcoded `cubic-bezier(...)` anywhere else is a defect. It has happened:
`dialog[open]` carried `cubic-bezier(0.42, 0, 0.58, 1)` under a comment
claiming it rode `EASE_STANDARD`, which is `[0.4, 0, 0.2, 1]`.

### What motion is for

Three jobs, and nothing else:

1. **State change** - a selection settling, a tree expanding, a panel arriving,
   a subtree replaced by an error card.
2. **Spatial continuity** - a surface that moved should be seen to move, so the
   user does not have to re-find it.
3. **Attention on an approval, a failure or a diagnostic** - once, on arrival.

What motion is NOT for: decoration, idle loops, and anything that runs while
the user is not acting. A looping animation needs a live pending state that
ends it: the loading line and a stepping swatch loop only while the real wait
lasts, the signing stroke only while a key is being made. Attention is ONCE
(`docs/design/R3-MINIMAL.md` section 11): the "awaiting your action" badge
(`vex-badge--shimmer`, a mission contract or a compaction ready to accept)
dips its opacity once on arrival, on the reveal step each way, and then rests
on its swatch and word; it no longer pulses for as long as it waits. The one
named exception is Kimm's glyph field, bound by its own section below
("Kimm's glyph field"). Motion never
delays a committed result, an approval, a final error or a security decision.

Prefer `transform` and `opacity`. Animating a size is reserved for the owner
of that layout (`.vex-expand`, the shell's column tracks); nothing inside a
panel may animate its own width or height.

### Reduced motion

`styles/global-css/base.css` carries a catch-all that collapses every
animation and transition to 0.01ms under `prefers-reduced-motion: reduce`, so
a class-based effect degrades to an instant state change on its own. Two
obligations remain:

- **State your own collapse.** A motion primitive also writes its own
  `@media (prefers-reduced-motion: reduce)` rule, so it is complete and
  provable in isolation rather than only as a consequence of another file.
- **Take the instant path in JS.** When a JS timer is paired with a CSS
  duration, the CSS collapsing while the timer still waits means the user who
  asked for less motion waits for an animation that is not playing. The owner
  reads `prefersReducedMotion()` / `useReducedMotion()` from `lib/motion/` and
  settles in the same commit instead.

The single documented opt-out from the catch-all is `data-vex-motion-opacity`,
whose contract is stated at the catch-all in `base.css`: an element may carry
it only if it defines a reduced-motion rule that removes every transform and
every movement and leaves at most an opacity change. Its holders are the
toasts (their exit fade stays a fade) and the pre-shell stage plate with the
handoff turn (the stage and the shell crossfade over a fixed 240ms linear).

What reduced motion means across R3 (`docs/design/R3-MINIMAL.md` section 11),
and where each part is stated:

- every duration collapses to instant, and so does every delay (the catch-all
  forces `animation-delay` and `transition-delay` to 0, so a both-filled
  stagger never holds its line invisible before it snaps in);
- the shell's column tracks snap: opening or hiding the Vex sidebar is a width
  change with no slide (`shell.css` states its own collapse);
- swatches and the loading line stop stepping (`ui-primitives/marks.css`);
- Kimm's glyph field paints one settled frame (`use-still-frame.ts`);
- Save-Data asks for the same still frame, and since it has no media query
  it reaches CSS as `data-still` on `<html>`: `public/theme-boot.js` stamps
  it before first paint and follows the connection's change event
  (`stampSaveData`, `use-still-frame.ts`), and `base.css` carries a twin of
  the reduced-motion catch-all under it, with the same one opt-out. A
  CSS-only motion, Kimm's clip-path wipe included
  (`docs/design/H3-DESKTOP.md` section 3.7), lands at once under either;
- the stage and the shell crossfade over a fixed 240ms linear (the opt-out
  above). Nothing slides.

### Kimm's glyph field

The falling V, X and E behind Kimm's figure on her blue ground
(`src/renderer/components/vex/kimm/KimmField.tsx` over the pure model
`kimm-field.ts`; `docs/design/H3-DESKTOP.md` sections 1.5, 3.2 and 3.5) is
the named loop. It is part of how she is drawn, not an idle
decoration, and it is bound four ways:

- **Only while her section is open.** Closed, the field holds its frame in
  the strip ("the field holds its frame", section 3.2) and paints nothing;
  opening starts it again from that frame. Her section's open choice is the
  switch, never her agent's state.
- **The run gate.** `lib/motion/run-gate.ts` runs it only while its canvas is
  on screen and the window is shown; a hidden window, a column folded or
  scrolled away, or the inspect view over her paints no frame.
- **A fixed step and a clock cap.** The model steps 10 times a second
  (`KIMM_FIELD_STEP_MS`), so a frame whose step has not come
  repaints nothing, and one animation frame never advances it more than
  250ms (`KIMM_FIELD_CLOCK_CAP_MS`), so a stalled window resumes where it
  stopped. Its draws come from one seeded sequence: the same step is the
  same field.
- **The still frame.** Reduced motion and Save-Data
  (`lib/motion/use-still-frame.ts`) paint one composed frame
  (`KIMM_FIELD_STILL_STEP`) and repaint only when its box changes; no loop
  starts.

It draws on a canvas, so it moves nothing in the layout and no transition or
keyframe of it exists to collapse; the bounds above are the whole of its
motion.

### The shell and the Vex sidebar

- **The column tracks.** The frame's `grid-template-columns` rides
  `--vex-duration-reveal` on `--vex-ease-inout`; a sidebar and its rail swap in
  one commit and only the tracks move. Lighter's chat share drag pauses the
  transition. Reduced motion snaps the tracks.
- **Her section opens and closes in its own wipe.** Kimm's section, the
  welcome's column included, opens in a 720ms clip-path wipe and closes in a
  420ms one (`KimmSection`, kimm.css; `docs/design/H3-DESKTOP.md` section
  3.1). Under the still frame she simply appears or folds.
- **A hide lands at the press.** When the user hides her (the header's Vex
  key, the desk's token chip, Cmd or Ctrl + Shift + B), the toggle writes the
  store at once and her section's wipe is the close
  (`features/vex/vex-hide.ts`); focus that was in a column that goes moves to
  the toggle that brings her back. A column the shell closes on its own (the
  narrow tier when the left sidebar opens, a table page's default, Lighter's
  Zen) goes at once too.

### The CSP rule for motion

Motion is expressed as **classes and CSS custom properties**, emitted at build
time. Not as a `style` attribute parsed from a string, and not as a runtime
stylesheet. The precise semantics - what CSP does and does not govern, and why
React's `style={{...}}` prop is on the allowed side - are in the sections
below; they are the authority, and this line is the summary.

### Cross-file timing invariants

When a JS timer must agree with a CSS duration, exactly one of them is the
source: a named constant that the CSS mirrors through its token, with a comment
on BOTH sides naming the pair. A number repeated in two files is a pair waiting
to drift.

Live pairs:

| JS constant | CSS site | Consequence of drift |
|---|---|---|
| `TOAST_EXIT_MS` | `.vex-notification-toast[data-phase="exiting"]`, overlays.css | a cut-off fade, or an invisible node holding a stack slot |
| `SECTION_SETTLE_MS` (`book/ReorderableSection.tsx`) | `.vex-section-settle`, motion-primitives.css (240ms) | the class is removed mid-settle, or held after it |
| `DURATION_VEX_CLOSE_MS` (`components/vex/kimm/KimmSection.tsx`, the end of her `closing` phase when no `transitionend` comes) | `.vex-kimm[data-kimm-open="false"]`'s clip-path transition, kimm.css (`--vex-duration-vex-close`) | her figure gives way to the strip mid-wipe, or she reads as closing after the wipe has ended |
| `DURATION_VEX_OPEN_MS` (`components/vex/kimm/KimmSection.tsx`, the end of her `opening` phase when no `transitionend` comes) | `.vex-kimm`'s clip-path transition, kimm.css (`--vex-duration-vex-open`) | the scan head goes before the wipe reaches her foot, or stays after it |


CSP for the renderer is strict: `style-src 'self'`: no `'unsafe-inline'`, no
inline `<style>` blocks, no inline HTML `style="..."` attributes parsed from
markup. This is a non-negotiable Phase 1 gate (skill §7, plan §"Phase 1
Acceptance Gates" CSP smoke test).

## CSP precise semantics (corrected per codex audits 2026-05-08)

Per CSP3 spec + MDN docs (`style-src`, `style-src-attr`), the `style-src`
directive controls:

1. external stylesheets (`<link rel="stylesheet" href="...">`)
2. `<style>` element contents
3. inline HTML `style="..."` attributes (governed by `style-src-attr` if set,
   otherwise inherited from `style-src`)
4. **`element.setAttribute("style", "...")`**: treated as creating an inline
   style attribute, hence blocked under `style-src 'self'`
5. **`element.style.cssText = "..."`**: also creates a parsed inline style
   string, also blocked

What `style-src` does NOT govern:

- `element.style.foo = "value"`: single CSSOM property assignment, allowed
- `CSSStyleSheet.insertRule(...)` from JavaScript: allowed by CSP, but
  audit-relevant: it is still a runtime stylesheet mutation, so a library
  that calls it for theming/animations should be reviewed under the same
  rigor as `<style>` injection (codex 2026-05-08 turn 2).
- `element.style.setProperty("--foo", "bar")`: single CSSOM property
  assignment, allowed

The distinction is: parsing a string into multiple style declarations
(`setAttribute`, `cssText`, raw HTML) is blocked; assigning a single
property via CSSOM is allowed.

## What that means for `motion` (formerly `framer-motion`)

React's reconciler applies `style={{...}}` props in the commit phase via
**CSSOM property assignment** (`domStyle[key] = value` in a loop), not via
`setAttribute("style", ...)`. So React-rendered inline styles go through the
allowed path.

Motion's animation loop similarly mutates `element.style.<prop>` in
`requestAnimationFrame`, which is also CSSOM property assignment.

Motion is therefore CSP-safe under our policy when used through React, and
its `style={{...}}` props will not produce CSP violations.

The places we must still avoid:

1. **`<style>{...}</style>` element injection**: some libraries (older
   Emotion configs, theme runtimes) parse a `<style>` element back into the
   DOM. Tailwind v4 emits CSS at build, so this is a non-issue for us; do not
   introduce another style runtime that would need an inline `<style>` tag.
2. **`<motion.div layout>` / `<Reorder>`**: Motion's layout features inject
   a runtime stylesheet to scope `layoutId` keyframes. **Avoid on
   wizard-critical screens** (Splash, System Check, Wallet step, Provider
   step, Review step). For Phase 2 chat/portfolio screens we will re-evaluate
   per feature.
3. **`dangerouslySetInnerHTML`**: never; always banned.
4. **Server-rendered HTML strings with `style="..."`**: banned. Our
   renderer is a SPA, no SSR, and no template literal injects raw `style=`.

## Per-Radix-primitive audit checklist (codex RED 3)

When introducing any `@radix-ui/*` primitive in a future milestone, the PR
must include:

- [ ] Confirm the primitive does not append a `<style>` element to `<head>`
      at runtime (open DevTools → Elements → `<head>`, exercise every state).
- [ ] Confirm any positioning/animation styles arrive via React `style`
      props (JS path, allowed) and not via injected `<style>` blocks.
- [ ] Run a Playwright `_electron` probe that opens every visible state
      (open/closed/hover) and asserts no `Refused to apply inline style`
      console violations.
- [ ] Document the audit result in this file under "Audited primitives"
      with the verifying commit hash.

If a primitive injects runtime `<style>`, two options exist:

- **Reject the primitive.** Prefer a CSS-only alternative or build a
  bespoke component using shadcn-pattern variants over Tailwind classes.
- **Implement nonce CSP plumbing properly.** This requires the main
  process to mint a per-load nonce, inject it into the served HTML, and
  forward it to the primitive's StyleSheet manager. **Do not ship a
  static nonce as a workaround**: that defeats CSP.

### Audited primitives

| Primitive | Status | Verifier | Commit |
|---|---|---|---|
| Button (shadcn-pattern, no Radix) | safe | M1 | TBD |

## Allowed

- `motion.div`, `motion.span`, etc. with `initial`, `animate`, `exit`,
  `transition` props (React-JSX path).
- `useAnimate`, `useScroll`, `useTransform` hooks.
- `AnimatePresence` for component mount/unmount transitions WITHOUT
  `layout`/`layoutId`.
- CSS keyframe animations defined in `globals.css` or Tailwind utilities
  (build-time emission, not runtime injection).
- Tailwind `transition-*` and `animate-*` utility classes.

## Disallowed in Phase 1

- `<motion.div layout>` and friends.
- `<Reorder.Group>` / `<Reorder.Item>`.
- Any third-party library that injects runtime `<style>` elements
  without an audited nonce or hash exception.
- Any inline-style HTML rendered from a string template (SSR-shaped
  paths, `innerHTML` assignments, `dangerouslySetInnerHTML`).

## Verification

The post-build CI script (`scripts/check-build-artifacts.mjs`) asserts that
the final HTML CSP contains no `'unsafe-inline'` or `'unsafe-eval'`. Per-state
runtime checks on Radix primitives ride in the M15 Playwright suite; new
primitives must include a runtime CSP smoke at the time of adoption (not
deferred). Any future inclusion that breaks this must be flagged in PR
review and either reworked or covered by a signed-off exception (currently
zero exceptions allowed).
