/**
 * One Agent Scan feed row — the LOGICAL activity (never a per-leg row) plus
 * its expandable audit detail.
 *
 * The row: protocol mark · ActivityBadge (kind·role + attention status) ·
 * `IN → OUT` legs · USD estimate · chain/route · time · TX↗.
 *
 * The detail (collapsed by default): every sibling execution leg with its own
 * chain, status and explorer link; the recorded Vex fee; the failure code and
 * redacted reason on a failed row; the last successful tracking check on a
 * pending one. A bridge shows ONE logical row here with its legs nested — the
 * feed never fans a bridge out into several top-level rows, because the audit
 * question is "what did this bridge do?", not "how many database rows did it
 * write?".
 *
 * EXPLORER LINKS ARE MAIN-RESOLVED. Both `entry.explorerUrl` and each leg's
 * `explorerUrl` arrive already built through main's curated host allowlist.
 * This file NEVER derives a URL from a chain id and a hash — the renderer has
 * no allowlist and must not grow one. A `null` url renders as plain text.
 */

import { useState, type JSX } from "react";
import {
  ArrowUpRight01Icon,
  VexIcon,
} from "../../../../components/icons/index.js";
import type { AgentScanEntry } from "@shared/schemas/agent-scan-feed.js";
import { isBridgeTrackingStale } from "@shared/bridge-tracking.js";
import { ProtocolMark } from "../../../../components/common/ProtocolMark.js";
import { resolveProtocolMark } from "../../../../lib/protocol-marks.js";
import { ActivityBadge, ActivityChip } from "../../ActivityBadge.js";
import {
  chainRouteText,
  entryClockText,
  isEstimatedBasis,
  legAmountText,
  legSymbolText,
  primaryUsdEstText,
  timestampText,
  usdEstText,
  vexFeeText,
} from "./agent-scan-display.js";

/** One `IN`/`OUT` leg: quantity (marked `~` when quoted) + main-resolved symbol. */
function LegText({
  amount,
  symbol,
  estimated,
}: {
  readonly amount: string | null;
  readonly symbol: string;
  readonly estimated: boolean;
}): JSX.Element {
  const shown = amount !== null && estimated ? `~${amount}` : amount;
  return (
    <span className="truncate">
      {shown !== null ? `${shown} ` : ""}
      {symbol}
    </span>
  );
}

/** A labelled line in the expanded detail panel. */
function DetailLine({
  label,
  children,
}: {
  readonly label: string;
  readonly children: React.ReactNode;
}): JSX.Element {
  return (
    <div className="flex gap-2">
      <span className="w-[92px] shrink-0 font-mono text-[9px] uppercase tracking-[0.14em] text-[var(--vex-text-3)]">
        {label}
      </span>
      <span className="min-w-0 flex-1 text-[11px] leading-relaxed text-[var(--vex-text-2)]">
        {children}
      </span>
    </div>
  );
}

