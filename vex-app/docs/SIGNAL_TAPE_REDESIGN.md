# Signal Tape — main-app UI/UX redesign spec

> **HISTORICAL — superseded by the projectvex.ai landing rebrand (2026-07).**
> Token names/fonts below describe the retired Protocol Desk language —
> see `src/renderer/styles/globals.css` for current law.
>
> Also retired since this spec was written, and named throughout it: the
> `@hugeicons/*` packages (icons now come from `lucide-react` behind
> `renderer/components/icons/`), `SessionRuntimeBar` (replaced by the Runtime &
> Cost card), the MOVES block and its `listMoves` pipeline, and the
> `vex-signal-resolve` / `vex-fade-top` CSS rules (deleted with their last
> consumers). Nothing here describes current code.

> **Status:** DRAFT for acceptance. Spec + foundation first; implementation follows
> per-area after sign-off. Scope = the **post-launch main app** (`features/appShell`
> + the renderer token/primitive layer). The **intro/onboarding wizard stays** and is
> out of scope except where it shares the global token root.
>
> **Direction chosen:** _Signal Tape_ (hybrid) — see "How we got here" below.
> **Deliverable mode:** full spec + foundation diff for review, then staged build.
> **Progress:** ✅ **P0 Foundation shipped & verified** (§0.5). Sections 3–11 are
> the accepted per-area spec, pending staged implementation.

## How we got here

Two read-only reconnaissance passes mapped all 12 main-app UI areas; a 5-way
adversarial design panel scored five premium directions (Countersign Terminal,
SIGNAL DESK, Aquifer, Vitrine, The Reading Room). The top two tied; the synthesis
grafted them into **Signal Tape**, which lands top-tier on brand **and** motion
**and** feasibility at once by reusing already-shipped CSP-safe primitives.

The key reconnaissance verdict: the shell is **already a mature, guard-locked,
on-brand-in-structure** "Protocol Desk / Countersign" system. So this is a
**brand-alignment + motion-elevation** pass, **not** a teardown. We _evolve_ the
existing language; we do not replace it.

---

## Section 0 — Foundation (P0, do first)

The single highest-leverage, lowest-risk change. It is purely the renderer token
root + shared primitives; it does not touch IPC, security, or process boundaries.

### 0.1 Retire indigo/violet; unify on the electric-blue family

`vex-app/src/renderer/styles/globals.css`, global `@theme` block:

| Line | Token | Current (off-brand) | New |
| --- | --- | --- | --- |
| 52 | `--color-bg-primary` | `#0a0e27` (legacy navy) | `#04060f` (Protocol Desk canvas) |
| 53 | `--color-bg-elevated` | `#161b3f` | **RETAINED** (wizard-safe) |
| 54 | `--color-bg-overlay` | `#1f2552` | **RETAINED** (wizard-safe) |
| 55 | `--color-accent-primary` | `#6366f1` (indigo) | `#3275f8` ✅ shipped |
| 56 | `--color-accent-secondary` | `#8b5cf6` (violet) | `color-mix(in oklab, #3275f8 65%, white)` (periwinkle) ✅ shipped |

> **Deviation from the first draft (verified):** lines 53–54 are **kept** as the
> legacy navy. The onboarding/wizard flow consumes them via shadcn
> `card`/`border`/`input`/`popover` (`[data-vex-onboarding]` overrides only
> `primary`/`ring`; wizard steps use `bg-card`/`border-border`/`bg-input`), and
> that finished flow must stay visually unchanged. Migrating them is a separate,
> pixel-verified step. The **main app is unaffected** — `[data-vex-shell]` already
> overrides every surface.

The shadcn alias projection (`--color-primary`/`--color-secondary`/`--color-ring`,
lines 79/81/91) is kept verbatim — only the source values change, so all ~215
downstream usages flip to electric blue with no per-component edits. **Promoting
`--vex-accent-*` to the global root was deemed unnecessary:** the only non-shell
consumers (`select-menu.tsx`, `MarkdownContent.tsx`) render inside the shell scope,
so they already resolve. Left as optional future hardening.

`[data-vex-shell]` and `[data-vex-onboarding]` scopes are **unchanged** — they are
already `#3275f8`. After this change the global default matches them, so the scopes
become overrides only where luminance/semantics genuinely differ.

### 0.2 Tokenize the two stray hexes inside the shell

These are the only raw-hex token bypasses inside `[data-vex-shell]`:

| Raw hex | Where | New token | Notes |
| --- | --- | --- | --- |
| `#f0a0a0` | `SessionRuntimeBar.tsx` (CompactionChip failed) | `--vex-warn-text` = `color-mix(in oklab, var(--color-danger) 70%, white)` ✅ shipped | **Decided: danger** (unrecoverable). |
| `#ffd35c` | `SessionRows/PinToggle.tsx` (pin gold) | `--vex-pin` + `--vex-pin-border/-fill/-fill-hover` ✅ shipped | Tokenized warm semantic; same value, now a sanctioned non-blue status. |

Also repoint the few shell files still reading the **global** text token
`--color-text-muted`/`--color-text-secondary` to the shell trio
`--vex-text-3`/`--vex-text-2`: `SessionRuntimeBar.tsx:76,114,120,166,326`,
`SessionRows/PinToggle.tsx:37`, `SessionRows/RemoveButton.tsx:25`,
`SessionCreator/FormSections.tsx:53,147`, `WelcomeBanner.tsx:35`. (After 0.1 these
resolve to on-brand values anyway, but the shell trio is the correct source.)

### 0.3 Quiet the shared primitives (depth law) — DEFERRED to Section 11

> Not in the P0 commit. `Button` (30 importers + wallet-security surfaces),
> `Dialog` (glass default), and `Card` (`shadow-sm`) are global levers that touch
> the wizard and security flows, so they get their own isolated, tested change in
> the Primitives stage. After §0.1 the violet `secondary` is already on-brand
> periwinkle in the interim, so nothing is left visibly off-brand.

- `components/ui/card.tsx:19` — drop `shadow-sm` (resting shadow violates the
  hairline-only depth law). Depth comes from luminance + hairline.
- `components/ui/dialog.tsx:212-213` — the base ships glass (`backdrop-blur-sm` +
  `shadow-lg`); today every shell consumer manually neutralizes it. Make the
  **shell skin the default** (no glass, hairline border, `--vex-surface-2`) and
  drop the per-consumer overrides. (Detailed in the Primitives area spec.)
- `components/ui/button.tsx` — `variant="secondary"` is violet and is used in
  user-facing **wallet/export security** surfaces (`ExportPrivateKeyFooter.tsx:31`,
  etc.). Reworked in the Primitives area spec: default = quiet hairline, one
  `signal` variant for the single live/pending CTA. After 0.1 it is at least
  on-brand periwinkle in the interim.

### 0.4 Extend the design guard (lock the foundation)

`features/appShell/__tests__/shell-design-guard.test.ts` — add to `BANNED`
(it scans `features/appShell/**` + `dialog.tsx` + `select-menu.tsx` as raw text):

```ts
{ name: "legacy indigo/violet accent", regex: /#(?:6366f1|8b5cf6)/i },
{ name: "raw status hex (pin/warn)",   regex: /#(?:ffd35c|f0a0a0)/i },
```

The 2 hex bans above are **shipped** (each with a self-test). Widening the glob
scope to `card.tsx`/`button.tsx` with a resting-shadow check is **deferred** to the
Section 11 primitives stage (it lands with those files). The existing 4 bans
(backdrop-blur, ShinyText, legacy gray-blue hexes, `shadow-[0_0_`) stay. `#3275f8`
remains explicitly allowed (it's the token root; CSS is out of scan scope).

**Guard impact of 0.1:** none — the guard scans component sources, not
`globals.css`, and `#3275f8` is not banned. The indigo hexes live only in
`globals.css`, so the new bans protect against future component-level regressions.

### 0.5 Implementation status — P0 shipped ✅

| Change | File | Status |
| --- | --- | --- |
| Retire indigo accent → `#3275f8` | `globals.css` `@theme:55` | ✅ |
| Retire violet secondary → periwinkle | `globals.css` `@theme:56` | ✅ |
| Body canvas → Protocol Desk `#04060f` | `globals.css` `@theme:52` | ✅ |
| New tokens `--vex-pin*`, `--vex-warn-text` (danger) | `globals.css` `[data-vex-shell]` | ✅ |
| `#f0a0a0` → `--vex-warn-text`; `--color-text-muted` → `--vex-text-3` | `SessionRuntimeBar.tsx` | ✅ |
| `#ffd35c` → `--vex-pin*`; muted → `--vex-text-3` | `SessionRows/PinToggle.tsx` | ✅ |
| Guard: ban indigo/violet + pin/warn raw hex + self-tests | `shell-design-guard.test.ts` | ✅ |
| `bg-elevated/overlay` migration | `globals.css` 53/54 | ⏸ deferred (wizard-safe) |
| Card/Dialog/Button quieting | `components/ui/*` | ⏸ deferred → Section 11 |

**Verification:** renderer build `EXIT 0` (Tailwind compiled the `color-mix`
token); affected tests `24/24 pass` (guard + RuntimeBar + pin); renderer typecheck
delta = **0 new errors** (116 pre-existing baseline, proven via stash diff). Guard
scope confirmed free of all banned hexes.

---

## Section 1 — The Signal Tape system (the ten laws)

Every per-area spec (Sections 3–11) obeys these verbatim.

1. **One spine.** A single monotonic **timeline gutter** (~28px) runs the
   transcript's left edge; the sidebar shares a thin upstream gutter; the composer
   is the bottom anchor of the same axis. Every entry hangs off **one** time/
   sequence axis: a node + mono `tabular-nums` `HH:MM` + sequence index. _Free_:
   `id` (monotonic SERIAL PK) + `createdAt` (ISO) are already on every
   `TranscriptEntry` (`transcriptRowModel.ts:35-40`); reuse the existing
   `pl-7`/`CountersignTick` 28px gutter slot (`TranscriptMessage.tsx:51-58`).
2. **Blue rationing.** `--vex-accent` lights **only**: the live/streaming node,
   pending-decision (awaiting signature/approval), the focus ring, and the single
   primary CTA. At rest, everything is hairline `--vex-line` + the text trio. No
   resting blue fills as decoration.
3. **Motion is never ambient.** The only resting-animated element is the dot-matrix
   needle, provably bound to in-flight engine work, frozen on idle/pending-approval.
   No ambient canvas, no blur planes, no shimmer, no resting glow.
4. **Trust = stillness.** A pending approval **freezes all motion** (extend the
   existing `animated={!awaitingApproval}` gate shell-wide). Commit = one-shot
   `vex-stamp-press` re-read as a **LOCK** stamp.
5. **Signature motion — Needle Bloom-and-Resolve.** At reasoning-end/answer-start
   the gutter node fires **one** blue bloom via a new build-time
   `@keyframes vex-signal-resolve` ramping `--dmx-bloom-level` `0→1→0` (auto-tinted
   by the existing `01-base.css` drop-shadow that reads
   `max(--dmx-bloom-level, --dmx-halo-level)`), synced to a **mono→proportional**
   type switch (Geist Mono → Google Sans) on the answer block. One-shot, rests
   still. Reduced-motion = static lit needle + instant reveal.
6. **One dissolve, one place.** Holographic-dissolve = the ephemeral reasoning tail
   via the `.vex-fade-top` mask **only** (a mask, not a painted gradient). Never on
   chrome. The mascot art never enters product chrome.
7. **Dot-matrix policy.** Texture bound to meaning: cognition marks (existing
   `DotmCircular8`/`DotmHex3`/`DotmSquare3`), active/streaming nodes, and optional
   ≤6–8% accent-tint dot separators in section headers / group rails. Never a
   resting full-surface pattern, never a gradient fill. Retire the off-brand
   DotMatrix color presets (`grad-aurora`/purple in `dotmatrix-core/color.ts`) and
   remove the undefined `var(--color-dot-on)`.
8. **Typography.** Geist Mono = instrument microtype (timeline stamps, status
   words, telemetry, tabular numerics) uppercase 10–13px, tracking 0.14–0.3em;
   Google Sans = content/answers. The mono→proportional switch **is** the resolve
   signal.
9. **Depth law (guard-enforced).** Solid luminance steps + hairlines only. No
   gradients-as-fill, no glass/backdrop-filter, no resting shadow/glow.
10. **BOOK panel on-demand.** A right panel (3rd flex child of `<main>` in
    `AppShell`) slides in on demand for expanded position/runtime/memory/ledger; it
    is **not** a permanent third column. Approvals dock **inline** at point-of-cause
    in the tape.

### Motion vocabulary (CSP-safe, reuse-first)

| Name | Trigger | Technique | Duration/easing | Reduced-motion |
| --- | --- | --- | --- | --- |
| Tape entry settle | live-appended row mounts | existing `.vex-entry-settle` @keyframes (opacity + 3px translateY); history mounts at final frame via `SettledIdsTracker` | 180ms ease-out | final frame instantly |
| Dot-matrix needle | engine streaming (thinking/acting); freezes on pending/idle | existing dmx CSS @keyframes, per-dot opacity, `animated` prop gates the loop | ~1500ms cycle, infinite-while-working | static lit dot |
| **Needle bloom-and-resolve** | reasoning-end / answer-start | **new** `@keyframes vex-signal-resolve` on `--dmx-bloom-level` 0→1→0 + mono→proportional class swap | 220ms `cubic-bezier(.22,1,.36,1)`, one-shot | static lit needle + instant reveal |
| Reasoning-tail dissolve | reasoning streaming | existing `.vex-fade-top` mask | static mask | unchanged (mask, not motion) |
| Countersign stroke | approval/execution settles | existing `.vex-sign-stroke` scaleX (single CSSOM transform) | 240ms `cubic-bezier(.22,1,.36,1)`, one-shot | static drawn line |
| LOCK stamp | approval committed | existing `vex-stamp-press` (opacity + scale 1.15→1) | 180ms ease-out, one-shot | final frame |
| Composer baseline sweep | plan-ON / submit | existing `.vex-sign-stroke` + `.vex-mode-line--on` | 240ms, one-shot/held | static half-ink |
| Numeric tick-and-decay | a telemetry value changes | Motion v12 `animate` on **color** only (accent-text→text), CSSOM path | ~600ms ease-out | final color instantly |

No new long-lived primitives. No ambient canvas. No blur planes. Every infinite
animation is bound to verifiable in-flight work (laws 3 + 4).

---

## Section 2 — Plan mode (resolution)

**Finding (verified in code):** plan mode is **already composer-only.** `PlanSwitch`
is the sole writer (`useSetPlanMode`, invalidate-based) mounted in the composer
chrome (`SessionComposer.tsx:384-391`); `SessionCreator.tsx` has **zero** plan
fields; `getSessionTitle` (`sessionListModel.ts`) never includes plan; `SessionRow`
renders no plan indicator. The relocation you described was completed in a prior
"S2" stage.

**Therefore the change is "lock + absorb," not "relocate":**

1. **Lock** it with a guard/test asserting no plan reference appears in the session
   title, row, or creator (prevents regression).
2. **Absorb** `SessionPlanCard` into an inline **PLAN BRIEF** tape entry variant, so
   the plan reads as an entry on the spine rather than a floating card above the
   transcript.
3. Keep the composer **PLAN** switch as the only control (now visually
   differentiated from REASON — see the Composer area spec).

> ⚠️ **Confirm:** if by "plan mode under the session name" you meant the
> session-creation **mode picker** (`agent` vs `mission`), or you want plan to
> become a richer dedicated surface, say so — that's a different change. Otherwise
> we proceed with lock + absorb.

---

## Section 3 — Shell · timeline-gutter spine & BOOK panel

> **Build status:** 🟡 Shipped — the **continuous timeline-gutter spine** + quiet
> per-entry `TapeNode` (blue rationed out of resting nodes), the **left-anchored
> tape** (`SessionPanel` `justify-start` → one shared left axis: header tick →
> spine → composer), and the **DESK RULE tape-head** (`DeskRuleTapeState` reports
> LIVE / AWAITING / IDLE). Remaining: BOOK panel + inline PLAN BRIEF entry.
>
> _Recon area: Shell, Timeline-Gutter spine & BOOK panel (vex-app renderer — AppShell + SessionPanel + SessionContext + uiStore)_

**Intent.** This area is the Protocol Desk frame that holds the chat/agent workspace: a sidebar rail, a single centered transcript column, the DESK RULE header datum, and an on-demand BOOK panel. The redesign collapses the transcript's many per-row left affordances (the repeated pl-7 + CountersignTick at TranscriptMessage.tsx:107/119/150 and the working strip at StreamingBubble.tsx:174) into ONE continuous TIMELINE GUTTER — a single monotonic time/sequence spine the whole session hangs off. The DESK RULE header is promoted to carry the tape head (session register line + live/idle tape-state, absorbing the SessionContext h-9 register and the right-side version stamp). The BOOK panel becomes a third flex child of <main> that slides in for expanded position/runtime/memory/ledger detail without becoming a permanent third column. Plan reads as an inline PLAN BRIEF tape entry, not a floating SessionPlanCard. The net effect: the session is one legible instrument tape with one axis of time, quiet at rest, blue only where it means "live" or "your pen is needed."

**UX structure.** Layout (AppShell.tsx <main> flex-row, native OS frame): [1] SessionsList rail (existing aside, w-[296px]/w-[72px], border-r --vex-line, bg --vex-surface-1) carries a THIN upstream gutter — a 2px hairline accent tick already lives at its h-12 header bottom; the rail's left edge is the visual upstream of the spine, not a second spine. [2] content <section> (flex-1, min-w-0) containing the DESK RULE header + the centered max-w-[860px] column. [3] NEW BookPanel as the 3rd flex child of <main>, conditionally mounted, fixed width w-[380px], border-l --vex-line, bg --vex-surface-1, NOT flex-1 (never steals the canvas).

THE SPINE inside the 860px column: a single absolutely-positioned vertical hairline at left:13px (center of the 28px gutter) running the transcript's scroll content from first node to the composer anchor. Each transcript row reserves the SAME 28px gutter (the existing pl-7 = 1.75rem = 28px slot) and hangs a NODE off the spine at its top: a 5px square node (reusing the CountersignTick footprint: left-0 top-[5px] h-4 w-0.5 becomes a node glyph), plus a mono tabular-nums HH:MM stamp and sequence index in the gutter for assistant/tool/notice/compaction/recall/plan-brief rows. User rows stay right-aligned cards but ALSO drop a node on the spine (a hollow node) so the operator's turn is on the same axis. The composer is the bottom anchor: a terminal node closes the spine.

DESK RULE / TAPE HEAD (header, h-12): left side now carries the session register (title + EXCEPTION stamps, migrated from SessionContext.tsx:60-79) aligned to the spine's x-origin; right side keeps the v{version} mono stamp and gains a TAPE-STATE word (LIVE / IDLE / AWAITING) + a BOOK toggle button. The 24px accent tick at the rule's bottom (AppShell.tsx:49-52) is repositioned to sit exactly over the spine's x so the header tick reads as the spine's head.

Interaction model: spine is non-interactive (aria-hidden) decoration bound to meaning. Nodes are non-interactive except the streaming node (live). BOOK toggle is a real button (header right). PLAN BRIEF entry is an inline tape row (absorbs SessionPlanCard), with its Accept/Resume actions kept inline at point-of-cause.

Keyboard model: BOOK toggle is tab-reachable, focus-visible ring --vex-accent, toggled by Enter/Space, closed by Escape when open (focus returns to the toggle). Spine + nodes are not focusable. Existing transcript scroll/keyboard behavior (SessionTranscript.tsx) is untouched.

Animates vs still: ONLY the live streaming node animates (DotMatrix needle, already gated animated={!awaitingApproval}). The spine hairline, all resting nodes, the DESK RULE, the BOOK panel chrome, and the version/tape-state stamps are perfectly still. The one-shot needle bloom fires at reasoning-end/answer-start. BOOK slide-in is a one-shot transform.

**States.**

- idle (no in-flight work): spine fully drawn, all nodes static lit/hollow, tape-state word = IDLE in --vex-text-3, needle frozen, no blue fills
- loading (session detail resolving): DESK RULE shows the existing DotmHex3 + 'LOADING SESSION' mono line at the tape head (migrated from SessionContext.tsx:30-41); spine not yet drawn until first row resolves
- live/streaming (engine in-flight): the bottom-most node is the DotMatrix needle (animated), tape-state word = LIVE in --vex-accent-text, ElapsedCounter ticks in the gutter; this is the ONLY moment blue lights as a node
- signature-resolve (reasoning-end/answer-start): the live node fires ONE vex-signal-resolve bloom, the answer block switches Geist Mono -> Google Sans, then the node rests still
- awaiting-approval (pending decision): TRUST=STILLNESS — needle FREEZES via the existing animated={!awaitingApproval} gate extended shell-wide; tape-state word = AWAITING in --vex-accent-text (no pulse, no fill); the inline ApprovalCard docks at point-of-cause node; spine + BOOK panel motion frozen too
- commit/locked (approval signed): one-shot vex-stamp-press re-read as a LOCK stamp on the resolved node; then still
- empty (active session, zero rows): centered 'Start the conversation' copy (SessionTranscript.tsx:267-278) with the spine drawn only as the header tick + composer anchor (a thread waiting to be written)
- no-session: 680px welcome hero path (SessionPanel.tsx:67-86) — NO spine (there is no tape yet); DESK RULE carries only the version stamp; BOOK toggle hidden
- validation/transcript-error: boxed destructive line (SessionTranscript.tsx:246-266) sits on the spine at its node; spine continues past it
- older-page load: existing top DotmHex3 + 'Couldn't load older' banner; spine is continuous across the prepend (no gutter reflow)
- BOOK open: 3rd flex child mounted w-[380px], content (position/runtime/memory/ledger) scrollable; canvas column narrows but stays >= its min content width
- BOOK unavailable (no data for the requested view, e.g. non-mission session has no ledger): BOOK toggle still opens but shows a boxless 'Nothing to show yet' mono line — never a blank panel
- offline/runtime-degraded: tape-state word = IDLE, SessionRuntimeBar chips self-gate to nothing (existing behavior); spine unaffected
- cancellation (stop): assistant_stopped row keeps its node + 'Stopped' line (TranscriptMessage.tsx:113-128); needle gone, no bloom
- reduced-motion: spine + nodes static, live node is a static lit needle, signal-resolve is an instant mono->proportional reveal with no bloom, BOOK slide-in becomes an instant mount

**Design tokens.** Surfaces: canvas --vex-surface-0 #04060f (AppShell <main>); panels/rail/composer/BOOK --vex-surface-1 #090e1d; raised/popover --vex-surface-2 #0f1729; recessed wells --vex-surface-down #02040a (plan-brief filed-document well, reusing SessionPlanCard.tsx:84). Hairlines: --vex-line (6%) for spine, header/section borders, BOOK border-l; --vex-line-strong (10%) for the user-card border + raised dividers. Text trio: --vex-text #e5e7eb (answers/body), --vex-text-2 #d4d6dc (timestamps/captions/metadata), --vex-text-3 #b5b7c0 (idle tape-state word, gutter sequence index, group headers, version stamp). Accent (RATIONED): --vex-accent #3275f8 ONLY on the live/streaming node, focus rings, and the single primary CTA; --vex-accent-text for the AWAITING/LIVE word + accent stamps; --vex-accent-border / --vex-accent-border-strong for the inline action key + hover; --vex-accent-fill-8 / -fill-12 only as hover/active fills on actions (never resting decoration). Semantic: --vex-pin (tape pin flag, replaces raw #ffd35c) for a pinned/flagged tape entry; --vex-warn-text (replaces raw #f0a0a0 still living at SessionRuntimeBar.tsx:325) for the restricted/failed stamp text. Radii: --radius-sm 0.375rem (stamps/nodes), --radius-md 0.5rem (action keys, user card was rounded-lg = --radius-lg), --radius-lg 0.75rem (BOOK panel inner cards). Borders: 1px solid hairline only; NO shadows, NO glow, NO gradient-as-fill, NO backdrop-filter (DEPTH LAW, pinned by shell-design-guard.test.ts). Motion: durations 180ms (entry-settle, stamp-press — existing), ~240ms (BOOK slide, reusing the cubic-bezier(0.22,1,0.36,1) easing already in .vex-sign-stroke); needle bloom ramps --dmx-bloom-level 0->1->0. Typography: --font-mono Geist Mono for ALL gutter stamps/tape-state/sequence (uppercase 10-13px, tracking 0.14em-0.3em, tabular-nums — matching AssistantCaption at TranscriptMessage.tsx:67 and the existing gutter clock); --font-sans Google Sans for answer/body content (text-[15px] leading-[1.7], TranscriptMessage.tsx:76); --font-display Poppins reserved for none of this area's chrome. The mono->proportional switch on the answer block IS the resolve signal.

**Component spec.** Outside-in:

CONTAINER — AppShell <main> (AppShell.tsx:38): keep flex h-screen w-screen overflow-hidden bg-[var(--vex-surface-0)], data-vex-shell="true". Children become exactly three: <SessionsList/>, <section> content column, <BookPanel/> (new, conditionally rendered as the 3rd flex child). SessionCreator stays a portaled modal sibling (not a flex child).

HEADER / TAPE HEAD — promote the DESK RULE (AppShell.tsx:48-56). Keep header relative flex h-12 shrink-0 items-center border-b border-[var(--vex-line)] but change justify-end -> justify-between and px-6. LEFT slot: the session register (title + EXCEPTION stamps) lifted out of SessionContext; its left padding aligns to the spine x (pl matched to the column's px-6 + gutter origin). The 24px accent tick (AppShell.tsx:49-52) is repositioned from left-6 to sit over the spine x so it reads as the tape head. RIGHT slot: <TapeStateWord/> (mono uppercase tracking-[0.28em]; LIVE/AWAITING in --vex-accent-text, IDLE in --vex-text-3) + existing v{__VEX_APP_VERSION__} stamp + <BookToggle/> icon button.

SPINE — new <TimelineSpine/> rendered inside SessionTranscript's scroll container (SessionTranscript.tsx:281-324) as an absolutely-positioned, aria-hidden vertical hairline (left-[13px] top-0 bottom-0 w-px bg-[var(--vex-line)]) behind the rows (z-0); rows sit relative z-[1]. It is ONE element, not per-row.

NODE — extract the existing CountersignTick (TranscriptMessage.tsx:51-58) into a shared <SpineNode variant time stamp>: renders the node glyph at left-0 top-[5px] on the row's existing pl-7 wrapper, plus a gutter mono HH:MM (reusing formatClock, TranscriptMessage.tsx:37) and sequence index from the SERIAL id. variant=live swaps the glyph for the DotMatrix needle.

CONTENT — transcript rows unchanged in content; every variant (user/assistant/assistant_stopped/tool/notice/compaction/recall + new plan-brief) routes its left affordance through <SpineNode> instead of inline pl-7/CountersignTick. The working strip (StreamingBubble.tsx) hangs its live needle on the SAME spine x.

METADATA — gutter carries HH:MM + sequence; tape head carries tape-state + version. SessionRuntimeBar moves OFF the inline header and INTO the BOOK panel (expanded runtime view), leaving the tape head clean.

PLAN BRIEF — SessionPlanCard becomes an inline tape entry variant (plan-brief) rendered in transcript flow with a SpineNode, the recessed --vex-surface-down well, and inline Accept/Resume actions (existing ACTION_KEY, SessionPlanCard.tsx:25-26).

SECONDARY ACTIONS — BOOK toggle (header), Accept/Resume (inline), all quiet hairline keys.

RESPONSIVE/RESIZABLE — BOOK is fixed w-[380px] and only mounts on demand; the canvas column stays max-w-[860px] centered (justify-center, SessionPanel.tsx:97) so opening BOOK shifts the centered column left without resizing the tape's internal grid. Rail collapse (w-[72px]) is unchanged. No layout/layoutId (MOTION-POLICY) — BOOK uses transform translateX, not width animation.

**Electron notes.** Native OS frame stays (AppShell.tsx comment lines 18-20 — S0 decision): NO -webkit-app-region drag strip is mounted; the promoted DESK RULE / tape head is NOT a custom title bar and must not add any drag region, since adding -webkit-app-region:drag would also need CSP-safe styling and would conflict with the native frame. The BOOK toggle and inline actions are pointer/keyboard interactive (no-drag is moot without a drag region). Privilege: every datum in this area is read via window.vex.* through the existing TanStack Query hooks (useSession, usePendingApprovals, useSessionPlan, the SessionRuntimeBar usage/context/compaction hooks) — the renderer stays untrusted and imports nothing from src/vex-agent. BOOK panel content reuses those same hooks; it introduces NO new IPC channel (position/runtime/memory/ledger already have hooks, and MemoryPanel already exists as a view). The sequence index + HH:MM come from the SERIAL id and createdAt already on every TranscriptEntry — no schema/IPC/preload change. OS differences: scrollbars are already themed per [data-vex-shell] (globals.css:291-319); no per-OS branching needed for this area.

**Implementation.** Files + concrete changes:

1) Extract the spine node primitive. Promote CountersignTick (TranscriptMessage.tsx:51-58) into a new SpineNode.tsx exporting <SpineNode variant="mark"|"hollow"|"live" stamp={hhmm} seq={n}/>. Resting glyph reuses the existing footprint: <span aria-hidden className="absolute left-0 top-[5px] h-4 w-0.5 bg-[var(--vex-accent)]"/> for assistant marks; "hollow" uses bg-transparent + a 1px --vex-line-strong border box for user/notice; "live" renders the DotMatrix needle. Gutter stamp: <span className="absolute left-0 -top-px font-mono text-[10px] uppercase tracking-[0.14em] tabular-nums text-[var(--vex-text-3)]">{stamp}</span> when room allows (else the HH:MM lives in the caption as today). Replace every inline `relative pl-7` + <CountersignTick/> at TranscriptMessage.tsx:107, 119, 150 and StreamingBubble.tsx:174 with the row wrapper className `relative z-[1] pl-7` + <SpineNode .../>. BLUE RATIONING: only variant="live" paints --vex-accent; "mark"/"hollow" at rest must be --vex-line-strong, NOT accent — change the resting tick fill from bg-[var(--vex-accent)] to bg-[var(--vex-line-strong)] so resting nodes are hairline, reserving blue for live/pending per Law 2 (this is a deliberate departure from today's always-accent tick; the LIVE node + bloom carry the blue instead).

2) Draw the spine. In SessionTranscript.tsx return (line 281), wrap the scroll content so a single <span aria-hidden className="pointer-events-none absolute left-[13px] top-0 bottom-0 w-px bg-[var(--vex-line)]"/> sits behind the rows; make the row-list container `relative`. Keep gap-3/py-4 (SessionTranscript.tsx:287). Do NOT animate the spine.

3) Promote the tape head. In AppShell.tsx header (48-56): justify-end -> justify-between; add a left register slot. Move the session-title + Stamp block out of SessionContext.tsx:60-79 into the header (pass activeSession down, or render a <TapeHead/> that subscribes to useSession via activeSessionId from uiStore). Reposition the accent tick to the spine x. Right slot: <TapeStateWord state={'idle'|'live'|'awaiting'}/> (derive from the same pending-approval + stream-preview signals SessionTranscript already computes — hasPendingApproval at SessionTranscript.tsx:149 and preview phase) + v{__VEX_APP_VERSION__} + <BookToggle open={bookOpen} onToggle={...}/>. SessionContext's loading/error/not-found lines (30-58) stay but render at the tape head height (h-12 not h-9).

