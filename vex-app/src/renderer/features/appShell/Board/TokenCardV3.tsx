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
 */

import { useRef, type JSX } from "react";
import {
  IconArrowUpRight,
  IconFullscreen,
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
  "vex-board-card group flex h-full flex-col rounded-2xl border bg-board-card px-5 py-5 " +
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
            className="truncate text-[13px] uppercase leading-[16px] text-ink-tertiary"
          >
            {ticker}
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
        <SpotlightAction
          symbol={ticker}
          selected={selected}
          onSpotlight={onSpotlight}
        />
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
        <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
          <span
            data-vex-area="board-token-price"
            className="min-w-0 truncate font-display text-[28px] font-bold leading-[34px] tracking-[-0.02em] tabular-nums text-ink-primary"
            // The WHOLE decimal string, so no digit the provider reported is
            // lost to the display precision above it.
            title={row?.priceUsd ?? undefined}
          >
            {priceLabel}
          </span>
          <span
            data-vex-area="board-token-delta"
            data-trend={card.trendH24}
            className={cn(
              "text-[15px] font-semibold leading-[20px] tabular-nums",
              deltaToneClass(card.trendH24),
            )}
          >
            {deltaLabel}
          </span>
          <span
            data-vex-area="board-token-delta-window"
            className="text-[13px] leading-[18px] text-ink-tertiary"
          >
            24h
          </span>
        </div>
        <div className="h-[44px] w-[30%] shrink-0">
          <BoardSparkline data={sparkline} trend={card.trendH24} />
        </div>
      </div>

      <div className="mt-4 h-px w-full bg-line-2" aria-hidden />

      {/* THE FOUR FIGURES. A `dl` with four equal columns: the label sits
        * ABOVE its value, as the mockup has it, and `grid-cols-4` keeps the
        * columns aligned across every card in the grid regardless of how wide
        * any one value renders. */}
      <dl
        data-vex-area="board-token-stats"
        className="mt-4 grid h-[46px] grid-cols-4 gap-x-3"
      >
        <Stat
          label="Liquidity"
          value={formatBoardUsdCompact(row?.liquidityUsd ?? null)}
          title={row?.liquidityUsd ?? undefined}
        />
        <Stat
          label="24h Volume"
          value={formatBoardUsdCompact(row?.volumeH24Usd ?? null)}
          title={row?.volumeH24Usd ?? undefined}
        />
        <Stat
          label="Trades"
          value={
            row === null
              ? BOARD_EMPTY
              : formatBoardTradeTotal(row.txns.buys, row.txns.sells)
          }
        />
        <Stat
          label="Pair age"
          value={formatBoardAge(row?.pairAgeSeconds ?? null)}
        />
      </dl>

      {/* FOOTER. `mt-auto` pins this row to the bottom of the plate, so a
        * row of cards has its chips and its buttons on one line whatever
        * happens above them. */}
      <div className="mt-auto flex items-center justify-between gap-3 pt-4">
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
  value,
  title,
}: {
  readonly label: string;
  readonly value: string;
  readonly title?: string | undefined;
}): JSX.Element {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <dt className="truncate text-[13px] leading-[16px] text-ink-tertiary">
        {label}
      </dt>
      <dd
        className="truncate text-[15px] font-semibold leading-[20px] tabular-nums text-ink-primary"
        title={title}
      >
        {value}
      </dd>
    </div>
  );
}
