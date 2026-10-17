# Board tile measurement matrix (R3 Minimal)

This document is the derivation behind `global-css/board-layout.css` and
`boardCardValueBudget.ts`. It describes the R3 Minimal tile
(`docs/design/R3-MINIMAL.md` section 9.4). **The V10 card numbers (the 502px
wide floor, the 358px compact floor, the two modes, the sparkline slots and
the 16px gap ladder) are SUPERSEDED**; they are kept in short form in section
8 so a reader of an old commit can follow the history.

## 0. How these numbers were obtained, and what to trust

The advances below are COMPUTED from the shipped font files, not read off a
rendered page: `public/fonts/instrument-sans-latin-var.woff2` and
`jetbrains-mono-latin-wght.woff2`, converted to TTF with fontTools and shaped
with FreeType and Raqm (GPOS kerning applied) at the tile's sizes, with the
variable weight axis set to the weight the tile paints. JetBrains Mono advances
0.6em at every weight, so a mono figure is `0.6 x size` plus the tracking
(`.vex-num` is -.01em; the price is -.03em). They agree with a browser to
within about a pixel, and every floor below keeps the rounding on the safe
side (it is a `ceil`).

The Chromium harness (`src/renderer/dev/board-layout/`, driven by
`e2e/board-layout.spec.ts`) is the ARBITER. It re-measures the natural width
of each region in a real engine, and if it disagrees with this document the
harness is right and this document and the CSS move together.

Units are CSS pixels. A tile is `box-sizing: border-box`: padding 16 18 14, a
1px quiet rule on its right and bottom edge. The grid carries a 1px quiet rule
on its top and left edge and has no gap. So a tile's inner width is
`card - 36 - 1`.

## 1. Realistic output

The same six pools as before (a five-figure price, a sub-cent price with eight
leading zeros, hundreds-of-thousands and tens-of-millions liquidity, a billions
volume, six-digit trade tallies, ages from five minutes to three years), plus
the widest ticker line a real board can print.

| Region | data-vex-area | Type | Widest realistic | Producing value |
| --- | --- | --- | --- | --- |
| Token name | `board-token-name` | sans 15 / 600 | 140 | Aerodrome Finance (ellipsis allowed) |
| Ticker line | `board-token-meta` | sans 12.5 | 120 | `BITCOIN` + ` · ` + `Robinhood` = 119.04 |
| Price | `board-token-price` | mono 26 / 500, -.03em | 177.84 | `$0.000001230`, 12 x 14.82 |
| Signed delta | `board-token-delta` | mono 13, -.01em | 61.36 | `+661.00%`, 8 x 7.67 |
| Delta window | `board-token-delta-window` | sans 12 | 20.51 | `24h` |
| Stat label | `dt` | sans 11.5 | 62.85 | `24h Volume` (widest label) |
| Stat label | `dt` | sans 11.5 | 45.81 / 35.28 / 42.31 | `Liquidity` / `Trades` / `Pair age` |
| Stat value | `dd` | mono 13, -.01em | 61.36 | `$1234.5B` (8 characters); `$998.8K` is 53.69 |
| Token photo | `board-token-photo` | box | 34 | fixed, 1px rule inside the 34 |
| Disclosure key | `board-token-full-value` | box | 26 | fixed |
| Spotlight chip | `board-card-spotlight` | sans 12.5 + 2 x 9 + 2 | 73 / 74 pressed | `Spotlight` 52.70 / 53.81 at 500 |
| DexScreener link | `board-token-dexscreener-link` | sans 13 / 500 + 5 + 14 | 97.63 | `DexScreener` 78.63 + glyph |
| Ask Vex link | `board-card-ask` | sans 13 / 500 + 14 + 5 | 67.02 | `Ask Vex` 48.02 + glyph |

## 2. Every safety chip label

The chip is the kit's compact chip painted as a swatch plus the word in 12.5
muted: a 10px swatch, a 6px gap, the word in sans 12.5 regular. The labels are
the frozen table in `src/shared/board/safety-classifier.ts` plus
`BOARD_NEW_PAIR_LABEL`. All of them are reachable in normal service, so none of
them is an "extreme".

| Label | Word | With swatch |
| --- | --- | --- |
| `Checks unavailable in this response` | 201.93 | 217.93 |
| `Not indexed by the checks provider` | 201.01 | 217.01 |
| `Checks describe another token` | 178.03 | 194.03 |
| `Checks out of date` | 107.05 | 123.05 |
| `Sources disagree` | 98.30 | 114.30 |
| `Partial checks` | 79.45 | 95.45 |
| `Clean checks` | 76.19 | 92.19 |
| `Unverified` | 59.14 | 75.14 |
| `Checking` | 55.16 | 71.16 |
| `New pair` | 50.17 | 66.17 |
| `High risk` | 49.91 | 65.91 |

