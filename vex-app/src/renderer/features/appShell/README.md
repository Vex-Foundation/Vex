# App Shell: three columns, the title bar and the pages

Exact behavior of the shell frame: a left sidebar that says where you are, a
centre that holds the conversation or one page, and Vex's own right sidebar.
The design values are `docs/design/R3-MINIMAL.md` sections 2 to 5, 9.6 and 12.
A fresh agent should be able to rebuild these surfaces from this file.

## The frame (`AppShell.tsx` + `lib/shell-columns.ts`)

- Three grid tracks, `{left}px minmax(0, 1fr) {vex}px`, from the pure
  `computeShellColumns({ viewport, mode, left, vex, welcome, closedVex,
  lighterChat, zen })`; `ShellFrame` measures its own box (rAF-throttled
  ResizeObserver). Every track is a length, so the 300ms
  `--vex-duration-reveal` transition interpolates (`global-css/shell.css`).
- Tiers (`shellTier`, a seam belongs to the wider side): wide from 1360, medium
  1180 to 1359, narrow under 1180. Left 264 / 224 / 224, closed the 56px rail.
  Vex 256 / 240 / 224, hidden 0. CENTER_MIN 640; the 760 transcript cap lives
  inside the centre. Widths are fixed, no drag handle. Minimum window 1000 x 720.
- Narrow tier: the left is asked by the launch-ephemeral `sidebarNarrowExpanded`
  (its toggle flips it; reaching medium clears it), not by `leftOpen`. An open
  Vex keeps the left at its rail; a left the user re-opens closes Vex (derived,
  the stored choice is never rewritten; showing Vex clears the override).
  Under a 640 centre Lighter's chat shrinks to 300 first, then Vex closes, then
  the left folds.
- Left column by mode: agent `SessionsList`, Studio `StudioSidebar`, Lighter the
  same `SessionsList` always on its rail. Zen hands the chart the window.
  `LighterSidebar.tsx` is the desk's title row, not a sidebar.
- Lighter's chat share is the one drag left (`ShellDragHandle.tsx`): an 8px
  strip on the column border while Vex is open there, rAF-throttled dx against
  the RENDERED width at drag start, 300 to 520 and centre-safe
  (`lighterChatDragMax`), stored as `desk.chatShare` (a window share).
- Welcome stage: agent mode with no session, Studio with no project, no page
  open, not Lighter. The Vex track is 0, `VexSidebar` is not mounted and the
  title bar has no Vex toggle: she stands in the centre (`SessionWelcomeHero.tsx`,
  serif greeting, no state word). Her token ("Hide Vex", `aria-pressed`) writes
  `showAvatar`, shared with the sidebar switch and Settings.
- Centre: `RunningHead` (once per frame), the mode's surface (`SessionPanel`,
  `StudioCenter`, `LighterCenter`), then `ShellScreens`. Surface and pages share
  one `ErrorBoundary` (`shell.centre`): "Something in Vex stopped rendering"
  between two standing sidebars, "Close this page" while a page is open. The
  title bar stays outside it. No veil (section 12): `SessionCreator` and the
  mission contract are dialog sheets over the centre.

## The left sidebar (`SessionsList.tsx`, section 4)

Styled in `global-css/left-sidebar.css`. Open, top to bottom:

- Head: the header's logo cell and sidebar key (`AgentSidebarHeader.tsx`,
  H3-DESKTOP.md section 1.3): the vx mark alone, 34 x 27 (`SidebarHomeSigil`,
  "Back to welcome" in a session), set 92 in on macOS after the traffic lights
  and 24 elsewhere, then the 77-wide key cell; over the rail the logo cell alone.
