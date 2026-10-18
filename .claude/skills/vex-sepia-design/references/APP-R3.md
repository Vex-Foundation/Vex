# The app layout: R3 Minimal (VEX Desktop and VEX Cloud `/app`)

R3 Minimal is the app language the owner approved on 2026-10-17 ("działajmy") and that both apps ship since 2026-10-18: a calm agent chat in three columns. A left sidebar says where you are, the centre holds the conversation or one page, and a right sidebar is Vex, the K2 halftone hologram rising from the vx token. The V10 colours and rules stay (paper, ink, one blue, Night Ledger at night, radius 0, no shadow, no glass, status by fill with a word). The V10 Spread is retired: the open book, the left page with its counter, the gutter caption, the running head tape word, the BOOK, the eagle and the flock, the dither veil and the pixel font are gone from the apps.

Read this file for where things sit, then `ELEMENTS.md` for how each element is built, and open `reference-images/app/INDEX.md` before you build.

**Sources of truth.** VEX Desktop: `vex-app/docs/design/R3-MINIMAL.md` (Vex-Foundation/Vex, branch `design/r3-minimal`, reference renders in `vex-app/docs/design/r3/`) and the renderer `vex-app/src/renderer/`. VEX Cloud: the web spec and the shipped web app (private). Where a spec, a mockup and the shipped code disagree, the shipped code wins and both are named here.

Path shorthands used in this file and in `ELEMENTS.md`: `R/` = `vex-app/src/renderer/`, `G/` = `R/styles/global-css/`.

---

## 1. The two rooms (themes)

