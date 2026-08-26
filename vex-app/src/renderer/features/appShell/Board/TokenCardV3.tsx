/**
 * TOKEN CARD (v3) - one pool, in the anatomy the owner's mockup fixes.
 *
 * Read top to bottom, the card is: a 64px round token photo, the token's name
 * over its ticker over its chain mark, a hero price with a signed 24h delta
 * and a sparkline in the right third of that row, a hairline, four equal stat
 * columns, and a status chip. The two actions - Spotlight and Ask VEX - are
 * real buttons.
 *
 * EQUAL CARDS ARE A CONTRACT, NOT A CONSEQUENCE. A grid of cards whose
 * heights follow their content reads as damage. So the identity block, the
 * price row and the stat block each carry a FIXED height, names are clamped
 * to one line rather than allowed to wrap a card taller, and the action row
 * is pushed to the bottom with `mt-auto`. A token with a long name, no photo
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
 * THE PHOTO IS TWO-STATE BY DESIGN. Roughly half of board pools carry no
 * profile artwork, so the monogram is what most cards wear rather than an
 * error state. It is `aria-hidden` either way: the ticker is already in the
 * accessible name and a screen reader gains nothing from hearing it twice.
 */

import { type JSX } from "react";
import {
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
  "vex-board-card group flex h-full flex-col rounded-2xl border border-line-2 bg-board-card px-5 py-[18px] " +
  "transition-[background-color,border-color,box-shadow] duration-150 " +
  "hover:border-line-3 hover:bg-board-card-hover hover:shadow-lv2 motion-reduce:transition-none";

export interface TokenCardV3Props {
  readonly card: BoardCardModel;
  readonly verdict: BoardSafetyVerdict;
  readonly sparkline: BoardSparklineData;
  /** True when the modal's spotlight is currently about THIS pool. */
  readonly selected: boolean;
  readonly onSpotlight: () => void;
  readonly onAsk: () => void;
}

export function TokenCardV3({
  card,
  verdict,
  sparkline,
  selected,
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

  return (
    <article
      data-vex-area="board-token-card-v3"
      data-state={state}
      data-selected={selected ? "true" : "false"}
      aria-label={`${ticker} on ${card.chain}, price ${priceLabel}, 24 hour change ${deltaLabel}, ${statusLabel}`}
      className={CARD_CLASS}
    >
      {/* IDENTITY. Fixed height so a two-line name in one card cannot push
        * every price row in its row of cards out of alignment. */}
      <header className="flex h-16 items-center gap-3.5">
        <TokenPhoto iconId={row?.iconId ?? null} symbol={symbol} />
        <div className="flex min-w-0 flex-1 flex-col gap-[3px]">
          <span
            data-vex-area="board-token-name"
            className="truncate font-display text-[20px] font-bold leading-[24px] tracking-[-0.02em] text-ink-primary"
            title={heading}
          >
            {heading}
          </span>
          <span
            data-vex-area="board-token-ticker"
            className="truncate text-[13px] leading-[16px] text-ink-tertiary"
          >
            {ticker}
          </span>
          <span
            data-vex-area="board-token-chain"
            className="flex items-center gap-1.5"
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
      <div className="mt-3.5 flex h-[42px] items-center gap-3">
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
        <div className="w-[34%] shrink-0">
          <BoardSparkline data={sparkline} trend={card.trendH24} />
        </div>
      </div>

      <div className="mt-3.5 h-px w-full bg-line-2" aria-hidden />

      {/* THE FOUR FIGURES. A `dl` with four equal columns: the label sits
        * ABOVE its value, as the mockup has it, and `grid-cols-4` keeps the
        * columns aligned across every card in the grid regardless of how wide
        * any one value renders. */}
      <dl
        data-vex-area="board-token-stats"
        className="mt-3.5 grid h-[46px] grid-cols-4 gap-x-3"
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

      {/* ACTIONS. `mt-auto` pins this row to the bottom of the plate, so a
        * row of cards has its chips and its buttons on one line whatever
        * happens above them. */}
      <div className="mt-auto flex items-center justify-between gap-3 pt-4">
        <BoardStatusChip
          verdict={verdict}
          pairAgeSeconds={row?.pairAgeSeconds ?? null}
        />
        <button
          type="button"
          data-vex-area="board-card-ask"
          onClick={onAsk}
          aria-label={`Ask VEX about ${ticker}`}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-line-2 px-2.5 py-1.5 text-[12.5px] font-medium text-ink-secondary transition-colors duration-150 hover:border-line-3 hover:bg-interactive-hover hover:text-ink-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
        >
          <IconSparkle size={14} />
          Ask VEX
        </button>
      </div>
    </article>
  );
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
        "inline-flex shrink-0 items-center gap-1.5 self-start rounded-lg border px-2.5 py-1.5 text-[12.5px] font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none",
        selected
          ? "border-accent-primary/50 bg-accent-wash text-accent-primary"
          : "border-line-2 text-ink-secondary hover:border-line-3 hover:bg-interactive-hover hover:text-ink-primary",
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
      <dt className="truncate text-[12px] leading-[16px] text-ink-tertiary">
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