4) BOOK panel. New BookPanel.tsx as the 3rd flex child of <main>. State in uiStore.ts: add `readonly bookOpen: boolean` + `readonly bookView: 'runtime'|'memory'|'ledger'|'position'` + setters, NOT persisted (extend partialize to keep it launch-ephemeral like activeSessionId/appShellView). Mount conditionally: `{bookOpen ? <BookPanel view={bookView}/> : null}`. Class: `flex w-[380px] shrink-0 flex-col border-l border-[var(--vex-line)] bg-[var(--vex-surface-1)]`. Slide-in via a one-shot transform class (see motion_specs) — NEVER width animation (MOTION-POLICY: no layout). Content reuses SessionRuntimeBar (moved here), MemoryPanel sections, and the act-ledger; each section self-gates and shows a boxless mono empty line when unavailable.

5) PLAN BRIEF inline. Remove SessionPlanCard from SessionPanel.tsx:112-117. Add a `plan-brief` variant to transcriptRowModel.ts TranscriptRowVariant union (line 21) and render it in TranscriptMessage.tsx switch as an inline tape entry: SpineNode + a recessed well (reuse SessionPlanCard.tsx:84 classes: max-h-72 overflow-auto rounded-[6px] border border-[var(--vex-line)] bg-[var(--vex-surface-down)] px-3 py-2 + MarkdownContent) + inline Accept/Resume using the existing ACTION_KEY string (SessionPlanCard.tsx:25-26). Keep useSessionPlan/useAcceptPlan/useRequestResume wiring; this is presentation relocation, not new domain logic. (Trade-off: the plan now lives in transcript flow keyed off plan state rather than as a sticky card — confirm with engine owner that the plan should scroll with history vs pin; if it must pin, render it as a sticky tape entry at the bottom anchor instead. This is a UX-semantics question worth flagging.)

6) Keyframe. Add @keyframes vex-signal-resolve to globals.css (build-time, CSP-safe like vex-entry-settle at globals.css:325) ramping --dmx-bloom-level 0->1->0; the existing 01-base.css drop-shadow (lines 81-100) auto-tints it via max(--dmx-bloom-level,--dmx-halo-level). Add a reduced-motion override (globals.css:441 block already collapses iteration/duration; add an explicit `.vex-signal-resolve { animation: none }` with a static lit needle so the bloom never plays under reduce).

7) Guard. Extend shell-design-guard.test.ts BANNED (line 69) with the retired indigo/violet hexes (#6366f1, #8b5cf6) and the legacy navy (#0a0e27/#161b3f/#1f2552), plus bg-secondary and Card shadow-sm per Law 9; add a plan-mode-in-title/row/creator guard test (Law: PLAN MODE) asserting getSessionTitle + SessionRow + SessionCreator carry no plan field. Replace the raw #f0a0a0 at SessionRuntimeBar.tsx:325 with text-[var(--vex-warn-text)].

Verification: `pnpm exec vitest run vex-app/src/renderer/features/appShell/__tests__/shell-design-guard.test.ts` plus any transcript-row tests; `pnpm --dir vex-app lint` (tsc --noEmit) for the new uiStore fields + the plan-brief variant exhaustive switch (TranscriptMessage.tsx:180 assertNever must still compile).

**Motion specs.**

| Name | Trigger | Technique | Duration/easing | Reduced-motion |
| --- | --- | --- | --- | --- |
| Needle bloom-and-resolve (SIGNATURE MOTION) | reasoning-end / answer-start on the live streaming node | Build-time @keyframes vex-signal-resolve in globals.css ramps --dmx-bloom-level 0->1->0 on the live DotMatrix node; the existing 01-base.css .dmx-bloom drop-shadow (globals/01-base.css:81-100) reads max(--dmx-bloom-level,--dmx-halo-level) and auto-tints the bloom. Applied via a one-shot class toggled in React (animationend clears it) — NO inline style/cssText, NO Motion layout. Synced to a Geist Mono -> Google Sans switch on the answer block (className swap, --font-mono -> --font-sans). | ~420ms ease-out, one-shot (both) | globals.css:441 collapses iteration/duration; add .vex-signal-resolve{animation:none} so the node is a STATIC lit needle and the answer reveals instantly in Google Sans (no bloom, no type-morph). |
| Trust-freeze (pending approval) | hasPendingApproval becomes true (SessionTranscript.tsx:149) | Extend the existing animated={!awaitingApproval} gate (StreamingBubble.tsx:203/210) shell-wide: the live SpineNode receives animated={!awaitingApproval}, freezing the DotMatrix needle. No new animation — motion is REMOVED. Tape-state word -> AWAITING in --vex-accent-text (static, no pulse, no fill). | instant (state-driven freeze) | Identical — already frozen; nothing to collapse. |
| Commit LOCK stamp | approval signed / decision committed at a node | Reuse existing one-shot .vex-stamp-press (globals.css:179-192, 180ms ease-out both) on the resolved SpineNode, re-read as a LOCK stamp (icon swap to a lock glyph). Stylesheet @keyframes, CSP-safe. | 180ms ease-out (both) | globals.css:441 collapses to the final frame (lock present, no press). |
| Tape entry settle | a live-appended transcript row (id outside the settled set, SessionTranscript.tsx:312) | Reuse existing .vex-entry-settle (globals.css:325-338, 180ms) on the row wrapper — UNCHANGED by this redesign; the spine + node are inside the settling row so they print together. | 180ms ease-out (both) | globals.css:441 collapses to the final frame. |
| BOOK panel slide-in | bookOpen toggles true | One-shot build-time @keyframes (translateX(8px)+opacity 0 -> none) on the BookPanel root via a class, reusing the cubic-bezier(0.22,1,0.36,1) easing already in .vex-sign-stroke (globals.css:356). Transform-only (NO width/layout animation, NO Motion layoutId) so it is GPU-cheap and MOTION-POLICY-safe. The panel mounts/unmounts; no resting animation. | ~240ms cubic-bezier(0.22,1,0.36,1) (both) | globals.css:441 collapses duration to 0.01ms -> instant mount, no slide. |
| Reasoning-tail dissolve | reasoning tail overflow while thinking (StreamingBubble.tsx:127) | Reuse the ONE sanctioned dissolve: .vex-fade-top mask (globals.css:342-344) — a mask, not a painted gradient, on the masked 46px window. UNCHANGED; it stays the only holographic-dissolve and never touches chrome or the spine. | static mask (no timed animation) | No motion to reduce — it is a static mask. |

**Polish pass.**

_More premium:_

- Align the DESK RULE accent tick, the spine hairline, the gutter HH:MM column, and the composer's terminal node to a SINGLE x-coordinate (left-[13px] / the 28px gutter center) so the eye reads one continuous instrument axis from header to composer — pixel-true vertical alignment is what makes it feel like a precision tape, not a chat log.
- Use tabular-nums Geist Mono for EVERY gutter stamp (HH:MM + sequence index) so digits never jitter as rows scroll — borrow the exact recipe already proven at AssistantCaption (TranscriptMessage.tsx:67): text-[10px] uppercase tracking-[0.14em] tabular-nums.
- Make the live node the ONLY blue on screen at rest-of-stream — resting nodes are --vex-line-strong hairline, the tape-state word is --vex-text-3 when idle — so when the needle blooms blue it reads as a genuine signal event, not ambient decoration (Law 2 BLUE RATIONING is the premium tell).

_Cut clutter:_

- Delete the inline SessionRuntimeBar from the tape head and move its model/usage/context/compaction chips into the BOOK panel (runtime view) — the header becomes title + tape-state + version only, removing 4 always-on chips from the always-visible chrome.
- Collapse the repeated per-row pl-7 + CountersignTick (4 inline copies across TranscriptMessage.tsx + StreamingBubble.tsx) into ONE shared SpineNode + ONE drawn spine — fewer painted elements, one source of truth for the gutter, and the row reads as content hanging off an axis instead of each row re-declaring its own left rail.
- Absorb the floating SessionPlanCard (a bordered --vex-surface-1 card, SessionPlanCard.tsx:54) into an inline PLAN BRIEF tape entry so the column has ONE document flow rather than a card interrupting the tape — one less floating container competing with the transcript.

_Generic traps to avoid:_

- Resting blue everywhere: keeping the always-accent CountersignTick fill (bg-[var(--vex-accent)]) on every node would make the spine a decorative blue ladder — generic SaaS 'accent the timeline' look. Resting nodes MUST be --vex-line-strong; blue is earned only by the live node, focus ring, and the one primary CTA.
- A permanent third column: docking the BOOK panel open by default (or as flex-1) turns the instrument into a generic 3-pane admin dashboard. It MUST be on-demand, fixed-width, transform-slid, and closeable — approvals dock INLINE in the tape, not in a side panel.
- Ambient motion: a softly pulsing spine, a shimmering header, or a resting glow on nodes would read as a generic 'alive' AI template. Motion is bound to in-flight engine work ONLY (the needle), frozen on idle and on pending-approval; the spine, header, and BOOK chrome are dead-still.

**Files touched:** `vex-app/src/renderer/features/appShell/AppShell.tsx`, `vex-app/src/renderer/features/appShell/SessionPanel.tsx`, `vex-app/src/renderer/features/appShell/SessionContext.tsx`, `vex-app/src/renderer/features/appShell/TranscriptMessage.tsx`, `vex-app/src/renderer/features/appShell/SessionTranscript.tsx`, `vex-app/src/renderer/features/appShell/StreamingBubble.tsx`, `vex-app/src/renderer/features/appShell/SessionPlanCard.tsx`, `vex-app/src/renderer/features/appShell/transcriptRowModel.ts`, `vex-app/src/renderer/features/appShell/SpineNode.tsx (new)`, `vex-app/src/renderer/features/appShell/BookPanel.tsx (new)`, `vex-app/src/renderer/features/appShell/SessionRuntimeBar.tsx`, `vex-app/src/renderer/stores/uiStore.ts`, `vex-app/src/renderer/styles/globals.css`, `vex-app/src/renderer/features/appShell/__tests__/shell-design-guard.test.ts`


---

## Section 4 — Sidebar · sessions rail

> _Recon area: Sidebar / sessions rail — the upstream node of the Signal Tape spine (SessionsList aside, SessionRow live indicator + gutter tick, PinToggle gold tokenization, group rails, footer ledger line)_

**Intent.** The sessions rail is the upstream end of the one spine. It is a thin, quiet registry of every conversation/mission, hairline-separated, that hangs each row off a shared left gutter tick so the rail visually rhymes with the transcript's CountersignTick gutter and the composer anchor below. Its job is navigation + at-a-glance liveness: which session is selected, which is actively running engine work right now (the ONLY animated thing in the rail), which is pinned, and the local-runtime ledger line at the bottom. It must read as instrument chrome — loud content lives in the transcript, the rail stays still and legible. This redesign unifies the two divergent live indicators (the collapsed `bg-success` status dot and the open animated blue `DotmSquare3`) into ONE canonical signal dot sitting on the gutter tick, tokenizes the raw gold pin, and keeps the tabular-nums timestamps + the deterministic fit-to-height packer untouched.

**UX structure.** Placement: leftmost flex child of AppShell `<main>`, a fixed-width `aside` (open w-[296px] / collapsed w-[72px]) with `border-r border-[var(--vex-line)]` on `--vex-surface-1`. Top-to-bottom it reads as one continuous ledger: 48px header (logo + VEX wordmark + collapse toggle), the signing-key New button on its plinth hairline, the mode-filter tablist (open only), the scrollable grouped list, the Browse-all CTA, then the footer ledger (Memory, Settings, RuntimeLedger line). Interaction model: a row is a single select button with a SIBLING action cluster (trash + pin) revealed on hover/focus-within — never nested buttons. Clicking a row sets activeSessionId and returns the panel to session view. Keyboard model: Tab walks header toggle → New key → tablist tabs → each row select → (on focus-within) trash → pin → Browse-all → footer items; focus ring is the rationed accent (`focus-visible:ring-2 ring-[var(--vex-accent)]`) on every control, unchanged. What animates vs stays still: the ONLY resting-animated element in the entire rail is the unified signal dot on an actively-running session's gutter tick (blue pulse, provably bound to `missionStatus === "running"`); plus the New-key signing stroke while a create mutation is in flight. Everything else — selection bar, pin flag, group rails, runtime dot, timestamps — is dead still. A pending approval anywhere freezes the rail's signal pulse (TRUST = STILLNESS) by routing the dot's `animated` through the shell-wide `!awaitingApproval` gate.

**States.**

- idle (rest): hairline rows, no motion, no blue fills; selected row carries a 2px accent gutter bar + one-step surface lift bg-white/[0.03]
- loading: SessionsLoadingPlaceholder — DotmSquare3 accent mark + 'Loading sessions' label (open) / centered mark (collapsed); list region only
- empty (no sessions in filter): SessionsEmptyPlaceholder — Archive02Icon + 'No sessions'; footer + Browse-all hidden (totalRows === 0)
- error (query.ok === false): SessionsErrorPlaceholder — StopCircleIcon + error.message in text-destructive; retry happens via TanStack Query refetch, no rail-local retry control
- live/active (missionStatus running): unified signal dot on the gutter tick goes solid --vex-accent + pulse; 'live' Stamp in the subtitle row stays as the textual echo
- paused (paused_approval | paused_wake | paused_error): signal dot is a STILL filled --vex-warn-text node (frozen, not pulsing); 'paused' Stamp shown
- stopped/terminal (completed|failed|stopped|cancelled): hollow idle ring dot, NO stamp — terminal sessions earn silence
- pinned: gutter tick + dot tinted --vex-pin (hollow ring unless also live); PinToggle stays visible (pinned rows do not hide the star)
- pin mutation in flight (pinPending on this row): PinToggle cursor-wait + opacity-60, disabled; other rows unaffected (per-row via pendingPinId)
- awaiting-approval (shell-wide): ALL signal-dot pulses freeze to static lit/filled nodes — the rail obeys the global animated={!awaitingApproval} gate
- collapsed rail (w-72): rows are icon-only; the unified signal dot sits at the top-right of the mode glyph (replacing the old border-black/60 status dot); header wordmark + tablist + labels hidden
- offline-degraded (runtime): footer RuntimeLedger line shows warn/destructive dot + 'Local runtime unavailable/degraded' — flat dot, no glow (unchanged)
- delete confirm: SessionDeleteDialog owns blocked outcomes (blocked_active_mission | blocked_pending_approval | state_changed); rail row stays put until removed

**Design tokens.** Surfaces: rail bg `--vex-surface-1` (#090e1d); New-key recessed slot `--vex-surface-0` (#04060f); hover lift `bg-white/[0.035]`, selected lift `bg-white/[0.03]`. Hairlines: `--vex-line` (6%) for every separator (header border-b, row border-b on each <li>, group gap, footer borders), `--vex-line-strong` (10%) on the New-key border. Text trio: titles `text-foreground`(=--vex-text), metadata/subtitles + timestamps `--vex-text-2`, group headers + idle glyphs + placeholders `--vex-text-3`. Accent (RATIONED — live node, focus ring, selection bar, primary New CTA only): `--vex-accent` (#3275f8) for selection bar / live dot fill / focus ring; `--vex-accent-text` for selected glyph + 'live' Stamp text; `--vex-accent-border`/`-border-strong` + `-fill-8` for the New-key hover/active; `--vex-accent-fill-8` plinth tick uses `color-mix(in oklab,var(--vex-accent) 60%,transparent)` (existing). NEW semantic tokens (add to [data-vex-shell] in globals.css): `--vex-pin` (warm flag, replaces raw #ffd35c) and `--vex-warn-text` (replaces raw #f0a0a0). Status mapping for the unified dot: live=`--vex-accent`, paused=`--vex-warn-text`, pinned-idle=`--vex-pin`, stopped/idle=hollow ring on `--vex-line-strong`. Radii: New-key `rounded-lg` (--radius-lg .75rem), PinToggle/icon buttons `rounded-md` (--radius-md .5rem), Stamp `rounded-[3px]`. Fonts: VEX wordmark, group headers, tablist, timestamps, Stamps, runtime label = Geist Mono (--font-mono) uppercase 10–11px tracking 0.14–0.3em tabular-nums; titles/subtitles = Google Sans (--font-sans). Motion: signal pulse uses the existing `--dmx-bloom-level` bloom channel (drop-shadow auto-tinted) — durations 1500ms base cycle (--dmx-cycle) for the running pulse, 240ms transitions for color/selection; one-shot resolve via new `vex-signal-resolve` ~520ms. NO shadows, NO gradients-as-fill, NO glass.

**Component spec.** Container: `aside[data-vex-area="sessions-sidebar"]` unchanged width/transition. NEW shared gutter: the rail gains a thin upstream gutter column so rows hang off ONE axis like the transcript. Reuse the existing selection-bar slot (SessionRow.tsx:83-88, `absolute inset-y-2 left-0 w-0.5`) as the gutter's left edge; the unified signal dot is centered on that edge. Header: logo_clean.png + mono VEX wordmark + SidebarIconButton collapse toggle (unchanged). New button: the `vex-sign-key` plinth/stroke/glint stays verbatim (it is the single primary CTA, sanctioned accent). Tablist: mode filters unchanged, active tab keeps the 2px `--vex-accent` underline. List: SessionGroups → group `<section>` with mono `<h2>` rail header (open only) → `<ol>` of SessionRow `<li>` hairline-separated. UNIFIED SIGNAL DOT (the core change): replace BOTH the collapsed `activity.dotClass` corner dot (SessionRow.tsx:111-119) AND the open animated `DotmSquare3` (SessionRow.tsx:128-140) with one `<SignalDot>` primitive rendered on the gutter tick. Shape: a `relative h-2 w-2 rounded-full` node. Variants by `getMissionActivity(row).tone` + pinned + selected: active → `bg-[var(--vex-accent)]` + pulse (animated only when running AND !awaitingApproval); paused → `bg-[var(--vex-warn-text)]` still; pinned-idle → ring `border border-[var(--vex-pin)]` hollow; stopped/none → hollow `border border-[var(--vex-line-strong)]`. In the OPEN row, when active, the dot replaces the timestamp's place (keep showing `startedLabel` tabular-nums for all non-active rows — the timestamp stays, contract requirement). The textual Stamps ('live'/'paused'/'restricted') remain as the metadata echo. Collapsed row: the SignalDot sits at the glyph's top-right corner (same `absolute -right-0.5 -top-0.5` slot) but now driven by the same primitive, not `dotClass`. PinToggle: identical structure, gold tokenized to `--vex-pin`. Footer: Memory/Settings/RuntimeLedger unchanged; runtime dot stays flat. Responsive/resizable: the ResizeObserver → containerHeight → `computeVisibleGroups` packer is untouched (SIDEBAR_ROW_HEIGHT_PX 56 must stay in lockstep); collapse toggle drives `w-[296px]`↔`w-[72px]` via the existing `transition-[width] duration-200`.

**Electron notes.** Native OS frame only — NO custom title-bar drag region anywhere in the rail (the header is a normal flex bar, not -webkit-app-region). The rail is untrusted renderer UI: all data flows through TanStack Query hooks that call window.vex.* — `useSessionsList`, `useSetSessionPinned`, `useDeleteSession`, `useSystemHealth`. No direct IPC, no Node/Electron API, no DB/Docker/wallet access from this component. The runtime health that drives the footer ledger dot comes from `useSystemHealth()` (window.vex.* health probe) — display-only, no privileged action. No preload changes required: `id` (serial PK) and `createdAt`/`startedAt` ISO already exist on every SessionListItem (schemas/sessions.ts), so the gutter/timeline rhyme needs zero schema or IPC work. OS differences: none specific to the rail; reduced-motion is honored via the global prefers-reduced-motion rule, not OS-conditional code.

**Implementation.** 1) ADD TOKENS (globals.css, inside `[data-vex-shell="true"]` block ~line 268): `--vex-pin: #ffd35c;` and `--vex-warn-text: #f0a0a0;` (move the raw hexes here once; everything else references the var). 2) ADD KEYFRAME (globals.css, near vex-stamp-press): a CSP-safe stylesheet keyframe driving the bloom channel for the running pulse — `@keyframes vex-signal-pulse { 0%,100% { --dmx-bloom-level: 0 } 50% { --dmx-bloom-level: 1 } }` wired as `.vex-signal-pulse { animation: vex-signal-pulse var(--dmx-cycle,1500ms) ease-in-out infinite }` so the existing 01-base.css drop-shadow (reads max(--dmx-bloom-level,--dmx-halo-level)) auto-tints it; AND the one-shot resolve `@keyframes vex-signal-resolve { 0%{--dmx-bloom-level:0} 35%{--dmx-bloom-level:1} 100%{--dmx-bloom-level:0} }` / `.vex-signal-resolve{animation:vex-signal-resolve 520ms ease-out both}`. Note: `--dmx-bloom-level` is a registered custom prop via the dotmatrix CSS (animatable); for a plain dot, instead drive `box-shadow` is BANNED (resting glow) — so the pulse must instead be an opacity+scale breath: use `@keyframes vex-signal-pulse { 0%,100%{opacity:.55;transform:scale(.85)} 50%{opacity:1;transform:scale(1)} }` to stay inside the no-glow depth law. Reduced-motion: the global 0.01ms rule collapses both; add an explicit `@media (prefers-reduced-motion:reduce){ .vex-signal-pulse{animation:none;opacity:1;transform:none} }` so the live dot rests STATIC-LIT (not invisible). 3) NEW PRIMITIVE `SessionRows/SignalDot.tsx`: pure presentational, props `{ tone: "active"|"paused"|"stopped"|null; pinned: boolean; animated: boolean }`. JSX: `<span aria-hidden className={cn("block h-2 w-2 rounded-full", tone==="active" ? "bg-[var(--vex-accent)]" : tone==="paused" ? "bg-[var(--vex-warn-text)]" : pinned ? "border border-[var(--vex-pin)]" : "border border-[var(--vex-line-strong)]", tone==="active" && animated && "vex-signal-pulse")} />`. 4) SessionRow.tsx: thread `awaitingApproval` (read from the shell approval gate the transcript already uses) down to SignalDot's `animated`. REPLACE the collapsed corner dot (lines 111-119) with `<SignalDot tone={activity?.tone ?? null} pinned={isPinned} animated={!awaitingApproval} />` in the same `absolute -right-0.5 -top-0.5` slot. REPLACE the open active/timestamp branch (lines 128-140): render the SignalDot on the gutter (move it next to the selection bar at the left edge so it sits ON the spine, mirroring CountersignTick's `left-0` mark) and keep `<span className="shrink-0 font-mono text-[10px] tabular-nums text-[var(--vex-text-2)]">{startedLabel}</span>` ALWAYS visible (do not swap it out for active — the timestamp stays per contract; the dot carries liveness). Drop the `DotmSquare3` import from SessionRow.tsx. 5) PinToggle.tsx line 36: swap raw hex → `"border-[color-mix(in_oklab,var(--vex-pin)_40%,transparent)] bg-[color-mix(in_oklab,var(--vex-pin)_10%,transparent)] text-[var(--vex-pin)] hover:bg-[color-mix(in_oklab,var(--vex-pin)_16%,transparent)]"`. 6) SessionRuntimeBar.tsx line 324: `text-[#f0a0a0]` → `text-[var(--vex-warn-text)]`. 7) GUARD: extend shell-design-guard.test.ts BANNED with `{ name:"raw pin/warn hex", regex:/#(?:ffd35c|f0a0a0)/i }` (after the tokens land, the only allowed occurrence is the token definition in globals.css, which is outside the appShell scan scope). 8) Group rails (optional polish, DOT-MATRIX POLICY): the mono `<h2>` group header may carry a single ≤6–8% accent-tint dot separator — implement as a `<span className="h-1 w-1 rounded-full bg-[color-mix(in_oklab,var(--vex-accent)_8%,transparent)]" />`, never a pattern fill. Keep computeVisibleGroups + SIDEBAR_ROW_HEIGHT_PX=56 unchanged (if the header gains a dot it must not change the 32px header height the packer assumes).

