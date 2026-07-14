/**
 * Left column v2 (design spec §13.6, zone `left`): ACCOUNT truth on top,
 * read-only EARN cards, and the session's AI-inference usage. Markets left
 * this column by owner decree — selection lives in the chart header's market
 * picker now, exactly like the venue.
 *
 * Earn stays agent-mediated only ("Ask Vex about HLP") — no deposit/withdraw
 * forms, no mutation surface here. Usage reuses the existing session-totals
 * read; absent numbers render an em-dash, never an invention.
 */

import type { JSX } from "react";

import type { HyperliquidAccountDto } from "@shared/schemas/hyperliquid.js";
import { useSubmitChat } from "../../../lib/api/chat.js";
import { useSessionUsageTotals } from "../../../lib/api/usage.js";
import { cn } from "../../../lib/utils.js";
import { HyperliquidRiskProposalPanel } from "../book/HyperliquidRiskBlock.js";
import { HlLiquidVeil } from "./HlLiquidVeil.js";
import { HypervexingRiskSetup } from "./HypervexingRiskSetup.js";

function SectionEyebrow({ children }: { readonly children: string }): JSX.Element {
  return (
    <p className="px-4 pb-1.5 pt-4 font-mono text-[10px] uppercase tracking-[0.2em] text-[var(--vex-text-3)]">
      {children}
    </p>
  );
}

function usd(value: string | null | undefined): string {
  if (value == null) return "—";
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "—";
  return `$${numeric.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}

function AccountLine({
  label,
  value,
  toneClass,
}: {
  readonly label: string;
  readonly value: string;
  readonly toneClass?: string;
}): JSX.Element {
  return (
    <div className="flex h-7 items-baseline justify-between px-4">
      <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-[var(--vex-text-3)]">
        {label}
      </span>
      <span
        className={cn(
          "font-mono text-[12px] font-semibold tabular-nums",
          toneClass ?? "text-[var(--vex-text)]",
        )}
      >
        {value}
      </span>
    </div>
  );
}

function EarnCard({
  title,
  caption,
  sessionId,
}: {
  readonly title: string;
  readonly caption: string;
  readonly sessionId: string | null;
}): JSX.Element {
  const submit = useSubmitChat();
  return (
    <div className="relative mx-3 mb-2 overflow-hidden rounded-lg bg-[var(--vex-surface-2)] p-3 transition-colors duration-150 hover:bg-[var(--vex-surface-2-up,var(--vex-surface-2))]">
      <HlLiquidVeil />
      <p className="relative text-[13px] font-semibold tracking-[0.01em] text-[var(--vex-text)]">
        {title}
      </p>
      <p className="relative mt-1 text-[11px] leading-[1.45] text-[var(--vex-text-3)]">
        {caption}
      </p>
      <button
        type="button"
        disabled={sessionId === null || submit.isPending}
        onClick={() =>
          sessionId !== null &&
          submit.mutate({
            sessionId,
            message: `Explain ${title} on Hyperliquid — current APR, how it works, and the risks. Don't move anything.`,
          })
        }
        className="mt-2.5 font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--vex-accent-text)] underline-offset-2 hover:underline disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ring)]"
      >
        {submit.isPending ? "Asking…" : `Ask Vex about ${title === "Staking" ? "staking" : "HLP"}`}
      </button>
    </div>
  );
}

function compactTokens(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return `${value}`;
}

/** Session inference meter (owner-requested §13.6): tokens + est. cost. */
function UsageCard({ sessionId }: { readonly sessionId: string | null }): JSX.Element {
  const query = useSessionUsageTotals(sessionId);
  const totals = query.data?.ok ? query.data.data : null;
  return (
    <div className="mx-3 mb-3 rounded-lg bg-[var(--vex-surface-2)] p-3">
      <p className="font-mono text-[9px] uppercase tracking-[0.18em] text-[var(--vex-text-3)]">
        AI inference · session
      </p>
      <div className="mt-2 flex items-baseline justify-between">
        <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--vex-text-3)]">
          Tokens in / out
        </span>
        <span className="font-mono text-[11px] tabular-nums text-[var(--vex-text-2)]">
          {compactTokens(totals?.totalPromptTokens)} / {compactTokens(totals?.totalCompletionTokens)}
        </span>
      </div>
      <div className="mt-1 flex items-baseline justify-between">
        <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--vex-text-3)]">
          Est. cost
        </span>
        <span className="font-mono text-[12px] font-semibold tabular-nums text-[var(--vex-text)]">
          {totals?.totalCost == null ? "—" : `$${totals.totalCost.toFixed(4)}`}
        </span>
      </div>
    </div>
  );
}

export function HypervexingLeftColumn({
  account,
  upnl,
  sessionId,
  selectedCoin,
}: {
  readonly account: HyperliquidAccountDto | null;
  /** Venue-preferred unrealized PnL (topbar derivation, shared by caller). */
  readonly upnl: number | null;
  readonly sessionId: string | null;
  /** Selected market — the risk panel names its per-asset leverage limit. */
  readonly selectedCoin: string;
}): JSX.Element {
  return (
    <aside className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <SectionEyebrow>Account</SectionEyebrow>
      <AccountLine label="Equity" value={usd(account?.equityUsd)} />
      <AccountLine label="Withdrawable" value={usd(account?.withdrawableUsd)} />
      <AccountLine
        label="Unrealized PnL"
        value={
          upnl === null || !Number.isFinite(upnl)
            ? "—"
            : `${upnl >= 0 ? "+" : ""}$${Math.abs(upnl).toLocaleString("en-US", { maximumFractionDigits: 2 })}`
        }
        toneClass={
          upnl === null || !Number.isFinite(upnl) || upnl === 0
            ? undefined
            : upnl > 0
              ? "text-[var(--vex-long)]"
              : "text-[var(--vex-short)]"
        }
      />

      {/* Pending risk setup confirms IN the room — the agent proposes here,
          the user answers here (the desk rail is unmounted in this mode). */}
      <div className="pt-3">
        <HyperliquidRiskProposalPanel sessionId={sessionId} />
      </div>

      <SectionEyebrow>Earn</SectionEyebrow>
      <EarnCard
        title="HLP vault"
        caption="Provide liquidity to Hyperliquid's market maker."
        sessionId={sessionId}
      />
      <EarnCard
        title="Staking"
        caption="Stake HYPE for protocol rewards."
        sessionId={sessionId}
      />

      {/* The former empty band (owner order): the session risk controls. */}
      <div className="pt-3">
        <HypervexingRiskSetup sessionId={sessionId} selectedCoin={selectedCoin} />
      </div>

      <div className="mt-auto pt-3">
        <UsageCard sessionId={sessionId} />
      </div>
    </aside>
  );
}