**218 is the number the footer has to survive.** It is not a schema extreme: a
transport blip on the details channel produces it on every tile at once. It
fits a row of the 282px floor with 64px to spare, so the checks word is ALWAYS
a row of its own and never wraps.

## 3. Schema-reachable extremes

`BOARD_DECIMAL_MAX_CHARS = 40` and `BOARD_TOKEN_LABEL_MAX_CHARS = 512`
(`src/lib/board/spec.ts`). A 40-character decimal renders as a 38-character
price; a 512-character symbol renders as a 512-character ticker. Neither fits
any tile at any width the page can reach, which is what the full-value
disclosure and the budgets of section 7 exist for: the cut becomes reported and
recoverable rather than silent.

## 4. The tile floor, derived

Three constraints each ask for an inner width; the widest is the floor.

| Constraint | Composition | Inner |
| --- | --- | --- |
| Price row | `177.84 + 10 + 61.36 + 10 + 20.51 = 279.71` | 280 |
| Four stats in a row | `4 x 63 + 3 x 6 gap` (the widest label, `24h Volume`, is 62.85) | 270 |
| Header | `34 photo + 11 + 120 identity + 11 + (26 key + 6 + 74 chip)` | **282** |
| Checks word | `201.93 + 6 + 10` | 218 |
| Links row | `97.63 + 12 + 67.02` | 176.65 |

The header binds: **inner floor 282.** The tile adds 36 of padding and 1 of
right rule: **tile floor 319px.** The four stats always fit one row at the
floor (270 of 282), so the V10 2x2 fallback and the wide and compact modes are
retired along with `--vex-board-mode`. The identity column at the floor is
`282 - 162 = 120`; the widest realistic ticker line (`BITCOIN` and `Robinhood`)
is 119.04 and fits whole, and a wider pair concedes in the chain name, which
ellipsizes and is whole in its `title` and in the disclosure.

