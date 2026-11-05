# H3: the desktop design

VEX Desktop's next look, H3, is a grid of square cells on a near-black ground: the chats column on the left, Vex's column in the middle, the chat on the right, one header row across all three and one bottom row under them. Vex's column holds the Vex key, her console and Kimm's section, the illustrated figure the person opens and closes. Opening or closing her section never moves a waiting money card.

This document is the desktop's contract for H3, in the shape of `R3-MINIMAL.md`. R3-MINIMAL stays the source of truth for a screen until the slice that restyles it lands; the last slice points R3-MINIMAL here. Once a slice lands, code comments cite this file as `docs/design/H3-DESKTOP.md section N`. Row IDs such as S1-03 are the feature rows of the revamp plan (`.context/revamp-ui-plan.md`, kept locally by the lead), one commit each.

The source is the VEX Cloud "v99 round 3" mockup sheet, app variant H3, dated 3 November 2026. Cloud builds the same design in `Jcaster99/Vex` (`apps/web`). No H3 branch was on that remote on 3 November 2026, so both apps start from the same mockup; wherever this document derives a number the mockup does not print, the number is reconciled with Cloud once Cloud's branch exists.

## Rules
- The ground is near black, and every surface is a square cell divided from its neighbours by 1px rules. Radius 0, no shadow, no blur, no glass. The only gradients are Kimm's blue ground and the selected nav row's fill.
- Labels are uppercase and tracked; sentences, names and values are in sentence case. Words are written in sentence case in code and uppercased by the label style, so a screen reader reads words, not letters.
- One saturated blue fills primary keys and nothing else. It is never type on the ground.
- A status is a small coloured square beside a light word. Green, red and grey are the only status colours; gains and losses in trading values take green and red type.
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
| bottom row | 0, 828, 1440 x 72 | measured: its top rule at y 827 to 828 |
| Kimm's section, open | 248, 264, 432 x 563 | printed |
| Kimm's section, closed (the strip) | 248, 264, 432 x 56 | printed: clip inset 507 of 563 |
| the swap card | 680, 249, 760 x 651 | printed |

Her section ends one pixel above the bottom row (264 + 563 = 827). The swap card's box runs to the window's foot: its decision row is the bottom row's chat cells (section 1.8).

### 1.2 The column rule and the tiers
The rule, derived on 3 November 2026 from the two printed card boxes and checked here against the proof plate's pixel counts:

- the chats column is a fixed 248;
- the Vex column is 30% of the window width, rounded to a whole pixel;
- the chat column takes the rest;
- under 1024 the band layout takes over (section 1.10).

Evidence:
- Printed boxes: at 1440 the card starts at 680 = 248 + 432, and 432 is 30% of 1440. At 2560 it starts at 1016 = 248 + 768, and 768 is 30% of 2560; its width 1544 is the rest.
- The proof plate's "Pixels" rows count the card's area at DPR 2 (four device pixels per CSS pixel). Each count is exactly four times the rule's chat width times a whole height: 1280 gives 1,645,920 = 4 x 648 x 635; 1366 gives 1,707,696 = 4 x 708 x 603; 1920 gives 3,112,640 = 4 x 1096 x 710; 1440 and 2560 give 4 x 760 x 651 and 4 x 1544 x 946, their printed boxes. At 1366, 30% is 409.8; a chat of exactly 708 means the Vex column rounds to 410 and the chat takes the whole remainder. The heights at 1280, 1366 and 1920 depend on window heights the plate does not print.

Open: Cloud's own breakpoints and widths, and whether Cloud's chat has a floor. Settled by desu's H3 branch.

| Window width | Chats | Vex | Chat | Note |
|---|---|---|---|---|
| 1000 to 1023 | 76 rail | a band | 924 to 947 | the band layout; desktop's minimum window is 1000 x 720 (`src/main/windows/bounds.ts`) |
| 1024 | 248 | 307 | 469 | no plate; the rule extended. Desktop starts the chats folded here: 76, 307, 641 (section 4.12) |
| 1180 | 248 | 354 | 578 | desktop folded: 76, 354, 750 |
| 1224 | 248 | 367 | 609 | the first run's window on a 1440px display (85% of the work area); desktop folded: 76, 367, 781 |
| 1280 | 248 | 384 | 648 | the stored default window, 1280 x 800 |
| 1366 | 248 | 410 | 708 | |
| 1440 | 248 | 432 | 760 | the 1440 captures |
| 1536 | 248 | 461 | 827 | |
| 1920 | 248 | 576 | 1096 | |
| 2560 | 248 | 768 | 1544 | printed |

What follows from the rule:
- The tracks are a function of the window width only: no drag, no hysteresis, nothing that reads her section's state. This is the first of the money rule's three legs (section 3.6). The solver is S2-01's (`lib/shell-columns.ts`).
- There is no chat floor. R3's `CENTER_MIN` of 640 goes: the H3 proof shows the card working at 1280 with one to three rows below the fold, and at 1024 the chat is 469, narrower than any plate. Open: whether the cells in the header and the bottom row fit between 1024 and 1279 (section 1.3), and whether Cloud moves the band seam above 1024. Settled in the harness at 1024 and 1280 and with Cloud.
- In a chat, the Vex column's width never depends on whether her section is open. On pages, closing her folds the column to a line (section 1.9).
- Open: what the sidebar key does at 1024 and up; it is drawn but never pressed. Presumed: it folds the chats column to the 76px rail and the chat takes the freed 172px. A fold the person asks for may move a card; her section never does. Desktop builds the presumption, and from 1024 to 1267 starts the chats folded (section 4.12).

### 1.3 The header row
76 high, one row of cells across the window. It is mounted once, because it hosts the app-wide approvals sync (`RunningHead.tsx`: preload allows one subscriber per event), and every cell that is not a control is a window drag region (`.vex-drag`).

Cells at 1440, measured from the rules in `h3-merged__welcome-closed-1440`:

| Cell | x, width | H3 draws | Desktop puts |
|---|---|---|---|
| logo | 0, 171 | the mark and "CLOUD" | the mark; on macOS it starts after the traffic lights (section 4.7) |
| sidebar key | 171, 77 | the panel icon | the same key: it folds the chats column to the rail |
| Vex key, portrait | 248, 76 | her mood still when closed; the fold glyph on a raised fill when open | the same (section 1.6) |
| Vex key, state | 324, 295 | the state square and word, a timer while live; then HIDE VEX or SHOW VEX and three keycaps | the same, with desktop's state words |
| Vex key, chevron | 619, 61 | down when closed, up when open | the same |
| chat title | 680, 398 | the chat's title, and "SAMPLE DATA" under it | the title, and under it the chat's kind and access ("Agent · Restricted") |
| network | 1078, 240 | MAINNET, the REAL FUNDS mark and a chevron: a network menu | MAINNET and the REAL FUNDS mark, with no chevron: a statement, not a menu |
| pause | 1318, 122 | PAUSE ALL | left out (no global pause); on Windows and Linux the caption buttons sit here (section 4.7) |