export function AgentScanRow({ entry }: { readonly entry: AgentScanEntry }): JSX.Element {
  const [open, setOpen] = useState(false);

  const protocolMark = resolveProtocolMark(entry.protocol);
  const estimated = isEstimatedBasis(entry);
  const route = chainRouteText(entry);
  const clock = entryClockText(entry.createdAt);
  const usd = primaryUsdEstText(entry);
  const fee = vexFeeText(entry);
  const feeUsd = usdEstText(entry.usdFeeEst);
  // Migration 065's DERIVED state. NOT a failure and deliberately not styled as
  // one: `no_safe_rpc` means the outcome is UNKNOWN, and a row that renders red
  // tells the user their funds are gone when nobody knows that. It says only
  // what is true — repeated checks could not conclude — which is the difference
  // between "still mining" and "we have been unable to look for forty minutes".
  const verificationStalled = entry.status === "pending" && entry.stalledVerification;
  // The stall supersedes the staleness chip: "we checked and could not
  // conclude" is a strictly more specific statement than "we have not checked
  // recently", and two attention chips on one row read as two problems.
  const trackingDelayed =
    entry.status === "pending" &&
    !verificationStalled &&
    isBridgeTrackingStale(entry.lastCheckedAt, entry.createdAt);
  const lastChecked =
    entry.lastCheckedAt !== null ? timestampText(entry.lastCheckedAt) : null;

  const hasDetail =
    entry.legs.length > 0 ||
    fee !== null ||
    feeUsd !== null ||
    entry.failureCode !== null ||
    entry.failureReason !== null ||
    entry.providerOrderId !== null ||
    entry.status === "pending";

  // A plain <div>: the virtualized feed owns the <ul>/<li> structure, because
  // each row must sit in an absolutely-positioned measured wrapper.
  return (
    <div className="border-b border-[var(--vex-line)] px-1 py-2">
      <div className="flex items-center gap-2">
        <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center">
          <ProtocolMark mark={protocolMark} size={14} />
        </span>
        <ActivityBadge
          kind={entry.activityKind}
          eventRole={entry.eventRole}
          status={entry.status}
          statusTitle={entry.failureCode ?? undefined}
        />
        {verificationStalled ? (
          // `paper`, never `danger`/`warning`: this is a statement about OUR
          // knowledge, not about the transaction's outcome.
          <ActivityChip
            tone="paper"
            text="verification stalled"
            title={
              entry.stalledReason !== null
                ? `Repeated checks could not confirm this yet (${entry.stalledReason}). Still pending — nothing has failed.`
                : "Repeated checks could not confirm this yet. Still pending — nothing has failed."
            }
          />
        ) : null}
        {trackingDelayed ? (
          // R12: a pending row whose sweep check has fallen far behind is NOT
          // reassuringly "tracked" — say so instead of implying progress.
          <ActivityChip
            tone="accent"
            text="tracking delayed"
            title={
              lastChecked !== null
                ? `Tracking delayed — last checked ${lastChecked}`
                : "Tracking delayed — not yet checked since this started"
            }
          />
        ) : null}

        <span className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden whitespace-nowrap font-mono text-[11.5px] leading-none text-[var(--vex-text)]">
          <LegText
            amount={legAmountText(entry.input)}
            symbol={legSymbolText(entry.input)}
            estimated={estimated}
          />
          <span className="shrink-0 text-[var(--vex-text-3)]">→</span>
          <LegText
            amount={legAmountText(entry.output)}
            symbol={legSymbolText(entry.output)}
            estimated={estimated}
          />
          {estimated ? (
            <span className="shrink-0 font-mono text-[9px] uppercase tracking-[0.14em] text-[var(--vex-text-3)]">
              est.
            </span>
          ) : null}
        </span>

        {usd !== null ? (
          <span className="shrink-0 font-mono text-[11.5px] tabular-nums text-[var(--vex-text)]">
            {usd}
          </span>
        ) : null}
      </div>

      <div className="mt-1 flex items-center gap-2 pl-[22px] font-mono text-[10px] tabular-nums text-[var(--vex-text-3)]">
        {route !== null ? <span className="truncate">{route}</span> : null}
        {clock !== null ? <span className="shrink-0">{clock}</span> : null}
        {entry.explorerUrl !== null ? (
          <a
            href={entry.explorerUrl}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Open transaction on block explorer"
            className="inline-flex shrink-0 items-center gap-0.5 rounded-[3px] uppercase tracking-[0.14em] transition-colors hover:text-[var(--vex-text)] focus-visible:text-[var(--vex-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--vex-accent)]"
          >
            TX
            <VexIcon icon={ArrowUpRight01Icon} size={11} aria-hidden />
          </a>
        ) : null}
        {hasDetail ? (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            aria-label={`${open ? "Hide" : "Show"} details for this activity`}
            className="ml-auto shrink-0 uppercase tracking-[0.14em] transition-colors hover:text-[var(--vex-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--vex-accent)]"
          >
            {open ? "Hide" : "Details"}
          </button>
        ) : null}
      </div>

      {open ? (
        <div className="mt-2 flex flex-col gap-1.5 rounded-lg border border-[var(--vex-line)] bg-[var(--vex-surface-down)] px-3 py-2.5">
          {entry.failureCode !== null || entry.failureReason !== null ? (
            <DetailLine label="Failure">
              <span className="text-[var(--vex-warn-text)]">
                {entry.failureCode ?? "unknown"}
                {entry.failureReason !== null ? ` — ${entry.failureReason}` : ""}
              </span>
            </DetailLine>
          ) : null}
          {fee !== null ? (
            <DetailLine label="Vex fee">
              {fee}
              {feeUsd !== null ? (
                <span className="text-[var(--vex-text-3)]"> ({feeUsd})</span>
              ) : null}
            </DetailLine>
          ) : null}
          {entry.providerOrderId !== null ? (
            <DetailLine label="Order">
              <span className="font-mono text-[10px]">{entry.providerOrderId}</span>
            </DetailLine>
          ) : null}
          {entry.status === "pending" ? (
            <DetailLine label="Last check">
              {lastChecked ?? "Not checked yet since this started"}
            </DetailLine>
          ) : null}
          {verificationStalled ? (
            <DetailLine label="Stalled">
              {entry.stalledReason !== null
                ? `Could not conclude: ${entry.stalledReason}. Still pending — this is not a failure.`
                : "Repeated checks could not conclude. Still pending — this is not a failure."}
            </DetailLine>
          ) : null}
          {entry.legs.length > 0 ? (
            <DetailLine label="Legs">
              <ul className="flex flex-col gap-1">
                {entry.legs.map((leg, index) => (
                  <li
                    key={`${leg.role ?? "leg"}:${index}:${leg.txHash ?? "none"}`}
                    className="flex items-center gap-2 font-mono text-[10px] tabular-nums text-[var(--vex-text-3)]"
                  >
                    <span className="inline-flex h-3.5 min-w-[92px] shrink-0 items-center justify-center rounded-[3px] border border-[var(--vex-line)] px-1 uppercase tracking-[0.14em]">
                      {leg.role ?? "leg"}
                    </span>
                    <span className="shrink-0">
                      {leg.chainSlug ?? leg.chainId ?? "—"}
                    </span>
                    {leg.status !== null ? (
                      <span className="shrink-0">{leg.status}</span>
                    ) : null}
                    {leg.failureCode !== null ? (
                      <span className="shrink-0 text-[var(--vex-warn-text)]">
                        {leg.failureCode}
                      </span>
                    ) : null}
                    {leg.explorerUrl !== null ? (
                      <a
                        href={leg.explorerUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        aria-label={`Open ${leg.role ?? "leg"} on block explorer`}
                        className="inline-flex shrink-0 items-center gap-0.5 rounded-[3px] uppercase tracking-[0.14em] transition-colors hover:text-[var(--vex-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--vex-accent)]"
                      >
                        TX
                        <VexIcon icon={ArrowUpRight01Icon} size={10} aria-hidden />
                      </a>
                    ) : null}
                  </li>
                ))}
              </ul>
            </DetailLine>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
