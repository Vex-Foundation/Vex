/**
 * TOKEN TILE (v3) - one pool, in the R3 Minimal anatomy
 * (docs/design/R3-MINIMAL.md section 9.4).
 *
 * Read top to bottom, the tile is: a 34px framed token photo, the token's
 * name over "TICKER - Chain name", and at the right the full-value key and the
 * Spotlight chip; the price in mono 26 with the signed 24h change in the
 * trading colour and the window printed after it; a quiet rule over four stats
 * in one row; and a footer of the checks word on a row of its own over the two
 * links, DexScreener and Ask Vex. The two actions - Spotlight and Ask Vex -
 * are real buttons.
 *
 * THE GRID DRAWS THE FRAME, THE TILE DRAWS ITS OWN HALF. The grid carries a
 * 1px quiet rule on its top and left edge and each tile a 1px quiet rule on
 * its right and bottom edge, with no gap between tiles, so the board reads as
 * one ruled sheet (`global-css/board-layout.css`). The tile has no fill of its
 * own: it is the page paper, and a hover is the interactive wash.
 *
 * EQUAL TILES ARE A CONTRACT, NOT A CONSEQUENCE. A grid of tiles whose heights
 * follow their content reads as damage. So every region is one line of fixed
 * line height: the name is clamped to one line rather than allowed to wrap a
 * tile taller, the price row carries a fixed height, the checks word never
 * wraps (the widest verdict the frozen safety table can produce fits one row
 * at the floor), and the footer is pushed to the bottom with `mt-auto`. A
 * token with a long name and no photo occupies exactly the same box as one
 * with a picture.
 *
 * SPOTLIGHT IS A BUTTON, NOT A SWITCH (owner's correction over the mockup's
 * own control). It navigates: pressing it changes which view the modal is
 * showing. A switch would claim the tile carries a persistent per-token
 * setting, and a reader who found it "on" would have no idea what it was
 * doing. `aria-pressed` still reports which tile the spotlight is currently
 * about, so the selected state is not left to an outline colour; the selected
 * tile also wears the 1.5px blue outline `board.css` draws inside it.
 *
 * THREE DATA STATES, and each is a designed state of the SAME elements, never
 * a missing element: a pool with no hydration row, a row whose price the
 * provider did not report, and a priced row. A board is never a run of gaps -
 * dropping a tile would misrepresent the board the model actually composed.
 *
 * THE LIVE TICK. When `priceUsd` or the 24h delta changes under a held lease
 * the price row is stamped with a fresh `data-tick`, and `board.css` flashes
 * the accent wash off it once. An unchanged rerender stamps nothing, so a
 * board that repaints for an unrelated reason does not blink. The change's
 * colour is never animated: a tone is a fact, not a flash.
 *
 * TRADING COLOUR IS ON ONE ELEMENT. The 24h change takes `text-trade-up` or
 * `text-trade-down`, and flat is muted. Status is never a hue: the checks word
 * is a swatch plus its word, and the swatch is a fill (R3 section 1.6).
 *
 * NO CHART ON THE TILE. The R3 tile has no sparkline: the spotlight carries
 * the chart, and the tile spends its width on the figures. Nothing here
 * fetches, draws or reserves room for a line.
 *
 * ONE ANATOMY AT EVERY WIDTH. The board plate is a container query container
 * and `global-css/board-layout.css` owns every threshold: how many columns the
 * grid has, and the single floor under which a tile does not shrink. The
 * floor is derived from this anatomy (the price row, the four stats in a row
 * and the header with its widest realistic ticker line), so there is no
 * second layout to switch to. Nothing here knows a pixel: there is no solver,
 * no ResizeObserver and no window read, so opening the Vex sidebar changes the
 * layout in the same paint that changes the container.
 *
 * NOTHING IS RECOVERED BY HOVER. `title` is a pointer convenience and never
 * the only way back to a cut string, so every tile carries one always-present
 * `FullValueDisclosure` key: a real `<button>` with `aria-expanded` and
 * `aria-controls`, in the tab order, that opens the whole name, the whole
 * ticker, the whole chain name and the RAW provider decimals. A DISCLOSURE and
 * never a dialog - the long form of why is on the component itself. It is
 * present unconditionally on purpose - a tile is always rounding something -
 * but it is not SILENT about the difference between rounding and cutting: when
 * the tile printed a shortened copy of a value it says so, in the key's
 * accessible name, in the key's own treatment (blue edge, blue glyph), and
 * again at the top of the panel.
 *
 * WHAT DECIDES "SHORTENED" IS THE DATA, NOT THE LAYOUT. `boardCardValueBudget
 * .ts` owns a per-region budget in SLOTS - grapheme clusters weighted by the
 * width class of their code points - derived from the same measurement
 * the CSS floor comes from, and it runs before layout exists. No
 * JavaScript here reads a width back, and no threshold leaves the stylesheet:
 * a budget decides how much of a string is worth printing, never how many
 * columns the board has.
 */

