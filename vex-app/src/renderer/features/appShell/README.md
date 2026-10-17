# App Shell: the spread + the sessions index

Exact behavior of the shell's column layout and the sessions index. The
design values are `docs/design/R3-MINIMAL.md` sections 2 to 5. A fresh
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
  44px paper cap. Lighter and Studio show the vx mark at the spine's top.
- The gutter (`ShellGutter.tsx`): the `aria-hidden` spread caption, context |
  tape word | connection, a drag column.
- The running head (`RunningHead.tsx`, seam `shell-status-strip`): the
  centre's 44px drag row, mounted once for the frame; it reserves the Windows
  and Linux caption buttons over a narrow BOOK and carries the folded gutter.

## The left page in agent mode (`SessionsList.tsx`)

docs/design/R3-MINIMAL.md section 4. Furniture on the print, styled in
`styles/global-css/left-page.css` (ink and blue on the sky by day, paper white
on the night print, white on the ground).

- Mast (`AgentSidebarHeader.tsx`): the open page's 44px head row, a drag
  region clear of the macOS traffic lights: the vx mark (`SidebarHomeSigil`,
  "Back to welcome" in a session) and the `Agent | Studio` capsule
  (`RuntimeModeToggle`), in every agent state. The welcome hero carries the
  capsule only while the page is a spine (`leftPage/leftPageContext.ts`), so
  the page holds one `Runtime mode` radiogroup.
- Sky: the 112px italic `Counter` (the open session's ordinal; on the welcome
  stage the session count, captioned SESSIONS), New session (a label box; the
  signing stroke and glint unchanged), the All | Agent | Mission tabs with
  search and collapse at their right, the optional search field, then the
  index. Only the index scrolls; `leftPage/useIndexFold.ts` hides a row or
  head the horizon would cut and the dotted fold counts the rows below
  (`n more`, one page per press).
- Ordinals (`leftPage/sessionOrdinals.ts`): a renderer-local ledger numbers
  each agent session the first time it is seen, oldest first, and keeps the
  number, so pinning, the tabs, the search, a removal or a row ageing out of
  the bounded list never renumber anyone.
- Rows (`SessionRows/SessionRow.tsx`, `index` setting, via
  `leftPage/SessionIndex.tsx`): ordinal, swatch and title, time; the open
  session solid and blue, a running mission the dot screen, a paused one the
  hatch; Remove+Pin replace the time on hover or keyboard focus; HoverCard
  preview; double-click inline rename persisted through `vex.sessions.rename`
  (sessionTitleSchema-bounded; unknown/soft-deleted id -> ok(null)). The
  Sessions library renders the same row in its `register` setting.
- Ground: `$VEX` (`market/VexTokenCardCompact.tsx`: price, change with its
  arrow, spark, one link out), the white hairline, and the profile row
  (`SidebarProfile.tsx`, `ground="print"`): portal `Menu` primitive with six
  action entries + a disabled runtime provenance footer row; screens expand
  from the trigger row's rect.
- Spine (under 1276, or closed by hand): New session, the ordinals
  (`leftPage/SpineIndex.tsx`, the open one behind a 2px bar), the open
  control and the profile box at the foot.
- Quiet scrollbars (`lib/useQuietScrollbars.ts`): the column rebinds the
  `--vex-scrollbar-thumb` pair to transparent while the pointer is outside
  its box (document pointermove probe; 2s linger). Rebinding, not hiding,
  keeps the gutter reservation.

## Known limitations and deferred work

- Hover cards cannot show a wallet count: `SessionListItem` carries no wallet
  fields.
- `BookPanel` still sets its own fixed widths (340px/48px); the grid track is
  the intended width owner (`w-full` interface pending with the book owner).