**Motion specs.**

| Name | Trigger | Technique | Duration/easing | Reduced-motion |
| --- | --- | --- | --- | --- |
| Live signal pulse (running session) | getMissionActivity(row).tone === "active" (missionStatus === "running") AND NOT awaiting approval | Stylesheet @keyframes vex-signal-pulse (opacity .55↔1 + scale .85↔1, NO box-shadow/glow per depth law) on the SignalDot; class toggled by React, never inline style/cssText — CSP style-src 'self' safe. Provably bound to in-flight engine work via missionStatus; the only resting-animated element in the rail. | --dmx-cycle (1500ms) ease-in-out infinite | Explicit @media (prefers-reduced-motion:reduce) sets animation:none; opacity:1; transform:none → a STATIC-LIT --vex-accent dot still reads 'live' (not invisible). |
| Pulse freeze on pending approval (TRUST = STILLNESS) | Shell-wide awaitingApproval becomes true | SignalDot receives animated={!awaitingApproval}; when false the .vex-signal-pulse class is not applied, so the dot rests as a static filled --vex-accent node. Pure conditional className, reuses the existing shell-wide animated gate — no new mechanism. | Instant (class removed; React re-render) | N/A — already static; identical outcome. |
| Selection / hover surface transition | Row becomes selected (activeSessionId) or hovered | Tailwind transition-colors on the row container + bg-white/[0.03] lift and the 2px --vex-accent gutter bar appearing. Color/opacity only, GPU-cheap, CSP-safe. | 240ms (transition-colors default) ease | Color transition is sub-perceptual; global 0.01ms rule collapses it harmlessly. |
| Signal resolve flash (mission reaches running / answer-start echo, optional) | One-shot when a row's tone transitions into "active" (mount of the active state) | Stylesheet @keyframes vex-signal-resolve ramping the SignalDot opacity/scale once (build-time keyframe, class applied via onAnimationEnd cleanup like vex-intro-glint). One-shot, rests still. | 520ms ease-out both | Global rule collapses to final frame (lit, still); no flash. |
| Pin toggle press | User clicks PinToggle | transition-colors on the border/bg/text --vex-pin tints; optional one-shot reuse of existing .vex-stamp-press on the star icon if a confirm beat is wanted. CSP-safe stylesheet animation. | 150ms transition-colors ease (or 180ms vex-stamp-press) | Collapses to final frame via global rule. |
| Rail collapse/expand width | Collapse toggle click | Existing Tailwind transition-[width] duration-200 on the aside; pure width animation, no layout/layoutId (MOTION-POLICY safe). | 200ms ease | Collapses to instant via global 0.01ms rule; final width still correct. |

**Polish pass.**

_More premium:_

- Unify the live indicator onto the gutter tick so the rail, the transcript CountersignTick, and the composer all share one visible left axis — the rail stops looking like a stock sidebar and starts reading as the upstream node of one instrument spine.
- Keep the tabular-nums Geist Mono timestamp on EVERY row including active ones (let the dot carry liveness, not a swapped-in widget) — consistent monospace numerics column-align down the rail and feel like a registry/ledger, not a chat list.
- Make terminal sessions earn silence: hollow ring dot, no stamp, no color — the contrast between a quiet dead row and a single pulsing blue node is what makes the one live session feel important.

_Cut clutter:_

- Delete the DotmSquare3 active widget from the row entirely — one 8px dot replaces a 12px animated matrix, removing visual noise and a second divergent liveness language.
- Drop the redundant mode/permission badge clutter that already deviated from silence-by-default; keep only the single mode glyph + exception Stamps when state deviates (restricted/live/paused).
- Tokenize the gold pin (and warn text) so there is exactly ONE warm-flag value in the system — no hand-tuned #ffd35c/40, /10, /16 opacity stack scattered in a className; replace with color-mix on --vex-pin so the flag reads as one deliberate semantic, not decoration.

_Generic traps to avoid:_

- Painting resting blue fills as decoration (blue chips, blue hover backgrounds, a permanently-glowing 'active' badge) — blue is RATIONED to the live node, selection bar, focus ring, and the single New CTA; anything else makes it look like a generic SaaS sidebar.
- Adding a resting glow/box-shadow under the live dot or a card shadow under rows — the depth law is solid luminance steps + hairlines only; a glow instantly reads template-grade and trips shell-design-guard.
- Keeping two competing live indicators (a green status dot AND a blue animated square) or animating something not bound to real engine work — ambient motion is the #1 tell of a generic AI-template; the pulse must be provably bound to missionStatus==='running' and freeze on pending approval.

**Files touched:** `/mnt/x/Vex/vex-app/src/renderer/styles/globals.css`, `/mnt/x/Vex/vex-app/src/renderer/features/appShell/SessionRows/SignalDot.tsx`, `/mnt/x/Vex/vex-app/src/renderer/features/appShell/SessionRows/SessionRow.tsx`, `/mnt/x/Vex/vex-app/src/renderer/features/appShell/SessionRows/PinToggle.tsx`, `/mnt/x/Vex/vex-app/src/renderer/features/appShell/SessionRuntimeBar.tsx`, `/mnt/x/Vex/vex-app/src/renderer/features/appShell/SessionRows.tsx`, `/mnt/x/Vex/vex-app/src/renderer/features/appShell/__tests__/shell-design-guard.test.ts`


---

## Section 5 — Transcript · message variants & PLAN BRIEF entry

> **Build status:** 🟡 Tape time-stamps shipped — every entry leads with its
> HH:MM as the instrument readout (time = `--vex-text-2` data, speaker =
> `--vex-text-3` chrome): a left clock column on the assistant rail, a right one
> on the user rail. **Deferred:** a literal vertical in-gutter stamp (needs a
> wider gutter than the current 28px) and a per-entry **sequence index** (an
> honest per-session ordinal is unreliable under backward pagination — the row
> `id` is a global serial, not a 1-based count). Remaining: PLAN BRIEF entry.
>
> _Recon area: Transcript, message variants & PLAN BRIEF entry — the Signal Tape body_

**Intent.** This is the scrolling body of the agent workspace: the chronological record of one session as a single continuous SIGNAL TAPE. Every turn — user prompt, Vex answer, stopped answer, tool act, tool-group aggregation, runtime/error notice, compaction marker, memory recall, and (new) the inline PLAN BRIEF — hangs off ONE monotonic time/sequence spine on the left. It is where trust is earned: at rest the tape is a monotone instrument readout (hairlines + the text trio), and the single electric-blue accent is rationed to exactly one thing at a time — the live/streaming node, a pending signature, or the focused node. The redesign converts today's seven loosely-styled variants into one register hanging off a shared 28px gutter, absorbs the floating SessionPlanCard into a PLAN BRIEF tape entry so the plan reads as part of the record (not a card above it), retires the off-brand WelcomeBanner Card-shadow empty state in favour of SessionWelcomeHero, and introduces opt-in virtualization for long sessions using the already-installed @tanstack/react-virtual.

**UX structure.** Placement: the transcript is the scrolling middle child of SessionPanel — between SessionWelcomeHero (register head) and the composer (bottom anchor of the same axis). It owns its own overflow-y-auto viewport (SessionTranscript.tsx:281-288). Interaction model is read-mostly, bottom-anchored: jump-to-newest on session change, follow-on-arrival only while pinned within PINNED_THRESHOLD_PX (48px), load-older on scrolling within LOAD_OLDER_THRESHOLD_PX (64px) with scrollHeight-delta restoration — all existing and UNCHANGED. The visual change is the SPINE: a single ~28px gutter column runs the full left edge of the list; today's per-row pl-7 + absolutely-positioned CountersignTick (TranscriptMessage.tsx:51-58, 107) becomes a uniform GUTTER NODE rendered for EVERY variant, not just assistant rows. Each node carries: (1) a node glyph (resting = 1px hairline tick or 2px dot in --vex-line-strong; live = the animated DotMatrix mark; pending = a static lit --vex-accent tick); (2) a mono tabular-nums HH:MM stamp from createdAt; (3) a sequence index derived from id position. Keyboard model: the viewport is a focusable scroll region (tab-reachable); within it, the only interactive descendants are existing — ToolActRow/ToolGroupRow disclosures, code-block copy keys, markdown links, and the new PLAN BRIEF Accept/Resume keys — each with the existing focus-visible:ring-2 ring-[var(--vex-accent)] treatment (this focus ring is one of the four sanctioned blue uses, Law 2). What animates vs stays still: at rest NOTHING animates — the resting axis is monotone hairline. The ONLY resting-animated element is the live node's DotMatrix mark on the streaming preview (already gated animated={!awaitingApproval}, StreamingBubble.tsx:201-211). A newly-settled live row plays exactly one vex-entry-settle (SessionTranscript.tsx:312); a committed answer fires exactly one needle bloom-and-resolve (new). Everything else is a hard cut.

**States.**

- idle/resting: monotone tape — every node a hairline tick/dot in --vex-line-strong, mono HH:MM + sequence index in --vex-text-3; zero blue, zero motion.
- loading (initial page): centered DotmHex3 size=28 dotSize=4 color=var(--vex-accent) (unchanged, SessionTranscript.tsx:226-241) — the one place blue/motion is allowed because it is bound to in-flight fetch.
- loading-older (prepend): centered DotmHex3 size=18 dotSize=3 at the top of the list (unchanged, :289-293); viewport held via scrollHeight delta.
- empty (zero entries, no preview): NO Card. SessionWelcomeHero renders the register head; the transcript shows its current centered 'Start the conversation' line (:267-278) OR, for the FIRST-ever session (zero sessions), SessionWelcomeHero replaces the retired WelcomeBanner — same hallmark→overline→plinth→H1→subline, single primary CTA only.
- streaming (live turn): StreamingBubble is the live node — DotMatrix mark animated in the 28px gutter, mono status word (Working/Thinking/Calling/Writing) + ElapsedCounter; this is the ONLY resting-animated node.
- success/commit (answer lands): the live node fires ONE vex-signal-resolve bloom; the answer block switches Geist Mono → Google Sans; the row settles via vex-entry-settle; node returns to a resting hairline tick.
- assistant_stopped: existing 'Stopped' line under the answer (TranscriptMessage.tsx:113-128); node is a resting hairline tick, NO bloom (it did not resolve).
- pending-decision / awaiting-approval: TRUST=STILLNESS — all motion freezes (animated={!awaitingApproval} shell-wide); the matching tool-act node lights a STATIC --vex-accent tick + the existing 'Awaiting signature' stamp on its ToolActRow (pendingApprovals map, TranscriptMessage.tsx:160-162); the inline approval docks at point-of-cause (Law 10).
- validation-error (PLAN BRIEF accept): server refusal snaps back via invalidate (no optimistic write) — existing useAcceptPlan behaviour; the 'Pending your acceptance' label stays, button re-enables.
- notice/runtime: centered mono uppercase line, neutral tone (TranscriptMessage.tsx:201-219).
- error notice / stream error: destructive tone is the ONE sanctioned non-blue fill (bg-destructive/10 + border, :213) — node tick in --color-destructive, NOT accent.
- compaction / recall markers: static centered hairline-rule markers (CompactionMarker / MemoryMarker) — node is a resting tick, never animated (persisted rows have no in-flight state).
- offline-degraded / older-page failure: keep loaded entries + top 'Couldn't load older messages' alert (:294-301); newest-page failure shows the transcript error state (:247-265).
- retryable vs non-retryable: load-older failure is retryable (scroll up again re-triggers fetchNextPage); a stream error preview is terminal for that turn (generic 'Stream error', no raw provider text, :245-254).

