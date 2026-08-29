/**
 * TOKEN CARD (v3) - one pool, in the anatomy the owner's mockup fixes.
 *
 * Read top to bottom, the card is: a 64px round token photo, the token's name
 * over its ticker over its bare chain mark, a hero price with a signed 24h
 * delta and a bare sparkline in the right third of that row, a hairline, four
 * equal stat columns, and a footer of the status chip beside Ask VEX. The two
 * actions - Spotlight and Ask VEX - are real buttons.
 *
 * EQUAL CARDS ARE A CONTRACT, NOT A CONSEQUENCE. A grid of cards whose
 * heights follow their content reads as damage. So the identity block, the
 * price row and the stat block each carry a FIXED height, names are clamped
 * to one line rather than allowed to wrap a card taller, and the footer is
 * pushed to the bottom with `mt-auto`. A token with a long name, no photo
 * and no sparkline occupies exactly the same box as one with all three.
 *
 * SPOTLIGHT IS A BUTTON, NOT A SWITCH (owner's correction over the mockup's
 * own control). It navigates: pressing it changes which view the modal is
 * showing. A switch would claim the card carries a persistent per-token
 * setting, and a reader who found it "on" would have no idea what it was
 * doing. `aria-pressed` still reports which card the spotlight is currently
 * about, so the selected state is not left to a border colour.
 *
 * THREE DATA STATES, and each is a designed state of the SAME elements, never
 * a missing element: a pool with no hydration row, a row whose price the
 * provider did not report, and a priced row. A board is never a run of gaps -
 * dropping a card would misrepresent the board the model actually composed.
 *
 * THE LIVE TICK. When `priceUsd` or the 24h delta changes under a held lease
 * the price row is stamped with a fresh `data-tick`, and `board.css` flashes
 * the accent wash off it once. An unchanged rerender stamps nothing, so a
 * board that repaints for an unrelated reason does not blink. The chip and
 * the delta colour are never animated: a tone is a fact, not a flash.
 *
 * NO ICON SITS ON A DISC. The chain mark, the chip's glyph and the Ask VEX
 * sparkle are bare `currentColor` glyphs; the one round container on the
 * card is the token photo itself.
 *
 * TWO ANATOMIES, ONE CARD, AND CSS PICKS. The board plate is a container
 * query container and `global-css/board-layout.css` owns every threshold; the
 * card carries the classes and reads the mode's values out of custom
 * properties. In WIDE mode the sparkline sits in the price row, the stats are
 * four columns and the footer is one line. In COMPACT mode the sparkline
 * moves to its own full-width slot, the stats go 2x2 and the footer stacks
 * the chip above the actions. Nothing here knows a pixel: there is no solver,
 * no ResizeObserver and no window read, so opening the Ask VEX drawer changes
 * the layout in the same paint that changes the container.
 *
 * NOTHING IS RECOVERED BY HOVER. `title` is a pointer convenience and never
 * the only way back to a cut string, so every card carries one always-present
 * `FullValueDisclosure` button: a real `<button>`, in the tab order, that
 * opens the whole name, the whole ticker and the RAW provider decimals, and
 * whose own tab sequence is contained the way a `role="dialog"` over obscured
 * controls must be. It is present unconditionally on purpose - a card is
 * always rounding something - but it is not SILENT about the difference
 * between rounding and cutting: when the card printed a shortened copy of a
 * value it says so, in the button's accessible name, in the button's own
 * treatment, and again at the top of the panel.
 *
 * WHAT DECIDES "SHORTENED" IS THE DATA, NOT THE LAYOUT. `boardCardValueBudget
 * .ts` owns a character budget per region, derived from the same measurement
 * matrix the CSS floors come from, and it runs before layout exists. No
 * JavaScript here reads a width back, and no threshold leaves the stylesheet:
 * a budget decides how much of a string is worth printing, never how many
 * columns the board has or which anatomy a card wears.
 */

import {
  useEffect,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import {
  IconArrowUpRight,
  IconClose,
  IconFullscreen,
  IconInfo,
  IconSparkle,
} from "../../../components/icons/index.js";
import { ChainSlugIcon } from "../../../components/common/ChainIcon.js";
import { cn } from "../../../lib/utils.js";
import { BoardSparkline, type BoardSparklineData } from "./BoardSparkline.js";
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
  BOARD_CARD_DELTA_MAX_CHARS,
  BOARD_CARD_PRICE_MAX_CHARS,
  BOARD_CARD_STAT_MAX_CHARS,
  BOARD_CARD_TICKER_MAX_CHARS,
  type BoardCardValue,
} from "./boardCardValueBudget.js";
import type { BoardCardModel } from "./boardModel.js";
import type { BoardSafetyVerdict } from "./board-surface-contracts.js";