Text sits 24 in from a cell's left edge (the chat title at 704); the Vex key's state cell sets its text 20 in (at 344).

The three Vex key cells span the Vex column, so they narrow with it: at 1024 the state cell is 307 - 76 - 61 = 170 wide, and the chat column's 469 must hold the title, the network cell and, on Windows, the 138px caption reserve. Open: how these cells give way under 1280 (shorter words, the network word dropped for its mark, the chevron cell folded into the state cell). Settled in the harness (S2-07) and with Cloud.

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

### 1.5 The Vex column
Measured in the approval and welcome captures at 1440, top to bottom:

| Part | y, height | Contents |
|---|---|---|
| the Vex key | the header, 248 to 680 | section 1.6 |
| Needs you head | 76, 43 | NEEDS YOU, and the count at the right |
| Needs you row | 119, 64 | the decision as a sentence ("Approve swap: 200 USDC → ETH"), a meta line ("Mainnet, real funds · since 12:40") and a REVIEW key cell with a chevron (559 to 680, raised fill); at zero, "Nothing needs you." |
| missions row | 183, 40 | the missions icon, "1 mission running on Mainnet · Grow ETH", a chevron |
| strategies row | 223, 40 | "2 strategies running", a chevron. Not on desktop |
| Kimm's section | 264, 563 | a fixed box over the rest of the console |
| the console's rest | under her section | seen while she is closed: strategy rows (62 each, with a MAINNET tag and a switch), AI PERMISSION (a 44 head, then its sentence and "Change in Settings"), RECENT ACTIVITY (a 44 head, rows about 43 high, each with a status square and word), OPEN ACTIVITY with an arrow, ending at 826 |

**Her section, open:** her figure on a blue gradient behind the falling V, X and E glyph field. The HIDE VEX key, the words and a cross, is a solid 56-high cell in the section's top right corner, 542 to 680 (138 x 56, measured), on a dark translucent fill over her ground.

**Closed:** the section folds to its top 56, the strip, 264 to 320: the glyph field's frame at the left and the same key, now SHOW VEX with a down chevron, 531 to 680 (149 x 56, measured). The console's rest starts under the strip.

**The box.** Her section is a box laid over the column, not a row in it: left and width are the column's, its top is the foot of the console's top block, and its foot is one pixel above the bottom row. Its size is a function of the window only; open and closed differ only in its clip-path (section 3.2). Its height is the window height less 73 less its top.

**Desktop's box.** Desktop has no strategies row (section 4.1), so the console's top block is 40 shorter and her section starts at y 224, not 264. At 1440 x 900 the box is 248, 224, 432 x 603 and the strip is 248, 224, 432 x 56 (derived). Its height is 423 at a 720-high window, 503 at 800 and 603 at 900. The missions row stays when no mission runs, with its own words (Appendix A), so the box never moves when a mission starts or ends.

Open:
- What the Needs you row shows with two or more decisions; the plates draw one and none. Default: the one that expires first, the count in the head, Review opening its card, and the Needs you page for the rest. Settled with Cloud.
- How her figure fills a box of another size (anchor, scale, crop): desktop's box is 40 taller than the plate's, and the box narrows with the column. Settled by the mockup source and Kimm's files from the designer.

### 1.6 The Vex key and her moods
The Vex key is the header cell over the Vex column, in three parts:
- **Portrait cell, 76 x 76.** Closed, her face: one cell of a mood sprite (28.5 KB, `stills/key-moods.webp` on the mood plate), cropped so each mood reads at 76px, the mood still set at her eye line. Open, the fold glyph (an up chevron under a bar) on a raised fill: she has stepped down into her section.
- **State cell.** Line one: a small square (about 6px) and the state word, with a timer while live ("THINKING 0:03"). Line two: the action, HIDE VEX or SHOW VEX, then the keycaps of the shortcut.
- **Chevron cell.** Down while she is closed, up while she is open.

The key is one control. Its name is the action ("Show Vex", "Hide Vex"), and it opens and closes her section (section 3.3).

Her moods, printed on `landing-r3__plate-key-moods`. Both apps must use the same list:

| Mood | Drawn | H3 moment |
|---|---|---|
| hi | the V sign | the welcome (READY) |
| think | the hand at her mouth, with the running square | Vex works (THINKING) |
| offer | the open palm | waiting in the app (WAITING FOR APPROVAL) |
| offer, held | the open palm, dimmed | held for sign-in (Cloud only) |
| refused | the whole anger mark | budget used (Cloud only) |
| rest | resting | after the answer (DONE) |

Desktop has states H3 draws no mood for (Listening, Working, Concerned, Error, Sleeping, Waking up) and has neither Cloud's sign-in hold nor its budget. Open: their moods. S4-02 maps every desktop state to one of these moods; the designer's files may add moods.

### 1.7 The chat column
Header cells as in section 1.3. The transcript and the welcome sit 24 in from both edges (704 to 1416 at 1440).

**The welcome** (`h3-merged__welcome-*-1440`): a greeting bubble, "Ready when you are.", at 704, 104 on a raised fill; two notes under it, each a small square and a caps line; and, low in the column, a two-by-two grid of suggestion cells, 704 to 1416 by 536 to 762, each about 356 x 113 with an icon, a title, a muted line and an arrow.

**A chat:** the person's message is a raised bubble at the right beside their avatar disc. Vex's thinking is a framed row, "THOUGHT FOR 2.8s", with "5 steps" and a chevron at the right.

**The swap card** (`h3-merged__approval-*-1440`), printed at 680, 249, 760 x 651, with its top rule at 248. Top to bottom: the eyebrow row (CONFIRM THIS SWAP, then MAINNET, the REAL FUNDS stamp and a collapse chevron at the right), the sentence, the consequence line, field rows on a 34px pitch with their labels in mono caps, ALL SIGNED FIELDS, and the reason field, "Tell Vex what to do instead" (771 to 826). Its decision row is the bottom row (section 1.8). Which rows desktop shows is in section 4.1.