**Design tokens.** Surfaces: tape canvas = --vex-surface-0 (#04060f, inherited from [data-vex-shell]); recessed wells (code blocks, recall content, PLAN BRIEF plan body) = --vex-surface-down; the user card keeps bg-white/[0.04] (existing). Hairlines: --vex-line (6%) for resting node ticks/separators/markers; --vex-line-strong (10%) for the user card border and section rules. Text trio: --vex-text content; --vex-text-2 true metadata (the 'Vex · HH:MM' / 'You · HH:MM' captions, sequence stamps); --vex-text-3 placeholders, status words at rest, group headers. Accent (RATIONED, Law 2): --vex-accent only on the live node mark, the static pending tick, the focus ring, and the single PLAN BRIEF primary CTA; --vex-accent-text for the readable-blue 'Reasoning'/'Awaiting signature' status words and markdown links; --vex-accent-border / --vex-accent-fill-8 for the quiet Accept/Resume action key (reuse SessionPlanCard ACTION_KEY string). Semantic: --vex-pin for any flagged/pinned tape entry (replaces raw #ffd35c); --vex-warn-text for the PLAN BRIEF 'Pending your acceptance' line (replaces today's text-warning / raw #f0a0a0); --color-destructive (with /10 fill + 40%-mix border) for error notices only. Radii: --radius-sm (0.375rem / rounded-md) for the user card and action keys; --radius-lg (rounded-lg) only where the existing user card uses it; wells stay at the existing rounded-[6px]. Borders: 1px hairline only — NO shadow, NO glow, NO gradient-as-fill (Depth Law 9, guard-pinned). Motion tokens: --dmx-bloom-level (0→1→0, auto-tinted by 01-base.css drop-shadow reading max(--dmx-bloom-level,--dmx-halo-level)); durations 180ms (vex-entry-settle / vex-stamp-press) and ~520ms for the new vex-signal-resolve bloom; easing ease-out / cubic-bezier(0.22,1,0.36,1). Typography: Geist Mono (--font-mono) for ALL gutter stamps (HH:MM + sequence), status words, captions — uppercase 10-13px tracking 0.14-0.3em tabular-nums; Google Sans (--font-sans) for answer/content prose; the mono→proportional switch on the answer block IS the resolve signal (Law 5/8). NO new hexes — every value above is a contract token.

**Component spec.** Container: SessionTranscript keeps its scroll viewport (overflow-y-auto, flex-col, min-h-0 flex-1). NEW: wrap the list in a relative column whose left padding reserves the 28px SPINE; render ONE continuous hairline rail as a single aria-hidden absolutely-positioned 1px column at left:13px (center of the 28px gutter) in --vex-line — drawn once for the whole list, not per row, so the spine is literally one line (Law 1). Header/controls: none inside the tape (the composer owns plan/controls). Per-entry node: extract a shared TapeNode presentational component (replaces the inline CountersignTick) rendered by EVERY variant via the existing pl-7 slot. TapeNode props: { variant, createdAt, seq, state: 'rest'|'live'|'pending'|'stopped'|'error' }. It renders, absolutely at left-0: (a) node glyph — rest: a 2px dot / h-4 w-0.5 tick in --vex-line-strong; live: passes through to StreamingBubble's existing DotMatrix mark (keep that ownership); pending: a static h-4 w-0.5 bg-[var(--vex-accent)] tick (today's CountersignTick color, but now meaning 'pending' not decoration); error: same geometry in --color-destructive; (b) the mono stamp block BELOW the glyph: HH:MM (reuse formatClock) + a sequence index. Content (per variant, mostly preserved): user = right-aligned card, mono 'You · HH:MM' caption; assistant/assistant_stopped = AssistantCaption + AssistantBody (MarkdownContent); tool/tool_group = ToolActRow/ToolGroupRow (unchanged); notice = centered mono NoticeBody; compaction/recall = CompactionMarker/MemoryMarker (unchanged, but their node tick comes from the spine). Metadata: the HH:MM + sequence index live in the gutter, freeing the inline captions to drop their redundant clock over time (keep speaker name). Secondary actions: existing disclosures, copy keys, links. NEW PLAN BRIEF variant: a tape entry (NOT a section card) — gutter node + mono 'PLAN BRIEF' overline + Stamp tone='accent' 'recommended', the plan markdown in a --vex-surface-down recessed well (reuse SessionPlanCard's well classes), the --vex-warn-text 'Pending your acceptance' / success 'Accepted' status, and the Accept/Resume ACTION_KEY. Responsive/resizable: the 28px gutter is fixed; content max-widths stay (user 70%, tool 80%, assistant full); when the BOOK PANEL (3rd <main> child) opens, the tape simply reflows narrower — no layout animation (MOTION-POLICY: no layout/layoutId). Virtualization (long sessions): wrap rows in @tanstack/react-virtual useVirtualizer (already a dep, ~3.13.24) with the scrollRef as scrollElement, dynamic measureElement (variable row heights), overscan ~8; keep the single spine rail outside the virtualized translate-Y track so it never gaps; preserve bottom-anchor + prepend-restore by translating measured offsets. Gate virtualization behind a row-count threshold so short sessions render plainly (avoids measuring churn).

**Electron notes.** Renderer-only, untrusted surface. NO title-bar drag/no-drag concerns here — the tape lives inside the native-framed window body, never the chrome. Privilege only via window.vex.*: all data flows through existing hooks — useTranscriptInfinite, usePendingApprovals, useStreamPreview, and for PLAN BRIEF useSessionPlan/useAcceptPlan/useRequestResume — which already wrap window.vex.* IPC; this spec adds NO new IPC channel and NO new preload method (id + createdAt are already on every TranscriptEntry, so the spine needs zero schema/IPC work). No Node/Electron API touched. CSP style-src 'self' is respected: every motion is a stylesheet @keyframes class toggle (no runtime <style>, no cssText, no setAttribute('style')); the --dmx-bloom-level value is driven the same CSS-variable-on-class way the existing DotMatrix keyframes use it (02-bloom-states.css), never via inline style strings. No OS-specific behaviour differs.

**Implementation.** 1) SPINE + TapeNode. In TranscriptMessage.tsx replace CountersignTick (lines 51-58) with a shared TapeNode (new file features/appShell/TapeNode.tsx) and render it in the pl-7 slot of EVERY variant case (not just assistant). TapeNode JSX: outer `<span aria-hidden className=\"absolute left-0 top-0 flex w-7 flex-col items-center\">` containing the glyph then a mono stamp `<span className=\"mt-1 font-mono text-[10px] uppercase tracking-[0.14em] tabular-nums text-[var(--vex-text-3)]\">{seq}</span>`. Rest glyph: `<span className=\"mt-[5px] h-4 w-0.5 bg-[var(--vex-line-strong)]\"/>`; pending glyph swaps to `bg-[var(--vex-accent)]`; error to `bg-[color-mix(in_oklab,var(--color-destructive)_70%,transparent)]`. HH:MM reuses formatClock(createdAt) (TranscriptMessage.tsx:37-43). Sequence index = the row's position in the flattened list (compute once in SessionTranscript.map and pass `seq`); do NOT print the raw serial id (it is non-contiguous after paging). 2) Continuous rail. In SessionTranscript.tsx return (around :281-288) add a `relative` wrapper and one `<span aria-hidden className=\"pointer-events-none absolute bottom-0 left-[13px] top-0 w-px bg-[var(--vex-line)]\"/>` so the spine is a single element. 3) Needle bloom-and-resolve (Law 5). Add to globals.css after vex-entry-settle (line 338): `@keyframes vex-signal-resolve { 0%{--dmx-bloom-level:0} 45%{--dmx-bloom-level:1} 100%{--dmx-bloom-level:0} }` and `.vex-signal-resolve{animation:vex-signal-resolve 520ms cubic-bezier(0.22,1,0.36,1) both}`. Apply `.vex-signal-resolve` to the node glyph on the FIRST persisted assistant row that replaces a just-finished stream (detect via the existing settledIds boundary — a row whose id just left the live set). The drop-shadow tint is automatic (01-base.css:81-100 reads --dmx-bloom-level). Mono→proportional switch: on that same answer block, start with font-mono and toggle to the default font-sans on resolve (class swap, one-shot). 4) PLAN BRIEF entry. Add `\"plan_brief\"` to TranscriptRowVariant (transcriptRowModel.ts:21-28) ONLY if the engine emits a plan row; if plan stays query-driven (useSessionPlan), instead render PLAN BRIEF as a pinned pseudo-entry injected at the top of the rows array in SessionTranscript (cleaner: no schema change). Build features/appShell/PlanBriefEntry.tsx from SessionPlanCard's body but wrapped in the pl-7 tape grammar: drop the `<section ... rounded-lg border bg-[var(--vex-surface-1)]>` wrapper (SessionPlanCard.tsx:54), keep the TapeNode + a mono 'PLAN BRIEF' overline, reuse the Stamp, the recessed well (:84), the ACTION_KEY (:25-26), and swap text-warning → text-[var(--vex-warn-text)] (:76, :103). Remove the SessionPlanCard mount in SessionPanel.tsx:113 once the entry is wired. 5) Retire WelcomeBanner. Delete WelcomeBanner.tsx and its Card import; the zero-sessions empty state uses SessionWelcomeHero (already in SessionPanel.tsx:75). This also removes a Card shadow-sm off-brand surface. 6) Virtualization. In SessionTranscript add useVirtualizer from '@tanstack/react-virtual' gated on rows.length > a threshold; keep the spine rail and bottom-anchor effects (:167-206) intact by translating the virtual offset. 7) Guard. Extend shell-design-guard.test.ts BANNED list (line 69) with entries for the legacy indigo/violet hexes (#6366f1/#8b5cf6) + `bg-secondary` + Card `shadow-sm` so the retired surfaces can't return; ensure deleting WelcomeBanner clears the only shadow-sm offender. Reuse existing primitives throughout: formatClock, Stamp, MarkdownContent, ToolActRow/ToolGroupRow, DotmHex3/DotmCircular8, ACTION_KEY, and the vex-entry-settle/vex-fade-top classes.

**Motion specs.**

| Name | Trigger | Technique | Duration/easing | Reduced-motion |
| --- | --- | --- | --- | --- |
| Live node DotMatrix mark | A turn is streaming (preview.phase === 'streaming') and no pending approval | Existing DotMatrix component (DotmCircular8 for thinking, DotmHex3 otherwise) animated via its own stylesheet @keyframes driving --dmx-bloom-level; gated animated={!awaitingApproval} (StreamingBubble.tsx:198-212). CSP-safe (class-driven CSS var, no inline style). This is the ONLY resting-animated tape element (Law 3). | DotMatrix internal loop (existing); infinite while in-flight, frozen otherwise | DotMatrix honors prefers-reduced-motion via the global 0.01ms collapse → a static lit needle (Law 5 fallback); the mark stays visible so 'in progress' still reads. |
| Needle bloom-and-resolve (signature motion) | Reasoning-end / answer-commit — the first persisted assistant row replacing the just-finished stream | New build-time @keyframes vex-signal-resolve ramping --dmx-bloom-level 0→1→0 on the node glyph; tint is auto-applied by the existing 01-base.css drop-shadow that reads max(--dmx-bloom-level,--dmx-halo-level). One-shot (animation ... both), rests still. Synced to a font-mono→font-sans class swap on the answer block (the mono→proportional switch IS the resolve signal). Pure class toggle — CSP-safe. | 520ms cubic-bezier(0.22,1,0.36,1), one-shot | Global 0.01ms rule collapses the bloom to its final still frame; the type switch applies instantly (instant reveal). Net: static lit→rest, no flash. |
| Live-row entry settle | A row appended LIVE after the session's first completed render (id outside settledIds) | Existing .vex-entry-settle (opacity + 3px translateY, globals.css:325-338) applied in SessionTranscript.tsx:312. Stylesheet @keyframes, CSP-safe; historical/paged rows hard-cut. | 180ms ease-out, one-shot (both) | Global reduce rule collapses to the final frame (instant, in place). |
| Pending-approval freeze (TRUST = STILLNESS) | Active session has ≥1 pending approval (hasPendingApproval) | Not an animation — a removal of animation. The shell-wide animated={!awaitingApproval} gate freezes the live DotMatrix mark; the matching node shows a STATIC --vex-accent tick + existing 'Awaiting signature' stamp (Law 4). No pulse, no glow. | n/a (frozen state) | Identical — already motionless. |
| Reasoning-tail holographic dissolve | Live reasoning tail visible (collapsed window) while thinking | Existing .vex-fade-top mask-image (globals.css:342-344) on the 46px reasoning window (StreamingBubble.tsx:127) — a MASK, not a painted gradient, and the ONLY dissolve in the product (Law 6). No change; documented for completeness. | static mask (no timeline) | Unaffected — a static mask, not motion. |
| PLAN BRIEF accept lock-stamp | User accepts a pending plan (acceptPlan settles ok) or commit confirmation | Reuse .vex-stamp-press (globals.css:179-192) one-shot on the 'Accepted' status, re-read as a LOCK stamp per Law 4. Stylesheet @keyframes, CSP-safe; rests still. | 180ms ease-out, one-shot (both) | Global reduce rule collapses to the final (settled, opacity 1) frame. |

**Polish pass.**

_More premium:_

- Make the gutter stamp a true tabular-nums instrument readout: HH:MM over a fixed-width sequence index in Geist Mono, baseline-aligned to the node glyph, so scrolling reads like ticking tape rather than a chat log — the single most premium cue and it costs only createdAt/id you already have.
- Let the mono→proportional type switch be the ONLY thing that announces 'the answer is final' — no badge, no checkmark, no color change. A pending answer is mono/instrument; a committed one is Google Sans/document. That single material change is the signature and feels engineered.
- Draw the spine as one continuous 1px line for the whole list (not per-row segments) so nodes appear pinned to a real axis; pair the resting node with --vex-line-strong dots and reserve every blue tick for live/pending — the discipline of one accent at a time is what reads as expensive.

_Cut clutter:_

- Move HH:MM out of the inline 'Vex · HH:MM' / 'You · HH:MM' captions into the gutter stamp so the clock is stated once per node, not duplicated beside every speaker name — the prose column gets quieter.
- Absorb SessionPlanCard's bordered bg-surface-1 section into a flat PLAN BRIEF tape entry: drop the card chrome (border + raised fill) so the plan stops competing with the spine and reads as one more entry on the axis.
- Delete the WelcomeBanner Card (shadow-sm + bullet list + duplicate CTA) entirely; the zero-state collapses to the single SessionWelcomeHero head + composer, removing a whole redundant surface and its off-brand shadow.

_Generic traps to avoid:_

- Bubble-chat avatars or a left rail of speaker icons — the shell is photo-free and asymmetric (user card right, Vex full-width document); adding avatars would make it read as a generic SaaS chat. Keep the gutter node, not a face.
- Resting blue accents as decoration — a blue 'AI' pill, a glowing online dot, a blue card border on the PLAN BRIEF. Blue must be rationed to live/pending/focus/primary-CTA only (Law 2); any resting blue fill makes it look like a template.
- Card surfaces with shadow-sm/rounded-2xl drop-shadows for messages or the plan — the Depth Law is solid luminance + hairlines only (guard-pinned). A soft drop-shadow instantly reads as Tailwind-admin-template and would fail shell-design-guard.

**Files touched:** `/mnt/x/Vex/vex-app/src/renderer/features/appShell/TranscriptMessage.tsx`, `/mnt/x/Vex/vex-app/src/renderer/features/appShell/SessionTranscript.tsx`, `/mnt/x/Vex/vex-app/src/renderer/features/appShell/TapeNode.tsx`, `/mnt/x/Vex/vex-app/src/renderer/features/appShell/transcriptRowModel.ts`, `/mnt/x/Vex/vex-app/src/renderer/features/appShell/PlanBriefEntry.tsx`, `/mnt/x/Vex/vex-app/src/renderer/features/appShell/SessionPlanCard.tsx`, `/mnt/x/Vex/vex-app/src/renderer/features/appShell/SessionPanel.tsx`, `/mnt/x/Vex/vex-app/src/renderer/features/appShell/WelcomeBanner.tsx`, `/mnt/x/Vex/vex-app/src/renderer/features/appShell/StreamingBubble.tsx`, `/mnt/x/Vex/vex-app/src/renderer/features/appShell/CompactionMarker.tsx`, `/mnt/x/Vex/vex-app/src/renderer/features/appShell/MemoryMarker.tsx`, `/mnt/x/Vex/vex-app/src/renderer/styles/globals.css`, `/mnt/x/Vex/vex-app/src/renderer/features/appShell/__tests__/shell-design-guard.test.ts`


---

## Section 6 — Thinking / Reasoning · Needle Bloom-and-Resolve

> **Build status:** 🟢 Stage 2 shipped — `@keyframes vex-signal-resolve` (one-shot
> asymmetric accent bloom, peak ~38%) + `vex-answer-resolve` in `globals.css`, fired
> on the gutter node at answer-start and gated off while `awaitingApproval` freezes
> the strip (`StreamingBubble.tsx`). Implemented as a wrapper-level animated
> `drop-shadow` (CSP-safe, not a resting glow) rather than `--dmx-bloom-level`
> surgery; the deeper dot-internal bloom (with `@property`) is an optional refinement.
>
> _Recon area: Thinking / Reasoning stream — Needle Bloom-and-Resolve (StreamingBubble working strip)_

**Intent.** This is THE signature surface of Vex: the live, token-by-token render of the agent's in-flight turn. It hangs off the one timeline spine in the assistant gutter, shows a dot-matrix needle provably bound to engine work, surfaces the ephemeral reasoning tail as honest needle-deflection (visible while it moves, never persisted), then — at reasoning-end / answer-start — fires the single signature gesture of the whole product: a one-shot blue NEEDLE BLOOM in the gutter node synced to a mono->proportional type switch on the answer body, so the eye reads "the machine resolved from instrument-thinking into a finished human answer." A pending approval freezes every moving part (trust = stillness). It carries the brand's "instrument" promise: quiet chrome, loud content, one electric blue rationed to live cognition.

**UX structure.** Placement: the working strip is the live equivalent of a persisted assistant row inside SessionTranscript — a `relative flex flex-col gap-2 pl-7` block whose 28px left pad is the same timeline gutter slot every transcript entry uses (the gutter node sits `absolute left-0 top-0`, sharing CountersignTick's coordinate). It lives at the tail of the transcript, directly above the composer (the bottom anchor of the same spine). Interaction model: read-only telemetry except for ONE control — the reasoning tail is a single `<button>` toggling expand/collapse of the trace; everything else is non-interactive live state. The status header (status word + elapsed m:ss) and the gutter needle update on their own cadence (80ms reasoning batch, 1s elapsed tick) without user input. Keyboard model: only the reasoning-trace button is focusable; it takes `focus-visible:ring-2 ring-[var(--vex-accent)]` (focus ring is one of the four blue-rationing exceptions), toggles on Enter/Space, and exposes `aria-expanded`. The sr-only `role="status"` region announces phase + working word (changes a few times per turn, never token-by-token). What animates vs stays still: the dot-matrix needle is the ONLY resting-animated element and only while `phase === "streaming"` AND not awaiting approval; the elapsed counter ticks once/sec (text, not animation); the reasoning tail's oldest line dissolves through the `.vex-fade-top` mask (CSS mask, no JS); the bloom-and-resolve plays exactly ONCE at the reasoning->answer boundary; the answer body's font-family switch is a one-shot, non-looping transition. At rest (done / awaiting-approval) the whole strip is perfectly still.

**States.**

- idle/no-stream: StreamingBubble is not mounted (parent renders it only when useStreamPreview returns non-null) — strip absent, nothing reserved, no layout jump.
- streaming · thinking: gutter shows DotmCircular8 (cognition mark) animated; status word 'Thinking' in font-mono 10px tracking-[0.3em] text-[var(--vex-accent-text)]; reasoning tail visible in the 46px .vex-fade-top window pinned bottom (justify-end); elapsed m:ss ticking; answer body empty.
- streaming · calling: gutter swaps to DotmHex3 animated; header reads 'Calling {toolName}' in text-[var(--vex-text-3)] (quiet, no accent — tool work is not cognition); reasoning flushed to state first so trace ordering survives batching.
- streaming · writing (answer-start): the RESOLVE fires — gutter node plays one-shot vex-signal-resolve bloom; reasoning tail hard-swaps to the collapsed 'Reasoned · N tokens' summary line; answer body mounts and switches Geist Mono -> Google Sans as the markdown streams; status word becomes 'Writing' text-[var(--vex-text-3)].
- success/done (phase==='done'): brief terminal frame before useStreamPreviewSync clears the preview and the canonical persisted row takes over — needle stops, no bloom replay, no flicker; the swap to the persisted AssistantBody is seamless (same #04060f canvas, same gutter).
- empty reasoning (answer with no reasoning trace): ReasoningStrip not rendered (guarded by reasoningText.length>0); resolve still fires on first text delta so the answer-start signature is preserved even with zero reasoning.
- awaiting-approval freeze (TRUST=STILLNESS): awaitingApproval=true freezes both needle marks via animated={!awaitingApproval}, suppresses the bloom (animated gate), header reads 'Awaiting signature' in quiet accent text-[var(--vex-accent-text)] with NO pulse/fill; any in-progress resolve is not retriggered; the strip is motionless until the user's pen.
- validation/permission-denied: not owned here — approval gating happens upstream; this strip only reflects the frozen awaiting state and never paints a denied/error decoration of its own.
- error (phase==='error'): needle removed, header gone; safe generic 'Stream error' in text-destructive plus 'Reasoning interrupted' microcaption if a partial trace existed; raw provider text never reaches the strip; NO bloom, NO type switch (the resolve is a success signal only).
- retryable-vs-non-retryable: the strip does not own retry UI; on error it shows the terminal safe message and waits for the canonical error row / composer to offer recourse.
- offline-degraded: identical to idle — no stream deltas arrive, strip stays unmounted; no spinner-of-nothing.
- cancellation: a superseding streamId resets the preview (reducePreview/resolveBase), the old needle/bloom state is discarded, and a fresh needle starts; clear() cancels pending reasoning timers so no orphaned flush re-animates.
- reduced-motion: needle renders as a STATIC lit mark (DotMatrix usePrefersReducedMotion -> phase idle, dots at rest opacity); bloom collapses to an instant static lit needle (no ramp); type switch is an instant reveal (Geist Mono -> Google Sans with no transition); .vex-fade-top mask still applies (it is a static mask, not motion).

**Design tokens.** Surfaces: strip is transparent over --vex-surface-0 (#04060f) canvas; no fill, no card, no shadow (Depth Law). Hairlines: none added — the strip relies on the gutter node + whitespace, not borders (an expanded trace's scroll well may sit on --vex-surface-down via existing patterns, but the default 46px tail is mask-only). Accent (rationed): --vex-accent (#3275f8) on the live needle (color=var(--vex-accent)) and as the bloom tint (drop-shadow currentColor === --vex-accent); --vex-accent-text (color-mix #3275f8 55% white) for the 'Thinking'/'Reasoning'/'Awaiting signature' status words and the focus ring var(--vex-accent). NO resting accent fill anywhere. Text trio: --vex-text-3 (#b5b7c0) for elapsed counter, 'Calling/Working/Writing' words, 'Reasoned · N tokens' and 'Ephemeral — not retained' microcaptions; --vex-text-2 (#d4d6dc) for the reasoning tail body (13px); --vex-text/foreground (#e5e7eb) for the streamed answer body (15px). Radii: none on the strip itself (no chrome); the expanded-trace scroll region keeps existing overflow only. Borders: none on default strip. Shadows: NONE except the dot-matrix drop-shadow bloom, which is a meaning-bound motion artifact (max(--dmx-bloom-level,--dmx-halo-level)) not a resting glow — it rests at level 0. Motion durations/easing: vex-signal-resolve ~520ms ease-out both, one-shot (sits between vex-stamp-press 180ms and vex-stroke-signing 1100ms; long enough to read as a 'resolve', short enough to not feel ambient); answer font-family transition 200ms ease (transition-[font-family] is non-animatable per spec, so the switch is class-toggle instant + the surrounding opacity settle carries the perceived ease — see motion_specs). Typography: Geist Mono (--font-mono) for all instrument microtype — status words, elapsed tabular-nums, summary line — uppercase 10px tracking 0.3em (status) / 0.14em (summary/captions); reasoning tail body 13px leading-[1.55]; answer body 15px leading-[1.7] in Geist Mono pre-resolve -> Google Sans (--font-sans) post-resolve. The mono->proportional switch IS the resolve signal (Law 8).

**Component spec.** Container: `<div data-vex-area="stream-preview" data-vex-message-role="assistant" data-vex-stream-phase={preview.phase} aria-busy={streaming} className="relative flex flex-col gap-2 pl-7">` (unchanged shell). Header zone: gutter node at `absolute left-0 top-0` (DotmCircular8 when status==='thinking', else DotmHex3; size=14 dotSize=2 color=var(--vex-accent) animated={!awaitingApproval}); a flex row `flex items-baseline justify-between gap-2` holding the status word (left) and ElapsedCounter (right). Controls: none beyond the reasoning-trace button. Content zone (top->bottom): (1) ReasoningStrip — a single `<button>` whose label row swaps 'Reasoning' (pre-answer, accent-text, tracking-0.3em) <-> 'Reasoned · N tokens' (answering, text-3, tracking-0.14em) with the 'Ephemeral — not retained' microcaption on the right; below it the trace window is either the masked 46px `.vex-fade-top flex max-h-[46px] flex-col justify-end overflow-hidden` (collapsed) or `max-h-[240px] overflow-y-auto` (expanded). (2) answerBody — memoized on preview.text, `<div className="break-words text-[15px] leading-[1.7] text-foreground" data-vex-answer-resolved={answering ? '' : undefined}>` wrapping MarkdownContent; this is where the mono->proportional class lives. Metadata: elapsed m:ss tabular-nums (top-right), token-count summary (mid). Secondary actions: expand/collapse trace only. Responsive/resizable behavior: the strip is fluid to the transcript column width; the 46px tail height is fixed (predictable mask); the expanded trace caps at 240px and scrolls; under a narrow window the justify-between header wraps gracefully because both children are short mono tokens. The gutter (pl-7 / 28px) is invariant across breakpoints so the spine never shifts.

**Electron notes.** No title-bar interaction (native OS frame; no custom drag region touched). No window.vex.* preload calls in this surface — the strip is pure renderer state: it reads the ephemeral Zustand streamStore (useStreamPreview), which is fed by the stream-delta IPC event consumed upstream; awaitingApproval is derived upstream from the shared ApprovalsRegion pending query and passed as a prop, keeping the stream store decoupled from privilege. CSP: all motion is stylesheet `@keyframes` (style-src 'self') — no runtime <style>, no element.style.cssText/setAttribute('style') for animation, no dangerouslySetInnerHTML. The dot-matrix components do set inline CSS custom properties via React style={} (allowed — that is the style attribute set by React's prop, but note: under strict style-src 'self' inline style attributes from React are already in use repo-wide via DotMatrix and are accepted by the existing CSP posture; we add NO new inline-style animation, only class toggles). OS differences: prefers-reduced-motion is honored via the global media query + DotMatrix's usePrefersReducedMotion hook — consistent across Win/macOS/Linux. No filesystem/Docker/wallet access.

**Implementation.** 1) NEW keyframe in globals.css (after vex-stamp-press, same CSP-safe stylesheet pattern):
```css
/* SIGNATURE MOTION — Needle Bloom-and-Resolve. One-shot blue bloom at the
 * reasoning->answer boundary, ramping --dmx-bloom-level 0->1->0 on the gutter
 * node's dots; the 01-base.css drop-shadow reads max(--dmx-bloom-level,
 * --dmx-halo-level) and auto-tints to currentColor (=var(--vex-accent)).
 * Rests at level 0 (perfectly still). Reduced motion -> static lit needle. */
@keyframes vex-signal-resolve {
  0%   { --dmx-bloom-level: 0; }
  38%  { --dmx-bloom-level: 1; }
  100% { --dmx-bloom-level: 0; }
}
.vex-signal-resolve .dmx-dot { animation: vex-signal-resolve 520ms ease-out both; }
@media (prefers-reduced-motion: reduce) {
  /* No ramp; a static lit needle carries the resolve. animation:none clears the
   * name (the global 0.01ms rule only forces duration), level pinned high. */
  .vex-signal-resolve .dmx-dot { animation: none; --dmx-bloom-level: 1; }
}
```
NOTE the `--dmx-bloom-level` must be a registered/animatable custom property for the ramp to interpolate; it is already declared on `.dmx-dot` (01-base.css:28 `--dmx-bloom-level: 0`) and consumed by the drop-shadow, but bare custom props animate as discrete steps unless registered. To get a smooth ramp, add a CSP-safe `@property --dmx-bloom-level { syntax: '<number>'; inherits: true; initial-value: 0; }` to globals.css (build-time stylesheet, allowed under style-src 'self'). If @property is declined in review, the keyframe still steps 0->1->0 (acceptable, reads as a flash-and-settle).

2) StreamingBubble.tsx — gate the bloom + halo on the gutter node. The marks already accept bloom/halo (forwarded through DotMatrixBase). Wrap the gutter `<span aria-hidden className="absolute left-0 top-0 ...">` with the resolve trigger so it plays ONCE when answering flips true:
- add `const justResolved = useResolvePulse(answering && !awaitingApproval);` (a tiny hook below) returning true for one render-window after the false->true edge.
- on the gutter span: `className={cn("absolute left-0 top-0", justResolved && "vex-signal-resolve")}`.
- pass `bloom` to the active mark while resolving so the per-dot --dmx-bloom-level path is live, e.g. on the DotmHex3/DotmCircular8 used at answer-start: `bloom={justResolved}`. (Keeps resting dots un-bloomed.)
The `animated={!awaitingApproval}` gate stays; awaiting-approval suppresses the resolve because `justResolved` requires `!awaitingApproval`.

3) Mono->proportional answer switch. Today answerBody is `text-foreground`; make the font-family the resolve signal via a class toggle (one-shot, not a CSS font-family transition which is non-animatable):
```tsx
const answerBody = useMemo(() => preview.text.length > 0 ? (
  <div
    data-vex-answer-resolved=""
    className="break-words font-sans text-[15px] leading-[1.7] text-foreground vex-answer-reveal"
  ><MarkdownContent text={preview.text} /></div>
) : null, [preview.text]);
```
Pre-resolve there is no answer block (text empty), so the very first text delta mounts the block already in Google Sans — the *perceived* mono->proportional switch is achieved by playing a 200ms opacity/translate reveal (`vex-answer-reveal`, mirroring vex-entry-settle) AS the reasoning tail collapses from its mono summary, so the eye reads instrument(mono header)->document(proportional body). Add to globals.css:
```css
@keyframes vex-answer-reveal { from { opacity: 0; transform: translateY(2px); } to { opacity: 1; transform: none; } }
.vex-answer-reveal { animation: vex-answer-reveal 200ms ease-out both; }
```
Reduced motion: the global 0.01ms rule collapses vex-answer-reveal to its final frame = instant reveal (matches Law 5).

4) Strengthen live-status typography toward true accent (recon ask): the 'Thinking'/'Reasoning' words already use --vex-accent-text; keep that, and ensure the 'Writing' word stays text-3 (writing is output, not cognition — preserves blue rationing). No change needed beyond confirming the resolve does not leave residual accent.

5) useResolvePulse hook (one-shot edge, CSP-safe, no timers needed beyond a microtask):
```tsx
function useResolvePulse(active: boolean): boolean {
  const [pulse, setPulse] = useState(false);
  const prev = useRef(false);
  useEffect(() => {
    if (active && !prev.current) { setPulse(true); const id = window.setTimeout(() => setPulse(false), 560); prev.current = true; return () => window.clearTimeout(id); }
    if (!active) prev.current = false;
  }, [active]);
  return pulse;
}
```
The 560ms clears just after the 520ms keyframe so the class is removed and the resting frame is the un-bloomed needle (Law 3: no resting glow).

Reuse: vex-stamp-press / vex-entry-settle as the one-shot-stylesheet-keyframe template; .vex-fade-top untouched (sole dissolve); DotMatrixBase bloom/halo plumbing untouched; usePrefersReducedMotion via the marks. Add a line to shell-design-guard.test.ts asserting vex-signal-resolve is one-shot (no `infinite`) and that the answer body uses font-sans post-resolve.

**Motion specs.**

| Name | Trigger | Technique | Duration/easing | Reduced-motion |
| --- | --- | --- | --- | --- |
| Needle bloom-and-resolve (signature) | answering flips false->true (first text delta) AND !awaitingApproval — the reasoning->answer boundary | Build-time stylesheet @keyframes vex-signal-resolve ramping the inherited custom prop --dmx-bloom-level 0->1->0 on .dmx-dot; the existing 01-base.css drop-shadow reads max(--dmx-bloom-level,--dmx-halo-level) and tints to currentColor=var(--vex-accent). Triggered by toggling the .vex-signal-resolve class + bloom prop via React state (useResolvePulse), no inline-style animation. CSP-safe (style-src 'self'). Optional @property --dmx-bloom-level for smooth ramp. | 520ms ease-out, both, one-shot (iteration 1) | animation:none on .dmx-dot, --dmx-bloom-level pinned to 1 = instant static lit needle (no ramp), per Law 5 fallback |
| Mono->proportional answer reveal | answer body mounts at answer-start (same boundary as the bloom) | Answer block mounts in font-sans (Google Sans) and plays stylesheet @keyframes vex-answer-reveal (opacity+2px translateY) while the reasoning summary above it hard-swaps to its mono collapsed line; class toggle only, no font-family transition (non-animatable), no layout/layoutId | 200ms ease-out, both, one-shot | global 0.01ms rule collapses to final frame = instant reveal in Google Sans |
| Dot-matrix needle (resting cognition mark) | phase==='streaming' && !awaitingApproval | Existing DotmCircular8/DotmHex3 JS-phase opacity loop (useCyclePhase) — the ONLY resting-animated element, provably bound to in-flight engine work; frozen by animated={!awaitingApproval} | 1400ms (circular) / 1850ms (hex) cycle, sinusoidal opacity | usePrefersReducedMotion -> phase idle -> static dots at rest opacity (no loop) |
| Reasoning tail dissolve | reasoning streaming in the collapsed 46px window | .vex-fade-top mask-image linear-gradient (transparent->black 18px) — a MASK not a painted gradient (Law 6, one dissolve one place); pinned bottom via CSS justify-end, no JS scroll | none (static mask; content scroll is intrinsic) | unaffected — a static mask is not motion |
| Approval freeze | awaitingApproval flips true | animated={!awaitingApproval} on both marks halts the JS phase loop; useResolvePulse gated on !awaitingApproval prevents any bloom; no class with animation remains | instant stop (no transition — trust=stillness) | identical (already still) |

**Polish pass.**

_More premium:_

- The 520ms bloom peaks at 38% then decays — a true 'resolve' arc, not a symmetric blink; pairing it with the mono->proportional reveal makes the answer feel EARNED by the thinking, which is the entire brand promise (Clarity Engine resolving).
- Tint the bloom purely through currentColor=var(--vex-accent) on the existing drop-shadow so the periwinkle->white halo is automatic and color-consistent with the needle — one blue family, zero hardcoded glow color, reads as instrument light not decoration.
- Hold the resting needle at the existing low base opacities (0.08-0.16) so the bloom has somewhere to travel FROM; a needle that already glows at rest would make the signature gesture invisible — the contrast between quiet-rest and one-shot-bloom is what feels premium.

_Cut clutter:_

- Keep the answer block ABSENT until the first text delta (no reserved empty box, no skeleton) so there is zero layout placeholder before the resolve — the strip grows only as real content arrives.
- Collapse the reasoning trace to the single 'Reasoned · N tokens' mono line the instant the answer streams (existing behavior) so two competing text columns never coexist; the trace stays reopenable but out of the way.
- Remove any temptation to add a separate 'done' checkmark or success chip — the bloom-and-resolve IS the completion signal; a second affordance would dilute the one signature gesture.

_Generic traps to avoid:_

- A looping/pulsing glow on the needle at rest (ambient motion) — would violate Law 3 and instantly read as generic 'AI is thinking' shimmer; the bloom MUST be one-shot and rest at level 0.
- A symmetric fade-in/fade-out blink or a spinner instead of the asymmetric resolve arc + type switch — a generic spinner throws away the instrument metaphor and the mono->proportional payoff.
- Painting the reasoning tail dissolve as a CSS linear-gradient background (a fake fade) instead of the .vex-fade-top mask — a painted gradient is a banned depth/fill pattern and looks like every other chat app; it must stay a mask.

**Files touched:** `/mnt/x/Vex/vex-app/src/renderer/features/appShell/StreamingBubble.tsx`, `/mnt/x/Vex/vex-app/src/renderer/styles/globals.css`, `/mnt/x/Vex/vex-app/src/renderer/features/appShell/__tests__/shell-design-guard.test.ts`


---

## Section 7 — Tool ledger

> _Recon area: Tool ledger — disclosure rows, registered-act rows, group/aggregation rows, and the "Awaiting signature" stamp-link — re-grammared into Signal Tape entries that hang off the one timeline gutter as tool-node tape stops._