import { useEffect, useId, useRef, useState, type JSX } from "react";
import { chainDisplayBySlug } from "@shared/chains/display.js";
import {
  LineClose,
  LineExternal,
  LineInfo,
  LineSpark,
} from "../../../components/icons/line/index.js";
import { cn } from "../../../lib/utils.js";
import { TokenPhoto } from "./TokenPhoto.js";
import {
  BoardStatusChip,
  boardStatusChipLabel,
} from "./BoardStatusChip.js";
import {
  BOARD_EMPTY,
  dexscreenerPairUrl,
  formatBoardAge,
  formatBoardPercent,
  formatBoardPriceUsd,
  formatBoardTradeTotal,
  formatBoardUsdCompact,
  type BoardTrend,
} from "./boardFormat.js";
import {
  anyShortened,
  boardCardValue,
  BOARD_CARD_DELTA_MAX_SLOTS,
  BOARD_CARD_PRICE_MAX_SLOTS,
  BOARD_CARD_STAT_MAX_SLOTS,
  BOARD_CARD_TICKER_MAX_SLOTS,
  type BoardCardValue,
} from "./boardCardValueBudget.js";
import type { BoardCardModel } from "./boardModel.js";
import type { BoardSafetyVerdict } from "./board-surface-contracts.js";

/**
 * The tile plate.
 *
 * `vex-board-card` is the selected-tile seam (`board.css` draws the 1.5px blue
 * outline inside it) and `vex-bd-tile` is the frame (`board-layout.css`: the
 * tile's right and bottom rule, its padding 16 18 14, no fill, the hover
 * wash). The hover moves COLOUR only, never geometry: a tile that scaled or
 * lifted on hover would reflow the grid under the pointer. `vex-tint` settles
 * the wash on the motion scale and stills it under reduced motion. The focus
 * ring is on the tile's own INTERACTIVE children (`board-layout.css`), not on
 * the plate: the plate is not focusable, and a ring around a non-target is
 * noise.
 */
const CARD_CLASS =
  "vex-board-card vex-bd-tile vex-tint group relative flex h-full w-full min-w-0 flex-col overflow-hidden";

export interface TokenCardV3Props {
  readonly card: BoardCardModel;
  readonly verdict: BoardSafetyVerdict;
  /** True when the modal's spotlight is currently about THIS pool. */
  readonly selected: boolean;
  /** True while the board holds a live lease: only then may a change tick. */
  readonly live?: boolean;
  readonly onSpotlight: () => void;
  readonly onAsk: () => void;
}

