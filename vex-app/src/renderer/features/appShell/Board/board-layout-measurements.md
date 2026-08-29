# Board card measurement matrix

Measured, not estimated. Every number below came out of a real Chromium at
device pixel ratio 1 against the real production stylesheet, through the
harness at `src/renderer/dev/board-layout/` (`e2e/board-layout.spec.ts` drives
the same page). Regenerate by running that spec: it re-measures and asserts.

Units are CSS pixels, `Math.ceil` of the natural (un-clamped, `white-space:
nowrap`) border-box width of the element.

Method: each element is cloned out of its card into an absolutely positioned
off-flow copy with `width:auto; max-width:none; overflow:visible;
text-overflow:clip; white-space:nowrap`, so the number is what the element
WANTS, not what its parent currently allows.

## 1. Realistic compact output

Six pools whose figures are real DexScreener shapes: a five-figure price, a
sub-cent price with eight leading zeros, hundreds-of-thousands and
tens-of-millions liquidity, a billions volume, six-digit trade tallies, and
ages from five minutes to three years. The fixtures live in
`src/renderer/dev/board-layout/harness.tsx` (`REALISTIC_ROWS`).

| Region | data-vex-area | Widest realistic | Producing row |
| --- | --- | --- | --- |
| Token name | `board-token-name` | 174 | Aerodrome Finance |
| Ticker | `board-token-ticker` | 41 | DEGEN |
| Hero price | `board-token-price` | 198 | `$0.000001230` (PEPE) |
| Signed delta | `board-token-delta` | 76 | `+661.00%` |
| Delta window | `board-token-delta-window` | 22 | `24h` |
| Stat label `Liquidity` | `dt` | 45 | fixed copy |
| Stat label `24h Volume` | `dt` | 66 | fixed copy (widest label) |
| Stat label `Trades` | `dt` | 38 | fixed copy |
| Stat label `Pair age` | `dt` | 45 | fixed copy |
| Stat value, Liquidity | `dd` | 62 | `$495.6K` |
| Stat value, 24h Volume | `dd` | 63 | `$998.8K` |
| Stat value, Trades | `dd` | 54 | `900.0K` |
| Stat value, Pair age | `dd` | 49 | `1095d` |
| Token photo | `board-token-photo` | 64 | fixed |
| Spotlight button | `board-card-spotlight` | 96 | fixed copy |
| DexScreener link | `board-token-dexscreener-link` | 100 | fixed copy |
| Ask VEX button | `board-card-ask` | 88 | fixed copy |

## 2. Every safety chip label

Measured in the chip's own type (`Pill` size `lg`, with its leading glyph and
padding). The labels are the frozen table in
`src/shared/board/safety-classifier.ts` plus `BOARD_NEW_PAIR_LABEL`. All of
them are reachable in normal service, so none of them is an "extreme".

| Label | Width |
| --- | --- |
| `Checks unavailable in this response` | 242 |
| `Not indexed by the checks provider` | 239 |
| `Checks describe another token` | 215 |
| `Checks out of date` | 147 |
| `Sources disagree` | 139 |
| `Partial checks` | 120 |
| `Clean checks` | 118 |
| `Unverified` | 100 |
| `Checking` | 95 |
| `New pair` | 92 |
| `High risk` | 90 |

**242 is the number the footer has to survive.** It is not a schema extreme:
a transport blip on the details channel produces it on every card at once.

## 3. Schema-reachable extremes

`BOARD_DECIMAL_MAX_CHARS = 40` and `BOARD_TOKEN_LABEL_MAX_CHARS = 512`
(`src/lib/board/spec.ts`). A 40-character decimal renders as a 38-character
hero price; a 512-character symbol renders as a 512-character ticker. Neither
fits any card at any width the modal can reach, which is what the full-value
disclosure exists for: the cut becomes recoverable rather than silent.

## 4. Derived region floors

Card padding is `px-5` (40 total). Inner width = card width - 40.