### 1.8 The bottom row
72 high, across the window, in a chat. Cells at 1440, measured in `h3-merged__welcome-closed-1440`:

| Cell | x, width | H3 draws | Desktop puts |
|---|---|---|---|
| account | 0, 248 | the avatar disc, "You", "Account and settings", a chevron | the same |
| tagline | 248, 432 | the moment's tagline (Appendix A) | the same, in desktop's words |
| model | 680, 75 | the model's glyph: the model choice | the same |
| field | 755, 471 | "Ask Vex..." | the same, running on to the send key |
| attach | 1226, 74 | an image key | left out: no attachments |
| send | 1302, 138 | blue: a three-by-three dot glyph and SEND | the same; STOP while a turn runs; held while the draft is blank (below) |

**The send cell** is H3's `.cmp-send`: 138 wide, padding 0 30 0 32, a 20px dots glyph and SEND in 13px caps; the dots are faint (white at 55%) at rest and white under the pointer. Measured at 140 from the captures before Cloud's CSS was read; the CSS is the source. **While the draft is blank, SEND is held** (Cloud's EC-04, `specs/v99-web/PLAN.md`; `h3-chat-gaps` decision 6): the cell fill, a muted word and the faint dots, no blue and no hover, because a blue key that does nothing is a trust regression. It turns blue the moment the draft has text. Which drafts can be sent is unchanged; only the look follows the key's disabled state. STOP keeps the blue while a turn runs; a stop being acknowledged is the same held look.

**The status strip** sits above the composer in the chat column, 31 high (797 to 827, measured): the model and its effort ("DeepSeek V4.1 Flash 1017 HIGH", 680 to 928), FUNDS REQUIRE APPROVAL (928 to 1139), an empty cell, and DAILY BUDGET with a ten-cell meter and a percentage (1186 to 1440). Desktop's strip is in section 4.1.

**While a card waits in the chat,** the composer and its strip give way to the card: the reason field takes the strip's place, the tagline says "CHECK THE CARD, THEN DECIDE.", and the bottom row's chat cells are the card's decision row:

| Cell | x, width | H3 draws |
|---|---|---|
| reject | 680, 168 | REJECT on a raised fill |
| middle | 848, 392 | a tick box, "I understand real funds can be lost" and "CTRL+ENTER APPROVES, ESC REJECTS" |
| approve | 1240, 200 | APPROVE SWAP, greyed until the box is ticked |

Desktop keeps its two-step confirm in this row (section 4.3).

### 1.9 Pages
From `h3-merged__portfolio-*-1440`.

- **Her section open:** the three columns stand. The page sits in the chat column from the header to the window's foot; there is no bottom row under a page, and the account cell stays at the chats column's foot. At the Vex column's foot is a segmented cell (828 to 900, about twenty segments, thirteen lit). Open: what it is; it looks like a load meter for her live model. Settled by the mockup source.
- **Her section closed:** the console folds to one line under the header (76 to 123, measured): NEEDS YOU and its count (248, 142), the decision or "Nothing needs you." (390, 290), the missions cell (680, 258), the strategies cell, and OPEN ACTIVITY with an arrow at the right edge (1277, 163). The page takes the whole width right of the chats, 248 to 1440.
- **The page frame:** a tabs row (about 57 high) with the tabs as cells (OVERVIEW selected on a raised fill, WALLET) and "Updated 12:41" at the right, then the page body, 24 in from each edge.

Open: whether a page's width change, when she closes on a page, slides or snaps. Default: it snaps when her close ends. Desktop's pages that can hold a money card keep the chat layout (section 4.10).

### 1.10 Under 1024: the band
H3 draws the band only on the phone and prints one box at 900. What is known:

- Printed: at 900 the card box is 76, 284, 824 x 516 (a 900 x 800 window). The chats fold to the 76 rail, and the chat runs from 76 to the right edge.
- Printed, in the proof plate's note: under 1024 the band rests for the whole turn, so a card's arrival and Approve change nothing.
- Measured on the phone (`h3-merged__phone-band-*-390`): the header is 59 high; the console line under it is 40, and its first cell carries her state and SHOW VEX or HIDE VEX; open, the band is her figure (230 high) and a 56-high foot row holding Vex's line and the HIDE VEX cell, and "the whole 56 tall row closes the band"; closed, there is no band, and the header's second cell shows her face with a chevron badge.

Desktop's default, derived for S2-08: the 76 header with the rail's cell (the mark), the Vex key, the chat title, the network cell and the caption reserve; the console line across the window right of the rail; her band under the console line while open; the chat under that.

Built in S2-08: the band is a row of the frame under the header, over the chat's track, 132 high at every desktop width (`H3_BAND_HEIGHT`): the Vex column's own parts laid in one row, its head (44) over her state and Needs you beside her portrait (88). Its height is a function of nothing, so a card under it never moves when a turn starts, waits or ends. The chats rail runs from the header to the foot beside it. A page shows no band (the strip, section 1.9).

Open: the band's heights at a desktop width; whether the band may stand open over a waiting card (the proof's narrow rows were read with "states closed"); the header cells at this width. Settled in the harness at 1000 x 720 and with Cloud.

---

## 2. Tokens and type

### 2.1 Colour
Two sources: the review sheet's own CSS tokens (the mockup page that frames the plates, drawn in the same language as the app screens) and what the app captures show. The sRGB values are converted from the sheet's OKLCH. Role names here are roles; S1-03 sets the names in `tokens.css`.