export function TokenCardV3({
  card,
  verdict,
  selected,
  live = false,
  onSpotlight,
  onAsk,
}: TokenCardV3Props): JSX.Element {
  const { row } = card;
  const state =
    row === null ? "unhydrated" : row.priceUsd === null ? "partial" : "data";
  const symbol = row?.baseTokenSymbol ?? null;
  const heading = row?.baseTokenName ?? symbol ?? card.pairAddress;
  const ticker = symbol ?? card.pairAddress;
  // The chain as a reader names it ("Base"), from the one shared catalogue.
  // An uncatalogued slug is named after itself and never blank.
  const chainName = chainDisplayBySlug(card.chain).name;
  const priceLabel = formatBoardPriceUsd(row?.priceUsd ?? null);
  const deltaLabel = formatBoardPercent(row?.priceChange.h24 ?? null);
  const statusLabel = boardStatusChipLabel(verdict, row?.pairAgeSeconds ?? null);
  const tick = useLiveTick(live, row?.priceUsd ?? null, row?.priceChange.h24 ?? null);

  // WHAT THE TILE WILL PRINT, and what it had to shorten to print it. The
  // budgets belong to `boardCardValueBudget.ts`; the accessible name below
  // and the disclosure panel both keep the WHOLE strings, so nothing here
  // removes a value from the reader - it decides which copy is on the plate.
  // The ticker is the tile's one PROPORTIONAL surface: it renders in
  // Instrument Sans, where `W` advances well over twice as far as `I`, so it
  // is weighed per glyph rather than counted. Everything below renders in
  // JetBrains Mono with `tabular-nums`, where a count of characters genuinely
  // is a width.
  const printedTicker = boardCardValue(
    ticker,
    BOARD_CARD_TICKER_MAX_SLOTS,
    "proportional",
  );
  const printedPrice = boardCardValue(priceLabel, BOARD_CARD_PRICE_MAX_SLOTS);
  const printedDelta = boardCardValue(deltaLabel, BOARD_CARD_DELTA_MAX_SLOTS);
  const stats: readonly {
    readonly label: string;
    readonly printed: BoardCardValue;
    readonly title: string | undefined;
  }[] = [
    {
      label: "Liquidity",
      printed: boardCardValue(
        formatBoardUsdCompact(row?.liquidityUsd ?? null),
        BOARD_CARD_STAT_MAX_SLOTS,
      ),
      title: row?.liquidityUsd ?? undefined,
    },
    {
      label: "24h Volume",
      printed: boardCardValue(
        formatBoardUsdCompact(row?.volumeH24Usd ?? null),
        BOARD_CARD_STAT_MAX_SLOTS,
      ),
      title: row?.volumeH24Usd ?? undefined,
    },
    {
      label: "Trades",
      printed: boardCardValue(
        row === null
          ? BOARD_EMPTY
          : formatBoardTradeTotal(row.txns.buys, row.txns.sells),
        BOARD_CARD_STAT_MAX_SLOTS,
      ),
      title: undefined,
    },
    {
      label: "Pair age",
      printed: boardCardValue(
        formatBoardAge(row?.pairAgeSeconds ?? null),
        BOARD_CARD_STAT_MAX_SLOTS,
      ),
      title: undefined,
    },
  ];
  // The NAME is deliberately not in this list: it keeps its CSS ellipsis by
  // product decision, and its whole string is in the `title`, in the tile's
  // accessible name and in the disclosure. The chain name is not budgeted
  // either: it is a short catalogue name, it concedes width to the ticker, and
  // its whole string is in the `title` and in the disclosure.
  const shortened = anyShortened([
    printedTicker,
    printedPrice,
    printedDelta,
    ...stats.map((stat) => stat.printed),
  ]);

  /**
   * THE DISCLOSURE'S STATE LIVES ON THE TILE, and it has to.
   *
   * The panel is opaque and covers the whole tile, so while it is open every
   * interactive element underneath it is INVISIBLE - and an invisible control
   * that can still be reached by Tab is exactly what rule 08 forbids ("focus
   * is visible and not obscured"). Withdrawing them is therefore the TILE's
   * job, because the tile is what owns them; a component inside the header
   * could not reach the footer's buttons without reaching up out of itself.
   *
   * `tabIndex={-1}` AND NOT `inert`, deliberately. `inert` removes a subtree
   * from the accessibility tree, which would take the trigger's own
   * `aria-expanded="true"` with it - the panel would be open and nothing
   * would be able to say so. `tabIndex={-1}` removes an element from the TAB
   * ORDER only: it stays in the tree, it still reports its state, and it can
   * still be focused programmatically, which is what the Escape restore below
   * relies on. The attributes revert with this flag, in the same commit that
   * removes the panel.
   */
  const [fullValueOpen, setFullValueOpen] = useState(false);

  return (
    <article
      data-vex-area="board-token-card-v3"
      data-state={state}
      data-selected={selected ? "true" : "false"}
      aria-label={`${ticker} on ${card.chain}, price ${priceLabel}, 24 hour change ${deltaLabel}, ${statusLabel}`}
      className={CARD_CLASS}
    >
      {/* IDENTITY. One fixed row: the 34px photo, the name over the ticker
        * line (18 + 16 = the photo's 34), and the two controls at the right.
        * A two-line name in one tile cannot push every price row in its row
        * of tiles out of alignment, because the name is clamped to one line. */}
      <header className="vex-bd-tile-id">
        <TokenPhoto iconId={row?.iconId ?? null} symbol={symbol} />
        <div className="min-w-0 flex-1">
          <span
            data-vex-area="board-token-name"
            className="block truncate text-[15px] font-semibold leading-[18px] text-ink-primary"
            // The WHOLE name: the visual clamp is CSS, the string is intact
            // here and in the accessible name.
            title={heading}
          >
            {heading}
          </span>
          {/* THE TICKER LINE: "TICKER - Chain name", 12.5 muted. The ticker
            * keeps its budgeted width (`shrink-0`) and the chain name is what
            * concedes, with an ellipsis and its whole string in the title,
            * so a cut can only ever land on the part that is whole in the
            * disclosure and never on the token's own symbol. The chain mark is
            * gone: the name is the chain. */}
          <span
            data-vex-area="board-token-meta"
            className="flex min-w-0 items-baseline text-[12.5px] leading-[16px] text-ink-tertiary"
          >
            <span
              data-vex-area="board-token-ticker"
              data-shortened={printedTicker.shortened ? "true" : undefined}
              className="shrink-0 whitespace-nowrap"
              title={ticker}
            >
              {printedTicker.text}
            </span>
            <span aria-hidden className="shrink-0 whitespace-pre">
              {" · "}
            </span>
            <span
              data-vex-area="board-token-chain"
              className="min-w-0 truncate"
              title={chainName}
            >
              {chainName}
            </span>
          </span>
        </div>
        <div className="vex-bd-tile-actions">
          <FullValueDisclosure
            ticker={ticker}
            heading={heading}
            chainName={chainName}
            row={row}
            shortened={shortened}
            open={fullValueOpen}
            onOpenChange={setFullValueOpen}
          />
          <SpotlightAction
            symbol={ticker}
            selected={selected}
            onSpotlight={onSpotlight}
            covered={fullValueOpen}
          />
        </div>
      </header>

      {/* PRICE. The mono 26 price, the qualified 24h change in its trading
        * colour, and the window ("24h") printed after it rather than left to
        * a legend, so "+661.00%" cannot be read as a lifetime move. One row,
        * fixed height, three things that are read together. */}
      <div
        data-vex-area="board-token-price-row"
        data-tick={tick}
        className="vex-bd-tile-px"
      >
        {/* NOWRAP, and that is the fix for a defect the matrix caught at
          * 1920px with no drawer at all: with `flex-wrap` the browser pushed
          * the delta and its `24h` window onto a second line rather than
          * shrinking the price, and the row's fixed height had no room for
          * it. Nowrap makes the price the one element that concedes width -
          * the right priority, because the delta and the window are short,
          * fixed and meaningless apart, and because the disclosure in the
          * header carries the whole decimal string either way. */}
        <div className="flex min-w-0 flex-1 flex-nowrap items-baseline gap-x-2.5">
          <span
            data-vex-area="board-token-price"
            data-shortened={printedPrice.shortened ? "true" : undefined}
            className="vex-bd-tile-price vex-num min-w-0 truncate font-mono text-[26px] font-medium leading-[32px] text-ink-primary"
            // The WHOLE decimal string, so no digit the provider reported is
            // lost to the display precision above it. The KEYBOARD path to
            // the same string is the header's disclosure; this is the
            // pointer's shortcut, never the only way back.
            title={row?.priceUsd ?? undefined}
          >
            {printedPrice.text}
          </span>
          <span
            data-vex-area="board-token-delta"
            data-trend={card.trendH24}
            data-shortened={printedDelta.shortened ? "true" : undefined}
            className={cn(
              "vex-num shrink-0 font-mono text-[13px] leading-[20px]",
              deltaToneClass(card.trendH24),
            )}
            title={printedDelta.shortened ? deltaLabel : undefined}
          >
            {printedDelta.text}
          </span>
          <span
            data-vex-area="board-token-delta-window"
            className="shrink-0 text-[12px] leading-[18px] text-ink-tertiary"
          >
            24h
          </span>
        </div>
      </div>

      {/* THE FOUR FIGURES. A `dl` with four equal columns under a quiet rule
        * (`board-layout.css`): the label sits ABOVE its value, as the mockup
        * has it, and the equal columns keep the figures aligned across every
        * tile in the grid regardless of how wide any one value renders. */}
      <dl
        data-vex-area="board-token-stats"
        className="vex-board-card-stats"
      >
        {stats.map((stat) => (
          <Stat
            key={stat.label}
            label={stat.label}
            printed={stat.printed}
            title={stat.title}
          />
        ))}
      </dl>

      {/* FOOTER. `mt-auto` (in `board-layout.css`) pins this block to the
        * bottom of the plate, so a row of tiles has its checks word and its
        * links on one line whatever happens above them. The checks word is
        * ALWAYS its own full-width row: "Checks unavailable in this
        * response" is the widest string the frozen safety table can produce
        * and it fits one row of the floor, so the links below it are never
        * what gives way. */}
      <div
        data-vex-area="board-token-footer"
        className="vex-board-card-footer"
      >
        <BoardStatusChip
          verdict={verdict}
          pairAgeSeconds={row?.pairAgeSeconds ?? null}
          className="vex-bd-tile-check"
        />
        <div className="vex-bd-tile-links">
          <DexscreenerLink
            chain={card.chain}
            pairAddress={card.pairAddress}
            ticker={ticker}
            covered={fullValueOpen}
          />
          <button
            type="button"
            data-vex-area="board-card-ask"
            onClick={onAsk}
            aria-label={`Ask Vex about ${ticker}`}
            // Covered by the full-value panel: out of the tab order, still in
            // the accessibility tree. See `fullValueOpen` above.
            tabIndex={fullValueOpen ? -1 : undefined}
            className="vex-bd-link"
          >
            <LineSpark size={14} />
            Ask Vex
          </button>
        </div>
      </div>
    </article>
  );
}

