# Session composer (the white field and its bar)

The composer is one component (`../SessionComposer.tsx`) serving the welcome
and the docked session stage; `variant="hero" | "docked"` names the stage
(default derives from `activeSessionId`). The textarea DOM survives a
hero-to-docked move because the parent keeps the mount position stable.

## Geometry (docs/design/R3-MINIMAL.md section 7, references d2, d3, d5)

- Card: `.vex-composer-card` (console.css) - square, 1px
  `--vex-alias-border-input` (the rule), the `--vex-alias-composer` field
  fill (white by day, night-1 at night), no shadow, scrollbar l2 rebind,
  padding 14 14 10 18 on both stages. It follows the page column (720 on the
  welcome, 540 beside Vex under 1180; composer.css). NO focus treatment of
  any kind; the blue caret and the send key carry focus. While an approval
  waits it draws the 1.5px ink frame.
- Field: 16/24 sans, a 48px two-line floor, the text 6px off the right edge
  (the placeholder overlay mirrors it), height cap 336px (14 lines) then
  scroll. The placeholder is muted.
- Bar (`.vex-composer-bar`): space-between, 8 apart, 6 under the field, and an
  inline-size QUERY CONTAINER (`@container`).
  - LEADING cluster (`min-w-0`, shrinkable): the ONE options control,
    "{model name} · Reasoning: {effort}" in a 30 high frame on the quiet rule
    (`.vex-composer-options`): the model key (the catalogue name, else the id;
    opens Settings -> Model), the muted dot and "Reasoning:", the effort key
    (`ReasoningEffortSelect`, the menu, with the chevron); then the
    legacy-plan chip.
  - TRAILING cluster (`flex-none`, protected): the permission as its promise
    ("Funds require approval" or "Full access", 13 / 500 blue with the lock
    or shield icon; on the welcome the new session form's Restricted
    preselect), "Context N%" with the five cell meter, the send/stop key.
- Send/stop key: send is 36 x 36, a dotted blue outline while empty and the
  view's one blue fill with text; while a turn runs the NAMED ink stop key
  replaces it ("Stop agent" in a chat, "Stop mission" in a mission; 36 high,
  a 9 x 9 square, 13 / 500); "Stopping" keeps the box on a dotted ink line.
- Shrink chain (codex Bug 3 / deepseek cross-check section 2). One priority
  order, in three steps: text LABELS truncate first (the model label owns
  `min-w-0 truncate`; the options frame and the model key carry `min-w-0`
  and no `shrink-0`); the permission LABEL collapses second, at the row
  container's 460px threshold (`@max-[460px]:hidden`, the reference value);
  fixed icons, the context label and the send/stop key never shrink. Nothing
  is blanket-clipped - a hidden focusable control would still be
  keyboard-reachable.
- Notice line: above the card, 13/20; an error speaks in ink behind the ink
  cross swatch, never red. Retry is a 13 / 500 blue key on the rule.
- Tag on the field's top edge (`.vex-composer-tag`, inside the card): "Waiting
  for approval" behind the target swatch, "Stopping…" on the rule.
- Welcome task rows (`ComposerQuickActions`, `.vex-starter` in composer.css):
  "Check wallet balances", "Review the market", "Create a mission", "Trade
  perps on Lighter"; 42 high, 15 ink 2, a blue line icon, the quiet rule
  between rows, in a fixed 186px slot that keeps its height while the rows
  hide for typing. A prompt row seeds the draft; "Create a mission" opens the
  new session form on the Missions view (Mission preselected).
- Dashed drop ring: SVG-masked `::after` on `[data-vex-drop="active"]`.

## Behavior modules

- Drafts (B1): `lib/composer-drafts.ts` - per-session in-memory store; the
  welcome composer uses the reserved `welcome` key, cleared when its draft
  becomes a created session's first turn.
- Submission policy (B13): `lib/composer-submission-policy.ts` - persisted
  `enter` (default) vs `mod-enter`; Cmd/Ctrl+Enter always submits,
  Shift+Enter always newlines, IME composition always passes.
- Slash commands (B9/B12): `../commands/` - pure caret detection with URL
  carve-outs, registry (`/plan /export /clear-draft /theme /help`), and a
  combobox menu (focus stays in the textarea; aria-activedescendant;
  mousedown picks). Results surface as toasts.
- Queue (A27): `lib/composer-queue.ts` + `ComposerQueueDock` - a submit
  while a turn is in flight queues per session; the head auto-drains when
  the session goes idle; rows offer edit / remove / send-now.
- Seats: `ComposerSeats` (the options control: model key -> Settings/model,
  effort menu; legacy-plan chip -> PlanDisplayModal), `ComposerPermissionSeat`
  (the promise, DISPLAY-ONLY - permission is locked at session creation and
  the renderer never grants or widens it), `ComposerContextMeter` (the
  context label and meter),
  `ComposerMissionStrip` (read-only mission status word + plan review link).
- Context meter (`ComposerContextMeter`): a 30px key reading "Context N%"
  beside the shared `CellMeter` (five 4x10 cells) from `useContextWindow`;
  past the ENGINE's
  own critical band the cells turn ink. It opens a 264px `role="dialog"`
  panel above and right-aligned, on the 1.5px ink frame. Outside pointer and Escape dismiss it; focus returns to
  the trigger; the tooltip serves the closed state only. The panel draws a
  TOTAL-ONLY bar (the same meter at twenty cells) - `ContextWindowDto` carries no System/Tools/Messages
  split, so the reference's legend is deliberately absent rather than
  invented - and hosts `ComposerCompactionBlock`.
- `ComposerCompactionBlock`: the apply control + compaction status that the
  retired BOOK "Runtime & Cost" card used to host. It moved here rather than
  disappearing with the card - it is the app's only renderer-initiated
  context mutation, and compaction is a context-pressure action. The card's
  cost/usage/model lines did NOT move: transcript turn stats remain the cost
  surface.

## Known limitations and deferred work

- No per-session model picker: the runtime model is global
  (`AGENT_PROVIDER`/`AGENT_MODEL`); the model key deep-links Settings ->
  Model instead. A picker needs an engine/IPC channel first.
- Attachments (B2-B8) are not built: a file drag shows the drop ring and a
  drop answers with an honest "not supported yet" toast.
- Read-only composer state (B25) and caret-into-view for long drafts (B15)
  are not built (outside the F3 task list).
- The mission strip carries status + plan only - the engine has no todo
  tool/channel to feed a todo list (A28's fuller shape).
- The submission-policy store has no settings UI yet (F4 surface).
- Drafts and queue are in-memory: they survive session switches, not an
  app restart.
