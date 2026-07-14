/**
 * Top bar v2 (design spec §13.2, grid zone `top`). Deliberately lean:
 * wordmark · equity/uPnL cluster · always-visible EXIT. All market context
 * (symbol, leverage, mark, funding) lives in the chart header now — exactly
 * like the venue — so this bar owns identity and account truth only.
 *
 * uPnL prefers the venue-confirmed account total and falls back to the
 * position-sum derivation; Equity renders an honest em-dash when absent.
 */

import { useState, type JSX } from "react";

import type {
  HyperliquidAccountDto,
  HyperliquidPositionDto,
} from "@shared/schemas/hyperliquid.js";
import { HypervexingHelpDialog } from "./HypervexingHelpDialog.js";
import { HypervexingWordmark } from "./HypervexingWordmark.js";
import {
  directionToneClass,
  formatSignedUsd,
  sumUnrealizedPnl,
} from "./workspacePositions.js";

function Eyebrow({ children }: { readonly children: string }): JSX.Element {
  return (
    <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-[var(--vex-text-3)]">
      {children}
    </span>
  );
}

/**
 * One right-cluster stat cell. Every cell shares the SAME value size and
 * baseline so Equity and uPnL sit level (the pre-redesign bar mixed 20px and
 * 12px values, which read as misalignment).
 */
function StatCell({
  label,
  value,
  toneClass,
}: {
  readonly label: string;
  readonly value: string;
  readonly toneClass?: string;
}): JSX.Element {
  return (
    <span className="flex min-w-[76px] flex-col items-end gap-0.5 leading-none">
      <Eyebrow>{label}</Eyebrow>
      <span
        className={`font-mono text-[14px] font-semibold tabular-nums ${toneClass ?? "text-[var(--vex-text)]"}`}
      >
        {value}
      </span>
    </span>
  );
}

function usd(value: string | null | undefined): string {
  if (value == null) return "—";
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "—";
  return `$${numeric.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}

export function HypervexingTopBar({
  positions,
  account,
  onExit,
}: {
  readonly positions: readonly HyperliquidPositionDto[];
  readonly account: HyperliquidAccountDto | null;
  readonly onExit: () => Promise<boolean>;
}): JSX.Element {
  // Venue-confirmed total when available; falls back to the position-sum derivation.
  const accountUpnl = account?.totalUnrealizedPnlUsd != null ? Number(account.totalUnrealizedPnlUsd) : null;
  const upnl = accountUpnl !== null && Number.isFinite(accountUpnl) ? accountUpnl : sumUnrealizedPnl(positions);
  const [exitPending, setExitPending] = useState(false);
  const [exitFailed, setExitFailed] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const requestExit = (): void => {
    setExitPending(true);
    setExitFailed(false);
    void onExit().then((accepted) => {
      setExitPending(false);
      setExitFailed(!accepted);
    });
  };

  return (
    <header className="relative flex h-full items-center gap-4 px-4">
      {/* The desk-rule accent tick, recolored to mint by token. */}
      <span
        aria-hidden
        className="absolute bottom-0 left-4 h-px w-6 bg-[var(--vex-accent)]"
      />
      <img
        src="/protocols/hl.png"
        alt=""
        aria-hidden
        className="h-[22px] w-[22px] shrink-0 rounded-full"
      />
      <HypervexingWordmark className="text-[18px]" />

      <div className="ml-auto flex items-center gap-5">
        <StatCell label="Equity" value={usd(account?.equityUsd)} />
        <StatCell
          label="uPnL"
          value={formatSignedUsd(upnl)}
          toneClass={directionToneClass(upnl)}
        />
        <button
          type="button"
          onClick={() => setHelpOpen(true)}
          aria-label="How this room works"
          className="flex h-6 w-6 items-center justify-center rounded-full border border-[var(--vex-line-strong)] font-mono text-[11px] text-[var(--vex-text-2)] hover:border-[var(--vex-accent-border)] hover:text-[var(--vex-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ring)]"
        >
          ?
        </button>
        <HypervexingHelpDialog open={helpOpen} onOpenChange={setHelpOpen} />
        {exitFailed ? (
          <span role="alert" className="font-mono text-[10px] text-[var(--color-warning)]">
            Exit failed. Retry.
          </span>
        ) : null}
        <button
          type="button"
          onClick={requestExit}
          disabled={exitPending}
          aria-label="Exit Hypervexing"
          className="rounded-md border border-[var(--vex-line-strong)] px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.16em] text-[var(--vex-text-2)] hover:border-[var(--vex-accent-border)] hover:text-[var(--vex-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ring)]"
        >
          {exitPending ? "Exiting…" : exitFailed ? "Retry exit" : "Exit ✕"}
        </button>
      </div>
    </header>
  );
}