/**
 * The provider's own page for this pool, ALWAYS present.
 *
 * A passive external link, painted as the board's blue link (`vex-bd-link`,
 * 13 / 500 with its glyph after the word). `target="_blank"` never opens a child window
 * here, because main's window-open handler denies it and routes allowlisted
 * hosts (dexscreener.com is on the list) through `shell.openExternal`. The
 * href is built from the board's own chain slug and pair address and from
 * nothing the model wrote.
 */
export function DexscreenerLink({
  chain,
  pairAddress,
  ticker,
  className,
  covered = false,
}: {
  readonly chain: string;
  readonly pairAddress: string;
  readonly ticker: string;
  readonly className?: string;
  /** True while an opaque overlay covers this link: out of the tab order. */
  readonly covered?: boolean;
}): JSX.Element {
  return (
    <a
      href={dexscreenerPairUrl(chain, pairAddress)}
      target="_blank"
      rel="noopener noreferrer"
      data-vex-area="board-token-dexscreener-link"
      aria-label={`Open ${ticker} on DexScreener`}
      tabIndex={covered ? -1 : undefined}
      className={cn("vex-bd-link", className)}
    >
      DexScreener
      <LineExternal size={14} />
    </a>
  );
}

/**
 * A fresh stamp per live change of the two figures the price row shows, or
 * undefined when nothing changed since the last commit.
 *
 * The stamp is a counter rather than a boolean because the CSS animation
 * restarts on an ATTRIBUTE CHANGE: a boolean that stayed `true` across two
 * consecutive ticks would flash once. It is undefined (no attribute at all)
 * on the first commit and on every unchanged rerender, and it never advances
 * without a held lease - a snapshot board has nothing to tick about.
 */