/**
 * The card plate.
 *
 * The hover treatment moves COLOUR and ELEVATION only, never geometry: a card
 * that scaled or lifted on hover would reflow the grid under the pointer.
 * `motion-reduce:transition-none` stills it outright, which a decorative
 * transition must survive - the card is fully legible with no transition at
 * all. The focus ring is on the card's own INTERACTIVE children, not on the
 * plate: the plate is not focusable, and a ring around a non-target is noise.
 */
const CARD_CLASS =
  "vex-board-card group relative flex h-full w-full min-w-0 flex-col overflow-hidden rounded-2xl border bg-board-card px-5 py-5 " +
  "transition-[background-color,border-color,box-shadow] duration-150 " +
  "hover:border-line-3 hover:bg-board-card-hover hover:shadow-lv2 motion-reduce:transition-none";

export interface TokenCardV3Props {
  readonly card: BoardCardModel;
  readonly verdict: BoardSafetyVerdict;
  readonly sparkline: BoardSparklineData;
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
  sparkline,
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
  const priceLabel = formatBoardPriceUsd(row?.priceUsd ?? null);
  const deltaLabel = formatBoardPercent(row?.priceChange.h24 ?? null);
  const statusLabel = boardStatusChipLabel(verdict, row?.pairAgeSeconds ?? null);
  const tick = useLiveTick(live, row?.priceUsd ?? null, row?.priceChange.h24 ?? null);

  // WHAT THE CARD WILL PRINT, and what it had to shorten to print it. The
  // budgets belong to `boardCardValueBudget.ts`; the accessible name below
  // and the disclosure panel both keep the WHOLE strings, so nothing here
  // removes a value from the reader - it decides which copy is on the plate.
  const printedTicker = boardCardValue(ticker, BOARD_CARD_TICKER_MAX_CHARS);
  const printedPrice = boardCardValue(priceLabel, BOARD_CARD_PRICE_MAX_CHARS);
  const printedDelta = boardCardValue(deltaLabel, BOARD_CARD_DELTA_MAX_CHARS);
  const stats: readonly {
    readonly label: string;
    readonly printed: BoardCardValue;
    readonly title: string | undefined;
  }[] = [
    {
      label: "Liquidity",
      printed: boardCardValue(
        formatBoardUsdCompact(row?.liquidityUsd ?? null),
        BOARD_CARD_STAT_MAX_CHARS,
      ),
      title: row?.liquidityUsd ?? undefined,
    },
    {
      label: "24h Volume",
      printed: boardCardValue(
        formatBoardUsdCompact(row?.volumeH24Usd ?? null),
        BOARD_CARD_STAT_MAX_CHARS,
      ),
      title: row?.volumeH24Usd ?? undefined,
    },
    {
      label: "Trades",
      printed: boardCardValue(
        row === null
          ? BOARD_EMPTY
          : formatBoardTradeTotal(row.txns.buys, row.txns.sells),
        BOARD_CARD_STAT_MAX_CHARS,
      ),
      title: undefined,
    },
    {
      label: "Pair age",
      printed: boardCardValue(
        formatBoardAge(row?.pairAgeSeconds ?? null),
        BOARD_CARD_STAT_MAX_CHARS,
      ),
      title: undefined,
    },
  ];
  // The NAME is deliberately not in this list: it keeps its CSS ellipsis by
  // product decision, and its whole string is in the `title`, in the card's
  // accessible name and in the disclosure.
  const shortened = anyShortened([
    printedTicker,
    printedPrice,
    printedDelta,
    ...stats.map((stat) => stat.printed),
  ]);

