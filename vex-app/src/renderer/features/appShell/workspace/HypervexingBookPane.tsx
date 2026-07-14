/**
 * Order book pane (design spec §13.5, zone `book`). The venue's depth ladder:
 * asks stacked above the spread row, bids below, cumulative depth painted as a
 * row-background bar in the side's fill token. Sizes stay decimal strings from
 * the DTO; numeric conversion here is rendering-only.
 *
 * Data: 2.5s poll while the pane is visible (the hook stops polling the moment
 * the pane unmounts on the narrow-viewport fold).
 */

import { useMemo, type JSX } from "react";

import type { HyperliquidBookLevelDto } from "@shared/schemas/hyperliquid.js";
import { useHyperliquidBook } from "../../../lib/api/hyperliquid.js";
import { cn } from "../../../lib/utils.js";

const VISIBLE_LEVELS = 11;

interface DepthLevel {
  readonly px: string;
  readonly sz: string;
  readonly cumulative: number;
  /** 0..1 share of the deepest visible cumulative size (bar width). */
  readonly depthShare: number;
}

export function buildDepthLadder(
  levels: readonly HyperliquidBookLevelDto[],
): readonly DepthLevel[] {
  const visible = levels.slice(0, VISIBLE_LEVELS);
  let running = 0;
  const cumulated = visible.map((level) => {
    const size = Number(level.sz);
    running += Number.isFinite(size) ? size : 0;
    return { px: level.px, sz: level.sz, cumulative: running };
  });
  const max = cumulated.length === 0 ? 0 : cumulated[cumulated.length - 1]?.cumulative ?? 0;
  return cumulated.map((level) => ({
    ...level,
    depthShare: max > 0 ? level.cumulative / max : 0,
  }));
}

export function spreadOf(
  bestBid: string | undefined,
  bestAsk: string | undefined,
): { readonly abs: string; readonly pct: string } | null {
  if (bestBid === undefined || bestAsk === undefined) return null;
  const bid = Number(bestBid);
  const ask = Number(bestAsk);
  if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0) return null;
  const abs = ask - bid;
  return { abs: abs.toPrecision(3), pct: `${((abs / bid) * 100).toFixed(3)}%` };
}

function Row({
  level,
  side,
}: {
  readonly level: DepthLevel;
  readonly side: "bid" | "ask";
}): JSX.Element {
  return (
    <div className="relative grid h-[22px] grid-cols-[1fr_1fr] items-center px-3">
      <span
        aria-hidden
        className={cn(
          "absolute inset-y-[2px] right-0 rounded-sm",
          side === "bid" ? "bg-[var(--vex-long-fill)]" : "bg-[var(--vex-short-fill)]",
        )}
        style={{ width: `${Math.round(level.depthShare * 100)}%` }}
      />
      <span
        className={cn(
          "relative font-mono text-[11px] tabular-nums",
          side === "bid" ? "text-[var(--vex-long)]" : "text-[var(--vex-short)]",
        )}
      >
        {level.px}
      </span>
      <span className="relative text-right font-mono text-[11px] tabular-nums text-[var(--vex-text-2)]">
        {level.sz}
      </span>
    </div>
  );
}

export function HypervexingBookPane({
  sessionId,
  coin,
}: {
  readonly sessionId: string | null;
  readonly coin: string;
}): JSX.Element {
  const query = useHyperliquidBook(sessionId, coin, true);
  const book = query.data?.ok ? query.data.data : null;

  const asks = useMemo(() => buildDepthLadder(book?.levels.asks ?? []), [book]);
  const bids = useMemo(() => buildDepthLadder(book?.levels.bids ?? []), [book]);
  const spread = spreadOf(book?.levels.bids[0]?.px, book?.levels.asks[0]?.px);

  return (
    <div className="flex min-h-0 flex-1 flex-col py-2.5">
      <div className="flex items-baseline justify-between px-3 pb-1.5">
        <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-[var(--vex-text-3)]">
          Order book
        </span>
        <span className="font-mono text-[10px] tabular-nums text-[var(--vex-text-3)]">
          {coin}-USD
        </span>
      </div>
      <div className="grid grid-cols-[1fr_1fr] px-3 pb-1 font-mono text-[9px] uppercase tracking-[0.14em] text-[var(--vex-text-3)]">
        <span>Price</span>
        <span className="text-right">Size</span>
      </div>

      {book === null ? (
        <p className="px-3 py-3 text-[11px] text-[var(--vex-text-3)]">
          {query.isLoading ? "Loading book…" : "Order book unavailable. Retrying."}
        </p>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col justify-center">
          <div className="flex flex-col-reverse">
            {asks.map((level) => (
              <Row key={`a:${level.px}`} level={level} side="ask" />
            ))}
          </div>
          <div className="my-1 flex items-baseline justify-between border-y border-[var(--vex-line)] px-3 py-1">
            <span className="font-mono text-[9px] uppercase tracking-[0.14em] text-[var(--vex-text-3)]">
              Spread
            </span>
            <span className="font-mono text-[10px] tabular-nums text-[var(--vex-text-2)]">
              {spread === null ? "—" : `${spread.abs} · ${spread.pct}`}
            </span>
          </div>
          <div className="flex flex-col">
            {bids.map((level) => (
              <Row key={`b:${level.px}`} level={level} side="bid" />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
