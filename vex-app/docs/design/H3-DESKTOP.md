# H3: the desktop design

VEX Desktop's next look, H3, is a grid of square cells on a near-black ground: the chats column on the left, Vex's column in the middle, the chat on the right, one header row across all three and one bottom row under them. Vex's column holds the Vex key, her console and Kimm's section, the illustrated figure the person opens and closes. Opening or closing her section never moves a waiting money card.

This document is the desktop's contract for H3, in the shape of `R3-MINIMAL.md`. R3-MINIMAL stays the source of truth for a screen until the slice that restyles it lands (the revamp plan's build order); the last slice points R3-MINIMAL here. Once a slice lands, code comments cite this file as `docs/design/H3-DESKTOP.md section N`.

The source is the VEX Cloud "v99 round 3" mockup sheet, app variant H3, dated 3 November 2026. Cloud builds the same design in `Jcaster99/Vex` (`apps/web`). No H3 branch was on that remote on 3 November 2026, so both apps start from the same mockup; wherever this document derives a number the mockup does not print, the number is reconciled with Cloud once Cloud's branch exists.

## Rules
- The ground is near black, and every surface is a square cell divided from its neighbours by 1px rules. Radius 0, no shadow, no blur, no glass. The only gradients are Kimm's blue ground and the selected nav row's fill.
- Labels are uppercase and tracked; sentences, names and values are in sentence case. Words are written in sentence case in code and uppercased by the label style, so a screen reader reads words, not letters.
- One saturated blue fills primary keys and nothing else. It is never type on the ground.
- A status is a small coloured square beside a light word. Green, red and grey are the only status colours; gains and losses in trading values take green and red type.
- Be Vietnam Pro for words, Roboto Mono for figures and for the money card's field labels.
- Opening or closing Kimm's section never moves, resizes or covers a waiting money card (section 3).
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
| 1024 | 248 | 307 | 469 | no plate; the rule extended |
| 1180 | 248 | 354 | 578 | |
| 1224 | 248 | 367 | 609 | the first run's window on a 1440px display (85% of the work area) |
| 1280 | 248 | 384 | 648 | the stored default window, 1280 x 800 |
| 1366 | 248 | 410 | 708 | |
| 1440 | 248 | 432 | 760 | the 1440 captures |
| 1536 | 248 | 461 | 827 | |
| 1920 | 248 | 576 | 1096 | |
| 2560 | 248 | 768 | 1544 | printed |

What follows from the rule:
- The tracks are a function of the window width only: no drag, no hysteresis, nothing that reads her section's state. This is the first half of the money rule (section 3.6). The solver is S2-01's (`lib/shell-columns.ts`).
- There is no chat floor. R3's `CENTER_MIN` of 640 goes: the H3 proof shows the card working at 1280 with one to three rows below the fold, and at 1024 the chat is 469, narrower than any plate. Open: whether the cells in the header and the bottom row fit between 1024 and 1279 (section 1.3), and whether Cloud moves the band seam above 1024. Settled in the harness at 1024 and 1280 and with Cloud.
- In a chat, the Vex column's width never depends on whether her section is open. On pages, closing her folds the column to a line (section 1.9).
- Open: what the sidebar key does at 1024 and up; it is drawn but never pressed. Presumed: it folds the chats column to the 76px rail and the chat takes the freed 172px. A fold the person asks for may move a card; her section never does.

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
| send | 1300, 140 | blue: a three-by-three dot glyph and SEND | the same; STOP while a turn runs |

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

Open: the band's heights at a desktop width; whether the band may stand open over a waiting card (the proof's narrow rows were read with "states closed"); the header cells at this width. Settled in the harness at 1000 x 720 and with Cloud.