  return (
    <article
      data-vex-area="board-token-card-v3"
      data-state={state}
      data-selected={selected ? "true" : "false"}
      aria-label={`${ticker} on ${card.chain}, price ${priceLabel}, 24 hour change ${deltaLabel}, ${statusLabel}`}
      className={cn(CARD_CLASS, selected ? "border-accent-primary/40" : "border-line-2")}
    >
      {/* IDENTITY. Fixed height so a two-line name in one card cannot push
        * every price row in its row of cards out of alignment. */}
      <header className="flex h-16 items-center gap-4">
        <TokenPhoto iconId={row?.iconId ?? null} symbol={symbol} />
        <div className="flex min-w-0 flex-1 flex-col gap-[3px]">
          <span
            data-vex-area="board-token-name"
            className="truncate font-display text-[20px] font-bold leading-[24px] tracking-[-0.02em] text-ink-primary"
            // The WHOLE name: the visual clamp is CSS, the string is intact
            // here and in the accessible name.
            title={heading}
          >
            {heading}
          </span>
          <span
            data-vex-area="board-token-ticker"
            data-shortened={printedTicker.shortened ? "true" : undefined}
            className="truncate text-[13px] uppercase leading-[16px] text-ink-tertiary"
            title={ticker}
          >
            {printedTicker.text}
          </span>
          <span
            data-vex-area="board-token-chain"
            className="flex h-[18px] items-center"
            title={card.chain}
          >
            <ChainSlugIcon chainSlug={card.chain} size={18} />
            <span className="sr-only">{card.chain}</span>
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-2 self-start">
          <FullValueDisclosure
            ticker={ticker}
            heading={heading}
            row={row}
            shortened={shortened}
          />
          <SpotlightAction
            symbol={ticker}
            selected={selected}
            onSpotlight={onSpotlight}
          />
        </div>
      </header>

      {/* PRICE. The hero numeral, the qualified delta, and the sparkline in
        * the right third - one row, fixed height, three things that are read
        * together. The window ("24h") is printed beside the figure rather
        * than left to a legend, so "+661.00%" cannot be read as a lifetime
        * move. */}
      <div
        data-vex-area="board-token-price-row"
        data-tick={tick}
        className="mt-4 flex h-[44px] items-end gap-3 rounded-md"
      >
        {/* NOWRAP, and that is the fix for a defect the matrix caught at
          * 1920px with no drawer at all: with `flex-wrap` the browser pushed
          * the delta and its `24h` window onto a second line rather than
          * shrinking the price, and the row's fixed 44px had no room for it.
          * Nowrap makes the price the one element that concedes width - the
          * right priority, because the delta and the window are short, fixed
          * and meaningless apart, and because the disclosure in the header
          * carries the whole decimal string either way. */}
        <div className="flex min-w-0 flex-1 flex-nowrap items-baseline gap-x-2.5">
          <span
            data-vex-area="board-token-price"
            data-shortened={printedPrice.shortened ? "true" : undefined}
            className="min-w-0 truncate font-display text-[28px] font-bold leading-[34px] tracking-[-0.02em] tabular-nums text-ink-primary"
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
              "shrink-0 text-[15px] font-semibold leading-[20px] tabular-nums",
              deltaToneClass(card.trendH24),
            )}
            title={printedDelta.shortened ? deltaLabel : undefined}
          >
            {printedDelta.text}
          </span>
          <span
            data-vex-area="board-token-delta-window"
            className="shrink-0 text-[13px] leading-[18px] text-ink-tertiary"
          >
            24h
          </span>
        </div>
        {/* WIDE mode only. `board-layout.css` gives this a fixed 132px rather
          * than a percentage: a percentage shrinks the figures' budget faster
          * than the card shrinks, which is what pushed the delta out of the
          * row in the first place. */}
        <div
          data-vex-area="board-token-sparkline-inline"
          className="vex-board-card-sparkline-inline"
        >
          <BoardSparkline data={sparkline} trend={card.trendH24} />
        </div>
      </div>

      {/* COMPACT mode only, and this is why compact loses no data: the line
        * is not deleted when it will not fit beside the figures, it moves
        * under them into a slot of its own. */}
      <div
        data-vex-area="board-token-sparkline-slot"
        className="vex-board-card-sparkline-slot w-full"
      >
        <BoardSparkline data={sparkline} trend={card.trendH24} />
      </div>

      <div className="mt-4 h-px w-full bg-line-2" aria-hidden />

      {/* THE FOUR FIGURES. A `dl` with four equal columns: the label sits
        * ABOVE its value, as the mockup has it, and `grid-cols-4` keeps the
        * columns aligned across every card in the grid regardless of how wide
        * any one value renders. */}
      <dl
        data-vex-area="board-token-stats"
        className="vex-board-card-stats mt-4"
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

      {/* FOOTER. `mt-auto` pins this row to the bottom of the plate, so a
        * row of cards has its chips and its buttons on one line whatever
        * happens above them. */}
      {/* In WIDE mode this is one line with the chip against the actions; in
        * COMPACT it stacks, which is what lets the chip print
        * "Checks unavailable in this response" - 242px, the widest string the
        * frozen safety table can produce - beside nothing instead of
        * ellipsizing beside two buttons. `board-layout.css` owns the switch. */}
      <div
        data-vex-area="board-token-footer"
        className="vex-board-card-footer mt-auto pt-4"
      >
        <BoardStatusChip
          verdict={verdict}
          pairAgeSeconds={row?.pairAgeSeconds ?? null}
        />
        <div className="flex shrink-0 items-center gap-2">
          <DexscreenerLink chain={card.chain} pairAddress={card.pairAddress} ticker={ticker} />
            <button
            type="button"
            data-vex-area="board-card-ask"
            onClick={onAsk}
            aria-label={`Ask VEX about ${ticker}`}
            className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-line-2 px-2.5 text-[12.5px] font-medium text-ink-secondary transition-colors duration-150 hover:border-line-3 hover:bg-interactive-hover hover:text-ink-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
          >
            <IconSparkle size={14} />
            Ask VEX
          </button>
        </div>
      </div>
    </article>
  );
}