**Intent.** The tool ledger is where Vex's autonomous on-chain work becomes auditable. Every tool the agent fired (search, web, terminal, file, memory, wallet/chain) registers as a quiet FACT in the transcript: a node on the timeline, a tool glyph, a tool name, and — on demand — a recessed well showing the exact sanitized Args and Output. Long uninterrupted runs collapse into one aggregation entry so the document stays readable, and any act that is blocking on the user's pen surfaces an "Awaiting signature" link that jumps to its inline approval card. This area is the trust ledger: it must read as a registered instrument log, never as decorative chat chrome, and it must NEVER hide the one act waiting on a signature inside a collapsed group.

**UX structure.** Placement: tool entries render inside the transcript flow (TranscriptMessage switch, cases "tool" and "tool_group"), sharing the SAME 28px left timeline gutter the assistant rows use via `relative pl-7` (the CountersignTick slot at TranscriptMessage.tsx:50-58). Today's tool rows ignore that gutter (`flex flex-col gap-1.5`, no pl-7); the redesign moves them ONTO the spine: each act/group row becomes `relative pl-7` so its tool-node glyph sits in the gutter at left-0, aligned to the same axis as user/assistant/notice/recall nodes — one spine, no second column.

Interaction model: the whole header is one disclosure button (`aria-expanded`/`aria-controls`, unchanged). Click or Enter/Space toggles the recessed well open/closed. The chevron rotates 90deg as the open affordance. For groups, expanding reveals member ToolActRow children under an indented sub-rail; each member is itself independently expandable. The ApprovalLinkStamp is a SIBLING button (never nested — invalid HTML), so Tab reaches: [group/act disclosure] -> [Awaiting-signature link] -> next entry. The link jumps + focuses the matching `[data-approval-id]` ApprovalCard (existing jumpToApproval, reduced-motion-aware scroll).

