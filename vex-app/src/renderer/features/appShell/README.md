# App Shell: layout frame + left sidebar

Exact behavior of the shell's column layout and the sessions sidebar,
rebuilt in the UIUX rebrand phase 3. A fresh agent should be able to rebuild
these surfaces from this file.

## Column frame (`AppShell.tsx` + `lib/shell-columns.ts`)

- Three grid tracks: sidebar | session column | BOOK, solved per frame by the
  pure `computeShellColumns(viewport, sidebarPref, bookPref)`.
- Contract geometry: CENTER_MIN 640; sidebar 264-420 (default 280, rail 56,
  auto-collapse below 1024); BOOK 300-520 (default 360, collapsed spine 48).
- Concession chain: sidebar never concedes; BOOK shrinks to 300, then
  auto-closes to its 48px spine (DERIVED - the stored `bookOpen` preference
  is never rewritten, widening restores it); center absorbs the rest and may
  drop below its floor only in the final fallback.
- Width preferences persist in `stores/uiStore` (`sidebarWidth`, `bookWidth`,
  v10 migration, coerced on every rehydrate). The narrow-viewport re-expand
  override (`sidebarNarrowExpanded`) is launch-ephemeral.
- Drag handles (`ShellDragHandle.tsx`): 8px strips on the column borders,
  pointer capture, rAF-throttled dx against the drag-start base (the RENDERED
  width, so a concession-clamped panel does not jump). Track transitions run
  300ms on `--vex-ease-inout` and pause under `data-dragging`.
- Welcome stage: the BOOK track is `auto` (the floating Portfolio tab sizes
  itself); the solver drives the BOOK track only with a session open.

## Sidebar (`SessionsList.tsx`)

- Collapse choreography (`lib/useCollapseChoreography.ts` +
  `.vex-sidebar-*` in `styles/global-css/shell.css`): 0-150ms the wide
  content freezes at its expanded width and fades in place; at the 150ms
  settle the rail controls enter the 56px spine from a 49px offset over the
  track transition's second half; the foot only fades. Cold-collapsed mounts
  render statically; expand remounts wide content on a 200ms fade.
- Quiet scrollbars (`lib/useQuietScrollbars.ts`): the column rebinds the
  `--vex-scrollbar-thumb` pair to transparent while the pointer is outside
  its box (document pointermove probe; 2s linger). Rebinding, not hiding,
  keeps the gutter reservation.
- Rows: generic primitives in `components/ui/rail-list.tsx` (RailRow 32px /
  radius 8 / title 14/20 / time 12/20; hover fill == selected fill;
  actions replace the time on hover; RailGroup eyebrow headers; 
  RailSearchField). Session mapping lives in `SessionRows*` - state dot in
  the leading slot (pixel chase while live, warn while paused), Remove+Pin
  cluster, HoverCard preview (full title, started time, mode facts),
  double-click inline rename persisted through `vex.sessions.rename`
  (sessionTitleSchema-bounded; unknown/soft-deleted id -> ok(null)).
- Profile footer (`SidebarProfile.tsx`): portal `Menu` primitive with six
  action entries + a disabled runtime provenance footer row; screens expand
  from the trigger row's rect.

## Known limitations and deferred work

- Hover cards cannot show a wallet count: `SessionListItem` carries no wallet
  fields.
- `BookPanel` still sets its own fixed widths (340px/48px); the grid track is
  the intended width owner (`w-full` interface pending with the book owner).