/**
 * The provider's own page for this pool, ALWAYS present.
 *
 * A passive external link: `target="_blank"` never opens a child window
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
}: {
  readonly chain: string;
  readonly pairAddress: string;
  readonly ticker: string;
  readonly className?: string;
}): JSX.Element {
  return (
    <a
      href={dexscreenerPairUrl(chain, pairAddress)}
      target="_blank"
      rel="noopener noreferrer"
      data-vex-area="board-token-dexscreener-link"
      aria-label={`Open ${ticker} on DexScreener`}
      className={cn(
        "inline-flex h-8 shrink-0 items-center gap-1 rounded-lg px-1.5 text-[12.5px] font-medium text-ink-tertiary transition-colors duration-150 hover:text-ink-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none",
        className,
      )}
    >
      DexScreener
      <IconArrowUpRight size={12} />
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
 * unreachable by keyboard and by touch, and this is the card's primary
 * action. What hover does change is its emphasis, which is decoration a
 * reduced-motion reader loses nothing by not seeing.
 */
function SpotlightAction({
  symbol,
  selected,
  onSpotlight,
}: {
  readonly symbol: string;
  readonly selected: boolean;
  readonly onSpotlight: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      data-vex-area="board-card-spotlight"
      data-selected={selected ? "true" : "false"}
      aria-pressed={selected}
      aria-label={`Spotlight ${symbol}`}
      onClick={onSpotlight}
      className={cn(
        "inline-flex h-7 shrink-0 items-center gap-1.5 self-start rounded-capsule border px-3 text-[13px] font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none",
        selected
          ? "border-accent-primary/40 bg-accent-wash text-accent-primary"
          : "border-line-2 text-ink-secondary hover:bg-interactive-hover hover:text-ink-primary",
      )}
    >
      <IconFullscreen size={14} />
      Spotlight
    </button>
  );
}

