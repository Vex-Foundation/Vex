# Session composer (the white field with chips)

The composer is one component (`../SessionComposer.tsx`) serving the welcome
opening and the docked session stage; `variant="hero" | "docked"` names the
stage (default derives from `activeSessionId`). The textarea DOM survives a
hero-to-docked move because the parent keeps the mount position stable.

## Geometry (docs/design/V10-SPREAD.md section 1, references d2 and d3)

- Card: `.vex-composer-card` (console.css) - square, 1px
  `--vex-alias-border-input` (the rule), the `--vex-alias-composer` field
  fill (white by day, night-1 at night), no shadow, scrollbar l2 rebind. It
  follows the page column; padding 12/10/10/16 docked, 16/12/12/18 on the
  opening. NO focus treatment of any kind; the accent caret and the send key
  carry focus. Approval park draws the 1.5px ink frame.
- Field: 16/24 sans, the stage's side padding (the placeholder overlay
  mirrors it), height cap 336px (14 lines) then scroll; the opening keeps a
  52px two-line floor.
- Toolbar row: space-between, 10px apart, and an inline-size QUERY
  CONTAINER (`@container`). Seat chips are 28px, 12px Departure Mono on a
  rule outline (`.vex-composer-chip`); the send/stop key is a 40px square:
  the one blue fill to send (a dotted blue outline while empty), the ink
  plate to stop.
  - LEADING cluster (`min-w-0`, shrinkable): model chip, legacy-plan chip,
    reasoning select.
  - TRAILING cluster (`flex-none`, protected): in-flight swatch, access-mode
    seat, context meter, send/stop key.
- Shrink chain (codex Bug 3 / deepseek cross-check section 2). One priority
  order, in three steps: text LABELS truncate first (`min-w-0 truncate` on
  the label span; the chip box carries `min-w-0` and no `shrink-0`); the
  permission LABEL collapses second, at the row container's 460px threshold
  (`@max-[460px]:hidden`, the reference value); fixed glyphs, the context
  meter and the send/stop key never shrink. The reasoning select's 6.5rem is
  a preferred width, not a floor. Nothing is blanket-clipped - a hidden
  focusable control would still be keyboard-reachable.
- Notice line: above the card, 13/20; an error speaks in ink behind the ink
  cross swatch, never red. In-flight mark: the 9px ongoing swatch beside the
  key while a turn is in flight (the page's one state motion).
- Status tag on the field's top rule: `AWAITING SIGNATURE` behind the target
  swatch, `Stopping…` on the rule outline.
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
- Seats: `ComposerSeats` (model chip -> Settings/model, legacy-plan chip ->
  PlanDisplayModal), `ComposerPermissionSeat` (access mode, DISPLAY-ONLY -
  permission is locked at session creation and the renderer never grants or
  widens it), `ComposerContextMeter` (the context meter),
  `ComposerMissionStrip` (read-only mission status word + plan review link).
- Context meter (`ComposerContextMeter`): a 28px trigger carrying the shared
  `CellMeter` (eight 5x12 cells) from `useContextWindow`; past the ENGINE's
  own critical band the cells turn ink. It opens a 264px `role="dialog"` panel above
  and right-aligned. Outside pointer and Escape dismiss it; focus returns to
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
  (`AGENT_PROVIDER`/`AGENT_MODEL`); the model chip deep-links Settings ->
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
