# H3: the desktop design

VEX Desktop's next look, H3, is a grid of square cells on a near-black ground: the chats column on the left, Vex's column in the middle, the chat on the right, one header row across all three and one bottom row under them. Vex's column holds the Vex key, her console and Kimm's section, the illustrated figure the person opens and closes. Opening or closing her section never moves a waiting money card.

**D2 (owner decision, 2026-11-09).** The app shell (the chat interface and its frame, in the agent shell and Studio) no longer stands Vex's column in the middle: it stands at the RIGHT edge, a fixed 280, under a VEX cell in the header, with Kimm as a portrait card at its top, and hiding Vex hides that whole column while its room stays. Since 2026-11-10 (owner decision) that column is a panel docked at the chat's top right, as tall as what it holds, and the chat runs to the window's right edge under it (section 6.3). Section 6 records D2 and every behaviour it changed; where a section of 1 to 4 below describes the shell's middle column, Kimm's section in it, its wipe, strip, corner key or first-close hint, or H3's Vex key in the header, section 6 replaces it for the shell. The Lighter desk (section 4.9), the lock screen (section 4.13) and the screens before the shell (wake, checks, migrations, the wizard) are not part of D2 and keep what those sections say.

This document is the desktop's contract for H3, in the shape of `R3-MINIMAL.md`. R3-MINIMAL stays the source of truth for a screen until the slice that restyles it lands; the last slice points R3-MINIMAL here. Once a slice lands, code comments cite this file as `docs/design/H3-DESKTOP.md section N`. Row IDs such as S1-03 are the feature rows of the revamp plan (`.context/revamp-ui-plan.md`, kept locally by the lead), one commit each.

The source is the VEX Cloud "v99 round 3" mockup sheet, app variant H3, dated 3 November 2026. Cloud builds the same design in `Jcaster99/Vex` (`apps/web`). No H3 branch was on that remote on 3 November 2026, so both apps start from the same mockup; wherever this document derives a number the mockup does not print, the number is reconciled with Cloud once Cloud's branch exists.

## Rules
- The ground is near black, and every surface is a square cell divided from its neighbours by 1px rules. Radius 0 (save the chat bubbles and the avatar circle, section 2.4), no shadow, no blur, no glass. The only gradients are Kimm's ground (the glyph field's own blue and its fall to the page) and the chosen row's fill (a chosen row and the row under the pointer in the chats column).
- Labels are uppercase and tracked; sentences, names and values are in sentence case. Words are written in sentence case in code and uppercased by the label style, so a screen reader reads words, not letters.
- One saturated blue fills primary keys and nothing else. It is never type on the ground.
- A status is a small square beside a word, and every status has its own drawing (solid, blink, target, cross, frame, dotted frame, hatch), so a colour never stands alone (section 2.2). Gains and losses in trading values take green and red type.
- Be Vietnam Pro for words, Roboto Mono for figures and for the money card's field labels.
- Opening or closing Kimm's section never moves, resizes or covers a waiting money card (section 3.6).
- Desktop shows only what it can back with real data (`AGENTS.md`). An H3 element with no desktop source is left out or replaced by a true one, never drawn with sample values.
- Dark only.

## How the numbers were taken
- **Printed:** the mockup prints the value on its own plates (the proof plate's CSS boxes, the strip plates' clip insets, the plate captions). Exact.
- **Measured:** read from a capture. The 1440-wide app captures are 1600px images, so CSS px = image px / 1.111. A 1 CSS px feature lands on one or two image pixels, so measured lengths are plus or minus 1px. Phone captures are 780px images of a 390px page (divide by 2). Colours are read from WebP files, which move dark values by one to three sRGB steps and blur marks under about 4px.
- **Derived:** computed from printed or measured values. The derivation is given.
- **Open:** not settled. The line says what would settle it.

## Reference captures
Captures of the mockup sheet, rendered from the running mockup with sample data. They are not in the repo. Open: add them under `docs/design/h3/`, as R3's renders are under `r3/`, if the owner wants them versioned. Names below drop the `.webp` suffix. "SAMPLE DATA" on the captures marks the mockup and is never an app word.

| Capture | Shows |
|---|---|
| `h3-merged__welcome-open-1440`, `h3-merged__welcome-closed-1440` | New chat, her section open and closed |
| `h3-merged__approval-open-1440`, `h3-merged__approval-closed-1440` | a swap card waiting, open and closed |
| `h3-merged__portfolio-open-1440`, `h3-merged__portfolio-closed-1440` | Portfolio, open and closed |
| `h3-merged__phone-band-open-390`, `h3-merged__phone-band-closed-390` | the phone band over a filled receipt |
| `h3-merged__plate-proof` | the proof that a waiting money card never moves |
| `h3-merged__plate-controls` | how the person closes and opens her section |
| `h3-merged__plate-strip-open`, `h3-merged__plate-strip-close` | the open and close frames with their clip insets |
| `landing-r3__plate-key-moods` | her key's moods |
| the other `landing-r3__*` captures | the public home page; out of scope for desktop |

---

## 1. Layout

### 1.1 The frame at 1440 x 900
Three columns and three rows of cells.

| Box | x, y, width x height | Source |
|---|---|---|
| header row | 0, 0, 1440 x 76 | measured: the rule under it at y 75 to 76 |
| chats column | 0, 76, 248 x 752 | measured |
| Vex column | 248, 76, 432 x 752 | printed: the section's x and width |
| chat column | 680, 76, 760 x 752 | printed: the card's x and width |
| bottom row | 0, 827, 1440 x 73 | measured: its top rule at y 827 to 828, then 72; VEX Cloud's foot line, 72 x zoom and its rule (`--vex-h3-foot`, section 1.11) |
| Kimm's section, open | 248, 264, 432 x 563 | printed |
| Kimm's section, closed (the strip) | 248, 264, 432 x 56 | printed: clip inset 507 of 563 |
| the swap card | 680, 249, 760 x 651 | printed |

Her section ends on the bottom row's top rule (264 + 563 = 827). The swap card's box runs to the window's foot: its decision row is the bottom row's chat cells (section 1.8).

### 1.2 The column rule and the tiers
VEX Cloud's rule (PD-14 of its build plan; `--vex-w` in the H3 mockup's `css/tokens.css`, lines 180 and 202, and its measured boxes in `renders/checks.json`), which replaced the rule derived here on 3 November 2026:

- the chats column is a fixed 248 from 1280 up, the 76 rail under it (section 4.12);
- the Vex column is clamp(360px, 30vw, 768px) from 1280 up, unrounded, and a fixed 340 from 1024 to 1279;
- the chat column takes the rest;
- under 1024 the band layout takes over (section 1.10).

Evidence:
- Printed boxes: at 1440 the card starts at 680 = 248 + 432, and 432 is 30% of 1440. At 2560 it starts at 1016 = 248 + 768, and 768 is 30% of 2560 and the clamp's cap; its width 1544 is the rest.
- Cloud's measured boxes (`renders/checks.json`, 4 November 2026): the Vex column 384 at 1280, 576 at 1920 and 768 at 2560; at 1024 x 768 the column is 340 and the content 608 (the README's table). At 1366 Cloud lays 30vw unrounded, 409.8; desktop's solver and its `--vex-h3-vex-w` token do the same, so the two apps agree to the fraction and need no tolerance.

| Window width | Chats | Vex | Chat | Note |
|---|---|---|---|---|
| 1000 to 1023 | 76 rail | a band | 924 to 947 | the band layout; desktop's minimum window is 1000 x 720 (`src/main/windows/bounds.ts`) |
| 1024 | 76 rail | 340 | 608 | Cloud's measure. The chats are the rail here; their key opens the chats panel over Vex's column (section 4.12) |
| 1180 | 76 rail | 340 | 764 | the chats panel, as at 1024 |
| 1224 | 76 rail | 340 | 808 | the first run's window on a 1440px display (85% of the work area) |
| 1280 | 248 | 384 | 648 | the stored default window, 1280 x 800 |
| 1366 | 248 | 409.8 | 708.2 | Cloud's unrounded 30vw |
| 1440 | 248 | 432 | 760 | the 1440 captures |
| 1536 | 248 | 460.8 | 827.2 | |
| 1920 | 248 | 576 | 1096 | |
| 2560 | 248 | 768 | 1544 | printed; the clamp's cap from here up |

What follows from the rule:
- The tracks are a function of the window width only: no drag, no hysteresis, nothing that reads her section's state. This is the first of the money rule's three legs (section 3.6). The solver is S2-01's (`lib/shell-columns.ts`).
- There is no chat floor. R3's `CENTER_MIN` of 640 goes: the H3 proof shows the card working at 1280 with one to three rows below the fold, and at 1024 the chat is Cloud's 608. Open: whether the cells in the header and the bottom row fit between 1024 and 1279 (section 1.3). Settled in the harness at 1024 and 1280.
- In a chat, the Vex column's width never depends on whether her section is open. On pages, closing her folds the column to a line (section 1.9).
- The sidebar key, from 1280 up, folds the chats column to the 76px rail and the chat takes the freed 172px: the person's own fold. Under it the chats are the rail at every moment and the key opens the chats panel over Vex's column, so no track changes (section 4.12).

### 1.3 The header row
76 high, one row of cells across the window. It is mounted once, because it hosts the app-wide approvals sync (`RunningHead.tsx`: preload allows one subscriber per event), and every cell that is not a control is a window drag region (`.vex-drag`).

Cells at 1440, measured from the rules in `h3-merged__welcome-closed-1440`:

| Cell | x, width | H3 draws | Desktop puts |
|---|---|---|---|
| logo | 0, 171 | the mark and "CLOUD" | the mark, 34 x 27 in ink (VEX Cloud's `.hd-home svg`), 24 in from the cell's edge; on macOS it starts after the traffic lights (section 4.7) |
| sidebar key | 171, 77 | the panel icon | the same key: it folds the chats column to the rail |
| Vex key, portrait | 248, 76 | her mood still when closed; the fold glyph on a raised fill when open | her mood still closed; open, Cloud's portrait glyph on the open ground, the two crossfading (section 1.6) |
| Vex key, state | 324, 295 | the state square and word, a timer while live; then HIDE VEX or SHOW VEX and three keycaps | the same, with desktop's state words |
| Vex key, chevron | 619, 61 | down when closed, up when open | the same: 60 and the column's own rule, as Cloud's CSS draws it (`.vk-dir`) |
| chat title | 680, 398 | the chat's title, and "SAMPLE DATA" under it | the title, and under it the chat's kind and access ("Agent · Restricted") |
| network | 1078, 240 | MAINNET, the REAL FUNDS mark and a chevron: a network menu | MAINNET and the REAL FUNDS mark, with no chevron: a statement, not a menu |
| pause | 1318, 122 | PAUSE ALL | left out (no global pause); on Windows and Linux the caption buttons sit here (section 4.7) |

Text sits 24 in from a cell's left edge (the chat title at 704); the Vex key's state cell sets its text 20 in (at 344) and 12 from its right. Under 1024 the Vex key's cell is 288 wide with the waiting count (section 1.10).

The three Vex key cells span the Vex column, so they narrow with it: at 1024 the state cell is 307 - 76 - 61 = 170 wide (the chevron's 60 and the column's rule), and the chat column's 469 must hold the title, the network cell and, on Windows, the 138px caption reserve. How they give way is VEX Cloud's (the H3 mockup's width rules, 2026-11-05), on the window's width: under 1440 the Vex key drops its keycaps and sets its state line at 12; under 1280 the key says the short state word ("Waiting") and the network cell says MAIN with the hatch, its words kept for assistive tech (section 1.6, Appendix A.1).

### 1.4 The chats column
248 wide. Measured in `h3-merged__welcome-closed-1440`, top to bottom:

| Part | y, height | Contents |
|---|---|---|
| New chat | 76, 55 | the new-chat icon at 24 and NEW CHAT at 58, on the cell fill |
| Search chats | 131, 48 | the search icon and "Search chats" |
| nav | 179 to 472 | seven rows on a 40px pitch, an icon and a caps label each; the selected row's fill fades from the column's left edge to the ground at its right |
| chats | 472 to 828 | the CHATS heading, then the groups TODAY, YESTERDAY and EARLIER, rows on a 36px pitch: the title (ellipsis) and at the right a time, or a square and a RUNNING or WAITING tag |
| account cell | the bottom row, 0 to 248 | the person's avatar disc, "You", "Account and settings", an up chevron |

Under 1024 the column is the 76px rail (section 1.10). The nav's entries on desktop are in section 4.6.

The Search chats field is always open in its 48 cell, VEX Cloud's (`shell/sidebar/chat-search.tsx`, `.vx-lc-search`): no row opens into it. The search icon is muted, the input 14 on the placeholder ink, and the whole cell carries the 2px focus ring. "Clear search", a 24 key with the 16 close glyph, stands only while there is a query; it empties the query and focuses the field. Escape with a query clears it and keeps the focus; with an empty field it passes on. A typed query (or the Missions row) enters desktop's search mode: the All, Agent and Mission tabs with their counts take the nav's place under the field and the CHATS heading's, New chat staying above; the empty field's Escape, from anywhere in the column, brings back the sections. The rail's search key opens the column (from 1280) or the chats panel (under it) with the field focused. Once a typed query rests for 250 ms a polite live region says "{n} chats found" ("1 chat found") or "No chats match your search.", and the narrowed chats are named "Search results" (Cloud's `chat-list.tsx`); a new query with the same count is spoken again.

A chat row's keys (Pin and Remove, desktop's) take its trailing cell's place on hover and keyboard focus, as Cloud's row menu does (`.vx-lc-rowmenu`): the time or the tag leaves the row, the title's right padding narrows to 8 so the title gains the room, and the keys stand in the row's flow 8 from its edge. At rest they take no width but stay in the tab order. The time or the state stays in the row's accessible name through a hidden copy.

The account cell takes VEX Cloud's built metrics (`account-launcher.tsx`, `.vx-lc-me`): a grid of 34 / 1fr / 16 at gap 12, the disc 34 across, the name at 14 over "Account and settings" at 12 muted, the 16 up chevron muted. Hover is Cloud's cell hover at 5% (the ink at 5%, white at 5% on Cloud); while the menu is open the cell lays the chosen row's wash over the rail's ground and the chevron turns 180 degrees in 300ms (at once under reduced motion; Cloud's house curve is JS only on desktop, so the sheet turns it on the out curve). Its accessible name is Cloud's, "{name}, account and settings", or "Account and settings" on the rail; the runtime's state is its description ("Runtime: Connected"). On the rail the shared tooltip says the name, or the trouble's sentence while the runtime has one, and stays down while the menu is open. The unread count on the avatar is not taken: desktop keeps its header Notices pill (owner decision, 2026-11-09; section 4.8).

The column never zooms (section 1.11); from 1920 its words step up instead, as Cloud's do (`styles/left.css`): New chat and the nav to 14, the day heads, tags and times to 12, the chat rows, the search field and the account name to 15.

The list's states, VEX Cloud's (`shell/sidebar/chat-list.tsx`, `.vx-lc-msg` and `.vx-lc-error`), in the column and in the chats panel alike: one sentence at 14/1.4 in the muted ink, padding 6 24 10, its mark 10 before it. Loading is the stepping hatch (14 square, still under reduced motion and Save-Data) and "Loading chats", a status. A failed read is the cross and "Chats could not load." (an alert, main's own reason after it when it gave one), over an outline Retry key 40 high, 4 24 round it, which reads the list again and says "Retrying…" while the read runs, staying focusable. The empty and no-match lines stand alone. The Lighter desk's drawer keeps its placeholders until its own restyle.

### 1.5 The Vex column
Measured in the approval and welcome captures at 1440, top to bottom:

| Part | y, height | Contents |
|---|---|---|
| the Vex key | the header, 248 to 680 | section 1.6 |
| Needs you head | 76, 44 | NEEDS YOU, and the count at the right, muted at zero (Cloud's `b[data-zero]`); VEX Cloud's `.cn-h`, its rule inside. The console's heads (Needs you, AI permission, This project, Recent activity) are `h2`, as Cloud's are under its `h1` title |
| Needs you row | 120, 64 | the decision as a sentence ("Approve swap: 200 USDC → ETH"), a meta line ("Mainnet, real funds · since 12:40") and a REVIEW key cell with a chevron (559 to 680, raised fill); at zero, "Nothing needs you." |
| missions row | 184, 40 | the missions icon, "1 mission running on Mainnet · Grow ETH", a chevron |
| strategies row | 224, 40 | "2 strategies running", a chevron. Not on desktop |
| Kimm's section | 264, 563 | a fixed box over the rest of the console |
| the console's rest | under her section | seen while she is closed: strategy rows (62 each, with a MAINNET tag and a switch), AI PERMISSION (a 44 head, then its sentence and "Change in Settings"), RECENT ACTIVITY (a 44 head, rows about 43 high, each with a status square and word), OPEN ACTIVITY with an arrow, ending at 826. OPEN ACTIVITY is the console's foot, as VEX Cloud builds it (`.vx-cn-foot`): 44 high under a top rule on the column's ground, pinned to the column's foot and sticky while the rest scrolls. Open: Cloud also fits whole Recent rows to the room left (40 to 56 each, five at most, `console-fit.ts`); desktop still shows four rows of 43 and lets the rest scroll |

**Her section, open:** her figure over the glyph field (` VEX` on its blue horizon, falling to the page). Desktop draws her as VEX Cloud's built stage does (`kimm.css`, settled 2026-11-08): the ground is the field's baked frame (`field-still.webp`, from 1600 `field-still-wide.webp`, which holds its own fall to the page) set from her top centre to cover the box, under `linear-gradient(to bottom, transparent 48%, page)` below 1600, until the live field has painted; her figure is her mood's still, 48 from her top (x zoom from 1760, as the column zooms), 88% of her width, centred, cut by her foot. In the band (1000 to 1023) the same still stands 12 from the band's top at 720 / 1040 of the width Cloud gives its phone still, so the foot row cuts it at the chest. The HIDE VEX key, the words and a cross, is a solid 56-high cell in the section's top right corner, 542 to 680 (138 x 56, measured). Desktop draws it as VEX Cloud's mockup source does (`.kz-cell`, settled 2026-11-05): opaque on the header's ground without its alpha (`--vex-alias-header-solid`, #010102, Cloud's `--vx-header-solid`), no blur, a 1px rule on its left and its foot (the foot clear on the strip), padding 0 18 0 20, a 12 gap, 13px caps, an 18px glyph, the raised fill under a hovering pointer; its width is its words', 137 open and 148 in the strip at 1440.

**Closed:** the section folds to its top 56, the strip, 264 to 320: her section's own top, the ground and the glyph field holding its frame (VEX Cloud dropped its `strip.webp`; the strip has no file of its own), and the same key, now SHOW VEX with a down chevron, 531 to 680 (149 x 56, measured). The console's rest starts under the strip.

**The box.** Her section is a box laid over the column, not a row in it: left and width are the column's, its top is the foot of the console's top block, and its foot is the bottom row's top rule (Cloud's foot line, section 1.11). Its size is a function of the window only; open and closed differ only in its clip-path (section 3.2). Its height is the window height less the foot row (73 at a zoom of 1) less its top; from 1760 up its top is 148 x zoom (section 1.11).

**Desktop's box.** Desktop has no strategies row (section 4.1), so the console's top block is 40 shorter, 44 + 64 + 40 = 148 (Cloud's rows, each with its rule inside; Cloud's head rows are 188), and her section starts at y 224, not 264. At 1440 x 900 the box is 248, 224, 432 x 603 and the strip is 248, 224, 432 x 56 (derived). Its height is 423 at a 720-high window, 503 at 800 and 603 at 900. The missions row stays when no mission runs, with its own words (Appendix A), so the box never moves when a mission starts or ends.

**Needs you lists every decision** (VEX Cloud's `h3-shell-gaps`, decisions 4 to 6, settled 2026-11-05). Cloud lets the list grow until her section reaches a 240 floor and then scrolls it. Desktop's box must not move, not even while she waits, so the top block keeps its 148 and her top its 224: the list scrolls inside the decision row, one whole 63 row at a time (scroll snap, no bar), the decision that expires first leading, then the rest in the model's reading order. A cue cell at the head's right end, behind its rule, says "{n} more below" with its chevron down and pages the list; at the list's end it reads "{n} more above" with the chevron turned. The 240 floor never binds on desktop: at the 720 window floor her box is 423 high.

- **Loading** holds the rows' height with parked covers (`Cover`: a 12 high bar on the raised fill, its 1px head at the left, never a pulse): the decision row a 70% cover, the missions row a 16 square cover and a 62% cover. The head has no count while it is unknown. The covers are one `role="status"` named Loading.
- **A failed read** says so where the fact would be: the cross and "Not available", no count, no Retry (the reads are polled). The detailed statement stays on the line's title. One source failed out of several: the list it has, then "Could not load every decision." beside the cross. A failed sessions read makes the missions row "Missions · Not available", never a zero.
- **The page strip** (section 1.9) follows: covers while loading, the cross and "Not available" when the read failed, no count and no Retry.
- How her figure fills a box of another size: settled 2026-11-08 by VEX Cloud's built stage (above): 48 from her top, 88% of the box's width, centred, cut by her foot, whatever the box's height.

### 1.6 The Vex key and her moods
The Vex key is the header cell over the Vex column, in three parts:
- **Portrait cell, 76 x 76.** Closed, her face: her mood's chip, VEX Cloud's header portrait (`chip-{mood}.webp`, 150 x 150, 5.4 to 6.2 KB each, `public/art/kimm/`), the whole chip filling the cell. Cloud's `key-moods.webp` sprite is its home page's, not the header's, and is not taken. Open, VEX Cloud's portrait glyph (DG-1 `portrait`, a framed bust: the frame she left; the direction is the chevron cell's, never the glyph's) at 20 in ink 2, ink under the pointer, on the open ground (`--vx-cell-open`, #0C0D0F). The two stand in the cell together and crossfade over 200ms, opacity only (MOTION-POLICY.md names it); reduced motion and Save-Data change it at once. The open ground fades in with the glyph, so a face that has not arrived leaves the header's own ground. The plates' fold glyph (an up chevron under a bar) on a raised fill is replaced.
- **State cell.** Line one: a small square (6px, a drawing per state, blinking while Vex works; section 2.2) and the state word, with a timer while live ("THINKING 0:03"). Line two: the action, HIDE VEX or SHOW VEX, then the keycaps of the shortcut. At VEX Cloud's measures (the H3 mockup's `.vk`, 2026-11-05): the text 20 in and 12 from the right, the two lines 10 apart; the state word 13 in caps in ink, the timer after it 10 on, in the sans, muted, at 0.04em with tabular figures; the action 12 in caps in ink, its keycaps 12 after it (section 2.4).
- **Chevron cell.** Down while she is closed, up while she is open: 60 wide, then the column's rule; muted, ink under the pointer. It is one up chevron that turns 180 degrees over 300ms at the press, never two glyphs swapped (VEX Cloud's `.vx-vk-dir`); at once under reduced motion and Save-Data.
- **Width rules** (VEX Cloud's, on the window's width): under 1440 no keycaps (the chord stays in the key's name, `aria-keyshortcuts`, its tooltip and the first-close hint), the state line 12 at 0.06em with its parts 8 apart, the text 16 in, the chevron cell 48, and the console's decision 14 with its Review cell 14 in from each side; under 1280 the state line says the chat row's short word ("Waiting" for Waiting for approval; every other word is already short), the long word staying the key's description; from 1920 the state line is 14 and the keycaps 20 high at 11.

The key is one control. Its name is the action ("Show Vex", "Hide Vex"), and it opens and closes her section (section 3.3). It is a disclosure as VEX Cloud's EC-01 draws every control of her section: the name follows the words, `aria-controls` names her section, and there is no `aria-expanded` or `aria-pressed`. Its description is the long state word; the short word and the ticking timer are hidden from assistive tech, as Cloud's are.

Her moods, printed on `landing-r3__plate-key-moods`, with the still VEX Cloud draws after a fill (`signed`, its mockup's `js/data.js`). Both apps must use the same list:

| Mood | Drawn | H3 moment |
|---|---|---|
| hi | the V sign | the welcome (READY) |
| think | the hand at her mouth, with the running square | Vex works (THINKING) |
| offer | the open palm | waiting in the app (WAITING FOR APPROVAL) |
| offer, held | the open palm, dimmed | held for sign-in (Cloud); a locked vault (desktop) |
| signed | after a fill | DONE after a fill, for 2.8 s |
| refused | the whole anger mark | the money call refused or ended in an error, for 3.4 s; ERROR on a status panel |
| rest | resting | after the answer (DONE), and after a failure with no money call |

**Held is offer, dimmed.** It has no file of its own: the seam draws it from offer's chip and still (`KIMM_ART_MOOD`, `kimm-assets.ts`) and the sheet dims it to half its light (opacity 0.5, `kimm.css`), as Cloud lays its 50% scrim over her; the mood plate's held cell measures 0.50 of the offer cell's.

**Her files** (S4-18, settled 2026-11-08) are VEX Cloud's ready-made renders, byte copies of its `apps/web/public/kimm/v1/stills/` in `src/renderer/public/art/kimm/` (`NOTICE.md` there; 561,760 bytes in all): a chip (150 x 150) and a section still (720 wide, 1032 to 1104 tall by pose) per drawn mood, signed included, and the glyph field's two baked frames (`field-still.webp` 780 x 652, `field-still-wide.webp` 1536 x 1972). Each is registered in the build check's `BRAND_ASSETS` (`scripts/kimm-brand-assets.mjs`) with its size and byte budget. Cloud's phone stills are not taken: the window floor is 1000, and the band (1000 to 1023) frames the section still. A file that leaves the folder turns its piece `missing`, drawn as no art at all. The Live2D model and Cubism Core are not in the desktop app.

**Desktop's states take Cloud's seats** (its `js/data.js`, `h3-shell-gaps` decision 15, "she is not the failure", and Cloud's built mood clock and status panel, verified 2026-11-08: `use-kimm-events.ts`, `kimm-moods.ts`, `kimm-provider.tsx`, `StatusPanel.tsx`), in `features/vex/kimm-mood.ts`:

| State | Mood |
|---|---|
| Ready, Listening | hi |
| Thinking, Working | think; offer while the approved money call runs (`approved`: Cloud's `sign` mood, drawn with the offer still) |
| Waiting for approval | offer |
| Done | rest; after the money call (`outcome`): signed after a fill for 2.8 s, refused after a refusal or an error for 3.4 s, then rest |
| Concerned | rest in a chat; think on a status panel (`seat: "panel"`) |
| Error | rest in a chat; refused for 3.4 s when the money call ended in it (`outcome`), then rest; refused on a status panel |
| Sleeping, Waking up | rest; held while the vault is locked |

The holds are Cloud's (`KIMM_EVENT_MOOD`: `done` 2800, `refused` 3400; its clock then returns to rest), kept by `useKimmMood`. Refused shows only for the money call's own end and for an Error status panel: never for a failure with no money call, nor for a stop. The source is the chat's approvals stack, which publishes a display-only decision signal when a card's decision lands (`features/appShell/approvals/decision-signal.ts`); nothing on the decision path reads it. `useKimmShellMood` (`features/vex/useKimmShellMood.ts`) reads it for the chat on screen and feeds her clock, in her section, her band and the Vex key: an approved call not yet settled (`executionStatus` null, not started or dispatching) passes `approved` (offer while Thinking or Working); one that succeeded passes `outcome: "filled"`; a rejection passes `refused` and a failed decision or dispatch `failed`; an unproven result (`indeterminate`) passes nothing, so she never claims a fill she cannot show. A decision is spent once Vex is idle again (Ready, Sleeping, Waking), so an old one never colours a later Done; Studio reads none. Desktop draws no status panel with her plate, so no caller passes `seat: "panel"`; the stages beside her section read the chat seat. Cloud also holds the welcome's hi for 1.8 s and then rests (its `hi` event); desktop keeps hi while Ready, as the H3 plates draw it.

### 1.7 The chat column
Header cells as in section 1.3. The transcript and the welcome sit 24 in from both edges (704 to 1416 at 1440).

**The welcome** (`h3-merged__welcome-*-1440`): a greeting bubble, "Ready when you are.", at 704, 104 on a raised fill; two notes under it, each a small square and a caps line; and, low in the column, a two-by-two grid of suggestion cells, 704 to 1416 by 536 to 762, each about 356 x 113 with an icon, a title, a muted line and an arrow.

The greeting fades in over 500 ms (still under reduced motion and Save-Data). The suggestion cells are a list named "Suggestions" (VEX Cloud's `SuggestionRows`): while the draft has text they are concealed at once, keeping their box and out of reach (`aria-hidden`, `inert`), and fade back over 200 ms when it empties, so nothing moves; while a send is being made they stand at 0.4 and take no press.

**A chat:** the person's message is a raised bubble at the right beside their avatar disc (34), under a meta line (VEX Cloud's `UserMessage`): 28 high on the bubble's right edge, 4 over it, the message keys as 28 keys with 14 glyphs (the latest message's Copy always shown, the rest on hover or focus), then "You · 12:40" in caps 11 muted, the clock a `<time>`; the row is an article named "You". Vex's thinking is a framed row, "THOUGHT FOR 2.8s", with "5 steps" and a chevron at the right.

**The flow rhythm** (VEX Cloud's spec 10.10, `FLOW_GAP` and `layoutRows`; desktop's `SessionTranscript/flowRhythm.ts`): the transcript column has no gap of its own. Each row's gap comes from what it shows at its edges, the later row owning it and the larger edge winning: 6 between rows (a message, a runtime line, the day line) and between trace cards; 12 around text or a card (Vex's answer, a receipt, a mission's result, an analysis) and above the live turn; 16 above the turn's head, and below it while the turn is folded to it. A row the fold hides adds no gap, and a row that only continues the steps of the row above joins that card with none. Inside one of Vex's rows its parts stand 12 apart; the earlier-messages band stands 12 over the first row and the turn's stats line 6 under its turn. The waiting card's region (`ApprovalsRegion`) sits after the transcript column, outside this rhythm, and keeps its own spacing; only the height of the transcript above it moves it.

**Loading and earlier messages** (VEX Cloud's `ThreadLoading` and `ShowEarlier`): a chat's first read says "Loading chat…" (named "Loading chat", 13 in ink 2 beside the ongoing swatch) only once it has lasted 200 ms, so a fast load never flashes it. Over the first loaded row, a 36 band on the 1px rule in caps 11 ink 2 says "Loading earlier messages" while an older page reads, "Earlier messages did not load" (an alert) with a 28 Retry key that reads the pages again, and "Start of the chat", muted and centred, once the reader has paged back to the chat's first message (never at the page cap). Desktop pages back as the reader scrolls up, so it has no "Show earlier" key; a status in the band speaks "Loading earlier messages" while a page loads.

**The turn's keys** (VEX Cloud's `TurnActions`): under Vex's answer a row 32 high, 6 out to the left so the first glyph stands on the answer's edge: the clock, then Copy, Branch and Report as 32 keys with 16 glyphs in ink 2, 2 apart, the cell's wash and ink under the pointer. The latest answer's keys always show; every earlier turn's reveal on hover or focus over 200 ms.

**Scroll to latest** (VEX Cloud's `BackToBottom`): while newer content sits below the view, a 44 square at the right end of the transcript's column, 16 over the composer, raised on the chosen rule (24%) with the 20 down arrow in ink, the open cell under the pointer, fading in over 160 ms (still under reduced motion). It is named "Scroll to latest". A press goes to the floor; if the key held the focus, the focus goes on to the draft field rather than dropping to the page.

**Code and tables** (VEX Cloud's markdown, `.md-code-block` and `.md-table-scroll`): a fenced block is the well in the 1px rule under a sticky 40 bar on the card ground: the language in caps 11 muted, 16 in, then Wrap (folding long lines, a pressed key) and Copy as 40 cells in ink 2, each with its left rule. A table is a cell on the card ground in the 1px rule: its head 36 high in caps 11 muted, its cells at least 42 high, 14 / 1.45 in ink 2, 10 by 16 in, each row on the rule but the last, the first column in ink and unwrapped; a right-aligned column holds figures in the mono 12.5.

**Runtime notes** (VEX Cloud's `RuntimeLine`, H3's `.t-sys`): a note the runtime writes into the chat (a wake, a resume, the answer to an instruction sent mid-turn) is a runtime line on the column's left, 16 in: the 6px hud square, 10 before the words in caps 11 muted. The live turn keeps its framed live frame (`TurnIsland`) from the send on; desktop draws no bare running line before it.

**The day line** (VEX Cloud's `.vx-tx-day`): above a chat's first loaded row and between rows of different days, "Today", "Yesterday" or the date in caps 11 muted, centred between two hairlines that fade from the chosen rule (24%) to nothing, 14 from the word.

**The trace card** (VEX Cloud's built trace, `TraceCard.tsx` and `trace-steps.ts`; desktop's `SessionTranscript/TurnTrace.tsx` and `turnFold.ts`): one head per turn folds every step of the turn, its thoughts and its tool steps alike. The head stands over the turn's first step, a thought or a tool call, so a turn that only called tools has one too; each later step part of the turn is a headless group at its place in the turn. Each group is one card on the card ground (`--vex-alias-card`) in the 1px rule, the head at the top of the first, and its steps are one list (VEX Cloud's `.vx-trace-steps`): no rule between steps, a 1px rail through their nodes at x 19 (white at 10%, from 18 under the list's top to 18 over its foot), each step a grid of the node (12), its kind in caps 10 at 0.1em (MODEL for a thought, TOOL for a call, a fold of calls or an orphan result; 64), its text, its time or word, and the chevron (16), 14 apart and padded 9 by 14. A tool's title is caps 11.5 at 0.06em with its venue mark and its legs after it, a summary 12.5, the time 10.5 at 0.04em; the chevron turns while its step is open. What a step opens to (its links, its well, a thought's trace) stands under it on the text column's edge (118 in). A fold of calls opens to its members as steps of the same list on the same rail. The kind column is a drawing (`aria-hidden`): every step's key keeps its own name. Desktop's steps arrive without Cloud's 380 ms step-in, since a live arrival already has the row's settle and history hard-cuts. The head is 40 high, 14 in: the glyph (Cloud's 3x3 cells, 3px, 2 apart, in ink: resting 18% with the centre 50%, done 30% with the centre lit, stopped 30%, and while the turn runs the light steps round the ring into the centre, 1100 ms at 120 ms a cell, still under reduced motion and Save-Data; a failed turn's 9px ink cross), the label in caps 11 in ink 2, "{n} steps" at the right in 11 muted at 0.04em, then the chevron, which turns over 300 ms (still under reduced motion); it carries no summary of the trace. While the turn runs (rows of it arrive while the live frame shows): the running node, "Working" muted, the steps so far; the live frame at the tail keeps the clock, so the turn never shows two. Settled: "Thought for 2.8s" after a turn watched live, else "Thought" (section 4.1 item 14). Folding hides only the steps, at once (`hidden="until-found"`, so find in page still reaches them and opens the turn); the answer, a receipt, a mission's result and an analysis stay. A turn from history opens folded; a running turn stands open and folds itself 900 ms after it settles, unless the person pressed its head; a press holds. A fold never hides focus: a group holding focus opens the turn instead. A stopped or failed turn's head is a label, "Stopped" or "Failed", with no key and no chevron, and its steps stay in view. Cloud folds 900 ms after the answer starts writing; desktop folds when the turn settles, as its persisted answer is then in place.

**The trace's steps** say their state by a node and a word, never a colour alone (VEX Cloud's `h3-chat-gaps`, section 19 and "Trace step (status)"; `StepNode`). The node is 7px; the time column at the row's right holds a done step's measured time and the state's word where there is no time or the state outranks it:

| Step | Node | Time column |
|---|---|---|
| done | the ink 2 square | its measured time ("812ms"); "Done" where nothing was measured |
| running | the ink square, blinking (PD-06), half a square under reduced motion | the live timer: the live frame's head (`TurnIsland`), whose every live state (working, thinking, calling, running, writing) is the running node |
| waiting | the target: a 1px ink ring and its 3px centre | the "Waiting for approval" link to its card |
| failed | the ink cross | FAILED in the refusal ink; its first line beside the title in the refusal ink |
| pending (a broadcast not yet confirmed) | the blinking node | PENDING in ink |

A fold's failures read "{n} failed" in the refusal ink beside the ink cross.

**The turn error row** (`TurnErrorRow`, after the last turn; VEX Cloud's `h3-chat-gaps`, "The turn error row, by kind", and its `.t-fail`): one row for every kind of failure, outcome first, never a new layout. The 1px rule on the card ground (Cloud's `--vx-card`, desktop's `--vex-alias-card`); the body 8 | 1fr, 14 apart, padded 14 18 16 16: the 8px status red square at 7, the title 15/1.45 in the refusal ink, the words 14/1.5 in ink 2; then a strip of zero to three key cells, 48 high under a 1px rule, each in caps 13 with no fill (Cloud's non-primary key; the cell's hover under the pointer), padding 0 22, a rule at its right. The row never moves focus and is not a live region (see below); the title and the words read as two. On desktop the kind is the engine error's category (`shared/engine-error-copy.ts`): its title heads the row, and the words are the scope ("This turn failed."), the category's sentence, the remedy in ink, the sanitized cause and the code trailer in the mono 11.5 muted. The strip holds Dismiss ("Dismiss error"), the one key desktop has here; it replaces R3's ink callout (`SessionErrorBanner`).

Open, for the owner:
- Red titles are Cloud's drawn default (its open question 4): a conflict or a missing chat is not a refusal and could keep the ink.
- Cloud draws the row as `role="alert"`. Desktop leaves the role off: its notification announcer already speaks each failure once (as B2.2 decided), and two live carriers would make a screen reader hear the failure twice.
- VEX Cloud's built `TurnErrorRow` (`apps/web`, 2026-11-05) still draws R3's cross callout; the row above is its drawn DG-4 default. Times are spelled as Cloud's trace spells them, the unit against the figure: "812ms", "2.8s", "1m 05s". A finished thought in the live frame is the done node.

**The swap card** (`h3-merged__approval-*-1440`), printed at 680, 249, 760 x 651, with its top rule at 248. Top to bottom: the eyebrow row (CONFIRM THIS SWAP, then MAINNET, the REAL FUNDS stamp and a collapse chevron at the right), the sentence, the consequence line, field rows on a 34px pitch with their labels in mono caps, ALL SIGNED FIELDS, and the reason field, "Tell Vex what to do instead" (771 to 826). Its decision row is the bottom row (section 1.8). Which rows desktop shows is in section 4.1.

### 1.8 The bottom row
73 high with its top rule (72 x the wide zoom and the rule, section 1.11), across the window, in a chat. Cells at 1440, measured in `h3-merged__welcome-closed-1440`:

| Cell | x, width | H3 draws | Desktop puts |
|---|---|---|---|
| account | 0, 248 | the avatar disc, "You", "Account and settings", a chevron | the same |
| tagline | 248, 432 | the moment's tagline (Appendix A) | Vex's line on a strip over the bars: the same, in desktop's words (Appendix A.6) |
| model | 680, 75 | the model's glyph: the model choice | the same |
| field | 755, 471 | "Ask Vex..." | the same, running on to the send key |
| attach | 1226, 74 | an image key | left out: no attachments |
| send | 1302, 138 | blue: a three-by-three dot glyph and SEND | the same; STOP while a turn runs; held while the draft is blank (below) |

**The send cell** is H3's `.cmp-send`: 138 wide, padding 0 30 0 32, a 20px dots glyph and SEND in 13px caps; the dots are faint (white at 55%) at rest and white under the pointer. Measured at 140 from the captures before Cloud's CSS was read; the CSS is the source. **While the draft is blank, SEND is held** (Cloud's EC-04, `specs/v99-web/PLAN.md`; `h3-chat-gaps` decision 6): the cell fill, a muted word and the faint dots, no blue and no hover, because a blue key that does nothing is a trust regression. It turns blue the moment the draft has text. Which drafts can be sent is unchanged; only the look follows the key's held state. Held is `aria-disabled`, never native `disabled` (VEX Cloud's `SubmitButton`, its dock contract section 3): the key stays in the tab order and keeps focus through a send, its press does nothing, and it is described "Write a message to send". SEND carries `aria-keyshortcuts` and a tooltip over it, "Send message (Enter)", from the person's Enter setting ("Cmd+Enter" or "Ctrl+Enter" under the newline setting). STOP keeps the blue while a turn runs, its square 14 (Cloud's `.vx-cmp-stop`); a stop being acknowledged is the same held look.

**The tagline cell is Vex's line over her bars** (VEX Cloud's `.vx-foot`, the H3 mockup's app.css and js/stage.js, 2026-11-05). The bars are a canvas filling the cell: n = max(12, round(W / 22)) bars 3 apart (20 at 432), each the cell's height, white at 1.4% plus up to 55% by its level; the levels ease on a critically damped spring toward one of three moods taken from her state alone: ready (a slow sweep), busy (a faster sweep while she thinks, works or wakes) and approve (a soft pulse while a decision waits). They are a display only (Cloud's PD-15): no figure, no data, no claim, no key. They draw only while on screen and while the window is shown, and under reduced motion and Save-Data they paint one still frame per mood (MOTION-POLICY.md, "Vex's bars"). Over them lies the strip with her line (Appendix A.6); when the line empties the strip fades and the bars show alone. Cloud grounds the bars on `--vx-key-field`, oklch(7% 0.006 264), one sRGB step from desktop's ground (#010102 against #010203); desktop keeps its ground.

**The status strip** sits above the composer in the chat column, 31 high (797 to 827, measured): the model and its effort ("DeepSeek V4.1 Flash 1017 HIGH", 680 to 928), FUNDS REQUIRE APPROVAL (928 to 1139), an empty cell, and DAILY BUDGET with a ten-cell meter and a percentage (1186 to 1440). Desktop's strip is in section 4.1. Each cell's words stand 24 in and 16 from its right rule, the context key, the strip's last cell, 16 in and 24 from the edge, and a key cell reaches 12 up into the transcript's foot, a 44 target on the 32 strip (VEX Cloud's `.vx-cmp-cell`).

**The / menu** (VEX Cloud's `SlashMenu`, `.vx-cmp-slash`): typed "/" opens the commands over the composer, the chat column's width with its foot flush on the composer's top, on the card ground under the chosen rule (24%), no shadow, at most 480 or half the window: a 32 head "Commands" in caps 11 muted, then each row at least 40 high, 24 in, on a 148 grid: the command in the mono 13 ink, what it does in 14 ink 2; the highlighted row is the wash. Focus stays in the field.

**While a card waits in the chat,** the composer and its strip give way to the card: the reason field takes the strip's place, the tagline says "CHECK THE CARD, THEN DECIDE.", and the bottom row's chat cells are the card's decision row:

| Cell | x, width | H3 draws |
|---|---|---|
| reject | 680, 168 | REJECT on a raised fill |
| middle | 848, 392 | a tick box, "I understand real funds can be lost" and "CTRL+ENTER APPROVES, ESC REJECTS" |
| approve | 1240, 200 | APPROVE SWAP, greyed until the box is ticked |

Desktop keeps its two-step confirm in this row (section 4.3).

### 1.9 Pages
From `h3-merged__portfolio-*-1440`.

- **Her section open:** the three columns stand. The page sits in the chat column from the header to the window's foot; there is no bottom row under a page, and the account cell stays at the chats column's foot. At the Vex column's foot is a segmented cell (828 to 900, about twenty segments, thirteen lit). Settled by the mockup source (2026-11-05): it is Vex's bars, a display of her mood and never a meter (section 1.8).
- **Her section closed:** the console folds to one line under the header (76 to 123, measured): NEEDS YOU and its count (248, 142), the decision or "Nothing needs you." (390, 290), the missions cell (680, 258), the strategies cell, and OPEN ACTIVITY with an arrow at the right edge (1277, 163). The page takes the whole width right of the chats, 248 to 1440.
- **The page frame:** a tabs row (about 57 high) with the tabs as cells (OVERVIEW selected on a raised fill, WALLET) and "Updated 12:41" at the right, then the page body, 24 in from each edge. The body's blocks stand at the left and are at most 1136 wide (VEX Cloud's page kit, `page.css`). With her section open (the Vex column standing, from 1024) the body and the tabs row's first cell start on the reading line (section 1.11), as the chat's title does: 24 at 1440, 159.6 at 1920. With her closed the page keeps 24. The Board, desktop's own page (section 4.9), keeps the whole column and 24.
- **The first read** (VEX Cloud's `PageLoading`, `RowsSkeleton` and `.vx-pfo-load-*`; section 5.6): a page that has read nothing yet draws its own shape with parked covers, never a sentence alone and never a figure (`screens/PageLoading.tsx`). One status names the read ("Loading your portfolio…"); the covers are decoration. Portfolio: the wallet total's tile keeps its label over a cover (the only tile every answer has), the curve is a cover block, Balances three cover rows, and the words stand in the stamp's slot instead of the body. Agent Scan: "Loading activity…" over five cover rows in the feed's frame. Watchlist: "Reading your watchlist…" over three cover rows. Vex Inference funds: "Checking Vex Inference…" over the Balance box with its head and its two labels, covers where the figures will stand. Settings: Tools (MCP) reads as "Reading your servers…" over two cover rows; the Lighter points, the leverage table and the local runtime's facts say their own loading words after the stepping hatch; the Vex Inference account's block is the kit's loading block (section 5.7).
- **"Updated {time}"** (VEX Cloud's `.vx-pgfresh`): 12 muted in tabular figures; the clock is a `<time>` with the instant in `dateTime` and the full local date and time as its tooltip ("3 Nov 2026, 14:30:05"). While a read of figures already shown runs (a poll, Retry, Refresh), the stepping hatch (section 5.6) stands before it; while the page's first read runs, the slot holds the hatch and the page's loading words ("Loading your portfolio…"), hidden from assistive tech because the body's one status says the same.
- **A page's lead** (VEX Cloud's `.vx-pglead`): ink 2, at most 760 wide; 14 / 1.5 on Settings and Memory. On Portfolio "Real money on mainnet." is ink 2 and what the total includes is muted (Cloud's `.vx-pfo-lead > span`). The leads in `book.css` keep their size until the type pass sets it.
- **Portfolio's figure strip** (VEX Cloud's `.vx-fstrip`): the wallet total's track is 1.3 to each other tile's 1. Under 900 four tiles go two by two on equal tracks (Cloud's three would leave four tiles a hole), and one under 480.
- **The wallet total chart's head** (VEX Cloud's `PortfolioEquity`): 44 high; the range is a radio group named "Range" in Cloud's brand-tone segments (the chosen one framed in the chosen rule on the raised ground, never blue), one Tab stop on the chosen range, the arrows, Home and End moving and choosing at once.
- **Section heads** (VEX Cloud's `.vx-psec-h`): 12 under a Portfolio section's head; on Memory, 6 from the head to its lead and 12 from the lead to the body, the count 12 muted in tabular figures.
- **Tables** (VEX Cloud's data table, `data.css`): Balances and All assets stand in one rule frame on the card ground, the head 34 high, the rows 48, each cell 12 in on both sides and the first 16 in from the frame, a quiet wash under a hovering pointer.
- **Agent Scan's feed** (VEX Cloud's `.vx-rows` and `.vx-arow`): one rule frame on the card ground, each row at least 56 high and 20 in from the frame, the day heads on the same inset. Desktop keeps its value column, its four filter menus and its outcome words.
- **What a page is to a reader** (VEX Cloud's `PageBody` and `PageHeader`): a region named by the page's title, never a modal dialog, since the side columns stay live beside it. It is `aria-busy` while its first read runs (Portfolio, Agent Scan), and on open its h1 (visible or hidden) takes the focus, so a reader lands on the page's name; a page whose own field claims the focus first (Sessions' search) keeps it. Escape still returns to the page before.
- **A failed refresh** (VEX Cloud's `PortfolioPage` and `ActivityList`, W4): a read that fails after the page has drawn real figures never wipes them. They stay, "Updated" keeps the time they were read, and a framed line above them says the newest read failed with Retry as a key cell at its right edge: "Couldn't refresh your portfolio." on Portfolio (the tiles and Balances keep theirs; both draw the one read), "Couldn't refresh activity." on Agent Scan. A refused or timed-out read resolves rather than throws, so the page holds the last good answer per read key (`screens/kept-read.ts`); a new scope or filter never borrows another read's figures. Only when nothing was ever read does the block take the content's place: "Couldn't load your portfolio." or "Couldn't load activity." (a timeout: "Activity is unavailable right now - try again shortly.", never an empty history), each with Retry. Retry reads again and says "Retrying…" until it settles.

**The re-lay** (VEX Cloud's EC-26; the H3 mockup's `js/stage.js`, lines 283 to 287): the frame's tracks never animate. Show Vex or Hide Vex on a page re-lays the page into its new width at the press, in one frame, and the page then fades in from 0.4 opacity over the leg's duration (720ms opening, 420ms closing) on the house curve, cubic-bezier(0.625, 0.05, 0, 1); her column, opening, wipes in from its top with clip-path on the push curve (`features/appShell/page-relay.ts`). A press only, never a cue. Cloud also wipes her section away over the re-laid page as she closes; desktop's section lives inside her column, which folds to the strip at the press, so the close shows the fade alone (left for the owner, section 4.11). Desktop's pages that can hold a money card keep the chat layout (section 4.10).

### 1.10 Under 1024: the console line and her band
VEX Cloud's 768 to 1023 layout (the H3 mockup's `css/app.css` section 14, `css/tokens.css` lines 190 to 191, `js/main.js` and `js/stage.js`; the README's "Under 1024 ... one rule (a)"), which desktop takes for its 1000 to 1023, in chats and on pages alike.

- **The frame.** The chats are the 76 rail (their key opens the chats panel over the chat, section 4.12); there is no Vex column. Under the header a **console line**, 48 high, is a row of the frame across the chat (`H3_CONSOLE_LINE_HEIGHT`): her state as its first cell (the square, the word and the timer while a turn runs; a key named by its action that opens and closes her band), NEEDS YOU and its count, the missions count, and Open activity at the right edge. The chat runs from under it to the window's foot.
- **The console line's state key** draws her state with the square every place that says it draws (`VEX_STATE_SQUARE`, Cloud's `MOOD_STATE`: the running square for a turn, the target for Waiting for approval, the cross for Error, the empty frame for Ready and Done), never the solid green of Confirmed. It is a disclosure as the Vex key is: `aria-controls` names her section, its description is the state word and, while the band rests, the reason; the timer is a picture, never read; every press says "Vex shown." or "Vex hidden." once, politely (EC-24), and a press while the band rests acts on nothing and says the reason once, politely, as the Vex key's does.
- **Needs you on the console line.** The decision gives way here, as in Cloud, and the header has no Needs you control (section 4.8), so while a decision waits the NEEDS YOU cell is itself the Review key to the decision that leads (`needsYouLeadOf`): named by the decision's own key word and title ("Review: Swap 200 USDC for ETH on Base."), described by its count, a chevron after the count, opening it as the console's Review does. At zero, loading or failed it stays words. Desktop's own: Cloud's line under 1024 has no Review.
- **The Vex key** is 288 wide (`H3_BAND_KEY_WIDTH`) and carries the waiting count beside her state; its keycaps leave (the chord stays in its name and tooltip) and its chevron cell is 48. While the band rests the key is held as VEX Cloud's is (`.vx-vk[data-held]`, `vex-key.tsx`): `aria-disabled`, the reason joined to its description and its tooltip, its action words and chevron hidden so nothing reads as pressable that is not, and a press says the reason once, politely, through the section's announcer. Open: Cloud also shows the reason for 6 s in the header's message slot, and "Show Vex" there on the first band close; desktop's title cell has no message slot yet.
- **Her band.** Her section, laid over the chat's top under the console line: the chat's width and min(clamp(220, 34dvh, 296), 40dvh) high (`--vex-band-h`: 244.8 at a 720-high window). Inside it her figure stands head to chest on her ground, and a 56 foot row holds Vex's line (the moment's words, the tagline) and the HIDE VEX cell; the whole foot row is one key, and a press anywhere on it closes the band, handing focus to the Vex key. It opens and closes with her section's own wipe from its top edge (720ms, 420ms, the push curve). While it is open the chat's transcript starts under it, its newest line still on the composer.
- **Closed, there is no band**: no strip, the room goes back to the transcript.
- **It starts closed on every visit** and a press holds for the session only (`vexOpenNarrow`, never persisted); nothing narrow writes `vexOpenChat` or `vexOpenPages` (section 3.5).
- **It rests** while a turn runs or a card waits (Thinking, Working, Waiting for approval: "Vex shows her section after this turn.") and while the composer holds the focus, Cloud's keyboard ("Vex steps aside while you type."): closed whatever was chosen, its keys say the reason instead of acting, and the choice comes back when the hold ends. Vex's cues never open or close it.
- **The money rule.** The console line is a row of the window; the band is a box over the chat that never enters the grid, and it rests whenever a card waits, so a card is never under it and never moves when it opens or closes. The card proof reads it at 1000 x 720 (`e2e/h3-card-proof.spec.ts`): with the swap card waiting and the band asked open, the band stays closed, and presses on the Vex key, the console line's key, the chord and the chats panel change neither the card nor a track on any painted frame; with no card, the band opens at 76, 124, 924 x 244.8 and its foot row closes it.

Desktop differs from Cloud here in one thing: Cloud hides the console line while a card takes the chat (its G10); desktop keeps it standing, because it is a row of the frame and hiding it would change the chat's box under a waiting card.

### 1.11 Wide windows: the zoom and the reading line
VEX Cloud's (`apps/web/src/lib/ui/wide-zoom.ts`, built; the H3 mockup's `css/tokens.css` lines 163, 183, 187 to 188 and 201; `renders/checks.json`), which desktop takes whole (`lib/wide-zoom.ts`).

- **The zoom.** `--vex-zoom` on `<html>` is clamp(1, window width / 1760, 1.5), to three decimals: 1 up to 1760, 1.091 at 1920, 1.455 at 2560, 1.5 from 2640. The shell frame writes it before its first paint and keeps it current as the window resizes.
- **What zooms:** the transcript (the reading column), the composer dock and its model picker, the card's decision row, the console (Vex's column body, so her section's top, her corner key and her strip go with it: 148, 56 and 56 x zoom), a page, and the page strip (48 x zoom). **What never zooms:** the frame's cells, the header, the chats column, the account cell, the tagline cell and the column widths.
- **The foot row** is 72 x zoom and its 1px top rule (`--vex-h3-foot`, Cloud's `--foot`): 73 at 1440, 79.55 at 1920, 105.76 at 2560. Her section ends on that rule. The Lighter desk keeps its 72.
- **The reading line,** `--vex-read-x` = max(24, (chat - 760 x zoom) / 2 + 24 x zoom), and 24 under 1024: the chat's title, the transcript's text and the waiting card's text start on it (the card stands one 24 inset wider than the reading column). 24 at 1440 (704 in the window), 159.6 at 1920 (983.6) and 254 at 2560 (1270), Cloud's measured lefts. Over a page's strip the title keeps 24.
- The card proof reads these at 1920 and 2560: the three lefts on the line within half a pixel, her box from 76 + 148 x zoom to the foot rule, her strip 56 x zoom, the foot row 72 x zoom + 1.

---

## 2. Tokens and type

### 2.1 Colour
Two sources: the review sheet's own CSS tokens (the mockup page that frames the plates, drawn in the same language as the app screens) and what the app captures show. The sRGB values are converted from the sheet's OKLCH. Role names here are roles; S1-03 sets the names in `tokens.css`.

| Role | Sheet token and value | sRGB | App captures, measured | Desktop takes |
|---|---|---|---|---|
| ground | `--panel` oklch(8.5% 0.008 264) | #010203 | #000002 to #020202 (OKLCH 7 to 8.5%) in every column, no readable hue | oklch(8.5% 0.008 264), #010203: the chat column, its cards' fields, the window's first paint |
| page | `--page` oklch(9% 0.012 264) | #020205 | | Cloud's built `--vx-page`: the page under the frame (html, body, #root) |
| rail | none; Cloud's `--vx-rail` oklch(6% 0.006 264) | #010101 | | Cloud's built value: the side columns, the chats column (and its 76 rail) and Vex's column |
| cell | `--cell` oklch(11% 0.006 264) | #040406 | #050407: the New chat cell, the composer's model cell, the greyed approve key | the sheet value |
| raised | `--raised` oklch(13% 0.004 264) | #070709 | #070709: the REVIEW and REJECT keys | the sheet value |
| card | none; Cloud's `--vx-card` oklch(10.5% 0.006 264) | #030405 | not drawn on the app plates | Cloud's value: the money card, menus, popovers, dialogs and sheets, the connection banner, the ground under a failure's red (section 5) |
| plate | none; Cloud's `--vx-tooltip` oklch(20% 0.004 264) | #151618 | not drawn on the app plates | Cloud's value: the toast and the tooltip, ink on it (section 5.1); the avatar's disc (Cloud's `--vx-avatar`, the same value) |
| open ground | none; Cloud's `--vx-cell-open` oklch(16% 0.004 264) | #0C0D0F | #0B0D0F (OKLCH 15.5%): the open Vex key's fold cell | Cloud's value: the Vex key's portrait cell while she is open (section 1.6), Kimm's open corner key, a selected tab or cell, a pressed key, every wash |
| bubbles | Cloud's `--vx-bubble` and `--vx-bubble-you`, white at 6% and 13% | #101112 and #222324 over the ground | #0F1112 to #121416 (the greeting); #212325 (the person's message) | Cloud's values: Vex's answer and greeting at 6%, the person's message at 13% |
| chosen row | Cloud's `--vx-chosen-row-rail` from oklch(22% 0.004 264) | #1A1B1C | a gradient from #181A1C (21.6%) | Cloud's value: from #1A1B1C at the row's left edge to transparent, under a chosen row and the row under the pointer in the chats column |
| placeholder | Cloud's `--vx-placeholder`, white at 55% | #8D8D8E over the ground | | Cloud's value, 6.3:1 on the field (v99's 40% failed AA) |
| dimmed | white at 24% (Cloud's chosen rule) | #3E3F3F over the ground | | decoration and disabled marks only, never a word |
| ink | `--ink` oklch(97% 0.005 264) | #F3F5F9 | glyph peaks up to #FFFFFF | the sheet value |
| ink 2 | `--ink-2` oklch(80% 0.012 264) | #BABEC6 | "Nothing needs you." and Portfolio's lead line peak at #ABADAE, read as ink 2 | the sheet value |
| muted | `--muted` oklch(62% 0.02 264) | #808693 | group heads and times peak at #8B8D91 to #9C9E9D, at or a little above the sheet value | the sheet value |
| rule | `--rule` oklch(100% 0 0 / 0.07) | #131415 over the ground | #0E0E10 to #101211 | the sheet value |
| chosen rule | `--rule-chosen` oklch(100% 0 0 / 0.24) | #3E3F3F over the ground | #2F3133 above TOTAL DEBIT; #38373A on keycap borders | the sheet value |
| blue | `--blue` oklch(45.2% 0.313 264.1) | #0000FF | #0000FF: SEND, Portfolio's LIVE · MAINNET key | the sheet value |
| blue hover | `--blue-hover` oklch(56% 0.28 264) | #1557FF | not drawn | the sheet value |
| gain | Cloud's built `--vx-pnl-up` (its `--vx-live-bubble-text`) oklch(80% 0.12 150) | #83D494 | Portfolio's +$182.40 peaks at #88D09E | Cloud's built value, as type (the sheet's `--live`, #76CF8A, retired) |
| loss | Cloud's built `--vx-pnl-down` (its `--vx-err-bubble-text`) oklch(76% 0.15 27) | #FF887C | no loss is drawn as type | Cloud's built value, as type (the sheet's `--err`, #FF7A6E, retired) |
| status green | none | | #1B813F (a square), #1D7E3F (the FILLED stamp): about oklch(52% 0.13 150) | #1D7E3F |
| status red | none | | #C22226 (a square): about oklch(53% 0.19 27) | #C22226, the turn error row's square (section 2.2) |
| status grey | none | | #8F9190 (RUNNING in the chats list); #3B3D3D (RUNNING in recent activity) | replaced by the hud, below |
| hud | Cloud's built `--vx-hud` oklch(94% 0 0) | #EBEBEB | | #EBEBEB: the running square, which blinks |
| refusal ink | Cloud's built `--vx-err-text` oklch(74% 0.17 27) | #FF7A6E | | #FF7A6E: the failed cross, a failure's word, a failed step's word and first line, the turn error row's title |

Where the app screens differ from the sheet:
1. **The ground is closer to black.** It matches `--panel` (8.5%) better than `--page` (9%) and shows no blue tint at WebP's resolution; the two differ by one to three sRGB steps. Desktop's ground is #010203. The window's `backgroundColor` (`src/main/windows/main-window.ts`, today `#1b1412`) and the Windows caption overlay colour (`src/main/windows/chrome-options.ts`, today `#1B1412`) take the same value, since the theme-matrix test ties them to the ground (S1-06).
2. **There are raised steps above `--raised`.** The bubbles, the selected tab and the open fold cell use fills between 15 and 26% that the sheet has no token for. Desktop first added raised 2 (#101214) and a solid bubble (#212325) as measured; Cloud's built tokens (W3 to W5) settled them, and both retired (2026-11-09): a selected tab, a pressed key and the washes take the open ground, menus and popovers the card, the bubbles Cloud's white at 6% and 13%, the avatar's disc the plate.
3. **Status fills are darker than `--live` and `--err`.** The sheet's green and red are type colours, which the app uses for gains and losses; the status squares and the FILLED stamp use a darker green and red.
4. **Two greys mark running in the captures.** Cloud's built status sheet (`apps/web/src/styles/status.css`, 2026-11-05) settles it: a running square is the hud (#EBEBEB) and blinks (section 2.2). Cloud's built values win over the mockup where they differ, so the hud and the refusal ink are primitives of their own (`--color-h3-hud`, `--color-h3-err-text`); the refusal ink has the loss colour's hex but never reads a trading primitive.

Cloud's built tokens (`apps/web/src/styles.css` on `rebranding-v99-ui`, W3 to W5) settle the page, the rail, the bubbles, the chosen row, the placeholder, the gain and the loss; they win where they differ from the sheet or the captures. Open: the status green and red, still as measured.

### 2.2 Status
A status is a square beside a word in caps, and **every status has its own drawing**, so a colour never stands alone (VEX Cloud's PD-03 and `contracts/status.md`; the square is Cloud's StateDot, desktop's `StateSquare`, `.vex-sq` in `ui-primitives/marks.css`). The square is 8px, 6px in a row, and every frame is 1px. The word is ink; a failure's word is the refusal ink.

| State | Drawing | Ink | Desktop's words |
|---|---|---|---|
| done | solid | status green | Confirmed, Filled, Fired |
| ongoing | blink (PD-06), half a square under reduced motion and Save-Data | the hud | Running, "Submitted, awaiting confirmation", Pending |
| warning | target: the 1px frame and a dot | ink | Waiting, Waiting for approval |
| error | cross | refusal ink | Failed, Refunded (desktop's mapping, below), Error |
| idle | empty frame | muted | Ready, Exited, a status word this build does not map |
| paused | dotted frame | ink 2 | Paused, Sleeping |
| draft | hatch | ink 2 | a draft |
| concerned | framed hatch | ink | Status unknown, Concerned |

- **The running square blinks** (PD-06): opacity 1 to 0.25 on steps(2, end), 600ms a cycle (`--vex-duration-blink`, Cloud's `--vx-blink`). It is never solid-still in motion and never green: green is Filled. Under reduced motion and Save-Data it holds still as half a square, so it never reads as Filled. Every running square in view blinks in phase.
- **Status unknown is concerned**, the framed ink hatch, not the failed cross: nobody knows the outcome. Its words and its note ("ask Vex before retrying") are unchanged.
- **Refunded keeps desktop's mapping**: the funds came back, and A.3 lists it under H3's DID NOT EXECUTE, so it takes the failed cross. Open: the owner may move it to its own state.
- **The status label in a row** (`StatusMark`) is caps 11 with the 6px square 6 before it, Cloud's built StatusLabel at its row size; caps 13 with the 8px square only at the md size.
- **Running blinks everywhere** (PD-06; Cloud's HANDOFF, "Deviations already taken"): the console's recent activity, the chats list's RUNNING tag, the Vex key, Studio's terminal tabs, pane heads and panel header, a project's RUNNING in Studio's rail, Studio's host cell, Agent Scan, Portfolio and the screens before the shell. Under reduced motion and Save-Data each holds still as half a square. The chats list's other tags take Cloud's drawings too: WAITING the target, Paused and Sleeping the dotted frame, Error the cross.
- **The trace's step nodes** draw their own states (section 1.7): done the ink 2 square, running the blinking ink square, waiting the target, failed the ink cross.
- **Her state's square** (the Vex key, its waiting count under 1024 and the console line) is one map, VEX Cloud's built `MOOD_STATE` (`components/vex/vex-mood.ts`; desktop's `VEX_STATE_SQUARE`, drawn with `StateSquare` at 6): Ready and Listening the empty frame; Thinking, Working and Waking up the running square, which blinks; Waiting for approval the target, so it stays apart from Done with the colour taken away (Cloud's `contracts/status.md`); Done the empty frame, a settled turn whatever its outcome, never the green of Filled; Concerned the framed hatch; Error the cross; Sleeping the dotted frame. The waiting count takes the target too. Cloud's waking says Ready; desktop's Waking up is the services starting, so it keeps the running square. This replaces the H3 mockup's key squares (`h3-merged/js/data.js`: Waiting solid ink, Done solid hud).

Gains and losses in trading values take the gain and loss colours as type (Portfolio's tiles and positions). This replaces R3's `trade-up` and `trade-down` pair and R3's rule that status is never a colour; S1-08 rewrites `status-contrast.test.ts` to this section.

The REAL FUNDS stamp in a card is an ink fill with ground-coloured caps and a hatch glyph. As built, it takes Cloud's tag (the status contract, H3 app.css `.tag.is-real`): 24 high, caps 11 at 400, a 1px ink edge, 3 in on its hatch side, the hatch a 10 x 14 block of 135 degree strokes, 1.5px every 4px; the risk tag beside it is 24 high and caps 11 too. In the header the same glyph and words stand without the fill.

Where money is shown but not decided (Portfolio's lead, the settled receipt), desktop takes Cloud's quiet mark (PD-05, EC-10; `.vex-rf`, `MainnetMark`): the word MAINNET in ink, 11 caps at 400, after a 10 x 14 hatch of 135 degree strokes, 1.5px every 4px, gap 6, no fill. The solid stamp stays only where money is decided: the waiting card and the Needs you row.

Contrast on the ground (#010203), computed from the values above:

| Pair | Ratio |
|---|---|
| ink, ink 2, muted on the ground | 19.0, 11.1, 5.7 |
| gain, loss on the ground | 11.7, 9.0 |
| ink in Vex's bubble, in the person's | 17.3, 14.4 |
| the placeholder on the field | 6.3 |
| white on blue, on blue hover | 8.6, 5.5 |
| white on status green, on status red | 5.1, 5.9 |
| status green, status red squares on the ground | 4.1, 3.5 (marks beside a word: above the 3:1 for graphics) |
| the hud square, the refusal ink on the ground | 17.4, 8.2 |
| blue on the ground | 2.4: blue is never type on the ground |

### 2.3 Type
- **Families.** Be Vietnam Pro, 400 and 600, for every word. Roboto Mono 400 with tabular figures for figures, balances, addresses, the money card's field labels and the receipt's labels. Both are bundled as local woff2 files with their licences (S1-01, S1-02), in latin, latin-ext and, as VEX Cloud ships them, vietnamese subsets (Be Vietnam Pro 400 and 600, Roboto Mono 400; byte copies of Cloud's Fontsource 5.3.0 files, owner approval 2026-11-08). Each has a metric twin for the block period at Cloud's generated numbers: Be Vietnam Pro on Arial (size-adjust 107.0523%, ascent 93.4123%, descent 24.7543%), Roboto Mono on Courier New (100%, 104.7852%, 27.0996%), the mono twin named in `--font-mono`. Instrument Sans and Instrument Serif retire. Studio's approved plate (section 4.9) moves the terminal onto Roboto Mono 13/20, with a bundled 700 for its bold text (2026-11-04); code elsewhere keeps `--font-code` (JetBrains Mono) until its own change.
- **Labels.** Caps with 0.08em tracking (`--tracking-label`), at VEX Cloud's sizes: the caps label 11 (the mockup's `.cap`), the section head 12 at 600 (`.head`), a key 13 (`.key`). Desktop first set each label 1px above these, which is what made the left column measure about 8% wide; the tracking was right. Cloud tracks a few roles apart, and so does desktop: field and check rows 0.06em (`--tracking-field`), times and counts 0.04em (`--tracking-figure`), the trace's kind 0.1em (`--tracking-kind`; desktop's trace has no kind label yet). Labels are sans, except the money card's and the receipt's field labels, which are mono caps 12 at the field row's 0.06em. Mono with caps, banned by R3's `shell-design-guard.test.ts`, is H3's style for those labels.
- **Weights,** read by eye: 600 for section heads (NEEDS YOU, CHATS, AI PERMISSION, RECENT ACTIVITY, Portfolio's EQUITY, ALLOCATION and OPEN POSITIONS), the tagline and Portfolio's equity figure; 400 for everything else.
- **Links** are ink with an underline ("Change in Settings"), never blue.

The sizes are VEX Cloud's (2026-11-05), read from its mockup source, `v99-ui-rebrand/mockups/h3-merged/css/app.css` on Cloud's `rebranding-v99-ui` branch; the line given is that file's. They replace the cap-height measures this table first held (each was plus or minus 1, and every label read 1px large). Where a caps label is listed, it is the label register's (section 2.3, Labels).

| Use | Face, size, weight | app.css |
|---|---|---|
| Portfolio's wallet total (the hero tile) | sans 24 / 1.1, 600, -0.01em | 757 |
| Portfolio's other tile figures | sans 18 / 1.1, 400, -0.01em; gains in the gain colour | 756 |
| Portfolio's tile labels; its table heads | sans 11, caps, muted | 756 (`.fig dt`, `.cap`), 808 |
| Portfolio's tile lines | sans 12, muted, 8 under the figure | 758 |
| the page tabs (ALL WALLETS) | sans 13, caps, ink 2 | 731 |
| the person's message | sans 16 / 1.45 in their bubble, 12 by 16, at most 74% | 291 |
| Vex's answer and the greeting | sans 16 / 1.45, -0.005em, in her bubble, 12 by 16, at most 82%; in the answer a code block or a table leaves the bubble (bubble runs, section 2.4) | 292 |
| the welcome's notes | sans 11 / 1.55 caps, muted, 10 after a 6px hud square, 6 apart | 308, 309 |
| a starter's title; its line | sans 15 / 1.3 ink; sans 13 / 1.4 muted, 6 under it | 319, 320 |
| the chat's title; the line under it | sans 14 / 1.3 ink; sans 11 caps, muted | 196, 156 |
| NEW CHAT; the nav | sans 13 caps, ink 2 (ink when chosen or under the pointer) | 248, 255 |
| "Search chats" | sans 14 | 252 |
| CHATS; a section head (NEEDS YOU, RECENT ACTIVITY, AI PERMISSION, Portfolio's heads) | sans 12, 600, caps, ink | 49 |
| a group head (TODAY) | sans 11 caps, muted | 261 (`.cap`) |
| a chat row | sans 14 / 1.3, ink 2 (ink when open) | 262 |
| a row's time; a count | sans 11 (a count 13), 0.04em, tabular | 266, 601 |
| a row's tag (RUNNING) | sans 11 caps, ink, 6 after a 6px square | 265 |
| the account row | sans 14 / 1.25 ink over sans 12 / 1.3 muted | 273, 274 |
| the Needs you count | sans 13, 0.04em, ink | 601 |
| a decision in the console; its line | sans 15 / 1.3 ink; sans 13 / 1.3 muted (14 under 1440, section 1.5) | 607, 608 |
| REVIEW, a key | sans 13 caps | 53, 609 |
| the Vex key's state word; HIDE VEX or SHOW VEX in it | sans 13 caps; sans 12 caps, ink | 220, 225 |
| keycap letters in the Vex key | sans 10 at 0.04em, caps, muted, 18 high | 228 |
| "Nothing needs you." | sans 15, muted | 613 |
| the missions row | sans 14 / 1.3, ink 2 | 614 |
| the permission sentence; where it comes from | sans 14 / 1.45 ink; sans 13 | 630, 631 |
| an activity row; its status | sans 14 / 1.3 ink 2; sans 11 caps, 8 after the square | 637, 638 |
| OPEN ACTIVITY | sans 11 caps, ink 2 | 639 (`.cap`) |
| the status strip | sans 11 caps, 32 high with its rule; the model's name sans 12 ink | 365, 370 |
| the status label in a row | sans 11 caps, 6 after the 6px square | 265 |
| the trace's head (THOUGHT FOR); its figure | sans 11 caps; 0.04em | 48, 329 |
| the receipt's head (its kind, time and stamp) | sans 11 caps, the time at 0.04em | 353 |
| the card's field labels (FROM, AMOUNT TO SWAP, QUOTED PRICE and the rest) | mono 12, caps, 0.06em | 115 |
| figures in rows and tables, balances, the amount field | mono 12 to 13, tabular | 808 to 812 |

**As built, beside the table:**
- the bottom row's tagline: Cloud's `--moment-size`, clamp(14px, 1.1vw, 22px) (14 at 1280, 16 at 1440, 21 at 1920), 600 caps at 0.01em, line height 1.15 (app.css 651); the narration in its place while Vex works, sans 14 times the wide zoom in ink 2, sentence case, line height 1.4 (Cloud's two registers, `.moment`, app.css 650);
- the money card, at Cloud's measures (H3 app.css, the takeover): the sentence sans 18 / 1.3 at -0.01em, not 20 (20 is a question card's); the field labels mono 12 caps at 0.06em, not 13 at 0.08em (the register itself, so the Lighter ticket and the receipt take it too); the values sans 13 with their figures mono 12, on the same 34 row; the docked decision keys sans 13 caps, Reject 168 and the approve key 200 with 32 each side of its word;
- the money card at a short window, Cloud's density rule (DG-0, H3 tokens.css: 1024 wide and up, 820 tall or less): the strip 4 shorter (2 over and 2 under its line), the head 10 under the consequence rather than 14, and the docked reason field 40 high rather than 56; the field rows stay 34 and the decision row 72. At 1280 x 720 this keeps the swap card's top under the header's rule, where the toast proof expects it.

Settled by the mockup source (2026-11-05): the labels' 8% came from their sizes, 1px over Cloud's, not from the tracking, which stays 0.08em.

### 2.4 Cells, rules and keys
- Every cell is bounded by 1px rules in the rule colour. The chosen rule marks a total (above TOTAL DEBIT) and draws keycaps. **Every line is 1px** (VEX Cloud's SK STYLE 2.3): R3's heavier 1.5px ink and blue frames (popovers, callouts, a chosen card, the composer's frame while an approval waits, the selected board tile, tab underlines, the swatch outlines) are 1px now, the heavier ones told apart by the ink rather than the width; the padding that gave back their half pixel went with them. `glass-tokens.test.ts` refuses a 1.5px border or outline in any sheet or utility. The hatch strokes (1.5px every 4px) are a pattern, not a line, and stay.
- **Radius** is 0 everywhere (base.css's shape law), with VEX Cloud's two exceptions (STYLE 5.5) and no others: the chat bubbles, 18 round with the corner next to the speaker sharp at 4 (Vex's answer and the greeting 4 18 18 18, from the left; the person's message 18 4 18 18, from the right; `--vex-radius-bubble-vex` and `-you`), and the avatar circle, which desktop draws as SVG geometry and so needs no radius. `glass-tokens.test.ts` holds the exceptions to exactly these.
- **Her answer in bubble runs** (VEX Cloud's G18, `styles/thread.css`, built in W4): a code block or a table never sits in her bubble. The answer's prose is a grid, `fit-content(82%)` then the rest; consecutive prose parts stand in the first column on the bubble's fill and read as one bubble as wide as its widest part, at most 82%; a code block or a table spans the column's full width as a square cell, 12 above and below, and ends the bubble; the prose after it opens a new one. A run's first part takes the top corners (4 by her, 18 away), its last part the bottom ones (18). The hooks are `.vex-code-block` and `.vex-md-table` (chat-transcript.css, base.css).
- A cell's text sits 24 in from its left edge (section 1.3).
- **Primary key:** the blue fill with white caps, 14 (the card's decision key; SEND is 13, section 1.8). One blue cell in view at a time. Hover takes blue hover; on SEND (and STOP, the same cell) and the docked approve key it rises from the key's foot over 420ms (`--vex-duration-key-fill`), Cloud's `--vx-blue-fill-hover` layer, never a swap of the fill. A look only: when a key acts is unchanged. A primary key that will not act is held, never blue (SEND on a blank draft, section 1.8).
- **Key cell:** the raised fill with ink caps (REVIEW, REJECT).
- **A control at rest** (New chat, the model cell) has the cell fill; **a disabled key** has the cell fill with muted words (APPROVE SWAP before the tick).
- **A held key** (Cloud's kit, h3-kit-gaps "Held / pending"): a decision key that cannot act, on the card, in the docked row and on the Needs you row, takes the cell fill, the muted word and the 7% edge; never blue, never a dotted outline, never dimmed. The key whose decision is running is pending, not held: the approve key keeps its blue (and its working swatch), a running rejection keeps the held fill with its word in ink. Desktop's armed key (the reversed ink fill of the two-press confirm) stays: Cloud has no armed state. Only the look changes; when a key is enabled is the card's own.
- **Her corner key** is an opaque cell on the header's ground without its alpha (#010102), no blur, 56 high (section 1.5).
- **Keycaps:** VEX Cloud's keycaps beside a label (the H3 mockup's `.vk-keys kbd`, the kit's plain variant): 18 high and at least 18 wide, 5 in from each side, a 1px chosen-rule border, caps letters 10 at 0.04em, muted, 3 apart (the captures measured 19 high with letters 11 to 12; Cloud's CSS is the source). The first-close hint draws them as Cloud's tooltip keycaps: 22 high, 11px at 0.04em in ink-2, 6 in from each side, 3 apart, in title case ("Ctrl", "Shift", "B"; the Mac's glyphs ⇧, ⌘, B).
- **Focus:** a 2px white ring (`--vex-alias-focus`, white; Cloud's `--vx-focus-ring-color`) drawn 2px inside a cell (`outline-offset: -2px`: keys, tabs, segments, rows; "the 2px white ring inside the cell", `h3-merged__plate-controls`). A link, a check box and a switch keep it outside, where an inset ring would cover what it marks.
- **Switch** (strategy rows; not on desktop): 36 x 20, a 1px light border, the thumb a light square at the right when on.
- **Tick box** (the card's middle cell; not on desktop, section 4.3): 18 x 18, a 1px light border.
- **The receipt's stamp:** a status green fill with white caps (FILLED), about 60 x 24 on the phone capture.

These replace R3's tokens and its guard contracts: the 24 primitives and the one room in `theme-matrix.test.ts`, the sentence-case register in `micro-label-register.test.ts`, the mono-caps ban in `shell-design-guard.test.ts` and status by fill in `status-contrast.test.ts`. Each is rewritten as an H3 contract in the slice that changes what it guards.

---

## 3. Motion, and opening and closing her

### 3.1 Timings and the curve
| Motion | Value | Source |
|---|---|---|
| open | 720ms | printed: "Show Vex: her section opens, 720 ms on the push curve" |
| close | 420ms | printed: "Hide Vex: her section closes, 420 ms on the push curve" |
| the push curve, both ways | cubic-bezier(0.22, 1, 0.36, 1) | derived from the printed insets, below |
| reduced motion | at once | printed: "reduced motion lands it at once", on both strip plates |
| Save-Data | at once | desktop's still-frame rule (`lib/motion/use-still-frame.ts`), as for K2 |
| a page's re-lay | the page fades from 0.4 over 720ms opening and 420ms closing on the house curve, cubic-bezier(0.625, 0.05, 0, 1); her column wipes in on the push curve | VEX Cloud's EC-26 (section 1.9) |
| the grid's tracks | never | VEX Cloud's EC-26: a track that slid would carry a waiting card (section 3.6) |
| while the window is resized | every transition held still, Web Animations land at once, during the drag and for 220ms after its last resize (`data-vex-resizing` on <html>, `lib/wide-zoom.ts`) | VEX Cloud's motion contract, section 3 rule 6 |

The strip plates print the section's clip inset at 120, 240 and 480ms while opening and at 120 and 240ms while closing. The closed inset is 507 (563 less the 56 strip). cubic-bezier(0.22, 1, 0.36, 1) reproduces all five values to the printed digits. The review sheet's own `--ease`, cubic-bezier(0.625, 0.05, 0, 1), does not:

| Frame | Printed inset | cubic-bezier(0.22, 1, 0.36, 1) | cubic-bezier(0.625, 0.05, 0, 1) |
|---|---|---|---|
| open, 120ms | 204.053 | 204.053 | 482.7 |
| open, 240ms | 67.5736 | 67.5736 | 319.5 |
| open, 480ms | 4.26557 | 4.2656 | 26.0 |
| close, 120ms | 413.219 | 413.219 | 97.2 |
| close, 240ms | 496.272 | 496.272 | 456.5 |

So the push curve is cubic-bezier(0.22, 1, 0.36, 1). The sheet's `--ease` is the review page's own curve, not the app's; the revamp plan's note that H3 needs cubic-bezier(0.625, 0.05, 0, 1) is replaced by this section. The close's caption, "arrive slowly, leave fast", is the same curve on the shorter duration. Open: confirm against the mockup source and Cloud's CSS.

### 3.2 The wipe
Only clip-path, transform and opacity animate. Her section's box never changes (section 1.5).

| Frame (printed, 1440 x 900) | Open: clip | Close: clip |
|---|---|---|
| 0ms | inset(0px 0px 507px) | inset(0px) |
| 120ms | inset(0px 0px 204.053px) | inset(0px 0px 413.219px) |
| 240ms | inset(0px 0px 67.5736px) | inset(0px 0px 496.272px) |
| 480ms | inset(0px 0px 4.26557px) | inset(0px 0px 507px) |
| 720ms | inset(0px) | inset(0px 0px 507px) |

The card's box is 680, 249, 760 x 651 and the section's is 248, 264, 432 x 563 on every one of these frames. Desktop's closed inset is the box height less 56 (547 at 1440 x 900, section 1.5).

**Opening:** the wipe grows from the strip's edge down to the foot line, behind a 1px scan head keyed to the same edge. The glyph field starts to run. Kimm drops 32px into place with the wipe. The corner key says HIDE VEX from the press.

**Closing:** the wipe rises back to the strip's edge in 420ms, behind the same scan head, and Kimm rises 32px with it. The field holds its frame in the strip. The key says SHOW VEX from the press. The console's rest stays inert until the close has ended.

**The scan head** (settled 2026-11-05 from VEX Cloud's mockup source, `h3-merged/js/stage.js` and `css/tokens.css`): a 1px line in Cloud's `--vx-scan-head`, oklch(97% 0.005 264 / 0.85) (desktop's `--vex-alias-scan-head`, the ink at 85%), keyed to the wipe's edge on the open and on the close, on the clip's own curve and duration. Its opacity stays 1 until 92% of the leg, then falls linearly to 0, so it is never left standing at her foot or at the strip.

**The engine.** Desktop runs the wipe as Cloud's mockup does, on Web Animations (`components/vex/kimm/kimm-wipe.ts`): the clip's inset and the scan head's place are one leg on one clock, started at the press. The sheet (`kimm.css`) holds only her resting insets, open and at the strip; a leg's last frame is that resting state, and the leg is stopped when it ends. Every length is in her own pixels, before the wide zoom scales her (section 1.11), as her resting clip is, so the last frame lands on that inset at every width; under 1024 she folds to the band's stub, 0, not the strip. A box that is not laid out starts no wipe, and her phase then ends on the leg's duration.

**Her drop** (settled 2026-11-05 from Cloud's `h3-merged/js/stage.js`): the layer that holds her figure is driven by the wipe's inset on both legs, translateY = -32 x inset / distance, on the clip's own curve and duration. Open she stands in place; folded she waits 32px up; so she drops into place as the wipe opens and rises as it closes, and a turned leg turns her with it from where she stands. The 32 is the sheet's `--vex-kimm-drop`, which the wipe reads from her box.

Open, settled by the mockup source: whether her figure also fades in (an opacity change is allowed; Cloud's 900ms crossfade is between her still and her live model, which desktop does not have).

### 3.3 The controls
One meaning everywhere: Hide Vex closes her section, Show Vex opens it, in the same place. Three controls carry it:
1. the Vex key in the header (section 1.6);
2. her corner key, HIDE VEX with a cross while she is open and SHOW VEX with a chevron in the strip while she is closed: the same key in the same corner;
3. Ctrl+Shift+B, Cmd+Shift+B on macOS, from anywhere (desktop's keys are in section 4.4).

- The words change at the press, not at the end of the motion.
- The way back is where the person pressed. After HIDE VEX is pressed, what is under the pointer from 0 to 600ms is Show Vex, and a second press there opens her again (printed at 1024, 1280, 1440 and 2560). The strip's key (531 to 680) covers the open key's box (542 to 680).
- A press acts at once: no confirm, no delay.
- Focused from the keyboard, each key shows the 2px white ring inside its cell.
- **For assistive tech** (VEX Cloud's EC-01 and EC-24): each control is a disclosure named by its words, with `aria-controls` naming her section (`vex-section` in the shell, `vex-stage-section` on the stage before it) and no `aria-expanded` or `aria-pressed`. Every press, by the Vex key, her corner key or the shortcut, is said once in a polite live region beside the Vex key: "Vex shown." or "Vex hidden." (Cloud's DRAFT words). Open: the console line's key under 1024 (section 1.10) is a toggle too and does not say its press yet.

### 3.4 While she moves
- Her section's body is inert while it moves: nothing in it takes a click or focus. The console's rest under her is inert while she is open and until a close has ended. The two keys stay live.
- **A press during the motion turns it around from where it is, without a jump.** Printed at 1440: Hide Vex, then Show Vex 80ms later, read over 13 frames. The control's name at the first press was Show Vex; the wipe's edge was at 408.1px at the second press and still at 408.1px on the next frame; it went no deeper after the press, ended open, and the card moved 0. **The turned leg** (settled 2026-11-05 from Cloud's `h3-merged/js/stage.js` and its motion contract, `TURN_MIN_MS`): the push curve from the current inset, lasting max(140, base x distance left / distance), base being the new direction's 720 or 420; the scan head and her drop turn with it on the same duration (`kimmLegMs`, `DURATION_VEX_TURN_MIN_MS`).
- **A Hide Vex press guards what it reveals** (Cloud's `stage.js` guard, `SECTION_GUARD_MS`). After a close pressed with a pointer (her corner key, the Vex key, or any key that writes her choice), nothing in the console's rest takes a pointer until all three hold: the close has ended, 500ms have passed since the press (`DURATION_VEX_GUARD_MS`), and the pointer has left the pressed key's box. So a second click, or a pointer resting where Hide Vex was, never lands on what the close uncovered. The guard is `data-kimm-guard` on her section, read by the sheet (`kimm.css`); the pressed key's box is noted by a capturing click listener for that task only (`kimm-guard.ts`). A close from the keyboard sets no guard; an open drops one. A touch or a pen has no hover, so once lifted it is out of the key, as Cloud's built guard has it (`use-vex-section.ts`): a press made with one waits only for its 500ms and the close, and any later lift of one counts as leaving, so the next tap is never swallowed. Desktop guards under reduced motion too, where the rest appears under the pointer at once (Cloud's mockup sets it only on its motion path; its built guard runs on every pointer close).
- **Focus.** A press on a key keeps focus on that key; both keys stay where they are through the motion. Focus inside a part that becomes covered or folded moves to the Vex key in the header. (Desktop today moves it to the token chip, `VexSidebar.tsx`; the Vex key replaces the chip in S3-03.)

### 3.5 The rules
- **Vex never opens her section by herself.** Her cue (a card arriving, a turn ending) changes her mood and her words, never her section's state (printed in the proof's note).
- **Esc never closes her section.** Esc belongs to the money card; in H3 the first Esc clears a typed instruction and the next rejects. Desktop's card keys are in section 4.3. Esc in Lighter Zen closed the Vex overlay until S2-13 removed it (`AppShell.tsx`).
- **The first close teaches the way back, once.** For 2.4s the key's name and its keycaps ("Show Vex", Ctrl, Shift, B; ⇧, ⌘, B on a Mac) stand under the Vex key, over Vex's column only. Cloud shows it once per browser; desktop shows it once per profile, behind a saved flag (S4-15). It is drawn as Cloud's `.vx-vk-tip` (`.vex-kimm-hint` in kimm.css): the tooltip plate (`--vex-alias-tooltip-bg`) at Cloud's top calc(100% + 8px) of the key, which is 8px into the column here since the column starts at the key's foot, and left 88 (the 76 portrait cell plus 12); padding 8 10, the words 12px at 0.02em, line height 1, on one line, 12 between the words and the keycaps; the keycaps 22 high, 11px ink-2 on a 1px chosen rule (section 2.4). It has no fixed height and no fade: it simply stands and leaves with its timer. Desktop keeps it a status (`role="status"`) so a screen reader hears the way back; Cloud's is `aria-hidden`.
- **The choice is remembered, split three ways** (VEX Cloud's PD-12 and its README's "What it remembers"). Cloud keeps it per browser (`vexChat`, `vexPages`; the mockup's `h3.section.chat`, `h3.section.pages` and, under 1024, the session's `h3.section.narrow`); desktop keeps it per profile in the layout store:
  - **in chats** (and on approvals and in Studio), `vexOpenChat`, persisted, **open** by default; v24 folded R3's "Show avatar" into it, so someone who had hidden her avatar finds her closed;
  - **on pages** (Portfolio and its subpages, Board, Watchlist, Settings), `vexOpenPages`, persisted, **closed** by default; hiding her on a page never closes her in a chat, nor the other way round;
  - **under 1024**, `vexOpenNarrow`, **closed on every visit** and kept for the session only (never persisted), so a relaunch starts it closed; nothing narrow writes `vexOpenChat` or `vexOpenPages` (section 1.10).
  Every saved choice survives the migrations: v22 seeded the two persisted slots only where a payload lacked them, and v24 touched only the chat's.
- **First launch: open** in chats, closed on pages, closed under 1024. The sheet's drawn answer for computers, and Cloud's PD-12.
- **The freed room in a chat goes to the console** (drawn): the chat keeps its width, and the console's rest shows under the strip.
- **Reduced motion and Save-Data** open and close her at once; the glyph field holds one still frame. The first-close hint shows the same, since it never fades.
- **Closed costs little.** Closed, only the chip of her mood loads (about 6 KB; the sheet: 415 KB closed against 15 MB open). Her large art loads when her section first opens (S4-05). The glyph field runs only while her section is open and on screen (S4-17): VEX Cloud's Gradient ASCII field (` VEX`, cell 20, density 0.5, glyphs 0.6, gradient 0.8, the palette #1E3FD8 #F6F8FF #A5D8FF #38BDF8 on the horizon shape, no intro), ported as plain canvas code (`gradient-ascii.ts`, MIT + Commons Clause, its licence beside it), reached by a dynamic import; closed it holds its frame, the band draws one frame, on a page her open section holds its frame (VEX Cloud runs it only in a chat's section, `kimmFieldMode`), and its ground gives up the baked frame for the page once it has painted.

### 3.6 The money card never moves
Opening or closing her section never moves, resizes or covers a waiting money card, on any frame. It holds because of three things, and needs all three:

1. **The chat column is a grid track whose width depends only on the window** (section 1.2). Nothing about her section enters the grid.
2. **Her section is a fixed box laid over Vex's column** (section 1.5). Open and closed differ only in its clip-path, so neither the column's content nor the grid reflows.
3. **Only clip-path, transform and opacity animate.** None of them changes layout.

Beyond that, Vex's cue never changes her section's state, and under 1024 the band rests for the whole turn, so a card's arrival and Approve change nothing either.

What the proof read (printed, `h3-merged__plate-proof`, in Chromium on the GPU at DPR 2): the seeked open and close, every 30ms from 0 to 720ms at 1440 x 900, 25 frames each; live presses at 1440 and 2560 on every painted frame; the card arriving with her open (50 frames) and closed (241 frames); the press's footprint at 1024, 1280, 1440 and 2560; a press during the motion; the narrow layouts at 390 and 900; and the card's pixels open against closed at 1280, 1366, 1440, 1920 and 2560. The card moved 0 in every row, and 0 of its pixels differed.

Desktop ports the proof as a CI test (S4-16, `e2e/h3-card-proof.spec.ts`): the card's box is read with her section open, closed and on every frame of both motions at 1280, 1366, 1440, 1920 and 2560, and the card's pixels open and closed are compared. Any change fails the build.

What desktop stops doing, because R3 does it and H3 forbids it:
- R3 animates the shell's `grid-template-columns` when Vex hides (`--vex-duration-reveal`, `AppShell.tsx`). H3's frame never animates a track at all (`shell.css`; VEX Cloud's EC-26): in a chat no track changes for her section, and where a track does change (the band seam, the chats fold from 1280 up, a page's strip) it snaps.
- R3's hide waits for K2's close episode before the column goes (`features/vex/vex-hide.ts`). H3's close is the wipe itself, and the words change at the press.
- R3 closes Vex by itself under its medium tier when the left sidebar opens (`lib/shell-columns.ts`). H3 has no derived close.

### 3.7 What the motion policy needs
`MOTION-POLICY.md` allows a closed scale of durations (0, 100, 150, 240 and 300ms), three curves and no fourth, and bans `cubic-bezier(` outside the token sheets. H3 needs, in S1-12, with JS mirrors and the policy edit in the same commit:
- 720ms and 420ms, as her section's open and close, named in the policy's exception list;
- the push curve, cubic-bezier(0.22, 1, 0.36, 1), as a fourth curve, for her section;
- the glyph field's loop as a named exception beside K2's portrait, bound by the run gate and the still frame (S4-17);
- Save-Data on `html` as an attribute (S1-13), so what the sheet moves collapses in CSS as well as in JS.

The wipe itself is Web Animations (section 3.2, "The engine"), which no stylesheet collapses: under reduced motion and Save-Data `KimmSection` starts none and rests her phase at the press.

Any JS timer paired with these durations follows the policy's cross-file pair rule.

---

## 4. Where desktop differs

Desktop follows H3 except where this section says otherwise. Every difference here is on purpose, and the parity captures (section 4.10) are expected to show each of them.

### 4.1 Elements with no data on desktop
Desktop is mainnet only ("Nothing here is a sandbox or testnet", `src/vex-agent/studio/instructions/shared-usage.ts`) and has no Hyperliquid. From the code audit behind the revamp plan:

**Left out** until a real feature backs them. Building those features (F04 spend caps, F11 strategies, a global pause, a daily budget, paper mode) is tracker work, not part of the revamp.
1. Strategies, everywhere: the console's strategies row and strategy rows, Strategies in the nav, the page strip's strategies cell, allocation by strategy, and the word "strategy" in any line. F11 has not started, and even F11 is paper only.
2. The network menu, and Paper against Live. There is no testnet and no paper mode; a static MAINNET and REAL FUNDS is true.
3. PAUSE ALL. Desktop has per-run pause and stop, and Lock Vex, which stops signing, not workers.
4. DAILY BUDGET. There is no daily budget; the status strip's CONTEXT meter takes its cell. It is drawn as Cloud's meter (`.vx-cmp-bars`, its `--vx-meter-off`, `-on` and `-head`): ten cells 6 x 12, 2 apart, an unlit cell white at 8%, a lit one 39%, the last lit one 60%; past the engine's critical band the lit cells turn ink. The Lighter account's margin meter (`lit-margin-usage-bar`) is the same drawing, its lit cells ink past 80%.
5. The card's limits line ("up to 10,000 USD per order, 50,000 USD a day"). F04 has not started.
6. "Change in Settings" under AI PERMISSION. A chat's permission is set when it is created and locked.
7. The composer's image key. Attachments are not supported.
8. The card's FROM row with the wallet's available balance.
9. The card's QUOTED PRICE.
10. The card's editable amount. The card shows the signed arguments; a new amount is a new proposal.
11. A network fee figure and a total debit with an unknown part. Network fee reads "Not available", and the total stays hidden until every part is known.

**Filled from what is real:**

12. Portfolio: the wallet total, the change since the last snapshot, and Lighter's equity and positions; the equity chart once the balance snapshots reach the renderer (S7-05). Left out: P&L over today, 7 days and all time, drawdown, "of allocated", the 90-day range and allocation by venue.
13. The open-positions table: Lighter perps only.
14. The thinking row: "Thought for 2.8s" only after a live turn; a stored turn reads "Thought" with no total, since persisted turns store no duration (VEX Cloud's EC-07); tool rows keep their measured times.
15. Agent Scan's status words (H3's Activity): desktop's outcome words (Appendix A.3).
16. The nav: section 4.6.

What this does to the layout: the console's top block is 40 shorter and her box starts at y 224 (section 1.5); the status strip holds the model and effort, the permission's promise and the context meter (section 1.8); the field runs on to the send key; the card's foot is section 4.3.

### 4.2 Mainnet only
- The header's network cell is a statement: MAINNET and the REAL FUNDS mark, no chevron, no menu.
- Every card keeps MAINNET and the REAL FUNDS stamp in its eyebrow row, as every R3 card wears REAL FUNDS.
- Portfolio has no PAPER key.
- "Mainnet" in the Needs you meta line and the missions row is true and stays.

### 4.3 The approval gate
H3 swaps desktop's two-step confirm for a tick ("I understand real funds can be lost") and adds Ctrl+Enter to approve and Esc to reject. `AGENTS.md` forbids weakening an approval gate without a reviewed product decision, so desktop keeps its gate and takes H3's look:

- Reject and the approve key sit in the bottom row's chat cells (section 1.8). Reject keeps the first focus. On a column 720 wide or less (the chat at 1280 and 1366) the keys step down as Cloud's do: Reject 128, the approve key 168 with 20 each side of its word, the middle cell 18 in; under 560 the gate line takes its own row as before.
- A high-risk card (risk level high or critical, or an action kind of `destructive` or `user_wallet_broadcast`, `ApprovalCard/risk.ts`) still takes two presses, for Approve and for Reject alike. The first press arms the key for 4 seconds (`CONFIRM_RESET_MS`, `ApprovalCard.tsx`) and its label reads "Click again to confirm approve" or "Click again to confirm reject"; the second decides. Any other card decides on one press.
- No tick box, no Ctrl+Enter, and Esc never decides a card.
- The middle cell holds the line for the card's gate (Appendix A.7) and no control.
- The approve key is the blue primary while it can be pressed. H3 never draws the enabled key; blue is presumed from SEND.
- R3's safety flow stays: REAL FUNDS on every card, Reject first, Lock Vex refused while signing, nothing signs until the person confirms.
- **The ground** of the waiting card, its own footer, the closed card and the receipt is Cloud's card ground, `--vx-card` (#030405, `--vex-alias-card`); the docked band in the shell is a box on the card ground too (section 6.5); the desk chat's keeps the bottom row's ground.
- **The rows** are Cloud's field row grid (`rows.css` `.vx-fr`): the name column at least 120 and as wide as its longest name, the value the rest, 16 between, each row's rule under it; the table draws the rule over its first row and its last row leaves its own to the cell under the table, so no rule doubles.
- **Outside the dock** (the Needs you page, the global panel, a second card in a chat's stack), the card's footer is Cloud's key row (`.vx-xc-foot`): cells on the card's rule, the reason field as a cell, the keys 44 high in 13 caps at 400 with a left rule each, Reject the raised cell at least 120 wide and the approve key the blue at least 200; armed, the reversed ink fill; held, Cloud's held look. The Lighter desk's Review order card keeps its approved plate's keys (S8-02).
- **The Needs you row** (a card folded to one line) takes the kit's measures: the decision in 15 / 1.3 at 400 (Cloud's kit has no 500), the REAL FUNDS stamp 24 high in caps 11, and its keys the kit's `Button` keys in 13 caps, Reject the strong `ink` key and Review the framed `ghost` key; nothing on a row is blue, since nothing is approved from it.
- **The clip cue** (Cloud's `ClipCue`, `.vx-tk-more`): while rows of the card are cut from view (the chat's approvals stack is bounded, and a card's own footer is sticky over its last rows), "{n} more lines below" lies right over the keys, 29 high in 11 caps ink 2 on the card ground. It is an overlay on the foot of the view and takes no layout room, so it never moves the card or takes its room. It counts only drawn rows the view cuts (the table's rows, the "All signed fields" toggle and, when open, the signed fields' rows; never the folded rows of a closed toggle), counting a row under the cue itself as cut while it shows. It is `aria-hidden` (every row is in the reading order) and decides nothing. Cloud's Total debit summary line has no desktop row to summarise (section 4.1).
- **The room the stack is given** (the money rule, section 3.6): in a chat the approvals stack is held to 75vh and also to the conversation scrollport's height less the composer seat (which holds the docked decision row while a card waits), the content's 16 foot and the tail space, at least 120. With the chat at its floor the waiting card's top never goes above the header's rule, at any window size, however tall the docked row grows (`ApprovalsRegion`, `useRoomAboveSeat`). Outside a chat 75vh stands alone.
- The card is named as Cloud names its card: by the eyebrow ("Confirm this swap"), described by the sentence, `aria-busy` while a decision runs. It is no live region of its own: the footer's `role="status"` says the running and settled words ("Approving…", "Rejected."), the docked middle cell being that status, and the failure line's `role="alert"` says a failure. Cloud's focusable "Details" group is left out: desktop's card body does not scroll by itself.
- **Review lands on Reject** (C3-A-14, Cloud's `decisionTarget`): the console's Review (and the console line's NEEDS YOU) brings the card into view and focuses its Reject, in the chat's dock when the band is docked there, else in the card's own footer; while a reason is typed, the reject key is "Reject and send". Never the approve key. A folded row, or a card whose keys are held because a decision runs, takes the focus itself, as before (`reveal-approval-card.ts`).
- **The send band** (Cloud's `TakeoverCard` send mode, C3-D-27; owner decision 2026-11-09). While "Tell Vex what to do instead" holds words (spaces alone are none), Approve leaves the band and the band reads Clear | the gate line | "Reject and send", in the card's own footer as in the docked row. "Reject and send" is the reject key under Cloud's name, in the approve key's cell and its blue: the same handler, the trimmed one-line reason travels with it, a high-risk card still takes two presses ("Click again to reject and send"), it keeps Reject's first focus, and while it runs it reads "Sending…". Clear, in Reject's cell, empties the field and gives it the focus, and Approve comes back. An approve armed by a first press is disarmed when words are typed, so it never comes back armed; an armed reject stays armed. While a decision runs the field and every key are held, so the band does not change. This is stricter than before: a typed instruction can no longer be thrown away by an approve.
- While a card waits in a chat, the composer gives way to the card, as H3 draws it: the reason field, "Tell Vex what to do instead", is the way to tell Vex something else, and it rejects with the reason, which reaches Vex. Open: whether desktop's composer stays usable under a waiting card, as it is today with its "Waiting for approval" tag. Default: H3's.

**Closed cards** (Cloud's EC-09, the money gaps sheet's group 07). When a card stops waiting while the chat shows it, decided here or elsewhere or expired, a closed card stands in its place in the approvals stack (`ApprovalCard/ClosedApprovalCard.tsx`, `closed-approval.ts`). It reads only what desktop already holds: the approval's row from the approvals read that exists (`approvals.get`) and the reply this chat's own card received; no new IPC, and it decides nothing. It says only what that record proves:
- "Expired. Nothing was run." with "This confirmation expired before it was answered.": the row carries the expiry sweep's own reason, was resolved at or after its own deadline, and its tool never ran. Next key: Dismiss.
- "Rejected. Nothing was run.": any other rejection whose tool never ran. "You chose to reject." and "You rejected it, so nothing from this confirmation ran." only when the person rejected on this card; a rejection made elsewhere or by the engine names no one. Next key: Dismiss.
- "Result uncertain" with "The result is uncertain. Check Agent Scan before trying again.": an approve whose outcome the engine could not prove (`indeterminate`); "You chose to approve." only when approved here. Next keys: Open Agent Scan, Dismiss.
- Nothing for an approve that settled (the act row and the receipt tell it), a row still being read, or a row the read does not return. No closed card names a network, carries the REAL FUNDS stamp or the quiet hatch, or says "Not submitted".
A closed card never holds the dock, so the composer comes back at once. It takes Cloud's `RefusalCard` structure: the strip's title is its only heading, 12 caps in ink; the body, which describes the card, is the answer row (the card's title in 11 caps muted, its sentence in 14 ink, "You chose to ..." in ink 2 only when chosen here), and for an expiry the line "This confirmation expired before it was answered." in 15 ink, never an alert; "You rejected it ..." and "The result is uncertain ..." are the alert line over the band, mounted empty. The band is 72 high and its rule: a fill, then the keys at its end, cells at least 160 wide with their left rules, 13 caps, none blue. It lives while the chat stays open, or until Dismiss.

Adopting the tick and the card keys later needs the owner's decision and a safety review. The card work (S6b) is kept in one builder's files so that review reads one diff.

### 4.4 Keys
- **Ctrl+Shift+B** on Windows and Linux, **Cmd+Shift+B** on macOS, opens and closes her section from anywhere: a listener at the shell, not one that lives only while a chip is mounted, as `VexTokenChip.tsx`'s does today. It matches `KeyboardEvent.code` `KeyB` with exact modifiers: Shift and the platform's key, no Alt, not the other platform's key.
- **Desktop binds it on Linux too.** Cloud leaves it unbound there ("unbound on Linux, as the app leaves it", `h3-merged__plate-controls`; the plate gives no reason). The desktop app owns its keys, and the chord collides with nothing in it: Studio's `KeyB` binding is Ctrl or Cmd+B without Shift, and Studio's matcher requires exact modifiers; xterm does not encode it; the menu's one accelerator is Lock Vex, Cmd or Ctrl+Shift+L (`src/main/menu-template.ts`). The Studio terminal refuses the chord explicitly (`XtermHost.tsx`), so the shell gets it first. Open: a Linux desktop that takes the chord globally; checked in the Linux pass (S9-03).
- **The old chord,** Cmd or Ctrl+Shift+Period (`features/vex/vex-toggle-shortcut.ts`), still opens and closes her for one release, then goes. Keycaps and tooltips show only the new chord.
- The shortcut's proof test compares modifiers as well as codes (`vex-toggle-shortcut.test.ts`).
- **Esc** never closes her and never decides a card. In Lighter Zen, Esc keeps closing Zen's own panels and then Zen, but no longer closes the Vex overlay (S2-13); leaving Zen with her open keeps her open, on the desk's own chat column.

### 4.5 Dark only
Every H3 plate is dark. Desktop retires its light theme (Celeris) and the "system" choice, and saved choices move to dark (S1-04). The window background, the Windows caption overlay and the theme-matrix test follow the one ground (section 2.1).

### 4.6 The nav
Chat, Missions, Watchlist, Portfolio, Agent Scan, Lighter, Studio, Board, Settings.
- Desktop keeps its page names (owner decision, 2026-11-04): H3's MARKETS is desktop's Watchlist and H3's ACTIVITY is desktop's Agent Scan, which joins the nav. Their titles, nav rows and links keep those names.
- No Strategies until F11.
- Lighter, Studio and Board are desktop's; H3 does not draw them.
- Icons are VEX's filled glyphs on the 24 grid, VEX Cloud's DG-1 set (`components/icons/glyph/`, a byte copy of Cloud's `glyph-sprite-data.ts`, VEX's own art; owner approval 2026-11-08): New chat `rail-plus`, Chat `rail-ask`, Missions `cube` in its three tones, Watchlist `rail-chart`, Portfolio `vault`, Agent Scan `list`, Settings `gear`, as Cloud's nav. They replace the line redrawings S5-04 first made from the captures; the components (`LineH3Chat` and the rest) keep their names and props. Desktop draws a glyph's parts inline, where Cloud clones a mounted sprite by `<use>`, so a glyph needs no sprite mounted first. Desktop's three extra entries (Lighter, Studio, Board) keep their line drawings. The Vex key's open portrait is the set's `portrait` (section 1.6).

Nine rows on the 40px pitch take 360 where H3's seven take 280, so the chats list's rule moves from 472 to about 552. The CHATS heading, the first group head and the first row need about 114 under that rule, so at a 720-high window (bottom row at 648) not one chat row fits; H3's own seven rows leave about one. Open: whether the nav condenses or the column scrolls at short heights. Settled in the harness at 1000 x 720 and 1280 x 800.

### 4.7 Window chrome
- `titleBarStyle: 'hidden'` stays on every OS. The header row is the drag region; every control in it opts out.
- **macOS.** The traffic lights are 12px circles 8 apart from x 20, so they span 20 to 72 (`TRAFFIC_LIGHT_POSITION`, `src/main/windows/chrome-options.ts`). In the 76-high header they move from y 16 to y 32, so they centre on the row ((76 - 12) / 2, derived; S2-04). The logo cell's mark starts after them, at 92, as R3's left head does. H3's "CLOUD" would not fit beside the mark there either.
- **Windows and Linux.** The window controls are an overlay at the top right: today 138 wide including its gap and 43 high (the 44 head less its rule). Desktop leaves PAUSE ALL out, so the header cell where H3 draws it becomes the reserve: as wide as `--overlay-w`, a drag region with nothing in it. Proposed: the overlay grows to 75 high (the header less its rule), so the buttons fill the row. Its colour is the ground. Open: the 75-high buttons and Windows 11's snap menu, checked on Windows in S9-02.
- **Linux with the native frame** (`nativeFrame`): no overlay and no reserve; the OS frame stands above the header.

### 4.8 Desktop's title bar items H3 has no cell for
Today's title bar (`RunningHead.tsx`) holds more than H3's header draws:

| Today | In H3 |
|---|---|
| the token chip | the Vex key (S3-03) |
| Needs you | the console's NEEDS YOU; no header control, in every mode, the Lighter desk's console included (removed 2026-11-09, VEX Cloud's G14). Its count and Review stay a press away: the column's NEEDS YOU and its rows from 1024, the page strip's decision on a table page, and under 1024 the console line's NEEDS YOU, which is then the Review key to the decision that leads (section 1.10). The header keeps its voice: `NeedsYouAnnouncer` says "{count} awaiting your approval" politely when the count rises after a known count, for 30 s; the first count and a fall are silent (Cloud's `needs-announcer.tsx`) |
| Notices, while notices exist | kept in the title cell's cluster while notices exist (owner, 2026-11-09: desktop users already know it). Open: a cell of its own before the network cell |
| a page's keys (refresh, export; `pageKeysSlot.tsx`) | the page's tabs row, at the right beside "Updated {time}" |
| a chat's export (`SessionExportControl`) and the mission rail (`MissionRail`) | Open. Proposed: the export in a menu on the chat title cell; the mission's controls in R3's mission strip above the composer |
| Studio's host status | Studio's own plate (section 4.9) |
| the approvals sync, the notification center and the announcer | unchanged: mounted once, inside the header (S2-03) |

### 4.9 Screens H3 does not draw
H3 covers Cloud's screens. These desktop surfaces have no H3 plate:
- Studio: projects, the explorer, terminals and their panes;
- the Lighter desk: the market bar, the chart, the book, the ticket and its Review order card, the account dock, Zen, the desk chat and its drag;
- the screens before the shell: wake and unlock, the system check and migration, the first-run stages and the wizard;
- Board, the Watchlist (H3's Markets), Memory, Sessions, How Vex works, Vex Inference funds, Settings' sections and the Needs you page.

They get our own H3 plates, composed in the harness from this document's tokens and cells and approved by the owner before any code for them is written (S8-01 to S8-03). Until then they keep their R3 layout and take only the H3 look (S1). Agent Scan, the Watchlist and Settings (H3's Activity, Markets and Settings) are in H3's nav but not drawn; they follow the page frame (section 1.9), with rows built from the console's and the chats list's cells.

Already known for those plates:
- The Lighter desk keeps its chat on the right until its own restyle (S2-06). The money rule binds its Review order card too: opening or closing her never moves it.
- Studio's console adds "This project" (S8-06).
- Kimm replaces K2 everywhere, including the stage screens, and K2 retires at the end of wave 4 (S8-16).

**Approved (owner, 2026-11-04), as drawn:** the harness plates `?plate=studio-project`, `studio-split` and `studio-band-files` (S8-01); `lighter-desk`, `lighter-desk-review`, `lighter-desk-two-step` and `lighter-zen` (S8-02); `stage-wake`, `stage-system-check`, `stage-system-check-blocked`, `stage-wizard-password` and `stage-wizard-wallets` (S8-03).

**The unlock leaves the stage (owner decision, 2026-11-09: "full split, keep the local screen simple").** The plates `stage-unlock` and `stage-unlock-locked`, approved as drawn on 2026-11-04, are superseded: the lock screen no longer stands on the three-column stage but is its own split, Kimm's panel at the left and the password's column at the right (section 4.13; the harness stages `?stage=unlock` and `?stage=unlock-locked`, with `&vex=closed` for her hidden choice). The old plates stay in the harness, marked superseded, as the record of what was approved before. Every other screen before the shell (the wake, the checks and the moves, the wizard) keeps the stage as approved. Where a plate's builder left a question open, the plate's own proposal is the answer unless the owner says otherwise. Two things are not part of that approval and stay as they are until the owner decides them separately, with a safety review:
- the desk's gate: an order create, close, cancel or modify is medium risk and decides on one press, as today; two presses stay for high-risk cards only (a deposit, a fee authorization, key registration, a withdrawal claim);
- a settle time before a freshly drawn approval key accepts a press (proposed after the desk plate showed Approve order drawn just above SHORT).

**Cloud's built pages are the plates (owner decision, 2026-11-09: "users use the desktop today, pick what fits it").** For the Watchlist, Memory, Vex Inference funds and Settings' sections, the plate is VEX Cloud's BUILT page (its W5 commits: 8f701ca2 the watchlist, 9b6ec94c Settings, 8b3ed699 the account pages and Memory, 239c202d Vex Inference, e1083f44 the W5 review), taken as LOOK ONLY. What each page holds, the data it reads, its controls and its names (Watchlist, Agent Scan) stay desktop's, and a figure Cloud draws that desktop has no source for is left out. No harness plate is composed for these pages. What each one took:
- **Watchlist** (Cloud's `WatchlistPage`): the lead, then from a 900 page two columns, 1.25 to 1: Following (its rows, then the follow form as a framed box) and the alerts. Each section head carries its count ("1 of 30", "1 of 20 waiting"), 12 muted. The lists stand on the card ground in one rule frame, a 34 caps head, rows 56 high and 16 in, the name over its chain and pool (12), the price over the 24 hour change. A failed refresh keeps the rows with "Couldn't refresh your watchlist." and Retry. Desktop keeps its Set alert and Remove keys, its alert form, its Fired list and its footnote.
- **Memory** (Cloud's `MemoryPage` and `account.css`): the lead, then from a 760 page two columns 16 apart: the register at the left and a 300 side column at the right holding the advisory-only guarantee as a framed box on the card ground (where Cloud keeps its controls). The side comes first in the reading order, so the guarantee is read before the register. Section heads are 12 caps with their count 12 muted; each register list stands on the card ground, rows 16 in. Each section's first read is the stepping hatch and its word ("Loading memory…") over two cover rows on the card ground, one status; R3's loading line is gone.
- **Vex Inference funds** (Cloud's `AccountBodyView` and `inference.css`): a Balance box on the card ground, its 44 head "Balance" with "As of {time}" from the account's own read time, then Available (with its USD estimate) and Withdrawable now, each an 11 caps label over a 20 mono figure, cut by 1px rules, and Deposit and Withdraw stacked as cells at the right that open those tabs (neither blue: the forms own their one action). The five tabs stay; their panels are framed on the card ground, at most 760 wide. Every form, card and figure is desktop's.
- **Settings** (Cloud's `settings.css`, the page kit and its controls, W5 9b6ec94c and e1083f44). The nav (`.vx-setnav`): 248 wide, group words 11 caps muted, rows 36 high with the name in sentence case 14, ink 2, and its icon muted (16: desktop's line set has no 18); hover and the chosen row take the chosen row's fill and ink. Desktop keeps the nav in the page (moving it into the left column is the owner's call) and its status words after the names. A section (Cloud's `PageHeader` and `PageBox`): its name is a visually hidden h2 (the nav's chosen row and the header name it), the lead row says the status word first (11 caps, its swatch before it) and then the lead; the body is 24 in, its column at most 760; each block is a box on the card ground, 16 in, its head a 44 band with the 12 caps name (600) and its link at the right. Tools (MCP) keeps its own per-server boxes. Preferences (Cloud's `.vx-field[data-layout=row]`): one framed list on the card ground, rows at least 64 high, padding 12 16, the name 15 and its help 13 muted at most 520; a switch row's name is the switch's label and its press area spans the row, so a press anywhere on the row flips the switch, and a hovering pointer washes the row. Tools (MCP) (Cloud's `McpServerCard` and `McpToolRow`): each server a box on the card ground, its 44 head the name with its state word at the right, the endpoint 13 muted under a rule, then its note and keys, then a "Tools" head (11 caps muted) over the tool rows, 10 16 in; "Use in chats" and "Run without asking" are switches with their labels; the add form is a box of its own. The Vex Inference account in Settings (Cloud's `AccountBodyView`): the balance and the linked wallets each a box with a 44 caps head, the balance's head saying "As of {time}" in hours and minutes, and Fund a full-size key; in onboarding the same heads stand as caps labels over the rows. The Save band (Cloud's `SaveFooter`, `.vx-savebar`): a step's keys in Settings stand in a band at least 56 high under a rule, each an end cell at least 148 wide with its left rule; a Save that will not act is held, never blue. The vault's Save changes is held until a password that passes the strength gate is typed, so a clean form shows no blue; the other steps' Saves keep their current enablement (held only while saving) until each step tracks its own changes, and no step's validation or confirmation changed.

### 4.10 Other desktop rules
- **Closed on a stage, her field stays** (owner decision, 2026-11-09). The screens before the shell that stand on the stage (wake, the checks, the wizard) have no console to stand under her strip, so with her closed the column keeps her glyph field: the tall baked frame (`field-still-wide.webp`) at every width, no figure, under her section (`PreShellStage.tsx`, `stage.css`). Her stored choice is the chat's (`vexOpenChat`) as before; Show Vex and the chord open her.
- **A page that can hold a money card keeps the chat layout.** On the Needs you page, closing her folds only her section, never the column, so a card there never moves. Cloud has no such page.
- Her open or closed choices (chats, pages; the session's own under 1024) and the first-close flag live in the layout store, per profile, not per browser (section 3.5).
- First launch opens her. The sheet's question whether hiding her on the home page also hides her in the app does not apply to desktop.
- There is no phone layout. The window floor is 1000 x 720, and the band borrows from the phone only between 1000 and 1023 (section 1.10).
- One release carries the new look, with no flag.
- **No Background row in Settings** (owner decision, 2026-11-08). It offered the person's own image for the print window of Vex's sidebar, which H3 no longer has. The row, its preview and its tests are gone from the renderer; the stored image and main's store stay as they are, unread, so nothing the person chose is lost.
- **Parity.** The same states are rendered on both apps at 1440 x 900 and 1280 x 800 (the welcome, a swap waiting and Portfolio, each with her open and closed) and compared side by side (`e2e/h3-parity.spec.ts`). The differences in this section are expected in those captures; any other difference is a defect on one side.

- **The owner's rule for Cloud's later changes** (2026-11-09: "pick what fits the desktop; people use it today"). Where Cloud's built W3 to W5 only moves or reorders something desktop users already know, desktop keeps its own; where Cloud fixes a real problem, makes a decision stricter, or restyles a surface in H3, desktop takes it. Recorded per item:
  - Taken: a typed reason takes Approve out of the band (Clear and Reject and send, section 4.3); Cloud's built pages as the look of Watchlist, Memory, Vex Inference funds and Settings, contents unchanged (section 4.9); Kimm's real stills, her live glyph field (GradientASCII, MIT plus Commons Clause, shipped inside the app), Cloud's filled nav glyphs, the loader gate as a kit piece and the Vietnamese font subsets (owner, 2026-11-08).
  - Kept as desktop has it: the waiting card's place in the reading column (Cloud's card and band as one seat), every waiting card stacked (Cloud's one card at a time with a pager), no red cross on closed cards, the Notices pill in the header (Cloud's bell in the account menu), effort in the status strip (Cloud's picker), "Ready when you are." (Cloud's greeting by time of day and name), desktop's provider marks, the turn error row with Dismiss only (Cloud's Retry needs its own reviewed slice), no focus ring on the composer field, the hover card on chat rows and one-press Pin, Save enabled on a clean form in the setup steps (the first-run wizard needs it), no stamp-only tab rows, no page entry motion, and the wake plate at boot (the loader gate is not mounted).
  - Not shipped: Kimm's Live2D model and Cubism Core (licence and size; owner, 2026-11-08). Lighter orders keep their one press, with no real-funds tick (owner, 2026-11-08).

### 4.11 What Cloud and desktop must agree on
The column rule and tiers (section 1.2), the words of every element both apps show (Appendix A, where desktop says "same"), the keys (Appendix A.9, less desktop's old chord and its Linux binding), the timings and the push curve (section 3.1), the mood list (section 1.6) and the open-and-closed memory rule (section 3.5). These go to desu; Cloud's answers are recorded here when they come, and each "Open" line above that Cloud settles is rewritten then.

### 4.12 The chats column under 1280: the chats panel
VEX Cloud's rule (PD-14; `h3-shell-gaps/README.md` decision 3 and its measures; `css/shell.css` section 5), which desktop takes whole. It replaces the unsaved override desktop had from 1024 to 1267 (and the fold point of 1268 that R3's 640 floor set), which widened the chats track and so narrowed the chat (to 469 at 1024) and moved a waiting card, with the move animated: a break of the money rule (section 3.6).

- Under 1280 the chats column is the 76 rail at every moment. Its key (the rail's Expand key), the rail's Search chats and its Chat and Missions keys slide a 248 CHATS PANEL out of the rail's right edge instead: the CHATS head (56), the Search chats field (48) and the chats by day, the open column's rows. Search opens it with its field focused.
- The panel is a box over Vex's column, from under the header to the window's foot, above her section; a scrim lies over the rest of her column beside it. The panel stands on Cloud's history-panel ground (`--vx-history-panel`, oklch(8% 0.006 264), the ground's #010203 in sRGB, a step above the rail's #010101) behind the 24% chosen rule; the scrim is Cloud's `--vx-scrim` (oklch(3% 0.004 264 / 50%)), the ground at 50%, never the dialog's 60%. No grid track changes, so a waiting card's box is identical open or closed (the card proof reads it at 1024, 1180 and 1279, seeked and live).
- Under 1024, and on a page whose Vex column has folded to its strip, there is no column to lie over: the scrim runs to the window's edge and the chat behind it rests (inert) until the panel closes.
- Esc (focus in the panel or on its key), a press outside it, and a row's press close it; Esc in its field clears a typed query first.
- Focus, Cloud's (W3 review, `nav-parts.tsx`): opening sends it inside, to the first chat, or to the search field when the press was Search or the list has no chat yet; closing hands focus that was inside back to the rail's key. While it is open, what it lies over rests (inert) so Tab and a screen reader never leave the panel for it: Vex's column (her console, her section `#vex-section` and, under 1024, the band) with the tagline cell at its foot, and, where it covers, the chat (C3-F-08). Closing the panel restores them. Nothing writes the stored fold: the panel is the visit's own and closes when the window grows past 1279.
- Motion, Cloud's (`h3-shell-gaps/js/shell.js` `setLeftOver`): the panel slides from translate3d(-100%) to none in 720ms and back in 420ms on the push curve, the close playing the same keyframes in reverse; the scrim fades in over 600ms and out over 300ms; its first twelve rows enter from 16px left and transparent over 620ms, row n after 120 + 45n ms. Transform and opacity only. Reduced motion and Save-Data land it at once.
- From 1280 up the key folds the track to the rail and back, as before: the stored choice (`leftOpen`), the person's own fold.
- Studio's rail has no chats to slide out: under 1280 it ends in its Projects and files key, whose drawer is the same kind of box over Vex's column.
- Nothing about her section enters this; the fold is what the solver reads (`h3ShellTier` and `H3_CHATS_OPEN_MIN` in `lib/shell-columns.ts`), and the panel is `ChatsPanel.tsx`.

### 4.13 The lock screen
Owner decision, 2026-11-09: "full split, keep the local screen simple". The unlock (`features/secrets/UnlockScreen.tsx`, the view `unlock`), at launch and after Lock Vex, stands on no stage (section 4.9): no header row, no Vex key, no steps, no tagline cell and no bottom row. It is one split on the black ground, cut by the 1px rule (`.vex-lock`, `stage.css`; harness `?stage=unlock`, `?stage=unlock-locked`, `?stage=unlock&vex=closed`).

- **Kimm's panel, the left half** (`KimmPanel.tsx`, `kimm.css`). Her glyph field edge to edge: the live field (`KimmField`, GradientASCII) over the tall baked frame (`field-still-wide.webp`) until it has painted. Her figure is her section still for the mood, standing on the panel's foot at the panel's height less 64, centred, cut by the foot. She rests while the screen waits, is concerned as the stage maps it (`kimmMoodOf("concerned")`, rest) over a wrong password, a throttle or the vault reset panel, and says hi once the vault opens (`stageVexLockMood`, `stage-vex.ts`). Her stored choice is the chat's (`vexOpenChat`), read only: hidden, the panel keeps the field without her figure, the field holding one frame. The field runs only while her figure stands, on screen in a shown window, and never under reduced motion or Save-Data (MOTION-POLICY.md). The panel is decorative: `aria-hidden`, nothing in it takes focus or a pointer. Width: half the window from 1440 up, 40% at the 1000 floor (400), linear between, never under 380 (`--vex-lock-kimm-w`).
- **The column, the right half.** One column 400 wide, centred both ways in the half under the window's top strip: the mark (24, ink) and LOCAL VAULT · LOCKED (12 caps, tracked, muted); the headline, 33 / 40 at 600, "Welcome back." after a launch and "Vex is locked." after Lock Vex; one muted line at 15 / 22, "Your master password decrypts the local vault on this machine. Your keys stay on this computer."; MASTER PASSWORD (12 caps) over the field, a 56-high cell on the field fill with a 1px rule (the chosen rule while focused, the error mark while invalid), the dots in Roboto Mono, its Show cell 74 wide at the right; Unlock, the full-width key 56 high under it, the one blue on the screen (the key cell while the field is empty, the blue once anything is typed and while the unlock runs, held while the throttle runs); and under it a quiet row, "I forgot my password - set up a new vault" with its arrow, 14 muted, under a rule. The field is focused on arrival and Enter unlocks through the form's own submit. A wrong password or the throttle's countdown is one ink line under the field: a square beside the sentence (red for a failure, ink for the throttle), Open logs folder at the right. The version stamp stands at the foot of the right half, 32 in and 24 up, mono 12 muted.
- **Set up a new vault?** takes the form's place in the column with its dialog semantics, its words and the acknowledgement as before; Cancel (a key cell, focused) and Set up new vault (the ink inversion, never the blue) are a row of two 56-high cells under it.
- **Window chrome** (section 4.7). The top strip, `--head-h` (76) high across both halves, is a drag region with nothing in it (`.vex-drag`): the mac traffic lights (20 to 72) stand over Kimm's top left, the Windows and Linux caption overlay at the top right over the right half; the column starts under the strip and is a no-drag region (`.vex-no-drag`), so neither the lights nor the overlay ever cover a control.
- **The handoffs.** The gate's reveal over the unlock lifts her stage away with it, as it does over the shell (`ChronosGate.tsx`), so the wake crossfades into the lock screen; the stage store keeps the launch for the headline and settles the spent crossfade (`stageVexSettle`). After a successful unlock the handoff is today's: the curtain (`CurtainExit`) flips the view beneath, and the lock screen fades out over the shell; no stage stands to lift away. Unlocking back into the wizard brings the wizard's stage back with it.
- **Unchanged**: the unlock logic, the password's handling (an uncontrolled field, never in React state, never logged or stored), the minimum length, the throttle and its countdown, the wrong-password handling, the vault reset flow and its confirmation, autofocus, the accessible names of the field and keys, and the IPC.

---

## 5. The kit

The primitives H3's app plates do not draw, taken from what VEX Cloud decided and built on `origin/rebranding-v99-ui` (the `h3-kit-gaps`, `h3-shell-gaps`, `h3-chat-gaps` and `h3-money-gaps` mockups, `contracts/keys.md`, `apps/web/src/styles/overlays.css` and `keys.css`, and Cloud's `HANDOFF.md`). The owner asked for desktop to take every change Cloud made here, however small. Where desktop keeps a rule of its own, the line says why.

### 5.1 The toast
- **One slot.** One floating cell, never a stack: the plate (`--color-h3-tooltip`, Cloud's `--vx-tooltip`, oklch 20%) in the chosen rule (24%), square, no shadow, at least 44 high, at most min(640, the window less 48) wide. Cloud's D2-16.
- **Anatomy.** The status column (44) first: the cross for a failure, the concerned hatch for a warning, the info glyph for information. Then the words, 14/1.45 in sentence case (a title, where the producer gives one, over the message in ink 2 at 13). Then each action as a key cell on the right edge: 13px caps, ink, padding 0 20, its left rule, never blue. Desktop keeps its dismiss key as the last cell (44, the cross glyph), because its notifications are dismissible and some are not.
- **A failure** is the refusal register: the red 16% over the card ground (`--vex-alias-refusal-tint` over `--color-h3-card`). Its words stay ink, where Cloud uses its refusal ink: a status word is ink on desktop (section 2.2).
- **Place.** 12 under the header, centred on the content column (the chat, a page or the desk), clamped 12 from the window's edges. Before the shell exists, 12 under the old 44 title row.
- **Never over a waiting card** (Cloud's DG-3 decision 16). A card's strip carries the network and REAL FUNDS, and on a short window it starts at the header's rule. When any `[data-vex-area="approval-card"]` would meet the toast's box, or come within 8 of its foot, the toast takes the header's message slot instead: the header's title cell, for its hold, on the header's ground with no plate of its own, the words 24 in at H3's `.hd-msg` (12/1.35), its keys as the cell's key cells. The words are clamped to three lines with an ellipsis (Cloud's `IN_SLOT_TEXT`; three lines of 12/1.35 fit the cell), never scrolled, and the slot never grows onto the card; the whole sentence stays in the notification center and was announced. An action there is the cell's key with its left rule, padding 0 12 (Cloud's `IN_SLOT_ACTION`). The seat is measured on show, on resize, on any scroll and whenever the document's tree changes, once a frame at most, and only while a toast is on screen (`toastSeat`, `components/ui/notification-toast.tsx`). The desk's Review order is a modal dialog, and a toast never paints while a modal holds the top layer: it waits in the center (unchanged). `e2e/h3-card-proof.spec.ts` proves both in a real browser at 1280 x 720 to 1920 x 1080.
- **Timings,** Cloud's: the hold is 3s, 6s for a toast with an action or whose words (title, message and action labels) reach 75 characters; then a 1000ms fade (Cloud's `toastFade`; Cloud's `HANDOFF.md` records the hold plus 1000ms as a deviation it keeps, against the drawn 300). The toast arrives in 620ms on the push curve, which has the control points of Cloud's caption curve, 8px down and in; reduced motion drops the arrival and keeps the fade. Hover or focus pauses the hold, and a sticky notification (progress still running, a failure with a working primary action) never fades, as before.
- **What waits** behind the slot is reported under the words ("+2 more in the notification center"), never dropped: the queue, the center and the announcer are unchanged. An urgent notification still passes the slot and stands under it; nothing raises one yet.

### 5.2 Keys and dialogs
**The general key** (`components/ui/button.tsx`) is Cloud's v99 key (`contracts/keys.md`, `keys.css`, D2-1 to D2-4). A key is a square, its word in caps at 13 and 400 with the label tracking; on a page it has a fixed height and its own 1px edge. Desktop's variant names stay, each keeping the action its call sites give it; only the look follows Cloud's map:

| Desktop variant | Cloud's look |
|---|---|
| primary | `primary`: the blue fill, white word, a blue edge; the view's one blue |
| ink (Reject, Decline, a danger confirm) and stop (Stop agent, Stop mission) | `strong`: the raised ground at full ink in the 40% control edge (`--vex-alias-rule-control`), because raised alone is 1.02:1 on the card |
| quiet, ghost, armed | `outline`: the framed key, the cell ground in the 7% rule, ink 2 words; armed turns blue on `data-armed="true"` |
| bare | `ghost`: no ground and no edge, ink 2 words |

Sizes: 40 high with padding 0 18 (the default), 32 with 0 14 at 12px (`sm`), 44 with 0 24 (`lg`), the 32 square glyph key (`icon`). Hover lifts the word to ink and raises a fill from the key's foot in 420ms (white 7%, the blue hover on the blue key; `--vex-duration-key-fill`, Cloud's `--vx-dur-fill`), hovering pointers only; a press moves the key down 1px. A key that will not act is held, never dimmed: the cell ground, a muted word, the 7% edge, no fill. **Red is never a key** and neither is a blue danger. Differences from Cloud: the fill rides the entrance curve, because Cloud's `--vx-ease-ease` is not one of desktop's four (MOTION-POLICY); the label roll (520ms) is not built, since it needs every label wrapped; the wizard's approved plate keeps its own keys and rows (`stage.css` opts them out of the caps and the fill).

**The dialog** (`components/ui/dialog.tsx`) is H3's `.dlg` (Cloud's D2-32, D2-33):
- One width, 560 (the window less 32 under it), confirms and forms alike; the width is stated in `overlays.css` so a call site's old `max-w-*` no longer decides it. A board and a sheet keep their own boxes.
- The card ground (`--color-h3-card`, Cloud's `--vx-card`) in the chosen rule (24%), square, no shadow.
- A head band 44 high under the 7% rule: an optional word 24 in (`kicker`, after the ink square of a decision that waits) and Close at its end, a 44 glyph cell with its left rule. An optional tag (`tag`, Cloud's `.vx-dlg-tag`) stands at the band's end before Close, gap 8 and 12 each side: a money dialog's network word and its solid REAL FUNDS tag, so a money dialog wears its mark in the head. Desktop's money confirmations are cards today, so no caller passes one yet. Close takes no Tab stop, so the dialog's keys keep the focus order they had, and it closes through the very path Esc takes (it raises the dialog's own `cancel` event), so a surface that ignores a close while it is busy ignores this one too. Cloud holds Close while pending; desktop's dialogs hold it the way they hold Esc.
- The title 22/600 tracked in; the description 15/1.5 in ink.
- Where the foot is keys and nothing else, it is a foot of cell keys: 64 high under the 7% rule, each key full height and at least 150 wide (four keys share the width), its left rule shared with its neighbour. Default tone: the keys on the right, Cancel raised, the confirm blue.
- **The danger confirm** (a foot whose last key is `ink`, with a Cancel before it) is the strong ink key, raised in the 40% control edge, on the right, beside a frameless Cancel on the left (Cloud's D2-3). Never red, never blue. Which key acts, which takes the first focus and what Esc does stay the call site's.

### 5.3 Sides in ink
Buy, Sell, Long and Short read as words in ink, never in the trading green and red (Cloud's DG5-07, confirmed by both token comparisons): red means refused in v99, so a red Sell or Short reads as a refusal. The word carries the side. Profit and loss keep the gain and loss colours, and so do a price's change and the last trade's tick (a movement, not a side). The token values of gain and loss are left to the token pass; only their use for sides stops here.

| Where | Before | Now |
|---|---|---|
| the ticket's LONG and SHORT keys (`lighter-ticket.css`) | the side word in gain or loss type | ink; the keys stay raised cells, never blue |
| the order book's prices (`lighter-book.css`) | bids in gain, asks in loss | bids in ink, asks in ink 2, as the tape's buys and sells |
| the book's depth bars and their one-frame flash (`--lit-depth-bid`, `--lit-depth-ask`) | a 14% wash of gain or loss | an ink wash, 12% for bids and 7% for asks, so the sides still read apart where they meet |
| the book's bid and ask share ("B 54%", "46% S", the bar) | gain and loss | ink and ink 2; the bar's bid share ink over a 24% ink track |
| the desk chat's scope chip (`lighter-chat.css`) | Long or Short in gain or loss | ink |
| the account dock: a position's Long or Short, an order's and a fill's Buy or Sell (`AccountPanel.tsx`) | gain or loss (`data-trade`, `data-tone`) | ink (`data-side`); uPnL and realized PnL keep their colours |
| Portfolio's Lighter positions: Long or Short (`LighterAccountCard.tsx`, `book.css`) | gain or loss (`data-trade`) | ink (`.vex-pf-side`, `data-side`); uPnL keeps its colour |

Cloud draws no order book, so it sets no rule for depth bars; desktop follows the side rule there too. Nothing about an order changes: its side, size and every key's action are what they were.

### 5.4 The tooltip
Cloud's v99 rail tooltip (`.vx-tip`, D2-25): the dark plate (`--color-h3-tooltip`, oklch 20%) with ink words, not the inverted ink plate R3 drew. 12/1.35 with 0.02em tracking, padding 8 10, at most 280 wide (a reason wraps), 8 from its key, pointed by an 8px notch turned 45 degrees toward the key. It fades in over 160ms. Cloud fades it out over 220ms; desktop's bubble leaves at once, because fading out would need it to outlive its anchor's hover (Open: build it if the owner wants the exit too). The Lighter chart's tool labels take the same plate.

### 5.5 Menus
Every list that opens from a key is one material (Cloud's D2-5, `menu-material.css`): the card ground (`--color-h3-card`, Cloud's `--vx-card`, #030405) in the 24% lifted rule, never an ink border and no shadow (`ui-primitives/menu.css`). The rows, their heights and their keys are unchanged in this pass; Cloud's row grammar (actions in 13px caps, values in 14px words, 40 high rows) is left for the menu's own restyle.

### 5.6 Loading
VEX Cloud's loading marks (its status contract and `styles/rows.css`; `components/ui/cover.tsx`, `ui-primitives/marks.css`). Loading is never a pulse, never a sweep and never a figure.
- **The parked cover** (`Cover`, `.vex-cover`): a value still loading is a 12 high bar on the raised fill with the scan's 1px head parked at its left edge. It holds the box the value will take. **In a line of text** (`CoverText`, Cloud's `SkeletonText`) the cover is centred in the text's own line box (`height: 1lh`), so the row keeps its height when the words land.
- **The loading hatch** (`LoadingHatch`, `.vex-stripes`): 14 square, 135 degree strokes in ink 2, 1px every 4px, blinking on two steps once every 1200ms (`--vex-duration-blink-hatch`, Cloud's `--vx-blink-hatch`). It stands only while a load lasts. Under reduced motion and Save-Data it holds still at full ink. **The loading word** (`LoadingWord`): the hatch, 10, then the word in ink at 14.
- The place that holds covers names itself as loading once (one `role="status"`); the covers and the hatch are decoration.

### 5.7 The empty, error and loading block
VEX Cloud's `EmptyState`, `ErrorState` and `LoadingState` (`components/ui/empty-state.tsx`, `styles/rows.css`; H3 `.empty`), desktop's `EmptyBlock` (`components/ui/empty-block.tsx`, `.vex-empty-block` in `ui-primitives/indicators.css`). It replaces R3's block (the caps scope word, the 15/500 title, the 150 minimum, the blue text link, the loading line).
- **Empty:** a centred card, the 7% rule frame on the card ground, padding 40 16, gap 12; the section's own glyph at 28 in muted when the caller names one (`glyph`), one sentence at 14 in muted, sentence case, no caps word; the next step as a 44 framed key (padding 0 26 in the rule), the outline key. No minimum height.
- **Error:** the same card, 56 above and below, the sentence and the cross glyph (`rail-no`) in ink; Retry as the 44 framed key in the strong (ink) variant. A read whose outcome is not known yet (`concerned`) takes the warning glyph.
- **Loading:** the card holds the loading word (the stepping hatch and the sentence, section 5.6) over three parked covers at full, four fifths and three fifths of a 320 column; the block is a busy status named by the sentence.
- Desktop keeps a second line (`detail`) under the sentence where a caller has a reason worth saying (a failed read's message, why deposits are closed): Cloud draws one sentence only, but those lines are real information. The old scope word is no longer drawn; it rides `data-scope`. A failed read does not add its own alert: the caller names the role (`LoadFailedBlock` passes `alert`).

### 5.8 Tabs
VEX Cloud's tabs (`components/ui/underline-tabs.tsx`, `styles/rows.css`, DG-2 section 8), desktop's `Tabs` (`components/ui/tabs.tsx`), its default look `cells`:
- Square cells cut by the 7% rule (each cell's right edge, the row's left edge and the rule under the row), 13 caps tracked at 0.08em in ink 2, padding 0 22. The chosen cell is the open ground (`--vex-alias-interactive-active`) with its word in ink: no underline, no blue (blue is the action), no glide. The pointer's cell takes the hover wash and ink. Focus is the white ring inside the cell.
- The row: 56 for a page's sections (`density="nav"`), 48 for a section's panels (`panel`, the default), 40 for a panel's own strip (`compact`, 12 caps, padding 0 16). Wider than its box it scrolls sideways with no bar.
- The page frame's tab cells (`PageTabs`, `.vex-pg-tabs` in `book.css`) were already these cells in the 57 row; their unused card head size (`size="head"`) is retired.
- R3's `underline` look stays only where an approved plate draws it (the wizard's wallets and Studio's tab strip, section 4.9); the `segmented` look is unchanged.

### 5.9 The loader and the loader gate
- **The loader** (`VexLoader`) is the loading hatch (section 5.6), 14 square, blinking once every 1200ms, still under reduced motion and Save-Data, its label announced once. It replaces R3's quiet loading line (the 2px track and its stepping blue segment) in the migrations, the wizard's waits and the transcript's loading states. The memory panel's own loading row still draws the line until its restyle.
- **The loader gate** (`LoaderGate`, `components/brand/`, `ui-primitives/gate.css`) is VEX Cloud's (its CTR/brand contract section 3, DG-3 shell.css section 9), ported as a primitive (owner approval 2026-11-08): the VEX mark 200 wide at 1440 (clamp(120px, 14vw, 200px)) drawn twice, the base at 8% white and the fill in white clipped from the right as real progress arrives; the word 11 caps in muted, 22 under the mark; a row of max(18, round(width / 22)) upright cells on the frame's foot line, off 3%, lit 20%, the head 42%; the slow line or a failure hung under the mark, out of flow. The count walks toward what has arrived at one speed (the whole bar in 2.4 s) and never past it; a full bar rests 320ms, the gate fades in 600ms while the mark lifts out to 96% (MOTION-POLICY.md); after 12 s it completes whatever has arrived. The gate's ground is the black primitive (Cloud's oklch(5% 0.006 264) is #000001, one step away). The gate's art is code (the mark's path and CSS): no file joins the brand asset registry.
- **Not mounted.** Desktop's boot is the approved wake plate (`ChronosGate`, section 4.9), which the gate does not replace. Open: whether the gate stands anywhere on desktop (the wake, a window's first paint) is the owner's call.

### 5.10 The next-step bar
Owner decision, 2026-11-10 ("Next-step bar"): in a mission chat with no run, the mission's one next step stands under Vex's answer as a bar, so it no longer reads as a stray outline key (`MissionControls/MissionNextStepBar.tsx`, chat-transcript.css).
- **The bar.** One ruled cell on the reading column (section 6.6): the card ground in the 7% rule, square, no shadow, no glow, no blur. On the left, 16 24 in: the state square and the eyebrow in caps 11. While the mission moves toward a run (MISSION READY, CONTRACT ACCEPTED) the square is the running square, which blinks (section 2.2; still as half a square under reduced motion and Save-Data); MISSION ENDED runs nothing, so its square is the still target (your move); under it one line in sentence case at 14 in ink 2. On the right, the action as a key cell the bar's full height, at least 44 high and 200 wide, its own edge laid over the bar's rule: the primary key (the blue, caps 13, the arrow glyph at its end, the rising blue hover of section 2.4). Under a 480 wide column the key takes the bar's foot.
- **The states,** with the keys' names, gates and presses unchanged:

| State | Eyebrow | Line | Key (its name) |
|---|---|---|---|
| a ready draft waiting for acceptance, the turn settled | MISSION READY | Review the contract, then accept it to start the run. | REVIEW & ACCEPT CONTRACT, opens the contract |
| an accepted contract, no run | CONTRACT ACCEPTED | Nothing runs until you start it. | START MISSION, starts the run |
| a terminal accepted mission, no draft | MISSION ENDED | Renew drafts a new contract; it runs only after you accept it. | RENEW MISSION, clones it into a draft; "Tell Vex what to do differently" stands under the line as its quiet link |

- **The one blue.** A money card waiting in the chat owns the view's blue: while one waits (the chat's pending approvals, a desk row aside, as the composer's frame reads them), the key is the ink key and does not rise.
- **The rise.** On the bar's first appearance for a state of a mission, the key's blue rises once from its foot in 720ms on the push curve, a layer under the word, then rests (MOTION-POLICY.md). Remembered for the app's run: a re-render, a remount or a return to the chat never plays it again. Reduced motion and Save-Data: no rise, the key simply stands blue; a held key never rises.
- A refusal's notice stands under the bar; a contract waiting on Vex keeps its standing notice (it is a notice, not a next step of the person's). The run's own keys (Continue, Edit contract, Stop mission) stay in the composer's mission strip and Recover in the paused callout.

---

## 6. D2: Vex's column at the right edge

Owner decision, 2026-11-09: desktop's app shell moves from H3's middle Vex column to the "D2 version, column" layout, because it "looks clean and better" (the owner's words). The source is two plates the owner showed ("D2 version · column · New chat, greeting" and "version d2 · column · chat in progress, trace of reasoning"), not in any repo, measured from a 1440-wide capture; the spec taken from them is the lead's `D2-SPEC.md` (kept locally). Where the plates are silent, desktop keeps what it did. Built on `revamp-ui-d2`, one feature per commit.

**Owner decision, 2026-11-10: her column becomes a panel.** On a tall window her full-height column ended its console at Open activity and left a hollow strip down to the bottom row. The owner chose "the chat takes that space": the chat runs to the window's right edge, and Vex is a panel docked at its top right, under the header, as tall as what it holds. The sections below are written for the panel (built on `revamp-ui-d2-panel`).

Not part of D2: the lock screen (its own split, section 4.13), the screens before the shell (they keep the stage and H3's middle column, `--vex-h3-vex-w`), and the Lighter desk (its approved plates, section 4.9: its order, its Kimm section with the wipe, strip and corner key, its H3 Vex key in the header and its composer strip are unchanged).

### 6.1 The frame
- Tracks, left to right: chats 248 (the 76 rail where folded, and under 1280) | the chat, the rest, to the window's right edge (`computeH3ShellColumns` and `h3GridTemplateColumns`, `lib/shell-columns.ts`). Vex has no track: her panel is a box 280 wide over the chat's top right, at every width from 1024 up (`D2_VEX_WIDTH`, `--vex-d2-vex-w`; the frame's `--vex-panel-w`). The solve names the chat (`chat`), her panel's width (`vex`) and the chat less it (`room`, where everything readable stands). At 1440: 248 | 1192, a room of 912; at 1280: 248 | 1032, a room of 752; at 1024: 76 | 948, a room of 668.
- The DOM follows the screen: chats, chat, Vex (`shellColumnOrder`), so focus reaches the composer before her panel. Under 1024 her console line stands over the chat and comes before it.
- Rows as H3's: the header 76, the body, the bottom row 72 x zoom and its rule (section 1.11). Open: the plates measure the header about 56; desktop keeps 76 because the macOS traffic lights and the Windows caption overlay are placed for it by the main process, the lock screen and the stages share it, and the spec keeps their reserved areas as today.
- Her panel's rules are on its left and its foot, on the column's opaque ground. It never zooms (it is fixed, as the chats column is); the page strip that stands for it on a page still zooms.
- The money rule's first leg holds by construction: the solve reads the window, the chats choice and a page's strip, and nothing about her shown or hidden choice (section 3.6). Her panel's room stays whether she shows or not.

### 6.2 The header
- Over the chats: the logo cell and the sidebar key, as before.
- Over the chat: the title cell (as before), then **NEEDS YOU and its count** (`NeedsYouHeadCell`): one key, caps 12 at 600, the count a figure after it, muted at zero, no count while the read runs or after it failed. A press opens the Needs you page at its first decision (`{ kind: "needsYou", approvalId: null }`) and never decides; the cards there keep their gate (section 4.3). This reverses section 4.8's "no header control" for the shell; the desk keeps none. Under 1024 the cell leaves the row: the console line carries Needs you and its Review (section 1.10). Then MAINNET and REAL FUNDS (static, as before), the Notices pill and the export as before. No PAUSE ALL.
- Over Vex's panel: **the VEX cell** (`VexHeadCell`): VEX in caps at its left, and at its right end a 44 square key with the panel glyph (`LinePanelRight`), named "Hide Vex" or "Show Vex", `aria-controls` her column (`#vex-section`; her band under 1024), `aria-keyshortcuts` and the tooltip carrying Ctrl+Shift+B (Cmd+Shift+B on a Mac), her state word as its description, every press said "Vex shown." or "Vex hidden." as before. It replaces H3's Vex key (portrait, state word, keycaps, chevron) in the shell. The cell shares the column with the caption reserve, `calc(280px - var(--overlay-w))`, so the Windows and Linux buttons keep their corner; under 1024 the cell is as wide as what it holds. The announcers of her state word and of her shown or hidden press live in this cell, which always stands.
- The cells in the DOM: chats, title, needs, funds, the caption reserve, VEX (`ShellHeader.tsx`); the running head keeps its one tree position. On the desk the same slot holds H3's Vex key, now after the network cell in the DOM (its place on screen is unchanged).

### 6.3 Vex's panel
Her panel (owner decision 2026-11-10) is a box laid over the chat's top right (shell.css): the chat's track, the body row, its right end and its top, 280 wide, under the header, as tall as what it holds, over the chat (z 15 over its 10) and under the chats panel (19), its scrim (18) and the chats column (20), so it never covers the chats panel. Under it is the chat's own ground. It never comes down past the top of the chat's composer group: the frame measures that top (the composer's dock, the box and the live rows over it, or the card's decision dock with its reason field, whichever stands higher) and writes it as `--vex-panel-floor` (`vex-panel-geometry.ts`), so a live step, a grown draft and the docked approval band are never under her. Where the room is short (1440 x 900 with a card waiting, 1280 x 800) her portrait card gives way first, to 160, and then her body scrolls. On a page and in Studio there is no composer to clear (a page's sheet covers the chat to the window's foot, and Studio has no composer row), so there she may run on into the bottom row, to the window's foot. Offline she starts under the connection row, as a page does. The frame also writes her height (`--vex-panel-h`), and the chat's scrollbar track starts under it, so the thumb is never under her.

Top to bottom (`VexColumn.tsx`, vex-sidebar.css):
1. **Kimm's portrait card**: the lock screen's panel (`KimmPanel`) in its `card` seat, the panel's width and 280 / 0.78 (about 359) high, flush under the header; her live glyph field behind her figure, her figure her mood's still by the mood clock (`useKimmShellMood`), placed by her section's settled rule (48 from her top, 88% of the width, cut by the foot). On a page her field holds its frame, as her section's did; reduced motion and Save-Data hold one frame; off screen it stops (`KimmField`'s run gate). Where the room over the composer is short the card gives way first, to 160, so the rows under it keep their place.
2. **The state row**, 44 under a rule: her state square (`VEX_STATE_SQUARE`) and word in caps 13, the live timer at the right end in mono, muted, while a turn runs.
3. **THIS CHAT** (this mission, this project), caps 11 muted, over one line from real parts (`thisChatLineOf`): the narration desktop already writes (`narration.ts`); with none, "{n} decision(s) wait(s) for you." while decisions wait elsewhere, or "Nothing waiting in your chats." once the Needs you read says nothing waits; nothing while that read has not answered. At least 68 high. In Studio with a project open, This project's block takes its place.
4. **Needs you and the missions row**: the console's top block as before (section 1.5), Review rows that never decide.
5. A page's own block (the Board's Ask Vex), then **OPEN ACTIVITY**, 44 high.
6. **Her bars**, the panel's foot strip, 48 high, no words (`TaglineCell` with `words` false, section 6.5), then the panel's foot rule. Under the panel, the chat's ground.

Gone from the shell's panel: Kimm's section over the console, its wipe, strip, scan head, drop, corner key, guard and first-close hint, the console's rest (AI permission, recent activity). The chat's AI permission stands in the composer box's row (section 6.5). Retired with their tests, since nothing reads them after D2: the console's AI permission and recent activity blocks (`VexConsolePermission`, `VexConsoleActivity`, `vex-console-activity.ts`), the console's rest rules (`.vex-vs__rest`, and kimm.css's strip room and guard rules over it, so the guard's `data-kimm-guard` attribute has no reader in the sheet now), and the R3 token chip and avatar-off token (`VexTokenChip`, `VexStatus`), which nothing mounted any more. Her section itself (`KimmSection`, `VexPortraitPlate`, `KimmHint`) stays for the desk, her band and the stages.

### 6.4 Hiding Vex
- The VEX key and the chord hide or show **the whole panel** at the press, no motion: hidden, the aside stays, empty (`data-vex-shown="false"`, no children), with no ground and no rule, so the chat's ground shows where she stood. Her panel's room stays (`--vex-panel-w` is the solve's, never her choice), so the reading column, the card and everything in the chat keep their place and a waiting money card never moves (section 3.6). Focus inside the panel as it hides goes to the VEX key (section 3.4).
- The remembered choices keep their meaning: chats `vexOpenChat` (open by default), pages `vexOpenPages` (closed by default; hidden on a table page the column folds to the page strip as before, section 1.9), the band under 1024 `vexOpenNarrow` (the session's own). Esc never hides her (section 3.5).
- The proof (`e2e/h3-card-proof.spec.ts`, the D2 legs): at 1280, 1366, 1440, 1920 and 2560 the card's box, the grid's columns and the transcript's column are read on every painted frame of Hide Vex, Show Vex, a press turned around 80ms later and the chord, and must not change; her panel shown is the shown render's box and hidden is 0 high at the same x; the frames must show her hidden and shown; on no frame does the card reach under her panel; the card's pixels shown and hidden must be identical. At 1440 x 900, a tall 1440 x 1250, 1920 and 2560 her panel stands at the right edge flush under the header, never past the composer group, her card full where the room allows and never under 160, the transcript and the card clear of her, and the bottom row runs to the right edge. From 1024 to 1279 the open chats panel lies beside her panel. A floating toast never lies over her panel.

### 6.5 The composer box and the bottom row
**Owner decision, 2026-11-10: the composer is a framed box on the conversation column** ("Framed box on the column"). The full-width footer row (the model cell, "Ask Vex..." and SEND under a full-width status strip) read as the window's edge, started far from the centred conversation and was "completely lost in the design". The composer is now one box standing on the conversation column, as the conversation does:

- **The box** (`SessionComposer`, `.vex-composer-box` in console.css; its place in composer.css): exactly the column's x and width (section 6.6: the composer's dock is a `.vex-reading-col`, so it reads `--vex-read-x` and `--vex-read-w` and zooms as the transcript does), lifted 24 off the window's foot from 1280 up and 16 under it. The card ground (`--vex-alias-card`) in the chosen rule (`--vex-alias-rule-chosen`), 1px, square, no shadow, no blur.
- **On top, the field**: "Ask Vex..." at 16 / 24, 16 20 in, its resting words in ink 2 (not muted); it grows with the draft to its 336 cap and then scrolls, as before.
- **Under it, on the 7% rule, one row 56 high**: the model cell (below), then AI PERMISSION and FUNDS REQUIRE APPROVAL (FULL ACCESS in Full access) as caps chips, 24 high in the 7% rule, the composer's state in the room left ("Waiting for approval", "Stopping..."), the context meter in its own left rule, and SEND at the right end, the row's height: blue once the draft has text, held while it is blank, STOP while a turn runs, as before. The status strip as a row of its own is gone; its cells stand in this row, the same words from the same data.
- **A narrow box gives way in steps** (container queries on the row): CONTEXT's word goes at 900 and under, AI PERMISSION's caption and "Reasoning:" at 760 and under (both `aria-hidden`: the grant and the effort key name themselves), the promise's words to its icon at 640 and under (the seat keeps its name). The model's name truncates before the strip's cells shrink. At 1440 everything stands; at 1280 and 1024 the caption, "Reasoning:" and CONTEXT's word have gone.
- **Focus.** While the field holds the focus the box's frame turns the kit's white focus rule (`--vex-alias-focus`), drawn as the frame, not a ring inside the field; the field still draws no ring of its own. While an approval waits the frame is the ink.
- **Over the box, on the column**: the live-step row ("Agent · Thinking" with its timer) and the queue sit on its top rule, their sides in its chosen rule (a mission paused on an error keeps its ink frame); a notice and the post-stop hint stand over them. The slash menu is the box's width, its foot on the box's top rule and its frame continuing the box's. Without a welcome slot the suggestions stand over the box on its width. The context meter's panel rises from its key. All of it stands on the column, so none of it reaches under Vex's panel.
- **The welcome**: the box stands at the bottom of the column, as in a chat; the welcome's group keeps the column's top (section 6.6).
- **Narrower windows**: from 1024 to 1279 the same box on the column's 24 gutter, 16 off the foot; under 1024 (the band) the box spans the chat with 16 each side and 16 off the foot.
- **The bottom row.** The chat has no bottom row any more: it runs to the window's foot and the box stands in it. The chats column's account cell keeps the frame's foot row (72 x zoom and its rule) at the chats column's foot, as before. **Her bars and no words** (`TaglineCell` with `words` false) are her panel's foot strip (section 6.3), still a display only, still stopping off screen and holding one frame under reduced motion and Save-Data (`VexBars`); hidden, they go with her panel. The stages before the shell and her band keep their lines.
- **The docked approval band takes the box's seat** (approval.css, "The band's box in the shell"): while a money card waits in the chat, its decision band is a framed box on the column in the composer box's place, with the same lift (24 off the foot from 1280 up, 16 under it, 16 from the chat's sides under 1024), the card ground in the chosen rule, 1px, square. On top the reason field, "Tell Vex what to do instead"; under it the decision row, 56 high as the box's row: Reject | the gate line | the blue approve key. The clip cue ("{n} more lines below") lies over the box's top rule, its sides continuing the frame. Every behaviour stays: the words, the keys' widths and their steps on a column 720 wide or less and under 560 (section 4.3, now read on the box's own width, the column's: the step at 720 falls on windows 1328 wide and under, so at 1280 and 1024 and not at 1366, whose column is 758), Reject's first focus and the reason row's focus ring, the two-press confirm, D-27's send mode (Clear and "Reject and send"), and the card proof's rules. The desk chat's dock keeps its row.
- **The model cell** (`composer-model-group`): the provider's mark (the model menu, or the key to Settings, as before), then the model's name over "Reasoning:" and the effort key's word and chevron ("Reasoning: High"), at most 260 wide, the name truncating first; two keys, each with its own name. "Reasoning:" stands only before a real effort key. No image key.
- The Lighter desk keeps its composer (section 4.9): its strip over the row (the model and its effort first, the promise), its mark-only model cell, the field and SEND at the window's foot. Studio has no composer.

### 6.6 The conversation column
**Owner decision, 2026-11-10: the conversation fills the centre.** "I meant the chat interface, both the message and the response, fill the space: a central wide space for the chat." The left-anchored 712 column of the D2 plates is replaced: the chat's content stands on one column CENTRED in the room and as WIDE as the room allows (shell.css, chat-transcript.css). The room is the chat less her panel's room (`--vex-read-room` = chat - `--vex-panel-w`, the solve's 280 wherever she has a panel, shown or hidden). `--vex-read-w` = min(1120 x zoom, room - 2 x gutter), the gutter 40 x zoom from 1280 up (the wide tier) and 24 under it, the cap keeping lines readable on a very wide window; `--vex-read-x` = (room - read-w) / 2 from the chat's left edge. 40 and 832 at 1440 (288 to 1120 in the window), 40 and 672 at 1280, 24 and 620 at 1024, 85 and 1221.9 at 1920, about 99.8 and 1272.3 at the owner's 2000 x 1250, 201.2 and 1629.6 at 2560 (the cap). Under 1024 she has no panel, so it is 24 and the chat less 48, centred in the chat. The column never reads her shown or hidden choice, so it does not move when she hides or shows (section 3.6), and nothing on it lies under her panel.

Everything in the conversation follows it: the chat's title starts on its line; the person's bubble and avatar stand at its right edge and Vex's answers at its left (at most 82%, a code block or a table breaking out to the column's whole width); the trace cards, receipts, tables, the day line, the stream preview and the next-step bar take its width; the money card and the approvals stack are the column's width, no wider (no longer one inset wider, so the card's text is 24 in from the column's line); the welcome group (greeting, notes, the 2 x 2 grid) stands on it; the composer box and everything over it (the live-step row, the queue, the slash menu) stand on it, and so does the docked approval band in the box's seat (section 6.5).

The transcript's scroller spans the chat to the right edge. A page's sheet still covers the whole chat (the composer under it included), and what it holds stands in the room, clear of her panel's 280 whether she shows or not, its body starting on the column's line (`--vex-read-x`, as before) at most 1136 wide; Studio's centre stands in the room the same way. The toast centres on the room.

The welcome stands on it too, as one group at the top of the conversation column: "Ready when you are." at 32 / 40 and 600 (no bubble), its two notes under it in muted sentence case 15 / 22, and the 2 x 2 suggestion grid 28 under the notes on the reading column's width; the chat under the group is empty down to the composer. The grid is still the composer's (it seeds the draft, conceals in place while the draft has text, dims while a send is made); the composer portals it into the welcome's slot under the notes (`welcome-starters-slot.ts`), and without a welcome it stands over the composer as before. The words and the suggestions are the welcome's own.

### 6.7 Narrower windows
- 1024 to 1279: the chats are the 76 rail; their key slides the chats panel out of the rail **over the chat** (it used to lie over Vex's column); its scrim runs to the window's edge and the chat and her panel rest (`inert`) until it closes (section 4.12). The chats panel (76 to 324) lies beside her panel, which stands at the right edge past it (the chat is at least 948 there), and over her in the stack. Studio's files drawer lies over the chat the same way. Her panel stays 280 at the right.
- Under 1024: the band and the console line as before (section 1.10), re-seated: her console line stands in the chat's track and before the chat in the DOM; the VEX cell's key opens and closes her band, held with its reason while the band rests; the header's NEEDS YOU cell leaves the row.

### 6.8 Studio and the harness
Studio stands in the same frame (Vex's panel at the right, the VEX cell, Needs you in the header, This project in THIS CHAT's place); its centre stands in the room, and her panel may run on to the window's foot (Studio has no composer row). The H3 harness's Studio plates (section 4.9) now lay their parts on D2's tracks, and their Vex panel is D2's (her portrait card on the stand-in still, the state row, This project, the console's top block, Open activity, her bars); the centre and the chats are still what the plate approved under H3.

### 6.9 Open
- The header's height (56 on the plates, 76 here; section 6.1).
- `kimm-guard.ts` still stands the guard on her section (the desk's, the stages'), but no rule reads it since the console's rest left; it can go with a safety look at the desk.

## Appendix A. Words, keys and taglines

Every word the H3 app screens show, and the word desktop shows in its place. "Same" means desktop uses H3's word. "Left out" means desktop has no real source for it. Where H3's word would be false on desktop, the desktop column gives a true one and the last column says why. Words are written in sentence case in code and shown in caps where the label style applies (section 2.3). Sample values on the captures (chat titles, figures, "Grow ETH") are not words and are not listed. Proposals marked "proposed" are for the row that builds the screen to confirm.

### A.1 Header
| H3 | Desktop | Why |
|---|---|---|
| CLOUD, beside the mark | the mark alone | desktop is not Cloud. Open: a word beside the mark, if the owner wants one |
| READY, THINKING 0:03, WAITING FOR APPROVAL, DONE | Ready, Listening, Thinking, Working, Waiting for approval, Done, Concerned, Error, Sleeping, Waking up (`features/vex/vex-state.ts`), with the timer while Thinking or Working | desktop's state machine has ten states |
| HIDE VEX, SHOW VEX | same | |
| (spoken) "Vex shown.", "Vex hidden." | same, on every toggle's press | Cloud's EC-24 pair, DRAFT in Cloud (PD-27 copy pass) |
| under 1280: WAITING for WAITING FOR APPROVAL in the Vex key; MAIN and the hatch for MAINNET and REAL FUNDS | same | Cloud's short words (`.vk-short`, `.hd-short`); the long words stay for assistive tech |
| keycaps CTRL, SHIFT, B | same on Windows and Linux; ⇧, ⌘, B on macOS, in Apple's modifier order | each platform's keys (section A.9) |
| "SAMPLE DATA" under the chat title | the chat's kind and access: "Agent · Restricted", "Mission · Full access"; a page's own line, or none | "SAMPLE DATA" marks the mockup |
| MAINNET, REAL FUNDS, a chevron | MAINNET and REAL FUNDS, no chevron | desktop is mainnet only; there is nothing to choose |
| PAUSE ALL | left out | desktop has per-run pause and stop and Lock Vex, which stops signing, not workers |

### A.2 Chats column
| H3 | Desktop | Why |
|---|---|---|
| NEW CHAT | same | |
| Search chats | same | |
| CHAT, STRATEGIES, MISSIONS, MARKETS, PORTFOLIO, ACTIVITY, SETTINGS | Chat, Missions, Watchlist, Portfolio, Agent Scan, Lighter, Studio, Board, Settings | no strategies; desktop keeps its names for H3's Markets (Watchlist) and Activity (Agent Scan), owner decision; Lighter, Studio and Board are desktop's |
| CHATS | same | |
| TODAY, YESTERDAY, EARLIER | Pinned, Today, Yesterday, Earlier | "Earlier" replaces desktop's "Older"; pinned chats are desktop's |
| a time, or RUNNING or WAITING | a time, or Running, Paused, Waiting or Sleeping | desktop's chat rows have four states |
| You, Account and settings | same | |
| "Loading chats", "Chats could not load.", "No chats yet.", "No chats match your search." | same | Cloud's REAL list words (`shell/sidebar/chat-list.tsx`); they replace "Loading sessions", the read's raw cause or "Vex could not read your sessions.", and "No sessions". The search's or a tab's empty list says none match; "No chats yet." only when there are none |
| RETRY, RETRYING… under "Chats could not load." | same | Cloud's inline `ErrorState` key; it reads the list again |
| "Untitled chat" | same, for a chat with no title and no first message, and where the Needs you rows and the inbox name an untitled chat | replaces "Agent session" and "Untitled session"; a mission with no title stays "Mission setup" |
| Collapse sidebar, Expand sidebar | same, as the sidebar key's and the rail's names | Cloud's REAL `page-key.tsx`; "chat", never "session", in every word a person reads; the column is named "Chats" |

### A.3 The console
| H3 | Desktop | Why |
|---|---|---|
| NEEDS YOU and a count | same | |
| "Nothing needs you." | same | |
| (loading: covers; failed: "Not available"; partial: "Could not load every decision.") | same: covers, the cross and "Not available" with no count and no Retry, "Could not load every decision." | Cloud's REAL words |
| "{n} more below", "{n} more above" | same, on the cue at the head's right (DRAFT in Cloud) | every decision is listed; the list scrolls inside the row |
| "Missions · Not available" | same (DRAFT in Cloud: REAL words joined) | the sessions read failed |
| "Approve swap: 200 USDC → ETH" | the decision from desktop's approval sentence (`approvalSentence`), for example "Swap 200 USDC for ETH on Base"; for a mission, "Recover the mission", "Accept the contract" or "Fill in the form" | desktop builds the sentence from the signed arguments; missions wait on these three decisions too |
| "Mainnet, real funds · since 12:40" | same, or "expires {time} UTC" when the approval has an expiry; an approval raised in another chat than the one on screen leads with its chat, Chat “{title}” ("Untitled chat" with none) | VEX Cloud's built `consoleMetaOf`: a decision from elsewhere says where it waits |
| REVIEW | same | |
| "1 mission running on Mainnet · Grow ETH" | same form: "1 mission running on Mainnet · {title}", "2 missions running on Mainnet"; with none, "No mission running" (proposed) | the row stays so her box never moves (section 1.5); H3 draws no empty row |
| "2 strategies running" | left out | no strategies |
| strategy rows: name, pair, venue and timeframe, MAINNET, a switch | left out | no strategies |
| AI PERMISSION | same | |
| "Restricted access: always asks before acting." | "Restricted: every mutating transaction requires your approval." or "Full access: auto-executes approved tools without prompting per call." | desktop's own words for its two modes (`ComposerPermissionSeat.tsx`); Restricted does not ask before reading |
| "Change in Settings" | "Set when this chat was created." (proposed) | a chat's permission is set at creation and locked; Settings cannot change it |
| RECENT ACTIVITY | same | |
| (loading) covers; "Could not load this section."; "Vex has not acted yet." | same: two cover rows while the first read runs; "Could not load this section." beside the cross for a read that failed or timed out; "Vex has not acted yet." for an empty feed | Cloud's REAL words (`RecentActivity.tsx`, the console's failed section); they replace "Loading…", "Couldn't load activity.", "Activity is unavailable right now - try again shortly." and "No activity recorded yet - everything Vex executes appears here." |
| FILLED | Confirmed | desktop knows a transaction confirmed, not an order filled (`agent-scan-outcome.ts`) |
| RUNNING | Submitted, awaiting confirmation | desktop's pending word |
| DID NOT EXECUTE | Failed or Refunded, with the failed cross; Status unknown with the concerned hatch (section 2.2) | "did not execute" for a rejected approval needs the approval history, which activity does not join yet; nobody knows an unknown outcome, so it is never drawn as a failure |
| OPEN ACTIVITY | same; it opens Agent Scan | |
| the first-close hint: "Show Vex" and keycaps | same | |

### A.4 The welcome
| H3 | Desktop | Why |
|---|---|---|
| "Ready when you are." | same | |
| VEX CAN TRADE FOR YOU | same | Vex swaps, bridges and trades Lighter perps on desktop |
| EVERY ORDER IS CHECKED AGAINST YOUR PAUSES, LIMITS, AND THE POLICY | "Your keys stay on this computer." (proposed) | desktop has no spend limits and no global pause; its keys are local (`AGENTS.md`) |
| Check wallet balances / "What's in my wallet?" | same, and the line becomes the prompt Send seeds | true |
| Review the market / "What's moving in crypto today, and why?" | same, and the line becomes the prompt | true |
| Create a mission / "I want to set up a mission. Ask me for its goal, markets, capital and how long it runs." | Create a mission / "Start a mission: Vex drafts its contract and you accept it." (proposed) | on desktop the key opens the mission form rather than seeding a prompt |
| Analyze BTC 4h / "Analyze BTC/USDT on the 4h chart and create a strategy from it" | Analyze BTC 4h / "Analyze BTC/USDT on the 4h chart." | no strategies; the market name follows the analysis tool (S6a-04) |
| (none) | "Trade perps on Lighter", today's fourth suggestion | Open: it leaves the two-by-two grid for the nav's Lighter entry (default), or the grid grows |

### A.5 The composer and the status strip
| H3 | Desktop | Why |
|---|---|---|
| "Ask Vex..." | same, as the resting placeholder; desktop keeps its own placeholders for a mission, a running turn and the Lighter desk | |
| SEND | same | |
| (STOP, not drawn) | "Stop agent", "Stop mission", "Stop turn" | desktop's stop names what it stops |
| the image key | left out | no attachments |
| "DeepSeek V4.1 Flash 1017" and "HIGH" | the model's name from the catalogue and its effort | |
| FUNDS REQUIRE APPROVAL | same in Restricted; FULL ACCESS in Full access | |
| DAILY BUDGET, a meter and "38%" | CONTEXT, its meter and the real share ("Context 21%") | desktop has no daily budget; the context meter is real |

### A.6 Taglines
The tagline cell is Vex's line on her column's foot (VEX Cloud's `.moment`, the H3 mockup's app.css and js/data.js, 2026-11-05): a strip over the bars (Cloud's `--vx-strip`, oklch(6% 0.01 264) at 0.82; Cloud blurs what lies under it by 10px, desktop does not, since desktop never blurs), and on it the moment's line in one of two registers: CAPS, two tones, the first clause in ink and the second muted; or SAY, the narration in sentence case in ink 2. The line is a picture of what the Vex key's state word and the transcript say (Cloud's G14), so it is hidden from assistive tech, as Cloud's is.

| Moment | H3 (Cloud) | Desktop | Why |
|---|---|---|---|
| the welcome and an idle chat | AN AI TRADING AGENT, INSIDE YOUR LIMITS. (DRAFT in Cloud) | AN AI TRADING AGENT, ON YOUR COMPUTER. (proposed) | desktop has no spend limits to be inside; Cloud shows its line only at the welcome and leaves an idle chat to the bars, desktop keeps its rest line |
| a card waiting | CHECK THE CARD, THEN DECIDE. (DRAFT in Cloud) | same | |
| Vex works (Thinking, Working) | the narration: "Running Read balances to answer “…”" (Cloud's REAL templates) | the narration from real parts (`narration.ts`): the live word the turn island shows, the resolved tool title, the person's own last message, as "Running Swap to answer “…”", "Thinking to answer “…”"; the state word alone (Thinking, Working) where it has nothing true to add | the same templates; nothing invented |
| a settled turn | FILLED, APPROVED BY YOU. (3.4 s); NOT PLACED, OVER THE POLICY'S LIMIT PER ORDER. (4.0 s) (DRAFT in Cloud) | DONE. for 3.4 s, then the line empties and the bars show alone until the moment changes | desktop proves no fill, no approval and no refusal at the turn's end (nothing joins a turn to its activity), so its settled line is the state word alone; Cloud's 4.0 s refusal has no desktop moment |
| Studio | (none) | CODING AGENTS, ON YOUR COMPUTER. | our approved Studio plate (section 4.9) |

An error, a concern, sleep and the rest keep the rest line. The band's foot row under 1024 says the caps line of the moment (rest, card, Studio); Open: whether it also narrates, as Cloud's band line does.

### A.7 The chat and the money card
| H3 | Desktop | Why |
|---|---|---|
| THOUGHT FOR 2.8s, "5 steps" | same after a live turn; a turn reopened from history reads THOUGHT with no total, and "{n} steps" (VEX Cloud's EC-07 and its stored trace head; "Thought", "Thought for {s}" and "{n} steps" are Cloud DRAFT words); every other thinking row of a turn reads THOUGHT, and the live frame's writing scope "Thought · 1.2K tokens" | desktop does not store a turn's duration |
| the strip: the state square, CONFIRM THIS SWAP in 12 caps muted, "Expires in 14 min" (`role="timer"`, 12 caps muted tabular at 0.04em), MAINNET in 12 caps ink, 18 from the stamp (Cloud's `TakeoverStrip`, `TakeoverTimer`) | same: the square is the target while the card waits and the blinking square while a decision runs; the expiry counts down from the approval's own bound `expiresAt`: "Expires in N min" while an hour or less is left, "Expires in m:ss" for the last two minutes and in ink for the last one, "Expired" at zero; further out than an hour, the clock time ("Expires at 15:30 UTC"). The whole ISO instant stays in the signed fields | words and paint only: the engine's sweep owns the deadline, and the keys never read the countdown; a count of hundreds of minutes reads worse than a time |
| CONFIRM THIS SWAP | "Confirm this swap", "Confirm this bridge", "Confirm this transfer", "Confirm this order"; any other card, the tool's own title ("Lighter · Fees approve"), and "Confirm this action" only where no tool name is readable | desktop's card serves every tool family (`approvalActionWord`); a card outside them is named as Cloud names its generic card, by the tool's title (DG5-01) |
| MAINNET, REAL FUNDS | same | every desktop approval moves real funds |
| "Swap 200 USDC for ETH on Base." | desktop's sentence from the signed arguments; else "{tool title}: review the signed fields" | |
| "This places a real order on mainnet. It cannot be undone." | same for a swap or an order; "This sends real funds on mainnet. A transfer cannot be reversed." for a transfer; "This moves real funds between chains. It cannot be undone." for a bridge; set in 14 / 1.45 ink 2, 6 under the sentence (Cloud's `.vx-tk-warn`) | Cloud's own lines for the transfer and the bridge (the money gaps sheet's `realFundsCopy`) |
| FROM, "Your trading wallet on Base", "Available 1,240.55 USDC" | left out | the card has no source wallet or balance today |
| AMOUNT TO SWAP, an editable field, and "At most what you hold is sold..." | YOU SEND, as signed | the card shows the signed arguments; a new amount is a new proposal |
| QUOTED PRICE | left out | no separate quoted price |
| YOU RECEIVE, "Not available" | same, in muted (Cloud's `.vx-fr[data-na]`); a row's note ("on Base", "slippage limit 0.5%", the fee's percent) is its own line under the value, 11 muted, 3 above (`.vx-fr-note`) | |
| SLIPPAGE LIMIT | MINIMUM RECEIPT, with the slippage limit in its note | desktop's real line |
| FEES, "Vex fee 0.25% of the amount: about 0.5 USDC" | FEES, the Vex fee as the engine states it ("Vex fee 0.5 USDC (0.25%)"), on a swap and a bridge; on a transfer, FEES is the network fee and reads "Not available" | Cloud's rows (DG5-06): a transfer has no Vex fee, so its one fee row is the network fee |
| NETWORK FEE, "Not available" | same, on a swap and a bridge; no second row on a transfer | one unknown said once (DG5-06); the word is DRAFT in Cloud |
| TOTAL DEBIT, "Not available" | shown only when every part is known | desktop never shows a total it cannot add up |
| "up to 10,000 USD per order, 50,000 USD a day", "Change in Settings" | left out | no spend limits (F04 has not started) |
| ALL SIGNED FIELDS | same, drawn as Cloud's toggle (`SignedFields`): 36 high, 12 caps in ink 2, a muted 14 chevron that swaps its glyph and never turns; open, the fields have no fill, the names mono 12 muted in a column up to 200 and the values mono 13 in ink, ruled edge to edge. It still opens on mount when the card has no readable facts above it | desktop's open-by-default rule stays (Cloud closes it on every mount) |
| "Tell Vex what to do instead" | same, for the reason field, drawn as Cloud's instruction field (`CustomRow`): sans 16 / 1.45, wrapping and growing to 144 then scrolling, a row of at least 56 (40 on a short window) with 16 around the words, the ring on the whole row, and "{count} / 500" from 450 characters. It stays one line of text, as the old one-line field was: Enter and a pasted break add nothing, so the reason that travels with Reject is unchanged | the reason reaches Vex; desktop's cap is 500, not Cloud's 1,000 |
| REJECT | same; "Click again to confirm reject" when armed; while the reason holds words, REJECT AND SEND in the approve key's cell, with CLEAR in Reject's (section 4.3) | |
| the tick box, "I understand real funds can be lost" | left out | desktop keeps its two-step confirm |
| CTRL+ENTER APPROVES, ESC REJECTS | left out; the middle cell says "Two presses decide: the first arms the key for 4 s." on a card that needs two presses, and "Nothing signs until you approve." on one that does not (proposed) | no card shortcuts on desktop |
| APPROVE SWAP | "Approve swap", "Approve bridge", "Approve order", "Approve transfer", else "Approve"; Lighter's own words for a deposit and trading fees; "Click again to confirm approve" when armed | desktop's action words |
| a failure: one ink line over the band, one step lighter than the card, `role="alert"`, mounted empty from the start, padding 10, no mark (Cloud's DG5-28, `FooterAlert`) | same: the decision's own error, in ink, never red, right over the keys wherever they are drawn: over the card's footer, or inside the docked row between the reason field and the keys, never in the transcript behind a docked card; on the Needs you row, the row's foot. Empty, it takes no room | nothing was refused, so nothing is red; the keys are live again |
| the closed cards: "Rejected. Nothing was run.", "Expired. Nothing was run.", "Result uncertain"; "You chose to reject.", "You chose to approve."; "You rejected it, so nothing from this confirmation ran. Reload the chat to continue.", "This confirmation expired before it was answered.", "The result is uncertain. Check Activity before trying again."; RELOAD CHAT, DISMISS, OPEN ACTIVITY | the same titles and answers; "You rejected it, so nothing from this confirmation ran." without its second sentence; "The result is uncertain. Check Agent Scan before trying again."; DISMISS in place of RELOAD CHAT, OPEN AGENT SCAN in place of OPEN ACTIVITY (section 4.3) | desktop's chat goes on by itself after a rejection, so there is nothing to reload; Agent Scan is desktop's Activity (section 4.6); the answer and the "You rejected it" line only where the person decided on this card |
| "Approving…", "Rejecting…" (Cloud's keys while a decision runs) | same on every card, the working approve key led by Cloud's busy mark (the blinking 8 square in the key's ink, 14 from the word) and its words swapping at once, never a crossfade; a Lighter order create, deposit and trading-fee authorization keep their own steps ("Signing and sending", "Signing and depositing", "Authorizing", "Revoking") | the words only; the keys behave as before |

### A.8 The receipt, pages and the page strip
| H3 | Desktop | Why |
|---|---|---|
| SWAP · MAINNET, a time, FILLED | the kind and its chain ("Swap · Base"), MAINNET on the quiet hatch, the time, and desktop's outcome word (Confirmed) on Cloud's tag: the green fill, the solid square and the word, 24 high, padding 0 7, caps 11; the chain stays in the title line. The card is Cloud's result card (6f067702): the card ground, a head row of at least 44, the title in 18 / 1.3 with the place word in 15 ink 2, 16 over the rows; rows with names in mono 12 at 0.06em and values in mono 12 at 0.01em | Cloud's EC-10: a settled mainnet money card carries the quiet hatch and the word Mainnet, never the solid stamp |
| "USDC → ETH · Base (your trading wallet)" | the pair, the chain and the wallet's name from the activity entry; the arrow is Cloud's `RouteArrow`, a 14 glyph a screen reader reads as "to"; a quoted leg amount says "about 200 USDC", never "~" | |
| SELL, VALUE (USD), RECEIVED, VEX FEE | those the activity entry holds | |
| the transfer and bridge result cards (Cloud 6f067702: RECIPIENT, VALUE (USD), TRANSACTION; EXPECTED, RECEIVED, VALUE (USD), VEX FEE, DEPOSIT, "It arrives at your own trading wallet on {chain}.") | a receipt for a confirmed transfer (the amount as the title, VALUE (USD), the Vex fee only when recorded) and a confirmed bridge (the route as the title from the route ends' slugs, RECEIVED, VALUE (USD), VEX FEE), joined on the act's transaction: the entry's own hash, or for a bridge one of its legs' (its logical row is the destination fill); no recipient, no expected amount, no wallet line | the activity entry names no recipient, no quoted expectation and no wallet; the join on a bridge's source leg is unverified against live rows |
| a dollar estimate, "about $200.00" (Cloud's DG5-40) | same on the receipt, Portfolio's activity table and Agent Scan; it replaces "~$200.00 est." | the feed's dollar values are quote-time estimates, so they say "about" |
| APPROVAL, "Approved by you" | left out | approvals are not joined to activity yet |
| OVERVIEW, WALLET, "Updated 12:41" | the page's own tabs; "Updated {time}" | |
| PAPER, LIVE · MAINNET, REAL FUNDS | MAINNET on the quiet hatch | no paper mode; a page shows real money and decides none, so it takes Cloud's quiet mark (PD-05), not the solid stamp |
| "Real money on mainnet. Equity = the cash and open positions of your 2 running live strategies." | "Real money on mainnet. Total value of your {n} on-chain wallets · Lighter is shown separately." | no strategies; desktop's total is wallets, with Lighter apart |
| EQUITY, "of $25,000.00 allocated" | the wallet total; no "allocated" | nothing is allocated |
| TODAY, 7 DAYS, ALL TIME "trading P&L", "realized and open" | left out; the change since the last snapshot | no P&L history over these spans |
| DRAWDOWN "worst running strategy"; RUNNING "3 open positions" | left out | no strategies |
| EQUITY chart: 7 DAYS, 30 DAYS, 90 DAYS | 24 H, 7 D, 30 D | the balance snapshots reach these spans once their IPC exists (S7-05) |
| ALLOCATION, "62% in use", by venue | left out | no allocation |
| OPEN POSITIONS, "Marked at the live price. Stopping a strategy closes its positions at market." | OPEN POSITIONS for Lighter perps, without the strategy line | positions are real only for Lighter |
| MARKET, QUANTITY, ENTRY, COST, PRICE, OPEN PNL, STOP-LOSS, TARGET; CLOSE, STOP | Lighter's columns: Position, Size, Entry, Mark, Liq. price, Margin, uPnL | desktop's real position fields |
| the page strip: NEEDS YOU, the decision, the missions cell, the strategies cell, OPEN ACTIVITY | the same without the strategies cell | |

### A.9 Keys
| Key | H3 | Desktop |
|---|---|---|
| Ctrl+Shift+B; Cmd+Shift+B on macOS | opens and closes her section from anywhere; unbound on Linux in Cloud | the same on Windows, Linux and macOS (section 4.4) |
| Cmd or Ctrl+Shift+Period | (none) | still opens and closes her for one release, then goes |
| Esc | never closes her; on a card, the first clears a typed instruction and the next rejects | never closes her; never decides a card |
| Ctrl+Enter | approves the card | not bound |

Keycap spellings: CTRL, SHIFT, B on Windows and Linux; ⇧, ⌘, B on macOS (Apple's modifier order, as the tooltip's "⇧⌘B"). The first-close hint spells them in title case on Windows and Linux (Ctrl, Shift, B). Tooltips and accessible names use the key's name and the chord: "Show Vex (Ctrl+Shift+B)", "Hide Vex (⇧⌘B)".
