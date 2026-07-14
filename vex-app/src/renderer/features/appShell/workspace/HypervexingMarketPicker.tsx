/**
 * Market picker (design spec §13.4) — the venue-style dropdown that opens
 * from the chart header's coin button. Search over every listed row, an
 * All/Favorites filter, and a data table (Market · Last · 24h · Funding ·
 * Volume · OI) with keyboard selection.
 *
 * Data honesty: rows are a superset type. Today they come from the pushed
 * watchlist (coin/mid/24h/OI); once the full-universe markets read lands the
 * same table gains leverage badges, funding, and volume with NO layout change
 * — absent numbers render an em-dash, never an invention.
 *
 * Popover chrome is the app's solid popover idiom (dialog/select-menu):
 * surface ink + hairline, no blur of its own (the zone beneath is already
 * glass; stacking blur would violate the guard's single-wrapper sanction).
 */

import type { JSX } from "react";

import { cn } from "../../../lib/utils.js";
import { HypervexingMarketRow } from "./HypervexingMarketRow.js";
import { useMarketPicker, type HvMarketRow } from "./useMarketPicker.js";

export { filterMarketRows, type HvMarketRow } from "./useMarketPicker.js";

export function HypervexingMarketPicker({
  rows,
  favorites,
  selectedCoin,
  onToggleFavorite,
  onSelect,
  onClose,
}: {
  readonly rows: readonly HvMarketRow[];
  readonly favorites: readonly string[];
  readonly selectedCoin: string;
  readonly onToggleFavorite: (coin: string) => void;
  readonly onSelect: (coin: string) => void;
  readonly onClose: () => void;
}): JSX.Element {
  const {
    clampedCursor,
    filter,
    listRef,
    onKeyDown,
    queryText,
    searchRef,
    setFilter,
    setMouseCursor,
    setQueryText,
    visible,
  } = useMarketPicker({ rows, favorites, onSelect, onClose });
  const hasExtendedColumns = rows.some((row) => row.maxLeverage !== undefined);

  return (
    <>
      {/* Click-away scrim (transparent — the room stays visible). */}
      <button
        type="button"
        aria-label="Close market picker"
        onClick={onClose}
        className="fixed inset-0 z-20 cursor-default"
        tabIndex={-1}
      />
      <div
        role="dialog"
        aria-label="Select market"
        onKeyDown={onKeyDown}
        className="absolute left-0 top-full z-30 mt-2 flex max-h-[420px] w-[min(620px,calc(100vw-380px))] min-w-[440px] flex-col overflow-hidden rounded-xl border border-[var(--vex-line-strong)] bg-[var(--vex-surface-1)]"
      >
        <div className="flex items-center gap-2 border-b border-[var(--vex-line)] p-2.5">
          <input
            ref={searchRef}
            value={queryText}
            onChange={(event) => setQueryText(event.target.value)}
            placeholder="Search markets"
            aria-label="Search markets"
            className="h-8 min-w-0 flex-1 rounded-md border border-[var(--vex-line)] bg-[var(--vex-surface-0)] px-2.5 font-mono text-[12px] text-[var(--vex-text)] placeholder:text-[var(--vex-text-3)] focus-visible:border-[var(--vex-accent-border)] focus-visible:outline-none"
          />
          {(["all", "favorites"] as const).map((id) => (
            <button
              key={id}
              type="button"
              onClick={() => setFilter(id)}
              aria-pressed={filter === id}
              className={cn(
                "h-8 rounded-md px-3 font-mono text-[10px] uppercase tracking-[0.14em] transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ring)]",
                filter === id
                  ? "bg-[var(--vex-accent-fill-12)] text-[var(--vex-accent-text)]"
                  : "text-[var(--vex-text-3)] hover:text-[var(--vex-text-2)]",
              )}
            >
              {id === "all" ? "All" : "Favorites"}
            </button>
          ))}
        </div>

        <div className="grid grid-cols-[16px_minmax(96px,1.2fr)_1fr_0.8fr_0.9fr_0.9fr] items-center gap-2 px-3 pb-1 pt-2 font-mono text-[9px] uppercase tracking-[0.16em] text-[var(--vex-text-3)]">
          <span aria-hidden />
          <span>Market</span>
          <span className="text-right">Last</span>
          <span className="text-right">24h</span>
          <span className="text-right">{hasExtendedColumns ? "8h Funding" : "OI"}</span>
          <span className="text-right">{hasExtendedColumns ? "OI" : ""}</span>
        </div>

        <div
          ref={listRef}
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-1.5"
          role="listbox"
          aria-label="Markets"
        >
          {visible.length === 0 ? (
            <p className="px-3 py-4 text-[11px] text-[var(--vex-text-3)]">
              {filter === "favorites" && favorites.length === 0
                ? "No favorites yet — star a market to pin it here."
                : "No market matches."}
            </p>
          ) : (
            visible.map((row, index) => (
              <HypervexingMarketRow
                key={row.coin}
                row={row}
                index={index}
                selected={row.coin === selectedCoin}
                active={index === clampedCursor}
                starred={favorites.includes(row.coin)}
                hasExtendedColumns={hasExtendedColumns}
                onHover={() => setMouseCursor(index)}
                onSelect={() => {
                  onSelect(row.coin);
                  onClose();
                }}
                onToggleFavorite={() => onToggleFavorite(row.coin)}
              />
            ))
          )}
        </div>
      </div>
    </>
  );
}