Keyboard model: native button semantics throughout; focus-visible ring is `--vex-accent` (rationed blue law #2). No roving tabindex, no custom key handlers — the disclosure is a plain button, the stamp is a plain button.

What animates vs stays still: at REST everything is frozen — node is a hairline/text-trio glyph, no glow, no pulse. The ONLY motion is one-shot: the well content settles in via `.vex-entry-settle` (180ms) on expand, group members stagger-reveal, and the gutter node fires ONE `vex-signal-resolve` bloom when its act resolves (call paired with output). A pending approval FREEZES all of it (the shell-wide `animated={!awaitingApproval}` gate): the node holds a static lit state and members reveal instantly.

**States.**

- idle/registered: act resolved, well collapsed — node is a still hairline tool-node glyph in the gutter (text-[var(--vex-text-3)]), name in mono, chevron right. No blue.
- expanded: disclosure open — recessed `bg-[var(--vex-surface-down)]` well slides via `.vex-entry-settle` (180ms ease-out), accent spine on the left edge of the well, Args section always, Output section only when `act.output !== null`.
- streaming/in-flight act (output === null while a run is live): node carries the active state — a DotMatrix cognition glyph or lit node bound to engine work; this is the only resting-animated node and it freezes on idle/pending (law #3/#4).
- resolved (one-shot): at output-merge the node fires `vex-signal-resolve` bloom once (--dmx-bloom-level 0->1->0) then rests; no persistent glow.
- awaiting-approval (pending decision): the matching act/group shows ApprovalLinkStamp (accent-toned, no fill, no pulse); ALL node motion freezes; the act node holds a static lit accent ring — the one place blue is allowed at rest (law #2 pending-decision).
- empty Args: SectionBody prints `(no parameters)` in text-3 mono.
- empty/no Output: Output section omitted entirely (null), not rendered as an empty block.
- orphan tool_result (call never paired in its run): falls back to ToolDisclosure standalone well — same recessed grammar, label `<tool>_output`, body or `(no output)` hint.
- group collapsed with a pending member: group header surfaces the matched ApprovalLinkStamp at header level (matchedApprovalId) so a collapsed group can never hide the act awaiting the pen.
- group expanded: members reveal under an indented accent sub-rail, each `.vex-entry-settle` staggered; member count badge `{N} tool calls` in tabular-nums.
- overflow glyph strip: >4 distinct glyphs collapse to `+{k}` in mono text-3.
- permission-denied / non-retryable tool error: surfaces as a `notice` error row (existing variant, destructive tone) BREAKING the run — not styled inside the act ledger; the act well shows whatever sanitized output landed.
- reduced-motion: `.vex-entry-settle` collapses to final frame (global rule), node bloom = static lit needle, stagger = instant reveal, ApprovalLinkStamp scroll = `behavior:auto`.

**Design tokens.** Surfaces: row container at-rest `bg-white/[0.02]` (the existing quiet act tone — sits just above --vex-surface-1); expanded well `bg-[var(--vex-surface-down)]` (#02040a recessed); raised group header `bg-[var(--vex-surface-2)]` (#0f1729, the only raised tool surface). Hairlines: `border-[var(--vex-line)]` (6%) for row + well separators; group header gets `border-[var(--vex-accent-border)]` (color-mix 55% accent) as the "raised+accent-bordered" treatment, AT REST only as a 1px hairline border — not a fill. Accent: `--vex-accent` (#3275f8) only on focus ring, the resolve node bloom, the pending-decision lit node, and the ApprovalLinkStamp border (`color-mix(in oklab,var(--vex-accent) 40%,transparent)` via Stamp tone="accent") + text `--vex-accent-text`. Accent spine on wells = `border-l border-[var(--vex-accent-border)]` at rest (hairline, 55% mix — within blue-rationing as a structural spine, not a fill); group sub-rail = `border-l border-[var(--vex-line)]` (existing). Dot-matrix tool-group rail tint = `--vex-accent-fill-8` (8% — the contract's <=8% ceiling). Text: name `--vex-text-2`, count `text-foreground` (existing), glyphs/headers/hints `--vex-text-3`. Radii: `--radius-sm` (0.375rem) on rows/wells (replaces the raw `rounded-[6px]`/`rounded-[3px]` literals — 6px ≈ 0.375rem so this is a token swap, not a visual change). Typography: Geist Mono (`font-mono`) for tool name 12px, count tabular-nums, section headings 10px uppercase tracking-[0.3em], stamp 10px uppercase tracking-[0.14em], `(no parameters)` hints; well body `<pre>` mono 11px leading-relaxed. Motion: `.vex-entry-settle` 180ms ease-out; `vex-signal-resolve` (new) one-shot bloom; `--dmx-bloom-level` 0->1->0 ramp auto-tinted by 01-base.css drop-shadow reading `max(--dmx-bloom-level,--dmx-halo-level)`. NO shadows, NO gradients-as-fill, NO backdrop-filter (depth law #9).

**Component spec.** Container (per entry): `<div data-vex-message-role="tool" class="relative pl-7 ...">` — adds the gutter; the existing `rounded-[6px] border border-[var(--vex-line)] bg-white/[0.02]` row body becomes the tape card hanging right of the gutter. Header (gutter node): a new `ToolNode` glyph absolutely positioned in the 28px slot at `absolute left-0 top-[5px]` (mirroring CountersignTick), rendering the `toolGlyph(act.toolName)` icon at size 14 in a tiny node frame (text-3 at rest; lit accent when pending; DotMatrix-bloom on resolve). Controls: the existing disclosure `<button>` (aria-expanded/controls, focus-visible ring accent) carrying name + chevron; ApprovalLinkStamp as sibling at right (`pr-2`). Content (expanded well): `<div class="vex-entry-settle border-t border-l border-[var(--vex-line)] border-l-[var(--vex-accent-border)] bg-[var(--vex-surface-down)] px-2.5 py-2">` — the new `border-l-[var(--vex-accent-border)]` is the accent SPINE on the well (the "args/output down-well" treatment); SectionHeading (Args/Output mono 10px tracking-0.3em) + SectionBody (`<pre>` text). Metadata: mono HH:MM + sequence index live in the shared gutter caption pattern (reuse `captionText`/`formatClock` from TranscriptMessage — tool entries gain the same register line as assistant rows so they sit on the time axis; tabular-nums). Group header: `bg-[var(--vex-surface-2)] border border-[var(--vex-accent-border)]` raised card, `{N} tool calls` tabular-nums + distinct-glyph strip (max 4 + `+{k}`), header-level ApprovalLinkStamp when matched. Group body: indented sub-rail `ml-1.5 border-l border-[var(--vex-line)] pl-6` with each member wrapped in `.vex-entry-settle`; the dot-matrix tool-group rail is an `::before` dotted accent line at `--vex-accent-fill-8` along the rail (see implementation). Secondary actions: ApprovalLinkStamp (jump-to-approval) is the only secondary action. Responsive: rows are full-width within the transcript column; `<pre>` wells cap at `max-h-[280px] overflow-auto` (existing) with whitespace-pre-wrap break-words; on a narrowed Book-panel-open layout the glyph strip already overflows gracefully to `+{k}`.

**Electron notes.** No title-bar interaction (native OS frame — no drag region touched here). All data is already local-sanitized: `act.toolArgs`/`act.output` are sanitized strings rendered as React text nodes via `<pre>` (never HTML, never dangerouslySetInnerHTML) — CSP `style-src 'self'` and the untrusted-renderer rule are honored; the ledger calls NO `window.vex.*` privilege (it is pure presentation over the already-fetched SessionMessageDto). The only platform calls are in ApprovalLinkStamp: `document.querySelector`, `CSS.escape` (feature-checked for jsdom), `scrollIntoView` + `matchMedia` (both feature-checked — degrade to focus-only in tests). The pending-approval freeze must read the same `awaitingApproval` source the shell-wide `animated={!awaitingApproval}` gate uses, threaded down as a prop (no new IPC). Renderer stays untrusted; no Node/Electron API enters this tree.

**Implementation.** 1) Gutter alignment (ToolActRow.tsx + ToolGroupRow.tsx + TranscriptMessage.tsx cases): wrap each tool entry in `relative pl-7` and add a `ToolNode` in the gutter. New `ToolNode.tsx` in ToolLedger/: `<span aria-hidden className="absolute left-0 top-[5px] flex h-4 w-4 items-center justify-center">` containing `<HugeiconsIcon icon={toolGlyph(name)} size={12} className="text-[var(--vex-text-3)]" />`; when `pending` add `className` extension `text-[var(--vex-accent)]` + a 1px ring via `ring-1 ring-[var(--vex-accent-border)] rounded-full`; when `resolving` add the DotMatrix bloom class (see motion). Move the glyph OUT of the header button (ToolActRow.tsx:90-95) into ToolNode so the header no longer prints the glyph inline (group header keeps its multi-glyph strip).
2) Accent spine on wells: in ToolActRow.tsx:117 change the expanded well class string to `"vex-entry-settle border-t border-l border-[var(--vex-line)] border-l-[color-mix(in_oklab,var(--vex-accent)_55%,transparent)] bg-[var(--vex-surface-down)] px-2.5 py-2"` (or reference `--vex-accent-border` directly: `border-l-[var(--vex-accent-border)]`). Apply the identical spine to ToolDisclosure.tsx:47 well and the orphan-result well.
3) Raised+accent-bordered group header: ToolGroupRow.tsx:64 — swap the container to `rounded-[var(--radius-sm)] border border-[var(--vex-accent-border)] bg-[var(--vex-surface-2)]` for the header card; keep member rows on the quieter `bg-white/[0.02]`.
4) Dot-matrix tool-group rail: replace the plain `border-l` sub-rail (ToolGroupRow.tsx:110) with a build-time CSS class `.vex-tool-rail` added to globals.css: `.vex-tool-rail{ background-image: repeating-linear-gradient(to bottom, var(--vex-accent-fill-8) 0 1px, transparent 1px 4px); background-repeat: no-repeat; background-size: 1px 100%; background-position: left; }` — a dotted accent rail at the 8% tint, no runtime style, CSP-safe. Apply with `pl-6` for member indent.
5) Staggered member reveal: keep the existing `.vex-entry-settle` per member (ToolGroupRow.tsx:112). For stagger WITHOUT inline style (CSP), add build-time delay classes in globals.css `.vex-settle-d1{animation-delay:40ms}.vex-settle-d2{animation-delay:80ms}` etc. and cap at a fixed small set (e.g. d1..d6) applied by index `min(i,6)`; this stays CSP-safe (class names, no cssText). Reduced-motion already zeroes the animation.
6) Resolve bloom keyframe (NEW, globals.css): `@keyframes vex-signal-resolve{0%{--dmx-bloom-level:0}50%{--dmx-bloom-level:1}100%{--dmx-bloom-level:0}}` plus `.vex-signal-resolve{animation:vex-signal-resolve 420ms ease-out both}` — requires `@property --dmx-bloom-level{syntax:"<number>";inherits:true;initial-value:0}` so the custom prop is animatable (Chromium/Electron supports @property; this is the same prop 01-base.css already reads in its drop-shadow). The ToolNode wraps a DotMatrix dot element so the drop-shadow auto-tints. Apply `.vex-signal-resolve` once on output-merge transition; freeze when `awaitingApproval`.
7) Radius tokenization: replace `rounded-[6px]` -> `rounded-[var(--radius-sm)]` and `rounded-[3px]` (Stamp/ApprovalLinkStamp focus radius) left as-is or -> a small literal (3px is below --radius-sm; keep literal, it's a focus-ring rounding not a surface).
8) Freeze plumbing: thread `awaitingApproval: boolean` from the shell gate into TranscriptMessage -> ToolActRow/ToolGroupRow -> ToolNode; when true, ToolNode renders the static lit state and skips `.vex-signal-resolve`/DotMatrix animation.
Reuse: `toolGlyph()` (unchanged), `Stamp` (unchanged), `ApprovalLinkStamp` (unchanged), `.vex-entry-settle` (existing), `cn()`, `formatClock`/`captionText` (lift to a shared module if reused by tool rows). Extend `shell-design-guard.test.ts` BANNED list with the retired indigo/violet hexes (#6366f1,#8b5cf6) and `bg-secondary` / `shadow-sm` per law #9 — these rows currently use none, so the guard stays green.

**Motion specs.**

| Name | Trigger | Technique | Duration/easing | Reduced-motion |
| --- | --- | --- | --- | --- |
| well-reveal | User expands a tool act or orphan-result disclosure (aria-expanded -> true). | Existing `.vex-entry-settle` stylesheet @keyframes (opacity 0->1 + translateY 3px->0) on the conditionally-rendered well div. CSP-safe: class-only, no inline style. | 180ms ease-out (both) | Global prefers-reduced-motion 0.01ms rule collapses to the final frame — instant reveal, content already at opacity 1. |
| member-stagger | User expands a tool_group; member ToolActRows mount. | `.vex-entry-settle` per member + build-time `.vex-settle-d1..d6` animation-delay classes applied by `min(index,6)`. CSP-safe: class names only, no cssText/setAttribute('style'). | 180ms ease-out, 40ms-per-step delay capped at d6 | Delays + settle collapse to final frame via global rule — all members appear at once. |
| node-resolve-bloom | An act resolves: its output merges (output transitions null -> string) at reasoning-end/answer-start. | NEW build-time `@keyframes vex-signal-resolve` ramping `--dmx-bloom-level` 0->1->0 (registered via `@property` so the custom prop animates); the ToolNode wraps a `.dmx-dot`/`.dmx-bloom` element whose 01-base.css drop-shadow auto-tints from `max(--dmx-bloom-level,--dmx-halo-level)`. One-shot, rests at level 0 (perfectly still). CSP-safe: stylesheet keyframes, no runtime style. | 420ms ease-out (both); single play | Static lit needle — apply a `.vex-node-lit` class (fixed --dmx-bloom-level:0, plain accent glyph) instead of the animation; no bloom. |
| chevron-rotate | Disclosure open/close toggle. | Existing Tailwind `transition-transform` + `rotate-90` class swap on the ArrowRight01Icon (transform only, GPU-cheap). CSP-safe. | default Tailwind transition (~150ms) ease | Transition zeroed by global rule; chevron snaps to rotated state. |
| pending-freeze | A matching approval becomes PENDING for this act/group (awaitingApproval true). | Law #4 trust=stillness: the `awaitingApproval` prop gates the ToolNode — DotMatrix animation and `.vex-signal-resolve` are not applied; node holds a static `.vex-node-lit` accent state. No motion runs anywhere in the entry. CSP-safe (conditional class). | n/a (frozen) | Identical — already static. |

**Polish pass.**

_More premium:_

- Tool-node glyph sits PRECISELY on the same 28px spine as assistant/user/notice/recall nodes (left-0 top-[5px], matching CountersignTick) so the whole transcript reads as one instrument timeline — the single most premium move is perfect axis alignment across every entry type.
- Accent spine on the args/output well (a 1px `--vex-accent-border` left edge on #02040a) gives the recessed data a quiet 'this is wired into the agent' depth WITHOUT a fill — structural blue, not decorative blue, honoring rationing.
- The resolve bloom is a single 420ms one-shot that returns the node to perfect stillness — the node 'clicks' into resolved like a stamping press, reinforcing the notary/instrument feel; nothing pulses or breathes at rest.

_Cut clutter:_

- Output section is omitted entirely when `act.output === null` (already true) — no empty 'Output: —' rows; the collapsed default keeps the ledger to one line per act until the user asks.
- Glyph strip caps at 4 distinct icons + `+{k}` (existing MAX_HEADER_GLYPHS) so a 20-call group header never becomes an icon soup; deduped by icon identity, not tool name.
- Drop the inline glyph from the act header button (it moves to the gutter node) — the header becomes name + chevron only, removing the doubled visual weight of glyph-in-gutter AND glyph-in-row.

_Generic traps to avoid:_

- Resting blue fills on tool rows (e.g. `bg-[var(--vex-accent-fill-12)]` headers or a glowing 'tool' pill) — this would read as generic AI-chat tool chips; blue stays rationed to focus/pending/resolve only.
- A status pill with green/red/yellow fills per call ('success'/'error') — the DTO carries NO per-call status; inventing one would be a fabricated state AND a fill-law violation. Status is communicated by node color + the run-breaking error notice, never a colored badge.
- Ambient shimmer/pulse on the tool-group rail or a permanently animated 'working' node — law #3: the only resting motion is the DotMatrix needle bound to verifiable in-flight engine work; a decorative pulse would make it look like every SaaS skeleton loader.

**Files touched:** `/mnt/x/Vex/vex-app/src/renderer/features/appShell/ToolLedger/ToolActRow.tsx`, `/mnt/x/Vex/vex-app/src/renderer/features/appShell/ToolLedger/ToolGroupRow.tsx`, `/mnt/x/Vex/vex-app/src/renderer/features/appShell/ToolDisclosure.tsx`, `/mnt/x/Vex/vex-app/src/renderer/features/appShell/ToolLedger/ApprovalLinkStamp.tsx`, `/mnt/x/Vex/vex-app/src/renderer/features/appShell/ToolLedger/ToolNode.tsx (new)`, `/mnt/x/Vex/vex-app/src/renderer/features/appShell/TranscriptMessage.tsx`, `/mnt/x/Vex/vex-app/src/renderer/styles/globals.css`, `/mnt/x/Vex/vex-app/src/renderer/features/appShell/__tests__/shell-design-guard.test.ts`


---

## Section 8 — Composer · chat input + Plan switch

> _Recon area: Composer / chat input + Plan switch — the bottom anchor of the Signal Tape spine (vex-app/src/renderer/features/appShell/SessionComposer.tsx + PlanSwitch.tsx + ReasoningSwitch.tsx + ComposerQuickActions.tsx)._

**Intent.** The Composer is the operator's command deck and the bottom terminus of the single Signal Tape spine: the same ~28px timeline gutter that runs the transcript's left edge continues down through the composer and dies in a live node where the textarea begins, so "where you type" reads as the newest, in-progress node on the time axis rather than a detached input box. It owns the chat-turn submit (textarea + auto-grow + the 3-state send/stop/stopping key), the PLAN switch (the sole writer of session-scoped plan mode, pending-decision grammar), the REASON tag (quiet mono telemetry, distinct from PLAN so they stop sharing one accent fill), free-text gating during mission runs, the inline notice/Retry, and the starter ledger. The MODE LINE along the form's top edge is promoted to the SIGNAL-TAPE baseline: it keeps the plan-ON scaleX hold and gains a one-shot left→right sweep on submit, signaling "the needle has started" the instant a turn is in flight. Blue is rationed: lit only while a turn is in flight, while plan is ON (pending decision), on the focus ring, and on the single primary CTA — at rest the whole deck is hairline + the text trio.

**UX structure.** Placement: third/last block of the transcript column in AppShell's center <main>, anchored at the bottom under the scrolling tape; it does NOT live in the right Book panel and is never a floating overlay. Spine continuity: the composer's left padding aligns to the transcript's pl-7 gutter (reuse the exact 28px slot CountersignTick occupies at TranscriptMessage.tsx:51-58) so the gutter is visually one unbroken axis from sidebar→tape→composer. A single live NODE (a 2px-wide, 16px-tall accent tick mirroring CountersignTick, plus a mono tabular-nums status word) sits in that gutter at the composer's top-left, level with the first textarea line. Interaction model: type → Enter sends (Shift+Enter / IME newline), the textarea auto-grows 52→200px; the MODE LINE fires its one-shot submit sweep; the send key hard-cuts send→stop→stopping in one fixed 68px slot so the h-11 chrome row never shifts. PLAN and REASON are h-7 token chips on the chrome row's left; the hint microtype fills the flexible middle; the send key pins right. Keyboard model: textarea is the primary focus; Enter=submit, Shift+Enter=newline, Esc is a no-op (native), Tab moves textarea→PLAN→REASON→Send (DOM order already correct); PLAN is role=switch with aria-checked, REASON is a cycle button with aria-label announcing the level; the focus ring is the only resting blue on chips. What ANIMATES: the gutter live node (in-flight only, frozen on pending-approval), the MODE LINE submit sweep (one-shot), the send→stop hard-cut (instant, no transition on swap), the node bloom-and-resolve on answer-start, and the plan-ON scaleX hold. What stays STILL: the textarea chrome, the PLAN/REASON chip borders at rest, the hint text, the surface — no ambient motion, no resting glow.

**States.**

- idle / empty draft: send key disabled (border --vex-line-strong, text --vex-text-3), gutter node DARK (hairline tick, no animation), MODE LINE at scaleX(0), hint reads 'Enter ↵ send · Shift+Enter newline' (or 'type a message to start a session' on welcome)
- draft typed (valid): send key promoted (border --vex-accent-border, text --vex-accent-text, hover lifts to --vex-accent-fill-8 + active:scale-[0.98]); gutter node still dark (no engine work yet)
- submitting / in-flight (submitPending): send key hard-cuts to STOP (border --vex-accent-border-strong, bg --vex-accent-fill-12, StopCircleIcon); gutter live node LIGHTS to --vex-accent and the dot-matrix needle status word animates (bound to engine work); MODE LINE fires the one-shot vex-signal-submit-sweep
- stop requested (stopRequested): key flips to disabled 'Stopping' (mono 10px, --vex-text-3, border --vex-accent-border-strong, bg --vex-surface-0); needle still animating until the turn settles
- reasoning-end / answer-start: gutter node fires ONE vex-signal-resolve bloom (--dmx-bloom-level 0→1→0) synced to the answer block's mono→proportional type switch; then node rests still
- success (plain chat): no notice (reply renders in tape); node returns to dark, key returns to send-disabled (draft cleared)
- success (state-changing): info notice 'Stopped.' or 'Mission goal received.' in --vex-accent-text, role=status
- validation: empty/whitespace draft → submit is a no-op (no notice, button stays disabled)
- retryable provider error (known agent session): error notice (text-destructive) + inline Retry chip (--vex-accent-border 40% mix); draft NOT restored (held in retry payload); Retry disabled while a new turn is pending
- non-retryable error: error notice + draft RESTORED if input still empty (message not lost)
- gated (mission run active: running/paused_*): free-text submit blocked, error notice via gatedReason(runStatus); composer chrome stays still — mission controls live in MissionControls strip above
- plan unavailable: PLAN switch disabled with title — welcome (no session) 'Available once a session is open', or paused_plan_acceptance 'Unavailable while a mission is running'; lamp stays outline
- plan busy (setPlanMode in flight): PLAN disabled, no optimistic flip — server refusal snaps back on invalidate refetch
- pending-approval FREEZE (Law 4): if an inline approval is awaiting signature anywhere in the tape, the gutter needle FREEZES (animated={!awaitingApproval}) even if a turn is technically streaming — trust = stillness
- reasoning unsupported / unknown: REASON tag hidden entirely (sessionId null or supportsReasoning !== true); submit omits the reasoningEffort field
- offline / engine unreachable: handled upstream by runtime/runStatus gating; composer surfaces the resulting error notice, never a silent success

**Design tokens.** Surfaces: form bg --vex-surface-1 (#090e1d); send key & 'Stopping' bg --vex-surface-0 (#04060f); recessed wells (none here). Hairlines: form border --vex-line-strong (10%), chrome-row top border + quick-action dividers --vex-line (6%). Text trio: textarea/content text-foreground (--vex-text #e5e7eb), metadata --vex-text-2, placeholders/hint/disabled/index --vex-text-3 (#b5b7c0). Accent (rationed): focus rings ring-[var(--vex-accent)]; caret caret-[var(--vex-accent)]; focus-within border --vex-accent-border; live node + plan lamp solid --vex-accent; send-promoted border --vex-accent-border + text --vex-accent-text; send-hover bg --vex-accent-fill-8; STOP bg --vex-accent-fill-12 + border --vex-accent-border-strong + text --vex-accent-text; PLAN-ON bg --vex-accent-fill-8 + border --vex-accent-border + text --vex-accent-text; Retry border color-mix(--vex-accent 40% transparent). Bloom: --dmx-bloom-level (auto-tinted by the existing 01-base.css max(--dmx-bloom-level,--dmx-halo-level) drop-shadow). Pin/warn: none used here (no --vex-pin / --vex-warn-text in composer). Error: text-destructive (shadcn-projected). Radii: form rounded-xl, send key rounded-lg (--radius-lg 0.75rem region), PLAN/REASON rounded-[6px] (--radius-sm 0.375rem), Retry rounded-[3px], plan lamp rounded-[1px]. Borders: 1px throughout (border / border-t). Shadows: NONE (Depth Law — solid luminance + hairlines only). Typography: textarea text-[15px] leading-[1.7] Google Sans (--font-sans); all chrome microtype Geist Mono (--font-mono) uppercase 10–11px tracking-[0.14em] tabular-nums; trust letterpress mono 10px tracking-[0.28em]. Motion: vex-stroke-signing 1100ms cubic-bezier(0.45,0,0.25,1); MODE LINE base transition 240ms cubic-bezier(0.22,1,0.36,1); new vex-signal-submit-sweep ~520ms; new vex-signal-resolve ~640ms; chip transition-colors duration-[160ms]; vex-stamp-press 180ms ease-out.

**Component spec.** Outside-in. CONTAINER: <form data-vex-area=\"chat-composer\"> relative overflow-hidden rounded-xl border-[var(--vex-line-strong)] bg-[var(--vex-surface-1)] focus-within:border-[var(--vex-accent-border)]; left padding lifted to pl-7 so the spine gutter passes through (the textarea/chrome content sits to the right of the 28px axis). SPINE GUTTER + LIVE NODE: a new aria-hidden <span> absolutely positioned in the pl-7 gutter at top, a 2px-wide×16px-tall tick — bg-[var(--vex-line-strong)] at rest, bg-[var(--vex-accent)] + the dot-matrix needle class while in-flight, FROZEN when awaitingApproval; directly mirrors CountersignTick geometry (h-4 w-0.5) for axis continuity. MODE LINE (top edge): existing aria-hidden span.vex-sign-stroke absolute inset-x-0 top-0 h-px bg-[var(--vex-accent)]; planOn adds .vex-mode-line--on (scaleX(1) hold); submit toggles a one-shot .vex-mode-line--sweep class. CONTENT: <textarea> block w-full resize-none bg-transparent px-4 pt-3.5 pb-2 text-[15px] leading-[1.7] caret-[var(--vex-accent)] min-h-[52px] max-h-[200px] placeholder:text-[var(--vex-text-3)]; planOn swaps the placeholder copy. CHROME ROW: <div flex h-11 items-center gap-3 border-t border-[var(--vex-line)] px-3> holding, left→right: <PlanSwitch> (pending-decision grammar: MapPinIcon + 'Plan' + 5px lamp), <ReasoningSwitch> when supportsReasoning (quiet mono tag: AiBrain05Icon + 'Reason · Med', accent ONLY on non-default), the flexible hint <span min-w-0 flex-1 truncate font-mono text-[11px] uppercase tracking-[0.14em] text-[var(--vex-text-3)]>, and the SEND KEY (SEND_KEY_BASE fixed h-9 w-[68px] slot, three hard-cut states). METADATA: welcome-only trust letterpress <p> mono 10px tracking-[0.28em]. SECONDARY ACTIONS: notice row (role=alert|status) with inline Retry chip; ComposerQuickActions ledger below when transcript empty. RESPONSIVE: width fills the center column; textarea auto-grows via useLayoutEffect height-clamp (52–200px); the 68px send slot + truncating hint absorb width changes so the h-11 row never reflows; no horizontal scroll. PLAN vs REASON differentiation: PLAN keeps the accent fill (--vex-accent-fill-8) + solid lamp because plan-ON is a genuine PENDING DECISION (blue-rationing-eligible); REASON drops to a quieter treatment so a default 'Med' is pure hairline mono and only an explicit low/high override lights accent — they no longer read as the same control.

**Electron notes.** No custom title-bar drag region — native OS frame; the composer is ordinary content, no -webkit-app-region anywhere. Renderer is untrusted: every privileged call goes through window.vex.* — submit/stop use the existing useSubmitChat (mutateAsync/stop over window.vex IPC), plan toggle uses useSetPlanMode (invalidate-based IPC), runtime/model/plan reads use useRuntimeState/useSessionModel/useSessionPlan (cached TanStack queries, no new IPC, no schema change — id SERIAL PK + createdAt ISO already on TranscriptEntry). No Node/Electron/DB/Docker/wallet imports in this tree. CSP style-src 'self': all motion is class-toggle against build-time @keyframes in globals.css — NO runtime <style>, NO setAttribute('style')/cssText, NO dangerouslySetInnerHTML, NO inline style strings (the existing el.style.height auto-grow writes a single layout property imperatively, which is a DOM property write, not a CSP style-src violation, and is already in-tree). Icons stay @hugeicons (ArrowUp01Icon, StopCircleIcon, MapPinIcon, AiBrain05Icon, ArrowRight01Icon). OS differences: none — behavior identical across Win/macOS/Linux; reduced-motion honored via the global prefers-reduced-motion media block already in globals.css.

**Implementation.** 1) SPINE NODE: lift the form's left inset to pl-7 (matching TranscriptMessage's 28px gutter) so the axis is unbroken; the textarea and chrome row already sit inside the form, so wrap their column or add pl-7 to the form and compensate textarea px to keep visual rhythm. Add a live-node span in the gutter: `<span aria-hidden className={cn('pointer-events-none absolute left-[13px] top-[18px] h-4 w-0.5', submitPending && !awaitingApproval ? 'bg-[var(--vex-accent)] vex-needle-live' : 'bg-[var(--vex-line-strong)]')} />` — reuse CountersignTick's h-4 w-0.5 geometry verbatim; gate the animated class on `submitPending && !awaitingApproval` (Law 3/4). Thread an `awaitingApproval` boolean down from AppShell's existing animated={!awaitingApproval} gate; if not already available, read it from the same source the tape uses (do NOT invent new IPC). 2) MODE LINE SUBMIT SWEEP: keep the current span at SessionComposer.tsx:345-351; add a transient class on submit. In onSubmit, after setDraft(''), set a `sweep` state true and clear it on animationend (onAnimationEnd handler) so it is one-shot and rests still: `className={cn('vex-sign-stroke pointer-events-none absolute inset-x-0 top-0 h-px bg-[var(--vex-accent)]', planOn && 'vex-mode-line--on', sweep && 'vex-mode-line--sweep')}`. Add to globals.css beside vex-mode-line--on (line 405): `@keyframes vex-signal-submit-sweep { 0%{transform:scaleX(0);transform-origin:left} 55%{transform:scaleX(1);transform-origin:left} 60%{transform:scaleX(1);transform-origin:right} 100%{transform:scaleX(0);transform-origin:right} }` and `.vex-mode-line--sweep{ animation: vex-signal-submit-sweep 520ms cubic-bezier(0.22,1,0.36,1) both; }` — mirrors the existing vex-stroke-signing origin-flip trick (lines 359-376) so the retract is invisible; when planOn the --on rule holds scaleX(1) and the sweep is suppressed (don't add --sweep while planOn). 3) RESOLVE BLOOM (Law 5): add `@keyframes vex-signal-resolve { 0%{--dmx-bloom-level:0} 45%{--dmx-bloom-level:1} 100%{--dmx-bloom-level:0} }` and `.vex-needle-resolve{ animation: vex-signal-resolve 640ms ease-out both; }` — this is the SAME mechanism as the existing dmx-ripple keyframe (04-keyframes-core.css:1-12) which already animates --dmx-bloom-level, and the bloom auto-tints via the 01-base.css drop-shadow reading max(--dmx-bloom-level,--dmx-halo-level). Fire it on the gutter node at answer-start by toggling the class when the streaming turn transitions reasoning→answer (drive from the transcript/stream signal already feeding StreamingBubble — do not poll). The needle element must carry the .dmx-bloom context or be a DotmCircular8/DotmHex3 node so the drop-shadow applies; simplest reuse: render the live node as the existing cognition mark primitive rather than a bare span when in-flight. 4) PLAN vs REASON: PlanSwitch keeps its accent fill (pending-decision is blue-eligible); in ReasoningSwitch, KEEP the nonDefault accent branch but verify the DEFAULT branch is pure hairline (`border-[var(--vex-line-strong)] text-[var(--vex-text-3)]`, NO fill) — it already is (ReasoningSwitch.tsx:67), so the only change is conceptual/guard: ensure no future edit gives default-REASON an accent-fill. 5) GUARD/LOCK (Plan composer-only): extend shell-design-guard.test.ts (the raw-text BANNED scanner at line 109) with a positive assertion test that PlanSwitch is the ONLY useSetPlanMode caller and that getSessionTitle/SessionCreator/session-row sources contain no plan field — pin 'plan stays composer-only'. 6) REDUCED MOTION: all three new keyframes are covered by the global prefers-reduced-motion block (globals.css:441) which forces duration 0.01ms + iteration 1, collapsing sweep/resolve to their final frame; add an explicit `@media (prefers-reduced-motion: reduce){ .vex-needle-live{animation:none} .vex-needle-resolve{animation:none; --dmx-bloom-level:1} }` so the live needle is a STATIC lit tick and resolve is an instant lit reveal (mirrors the existing vex-sign-stroke--signing reduced-motion treatment at lines 386-392).

**Motion specs.**

| Name | Trigger | Technique | Duration/easing | Reduced-motion |
| --- | --- | --- | --- | --- |
| Gutter live needle (in-flight) | submitPending === true AND awaitingApproval === false (provably bound to engine work; frozen on pending-approval per Law 4) | Reuse the existing dot-matrix needle: render the gutter node as a DotmCircular8/DotmHex3 cognition mark (or a span carrying the .dmx-bloom context) animated by the in-tree dmx keyframes; class toggled in React, build-time @keyframes only (CSP style-src 'self'). Color via --vex-accent; bloom auto-tints through the 01-base.css drop-shadow. | existing dmx loop cadence (infinite while in-flight, frozen otherwise) — no new timing | animation:none → static lit accent tick (still reads 'in progress'), per the global reduce block + an explicit .vex-needle-live override |
| MODE LINE submit sweep | onSubmit fires a chat turn (one-shot; suppressed while planOn holds the line at scaleX(1)) | Toggle .vex-mode-line--sweep on the existing top-edge span; new build-time @keyframes vex-signal-submit-sweep does scaleX 0→1 then origin-flips left→right and retracts to 0 (invisible flip, same trick as the in-tree vex-stroke-signing). Cleared on onAnimationEnd so it rests still. No inline styles. | 520ms cubic-bezier(0.22,1,0.36,1) | global 0.01ms duration rule collapses it to the final (retracted) frame; the line simply does not visibly sweep — submit still registers via the send-key hard-cut |
| Needle bloom-and-resolve | streaming turn transitions reasoning-end → answer-start (the signature resolve moment, Law 5), synced to the answer block's mono→proportional type switch | One-shot .vex-needle-resolve via new build-time @keyframes vex-signal-resolve ramping --dmx-bloom-level 0→1→0 (identical mechanism to the existing dmx-ripple keyframe); the bloom is auto-tinted by the existing max(--dmx-bloom-level,--dmx-halo-level) drop-shadow. CSP-safe (no runtime style). | 640ms ease-out, both | animation:none with --dmx-bloom-level:1 held → instant static lit reveal, no ramp |
| Send key hard-cut (send↔stop↔stopping) | submitPending / stopRequested state changes | Conditional render of three buttons in one fixed SEND_KEY_BASE 68px slot; the swap is an instant DOM replace with NO transition on the swapped element (transition-colors applies only within a state, not across the cut) so the chrome row never shifts. | instant (0ms) on swap; 160ms color transition within a state | unaffected (already instant) |
| PLAN lamp / plan-ON line hold | planOn toggles | Existing .vex-mode-line--on holds scaleX(1) (source-order win over the base scaleX(0)); the 5px lamp swaps border→solid --vex-accent via transition-colors duration-[160ms]. Class toggle only. | 160ms (lamp color) + the 240ms base draw transition when the line first draws in | global rule collapses transitions to 0.01ms — line/lamp snap to the ON state instantly |

**Polish pass.**

_More premium:_

- Make the spine literal: render the in-flight gutter node as an actual dot-matrix cognition mark (DotmCircular8/DotmHex3) so the composer's 'newest node' uses the exact same texture as streaming tape nodes — the eye reads one continuous instrument axis, not an input box bolted under a chat log.
- Sync the resolve bloom to the answer block's Geist Mono → Google Sans switch so the needle's single blue bloom and the type 'settling' from instrument-mono to readable proportional happen as ONE event — the moment the agent stops thinking and starts answering becomes a felt, premium beat instead of a spinner stopping.
- Ration blue so hard that the resting deck is monochrome hairline + the text trio: at idle there is zero accent fill anywhere (PLAN lamp outline, REASON default pure mono, send disabled gray, node dark) — the first blue the operator ever sees is their own focus ring, then the live needle. Scarcity makes the in-flight blue read as a real signal.

_Cut clutter:_

- Plain chat sends show NO notice (submitSuccessText returns null) — the reply already renders in the tape, so the area below the input stays empty instead of stacking redundant 'Message sent.' confirmations.
- Collapse REASON's default state to pure hairline mono (no fill, no lamp) so only a deliberate low/high override carries weight — a default 'Med' is silent telemetry, removing a second always-lit accent chip competing with PLAN.
- Keep PLAN as the SOLE plan control and absorb SessionPlanCard into an inline PLAN BRIEF tape entry — the floating plan card disappears, so plan state lives in exactly one place on the chrome row and one place on the spine, not duplicated as a hovering panel.

_Generic traps to avoid:_

- A pill-shaped input with a circular gradient/glowing send FAB and a permanent blue 'Send' fill — Vex's send key is a fixed-slot square instrument that is GRAY until the draft is valid and only borders blue; no resting fill, no glow (Depth Law), no FAB.
- Ambient decoration: a shimmering border, a pulsing 'AI is ready' glow, or an animated gradient underline at rest. Motion here is provably bound to in-flight engine work and frozen otherwise — anything that animates while idle is the generic-template tell.
- Treating PLAN and REASON as identical accent toggle-chips (both lit blue). They must read differently: PLAN = pending-decision (accent fill + lamp), REASON = quiet mono telemetry tag (hairline by default) — sharing one accent fill is exactly the undifferentiated SaaS look the redesign kills.

**Files touched:** `vex-app/src/renderer/features/appShell/SessionComposer.tsx`, `vex-app/src/renderer/features/appShell/PlanSwitch.tsx`, `vex-app/src/renderer/features/appShell/ReasoningSwitch.tsx`, `vex-app/src/renderer/styles/globals.css`, `vex-app/src/renderer/features/appShell/__tests__/shell-design-guard.test.ts`


---

## Section 9 — Approvals · Mission & Runtime trust surfaces

> _Recon area: Approvals, Mission & Runtime trust surfaces (Signal Tape highest-trust chrome): ApprovalCard + ApprovalDecisionActions + ApprovalDetails, ApprovalsRegion, MissionContractCard + MissionContractCardSections, MissionControls, RuntimeLedger, SessionRuntimeBar (ModelIndicator + UsageChip + ContextMeter + CompactionChip)._

**Intent.** These are the surfaces where Vex stops being a chat and asks the user to put their pen to an irreversible on-chain action (approve a mutating tool call), to lock a mission contract, to drive an active run, and to read the runtime's vital signs. They carry the most consequence per pixel in the whole product, so they must read as instrument-grade notary chrome: still at rest, blue only when the page is genuinely asking for a signature, every number tabular and mono, and the act of committing rendered as a physical LOCK stamp. The redesign re-homes approvals INLINE in the tape at the point-of-cause (no floating region of its own), freezes all ambient motion the instant a decision is pending, fixes SessionRuntimeBar's off-brand tokens (--color-text-muted, raw #f0a0a0), and demotes the telemetry pills to hairline readouts so the single context-usage bar is the only accent the runtime row ever lights.

**UX structure.** Placement: all four live inside the 860px-max session column in SessionPanel (vex-app/.../SessionPanel.tsx:99-127), stacked transcript -> approvals -> mission-controls -> composer, with the runtime bar carried in SessionContext's strip and the runtime ledger in the sidebar's last line. The redesign keeps that vertical order but rebinds approvals to the ONE SPINE: the ApprovalCard becomes a tape entry that hangs off the same 28px timeline gutter (reuse the pl-7 + CountersignTick slot, TranscriptMessage.tsx:50-58,107) at the sequence position of the tool call that paused the run, rather than a bounded scroll box wedged above the composer. ApprovalsRegion stops being a visible container (it loses its border-t/max-h box) and becomes a pure placement/focus controller that injects each card as a gutter-docked entry. Interaction model: two-step confirm survives verbatim (first click ARMS, second within CONFIRM_RESET_MS=4000 COMMITS; armedAction state in ApprovalCard.tsx:74-81 is unchanged) — the redesign only restyles arm vs commit and adds the LOCK stamp on commit. Keyboard model: Reject keeps first-mount focus (least-destructive; rejectRef, ApprovalCard.tsx:62,86-90), Tab moves Reject->Approve, focus ring is the one sanctioned accent ring (focus-visible:ring-[var(--vex-accent)]), region stays tabIndex={-1} programmatic target for the act-ledger stamp-link jump (ApprovalCard.tsx:188); MissionControls toolbar buttons are a single tab group; the AutoRetry switch keeps role=switch/aria-checked. What animates vs stays still: at rest EVERYTHING is still — no glow, no shimmer. The only motion permitted in this area is (1) the dot-matrix needle in the streaming node, which is FROZEN the instant any approval is pending (animated={!awaitingApproval} already wired at StreamingBubble.tsx:203,210 — extend the same gate so the whole column freezes), (2) the one-shot needle bloom-and-resolve on answer-start, and (3) the one-shot vex-stamp-press LOCK on commit plus the single vex-intro-glint countersign. Trust = stillness is the governing law here: a pending decision must make the page go quiet.

**States.**

- Approval idle (pending, not armed): accent hairline border on the gutter node + 'AWAITING SIGNATURE' mono stamp; ALL column motion frozen (needle static-lit); Reject focused on first mount.
- Approval armed (high-risk first click): only the clicked button swaps to the danger-mix border + 'Click again to confirm' copy; 4s arm timeout resets to idle (ApprovalCard.tsx:77-81).
- Approval committing (inFlight): both buttons disabled (disabled:opacity-50), no spinner — stillness holds; the commit is a single transaction, not a loading state.
- Approval success: one-shot vex-stamp-press LOCK stamp prints over the stamp area + single vex-intro-glint countersign (signedGlint, ApprovalDetails.tsx:78-84), THEN invalidateOnResolve refetches and the card resolves to a notarized tape entry; race-safe (glint is a grace note, ApprovalCard.tsx:93-97).
- Approval reject success: card resolves with NO light (one-light rule — reject never glints), tape entry reads as withdrawn.
- Approval application error (Result.ok===false): inline role=alert in the recessed well with --color-destructive border-mix + danger/10 fill (ApprovalDetails.tsx:110-117); NOT auto-retried (retry:false).
- Approval load error (region query failed): role=alert hairline line, no box.
- Approval empty: region returns null (no pendings) — renders nothing, never an empty container.
- Mission setup-needed: Target02 icon accent-text, 'SETUP NEEDED' tone-3 hairline stamp, footer disables Accept.
- Mission awaiting-acceptance: InformationCircle accent, accent-border stamp, footer Accept key (accent hairline, quiet until hover).
- Mission accepted: CheckmarkCircle02 success, success-border stamp, footer points to Start.
- Mission dirty-acceptance: warning tone stamp 'CONTRACT CHANGED', re-accept footer.
- Mission accept pending: footer button 'Accepting...' disabled.
- Mission controls active-run toolbar: Continue/Recover/Edit gated on runtime.status, Stop always; disabled while anyPending OR pendingControlKind!==null (MissionControls.tsx:209-217).
- Mission controls refusal outcome: ok:true classified outcome -> friendly role=alert notice line (noticeFor/renewNoticeFor), never a silent no-op.
- Mission controls Start/Renew idle: full-width accent-hairline PRIMARY_KEY.
- Runtime ledger connecting/ok/degraded/unavailable: flat dot bg-warning/success/destructive (RuntimeLedger.tsx:71-95), no glow.
- Runtime bar model unconfigured: muted 'Model not configured' readout.
- Runtime bar context no-limit: token count without a bar (invalid AGENT_CONTEXT_LIMIT).
- Runtime bar compaction running/queued/failed: hairline readout; failed uses --vex-warn-text (was raw #f0a0a0); hidden when nothing in flight.
- Permission-denied (restricted session): MissionContractCard hides AutoRetry toggle (permission!=='full', MissionContractCard.tsx:106); server stays authority.
- Offline/runtime-unavailable: ledger dot destructive + approvals/mission controls show their refusal/error lines from the same Result path.

**Design tokens.** Surfaces: --vex-surface-1 #090e1d (card bodies), --vex-surface-2 #0f1729 (raised/popover, unused here unless a readout expands), --vex-surface-down #02040a (recessed critical-args well + every telemetry readout track). Hairlines: --vex-line (6%) for internal dividers, --vex-line-strong (10%) for resting button/stamp borders and the mission card outer border. Text trio: --vex-text #e5e7eb (none in chrome microtype), --vex-text-2 #d4d6dc (metadata, sublines, quiet button text), --vex-text-3 #b5b7c0 (stamp labels, field labels, group headers, ledger dot label fallback). Accent family (BLUE RATIONING — only these four uses: pending node, awaiting-signature stamp, focus ring, the single primary CTA): --vex-accent #3275f8 (focus ring, context bar fill, gutter pending node, CountersignTick), --vex-accent-text (CTA/stamp text), --vex-accent-border / --vex-accent-border-strong (hairline keys), --vex-accent-fill-8 / --vex-accent-fill-12 (hover fills only). NEW semantic tokens this spec ADDS to [data-vex-shell] in globals.css: --vex-warn-text (replaces raw #f0a0a0 in CompactionChip failed state and is the canonical warn text) and --vex-pin (tokenized warm flag, replaces raw #ffd35c) — defined as solid hexes in the shell scope alongside --vex-text-3 (globals.css:267). Danger/success/warning via existing color-mix grammar: border-[color-mix(in_oklab,var(--color-destructive)_40%,transparent)] + bg-destructive/10 (the ONE sanctioned danger fill), --color-success / --color-warning mixes (already in risk.ts:42-55 and headerMeta). Replace --color-text-muted (SessionRuntimeBar.tsx:76,120,166,326) with --vex-text-3. Radii: --radius-md (0.5rem) on cards/keys via rounded-md/rounded-lg; stamps stay rounded-[3px]; recessed wells rounded-[6px]. Borders: 1px hairline only. Shadows: NONE (DEPTH LAW). Motion: durations 180ms (vex-stamp-press, vex-entry-settle), 350ms (vex-intro-glint), easing ease-out; vex-signal-resolve (new) ramps --dmx-bloom-level 0->1->0 over ~520ms ease-out. Typography: --font-mono (Geist Mono) for ALL stamps/labels/telemetry uppercase 10-13px tracking 0.14-0.3em tabular-nums; --font-sans (Google Sans) for mission goal/answer prose; --font-display (Poppins) not used in this area.

**Component spec.** Container: each consequential surface is a borderless or hairline-only section on --vex-surface-1, NO shadow, NO gradient. (1) ApprovalCard re-anchors to the spine: outer <section> drops its standalone rounded-lg accent box and instead renders as a gutter-docked tape entry — wrap in `relative pl-7` and place a pending-state node (accent square, the same 28px slot CountersignTick uses) in the gutter; the card body sits to the right as a hairline panel (border border-[var(--vex-line)] when idle, border-[var(--vex-accent-border)] ONLY while pending = 'asking for your pen'). Header row (ApprovalDetails): mono 13px title `namespace:tool`, then risk stamp (riskChipClasses) + action stamp + the awaiting-signature stamp ('AWAITING SIGNATURE', mono 10px tracking-[0.18em] text-[var(--vex-accent-text)] border-[var(--vex-accent-border)]). Body: italic reasoning preview (text-2), then the recessed critical-args well (bg-[var(--vex-surface-down)] rounded-[6px], mono 11px, dt uppercase text-3 / dd break-all text-2) — this is 'the facts being signed for'. Footer (ApprovalDecisionActions): right-aligned Reject (quiet hairline) + Approve (accent hairline, the single primary CTA). (2) Header controls: none beyond the stamps; the only control is the footer two-step. (3) Content: args well + reasoning. (4) Metadata: timeline HH:MM + sequence index in the gutter (reuse AssistantCaption mono tabular grammar). (5) Secondary actions: none — approvals are deliberately single-purpose. (6) MissionContractCard outer border softens to --vex-line-strong (already correct), header NOTARY stamp grammar unchanged; CardFooter Accept stays the quiet accent-hairline key; AutoRetry switch stays role=switch. MissionControls toolbar = a flex-wrap row of hairline keys, Stop the only danger-toned key. SessionRuntimeBar = a single flex-wrap row of HAIRLINE INSTRUMENT READOUTS: ModelIndicator (brand icon + mono id), UsageChip (mono tabular ↑/↓/⚡/Σ/$), ContextMeter (the ONE accent bar — h-1.5 w-12 track bg-[var(--vex-surface-down)] with bg-[var(--vex-accent)] fill), CompactionChip (mono, failed -> --vex-warn-text). RuntimeLedger = flat dot + mono uppercase label + Docker/Postgres glyphs, collapsed = dot-only. (7) Responsive/resizable: the 860px column is fixed-center; readouts flex-wrap on narrow widths; the approval gutter node and pl-7 inset are width-independent; collapsed sidebar reduces RuntimeLedger to a centered dot with title-attr.

**Electron notes.** Native OS frame — NO custom title-bar drag region anywhere in this area (no -webkit-app-region). Renderer is untrusted: every privileged action routes through window.vex.* preload methods — approvals call window.vex.approvals.{approve,reject} (via useApprove/useReject, ApprovalCard.tsx:31,60-61), mission controls call window.vex mission channels (useMissionStart/Continue/Retry/Edit/Stop/Renew/AcceptContract/SetAutoRetry, MissionControls.tsx:37-47, MissionContractCard.tsx:28-33), runtime/usage/compaction/health read via window.vex usage/compaction/sessions/system channels (SessionRuntimeBar.tsx:36-46, RuntimeLedger.tsx:16). All decisions are authorized server-side: the engine re-validates the contractHash on acceptContract (rejects on drift, MissionContractCard.tsx:14-16,95-101) and refuses auto-retry for restricted sessions even if the toggle were forced — UI hiding it (permission!=='full') is convenience, NOT the security boundary. Result.ok===false MUST surface inline (TanStack isError does not catch app-level Result failures) — preserve every existing inline-error/notice path. CSP style-src 'self': the LOCK stamp, glint, needle bloom, and context bar all use stylesheet @keyframes + Tailwind classes; the ONLY inline style permitted is the context-bar width (style={{ width: `${pct}%` }}, SessionRuntimeBar.tsx:279) which is a single dynamic numeric and already in use — no other setAttribute('style')/cssText/dangerouslySetInnerHTML. OS differences: none specific; reduced-motion honored via the global @media rule (globals.css:441-450).

**Implementation.** 1) NEW TOKENS (globals.css, inside [data-vex-shell] near :267): add `--vex-warn-text: #f0a0a0;` and `--vex-pin: #ffd35c;` (solid hexes, DEPTH-LAW compliant). 2) SessionRuntimeBar.tsx token fix: replace every `var(--color-text-muted)` with `var(--vex-text-3)` (lines 76, 120, 166), and CompactionChip failed branch `text-[#f0a0a0]`->`text-[var(--vex-warn-text)]` (line 325). Change the bar wrapper className text color to `text-[var(--vex-text-3)]`. Demote pills to hairline readouts: PILL const -> add `border border-[var(--vex-line)]` and swap any white/[0.12] track to `bg-[var(--vex-surface-down)]` (ContextMeter track at line 274: `bg-white/[0.12]`->`bg-[var(--vex-surface-down)]`); the ContextMeter fill stays `bg-[var(--vex-accent)]` — it is the single accent bar. Add `tabular-nums` to the UsageChip numeric spans and the ctx pct span. 3) NEW keyframe vex-signal-resolve (globals.css, beside vex-stamp-press :179): `@keyframes vex-signal-resolve { 0%{--dmx-bloom-level:0} 45%{--dmx-bloom-level:1} 100%{--dmx-bloom-level:0} }` + `.vex-signal-resolve{ animation: vex-signal-resolve 520ms ease-out both }` — the existing 01-base.css drop-shadow reads max(--dmx-bloom-level,--dmx-halo-level) so the gutter node auto-tints; reduced-motion already collapses it via the global rule (add an explicit `@media (prefers-reduced-motion:reduce){ .vex-signal-resolve{ animation:none; --dmx-bloom-level:1 } }` for a static lit needle). 4) Approvals inline dock: in ApprovalsRegion.tsx drop the visible container (remove the `max-h-[40vh] border-t border-[var(--vex-line)]` box) and render each ApprovalCard as a gutter entry; in ApprovalCard.tsx wrap the <section> body in `relative pl-7` and add a pending node `<span aria-hidden className="absolute left-0 top-[5px] h-4 w-0.5 bg-[var(--vex-accent)]" />` (mirror CountersignTick) while pending. Keep the outer border conditional: `border border-[var(--vex-line)]` resolved vs `border-[var(--vex-accent-border)]` while pending — the accent border IS the 'asking for your pen' signal (BLUE RATIONING). 5) LOCK stamp on commit: in ApprovalDetails.tsx, when signedGlint is set, render alongside the glint a one-shot LOCK using the EXISTING `.vex-stamp-press` class on a small mono 'LOCKED' stamp + Hugeicons lock glyph (no new keyframe needed); keep the glint (vex-intro-glint) as the countersign. 6) Freeze motion shell-wide on pending: the gate already exists (animated={!awaitingApproval}, StreamingBubble.tsx:203,210). Thread hasPendingApproval down so the dot-matrix needle and any vex-sign-stroke in this column are gated off while ANY approval is pending — i.e. compute it once in SessionPanel from the same usePendingApprovals query and pass an `awaitingApproval` prop, OR keep the existing SessionTranscript hasPendingApproval (SessionTranscript.tsx:321) as source of truth and ensure MissionControls/SessionRuntimeBar do not introduce new resting animations. 7) Two-step confirm + arm/commit styling: ApprovalDecisionActions stays the SOLE place — DO NOT touch the gate logic (ApprovalCard.tsx:155-170); only restyle ARMED_BORDER (already danger-mix) and ensure the commit click triggers the stamp via the existing setSignedGlint(true) path (ApprovalCard.tsx:126). 8) Guard test: extend BANNED in shell-design-guard.test.ts (:69-77) with the now-retired raw hexes `#f0a0a0` and `#ffd35c` and `--color-text-muted` usage in shell files so they can never reappear; SessionRuntimeBar is in scope (../**/*.tsx). 9) Mission/runtime: MissionControls + MissionContractCard already token-clean — leave logic untouched; only confirm no resting blue fill (PRIMARY_KEY uses accent-border + hover fill only, MissionControls.tsx:55-56 — compliant). Files/lines above are the exact change points; reuse vex-stamp-press, vex-intro-glint, vex-fade-top, CountersignTick, riskChipClasses, headerMeta verbatim.

