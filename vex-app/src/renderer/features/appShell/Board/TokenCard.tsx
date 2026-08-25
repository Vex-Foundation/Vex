/**
 * BOARD TOKEN CARD - one pool the agent put on the board.
 *
 * THREE STATES, and they are three different facts, not one "no data":
 *
 *   unhydrated  hydration carried no row for this pool. The pool the agent
 *               named is still shown, because dropping the card would
 *               misrepresent the board; its figures are blank.
 *   partial     a row exists but its price is null. The provider answered and
 *               had no price - which is not the same as never having asked.
 *   data        a priced row.
 *
 * Every state resolves to a visible card, so a board is never a run of gaps.
 *
 * STALENESS IS STATED IN WORDS. A board is a snapshot of the market at
 * compose time, so `data-stale` drives the visible marker AND the accessible
 * name says "market data delayed". A reader on assistive tech cannot see a
 * dimmed pixel, and the age of these figures changes what they mean.
 *
 * GEOMETRY IS INHERITED ON PURPOSE. The plate, hairline, padding, display
 * numerals and micro-label register mirror `market/VexTokenCardCompact.tsx`,
 * so a board card and the sessions-rail widget read as one family rather than
 * as two designers' takes on a token card. Change one and look at the other.
 *
 * The card is inert: it links nowhere. A pair address in a persisted spec is
 * model-authored text, and turning it into an outbound URL would make the
 * agent the author of a link the reader clicks. The address is shown as text
 * and can be copied.
 */

import type { JSX } from "react";
import { cn } from "../../../lib/utils.js";
import {
  BOARD_EMPTY,
  formatBoardAge,
  formatBoardCount,
  formatBoardPercent,
  formatBoardPriceUsd,
  formatBoardUsdCompact,
  type BoardTrend,
} from "./boardFormat.js";
import type { BoardCardModel } from "./boardModel.js";

const CARD_CLASS =
  "flex flex-col gap-2 rounded-xl border border-line-2 bg-surface-1 px-3 py-2.5";

export interface TokenCardProps {
  readonly card: BoardCardModel;
  /** Whether the board's market data has outlived its freshness window. */
  readonly stale: boolean;
}

export function TokenCard({ card, stale }: TokenCardProps): JSX.Element {
  const { row } = card;
  const state =
    row === null ? "unhydrated" : row.priceUsd === null ? "partial" : "data";

  const symbol = row?.baseTokenSymbol ?? null;
  const heading = symbol ?? card.pairAddress;
  const priceLabel = formatBoardPriceUsd(row?.priceUsd ?? null);
  const deltaLabel = formatBoardPercent(row?.priceChange.h24 ?? null);

  return (
    <article
      data-vex-area="board-token-card"
      data-state={state}
      data-stale={stale ? "true" : "false"}
      aria-label={`${heading} on ${card.chain}, price ${priceLabel}, 24 hour change ${deltaLabel}${
        stale ? ", market data delayed" : ""
      }`}
      className={CARD_CLASS}
    >
      <header className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="vex-micro-label inline-flex items-center gap-1.5 self-start uppercase text-ink-secondary">
            {card.chain}
            {stale ? <StaleMarker /> : null}
          </span>
          <span
            className="truncate font-display text-[15px] font-extrabold leading-none tracking-[-0.02em] text-ink-primary"
            title={row?.baseTokenName ?? card.pairAddress}
          >
            {heading}
          </span>
          {row !== null ? (
            <span className="truncate text-[11px] text-ink-tertiary">
              {row.baseTokenSymbol}/{row.quoteTokenSymbol} on {row.dexId}
            </span>
          ) : (
            <span className="text-[11px] text-warning-label">
              No market data for this pool.
            </span>
          )}
        </div>
        <DeltaFigure trend={card.trendH24} label={deltaLabel} />
      </header>

      <div className="flex items-baseline gap-2">
        <span
          className="truncate font-display text-[17px] font-extrabold leading-none tabular-nums text-ink-primary"
          // The whole decimal string, so no digit the provider gave is lost
          // to the display precision above.
          title={row?.priceUsd ?? undefined}
        >
          {priceLabel}
        </span>
        <span className="text-[11px] tabular-nums text-ink-tertiary">
          1h {formatBoardPercent(row?.priceChange.h1 ?? null)}
        </span>
      </div>

      <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]">
        <Stat
          label="Liquidity"
          value={formatBoardUsdCompact(row?.liquidityUsd ?? null)}
          title={row?.liquidityUsd ?? undefined}
        />
        <Stat
          label="24h volume"
          value={formatBoardUsdCompact(row?.volumeH24Usd ?? null)}
          title={row?.volumeH24Usd ?? undefined}
        />
        <Stat
          label="24h trades"
          value={
            row === null
              ? BOARD_EMPTY
              : `${formatBoardCount(row.txns.buys)} / ${formatBoardCount(row.txns.sells)}`
          }
        />
        <Stat label="Pair age" value={formatBoardAge(row?.pairAgeSeconds ?? null)} />
      </dl>

      {card.caption !== null ? (
        <p
          data-vex-area="board-token-caption"
          className="text-[11px] leading-snug text-ink-secondary"
        >
          {card.caption}
        </p>
      ) : null}
    </article>
  );
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
    <div className="flex min-w-0 flex-col">
      <dt className="vex-micro-label uppercase text-ink-secondary">{label}</dt>
      <dd className="truncate tabular-nums text-ink-primary" title={title}>
        {value}
      </dd>
    </div>
  );
}

function StaleMarker(): JSX.Element {
  return (
    <span
      data-vex-area="board-stale-marker"
      className="flex items-center gap-1 text-ink-tertiary"
      title="These figures were captured when the board was composed."
    >
      <span
        aria-hidden
        className="h-[5px] w-[5px] rounded-full bg-[var(--vex-alias-state-warn)]"
      />
      delayed
    </span>
  );
}

/**
 * The 24h delta in the SEMANTIC status tone. Borderless, matching the market
 * rail's figure; no shimmer here, because a persisted snapshot is not a live
 * signal and animating it would claim a liveness the data does not have.
 */
function DeltaFigure({
  trend,
  label,
}: {
  readonly trend: BoardTrend;
  readonly label: string;
}): JSX.Element {
  return (
    <span
      data-vex-area="board-token-delta"
      data-trend={trend}
      className={cn(
        "shrink-0 text-[11px] font-semibold tabular-nums",
        trend === "up" && "text-success",
        trend === "down" && "text-warning-label",
        trend === "flat" && "text-ink-tertiary",
      )}
    >
      {label}
    </span>
  );
}