- New chat (55 high on the cell fill) and Search chats (48) as H3 cells, edge to
  edge, then the nav (`SessionRows/SidebarNav.tsx`, H3-DESKTOP.md section 4.6):
  Chat, Missions, Watchlist, Portfolio, Agent Scan, Lighter, Studio, Board,
  Settings (desktop's names where H3 says Markets and Activity), nine caps rows
  on the 40 pitch between two rules, the selected one on
  `--vex-alias-row-selected`. One action backs every row,
  `navigate(destination, origin)` (`navigationTarget`, `uiStore/shell-route.ts`):
  Chat and Missions are agent mode (Missions on its Mission tab); Watchlist,
  Portfolio, Agent Scan (its full feed), Board and Settings open pages; Lighter
  and Studio switch mode. The selected row is `selectNavDestination`: the open
  page first (Agent Scan in any scope selects its row), then the mode.
- The Search chats field is always open in its 48 cell (VEX Cloud's). A typed
  query (or Missions) enters the search mode: All, Agent and Mission tabs with
  counts take the nav's place (local text, title filter). "Clear search" stands
  only while there is a query. Escape clears a query first, then leaves the mode
  and drops the Agent tab.
- The CHATS heading, then the chats by name in Pinned, Today, Yesterday, Earlier
  (`sessionListModel.ts`; H3's "Earlier" where R3 said "Older"), the one
  scroller, over the 100-row session read. `SessionRows/SessionRow.tsx`
  (`sidebar` variant): 36 high, ellipsis name at 15, then the time (24-hour today
  and yesterday, `formatChatRowTime`) or H3's tag, a status square and the word in
  caps, from the mission run (`session-row-state.ts`: Running grey, Waiting ink,
  Paused and Sleeping grey outlines, Error red). Hover or focus swaps the time
  for Pin and Remove; double-click renames via `vex.sessions.rename`
  (`sessionTitleSchema`-bounded; an unknown id answers ok(null)). The Sessions
  page reuses the row as `register`.
- Update slot `vex-upd-slot` (`updates/update-card-slot.ts`): `UpdateCard`
  portals into it above the account row; with no slot it floats at the lower left.
- Account cell (`SidebarProfile.tsx`, the bottom row's first cell): the person's
  avatar disc (the transcript's drawing, the avatar ground on the chosen rule), the name
  or "You", then "Account and settings" (or the runtime's trouble as a sentence),
  and the up chevron. Its upward menu, its foot on the cell's top rule:
  Personalize (which asks for a name while there is none), Memory (when
  enabled), Sessions, Agent Scan, How Vex works, Settings, Lock Vex, a disabled
  Runtime row. Pages open from the trigger's rect (`origin`).
- Rail (76 wide): the open column's H3 cells at the rail's whole width, icon only
  with tooltips: the Expand key (48, behind its rule; none on the band or the
  Lighter desk), New chat (55, the cell fill), Search chats (48), the nav keys on
  the 40 pitch, and the account cell's disc. Chat and Missions open the column on
  their list; on the Lighter desk the drawer opens from Markets & sessions. No
  update slot.
- Studio (`studio/sidebar/StudioSidebar.tsx`): same head, rows, nav and account;
  under the nav New project, Projects with a Welcome row, and the open project's
  explorer in a `SplitPane` sized by `studioRailExplorerShare` (0.2 to 0.8).

## The title bar (`RunningHead.tsx`, section 3)

- The centre's 44px drag row (seam `shell-status-strip`), mounted once because
  `GlobalApprovalsSync` owns the approvals live subscription. It reserves the
  Windows and Linux caption buttons over a narrow Vex column. On the Lighter desk
  it is the desk's title cell, holding the desk's head (`lighterTrading/LighterSidebar.tsx`:
  "Lighter" over the section and deployment, Markets and sessions, New desk
  session, Zen) and a cluster of a page's keys and Notices only.
- Left cell: the page name from `screens/page-crumbs.ts` (`titleBarPageOf`); a
  subpage is a crumb with parent links ("Portfolio / Agent Scan"), each going up
  through `goUpToPage`. Else the Studio project or the session title with "Agent ·
  Restricted" and the mission badge (`MissionRail`). The agent welcome has none.
- Right cluster: a page close key (top-level page outside agent mode), export,
  the Studio host word, Notices (while any exist), the token chip.
- Needs you lives in the Vex console (`features/vex/VexConsole.tsx`, the console
  line under 1024); `NeedsYouAnnouncer` in the header says a rise in its count.
  Review never decides: an on-screen card is scrolled to with Reject focused,
  other approvals open the Needs you page.
- The VEX cell (`features/vex/VexHeadCell.tsx`, D2): VEX and the 44 key that
  hides or shows Vex's column ("Hide Vex" or "Show Vex"); Cmd or Ctrl + Shift + B
  (`vex-toggle-shortcut.ts`, `KeyboardEvent.code`, never Alt; R3's Cmd or Ctrl +
  Shift + Period still works for one release, unspelled) is the same press,
  off under a modal. `VexStateAnnouncer` is the one live region of the word.

## Pages in the centre (`screens/`, section 9.6)

- A page is a `ShellRoute` (`uiStore/shell-route.ts`, launch-ephemeral): `memory`,
  `sessions`, `howItWorks`, `portfolio`, `board`, `needsYou`, `settings`,
  `agentScan` and `assets` (one session or one Studio project, never both),
  `tokenHistory`. `ShellScreens.tsx` mounts the screen under `AnimatePresence`;
  every close goes to `none`, except token history opened from All assets.
- `ShellScreen.tsx` is the sheet: absolute inside the centre under the title bar
  (never reflows a track), a 760 column or `wide` 1100, entering by a FLIP from
  the trigger's `origin` (reduced motion is instant). Focus returns to the opener.
- Escape goes back one page (`page-trail.ts`, 12 pages at most, `none` clears
  it), else the host closes; it yields to a nearer handler or a dialog.

## The Vex sidebar (`features/vex/VexSidebar.tsx`, section 5)

- Props `open` and `onHide`; hidden is 0 width and renders nothing inside. Body:
  head and hide key, state (swatch, scope, word, timer, narration, background
  missions), Needs you, Studio's "This project", the page slot (`vex-sidebar-slot.ts`,
  the Board's Ask Vex), Kimm's section, the "Show avatar" foot. Lighter puts the
  desk chat under the plate.
  Words come from `useVexPresence` (precedence in `vex-state.ts`).
- Open by page class (`vexPageClass`, `uiStore/layout.ts`): `chat` (`vexOpenChat`,
  open by default: chat, Needs you, Memory, Sessions, How Vex works, Studio),
  `pages` (`vexOpenPages`, hidden: Portfolio and subpages, Board, Settings),
  `lighter` (`vexOpenLighter`, not persisted). `setVexOpen` writes only the
  current class's slot; the frame hands her `vexEffectiveOpen`, the solved width.
- She docks when her column shows again after a hide; the welcome keeps her
  column (docs/design/H3-DESKTOP.md section 1.7), so nothing hands her over.
  Hiding lands at the press (`vex-hide.ts`): the Vex key, chip and shortcut call
  `requestVexHide(commit)`; the sidebar hands focus on and the write lands at
  once, her section's own wipe being the close. Derived closes (narrow tier, page
  default, Zen) go at once.

## Persisted layout (`stores/uiStore.ts`, `uiStore/persistence.ts`)

The shell reads `leftOpen` (twin `sidebarOpen`), `vexOpenChat`, `vexOpenPages`,
`showAvatar`, `bookSectionOrder`, `studioRailExplorerShare`, `runtimeMode` and
`activeProjectId`. Not persisted: `sidebarNarrowExpanded`, `vexOpenLighter`,
`shellRoute`, `sessionModeFilter`. `bookOpen` mirrors the last Vex write.

## Known limitations and deferred work

- Hover cards cannot show a wallet count: `SessionListItem` carries no wallet
  fields.
- `sidebarWidth`, `bookWidth`, `bookTab` and `sessionOrdinals` are still persisted
  and coerced but nothing reads them (expand-only migrations); drop them later.