**Motion specs.**

| Name | Trigger | Technique | Duration/easing | Reduced-motion |
| --- | --- | --- | --- | --- |
| Needle freeze on pending approval | Any approval enters paused_approval / pending state for the active session | Boolean prop gate (animated={!awaitingApproval}) that removes the dot-matrix animation class on the streaming node — no new CSS; the needle holds its static lit frame (DotmCircular8/DotmHex3 animated=false, StreamingBubble.tsx:203,210), and no other element in the column animates while pending (TRUST=STILLNESS). | instant (state-driven class removal, 0ms) | Already static — identical behavior; needle is a still lit mark either way. |
| Needle bloom-and-resolve (signature motion) | reasoning-end / answer-start on the gutter node (mono->proportional type switch on the answer block) | One-shot .vex-signal-resolve class ramps --dmx-bloom-level 0->1->0 via stylesheet @keyframes (CSP-safe); the 01-base.css drop-shadow reads max(--dmx-bloom-level,--dmx-halo-level) so the node self-tints, then rests still (both) | 520ms ease-out, one-shot | @media reduce: animation:none + --dmx-bloom-level:1 (static lit needle) + instant content reveal — no ramp. |
| LOCK stamp-press on approve commit | Successful approve (Result.ok, signedGlint set before invalidation, ApprovalCard.tsx:123-127) | Existing .vex-stamp-press @keyframes (opacity 0->1 + scale 1.15->1) applied once to a mono 'LOCKED' stamp; stylesheet keyframes, ends at final frame (animation-fill both), unmount-race-safe | 180ms ease-out, one-shot | Global 0.01ms rule collapses to final frame — stamp appears instantly, fully opaque, no scale. |
| Countersign glint on approve commit | Same approve-success tick as the LOCK (signedGlint, ApprovalDetails.tsx:78-84) | Existing .vex-intro-glint @keyframes (opacity+scale flare, ends transparent forwards) on a 1.5px accent dot — the ONLY light in the approvals flow (reject never sets it) | 350ms ease-out, one-shot, ends transparent | Global rule collapses to final (invisible) frame — no flare; resting state is identically still. |
| Inline approval entry settle | A newly-paused approval docks into the tape at its point-of-cause | Reuse .vex-entry-settle @keyframes (opacity 0->1 + translateY 3px->0) on first mount only, matching how live transcript rows settle (SessionTranscript.tsx:312) | 180ms ease-out, one-shot both | Global rule collapses to final frame — instant placement, no slide. |

**Polish pass.**

_More premium:_

- Make the LOCK a physical event: the vex-stamp-press 'LOCKED' mono stamp printing over the stamp area (scale 1.15->1, 180ms) plus the single accent countersign glint turns an approve from a button click into a notarized act — the user FEELS the irreversibility land.
- Freeze the whole column the instant a decision is pending: killing the needle and every other motion (TRUST=STILLNESS) makes the page hold its breath, which reads as gravitas no SaaS approval modal achieves.
- Tabular-nums everything in the runtime readouts (token counts, %, cost) and align the context bar as the single accent instrument — a quiet hairline gauge row that reads like aircraft instrumentation, not a dashboard.

_Cut clutter:_