| Region | Composition | Inner floor |
| --- | --- | --- |
| Stat block, 4 equal columns | `4 x max(label,value) + 3 x 12` gap, binding column is `24h Volume` at 66 | 300 |
| Stat block, 2x2 | `2 x 66 + 12` | 144 |
| Price row, no sparkline | `198 + 10 + 76 + 10 + 22` | 316 |
| Price row, sparkline at `w-[30%]` | `316 + 12 <= 0.7 x inner` | 469 |
| Footer, one row | `242 chip + 12 + (100 + 8 + 88)` | 450 |
| Footer, stacked | `max(242, 196)` | 242 |

## 4b. Per-mode floors, as built

Two grid-wide modes. The mode is chosen by CARD width; the column count is
chosen by CONTAINER width; both live in `global-css/board-layout.css` and
nowhere else.

**WIDE** keeps the anatomy the mockup fixes: the sparkline sits in the price
row beside the figures, the stat `dl` is four equal columns, the footer is one
row. The inline sparkline is a fixed `132px` rather than `w-[30%]`, so the
price row's budget cannot shrink faster than the card does.

| Wide constraint | Composition | Inner |
| --- | --- | --- |
| Price row | `316 + 12 gap + 132 sparkline` | **460** |
| Footer, one row | `242 chip + 12 + (100 + 8 + 88)` | 450 |
| Stat block, 4 columns | `4 x 66 + 3 x 12` | 300 |

Binding: 460. Plus 40px of `px-5` padding AND the card border's 2px:
**Wide floor = 460 + 42 = 502px card.**

**COMPACT** adapts rather than deletes: the sparkline leaves the price row for
its own fixed-height full-width slot below it, the footer stacks (chip row
above actions row), the stat `dl` goes 2x2.

| Compact constraint | Composition | Inner |
| --- | --- | --- |
| Price row, full width | `198 + 10 + 76 + 10 + 22` | **316** |
| Footer, stacked | `max(242 chip, 100 + 8 + 88 actions)` | 242 |
| Stat block, 2x2 | `2 x 66 + 12` | 144 |

Binding: 316. Plus 40px of `px-5` padding AND the card border's 2px:
**Compact floor = 316 + 42 = 358px card.**

THE BORDER WAS MISSING FROM THE FIRST PASS OF THIS TABLE, and it is not a
rounding detail. `CARD_CLASS` carries `border`, so a 356px card has 314px of
inner width, not 316: the hero price got 196px for a string that measures
197.29, and the one figure the entire ladder is derived from was cut by two
pixels at every floor on it. The constrained 800px case in
`e2e/board-layout.spec.ts` is what found it.

Fixed heights per mode, so cards are equal within a mode:

| Block | Wide | Compact |
| --- | --- | --- |
| Identity | 64 | 64 |
| Price row | 44 | 44 |
| Sparkline | inline, `132 x 44` | own slot, 36 high, 12 margin above |
| Stat block | 46 | 92 (`2 x 40 + 12` row gap) |
| Footer | one row | stacked |

Measured card height, six realistic pools, every card in a grid identical:
**293 wide, 423 compact.**

The mode is declared on the GRID, not on the plate. `@container` styles apply
to a container's DESCENDANTS and never to the container element itself, so
mode variables written onto the plate would sit in a block that can never
match - a defect this document's own verification pass caught after the CSS
was first written. The grid is the correct owner in any case: it is the one
element every card shares, which is what makes the mode grid-wide and
therefore makes the cards equal.

## 4c. The mode ladder

`C` is the plate's content box, which is what `container-type: inline-size`
measures. With `n` columns and a 16px gap, `card = (C - 16(n-1)) / n`.

The rule, in one sentence: **take the most columns (max 3) whose card clears
the compact floor, then use wide anatomy if that card also clears the wide
floor.** Nothing else is consulted - not the viewport, not the drawer.

| Threshold | Derivation | Result |
| --- | --- | --- |
| `C >= 1538` | `3 x 502 + 32` | 3 columns, WIDE |
| `C >= 1106` | `3 x 358 + 32` | 3 columns, COMPACT |
| `C >= 1020` | `2 x 502 + 16` | 2 columns, WIDE |
| `C >= 732` | `2 x 358 + 16` | 2 columns, COMPACT |
| `C >= 502` | `1 x 502` | 1 column, WIDE |
| `C >= 358` | `1 x 358` | 1 column, COMPACT |
| `C < 358` | UNDERSIZED | 1 column pinned at 358, the plate side-scrolls |