function useLiveTick(
  live: boolean,
  priceUsd: string | null,
  changeH24: string | null,
): number | undefined {
  const seen = useRef<{ price: string | null; change: string | null } | null>(null);
  const stamp = useRef(0);
  const armed = useRef<number | undefined>(undefined);
  const previous = seen.current;
  const changed =
    previous !== null && (previous.price !== priceUsd || previous.change !== changeH24);
  if (previous === null || changed) {
    seen.current = { price: priceUsd, change: changeH24 };
  }
  if (changed && live) {
    stamp.current += 1;
    armed.current = stamp.current;
  }
  // An unchanged rerender carries the LAST stamp forward unchanged, so React
  // does not rewrite the attribute and the animation does not restart.
  return armed.current;
}

/**
 * The Spotlight trigger.
 *
 * ALWAYS VISIBLE, never hover-revealed. A hover-only affordance is
 * unreachable by keyboard and by touch, and this is the tile's primary
 * action. It is the board's chip (`vex-bd-chip` in `board.css`: 26 high, 12.5,
 * a quiet rule) with the word and no icon; `aria-pressed="true"` gives it the
 * pressed look (blue edge, blue type at 500 on the selection fill), so the
 * selected state is carried by the attribute and by the paint, never by the
 * paint alone.
 */