| Role | Sheet token and value | sRGB | App captures, measured | Desktop takes |
|---|---|---|---|---|
| ground | `--page` oklch(9% 0.012 264); `--panel` oklch(8.5% 0.008 264) | #020205; #010203 | #000002 to #020202 (OKLCH 7 to 8.5%) in every column, no readable hue | oklch(8.5% 0.008 264), #010203 |
| cell | `--cell` oklch(11% 0.006 264) | #040406 | #050407: the New chat cell, the composer's model cell, the greyed approve key | the sheet value |
| raised | `--raised` oklch(13% 0.004 264) | #070709 | #070709: the REVIEW and REJECT keys | the sheet value |
| card | none; Cloud's `--vx-card` oklch(10.5% 0.006 264) | #030405 | not drawn on the app plates | Cloud's value: menus, dialogs, the ground under a failure's red (section 5) |
| plate | none; Cloud's `--vx-tooltip` oklch(20% 0.004 264) | #151618 | not drawn on the app plates | Cloud's value: the toast and the tooltip, ink on it (section 5.1) |
| raised 2 | none | | #0B0D0F (OKLCH 15.5%): the open Vex key's fold cell; #0F1112 to #121416 (17.6 to 19%): the greeting bubble, the selected tab | #101214, oklch 18% |
| bubble | none | | #212325 (25.5%): the person's message bubble; #151718 (20%): their avatar disc | #212325 |
| selected row | none | | a gradient from #181A1C (21.6%) at the chats column's left edge to the ground at its right | as measured |
| ink | `--ink` oklch(97% 0.005 264) | #F3F5F9 | glyph peaks up to #FFFFFF | the sheet value |
| ink 2 | `--ink-2` oklch(80% 0.012 264) | #BABEC6 | "Nothing needs you." and Portfolio's lead line peak at #ABADAE, read as ink 2 | the sheet value |
| muted | `--muted` oklch(62% 0.02 264) | #808693 | group heads and times peak at #8B8D91 to #9C9E9D, at or a little above the sheet value | the sheet value |
| rule | `--rule` oklch(100% 0 0 / 0.07) | #131415 over the ground | #0E0E10 to #101211 | the sheet value |
| chosen rule | `--rule-chosen` oklch(100% 0 0 / 0.24) | #3E3F3F over the ground | #2F3133 above TOTAL DEBIT; #38373A on keycap borders | the sheet value |
| blue | `--blue` oklch(45.2% 0.313 264.1) | #0000FF | #0000FF: SEND, Portfolio's LIVE · MAINNET key | the sheet value |
| blue hover | `--blue-hover` oklch(56% 0.28 264) | #1557FF | not drawn | the sheet value |
| gain | `--live` oklch(78% 0.13 150) | #76CF8A | Portfolio's +$182.40 peaks at #88D09E | the sheet value, as type |
| loss | `--err` oklch(74% 0.17 27) | #FF7A6E | no loss is drawn as type | the sheet value, as type |
| status green | none | | #1B813F (a square), #1D7E3F (the FILLED stamp): about oklch(52% 0.13 150) | #1D7E3F |
| status red | none | | #C22226 (a square): about oklch(53% 0.19 27) | #C22226 |
| status grey | none | | #8F9190 (RUNNING in the chats list); #3B3D3D (RUNNING in recent activity) | muted |

Where the app screens differ from the sheet:
1. **The ground is closer to black.** It matches `--panel` (8.5%) better than `--page` (9%) and shows no blue tint at WebP's resolution; the two differ by one to three sRGB steps. Desktop's ground is #010203. The window's `backgroundColor` (`src/main/windows/main-window.ts`, today `#1b1412`) and the Windows caption overlay colour (`src/main/windows/chrome-options.ts`, today `#1B1412`) take the same value, since the theme-matrix test ties them to the ground (S1-06).
2. **There are raised steps above `--raised`.** The bubbles, the selected tab and the open fold cell use fills between 15 and 26% that the sheet has no token for. Desktop adds raised 2 and bubble as measured.
3. **Status fills are darker than `--live` and `--err`.** The sheet's green and red are type colours, which the app uses for gains and losses; the status squares and the FILLED stamp use a darker green and red.
4. **Two greys mark running.** Desktop uses muted for every running or pending square.

Open: the exact values of every "none" row and of the ground. Settled by the mockup source from the designer; the measured values stand until then.

