/**
 * ONE COMPACT TOKEN ROW in the BOOK's Active board module.
 *
 * The rail is narrow, so the row carries only the four facts that make a
 * token recognisable at a glance: its photo, its symbol, its price and its
 * 24h move. Everything else about that token lives one press away, in the
 * board itself.
 *
 * THE ROW IS A BUTTON. It opens the board on THIS token's spotlight, so it is
 * reachable by keyboard and by touch like any other control - never a
 * hover-revealed affordance and never a div with a click handler.
 *
 * The figures are read from the SAME `BoardCardModel` the grid and the
 * preview card render, so a price here can never disagree with the price on
 * the card it stands for.
 */

import { useState, type JSX } from "react";
import {
  boardTokenIconDataUrl,
  useBoardTokenIcon,
} from "../../../../lib/api/board-icons.js";
import { cn } from "../../../../lib/utils.js";
import {
  BOARD_EMPTY,
  formatBoardPercent,
  formatBoardPriceUsd,
} from "../../Board/boardFormat.js";
import type { BoardCardModel } from "../../Board/boardModel.js";

export function ActiveBoardRow({
  card,
  active,
  onOpen,
}: {
  readonly card: BoardCardModel;
  /** True when this token is the one the open spotlight is showing. */
  readonly active: boolean;
  readonly onOpen: () => void;
}): JSX.Element {
  const row = card.row;
  const symbol = row?.baseTokenSymbol ?? null;
  const price = formatBoardPriceUsd(row?.priceUsd ?? null);
  const delta = formatBoardPercent(row?.priceChange.h24 ?? null);

  return (
    <button
      type="button"
      data-vex-area="active-board-row"
      data-active={active ? "true" : "false"}
      data-trend={card.trendH24}
      onClick={onOpen}
      aria-label={`${symbol ?? card.pairAddress}, ${price}, ${delta} over 24 hours${
        active ? ", shown in the spotlight" : ""
      }`}
      className={cn(
        "flex w-full items-center gap-2 rounded-lg border px-2 py-1.5 text-left transition-colors duration-150 hover:bg-interactive-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none",
        active
          ? "border-accent-primary/50 bg-accent-wash"
          : "border-transparent",
      )}
    >
      <TokenPhoto iconId={row?.iconId ?? null} symbol={symbol} />
      <span
        data-vex-area="active-board-row-symbol"
        className="min-w-0 flex-1 truncate text-[12.5px] font-semibold leading-[16px] text-ink-primary"
      >
        {symbol ?? BOARD_EMPTY}
      </span>
      <span
        data-vex-area="active-board-row-price"
        className="shrink-0 text-[12.5px] leading-[16px] tabular-nums text-ink-secondary"
        title={row?.priceUsd ?? undefined}
      >
        {price}
      </span>
      <span
        data-vex-area="active-board-row-delta"
        className={cn(
          "w-[62px] shrink-0 text-right text-[12px] font-semibold leading-[16px] tabular-nums",
          card.trendH24 === "up"
            ? "text-success"
            : card.trendH24 === "down"
              ? "text-danger"
              : "text-ink-tertiary",
        )}
      >
        {delta}
      </span>
    </button>
  );
}

/**
 * The token's real photo, with the monogram as its designed second state.
 *
 * Same two-state contract as the grid card's 64px photo, at rail size. A
 * photo that fails to decode falls back rather than leaving a hole, and the
 * failing URL is remembered so the fallback does not flicker on re-render.
 */
function TokenPhoto({
  iconId,
  symbol,
}: {
  readonly iconId: string | null;
  readonly symbol: string | null;
}): JSX.Element {
  const query = useBoardTokenIcon(iconId);
  const dataUrl = boardTokenIconDataUrl(query);
  const [undecodableUrl, setUndecodableUrl] = useState<string | null>(null);
  const shell =
    "h-5 w-5 shrink-0 rounded-full border border-line-2 bg-surface-2";

  if (dataUrl !== null && dataUrl !== undecodableUrl) {
    return (
      <img
        data-vex-area="active-board-row-photo"
        data-state="image"
        src={dataUrl}
        alt=""
        onError={() => {
          setUndecodableUrl(dataUrl);
        }}
        className={cn(shell, "object-cover")}
      />
    );
  }
  return (
    <span
      data-vex-area="active-board-row-photo"
      data-state="monogram"
      aria-hidden
      className={cn(
        shell,
        "flex items-center justify-center font-display text-[9px] font-bold leading-none text-ink-secondary",
      )}
    >
      {monogram(symbol)}
    </span>
  );
}

function monogram(symbol: string | null): string {
  if (symbol === null) return "?";
  const characters = Array.from(symbol.replace(/^\$/, "").trim());
  if (characters.length === 0) return "?";
  return characters.slice(0, 2).join("").toUpperCase();
}