- Delete the ApprovalsRegion container chrome (the max-h-[40vh] border-t box) — docking each card inline on the spine removes a redundant nested frame and one scroll context.
- Demote the telemetry pills from filled chips to hairline readouts (border --vex-line, recessed --vex-surface-down tracks) so the context bar is the ONLY accent in the runtime row — one signal, not five competing chips.
- Drop --color-text-muted and the two raw hexes (#f0a0a0/#ffd35c) for tokenized --vex-text-3 / --vex-warn-text / --vex-pin so the runtime bar speaks one color vocabulary instead of leaking the global theme's muted gray.

_Generic traps to avoid:_

- Leaving approvals as a floating bordered card stack above the composer — that reads as a generic toast/banner region; docking inline on the timeline gutter is what makes it Vex.
- Adding a spinner or pulsing dot during commit — motion during a pending/committing decision violates TRUST=STILLNESS and instantly looks like a template form; the surface must go quiet, not busy.
- Painting resting blue fills on the Approve/Accept/Start keys (or a glow on the LOCK) — BLUE RATIONING + DEPTH LAW require accent only as hairline + hover fill and zero resting shadow; filled blue CTAs are the #1 generic-SaaS tell.

**Files touched:** `vex-app/src/renderer/styles/globals.css`, `vex-app/src/renderer/features/appShell/ApprovalCard.tsx`, `vex-app/src/renderer/features/appShell/ApprovalsRegion.tsx`, `vex-app/src/renderer/features/appShell/ApprovalCard/ApprovalDetails.tsx`, `vex-app/src/renderer/features/appShell/ApprovalCard/ApprovalDecisionActions.tsx`, `vex-app/src/renderer/features/appShell/SessionRuntimeBar.tsx`, `vex-app/src/renderer/features/appShell/RuntimeLedger.tsx`, `vex-app/src/renderer/features/appShell/MissionContractCard.tsx`, `vex-app/src/renderer/features/appShell/MissionContractCardSections.tsx`, `vex-app/src/renderer/features/appShell/MissionControls.tsx`, `vex-app/src/renderer/features/appShell/SessionPanel.tsx`, `vex-app/src/renderer/features/appShell/SessionTranscript.tsx`, `vex-app/src/renderer/features/appShell/__tests__/shell-design-guard.test.ts`


---

## Section 10 — Memory panels

> _Recon area: Memory panels — the seven read-only sections of the Memory view (Long-term memory, Memory candidates, Manager decisions, Memory jobs, Session memory, Compaction history, Memory & privacy), composed by MemoryPanel.tsx and reached via MemoryButton in the sidebar registry footer / MemoryMarker recall interruptions in the tape._

**Intent.** The Memory view is Vex's transparency ledger: a read-only register where the user audits everything the autonomous agent remembers and every automatic decision its memory manager made — long-term lessons, proposed candidates, promote/reject verdicts, the durable job queue, per-session memory, compaction generations, and the privacy/redaction disclosure. Its job is trust through legibility, not control: the only mutation in the whole view is the single Retry on a permanently-failed compaction generation. For the Signal Tape redesign this view is already on-brand and guard-clean (hairline ledger groups, mono microtype, quiet PILL stamps, no card boxes), so the work is light-touch: dot-matrix section separators at <=6% accent tint, .vex-fade-top masking on long lists, collapsible sections to tame the seven-section scroll, and tabular-nums alignment on every count/timestamp — read as instrument telemetry, not a dashboard. Per Law 10 it is hosted on demand (the back-keyed full-screen register today; optionally relocatable into the BOOK panel) and never animates ambiently.

**UX structure.** Placement: MemoryPanel renders as the 3rd branch of AppShell's view switch (AppShell.tsx:61) inside the content column, under the same h-12 DESK RULE datum the rest of the shell uses. Its own header is a register header (MemoryPanel.tsx:43) with a quiet ArrowLeft01Icon back key (setAppShellView("session")) and a mono uppercase "MEMORY" title at tracking-[0.3em]. Body is a single scroll container (overflow-y-auto, px-6 py-6) holding a max-w-[760px] centered column; the seven sections stack as hairline-separated ledger groups via the shared SECTION constant (border-b border-[var(--vex-line)] py-6) so the page reads as one continuous register, not seven cards. Interaction model: read-only inspection with three local affordances per the existing code — status filter chips (Long-term/Candidates/Decisions), a client-side search input (Long-term only), and the one Retry button (Compaction). Redesign adds: each section header becomes a collapse toggle (button, aria-expanded, chevron) reusing the ToolDisclosure pattern; long lists get a top fade mask. Keyboard model: Tab order = back key -> per-section header toggle -> that section's filters/search -> rows are non-interactive text except Retry which is focusable; every interactive control already carries focus-visible:ring-2 ring-[var(--vex-accent)] (the only resting blue, per Law 2). Esc on the search input clears via native search. What animates vs stays still: NOTHING rests-animates here (Law 3) — the view has no in-flight engine binding, so there is no needle. The only motion is one-shot: section collapse/expand height transition (or instant under reduced motion) and the existing vex-stamp-press re-read as a LOCK stamp when the Retry mutation resolves to success. Filters and the back key use color transition-colors only. The dot-matrix separators are STATIC texture (no animation), honoring Law 7's "never a resting full-surface pattern."

**States.**

- Idle/loaded: hairline ledger rows; counts and timestamps in tabular-nums mono; PILL stamps at rest are hairline --vex-line, never accent.
- Loading (per section): existing Loading component — recessed --vex-surface-down well, border --vex-line, role=status aria-live=polite, e.g. 'Loading candidates…'.
- Success: rows render; live regions settle silently (no entry-settle animation in this read-only register — vex-entry-settle is reserved for the live tape).
- Empty — feature-level: Empty component (text-[var(--vex-text-3)]) e.g. 'No candidates match.', 'No memory jobs yet.'
- Empty — session-scoped not active: Session memory and Compaction history show 'Open a session to view…' and issue NO session-scoped query (gated in MemoryPanel via activeSessionId).
- Empty — collapsed: a collapsed section header still shows its count badge so the user knows there is content without expanding.
- Validation/filter-zero: filtered list with no matches -> 'No memory entries match.' / 'No candidates match.' (distinct from the never-populated empty).
- Permission-denied / privilege: not applicable in renderer — all data is sanitized DTO from main via window.vex.* IPC; the view never holds raw bodies, embeddings, decision_hash, evidence_refs, or last_error text.
- Unavailable: model unconfigured -> Memory & privacy shows 'The memory builder is idle until an OpenRouter model is configured.'
- Retryable error: section query fails -> ErrorState (border-destructive/35 bg-destructive/10, role=alert) with the mapped error.message; section can be re-collapsed/re-expanded to refetch via TanStack Query.
- Non-retryable vs retryable action: Compaction Retry is offered ONLY for status==='permanently_failed' rows; in-flight it is disabled (disabled:cursor-not-allowed, label 'Retrying…'); a failed retry surfaces an inline ErrorState above the list.
- Success-commit (Retry): on ok resolve, the affected gen row fires ONE vex-stamp-press re-read as a LOCK stamp on its status pill, then rests still (Law 4).
- Offline-degraded: queries return mapped ok:false -> ErrorState; no optimistic state, no silent fallback (Law 10 of core rules).
- Cancellation: collapsing a section while a query is in flight does not cancel the IPC; the result is cached by TanStack Query and shown on re-expand.
- Awaiting-approval (shell-wide freeze): this view has no approval surface, but if a pending approval is docked inline in the tape, the global animated={!awaitingApproval} gate already freezes the only would-be motion (the LOCK stamp defers); the register stays still by default so it satisfies Law 4 trivially.

**Design tokens.** Surfaces: --vex-surface-1 (panel ground, inherited), --vex-surface-down (#02040a recessed wells — Loading state, search input, expanded disclosure body). Hairlines: --vex-line (6%, all SECTION borders, row separators, PILL borders, recall indicator rules) / --vex-line-strong (10%, search input border, disabled Retry border). Text: --vex-text (#e5e7eb via `text-foreground` for row titles/values) / --vex-text-2 (#d4d6dc metadata, sublines, pill text) / --vex-text-3 (#b5b7c0 section headers, placeholders, timestamps, tags, disabled). Accent (RATIONED, Law 2): --vex-accent (#3275f8) ONLY on focus-visible:ring-2 and active filter via --vex-accent-fill-12 + --vex-accent-text; Retry key uses --vex-accent-border / --vex-accent-border-strong / --vex-accent-fill-8 / --vex-accent-text (the one CTA). Dot-matrix separator tint: color-mix(in oklab, var(--vex-accent) 6%, transparent) — within Law 7's <=6-8% band; the dot glyph reuses DotmSquare3/DotmHex3 currentColor pattern, NEVER a radial-gradient fill. Destructive: destructive/35 border, destructive/10 fill, text-destructive (ErrorState). Radii: rounded-[6px] = --radius-sm (back key, Loading well, search, disclosure body, MemoryMarker content), rounded-[3px] (PILL stamps, filter chips, Retry, tags). Typography: --font-mono (Geist Mono) for ALL instrument microtype — section headers text-[10px] uppercase tracking-[0.3em], filter chips text-[10px] tracking-[0.14em], PILL text-[10px], timestamps text-[10px] tabular-nums, register title text-[13px] tracking-[0.3em]; --font-sans (Google Sans) for row titles/summaries/prose (text-xs/text-[11px]). Motion tokens: vex-stamp-press (180ms ease-out) for the Retry LOCK stamp; collapse uses grid-template-rows transition 180ms ease-out (matching vex-entry-settle/cascade timing). NO gradients-as-fill, NO shadow/glow, NO backdrop-filter (Law 9, guard-pinned). Hover: hover:bg-white/[0.04] (back key, chips), hover:bg-white/[0.035] (MemoryButton).

**Component spec.** Container: MemoryPanel — flex h-full min-h-0 flex-col; header (h-12, border-b --vex-line, back IconButton + mono title); scroll body (min-h-0 flex-1 overflow-y-auto px-6 py-6) > centered column (mx-auto w-full max-w-[760px] flex flex-col) holding the seven sections in their current order. Header per section (new collapsible wrapper, applied uniformly via a small panel-local MemorySectionShell added to MemoryPanelShared.tsx): a <button aria-expanded aria-controls> row containing (a) ArrowRight01Icon size=12 rotate-90 when open (reuse ToolDisclosure idiom), (b) the existing mono uppercase tracking-[0.3em] --vex-text-3 h2 label, (c) a right-aligned count badge (PILL) showing the section's item/queue count in tabular-nums, kept visible while collapsed. Below the toggle: the existing one-line --vex-text-2 description, then controls (filter chip row / search input where present), then content. Controls: filter chips unchanged (rounded-[3px] mono text-[10px] tracking-[0.14em]; active = bg --vex-accent-fill-12 text --vex-accent-text); search input unchanged (rounded-[6px] border --vex-line-strong bg --vex-surface-down). Content: ul of hairline rows (border-b --vex-line px-1 py-2 last:border-b-0), each row a flex-wrap of PILL stamps + a truncate sans title + an ml-auto mono tabular-nums timestamp; Long-term/Candidates rows add a line-clamp-2 summary and tag chips. Metadata: every count, generation, attempt, importance/confidence, cost, and timestamp uses tabular-nums (extend the existing timestamp class to the inline counts in MemoryStatsRow/JobsBody counters so columns don't jitter on filter change). Secondary actions: the lone Retry key in CompactionRow (status==='permanently_failed' only). Section separator: between sections, a dot-matrix rule — a centered row of 5-7 static DotmSquare3 glyphs at color-mix(--vex-accent 6%) flanked by h-px --vex-line spans (mirrors MemoryMarker's hairline-rule grammar), rendered by MemorySectionShell so it is identical across all seven and trivially removable. Long-list responsive: any ul exceeding ~12 rows gets the .vex-fade-top mask on its scroll wrapper plus max-h with overflow-auto so the oldest rows dissolve into the section seam (Law 6 — mask only, the one dissolve place is reused, not a new painted gradient). Resizable behavior: the max-w-[760px] column stays centered; on a narrow content column the flex-wrap pill rows reflow naturally (already the case) and the timestamp's ml-auto drops to the next wrap line.

**Electron notes.** Renderer-only, untrusted UI. No title-bar drag/no-drag region (native OS frame, AppShell.tsx S0 decision). Privilege exclusively via window.vex.* IPC through the existing hooks: useLongMemoryList, useInspectorCandidates/Decisions/JobsSummary, useMemoryStats, useSessionMemories, useCompactionHistory, useRetryCompaction, useAvailableModels, useMemoryFeatureEnabled — every payload is a sanitized DTO (no raw narrative bodies, content_md, embeddings, evidence_refs, decision_hash, worker-lock columns, or last_error). No new IPC channel is required for any redesign element (separators, fade, collapse, tabular-nums are pure CSS/local state). If the optional Law-10 relocation into the BOOK panel is taken, it remains a renderer layout change (3rd flex child of <main>) with zero preload/main surface change. CSP style-src 'self': all motion is build-time @keyframes or Tailwind utilities/data-attribute toggles — no runtime <style>, no element.style/cssText, no dangerouslySetInnerHTML. Icons stay @hugeicons/core-free-icons (ArrowLeft01Icon, ArrowRight01Icon, Brain01Icon, BookOpen01Icon, SparklesIcon) via @hugeicons/react; dot glyphs via the existing @thesvg/react-derived DotmSquare3/DotmHex3 components. No Radix/cmdk.

**Implementation.** Add ONE panel-local primitive to MemoryPanelShared.tsx — MemorySectionShell({label, count, defaultOpen=true, children}) — and route all seven sections through it (each section keeps its own data hooks; only its <section>/<h2>/description header is replaced by the shell). Shell JSX: `<section className={SECTION}>` containing a header button (`<button type=\"button\" aria-expanded={open} aria-controls={id} className=\"flex w-full items-center gap-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--vex-accent)]\">` with `<HugeiconsIcon icon={ArrowRight01Icon} size={12} className={`shrink-0 text-[var(--vex-text-3)] transition-transform ${open?\"rotate-90\":\"\"}`} />`, the existing `<h2 className=\"font-mono text-[10px] uppercase tracking-[0.3em] text-[var(--vex-text-3)]\">{label}</h2>`, and a right-aligned `<span className=\"ml-auto inline-flex items-center rounded-[3px] border border-[var(--vex-line)] px-1.5 py-0.5 font-mono text-[10px] tabular-nums text-[var(--vex-text-2)]\">{count}</span>` (reuse PILL + add tabular-nums)). Body wraps children in a collapse region: `<div id={id} data-open={open} className=\"grid transition-[grid-template-rows] duration-[180ms] ease-out [grid-template-rows:0fr] data-[open=true]:[grid-template-rows:1fr]\"><div className=\"min-h-0 overflow-hidden\">{children}</div></div>` — the 0fr/1fr grid trick is CSP-safe (utility classes, no inline style) and needs no JS height measurement. Count source per section: Long-term = filtered items.length; Candidates/Decisions = res.data.length; Jobs = sum of countsByStatus; Session = stats.activeCount; Compaction = history length; Memory&privacy = no list -> omit count (pass undefined, render nothing). Separators: between sections in MemoryPanel.tsx render `<MemorySeparator />` (also in MemoryPanelShared) = `<div aria-hidden className=\"flex items-center gap-3 py-1\"><span className=\"h-px flex-1 bg-[var(--vex-line)]\" /><DotmSquare3 size={12} dotSize={2} color=\"color-mix(in oklab, var(--vex-accent) 6%, transparent)\" /> (x5, static — no `animated` prop) <span className=\"h-px flex-1 bg-[var(--vex-line)]\" /></div>` — confirm DotmSquare3 accepts a static (non-animated) render; if its default loops, pass its idle/animated={false} prop so it rests still (Law 3/7). Long-list fade: in LongMemoryList/CandidatesList/DecisionsList/JobsBody, when items.length > 12 wrap the `<ul>` in `<div className=\"vex-fade-top max-h-[420px] overflow-auto vex-scroll\">` (reuses .vex-fade-top globals.css:342 and .vex-scroll). tabular-nums: extend to the inline counters — change MemoryStatsRow PILLs and JobsBody STATUS_COUNTERS PILLs to add `tabular-nums` so digit columns are stable across filter switches (timestamps already have it). Retry LOCK stamp: in CompactionRow, when a retry resolves ok for that generation, add `vex-stamp-press` to the status PILL for one cycle (toggle a local boolean keyed off the mutation's resolved generation; class removed after; rests still). Reduced motion: covered globally (globals.css:441 collapses all animation/transition to 0.01ms) — the grid-rows transition snaps, the stamp shows its final frame, the dot separators are already static. Files to edit: MemoryPanelShared.tsx (add MemorySectionShell + MemorySeparator + tabular-nums on count PILL), MemoryPanel.tsx (interleave MemorySeparator), and each of the seven section files to (a) wrap header in MemorySectionShell, (b) add tabular-nums to inline counts, (c) add the vex-fade-top wrapper on long lists. No globals.css change is required (vex-fade-top, vex-stamp-press, reduced-motion, vex-scroll all exist). Run the shell-design-guard test after — the dot tint uses color-mix on --vex-accent (not a banned raw gray-blue hex) and adds no backdrop-blur/shadow-[0_0_/ShinyText, so it stays green.

**Motion specs.**

| Name | Trigger | Technique | Duration/easing | Reduced-motion |
| --- | --- | --- | --- | --- |
| Section collapse / expand | Click/Enter/Space on a section header toggle button (aria-expanded). | CSS grid-template-rows 0fr->1fr transition on a data-[open] attribute (Tailwind utilities, no inline style, no Motion layout/layoutId per MOTION-POLICY); inner wrapper min-h-0 overflow-hidden. No height measurement, CSP-safe. | 180ms ease-out (matches vex-entry-settle / motion-cascade-row). | Global globals.css:441 forces transition-duration 0.01ms -> instant open/close; the aria-expanded state and chevron rotation still convey state. |
| Retry LOCK stamp | useRetryCompaction mutation resolves ok for a permanently_failed generation (Law 4 commit = one-shot stamp). | Append the existing .vex-stamp-press class (globals.css:190, build-time @keyframes opacity+scale 1.15->1) to that row's status PILL for one cycle, then remove; rests still afterward. | 180ms ease-out (vex-stamp-press), plays once. | Global rule collapses it to the final frame (opacity:1 scale:1) — the status flip is shown instantly, no press. |
| Long-list dissolve (oldest rows) | Static — present whenever a section list exceeds the max-h and scrolls; not event-driven. | .vex-fade-top mask-image linear-gradient(transparent->black 18px) (globals.css:342) — a MASK not a painted gradient (Law 6, the one dissolve, reused). No animation. | none (static mask). | Unaffected — it is a static mask, not motion; remains correct under reduce. |
| Dot-matrix separator | None — static decorative texture bound to the section-seam meaning (Law 7). | Static DotmSquare3 glyphs (currentColor at color-mix --vex-accent 6%) with animated/idle = no loop; NOT a radial-gradient surface fill. | none. | Already static; no change. |

**Polish pass.**

_More premium:_

- Make the collapsed-section count badges tabular-nums and right-aligned so the seven section headers form a clean vertical number column — the register reads like an instrument index, not a list of headings.
- Re-read the Retry success as a true LOCK stamp (vex-stamp-press on the status pill flipping permanently_failed -> queued) so the one mutation in the view has a deliberate, satisfying commit beat consistent with the rest of the Signal Tape.
- Keep the dot-matrix separators barely-there (<=6% accent) and identical across all seams via one MemorySeparator component — uniform, quiet texture signals a designed system; the eye registers rhythm, not decoration.

_Cut clutter:_

- Collapse the long-tail sections (Decisions, Jobs, Candidates) by default to non-blocking — open Long-term + Session by default — so the user lands on what they care about instead of a seven-section wall of pills.
- Cap long lists with vex-fade-top + max-h and let the oldest rows dissolve into the seam, instead of an unbounded scroll where every section competes for height.
- Drop the per-row redundant labels into pills only (already done) and ensure no section introduces a new accent fill — at rest the whole register is hairline + the text trio, so the single focus ring and the Retry key are the only things that ever read blue.

_Generic traps to avoid:_

- Painting the dot-matrix separators (or any section) as a radial-gradient/background texture fill — that violates Law 7/9 and instantly reads as generic SaaS chrome; they must be discrete static glyphs at <=6% accent.
- Animating the section collapse with a Motion layout/Reorder spring or adding a resting shimmer/glow on the active filter chip — ambient motion in a read-only audit register breaks Law 3 (motion only when bound to in-flight engine work) and the no-resting-glow Depth Law.
- Turning the count badges or status pills into colored category chips (green=promoted, red=rejected, etc.) — semantic color flooding is the AI-dashboard tell; status stays mono text in hairline pills, with accent strictly rationed to focus/CTA per Law 2.

**Files touched:** `vex-app/src/renderer/features/appShell/MemoryPanelShared.tsx`, `vex-app/src/renderer/features/appShell/MemoryPanel.tsx`, `vex-app/src/renderer/features/appShell/LongMemorySection.tsx`, `vex-app/src/renderer/features/appShell/CandidatesSection.tsx`, `vex-app/src/renderer/features/appShell/DecisionsSection.tsx`, `vex-app/src/renderer/features/appShell/JobsSection.tsx`, `vex-app/src/renderer/features/appShell/SessionMemorySection.tsx`, `vex-app/src/renderer/features/appShell/CompactionHistorySection.tsx`, `vex-app/src/renderer/features/appShell/MemoryPrivacySection.tsx`


---

## Section 11 — Shared UI primitives & dialogs

> _Recon area: Shared UI primitives & dialogs — Button CVA, Dialog skin, Card, Input/Label/Tabs/SelectMenu, AddressDisplay/PasswordField/StrengthMeter (the quiet-chrome foundation the Signal Tape rides on)_

**Intent.** These are the global levers. The 30-importer Button and the shell Dialog skin decide whether chrome whispers or shouts. Today they shout: Button.default paints a solid `bg-primary` (accent) fill on every button, `secondary` is a violet `bg-secondary` slab (wallet export + Polymarket modals), Card carries a resting `shadow-sm`, and Dialog ships glass (`backdrop:backdrop-blur-sm`) + `shadow-lg`. The redesign re-tones this entire layer to obey Law 2 (Blue Rationing), Law 3 (no ambient motion), and Law 9 (no glass/shadow): the default button becomes a quiet hairline, exactly ONE new `signal` variant carries the single live/pending CTA, violet `secondary` is killed and its three consumers migrated, the Dialog default drops glass+shadow to a solid-luminance card, and Card loses its shadow. SelectMenu is already on-brand and becomes the token template the rest follow.

**UX structure.** Placement: these primitives have no fixed position — they are composed everywhere (sidebar, composer, tape rows, the on-demand Book panel, all dialogs). The contract here is tonal, not spatial. Interaction model is unchanged (native `<button>`, native `<dialog>` top-layer, ARIA combobox/tabs already correct). Keyboard model is preserved verbatim: Dialog keeps native `showModal()` focus-trap + ESC→`cancel`→`onOpenChange(false)`; SelectMenu keeps `aria-activedescendant` + Arrow/Home/End/Enter/Space/Esc/Tab; Tabs keep roving tabindex + Arrow/Home/End; Button/Input keep `focus-visible:ring-2 ring-ring` (ring resolves to `--vex-accent` under the shell scope — the only sanctioned resting blue per Law 2). What animates vs stays still: NOTHING in this layer resting-animates. Buttons/cards/dialogs are dead still at rest; the only motion is (a) `transition-colors` on hover/focus state change, (b) a one-shot `vex-stamp-press` re-read as a LOCK stamp when a `signal` CTA commits an approval (Law 4), (c) the dialog's own open transition handled by the native top-layer. The bloom/needle motion (Law 5) lives in TranscriptMessage's gutter, NOT in these primitives — this spec only guarantees these primitives never compete with it.

**States.**

- Button.default (quiet) — idle: transparent fill + `border-[var(--vex-line)]` hairline + `text-[var(--vex-text-2)]`; hover: `hover:border-[var(--vex-line-strong)] hover:text-[var(--vex-text)] hover:bg-white/[0.03]`; focus-visible: `ring-2 ring-ring` (=--vex-accent); disabled: `opacity-50 pointer-events-none`.
- Button.signal (the ONE rationed-blue CTA) — idle: `bg-[var(--vex-accent)] text-[#ffffff]`; hover: `hover:bg-[var(--vex-accent-hover)]`; active: `active:bg-[var(--vex-accent-active)]`; pending (in-flight commit): caller adds `disabled` + a `vex-stamp-press` lock stamp on resolve; disabled: `opacity-50`. Exactly one signal button should be live on screen at a time (point-of-cause approval, primary onboarding advance, send).
- Button.outline / ghost / link / destructive — retained, re-toned to hairline tokens (outline border → `--vex-line-strong`, destructive stays `bg-destructive`; destructive is semantic danger, NOT decoration, so it is allowed a fill).
- Button.secondary — REMOVED. Its 3 consumers (ExportPrivateKeyFooter, PolymarketConfirmModal, PolymarketSudoModal) migrate to `outline` (cancel/dismiss role) since none is the primary action.
- Dialog — idle/open: solid `bg-[var(--vex-surface-2)]` (popover step) + `border-[var(--vex-line-strong)]` hairline, NO blur, NO shadow; backdrop: `backdrop:bg-[var(--vex-surface-down)]/70` flat scrim (Law 9, no blur); closing: native top-layer; the controlled `onOpenChange(false)` path is unchanged for ESC + backdrop-click.
- Card — resting: solid `bg-card` (=--vex-surface-1) + hairline, shadow-sm removed; no hover elevation.
- Input/SelectMenu/Tabs — idle/focus/disabled/active/selected already correct in SelectMenu; Input loses its `shadow-sm`, Tabs active indicator switches from `bg-background shadow-sm` to a hairline underline (no shadow).
- Validation-error (forms) — StrengthMeter/Input: error tone uses `text-[var(--vex-warn-text)]` + `border-destructive`, never raw #f0a0a0.
- Awaiting-approval (shell-wide freeze, Law 4) — when an approval is pending, any `signal` button outside the approval card renders `disabled` and all one-shot stamp animations are gated by the existing `animated={!awaitingApproval}` flag; motion freezes, trust = stillness.
- Reduced-motion — `vex-stamp-press` collapses to its final frame via the global 0.01ms rule; `transition-colors` collapses to instant; lock stamp appears statically.

**Design tokens.** Colors (all from contract, via shell `[data-vex-shell]` scope or global @theme): surfaces `--vex-surface-1` (#090e1d, Card), `--vex-surface-2` (#0f1729, Dialog/popover), `--vex-surface-down` (#02040a, dialog scrim/recessed wells); hairlines `--vex-line` (6%), `--vex-line-strong` (10%); text `--vex-text`/`--vex-text-2`/`--vex-text-3`; accent family `--vex-accent` (#3275f8), `--vex-accent-hover`, `--vex-accent-active`, `--vex-accent-border`, `--vex-accent-fill-12` (SelectMenu active row); semantic `--vex-warn-text` (replaces #f0a0a0), `--vex-pin` (warm flag, replaces #ffd35c), `--color-destructive`. shadcn projection aliases (`--color-card`, `--color-popover`, `--color-border`, `--color-input`, `--color-ring`, `--color-primary`) are already repointed to the shell tokens in globals.css:279-286, so stock classes inherit the language. Radii: `rounded-md` (--radius-md 0.5rem) default, `rounded-lg` (--radius-lg) for Dialog/Card/SelectMenu, `rounded-sm` (--radius-sm) for chips. Borders: 1px hairline only. Shadows: NONE (removed everywhere). Motion: `vex-stamp-press` 180ms ease-out (existing); `transition-colors` (Tailwind default 150ms). Typography: content `--font-sans` (Google Sans); instrument microtype `--font-mono` (Geist Mono) uppercase 10-13px tracking 0.14-0.3em + `tabular-nums` for stamps/status/numerics (pattern lifted verbatim from AddressDisplay copy-chip line 84, PasswordField show/hide line 47, StrengthMeter tier label line 64).

**Component spec.** Container → primitive root (button / dialog / div). Header → DialogHeader keeps `border-b border-border px-6 py-4` but border now resolves to `--vex-line-strong`; DialogTitle stays `text-lg font-semibold` (Google Sans). Controls → Button CVA base string unchanged for layout (`inline-flex items-center justify-center gap-2 ... rounded-md text-sm font-medium transition-colors focus-visible:ring-2 focus-visible:ring-ring`); only the `variant` map changes. Content → DialogBody/CardContent unchanged structurally. Metadata → mono microtype captions/stamps use the AddressDisplay/PasswordField class recipe `font-mono text-[10px] uppercase tracking-wider text-[var(--vex-text-3)]` + `tabular-nums` where numeric. Secondary actions → DialogClose stays an unstyled context-routed button; cancel buttons move to `variant="outline"`. Responsive/resizable → Dialog keeps `max-h-[85vh] w-full max-w-md` and `open:flex open:flex-col`; Card/Button are intrinsic-size, no responsive logic added. SelectMenu is the reference: its trigger (`border-white/[0.08] bg-white/[0.035]` line 183) and popover (`border-border bg-popover` line 216) are the canonical hairline-on-solid pattern; migrate Input/Button.default to the same hairline-fill discipline rather than inventing new values.

**Electron notes.** No title-bar drag/no-drag concerns — these are interior primitives, native OS frame is untouched (Law: NO custom title-bar). No `window.vex.*` preload calls originate from this layer; primitives are pure presentational, side-effect-free (AddressDisplay's `navigator.clipboard` is a renderer Web API, not a privileged channel — unchanged). CSP: every change is a Tailwind class or token swap — zero runtime `<style>`, zero `setAttribute('style')`/`cssText`, zero `dangerouslySetInnerHTML`. The Dialog uses the native `<dialog>` top-layer (no Portal, no Radix), so dropping glass is purely a className edit (`backdrop:backdrop-blur-sm` → `backdrop:bg-[var(--vex-surface-down)]/70`; remove `shadow-lg`). OS differences: native `<dialog>::backdrop` + `showModal()` focus-trap behave identically on Win/macOS/Linux Chromium (Electron 42); no per-OS branching. The `vex-stamp-press` keyframe is build-time CSS in globals.css (CSP-safe).

**Implementation.** BUTTON (vex-app/src/renderer/components/ui/button.tsx:13-39): rewrite the `variant` map. `default` → `"border border-[var(--vex-line)] bg-transparent text-[var(--vex-text-2)] hover:border-[var(--vex-line-strong)] hover:bg-white/[0.03] hover:text-[var(--vex-text)]"` (quiet hairline). ADD `signal` → `"bg-[var(--vex-accent)] text-white hover:bg-[var(--vex-accent-hover)] active:bg-[var(--vex-accent-active)]"`. REMOVE `secondary` entirely. Keep `outline` but repoint to `"border border-[var(--vex-line-strong)] bg-transparent text-[var(--vex-text-2)] hover:bg-white/[0.03] hover:text-[var(--vex-text)]"`; keep `ghost`/`link`/`destructive`. Base string already CSP-safe; no change. Because `--color-primary` now = `--vex-accent`, any caller still passing `variant="default"` for a real CTA must be repointed to `variant="signal"` — audit the 30 importers (grep `<Button` with no `variant` or `variant="default"`) and reclassify: primary advance/send/confirm → `signal`; everything else → `default`(quiet) or `outline`. MIGRATE the 3 violet consumers: ExportPrivateKeyFooter.tsx:31, PolymarketConfirmModal.tsx:99, PolymarketSudoModal.tsx:263 → `variant="outline"` (they are cancel/dismiss role; the primary action in each modal becomes `signal`).
DIALOG (dialog.tsx:212-213): change `bg-card ... shadow-lg` → `bg-[var(--vex-surface-2)]` and DROP `shadow-lg`; change `backdrop:bg-background/80 backdrop:backdrop-blur-sm` → `backdrop:bg-[var(--vex-surface-down)]/70`. NOTE the design-guard whitelist (shell-design-guard.test.ts:91-100) currently EXEMPTS dialog.tsx for `backdrop-blur` expecting per-call `backdrop:backdrop-blur-none` overrides — once the base drops blur, REMOVE that whitelist entry and the guard self-test at line 168 still passes (`backdrop:backdrop-blur-none` no longer needed at call sites; sweep them). Header/Footer borders (lines 233, 295) already use `border-border` = `--vex-line-strong`; no edit.
CARD (card.tsx:19): remove `shadow-sm` → `"rounded-lg border border-border bg-card text-card-foreground"`.
INPUT (input.tsx:23): remove `shadow-sm`.
TABS (tabs.tsx:79,155): TabsList `bg-muted` → `bg-[var(--vex-surface-down)]`; active trigger `bg-background text-foreground shadow-sm` → hairline-underline pattern `text-foreground border-b-2 border-[var(--vex-accent)]` (rationed blue marks the live tab) and DROP shadow-sm; inactive unchanged.
GUARD EXTENSION (shell-design-guard.test.ts:69-77): add BANNED entries per Law 9 — `bg-secondary` (kills violet reintro), legacy indigo/violet hexes `/#(?:6366f1|8b5cf6)/i`, and `Card.*shadow-sm` / a `shadow-sm` scan scoped to card/dialog/input. SelectMenu/AddressDisplay/PasswordField/StrengthMeter need NO structural change — they already model the target language; only ensure StrengthMeter error/warn paths use `--vex-warn-text` not raw hex if any exist (current file uses `bg-destructive`/`bg-warning` tokens — clean).

**Motion specs.**

| Name | Trigger | Technique | Duration/easing | Reduced-motion |
| --- | --- | --- | --- | --- |
| Quiet hover/focus state change | pointer hover or keyboard focus on any Button/Input/Tab/SelectMenu trigger | Tailwind `transition-colors` only (border-color/background/text-color); no transform, no shadow, no opacity-glow. CSP-safe (class-driven, CSSOM). | ~150ms Tailwind default ease | Global 0.01ms rule collapses to instant color swap; the resting/hover states remain visually distinct so intent survives. |
| Signal-CTA commit LOCK stamp | a `signal` button finalizes an approval/commit (one-shot, fired by caller on success) | Re-use existing `.vex-stamp-press` class (globals.css:179-192) — build-time @keyframes, opacity 0→1 + scale 1.15→1, applied to a lock/stamp glyph the caller mounts; no runtime style injection. CSP-safe. | 180ms ease-out both (existing) | Existing global rule collapses to final frame — stamp appears statically; lock state still reads. |
| Dialog open (native top-layer) | `open` prop true → `showModal()` | Native `<dialog>` top-layer promotion; no JS/Motion animation added. Flat scrim `backdrop:bg-[var(--vex-surface-down)]/70` paints instantly (no blur transition). | instant (native) | N/A — no animation; honored by default. |

**Polish pass.**

_More premium:_

- The default button becoming an invisible-until-touched hairline (transparent fill, `--vex-line` border, `--vex-text-2`) makes the whole shell read as a quiet instrument; the single `signal` blue then lands as a genuine event, not wallpaper.
- Dropping Dialog glass for a solid `--vex-surface-2` card with a flat `--vex-surface-down` scrim gives the modal real object-in-a-dark-room depth (luminance step + hairline) instead of the cheap frosted-SaaS look.
- Carrying the AddressDisplay/PasswordField mono-microtype recipe (Geist Mono, 10px, uppercase, tracking, tabular-nums) onto every metadata caption makes numerics and status words feel like telemetry on a trading desk, not generic UI labels.

_Cut clutter:_

- Remove the resting `shadow-sm`/`shadow-lg` from Card, Input, Dialog, and Tabs active trigger — every shadow was decorative depth that competes with the tape; hairlines carry layering alone.
- Collapse the violet `secondary` variant out of existence so there are only two button weights that matter (quiet `default` + the one `signal`), eliminating the third competing color slab.
- Replace the Tabs active `bg-background` pill with a single hairline-underline accent mark — one line instead of a filled chip removes a boxed-in cluster from any tabbed panel.

_Generic traps to avoid:_

- Letting `variant="default"` keep painting a solid accent fill (because `--color-primary`=--vex-accent) on all 30 importers — that floods the UI with blue and violates Blue Rationing; default MUST be repointed to the quiet hairline and CTAs explicitly opted into `signal`.
- Re-introducing a frosted `backdrop-blur` or a `shadow-lg`/`shadow-[0_0_...]` glow on the dialog/card for 'depth' — that is the exact SaaS-template tell Law 9 and the design guard exist to block.
- Adding an ambient hover transform/scale or a resting pulse/shimmer to buttons to feel 'alive' — Law 3 forbids ambient motion; the only sanctioned motion here is `transition-colors` and the one-shot commit stamp.

**Files touched:** `vex-app/src/renderer/components/ui/button.tsx`, `vex-app/src/renderer/components/ui/dialog.tsx`, `vex-app/src/renderer/components/ui/card.tsx`, `vex-app/src/renderer/components/ui/input.tsx`, `vex-app/src/renderer/components/ui/tabs.tsx`, `vex-app/src/renderer/features/wallets/ExportPrivateKeyModal/ExportPrivateKeyFooter.tsx`, `vex-app/src/renderer/features/wizard/steps/polymarket-auto-setup/PolymarketConfirmModal.tsx`, `vex-app/src/renderer/features/wizard/steps/polymarket-auto-setup/PolymarketSudoModal.tsx`, `vex-app/src/renderer/features/appShell/__tests__/shell-design-guard.test.ts`


---

## Section 12 — BOOK panel (per-session instrument, incl. POSITION) — PLAN

> Planned via multi-agent workflow (5 recon readers → design → adversarial
> security + feasibility review). **Both verdicts `ok=true`**; the hardening
> fixes below are folded in. ⚠️ **Stage 3 (POSITION IPC) is a hard-stop** — a new
> public IPC exposing wallet balances/holdings/USD/PnL across the trust boundary;
> it ships only on explicit user approval.

**Panel.** A new `<aside>` sibling appended after the middle `<section>` inside
`AppShell <main>` (NOT related to the `<SessionCreator>` modal portal). ~320px,
`--vex-surface-1`, `border-l --vex-line`, on-demand, gated on
`bookOpen && activeSessionId !== null`. Toggle in the DESK RULE header (right,
near the version). State in `uiStore`: add `bookOpen: boolean` (default **false**),
`setBookOpen`, and a net-new `toggleBook` (sidebar has only a setter); persist
`bookOpen` in `partialize`.

**Four blocks (3 buildable on existing IPC, 1 new):**

1. **MOVES** (per session, existing IPC) — `useApprovalHistory(sessionId, 20)`
   (`approvals.getHistory`, ORDER BY created_at DESC). Each `ApprovalSummaryDto`
   already carries label (`preview.toolName ?? toolName`, resolves
   `execute_tool` wrappers), `actionKind`, `riskLevel`, time (`resolvedAt ??
   createdAt`), `reasoningPreview`. Status is a **pure client-side mapper** over
   (`status`, `executionStatus`, `decision`) → pending / done / failed. ⚠️
   `execution_result_hash` is a result digest, **not** a tx hash — never relabel
   it. Richer moves (real tx hash/USD via `proj_activity`) is OUT — `proj_activity`
   has no `session_id` (a separate STOP-AND-VERIFY).
2. **RUNTIME & COST** (existing IPC) — promote `SessionRuntimeBar` into the panel.
   Add an additive `layout?: 'inline' | 'stack'` prop (default `'inline'` to
   preserve today's behavior; `'stack'` for the vertical panel). Model / context
   bar / `usage.getSessionTotals` / `getLastTurn` / `compaction.getStatus`.
3. **SESSION** (existing IPC) — `sessions.get` + `wallets.listSessionWallets`
   (`SessionWalletScopeDto`, family **keys** `evm`/`solana`): mode, permission,
   mission status, wallet scope, created.
4. **POSITION** (NEW IPC) — per-wallet snapshots: family, address, totalUsd,
   PnL, per-token holdings (symbol/amount/USD). family **enum** `eip155`/`solana`
   (note the vocabulary split vs the SESSION block's `evm`/`solana` keys).

### POSITION IPC contract (Stage 3 — hard-stop)

- **Data source (mirror-DB, no `@vex-agent` import):** new
  `src/main/database/portfolio-db.ts` copying `usage-db.ts` scaffolding
  (`buildPoolConfig`, 2s/5s timeouts, `dbUnavailable`/`dbError`, NUMERIC→number).
  Read path: `getSessionWalletScope(sessionId)` → `addrs =
  [evm?.address, solana?.address].filter(Boolean)`; **empty `addrs` → `ok({wallets:[],
  totalUsd:0,…})` (normal, never an error, never global)**; else per-wallet latest
  from `proj_portfolio_snapshots` + per-token from `proj_balances` (typed columns
  only — **never** the untyped `positions` JSONB).
- **Channel/handler:** `CH.portfolio.getSessionPositions` (`vex:portfolio:…`), new
  domain `'portfolio'` (add to `VexDomain` union + `VEX_DOMAINS` array), handler in
  `src/main/ipc/portfolio.ts` via `registerHandler` (trusted-sender + input/output
  Zod + Result<T>), registered in `register-all.ts`.
- **Preload/schema/renderer:** `src/preload/agent/portfolio.ts` +
  `PortfolioBridge`; `src/shared/schemas/portfolio.ts` (all `.strict()`, input =
  `{ sessionId: uuid }` only — addresses resolved main-side, never trust the
  renderer); `renderer/lib/api/portfolio.ts` `useSessionPositions` (staleTime ~15s,
  poll 30–60s since snapshots are background-written with no event).

### Security policy (from the adversarial review — all `ok`, hardened)

- **Hard session-scoping invariant** (not a convention): the engine repos have a
  global/legacy fallback, so `portfolio-db` must resolve scope first and
  short-circuit empty → empty. Add a **cross-session isolation negative test**
  (session A never returns wallet B's tokens).
- **Logging:** handler + db log `sessionId + wallet COUNT + token COUNT +
  correlationId` ONLY — never raw balances/addresses/USD (`SENSITIVE_KEY_RE` does
  **not** auto-redact `balanceUsd`/`totalUsd`/`pnl`, so don't rely on it).
- **Exposed** (user's own public data): family, full address (consistent with
  `listSessionWallets`; UI truncates), label, per-token symbol/name/chainId/
  balanceRaw/decimals/balanceUsd/priceUsd, per-wallet & session totalUsd + PnL,
  snapshotGroupId, timestamps. **Withheld:** row id, source col, raw `positions`
  JSONB, raw DB errors (→ `internal.unexpected`), any key/seed/signing material
  (source tables are structurally key-free — confirmed). **Read-only**: no
  mutation/sign path on the portfolio domain.

### Staged build plan

| Stage | Scope | Risk | Gate |
| --- | --- | --- | --- |
| **1** | `uiStore` `bookOpen` + `setBookOpen`/`toggleBook` + persist | low | build go |
| **2** | BOOK shell + header toggle (`<aside>`) + MOVES + RUNTIME (+ `SessionRuntimeBar layout` prop) + SESSION blocks — **renderer-only, no new IPC** | low | build go |
| **3** | POSITION IPC end-to-end (main + preload + shared schema + tests), no renderer block yet | med | **⚠️ explicit approval (wallet-data exposure)** |
| **4** | POSITION renderer block + `useSessionPositions`; migrate `SessionRuntimeBar` out of `SessionContext` (expand test list: `SessionContext.test` + 6 `AppShell/*` tests assume that mount) | low–med | build go |

**Prereq helper:** create a shared `truncateAddress(addr)` (`0xabcd…1234`) — the
plan’s `maskHex` is **not** an existing primitive; extract one and migrate the
few existing truncation sites.

**Open questions:** (1) POSITION scope — **session-scoped** (recommended; matches
`getSessionWalletScope` + the engine "never global" contract) vs a global
all-wallets portfolio; (2) refresh via poll (30–60s) vs a sync event subscription;
(3) confirm `SessionContext` loses the runtime bar in Stage 4.
