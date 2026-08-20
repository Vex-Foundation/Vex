# Session composer (the floating capsule)

The composer is one component (`../SessionComposer.tsx`) serving the welcome
hero and the docked session stage; `variant="hero" | "docked"` names the
stage (default derives from `activeSessionId`). The textarea DOM survives a
hero-to-docked move because the parent keeps the mount position stable.

## Geometry (catalog 1:1)

- Card: `.vex-composer-card` (console.css) - radius 22px, 1px
  `--vex-alias-border-input` (thin-in-dark), `--vex-alias-composer` fill,
  `--shadow-lv2`, max-width 780px, top padding 10px, scrollbar l2 rebind.
  NO focus treatment of any kind; the accent caret and send key carry focus.
- Field: 16/24 sans, padding 4/12/0/16 (placeholder overlay mirrors it),
  height cap 336px (14 lines) then scroll; hero keeps a 52px two-line floor.
- Toolbar row: space-between, gap 12, padding 2/8/6. Seat chips are h28/r8
  13/20 medium; the send/stop key is a 34px r999 accent circle with a
  background-color 100ms transition, riding -2px out of the row's shift.
- Notice strip: above the card, r8, pad 4/8, 12/18; error tone on the
  danger wash. Pending dot: 8px, `1s ease-in-out infinite alternate`,
  beside the key while a turn is in flight.
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
- Seats: `ComposerSeats` (model chip -> Settings/model, permission pill
  display-only, legacy-plan chip -> PlanDisplayModal),
  `ComposerContextRing` (14px ring from `useContextWindow`, engine
  pressure-band tint, breakdown tooltip), `ComposerMissionStrip` (read-only
  mission status word + plan review link).

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
