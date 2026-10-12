# App Shell: the spread + the sessions index

Exact behavior of the shell's column layout and the sessions index. The
design values are `docs/design/V10-SPREAD.md` sections 2 to 5 and 8. A fresh
agent should be able to rebuild these surfaces from this file.

## The spread (`AppShell.tsx` + `lib/shell-columns.ts`)

- Five grid tracks: left page | gutter | Studio rail | centre | BOOK, solved
  per frame by the pure `computeShellColumns({ viewport, mode, sidebar, book,
  closedBook, zen })`. Every track is a length.
- Contract geometry: CENTER_MIN 640. Left page 300 (wider by drag up to 420,
  only into room the centre does not need), spine 56. Gutter 36 beside the
  page, 22 beside a spine, 0 under the spread. BOOK 300-520 (default 340,
  held at 300 under 1316, collapsed spine 48). Studio rail 240-420 inside the
  centre, icon spine 56. First-column preference 240-420 (default 240).
- Breakpoints: under SPREAD_MIN 1276 the left page and Studio's rail close to
  their spines (a manual toggle there flips the launch-ephemeral
  `sidebarNarrowExpanded` override) and the gutter folds into the running
  head. Lighter and Studio always show the spine.
- Concession chain: a widened page gives its extra back first; then the BOOK
  shrinks to 300, then auto-closes to its 48px spine (DERIVED - the stored
  `bookOpen` preference is never rewritten, widening restores it); the centre
  absorbs the rest and may drop below its floor only in the final fallback.
- Width preferences persist in `stores/uiStore` (`sidebarWidth`, `bookWidth`,
  v10 migration, coerced on every rehydrate).
- Drag handles (`ShellDragHandle.tsx`): 8px strips on the column borders,
  pointer capture, rAF-throttled dx against the drag-start base (the RENDERED
  width, so a concession-clamped panel does not jump). The page handle exists
  only while the page can widen; the BOOK handle only while the BOOK is open
  and free (1316 and up, or Lighter). Track transitions run 300ms on
  `--vex-ease-inout` and pause under `data-dragging`.
- Welcome stage: the Portfolio tab fills the BOOK track; closed, the track is
  0 (no spine).
- The left page (`ShellBackdrop.tsx`): the day or night print in place
  (window size from the column's corner, swapped on `data-vex-theme`), or the
  user's own image from `window.vex.shellBackdrop.read`; the spine adds a
  44px paper cap. Its children slot is the agent state canvas.
- The gutter (`ShellGutter.tsx`): the `aria-hidden` spread caption, context |
  tape word | connection, a drag column.
- The running head (`RunningHead.tsx`, seam `shell-status-strip`): the
  centre's 44px drag row, mounted once for the frame; it reserves the Windows
  and Linux caption buttons over a narrow BOOK and carries the folded gutter.

## Sessions index (`SessionsList.tsx`)

- Open page or spine: the frame decides (`collapsed`); the spine renders the
  icon rail. The column has no surface of its own: the print is the ground.
  The open page's header is the left page's 44px head row (drag region,
  clear of the macOS traffic lights).
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