Celeris is the light room (the website's paper), Chronos is the dark room ("Night Ledger"). Both apps follow the system; a stored choice wins.

| Role | Celeris (light) | Chronos (dark) | Desktop alias / web token |
|---|---|---|---|
| paper, all three columns | `#F3F4F7` | `#1B1412` | `--vex-alias-*` paper / `--vx-bg-base` |
| paper 2 (open tool row, banner, code well, hover step) | `#E8EAF2` | `#221A17` | / `--vx-module` |
| field (composer, inputs, result line) | `#FFFFFF` | `#221A17` | / `--vx-raised` |
| ink, ink 2, muted (muted is also the placeholder) | `#0A0D18`, `#3A3E52`, `#565C78` | `#F3F4F7`, `#BBBABB`, `#989697` | / `text-label-primary`, `-secondary`, `-tertiary` |
| blue: type, links, selected row text | `#0000C0` | `#A3ABFF` periwinkle | / `text-accent` |
| fill: the one primary key, switch on, the token disc | `#0000C0` | `#0000C0` with a 1px `#A3ABFF` edge | / `bg-accent-fill` |
| on fill | `#F3F4F7` | `#FFFFFF` | |
| blue hi (primary hover only in the apps) | `#0000FF` | `#6470FF` | |
| focus ring | `#0000FF` | `#A3ABFF` | |
| rule, rule quiet | blue at 22% and 12% | paper at 14% and 7% (web 13% and 7%) | / `border-rule`, `border-rule-quiet` |
| rule ink (frames, tags, popovers) | `#0A0D18` | `#F3F4F7` | / `border-rule-ink` |
| wash (row hover), selection (selected row, pressed chip) | blue at 5%, 7.5% | paper at 4%, periwinkle at 10% | |
| stamp | ink fill, paper type | paper fill, `#1B1412` type | |
| plate (ground behind a print while it loads) | `#C7B6A6` | `#150F0D` | |
| trading up, trading down (trading values only) | `#10763A`, `#C2272E` | `#4CD685`, `#FF7B7B` | `--vex-alias-trade-up/down` / `--vx-trade-up/down` |
| candles (inside the chart only) | desktop `#22C55E`, `#EF4444`; web `#3C7A55`, `#A9483E` | web `#86B897`, `#D98A7E` | / `--vx-candle-up/down` |
| flat scrim (only when a dialog must block) | paper at 62% | night at 66% | / `--vx-mask-drop` |

- **Selectors.** Desktop: Chronos is the default `:root`, Celeris is `[data-vex-theme="celeris"]` (`G/tokens.css`). Web: light is `:root`, dark is `:root.dark`.
- **No faint tier.** The mockups paint hints in a fainter step (`#8A8FA8`, night `#6F6B6A`); it measures 2.9:1, under the 4.5:1 floor, so both apps paint muted there.
- **Trading colours** measure 5.20:1 and 5.27:1 on paper, 9.75:1 and 7.25:1 on night paper; a solid Long or Short key takes white type by day and `#1B1412` at night. Web contrast row CT26 keeps them off the active, tint and wash fills.
- **One blue fill per view**: send, Approve, Confirm, Unlock. Everything else is outline, quiet or ink.

## 2. Type in the apps

Instrument Sans for every word, in sentence case. JetBrains Mono (tabular, tracking `-.01em`) for every figure, address, time and duration. Instrument Serif 400 only at display sizes (never under 32, never bold). Caps only on tiny tags (REAL FUNDS, HIGH RISK) at 11 / 600. No pixel font: Departure Mono is gone from both apps (desktop removed the face; web rebinds `--vx-font-mono` to JetBrains Mono inside `[data-vx-app]`, so the public site under `_site` keeps Departure Mono).

| Use | Desktop (R3-MINIMAL 1.3) | Web (the web spec, nearest existing role) |
|---|---|---|
| Greeting | serif 52 / 1.02, `-.012em`, blue (46 beside Vex at 1024) | `vx-serif vx-serif-56` (52 to 56) |
| Wake and unlock title | serif 56 / 1 | boot and sign in plates |
| Page head | serif 40 / 1 (Memory, Sessions, How Vex works) | `vx-serif-32`, `vx-serif-40`; most web pages set the title only in the top bar |
| Approval sentence | sans 21 / 1.3, 500 | `text-heading-20` |
| Vex state word | sans 15, 500 (scope 400 muted) | `text-heading-16` |
| Reading text | sans 15 / 1.6 (user 1.55) | `text-headline-15` (15 on 24) |
| Composer text | sans 16 / 24 | |
| Rows, nav, buttons | sans 14 (buttons 500) | `text-body-14` |
| Meta, chips | sans 13 | `vx-meta`, `text-body-13` |
| Group heads, field labels | sans 12 / 500 muted, sentence case | `text-body-12` |
| Tags | sans 11 / 600 caps, `.1em` stamp, `.08em` outline tag | `vx-stamp*` (JetBrains Mono inside the app) |
| Money headline | mono 34 / 1.1, 500, `-.03em` | `vx-figure` (33) |
| Figures | mono 13 tabular (inline 12 to 12.5), `.vex-num` | `vx-num` with a body role |

## 3. The frame: three columns

The window is `left | centre | vex`. One paper per room: the three columns sit on the same ground and are told apart by 1px quiet rules. The left and Vex widths are fixed (no drag handles, except the Lighter desk chat share on desktop).

| Window | Left sidebar | Centre | Vex sidebar (open) |
|---|---|---|---|
| 1360 and up (the 1440 design) | desktop 264, web 248 (R3b allows 240 to 264); foldable to the 56 rail | 1fr, transcript max 760 | 256 |
| 1180 to 1359 (1280) | 224 | 1fr | 240 |
| 1024 to 1179 (1024) | 56 rail with a "Chats" key (desktop: the rail only while Vex is open; 224 if the user opens it with Vex hidden) | 1fr | 224 |
| 768 to 1023 (web only) | 56 rail with "Chats" | 1fr | a 224 sheet over the right edge, no scrim, a 1.5px ink edge, hidden by default; Escape or the token closes it |
| under 768 (web phone) | none: the bottom tab bar | full width | a compact bottom sheet from the top bar token |

- **Centre widths** at 1440: 920 with both sidebars open (desktop). The centre never goes under 640; the desktop window minimum is 1000 x 720.
- **Hidden Vex takes zero width** and the transcript recentres. The chip in the top bar keeps the token, the fill, the word, the timer and "1 mission running".
- **Motion.** Desktop rides `grid-template-columns` on the 300ms reveal (`--vex-duration-reveal`); hiding plays her close episode first (`CLOSE_MS`, `R/features/vex/vex-hide.ts`). Web eases the tracks over 240ms (`--vx-duration-rail`, never on a resize). Both are instant under reduced motion.
- **Code.** Desktop `R/features/appShell/AppShell.tsx`, `G/shell.css`, the geometry tokens `--vex-left-w 264`, `--vex-left-w-md 224`, `--vex-rail-w 56`, `--vex-vex-w 256`, `--vex-vex-w-md 240`, `--vex-vex-w-sm 224`, `--vex-transcript-max 760`, `--vex-head-h 44`. Web: the VEX Cloud web app (private).

### Where Vex opens

| Surface | Desktop | Web |
|---|---|---|
| Welcome | no sidebar: Vex is the centre; she docks into the sidebar on the first message | same |
| Chat, approvals, missions | open (`vexOpenChat`, default true) | open after the first message and on approvals |
| Table pages | hidden (`vexOpenPages`, default false): Portfolio and subpages, Board, Lighter, Settings | hidden: Portfolio, Markets, Settings; open on Strategies, a strategy's overview, Activity |
| Studio | open, "This project" | |
| Memory, Sessions, How Vex works | pages in the centre with both sidebars standing | |

Remembered choices: desktop `vexOpenChat`, `vexOpenPages`, `showAvatar`, `leftOpen`, and the welcome's own `welcomeVexShown`; web one remembered choice for chats and one for pages (the `vx-shell` cookie, version 3), "Show avatar" as a local preference.

### The Vex toggle

The flat vx token chip at the right of the top bar toggles the sidebar (`aria-pressed`, tooltip "Hide Vex" / "Show Vex"). Shortcuts: desktop Cmd or Ctrl + Shift + Period (`R/features/vex/vex-toggle-shortcut.ts`; the Studio terminal refuses the chord to xterm); web Cmd or Ctrl + Shift + B, and Cmd or Ctrl + Alt + B folds the left nav.

## 4. The top bar (44)

The first row of the centre column, 44 high, a 1px quiet rule under it (none on the welcome). Every control in it is 32 high with 8 between.

- **Left cell.** The session title (14 / 500) and its mode in 13 muted ("Agent · Restricted", "Mission · Restricted" plus a 26 high mission badge with a swatch and a word). Pages put their name there, subpages a crumb ("Portfolio / Agent Scan"); Escape goes back one page. Desktop Lighter: "Lighter" with "Perps · {network}"; Studio: the project and "Running · {n} connected".
- **Right cluster, desktop:** page keys (refresh, export), Notices (only while notices exist), "Needs you · N", the token chip.
- **Right cluster, web:** "Needs you · N", the network pill (unfilled), Pause all, the bell (on page routes and the welcome; on a chat with a conversation it lives in the account menu), the overflow menu when it has items, then a quiet rule, "1 mission running" and the token chip. A guest sees Needs you (quiet, 0) and Sign in.
- **On the welcome** there is no token chip (Vex is the centre); Needs you stays on every screen.
- **Desktop title bar per OS.** `titleBarStyle: 'hidden'`; every 44 head row is the drag region. macOS lights at `{x: 20, y: 16}` over the left sidebar head, which starts its content at 92. Windows and Linux (`html[data-os='win']`): the controls overlay is 138 x 43; the head cell under it reserves it (Vex head right padding 148, the centre head with Vex hidden 150).
- **Code.** Desktop `R/features/appShell/RunningHead.tsx`, `G/title-bar.css`, `G/window-chrome.css`. Web: the VEX Cloud web app (private).

## 5. The left sidebar

Paper, a 1px quiet rule on its right. Desktop 264 (224, 56 rail); web 248 (224, 56 rail).

- **Head (44):** the vx wordmark at the left, the collapse key (32 x 32, panel icon) at the right.
- **Body:** New chat (500) and Search, then the nav, then sessions by name, then the account row pinned to the foot.
- **Nav, desktop:** Chat, Missions, Portfolio, Board, Lighter, Studio, Settings. **Nav, web:** Chat, Strategies, Missions, Markets (Watchlist and Scanner tabs), Portfolio (Wallet tab), Activity, Settings; Leaderboard is a Strategies tab. Rows 34 high, a 16 line icon in ink 2, 14 type; the selected row has the selection fill, blue type, weight 500 and a blue icon, and follows the route.
- **Sessions:** grouped ("Today", "Yesterday", "Older", "Pinned" on desktop; day groups on web, "Earlier" in the captures), 12 / 500 muted heads; a row is the name (ellipsis) and a time in mono 11.5 muted, or a swatch and a word in 12 muted when it has a state (Running, Paused, Waiting, Sleeping). No ordinals, no counters.
- **Rail (56):** icons only with tooltips, 40 x 40 keys, an explicit "Chats" key (desktop 48 x 50, icon over an 11px word) that opens the named session drawer (web: a chats popover under 1180), the account avatar at the foot. Desktop Lighter always uses the rail.
- **Desktop only:** Studio puts its projects and explorer under the nav; the update card sits above the account row.
- **Web only:** Settings replaces the left nav with its own grouped nav ("Back to chat", then Account, Trading, Vex, Records).
- **Code.** Desktop `R/features/appShell/SessionsList.tsx`, `SessionRows/SidebarNav.tsx`, `SessionRows/SessionRow.tsx`, `SessionRows/SessionSearch.tsx`, `SidebarProfile.tsx`, `G/left-sidebar.css`. Web: the VEX Cloud web app (private).

## 6. The centre

- **Chat:** a centred transcript, max 760; the composer docked under it (padding 0 0 22). Nothing else in the centre.
- **Welcome:** Vex's stage centred, the serif greeting, the 720 composer, four task rows (section 8).
- **Pages:** money and work live on their own pages in the centre, never in a side panel. Desktop page padding 22 40 24 (Portfolio), 30 40 0 with a 760 column (Memory, Sessions, How Vex works), Settings with its own 236 nav inside the centre. Web page widths through `PageBody`: form 760, default 1040, wide 1120.
- **The connection banner** is a 40 high row of the centre column under the top bar (paper 2, a 1px ink rule below), never across the three columns.

## 7. The Vex sidebar

Width 256 (240, 224); hidden is zero width. Paper, a 1px quiet rule on its left. Information first, then her portrait.

1. **Head (44):** "Vex" 14 / 500 and the hide key (32 x 32).
2. **State:** a 12 swatch, the scope and the word ("This chat: Working", 15, scope 400 muted, word 500), the timer in mono 12 muted at the right; the narration under it (13.5 / 1.5 ink 2), then the background line ("1 mission running · {title}" with a running swatch).
3. **Needs you · N:** a 1px quiet rule above, 12 / 500 muted heading, items with the action as the title, a 12 muted meta line, "Review ↓" or "Open" in 13 / 500 blue; "Nothing needs you." when empty.
4. A spacer, then **the portrait plate**: 280 high (220 to 280 allowed in small windows, 236 at 1024), her face at least 90 px, cut at the shoulders, a short beam of dots to a small token at its base, on the print.
5. **Foot:** "Show avatar" (13 ink 2) and its switch.

- **Desktop extras:** Studio adds "This project" (Project assets, Agent Scan); Lighter mounts the desk chat under the plate; inspect views take over the body with a Back key.
- **Web extras and differences:** the shipped panel sets the word first and the scope under it ("Ready" over "This chat"; the spec and the kit write "This chat: Ready"), adds "Open Activity" under Needs you (up to three items), an "AI permission" block ("Restricted access: always asks before acting.", "Change in Settings"), and a strategies disclosure with each run's switch. A guest sees the state and Needs you only.
- **Avatar off:** no plate and no hologram anywhere. Desktop stands the 44 flat token with a thin state ring beside the state line (`R/features/vex/VexStatus.tsx`); web stands the 44 flat token beside the state, without a ring (56 on a stage).
- **Code.** Desktop `R/features/vex/VexSidebar.tsx`, `VexPortraitPlate.tsx`, `VexStatus.tsx`, `narration.ts`, `background-work.ts`, `needs-you.ts`, `vex-state.ts`, `G/vex-sidebar.css`. Web: the VEX Cloud web app (private).

## 8. The welcome

No Vex sidebar: Vex is the centre (the brand moment where the eagle used to be).

- Her stage 268 to 284 high (240 to 300 allowed; web `welcome` stage 284 x 300), her token under her, **no state word under her** (owner, 2026-10-17: the state lives in the title bar chip and the Vex sidebar).
- The serif greeting in blue (desktop 52, margin 16 0 24), the composer (720; 540 beside Vex at 1024 on desktop, where she sits left of the greeting), then four task rows: desktop "Check wallet balances", "Review the market", "Create a mission", "Trade perps on Lighter"; web members get the same first three and "Analyze BTC 4h", guests get the home tiles and the guest line.
- **The token is the toggle** ("Hide Vex" / "Show Vex"): pressed, she closes into the upright coin and the stage collapses to it, so the greeting and the composer move up; pressed again, she wakes from it. Desktop keeps its own persisted `welcomeVexShown` (independent of "Show avatar"); web drives it from the saved Show avatar choice. The R3-MINIMAL text still says the welcome writes `showAvatar`: the desktop code wins.
- On the first message the token travels into the sidebar and she appears there (reduced motion: she simply appears).

## 9. Brand moments

Only where there is room: the welcome, the wake and unlock stage, the first run and wizard, the Vex sidebar plate, the Settings preview; on the web the boot splash, the loading window, sign in and the 404 and error plates. Working views are paper and type.

| Place | Geometry |
|---|---|
| Desktop wake, unlock, first run | a 720 wide plate at the left, full height, paper at the right (padding 0 120 0 96); token `bottom 118`, the state word `bottom 84` on the print (13 / 500 white) |
| Desktop wizard | the plate shrinks to 480 (at 1000 x 720 no plate: a 40 mark and the state word above the form) |
| Desktop Settings preview | a 200 x 220 plate beside its text |
| Web boot splash, loading window | the turning 3D token from pre-rendered sprites (no three.js), on paper or night ground, "Loading" in Sans, a Reload line after 10 s, reduced motion a still frame |
| Web sign in, 404, route error | Vex on a print plate (sign in "Looking at you"), one 404 inside the frame for every unknown path |

The print is the shipped plateau, day or night, with the plate ground `#C7B6A6` (night `#150F0D`) behind it while it loads. The 3D coin appears only here; working views use the flat token.

## 10. Overlays without veils

Nothing dims the window. Approvals are inline cards; the mission contract and the new session form are sheets or panels over the centre with both sidebars standing; menus, popovers and toasts are flat panels with ink rules. A dialog that must block (destructive confirms, token launch, "Trade with real funds?") uses the flat paper scrim (62%, night 66%), never the old dot screen dither. Values in `ELEMENTS.md` section 22.

## 11. The phone (VEX Cloud under 768)

- **Top bar** 52 high (padding 0 8 0 16), no menu key: the title, Needs you, the network and Pause all in short forms, the bell on page routes, the token chip with its word; controls 44 high, 4 apart.
- **Bottom tab bar:** four tabs, Chat, Portfolio, Markets, More; a calm line glyph over a Sans word, 56 tall, 44 targets, safe area insets. Only the current tab carries the accent wash and the blue word. More opens the nav drawer (`#app-drawer`): New chat, Search, the seven sections, the chats and the account. Vex is never a tab: she is the token in the top bar.
- **Vex sheet:** a compact bottom sheet from the token: state, narration, Needs you, a small portrait (128), "Show the full portrait", the avatar switch. **Approvals open straight to the decision**, with 44 high actions in a sticky footer.
- **Welcome:** her portrait 238 x 240 on paper, the greeting, the rows, the composer docked.
- The mockups (`wx41` to `wx49`) draw a menu key drawer and no tab bar; the shipped phone has the four tab bar (owner decision 9). Follow the code.
- **Code.** The VEX Cloud web app (private).

## 12. Widths every screen is checked at

- **Desktop:** 1440 x 900, 1280 x 800, 1024 x 720, 1000 x 720 (the minimum), light and dark, macOS and Windows title bars. Check the 1179/1180 and 1359/1360 seams.
- **Web:** 1440, 1280, 1024, 768 and 390 (also 375 x 667), light and dark, Chromium and WebKit. No horizontal scroll; 44 px targets on the phone.

## 13. What R3 retired, and what it kept

| Retired (V10 Spread) | Instead |
|---|---|
| Departure Mono for every number and label; tracked caps everywhere | Instrument Sans words in sentence case, JetBrains Mono figures, caps only on tags |
| The left page with the giant session counter, ordinals, the vertical gutter caption, the running head tape word | sessions by name, the title once in the top bar, state as a swatch and a word |
| The BOOK and money panels around the chat | Portfolio, Board, Lighter as pages |
| The eagle and the flock as the agent's state; the print band behind the session list | Vex K2 in the right sidebar, her mood per state, the word always beside it |
| The dot screen dither veil behind dialogs | no veil; inline cards, sheets, the flat scrim when a dialog must block |
| Status without trading colour anywhere | green and red back on trading values only (P&L, bids and asks, Long and Short, Buy and Sell, 24h change) |

Kept: paper, ink, one blue, Night Ledger, radius 0, no shadow or glass or gradient (the hologram's light excepted), status by fill always with a word, serif display, sepia prints as brand moments.