function SpotlightAction({
  symbol,
  selected,
  onSpotlight,
  covered = false,
}: {
  readonly symbol: string;
  readonly selected: boolean;
  readonly onSpotlight: () => void;
  /** True while the full-value panel covers this button. */
  readonly covered?: boolean;
}): JSX.Element {
  return (
    <button
      type="button"
      data-vex-area="board-card-spotlight"
      data-selected={selected ? "true" : "false"}
      aria-pressed={selected}
      aria-label={`Spotlight ${symbol}`}
      tabIndex={covered ? -1 : undefined}
      onClick={onSpotlight}
      className="vex-bd-chip"
    >
      Spotlight
    </button>
  );
}

/**
 * The 24h change is the ONE element on the tile that takes a trading colour
 * (R3 section 1.2): up and down are the two trading aliases, flat is muted.
 * A change that is absent reads as flat, so it is never painted as a move.
 */
function deltaToneClass(trend: BoardTrend): string {
  if (trend === "up") return "text-trade-up";
  if (trend === "down") return "text-trade-down";
  return "text-ink-tertiary";
}

function Stat({
  label,
  printed,
  title,
}: {
  readonly label: string;
  readonly printed: BoardCardValue;
  readonly title?: string | undefined;
}): JSX.Element {
  // NEITHER LINE ELLIPSIZES IN CSS, and that is why the value arrives already
  // decided. A stat label is fixed product copy and a stat value is a figure
  // a reader is about to act on; the floor in `board-layout.css` is sized so
  // every realistic pair fits whole (binding label "24h Volume" at 63px in
  // sans 11.5, widest value "$1234.5B" at 62px in mono 13). A schema extreme
  // that cannot fit is shortened by `boardCardValueBudget.ts` BEFORE it gets
  // here, so what reaches this cell always fits and always says whether it
  // is the whole figure - rather than being clipped by the tile with nothing
  // reporting it. The label is a word (sans, sentence case, muted); the value
  // is a figure (mono, tabular).
  return (
    <div className="min-w-0">
      <dt className="whitespace-nowrap text-[11.5px] leading-[16px] text-ink-tertiary">
        {label}
      </dt>
      <dd
        data-shortened={printed.shortened ? "true" : undefined}
        className="vex-num whitespace-nowrap font-mono text-[13px] leading-[18px] text-ink-primary"
        title={title}
      >
        {printed.text}
      </dd>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* The full-value disclosure                                           */
/* ------------------------------------------------------------------ */

/** What the card is showing in a clamped form, and the whole string for it. */
interface FullValueEntry {
  readonly label: string;
  readonly value: string;
  /** A figure: set in the mono face, as everywhere else on the tile. */
  readonly figure: boolean;
}

export const BOARD_FULL_VALUE_LABEL = "Show the full values";
export const BOARD_FULL_VALUE_TITLE = "Full values";

/**
 * WHAT THE AFFORDANCE SAYS WHEN THE CARD ACTUALLY CUT SOMETHING.
 *
 * "Show the full values" says a panel exists; it does not say that the figure
 * in front of the reader is not the whole figure. That difference is the
 * whole point of a reported bound, so a card that shortened a value names the
 * cut state in the button's accessible name and again, visibly, at the top of
 * the panel.
 */
export const BOARD_FULL_VALUE_SHORTENED_LABEL =
  "Some values on this card are shortened";

/**
 * THE RECOVERY PATH FOR EVERY CLAMPED STRING ON THE CARD.
 *
 * A 40-character decimal and a 512-character symbol are both schema-valid
 * (`BOARD_DECIMAL_MAX_CHARS`, `BOARD_TOKEN_LABEL_MAX_CHARS`) and neither can
 * be made to fit any card at any width. The display formatters also round
 * every price by design. So the card always clamps SOMETHING, and until now
 * the only way back was a `title` - unreachable by keyboard and by touch,
 * which rule 08 does not accept for anything a reader may need.
 *
 * This is a real `<button>`, so Enter and Space work with no key handler of
 * our own, and the panel it opens is an ordinary absolutely-positioned
 * overlay INSIDE the card rather than a portal: the board modal's native
 * `<dialog>` already owns the modal layer, and a portal to `document.body`
 * would put the panel outside it.
 *
 * IT IS A DISCLOSURE, NOT A DIALOG, and the difference is not cosmetic. This
 * panel carried `role="dialog"` with `aria-modal="true"` and a focus trap,
 * and every part of that claim was false: nothing outside it was inert, a
 * pointer reached every other card on the board while it was open, and two of
 * them could be "modal" at the same time. `aria-modal` promises a reader that
 * the rest of the page is unavailable, and a promise the code does not keep
 * is worse than no promise - a screen-reader user would have been told the
 * board was gone while a sighted user was clicking it.
 *
 * So it is what it actually is: a button with `aria-expanded` and
 * `aria-controls`, and a labelled group it points at. Consequences, all
 * deliberate:
 *
 *   - NO FOCUS TRAP. A non-modal surface must not trap; Tab runs through the
 *     panel's content and then ONWARD, out of this card entirely - because
 *     the controls it covers leave the tab order for as long as it covers
 *     them. That is `tabIndex={-1}` on the card's own buttons and NOT
 *     `inert`: `inert` would take the whole subtree out of the accessibility
 *     tree, including the trigger's `aria-expanded="true"`, so the panel
 *     would be open with nothing able to say so. `tabIndex={-1}` removes an
 *     element from the tab order alone - it still reports its state, and it
 *     can still be focused programmatically, which is what the Escape
 *     restore depends on. `TokenCardV3` owns that flag; see `fullValueOpen`.
 *   - MANY MAY BE OPEN. Two cards showing their values at once is legitimate
 *     for a disclosure - it is how a reader compares two pools - so it is
 *     TESTED rather than left accidental, and opening one never closes
 *     another.
 *   - THE REST OF THE BOARD STAYS LIVE. Another card's Spotlight is one click
 *     away while this panel is open, which is also tested.
 *
 * Focus still MOVES into the panel on open and RETURNS to the trigger on
 * close. That is not a modal obligation, it is this panel's own: it paints
 * over the card it belongs to, so a reader whose focus stayed behind it would
 * be operating a control they can no longer see. Escape closes it, and is
 * stopped from propagating so that closing the panel does not also close the
 * board `<dialog>` listening for the same key.
 */
function FullValueDisclosure({
  ticker,
  heading,
  chainName,
  row,
  shortened,
  open,
  onOpenChange,
}: {
  readonly ticker: string;
  readonly heading: string;
  /** The chain's display name, which the ticker line may cut. */
  readonly chainName: string;
  readonly row: BoardCardModel["row"];
  /** True when the card printed a shortened copy of at least one value. */
  readonly shortened: boolean;
  /**
   * CONTROLLED BY THE CARD, because the card is what has to react to it: the
   * panel covers the Spotlight button, the DexScreener link and Ask Vex, and
   * those have to leave the tab order while they cannot be seen. State owned
   * privately here could not reach them.
   */
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}): JSX.Element {
  const setOpen = onOpenChange;
  const trigger = useRef<HTMLButtonElement | null>(null);
  const close = useRef<HTMLButtonElement | null>(null);
  // The panel's id is the other half of `aria-controls`, and `useId` is what
  // keeps it unique across a board of eight cards without a counter of ours.
  const panelId = useId();

  useEffect(() => {
    if (!open) return;
    close.current?.focus();
  }, [open]);

  const dismiss = (): void => {
    setOpen(false);
    trigger.current?.focus();
  };

  const entries: readonly FullValueEntry[] = [
    { label: "Name", value: heading, figure: false },
    { label: "Ticker", value: ticker, figure: false },
    // The chain name is on the ticker line, where it concedes width, so the
    // whole of it is owed here like every other string the tile may cut.
    { label: "Chain", value: chainName, figure: false },
    { label: "Price, USD", value: row?.priceUsd ?? BOARD_EMPTY, figure: true },
    {
      label: "24h change, percent",
      value: row?.priceChange.h24 ?? BOARD_EMPTY,
      figure: true,
    },
    {
      label: "Liquidity, USD",
      value: row?.liquidityUsd ?? BOARD_EMPTY,
      figure: true,
    },
    {
      label: "24h volume, USD",
      value: row?.volumeH24Usd ?? BOARD_EMPTY,
      figure: true,
    },
  ];

  return (
    <>
      <button
        ref={trigger}
        type="button"
        data-vex-area="board-token-full-value"
        data-shortened={shortened ? "true" : undefined}
        aria-expanded={open}
        aria-controls={panelId}
        // The trigger is under the panel too. Out of the tab order while it
        // is covered, and still focusable programmatically - which is exactly
        // what `dismiss` needs and what `inert` would have taken away.
        tabIndex={open ? -1 : undefined}
        // NAMED, NOT GENERIC, once the card has actually cut something.
        aria-label={
          shortened
            ? `${BOARD_FULL_VALUE_SHORTENED_LABEL}. ${BOARD_FULL_VALUE_LABEL} for ${ticker}`
            : `${BOARD_FULL_VALUE_LABEL} for ${ticker}`
        }
        title={
          shortened
            ? `${BOARD_FULL_VALUE_SHORTENED_LABEL}. ${BOARD_FULL_VALUE_LABEL}.`
            : BOARD_FULL_VALUE_LABEL
        }
        onClick={() => {
          setOpen(true);
        }}
        // THE KEY: 26 x 26, a quiet rule, the info glyph at 14
        // (`vex-bd-tile-key` in `board-layout.css`). The cut is VISIBLE on
        // the control itself - `data-shortened` gives it the blue edge and
        // the blue glyph, the one treatment the board uses for "this needs
        // your attention" - so a reader who never opens the panel still sees
        // that this tile is showing them less than the provider sent.
        className="vex-bd-tile-key vex-tint"
      >
        <LineInfo size={14} />
      </button>
      {open ? (
        <div
          id={panelId}
          data-vex-area="board-token-full-value-popover"
          // A LABELLED GROUP, which is what this is. Not `role="dialog"`, and
          // emphatically not `aria-modal`: see the head note above. The
          // trigger's `aria-expanded` plus `aria-controls` is the whole
          // relationship a disclosure needs.
          role="group"
          aria-label={`${BOARD_FULL_VALUE_TITLE} for ${ticker}`}
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            // The board dialog is listening for Escape too, and it would
            // close the whole board behind this panel.
            event.stopPropagation();
            event.preventDefault();
            dismiss();
          }}
          className="absolute inset-0 z-10 flex flex-col gap-3 overflow-y-auto bg-board-surface px-[18px] pb-[14px] pt-4"
        >
          <div className="flex items-start justify-between gap-3">
            <p className="text-[12px] font-medium leading-[26px] text-ink-tertiary">
              {BOARD_FULL_VALUE_TITLE}
            </p>
            <button
              ref={close}
              type="button"
              data-vex-area="board-token-full-value-close"
              onClick={dismiss}
              aria-label={`Close the full values for ${ticker}`}
              className="vex-bd-tile-key vex-tint"
            >
              <LineClose size={14} />
            </button>
          </div>
          {shortened ? (
            <p
              data-vex-area="board-token-full-value-notice"
              className="text-[12.5px] leading-[18px] text-ink-secondary"
            >
              {BOARD_FULL_VALUE_SHORTENED_LABEL}. Every value below is the
              whole one.
            </p>
          ) : null}
          <dl className="flex flex-col gap-2">
            {entries.map((entry) => (
              <div key={entry.label} className="flex flex-col gap-0.5">
                <dt className="text-[12px] leading-[16px] text-ink-tertiary">
                  {entry.label}
                </dt>
                {/* `break-all` and no clamp of any kind: this is the one place
                  * on the card where the WHOLE string is the point, so a
                  * 512-character symbol wraps and the panel scrolls. */}
                <dd
                  className={cn(
                    "break-all text-[13px] leading-[18px] text-ink-primary",
                    entry.figure && "vex-num font-mono",
                  )}
                >
                  {entry.value}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      ) : null}
    </>
  );
}