Fixed heights come from fixed line heights, not from a measurement of content:
header 34 (name 18 + ticker line 16 = the photo's 34), price row 32 with a
margin of 14 above and 12 below, stats `1 + 9 + 16 + 18 = 44`, footer
`12 + 20 + 8 + 18 = 58`, padding `16 + 14`, bottom rule 1. That is about 225px a
tile, computed from the line heights; the harness confirms it. Every tile of a
row is the same box (`h-full w-full`), the name is one line, and the footer is
pinned with `margin-top: auto`.

## 5. The column ladder

`C` is the plate's content box, which is what `container-type: inline-size`
measures; the plate draws no border and no padding, so it is the grid's width.
The grid's own 1px left rule is taken once, so with `n` columns
`card = (C - 1) / n`. The rule, in one sentence: **take the most columns (at
most 3) whose tile clears 319.**

| Threshold | Derivation | Result |
| --- | --- | --- |
| `C >= 958` | `3 x 319 + 1` | 3 columns |
| `C >= 639` | `2 x 319 + 1` | 2 columns |
| `C >= 320` | `319 + 1` | 1 column |
| `C < 320` | UNDERSIZED | 1 column pinned at 320, the plate side-scrolls |

The track is `minmax(319px, 1fr)` in one column and `minmax(0, 1fr)` in two and
three; `min-width: 320px` on the grid keeps its top rule as wide as the pinned
track. Nothing transitions, and nothing reads layout back.

### What the ladder produces at real widths

`C = window - 264 (left sidebar, --vex-left-w) - 56 (page padding)`, less 256
when the Vex sidebar is open (`--vex-vex-w`). At the narrower left column
(224) `C` is 40 wider.

| Window | Vex | C | Columns | Tile |
| --- | --- | --- | --- | --- |
| 1920 | hidden | 1600 | 3 | 533 |
| 1440 | hidden | 1120 | 3 | 373 |
| 1366 | hidden | 1046 | 3 | 348 |
| 1280 | hidden | 960 | 3 | 319.67 |
| 1920 | open | 1344 | 3 | 447 |
| 1440 | open | 864 | 2 | 431.5 |
| 1366 | open | 790 | 2 | 394.5 |
| 1280 | open | 704 | 2 | 351.5 |

Three columns hold at 1440 with the Vex sidebar hidden and two with it open,
which were the requirements. The centre column never goes under the app's
640, so `C` is at least 584 and the pinned regime is a floor the app does not
reach in normal use; it is kept so a narrow constrained container (a future
panel, the harness) side-scrolls instead of cutting a figure.

## 6. The full-value disclosure

A schema extreme cannot be made to fit and must not be cut in silence, so
every tile carries ONE always-present control in its header - a semantic
`<button>`, drawn as a 26 x 26 key with the line info glyph, next to the
Spotlight chip - that opens the whole name, the whole ticker, the whole chain
name and the raw provider decimals for price, 24h change, liquidity and
volume.

Its PRESENCE is **not** conditional on width, because a card always rounds
something: `formatBoardPriceUsd` truncates every price by design, so the
recovery path is owed to every card at every width.

What IS conditional is what it SAYS. A control that reads "Show the full
values" on a card whose price has had its tail removed tells the reader a
panel exists and does not tell them the figure in front of them is not the
figure. So when the card printed a shortened copy of a value, the button
names the cut state in its accessible name, wears the blue edge and the blue glyph the
board uses for "this needs your attention", and repeats the statement
visibly at the top of the panel. That is what turns a cut into a REPORTED
bound.

It also retires hover as a recovery path. `title` stays on the token name for
the pointer, but the name's ellipsis now has a real, keyboard-reachable way
back to the whole string.

It is a DISCLOSURE, not a dialog. It carried `role="dialog"` with
`aria-modal="true"` and a focus trap, and none of that was true: nothing
outside the panel was inert, a pointer reached every other card on the board
while it was open, and two of them could be "modal" at once. `aria-modal`
promises a reader that the rest of the page is unavailable, so a screen-reader
user was told the board was gone while a sighted user was clicking it. A
promise the code does not keep is worse than no promise.

What it is instead: a button carrying `aria-expanded` and `aria-controls`, and
a labelled `role="group"` it points at. Consequences, each of them tested
rather than assumed:

- no focus trap, because a non-modal surface must not trap - Tab runs through
  the panel and ONWARD, out of the card entirely;
- MANY MAY BE OPEN AT ONCE, which is legitimate for a disclosure and is how a
  reader compares two pools' raw decimals side by side;
- the rest of the board stays live to a pointer, including another card's
  Spotlight.

**The covered controls leave the TAB ORDER, and only the tab order.** The
panel is opaque and covers its whole card, so while it is open the Spotlight
button, the DexScreener link, Ask VEX and the trigger itself cannot be seen -
and a Tab that reached one of them would put focus somewhere invisible, which
rule 08 forbids. Each of them therefore carries `tabIndex="-1"` for exactly as
long as the panel is open, so tabbing out of the panel leaves the card rather
than landing behind it.

`tabIndex="-1"` and NOT `inert`, deliberately. `inert` removes a subtree from
the ACCESSIBILITY TREE, which would take the trigger's own
`aria-expanded="true"` with it: the panel would be open with nothing able to
report that it was, and the Escape restore could not focus the trigger either.
`tabIndex="-1"` removes an element from the tab order alone - it keeps its
accessible name and state, and it can still be focused programmatically. The
attributes revert in the same commit that removes the panel, so a card nothing
covers carries none of them. `TokenCardV3` owns the flag, which is why the
disclosure's open state is controlled by the card rather than private to the
disclosure: a component in the header cannot reach the footer's buttons.

Focus still moves into the panel on open and returns to the trigger on close.
That is not a modal obligation but this panel's own: it paints over the card
it belongs to, so focus left behind it would be operating an invisible
control. Escape closes it and is stopped from propagating, so closing a panel
never closes the board `<dialog>` listening for the same key.

Its cost to the floor is the 26px key and the 6px gap before the Spotlight
chip, both inside the header sum of section 4 (the header is the constraint
that binds the floor). The chain name is in the panel for a reason of its own:
it is a word on the ticker line, it concedes width there with an ellipsis, and
nothing the tile may cut is recoverable by hover alone.


## 7. The content budgets

The floor above is sized against the widest REALISTIC output. The schema
permits far more, and such a value used to be rendered whole into a
`whitespace-nowrap` cell inside an `overflow-hidden` tile: the reader got a
figure with its tail removed and nothing saying so.

`boardCardValueBudget.ts` owns the fix. Each budget is a number of SLOTS, and
each is derived from the region's own column at the floor:

| Region | Budget | Where it comes from |
| --- | --- | --- |
| Price | 12 | `$0.000001230`, 177.84px: the string the 280px price row was derived from |
| Signed delta | 8 | `+661.00%`, 61.36px |
| Stat value | 8 | the four-column row leaves `(282 - 3 x 6) / 4 = 66px`; `8 x 7.67 = 61.4px` fits, nine (69px) would not |
| Ticker | 10 | the identity column is 120px; ten slots of 9.1px are at most 91px, leaving 29px for the separator and the chain |
| Token name | none | keeps its CSS ellipsis by product decision; whole in the `title`, the card's accessible name and the disclosure |
| Chain name | none | a short catalogue name; concedes to the ticker with an ellipsis, whole in the `title` and the disclosure |

`boardCardValueBudget.test.ts` carries this arithmetic (the last describe), so
raising a budget past its column fails a test instead of cutting a figure.

**TWO SURFACES, TWO WIDTH MODELS.** The price, delta and stat values render in
JetBrains Mono with `tabular-nums`, where every character advances the same
width by definition, so a count of clusters IS a width and one slot is one
character. The TICKER is the one proportional surface, in Instrument Sans
regular at 12.5px (not uppercased, not tracked), where advances run from `I` at
3.18px to `W` at 13.61px, so it is weighed per glyph against a slot of 9.1px
(the widest glyph the allowlist admits, `V` and `A`):

| Advance at 12.5px | Glyphs |
| --- | --- |
| 13.61 | `W` |
| 11.32 | `M` |
| 9.82 to 9.84 | `Q` `%` `O` |
| 9.20 to 9.56 | `G` `D` `C` `H` `N` |
| 9.10 | `A` `V` (the slot) |
| 8.20 to 8.90 | `U` `K` `X` `Y` `0` `P` `R` |
| 7.30 to 8.10 | `T` `E` `B` `Z` `9` `S` `$` `F` `4` `6` `L` `8` |
| 6.30 to 7.20 | `3` `5` `2` `7` `+` `-` |
| 5.69 | `J` |
| 4.89 | `1` |
| 3.18 | `I` `.` `,` `:` |

Anything past a slot is charged two, and the class is an ALLOWLIST of the
glyphs measured inside one (`U`, at 8.90, is left out on purpose: charging it
two is the safe direction and the budget tests pin the table). A character
nobody measured, and the schema admits all of Latin-1, is charged the wide
weight rather than assumed innocent. Classification uppercases first: the tile
no longer forces capitals, but a lowercase glyph weighed as its capital is
never narrower than what renders (the widest lowercase among the one-slot
capitals is 7.6px), and `m` (11.5px) and `w` (9.6px) land in the two-slot class
as `M` and `W`.

**One slot is one narrow character of that region's own type**, and the unit
matters because `String.length` is not it. Three corrections stand:

- **The ellipsis costs TWO slots.** In the tile's mono it is one cell (7.67px),
  so two slots over-charge it; that is the safe direction and the cut value
  always has room for its mark.
- **A wide code point costs TWO slots, and the cut is grapheme-safe.**
  `baseTokenSymbol` is `z.string().min(1).max(512)`: 512 UTF-16 code units of
  any Unicode. `String.slice` cuts code units, so a cut between a surrogate
  pair emitted a LONE SURROGATE (an ill-formed string on its way to the jsonb
  boundary) and a cut inside a ZWJ sequence rendered a different token than the
  provider sent. A value is segmented into grapheme clusters with
  `Intl.Segmenter` before anything is measured or removed.
- **A wide LATIN glyph costs two slots on the proportional surface.** Plain
  ASCII `WWWWWWWW` is eight characters and renders 107px against the 91px a
  ten-slot ticker may take; a count let it through with `shortened` false.

A budget is a property of the DATA, decided before layout exists. It owns no
threshold: it does not pick a column count or a floor, and no JavaScript reads
a width back. The overflow assertions in `e2e/board-layout.spec.ts` run over
the SCHEMA-EXTREME board AND a WIDE-GLYPH board (CJK, emoji ZWJ sequences,
combining marks) at the tile floor, and fail if any financial, stat, badge or
action region scrolls. That is what proves the budgets hold.

## 8. Superseded: the V10 card

For the history of the old numbers only. None of this is implemented any more.

- The V10 card was `px-5` (40 of padding) with a 1px border on every edge and a
  16px gap between cards, and set its figures in Departure Mono caps. The price
  row `$0.000001230 +661.00% 24h` measured 316; the stat block, the header and a
  stacked footer gave a COMPACT floor of 358px and, with a 132px sparkline in
  the price row, a WIDE floor of 502px.
- Two grid-wide modes (`--vex-board-mode: wide | compact`) chose the anatomy
  (sparkline inline or in its own slot, stats 4 across or 2x2, header actions in
  a row or stacked). The ladder was `C >= 1538` 3 wide, `C >= 1106` 3 compact,
  `C >= 1020` 2 wide, `C >= 732` 2 compact, `C >= 502` 1 wide, `C >= 358` 1
  compact, below that pinned at 358.
- Its measured defects (the price row wrapping out of a 44px row at 1920px,
  cards of unequal width, columns following the viewport while the drawer
  shrank the container, the card's own border missing from the first floor)
  are the reasons the container-query ladder, the `h-full w-full` tile and the
  border term in `card = inner + padding + border` exist; they stay fixed in the
  R3 tile and are covered by the harness spec.
- The sparkline (`BoardSparkline`, `board-sparkline-source`) was deleted with
  the R3 tile: the spotlight carries the chart.