### 2.2 Status
A status is a square of about 6px and a word in caps, 13, ink. (The words' glyph peaks, #CED0CF to #DDDFDE, are lighter than ink 2, so they are ink.)

| Status | Square | H3's word | Where H3 draws it |
|---|---|---|---|
| filled | status green | FILLED | recent activity; the receipt's stamp, a green fill with a white word |
| running | status grey | RUNNING | the chats list, recent activity |
| waiting | ink | WAITING | the chats list |
| did not execute | status red | DID NOT EXECUTE | recent activity |
| Vex's state | ink; an outline at Ready | READY, THINKING, WAITING FOR APPROVAL, DONE | the Vex key |

Desktop's true words for these are in Appendix A.

Gains and losses in trading values take the gain and loss colours as type (Portfolio's tiles and positions). This replaces R3's `trade-up` and `trade-down` pair and R3's rule that status is never a colour; S1-08 rewrites `status-contrast.test.ts` to this section.

The REAL FUNDS stamp in a card is an ink fill with ground-coloured caps (12) and a hatch glyph, about 105 x 23. In the header the same glyph and words stand without the fill.

Contrast on the ground (#010203), computed from the values above:

| Pair | Ratio |
|---|---|
| ink, ink 2, muted on the ground | 19.0, 11.1, 5.7 |
| gain, loss on the ground | 10.9, 8.2 |
| white on blue, on blue hover | 8.6, 5.5 |
| white on status green, on status red | 5.1, 5.9 |
| status green, status red squares on the ground | 4.1, 3.5 (marks beside a word: above the 3:1 for graphics) |
| blue on the ground | 2.4: blue is never type on the ground |

### 2.3 Type
- **Families.** Be Vietnam Pro, 400 and 600, for every word. Roboto Mono 400 with tabular figures for figures, balances, addresses, the money card's field labels and the receipt's labels. Both are bundled as local woff2 files with their licences (S1-01, S1-02). Instrument Sans and Instrument Serif retire. Studio's approved plate (section 4.9) moves the terminal onto Roboto Mono 13/20, with a bundled 700 for its bold text (2026-11-04); code elsewhere keeps `--font-code` (JetBrains Mono) until its own change.
- **Labels.** Caps with 0.08em tracking (the sheet's value; the measured widths were not checked against the font files). Labels are sans, except the money card's and the receipt's field labels, which are mono caps. Mono with caps, banned by R3's `shell-design-guard.test.ts`, is H3's style for those labels.
- **Weights,** read by eye: 600 for section heads (NEEDS YOU, CHATS, AI PERMISSION, RECENT ACTIVITY, Portfolio's EQUITY, ALLOCATION and OPEN POSITIONS), the tagline and Portfolio's equity figure; 400 for everything else.
- **Links** are ink with an underline ("Change in Settings"), never blue.

Sizes are measured from cap heights, taking Be Vietnam Pro's cap height as 0.70em and Roboto Mono's as 0.711em. One image pixel of cap height is 1.3px of size at this scale, so each size is plus or minus 1. The sheet's own labels run 12 to 13; the app's labels measure 11 to 14.

| Use | Face, size, weight | Captures |
|---|---|---|
| Portfolio's equity figure | sans 33, 600 | portfolio |
| Portfolio's tile figures | sans 24, 400; gains in the gain colour | portfolio |
| the card's sentence; the Needs you row's decision; the tagline | sans 20; the tagline 600 in caps, its second clause muted | approval, welcome |
| the greeting; the reason field | sans 18, 400 | welcome, approval |
| suggestion titles; the composer field; the person's message; the permission sentence | sans 16 to 17, 400 | welcome, approval |
| rows: chat rows, "Search chats", the chat title, "Nothing needs you.", activity rows, the card's consequence line, "You"; REVIEW and the page tabs; nav labels | sans 15 (nav labels 14 to 15), caps where they are keys or labels | welcome, approval, portfolio |
| the state word, MAINNET, PAUSE ALL, NEW CHAT, NEEDS YOU, SEND, REJECT, APPROVE SWAP, HIDE VEX on her section; the suggestions' lines, "Account and settings", card values ("Not available") | sans 14 | welcome, approval |
| HIDE VEX or SHOW VEX in the Vex key, CHATS, RECENT ACTIVITY, AI PERMISSION, the chats list's tags, status words, the status strip, CONFIRM THIS SWAP, the tick's key line, THOUGHT FOR, Portfolio's tile labels and table heads | sans 13, caps | welcome, approval, portfolio |
| the card's field labels (FROM, AMOUNT TO SWAP, QUOTED PRICE and the rest) | mono 13, caps | approval |
| group heads (TODAY), times in rows, the line under the chat title, the welcome's notes, OPEN ACTIVITY, keycap letters | sans 11 to 12, caps (times are figures) | welcome |
| a tag inside a row (MAINNET on a strategy row) | sans 10, caps | welcome |
| figures in rows and tables, balances, the amount field | mono 13 to 14, tabular | approval, portfolio |

**As built, where the builders' widths measured against the plates differ from the cap-height table** (harness at 1440x900, the bundled fonts):
- the Needs you row's decision sentence: sans 16, not 20; the bottom row's tagline: sans 14, 600 caps, not 20 (S3-04, S3-10);
- the chats list's RUNNING and WAITING tags: sans 12, not 13 (S5-06);
- "Account and settings": sans 13, not 14, so it fits its cell (S5-07).

Open: the sizes and tracking against the bundled fonts' metrics (S1-01, S1-02) and the mockup source. The left column's labels draw about 8% wider than H3's at `--tracking-label` 0.08em, which suggests H3 tracks tighter; the token is unchanged until the mockup source settles it.

### 2.4 Cells, rules and keys
- Every cell is bounded by 1px rules in the rule colour. The chosen rule marks a total (above TOTAL DEBIT) and draws keycaps.
- A cell's text sits 24 in from its left edge (section 1.3).
- **Primary key:** the blue fill with white caps, 14 (the card's decision key; SEND is 13, section 1.8). One blue cell in view at a time. Hover takes blue hover. A primary key that will not act is held, never blue (SEND on a blank draft, section 1.8).
- **Key cell:** the raised fill with ink caps (REVIEW, REJECT).
- **A control at rest** (New chat, the model cell) has the cell fill; **a disabled key** has the cell fill with muted words (APPROVE SWAP before the tick).
- **Her corner key** is a dark translucent fill over her ground, 56 high (section 1.5).
- **Keycaps:** 19 high, a 1px chosen-rule border, caps letters 11 to 12, 3 to 4 apart; CTRL about 40 wide, SHIFT about 42, B about 23 (measured). The first-close hint draws them larger and in title case ("Ctrl", "Shift", "B").
- **Focus:** a 2px white ring drawn inside the cell ("the 2px white ring inside the cell", `h3-merged__plate-controls`).
- **Switch** (strategy rows; not on desktop): 36 x 20, a 1px light border, the thumb a light square at the right when on.
- **Tick box** (the card's middle cell; not on desktop, section 4.3): 18 x 18, a 1px light border.
- **The receipt's stamp:** a status green fill with white caps (FILLED), about 60 x 24 on the phone capture.

These replace R3's tokens and its guard contracts: the 23 primitives and both themes in `theme-matrix.test.ts`, the sentence-case register in `micro-label-register.test.ts`, the mono-caps ban in `shell-design-guard.test.ts` and status by fill in `status-contrast.test.ts`. Each is rewritten as an H3 contract in the slice that changes what it guards.

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

**Opening:** the wipe grows from the strip's edge down to the foot line, behind a 1px scan head keyed to the same edge. The glyph field starts to run. Kimm drops 32px into place. The corner key says HIDE VEX from the press.

**Closing:** the wipe rises back to the strip's edge in 420ms. The field holds its frame in the strip. The key says SHOW VEX from the press. The console's rest stays inert until the close has ended.

Open, each settled by the mockup source:
- the drop's duration and curve (default: the push curve over the 720ms);
- whether her figure also fades in (an opacity change is allowed);
- the scan head's colour, and whether it also draws while closing (the close plate does not mention it).

### 3.3 The controls
One meaning everywhere: Hide Vex closes her section, Show Vex opens it, in the same place. Three controls carry it:
1. the Vex key in the header (section 1.6);
2. her corner key, HIDE VEX with a cross while she is open and SHOW VEX with a chevron in the strip while she is closed: the same key in the same corner;
3. Ctrl+Shift+B, Cmd+Shift+B on macOS, from anywhere (desktop's keys are in section 4.4).

- The words change at the press, not at the end of the motion.
- The way back is where the person pressed. After HIDE VEX is pressed, what is under the pointer from 0 to 600ms is Show Vex, and a second press there opens her again (printed at 1024, 1280, 1440 and 2560). The strip's key (531 to 680) covers the open key's box (542 to 680).
- A press acts at once: no confirm, no delay.
- Focused from the keyboard, each key shows the 2px white ring inside its cell.

### 3.4 While she moves
- Her section's body is inert while it moves: nothing in it takes a click or focus. The console's rest under her is inert while she is open and until a close has ended. The two keys stay live.
- **A press during the motion turns it around from where it is, without a jump.** Printed at 1440: Hide Vex, then Show Vex 80ms later, read over 13 frames. The control's name at the first press was Show Vex; the wipe's edge was at 408.1px at the second press and still at 408.1px on the next frame; it went no deeper after the press, ended open, and the card moved 0. Open: the reversed leg's duration. Default: the push curve from the current inset over the part of 720ms that is left.
- **Focus.** A press on a key keeps focus on that key; both keys stay where they are through the motion. Focus inside a part that becomes covered or folded moves to the Vex key in the header. (Desktop today moves it to the token chip, `VexSidebar.tsx`; the Vex key replaces the chip in S3-03.)

### 3.5 The rules
- **Vex never opens her section by herself.** Her cue (a card arriving, a turn ending) changes her mood and her words, never her section's state (printed in the proof's note).
- **Esc never closes her section.** Esc belongs to the money card; in H3 the first Esc clears a typed instruction and the next rejects. Desktop's card keys are in section 4.3. Esc in Lighter Zen closed the Vex overlay until S2-13 removed it (`AppShell.tsx`).
- **The first close teaches the way back, once.** For 2.4s the key's name and its keycaps ("Show Vex", Ctrl, Shift, B) stand under the Vex key, over Vex's column only. Cloud shows it once per browser; desktop shows it once per profile, behind a saved flag (S4-15).
- **The choice is remembered.** Cloud keeps it per browser; desktop keeps it in the persisted layout store, one choice for chats and pages, replacing "Show avatar" and R3's `vexOpenChat` and `vexOpenPages` slots, which migrate into it (S2-11, S4-14). Open: whether pages keep a choice of their own; the plates draw Portfolio both ways but print no rule.
- **First launch: open.** The sheet's drawn answer for computers.
- **The freed room in a chat goes to the console** (drawn): the chat keeps its width, and the console's rest shows under the strip.
- **Reduced motion and Save-Data** open and close her at once; the glyph field paints one still frame. The first-close hint still shows, without a fade.
- **Closed costs little.** Closed, only the key's mood sprite loads (the sheet: 415 KB closed against 15 MB open). Her large art loads when her section first opens (S4-05). The glyph field runs only while her section is open and on screen (S4-17).

### 3.6 The money card never moves
Opening or closing her section never moves, resizes or covers a waiting money card, on any frame. It holds because of three things, and needs all three:

1. **The chat column is a grid track whose width depends only on the window** (section 1.2). Nothing about her section enters the grid.
2. **Her section is a fixed box laid over Vex's column** (section 1.5). Open and closed differ only in its clip-path, so neither the column's content nor the grid reflows.
3. **Only clip-path, transform and opacity animate.** None of them changes layout.

Beyond that, Vex's cue never changes her section's state, and under 1024 the band rests for the whole turn, so a card's arrival and Approve change nothing either.

What the proof read (printed, `h3-merged__plate-proof`, in Chromium on the GPU at DPR 2): the seeked open and close, every 30ms from 0 to 720ms at 1440 x 900, 25 frames each; live presses at 1440 and 2560 on every painted frame; the card arriving with her open (50 frames) and closed (241 frames); the press's footprint at 1024, 1280, 1440 and 2560; a press during the motion; the narrow layouts at 390 and 900; and the card's pixels open against closed at 1280, 1366, 1440, 1920 and 2560. The card moved 0 in every row, and 0 of its pixels differed.

Desktop ports the proof as a CI test (S4-16, `e2e/h3-card-proof.spec.ts`): the card's box is read with her section open, closed and on every frame of both motions at 1280, 1366, 1440, 1920 and 2560, and the card's pixels open and closed are compared. Any change fails the build.

What desktop stops doing, because R3 does it and H3 forbids it:
- R3 animates the shell's `grid-template-columns` when Vex hides (`--vex-duration-reveal`, `AppShell.tsx`). In a chat, H3 never changes a track for her section.
- R3's hide waits for K2's close episode before the column goes (`features/vex/vex-hide.ts`). H3's close is the wipe itself, and the words change at the press.
- R3 closes Vex by itself under its medium tier when the left sidebar opens (`lib/shell-columns.ts`). H3 has no derived close.

### 3.7 What the motion policy needs
`MOTION-POLICY.md` allows a closed scale of durations (0, 100, 150, 240 and 300ms), three curves and no fourth, and bans `cubic-bezier(` outside the token sheets. H3 needs, in S1-12, with JS mirrors and the policy edit in the same commit:
- 720ms and 420ms, as her section's open and close, named in the policy's exception list;
- the push curve, cubic-bezier(0.22, 1, 0.36, 1), as a fourth curve, for her section;
- the glyph field's loop as a named exception beside K2's portrait, bound by the run gate and the still frame (S4-17);
- Save-Data on `html` as an attribute (S1-13), so the wipe collapses in CSS as well as in JS.

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
4. DAILY BUDGET. There is no daily budget; the status strip's CONTEXT meter takes its cell.
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
14. The thinking row: "Thought for N s" only after a live turn, since persisted turns store no duration; tool rows keep their measured times.
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

- Reject and the approve key sit in the bottom row's chat cells (section 1.8). Reject keeps the first focus.
- A high-risk card (risk level high or critical, or an action kind of `destructive` or `user_wallet_broadcast`, `ApprovalCard/risk.ts`) still takes two presses, for Approve and for Reject alike. The first press arms the key for 4 seconds (`CONFIRM_RESET_MS`, `ApprovalCard.tsx`) and its label reads "Click again to confirm approve" or "Click again to confirm reject"; the second decides. Any other card decides on one press.
- No tick box, no Ctrl+Enter, and Esc never decides a card.
- The middle cell holds the line for the card's gate (Appendix A.7) and no control.
- The approve key is the blue primary while it can be pressed. H3 never draws the enabled key; blue is presumed from SEND.
- R3's safety flow stays: REAL FUNDS on every card, Reject first, Lock Vex refused while signing, nothing signs until the person confirms.
- While a card waits in a chat, the composer gives way to the card, as H3 draws it: the reason field, "Tell Vex what to do instead", is the way to tell Vex something else, and it rejects with the reason, which reaches Vex. Open: whether desktop's composer stays usable under a waiting card, as it is today with its "Waiting for approval" tag. Default: H3's.

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
- Icons follow H3's nav icons (S5-04); desktop's three extra entries are drawn in the same grid and stroke.

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
| Needs you | the console's NEEDS YOU; no header control. The Lighter desk has no console until its restyle, so its title row keeps today's Needs you control until then (S2-06) |
| Notices, while notices exist | Open. Proposed: a cell in the chat header before the network cell, only while notices exist |
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

**Approved (owner, 2026-11-04), as drawn:** the harness plates `?plate=studio-project`, `studio-split` and `studio-band-files` (S8-01); `lighter-desk`, `lighter-desk-review`, `lighter-desk-two-step` and `lighter-zen` (S8-02); `stage-wake`, `stage-unlock`, `stage-unlock-locked`, `stage-system-check`, `stage-system-check-blocked`, `stage-wizard-password` and `stage-wizard-wallets` (S8-03). Where a plate's builder left a question open, the plate's own proposal is the answer unless the owner says otherwise. Two things are not part of that approval and stay as they are until the owner decides them separately, with a safety review:
- the desk's gate: an order create, close, cancel or modify is medium risk and decides on one press, as today; two presses stay for high-risk cards only (a deposit, a fee authorization, key registration, a withdrawal claim);
- a settle time before a freshly drawn approval key accepts a press (proposed after the desk plate showed Approve order drawn just above SHORT).

### 4.10 Other desktop rules
- **A page that can hold a money card keeps the chat layout.** On the Needs you page, closing her folds only her section, never the column, so a card there never moves. Cloud has no such page.
- Her open or closed choice and the first-close flag live in the persisted layout store, per profile, not per browser (section 3.5).
- First launch opens her. The sheet's question whether hiding her on the home page also hides her in the app does not apply to desktop.
- There is no phone layout. The window floor is 1000 x 720, and the band borrows from the phone only between 1000 and 1023 (section 1.10).
- One release carries the new look, with no flag.
- **Parity.** The same states are rendered on both apps at 1440 x 900 and 1280 x 800 (the welcome, a swap waiting and Portfolio, each with her open and closed) and compared side by side (`e2e/h3-parity.spec.ts`). The differences in this section are expected in those captures; any other difference is a defect on one side.

### 4.11 What Cloud and desktop must agree on
The column rule and tiers (section 1.2), the words of every element both apps show (Appendix A, where desktop says "same"), the keys (Appendix A.9, less desktop's old chord and its Linux binding), the timings and the push curve (section 3.1), the mood list (section 1.6) and the open-and-closed memory rule (section 3.5). These go to desu; Cloud's answers are recorded here when they come, and each "Open" line above that Cloud settles is rewritten then.

### 4.12 The chats column from 1024 to 1267
Decided on 3 November 2026, for S2-07: desktop keeps the chat at 640 or more wherever the window allows, by folding the chats column rather than bending the column rule (section 1.2), which stays as printed.

- From 1268 up the chats column is the person's stored choice: 248 open, the 76px rail folded. 1268 is the first width at which 248 + 30% + 640 fits (248 + 380 + 640); at 1267 the chat would be 639.
- From 1024 to 1267 the chats column starts folded to the 76px rail, so the chat keeps at least 640 (641 at 1024: 76 + 307 + 641; 811 at 1267). The sidebar key and the rail's Expand key still open it there. That opening is an unsaved override, as R3's narrow tier had (the store's `sidebarNarrowExpanded`): the chat then takes what the rule leaves (469 at 1024), and leaving the tier, past 1267 or under 1024, clears it, so the next entry starts folded again. The stored choice is never rewritten.
- Under 1024 the band (section 1.10) folds the chats whatever either says, and the rail has no Expand key there.
- Nothing about her section enters this: the Vex column is 30% of the window at every width, and the fold is only what the shell asks the solver (`h3ShellTier` and `H3_CHATS_OPEN_MIN` in `lib/shell-columns.ts`). A fold the person asks for may move a card (section 1.2); her section never does.
- Open: whether Cloud folds its chats under 1268 too. Settled with Cloud.

---

## 5. The kit

The primitives H3's app plates do not draw, taken from what VEX Cloud decided and built on `origin/rebranding-v99-ui` (the `h3-kit-gaps`, `h3-shell-gaps`, `h3-chat-gaps` and `h3-money-gaps` mockups, `contracts/keys.md`, `apps/web/src/styles/overlays.css` and `keys.css`, and Cloud's `HANDOFF.md`). The owner asked for desktop to take every change Cloud made here, however small. Where desktop keeps a rule of its own, the line says why.

### 5.1 The toast
- **One slot.** One floating cell, never a stack: the plate (`--color-h3-tooltip`, Cloud's `--vx-tooltip`, oklch 20%) in the chosen rule (24%), square, no shadow, at least 44 high, at most min(640, the window less 48) wide. Cloud's D2-16.
- **Anatomy.** The status column (44) first: the cross for a failure, the concerned hatch for a warning, the info glyph for information. Then the words, 14/1.45 in sentence case (a title, where the producer gives one, over the message in ink 2 at 13). Then each action as a key cell on the right edge: 13px caps, ink, padding 0 20, its left rule, never blue. Desktop keeps its dismiss key as the last cell (44, the cross glyph), because its notifications are dismissible and some are not.
- **A failure** is the refusal register: the red 16% over the card ground (`--vex-alias-refusal-tint` over `--color-h3-card`). Its words stay ink, where Cloud uses its refusal ink: a status word is ink on desktop (section 2.2).
- **Place.** 12 under the header, centred on the content column (the chat, a page or the desk), clamped 12 from the window's edges. Before the shell exists, 12 under the old 44 title row.
- **Never over a waiting card** (Cloud's DG-3 decision 16). A card's strip carries the network and REAL FUNDS, and on a short window it starts at the header's rule. When any `[data-vex-area="approval-card"]` would meet the toast's box, or come within 8 of its foot, the toast takes the header's message slot instead: the header's title cell, for its hold, on the header's ground with no plate of its own, the words 24 in at H3's `.hd-msg` (12/1.35), its keys as the cell's key cells. Words longer than the cell scroll inside it; the slot never grows onto the card. The seat is measured on show, on resize, on any scroll and whenever the document's tree changes, once a frame at most, and only while a toast is on screen (`toastSeat`, `components/ui/notification-toast.tsx`). The desk's Review order is a modal dialog, and a toast never paints while a modal holds the top layer: it waits in the center (unchanged). `e2e/h3-card-proof.spec.ts` proves both in a real browser at 1280 x 720 to 1920 x 1080.
- **Timings,** Cloud's: the hold is 3s, 6s for a toast with an action or whose words (title, message and action labels) reach 75 characters; then a 1000ms fade (Cloud's `toastFade`; Cloud's `HANDOFF.md` records the hold plus 1000ms as a deviation it keeps, against the drawn 300). The toast arrives in 620ms on the push curve, which has the control points of Cloud's caption curve, 8px down and in; reduced motion drops the arrival and keeps the fade. Hover or focus pauses the hold, and a sticky notification (progress still running, a failure with a working primary action) never fades, as before.
- **What waits** behind the slot is reported under the words ("+2 more in the notification center"), never dropped: the queue, the center and the announcer are unchanged. An urgent notification still passes the slot and stands under it; nothing raises one yet.

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

---

## Appendix A. Words, keys and taglines

Every word the H3 app screens show, and the word desktop shows in its place. "Same" means desktop uses H3's word. "Left out" means desktop has no real source for it. Where H3's word would be false on desktop, the desktop column gives a true one and the last column says why. Words are written in sentence case in code and shown in caps where the label style applies (section 2.3). Sample values on the captures (chat titles, figures, "Grow ETH") are not words and are not listed. Proposals marked "proposed" are for the row that builds the screen to confirm.

### A.1 Header
| H3 | Desktop | Why |
|---|---|---|
| CLOUD, beside the mark | the mark alone | desktop is not Cloud. Open: a word beside the mark, if the owner wants one |
| READY, THINKING 0:03, WAITING FOR APPROVAL, DONE | Ready, Listening, Thinking, Working, Waiting for approval, Done, Concerned, Error, Sleeping, Waking up (`features/vex/vex-state.ts`), with the timer while Thinking or Working | desktop's state machine has ten states |
| HIDE VEX, SHOW VEX | same | |
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

### A.3 The console
| H3 | Desktop | Why |
|---|---|---|
| NEEDS YOU and a count | same | |
| "Nothing needs you." | same | |
| "Approve swap: 200 USDC → ETH" | the decision from desktop's approval sentence (`approvalSentence`), for example "Swap 200 USDC for ETH on Base"; for a mission, "Recover the mission", "Accept the contract" or "Fill in the form" | desktop builds the sentence from the signed arguments; missions wait on these three decisions too |
| "Mainnet, real funds · since 12:40" | same, or "expires {time} UTC" when the approval has an expiry | |
| REVIEW | same | |
| "1 mission running on Mainnet · Grow ETH" | same form: "1 mission running on Mainnet · {title}", "2 missions running on Mainnet"; with none, "No mission running" (proposed) | the row stays so her box never moves (section 1.5); H3 draws no empty row |
| "2 strategies running" | left out | no strategies |
| strategy rows: name, pair, venue and timeframe, MAINNET, a switch | left out | no strategies |
| AI PERMISSION | same | |
| "Restricted access: always asks before acting." | "Restricted: every mutating transaction requires your approval." or "Full access: auto-executes approved tools without prompting per call." | desktop's own words for its two modes (`ComposerPermissionSeat.tsx`); Restricted does not ask before reading |
| "Change in Settings" | "Set when this chat was created." (proposed) | a chat's permission is set at creation and locked; Settings cannot change it |
| RECENT ACTIVITY | same | |
| FILLED | Confirmed | desktop knows a transaction confirmed, not an order filled (`agent-scan-outcome.ts`) |
| RUNNING | Submitted, awaiting confirmation | desktop's pending word |
| DID NOT EXECUTE | Failed, Refunded or Status unknown, as the entry says | "did not execute" for a rejected approval needs the approval history, which activity does not join yet |
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
The tagline cell says the moment. H3 draws two.

| Moment | H3 | Desktop | Why |
|---|---|---|---|
| the welcome and an idle chat | AN AI TRADING AGENT, INSIDE YOUR LIMITS. | AN AI TRADING AGENT, ON YOUR COMPUTER. (proposed) | desktop has no spend limits to be inside |
| a card waiting | CHECK THE CARD, THEN DECIDE. | same | |

The second clause of each is muted. Open: the taglines for the other moments (thinking, done, an error); default, the first line. Settled by the mockup source or the owner.

### A.7 The chat and the money card
| H3 | Desktop | Why |
|---|---|---|
| THOUGHT FOR 2.8s, "5 steps" | same after a live turn; a turn reopened from history shows "{n} steps" only | desktop does not store a turn's duration |
| CONFIRM THIS SWAP | "Confirm this swap", "Confirm this bridge", "Confirm this transfer", "Confirm this order", else "Confirm this action" | desktop's card serves every tool family (`approvalActionWord`) |
| MAINNET, REAL FUNDS | same | every desktop approval moves real funds |
| "Swap 200 USDC for ETH on Base." | desktop's sentence from the signed arguments; else "{tool title}: review the signed fields" | |
| "This places a real order on mainnet. It cannot be undone." | same for a swap or an order; "This sends real funds on mainnet. It cannot be undone." for a transfer or a bridge (proposed) | |
| FROM, "Your trading wallet on Base", "Available 1,240.55 USDC" | left out | the card has no source wallet or balance today |
| AMOUNT TO SWAP, an editable field, and "At most what you hold is sold..." | YOU SEND, as signed | the card shows the signed arguments; a new amount is a new proposal |
| QUOTED PRICE | left out | no separate quoted price |
| YOU RECEIVE, "Not available" | same | |
| SLIPPAGE LIMIT | MINIMUM RECEIPT, with the slippage limit in its note | desktop's real line |
| FEES, "Vex fee 0.25% of the amount: about 0.5 USDC" | FEES, the Vex fee as the engine states it | |
| NETWORK FEE, "Not available" | same | |
| TOTAL DEBIT, "Not available" | shown only when every part is known | desktop never shows a total it cannot add up |
| "up to 10,000 USD per order, 50,000 USD a day", "Change in Settings" | left out | no spend limits (F04 has not started) |
| ALL SIGNED FIELDS | same | |
| "Tell Vex what to do instead" | same, for the reason field | the reason reaches Vex |
| REJECT | same; "Click again to confirm reject" when armed | |
| the tick box, "I understand real funds can be lost" | left out | desktop keeps its two-step confirm |
| CTRL+ENTER APPROVES, ESC REJECTS | left out; the middle cell says "Two presses decide: the first arms the key for 4 s." on a card that needs two presses, and "Nothing signs until you approve." on one that does not (proposed) | no card shortcuts on desktop |
| APPROVE SWAP | "Approve swap", "Approve bridge", "Approve order", "Approve transfer", else "Approve"; Lighter's own words for a deposit and trading fees; "Click again to confirm approve" when armed | desktop's action words |

### A.8 The receipt, pages and the page strip
| H3 | Desktop | Why |
|---|---|---|
| SWAP · MAINNET, a time, FILLED | the kind, MAINNET, the time, and desktop's outcome word (Confirmed) | |
| "USDC → ETH · Base (your trading wallet)" | the pair, the chain and the wallet's name from the activity entry | |
| SELL, VALUE (USD), RECEIVED, VEX FEE | those the activity entry holds | |
| APPROVAL, "Approved by you" | left out | approvals are not joined to activity yet |
| OVERVIEW, WALLET, "Updated 12:41" | the page's own tabs; "Updated {time}" | |
| PAPER, LIVE · MAINNET, REAL FUNDS | the REAL FUNDS stamp alone | no paper mode |
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