The wide ranges are therefore `[502, 732)` or `[1020, 1106)` or
`[1538, inf)` - the three windows where the chosen column count happens to
leave a card 502px wide or better. That is ONE container-query block, not
three: every mode-dependent value is a custom property set inside it.

The UNDERSIZED regime KEEPS the sparkline slot. Hiding it there was
permitted and is not needed: the pinned 358px card IS the compact floor, so
every region still fits and the only thing that changes is that the plate
scrolls horizontally instead of cutting a figure.

### What the ladder produces at real widths

`C = dialog - 80` with no drawer (body `px-6`, plate `p-4`), and
`C = dialog - 440` with it. The dialog is `min(90vw, 1280)`, widened by the
host to `min(94vw, 1640)` while the drawer is open.

| Viewport | Drawer | Dialog | C | Columns | Mode | Card |
| --- | --- | --- | --- | --- | --- | --- |
| 1920 | no | 1280 | 1200 | 3 | compact | 389 |
| 1440 | no | 1280 | 1200 | 3 | compact | 389 |
| 1366 | no | 1229 | 1149 | 3 | compact | 372 |
| 1280 | no | 1152 | 1072 | 2 | WIDE | 528 |
| 1000 | no | 900 | 820 | 2 | compact | 402 |
| 1920 | yes | 1640 | 1200 | 3 | compact | 389 |
| 1440 | yes | 1353 | 913 | 2 | compact | 448 |
| 1366 | yes | 1284 | 844 | 2 | compact | 414 |
| 1280 | yes | 1203 | 763 | 2 | compact | 373 |
| 1000 | yes | 940 | 500 | 1 | WIDE | 500 |
| 800 | no | 752 | 636 | 1 | WIDE | 636 |
| 800 | yes | 752 | 312 | 1 | compact | 358, side-scrolls |

Three columns hold at 1440 with no drawer, which was the requirement; the
drawer costs a column rather than a figure. The 800px rows are the
constrained case the Playwright suite runs: one of them is the only regime in
which the plate side-scrolls, and it is what caught the missing border above.

## 4d. The full-value disclosure

A schema extreme cannot be made to fit and must not be cut in silence, so
every card carries ONE always-present control in its header - a semantic
`<button>` beside Spotlight - that opens the whole name, the whole ticker and
the raw provider decimals for price, liquidity and volume.

Its PRESENCE is **not** conditional on width, because a card always rounds
something: `formatBoardPriceUsd` truncates every price by design, so the
recovery path is owed to every card at every width.

What IS conditional is what it SAYS. A control that reads "Show the full
values" on a card whose price has had its tail removed tells the reader a
panel exists and does not tell them the figure in front of them is not the
figure. So when the card printed a shortened copy of a value, the button
names the cut state in its accessible name, wears the accent treatment the
card already uses for "this needs your attention", and repeats the statement
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

Its cost to the floors is nothing: it sits in the identity row, whose
flexible middle absorbs it, so no table above changes.

## 4e. The content budgets

The floors above are sized against the widest REALISTIC output. The schema
permits far more (`BOARD_DECIMAL_MAX_CHARS = 40`,
`BOARD_TOKEN_LABEL_MAX_CHARS = 512`), and such a value used to be rendered
whole into a `whitespace-nowrap` cell inside an `overflow-hidden` card: the
reader got a figure with its tail removed and nothing saying so.

`boardCardValueBudget.ts` owns the fix. Each budget is the widest realistic
string for that region, measured in SLOTS - which is exactly the string the
region's floor was derived from, so a value past it is by construction past
what the layout was sized for, and it is the value that concedes rather than
the layout.

| Region | Budget | The string it is derived from |
| --- | --- | --- |
| Hero price | 12 | `$0.000001230`, 197.29px in a 198px slot |
| Signed delta | 8 | `+661.00%`, 76px |
| Stat value | 11 | wide mode's `(460 - 3 x 12) / 4 = 106px` column |
| Ticker | 10 | compact identity column, 88px |
| Token name | none | keeps its CSS ellipsis by product decision |

**One slot is one narrow character of that region's own type**, and the unit
matters because `String.length` is not it. Two corrections came out of that:

- **The ellipsis costs TWO slots.** The financial regions render
  `tabular-nums` where every digit is one width, but `…` is not a digit: in
  the display face at the hero's 28px it measures about 30px against a
  digit's 16.44. A value shortened to exactly the budget in characters still
  overflowed by nine pixels, which the extreme case at the compact floor
  caught.
- **A wide code point costs TWO slots, and the cut is grapheme-safe.**
  `baseTokenSymbol` is `z.string().min(1).max(512)`: 512 UTF-16 CODE UNITS of
  any Unicode, and the ticker is not `tabular-nums`. A ten-character CJK
  ticker was ten `String.length`, sat under a ten-character budget, and
  rendered 130px into an 88px column with `shortened` reported as false -
  silent loss from the module written to prevent it. And `String.slice` cuts
  code units, so a cut between a surrogate pair emitted a LONE SURROGATE (an
  ill-formed string on its way to the jsonb boundary) while a cut inside a ZWJ
  sequence rendered a different token than the provider sent.

  The model, owned in that module's head note: segment into grapheme clusters
  with `Intl.Segmenter`, then charge a cluster ONE slot when every code point
  in it is U+0000-U+00FF and TWO otherwise. It over-charges a Greek letter or
  a combining mark, which is the right direction to be wrong in -
  over-charging shortens early AND SAYS SO; under-charging overflows in
  silence.

A budget is a property of the DATA, decided before layout exists. It owns no
threshold: it does not pick a column count, a mode or a floor, and no
JavaScript reads a width back. The overflow assertions in
`e2e/board-layout.spec.ts` run over the SCHEMA-EXTREME board AND a WIDE-GLYPH
board (CJK, emoji ZWJ sequences, combining marks) at the compact floor, and
fail if any financial, stat, badge or action region scrolls. That is what
proves the budgets hold.

## 5. What the matrix proves about the CURRENT card

Three defects, all reproduced by `e2e/board-layout.spec.ts` before any fix:

1. **The hero price row already wraps and is clipped, with no drawer and no
   narrow window.** At a 1920px viewport the price row's inner flex box
   measures `scrollHeight` 56 inside its `h-[44px]` parent on three of the six
   realistic rows (WBTC, PEPE, TOSHI). The delta and its `24h` window wrap
   onto a second line that the fixed height does not have room for. The
   binding constraint is the `w-[30%]` sparkline: the row needs 469px of inner
   width to hold realistic figures beside it, and a three-column grid at 1440
   gives 349.

2. **Cards in one grid are not the same width.** `<li className="flex
   min-w-0">` wraps an `<article>` with no `w-full`, so each card shrinks to
   its own content inside its column: 382 / 369 / 406 / 345 / 407 / 342 at a
   1440px viewport where every grid track is 388.

3. **Columns follow the viewport while the drawer shrinks the container.** At
   1440 with the drawer open the grid still asks for three tracks and each one
   measures 268px, below the 300 the stat block needs and far below the 316
   the price row needs. `24h Volume` and every chip label ellipsize.

## 6. The question this matrix raised, and how it was settled

With the anatomy the mockup fixes and a `w-[30%]` sparkline, a card needed
**509px** to render realistic figures with nothing cut. The modal's plate is
1200px, which is two cards of 592 - never three. Three columns would have
needed a window past 1820px.

The owner's answer was that the board must be RESPONSIVE at every width, with
no data loss and no empty-looking two-column board on a typical monitor. That
is what sections 4b and 4c implement: the anatomy ADAPTS rather than the data
being cut or a column being surrendered. The sparkline moves to its own slot,
the footer stacks and the stat block goes 2x2, which drops the floor from 509
to 358 and lets 1440 keep three columns.

Rejected on the way there, and why:

- **Two columns at 1440.** Wastes the owner's own screen for a constraint the
  anatomy can absorb instead.
- **Deleting the sparkline below a width.** Data loss, and the mockup fixes
  that sparkline as part of the card.
- **Shrinking the hero price type.** Financial display; rule 08 does not let
  a layout constraint decide how legible a price is.
- **Raising the dialog cap past 1280px.** Moves the problem to the next
  window size instead of solving it, and widens a surface the owner sized.