function deltaToneClass(trend: BoardTrend): string {
  if (trend === "up") return "text-success";
  if (trend === "down") return "text-danger";
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
  // a reader is about to act on; the mode floors in `board-layout.css` are
  // sized so every realistic pair fits whole (binding label "24h Volume" at
  // 66px, binding value "$998.8K" at 63px). A schema extreme that cannot fit
  // is shortened by `boardCardValueBudget.ts` BEFORE it gets here, so what
  // reaches this cell always fits and always says whether it is the whole
  // figure - rather than being clipped by the card with nothing reporting it.
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <dt className="whitespace-nowrap text-[13px] leading-[16px] text-ink-tertiary">
        {label}
      </dt>
      <dd
        data-shortened={printed.shortened ? "true" : undefined}
        className="whitespace-nowrap text-[15px] font-semibold leading-[20px] tabular-nums text-ink-primary"
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
 * `<dialog>` already owns the focus trap, and a portal to `document.body`
 * would put the panel outside it. Initial focus goes to the close button,
 * Escape closes, and focus returns to the trigger - the three obligations a
 * dialog-nested disclosure has, met without touching the dialog primitive.
 *
 * Escape is stopped from propagating while the panel is open, so closing the
 * panel does not also close the board behind it.
 *
 * AND ITS TAB SEQUENCE IS CONTAINED, which a `role="dialog"` over obscured
 * controls owes its reader (WAI modal-dialog pattern). The panel covers the
 * card, but the card's own buttons - the Spotlight trigger, DexScreener, Ask
 * VEX - are still in the document after it, so without the trap below a Tab
 * from the close button lands on a control nobody can see, and an Escape from
 * there is no longer this panel's to stop: it reaches the board `<dialog>`
 * and closes the whole board.
 */
function FullValueDisclosure({
  ticker,
  heading,
  row,
  shortened,
}: {
  readonly ticker: string;
  readonly heading: string;
  readonly row: BoardCardModel["row"];
  /** True when the card printed a shortened copy of at least one value. */
  readonly shortened: boolean;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const close = useRef<HTMLButtonElement | null>(null);
  const panel = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    close.current?.focus();
  }, [open]);

  const dismiss = (): void => {
    setOpen(false);
    trigger.current?.focus();
  };

  /**
   * The trap. It lives on the panel's own `keydown`, so it can only run while
   * focus is already inside: there is no document listener to leak, nothing
   * to unregister, and a card whose panel is closed costs nothing.
   */
  const trap = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== "Tab") return;
    const host = panel.current;
    if (host === null) return;
    const focusable = [
      ...host.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    ];
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (first === undefined || last === undefined) {
      // Nothing to move to, so the only correct move is not to move: letting
      // Tab through would put focus on the card behind the panel.
      event.preventDefault();
      return;
    }
    const active = document.activeElement;
    const inside = active instanceof Node && host.contains(active);
    if (event.shiftKey) {
      if (!inside || active === first) {
        event.preventDefault();
        last.focus();
      }
      return;
    }
    if (!inside || active === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const entries: readonly FullValueEntry[] = [
    { label: "Name", value: heading },
    { label: "Ticker", value: ticker },
    { label: "Price, USD", value: row?.priceUsd ?? BOARD_EMPTY },
    { label: "24h change, percent", value: row?.priceChange.h24 ?? BOARD_EMPTY },
    { label: "Liquidity, USD", value: row?.liquidityUsd ?? BOARD_EMPTY },
    { label: "24h volume, USD", value: row?.volumeH24Usd ?? BOARD_EMPTY },
  ];

  return (
    <>
      <button
        ref={trigger}
        type="button"
        data-vex-area="board-token-full-value"
        data-shortened={shortened ? "true" : undefined}
        aria-expanded={open}
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
        className={cn(
          "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border text-ink-tertiary transition-colors duration-150 hover:border-line-3 hover:bg-interactive-hover hover:text-ink-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none",
          // The cut is VISIBLE on the control itself, in the one treatment
          // the card already uses to mean "this needs your attention", so a
          // reader who never opens the panel still sees that this card is
          // showing them less than the provider sent.
          shortened
            ? "border-accent-primary/40 bg-accent-wash text-accent-primary"
            : "border-line-2",
        )}
      >
        <IconInfo size={14} />
      </button>
      {open ? (
        <div
          ref={panel}
          data-vex-area="board-token-full-value-popover"
          role="dialog"
          aria-modal="true"
          aria-label={`${BOARD_FULL_VALUE_TITLE} for ${ticker}`}
          onKeyDown={(event) => {
            if (event.key === "Tab") {
              trap(event);
              return;
            }
            if (event.key !== "Escape") return;
            // The board dialog is listening for Escape too, and it would
            // close the whole board behind this panel.
            event.stopPropagation();
            event.preventDefault();
            dismiss();
          }}
          className="absolute inset-0 z-10 flex flex-col gap-3 overflow-y-auto rounded-2xl border border-line-2 bg-board-card px-5 py-5"
        >
          <div className="flex items-start justify-between gap-3">
            <p className="font-display text-[15px] font-semibold leading-[20px] text-ink-primary">
              {BOARD_FULL_VALUE_TITLE}
            </p>
            <button
              ref={close}
              type="button"
              data-vex-area="board-token-full-value-close"
              onClick={dismiss}
              aria-label={`Close the full values for ${ticker}`}
              className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-ink-tertiary hover:bg-interactive-hover hover:text-ink-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <IconClose size={14} />
            </button>
          </div>
          {shortened ? (
            <p
              data-vex-area="board-token-full-value-notice"
              className="text-[12px] leading-[16px] text-ink-secondary"
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
                <dd className="break-all text-[13px] leading-[18px] text-ink-primary">
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
