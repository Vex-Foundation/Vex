import type { JSX } from "react";

import { cn } from "../../../lib/utils.js";
import type { HvMarketRow } from "./useMarketPicker.js";

function compactUsd(value: string | null | undefined): string {
  if (value == null) return "—";
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "—";
  if (numeric >= 1_000_000_000) return `$${(numeric / 1_000_000_000).toFixed(2)}B`;
  if (numeric >= 1_000_000) return `$${(numeric / 1_000_000).toFixed(1)}M`;
  if (numeric >= 1_000) return `$${(numeric / 1_000).toFixed(1)}K`;
  return `$${numeric.toFixed(2)}`;
}

function pct(value: string | null | undefined): { readonly text: string; readonly tone: string } {
  if (value == null) return { text: "—", tone: "text-[var(--vex-text-3)]" };
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return { text: "—", tone: "text-[var(--vex-text-3)]" };
  return {
    text: `${numeric >= 0 ? "+" : ""}${numeric.toFixed(2)}%`,
    tone: numeric >= 0 ? "text-[var(--vex-long)]" : "text-[var(--vex-short)]",
  };
}

export function HypervexingMarketRow({
  row,
  index,
  selected,
  active,
  starred,
  hasExtendedColumns,
  onHover,
  onSelect,
  onToggleFavorite,
}: {
  readonly row: HvMarketRow;
  readonly index: number;
  readonly selected: boolean;
  readonly active: boolean;
  readonly starred: boolean;
  readonly hasExtendedColumns: boolean;
  readonly onHover: () => void;
  readonly onSelect: () => void;
  readonly onToggleFavorite: () => void;
}): JSX.Element {
  const change = pct(row.change24hPct);
  const funding = pct(row.fundingRate8hPct);

  return (
    <div
      data-hv-row-index={index}
      role="option"
      aria-selected={selected}
      className={cn(
        "grid cursor-pointer grid-cols-[16px_minmax(96px,1.2fr)_1fr_0.8fr_0.9fr_0.9fr] items-center gap-2 px-3 py-1.5 transition-colors duration-100",
        active
          ? "bg-[var(--vex-accent-fill-8)]"
          : "hover:bg-[var(--vex-accent-fill-8)]",
      )}
      onMouseEnter={onHover}
      onClick={onSelect}
    >
      <button
        type="button"
        aria-label={starred ? `Unstar ${row.coin}` : `Star ${row.coin}`}
        aria-pressed={starred}
        onClick={(event) => {
          event.stopPropagation();
          onToggleFavorite();
        }}
        className={cn(
          "text-[11px] leading-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ring)]",
          starred ? "text-[var(--vex-accent-text)]" : "text-[var(--vex-text-3)] hover:text-[var(--vex-text-2)]",
        )}
      >
        {starred ? "★" : "☆"}
      </button>
      <span className="flex min-w-0 items-center gap-1.5 font-mono text-[12px] tabular-nums text-[var(--vex-text)]">
        <span className="truncate">{row.coin}-USD</span>
        {row.maxLeverage !== undefined ? (
          <span className="shrink-0 rounded-sm bg-[var(--vex-accent-fill-12)] px-1 py-px font-mono text-[9px] tabular-nums text-[var(--vex-accent-text)]">
            {row.maxLeverage}x
          </span>
        ) : null}
      </span>
      <span className="text-right font-mono text-[12px] tabular-nums text-[var(--vex-text-2)]">
        {row.midPx ?? "—"}
      </span>
      <span className={cn("text-right font-mono text-[11px] tabular-nums", change.tone)}>
        {change.text}
      </span>
      {hasExtendedColumns ? (
        <>
          <span className={cn("text-right font-mono text-[11px] tabular-nums", funding.tone)}>
            {funding.text}
          </span>
          <span className="text-right font-mono text-[11px] tabular-nums text-[var(--vex-text-2)]">
            {compactUsd(row.openInterestUsd)}
          </span>
        </>
      ) : (
        <>
          <span className="text-right font-mono text-[11px] tabular-nums text-[var(--vex-text-2)]">
            {compactUsd(row.openInterestUsd)}
          </span>
          <span aria-hidden />
        </>
      )}
    </div>
  );
}
