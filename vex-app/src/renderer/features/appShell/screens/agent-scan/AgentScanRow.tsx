/**
 * One Agent Scan feed row for an AGENT_ACTIVITY entry - the LOGICAL activity
 * (never a per-leg row) plus its expandable audit detail. The feed's second
 * arm (a Lighter fill) is rendered by `AgentScanLighterRow`: one list, one
 * renderer per kind, chosen by the entry's `source` discriminator.
 *
 * The row (docs/design/R3-MINIMAL.md section 9.2): the kind in caps, then
 * `IN → OUT` with the venue, chain or route and time under it and the row's
 * links (TX, Ask Vex, Details), the USD estimate at the right, and the state
 * word with its consequence (`agent-scan-outcome.ts`). Every row ends in a
 * word.
 *
 * The detail (collapsed by default): what happened and the next step for a
 * row that failed or whose outcome is unknown, the failure code and redacted
 * reason, the recorded Vex fee, the order id, the last successful check of a
 * pending row, and every sibling execution leg with its own chain, state and
 * explorer link. A bridge shows ONE logical row here with its legs nested -
 * the feed never fans a bridge out into several top-level rows, because the
 * audit question is "what did this bridge do?", not "how many database rows
 * did it write?".
 *
 * EXPLORER LINKS ARE MAIN-RESOLVED. Both `entry.explorerUrl` and each leg's
 * `explorerUrl` arrive already built through main's curated host allowlist.
 * This file NEVER derives a URL from a chain id and a hash - the renderer has
 * no allowlist and must not grow one. A `null` url renders as plain text.
 */

import { useId, useRef, useState, type JSX } from "react";
import type {
  AgentScanActivityEntry,
  AgentScanBridgeLeg,
} from "@shared/schemas/agent-scan-feed.js";
import { resolveProtocolMark } from "../../../../lib/protocol-marks.js";
import { ActivityBadge } from "../../ActivityBadge.js";
import { ExpandRegion } from "../../../../components/ui/expand-region.js";
import { Swatch, type SwatchState } from "../../../../components/ui/swatch.js";
import { useUiStore } from "../../../../stores/uiStore.js";
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
import { activityOutcome, pendingSignal } from "./agent-scan-outcome.js";
import { activityFollowUpMessage } from "./event-follow-up.js";
import { ScanKind, ScanMeta, ScanState, ScanTxLink } from "./ScanRowParts.js";

/** One `IN`/`OUT` leg: quantity (marked `~` when quoted) + main-resolved symbol. */
function LegText({
  amount,
  symbol,
  estimated,
  bound = false,
}: {
  readonly amount: string | null;
  readonly symbol: string;
  readonly estimated: boolean;
  readonly bound?: boolean;
}): JSX.Element {
  const shown = amount !== null && estimated ? `~${amount}` : amount;
  return (
    <span className={bound ? "min-w-0 break-all" : "min-w-0 truncate"}>
      {shown !== null ? `${shown} ` : ""}
      {symbol}
    </span>
  );
}

/** A leg's own status, as a fill beside its word. */
function legSwatch(status: string | null): SwatchState {
  if (status === "confirmed") return "done";
  if (status === "failed" || status === "definitively_failed") return "error";
  if (status === "pending") return "listening";
  return "idle";
}

/** The leg's role in plain words for the "what happened" sentence. */
function legNoun(role: string | null): string {
  if (role === null) return "leg";
  if (role.startsWith("bridge_fill")) return "fill";
  if (role === "bridge_deposit") return "deposit";
  if (role === "bridge_refund") return "refund";
  if (role.startsWith("allowance")) return "approval";
  if (role.endsWith("_fee")) return "fee";
  return role.replace(/_/g, " ");
}

function legStatusWord(status: string | null): string | null {
  if (status === null) return null;
  return status === "definitively_failed" ? "failed" : status;
}

/**
 * WHAT HAPPENED, from the row's own facts only: whether a transaction left
 * (a hash on the row or a leg) and each leg's recorded state. Nothing here is
 * inferred beyond what the row carries.
 */
function whatHappened(entry: AgentScanActivityEntry, word: string): string {
  const submitted =
    entry.explorerUrl !== null || entry.legs.some((leg) => leg.txHash !== null);
  const lead = word === "Failed" && submitted ? "Submitted, then failed." : `${word}.`;
  const legLines = entry.legs
    .map((leg) => {
      const status = legStatusWord(leg.status);
      if (status === null) return null;
      const chain = leg.chainSlug ?? null;
      return `the ${legNoun(leg.role)}${chain !== null ? ` on ${chain}` : ""} ${status}`;
    })
    .filter((line): line is string => line !== null);
  if (legLines.length === 0) return lead;
  const sentence = legLines.join("; ");
  return `${lead} ${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}.`;
}

/** The NEXT STEP for a row that failed or whose outcome is unknown. */
function nextStep(entry: AgentScanActivityEntry): string {
  const confirmedLeg = entry.legs.find((leg) => leg.status === "confirmed");
  if (confirmedLeg !== undefined) {
    return `Check the ${legNoun(confirmedLeg.role)} leg before trying again.`;
  }
  return "Ask Vex what happened before trying again.";
}

function LegRow({ leg }: { readonly leg: AgentScanBridgeLeg }): JSX.Element {
  const status = legStatusWord(leg.status);
  return (
    <li className="vex-scan-leg">
      <span className="vex-scan-code">{leg.role ?? "leg"}</span>
      <span>{leg.chainSlug ?? leg.chainId ?? "-"}</span>
      {status !== null ? (
        <span className="inline-flex items-center gap-1.5">
          <Swatch state={legSwatch(leg.status)} className="text-accent-primary" />
          {status}
        </span>
      ) : null}
      {leg.failureCode !== null ? <span className="vex-num">{leg.failureCode}</span> : null}
      {leg.explorerUrl !== null ? (
        <ScanTxLink
          href={leg.explorerUrl}
          label={`Open ${leg.role ?? "leg"} on block explorer`}
        />
      ) : null}
    </li>
  );
}

export function AgentScanRow({
  entry,
}: {
  readonly entry: AgentScanActivityEntry;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const openCreateSession = useUiStore((state) => state.openCreateSession);
  const detailId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);

  const venue = resolveProtocolMark(entry.protocol)?.label ?? null;
  const estimated = isEstimatedBasis(entry);
  const hasNativeBound = entry.input.amountBasis === "lower_bound";
  const route = chainRouteText(entry);
  const clock = entryClockText(entry.createdAt);
  const usd = primaryUsdEstText(entry);
  const fee = vexFeeText(entry);
  const feeUsd = usdEstText(entry.usdFeeEst);
  const outcome = activityOutcome(entry);
  const signal = pendingSignal(entry);
  const lastChecked =
    entry.lastCheckedAt !== null ? timestampText(entry.lastCheckedAt) : null;
  // A failed row, or one Vex cannot settle, opens to what happened and the
  // next step (section 9.2); a refund is neither.
  const explains = outcome.word === "Failed" || outcome.word === "Status unknown";

  const hasDetail =
    explains ||
    entry.legs.length > 0 ||
    fee !== null ||
    feeUsd !== null ||
    entry.failureCode !== null ||
    entry.failureReason !== null ||
    entry.providerOrderId !== null ||
    entry.status === "pending";

  const askVex = (): void => openCreateSession(activityFollowUpMessage(entry));

  const metaParts = [
    ...(venue !== null ? [{ key: "venue", text: venue }] : []),
    ...(route !== null ? [{ key: "route", text: route }] : []),
    ...(clock !== null ? [{ key: "time", text: clock, figure: true }] : []),
  ];

  // A plain <div>: the virtualized feed owns the <ul>/<li> structure, because
  // each row must sit in an absolutely-positioned measured wrapper.
  return (
    <div className="vex-scan-row" data-open={open ? "" : undefined}>
      <ScanKind>
        {/* The kind and role only: the state is the word at the row's end. */}
        <ActivityBadge kind={entry.activityKind} eventRole={entry.eventRole} status={null} />
      </ScanKind>

      <div className="vex-scan-what">
        <span className="vex-scan-legs" data-wrap={hasNativeBound ? "" : undefined}>
          <LegText
            amount={legAmountText(entry.input)}
            symbol={legSymbolText(entry.input)}
            estimated={estimated}
            bound={hasNativeBound}
          />
          <span aria-hidden className="vex-scan-legs__arrow">→</span>
          <LegText
            amount={legAmountText(entry.output)}
            symbol={legSymbolText(entry.output)}
            estimated={estimated}
          />
          {estimated ? <span className="vex-scan-est">est.</span> : null}
        </span>
        <ScanMeta parts={metaParts}>
          {entry.explorerUrl !== null ? (
            <ScanTxLink href={entry.explorerUrl} label="Open transaction on block explorer" />
          ) : null}
          <button type="button" onClick={askVex} className="vex-scan-link">
            Ask Vex
          </button>
          {hasDetail ? (
            <button
              ref={triggerRef}
              type="button"
              onClick={() => setOpen((v) => !v)}
              aria-expanded={open}
              aria-controls={detailId}
              aria-label={`${open ? "Hide" : "Show"} details for this activity`}
              className="vex-scan-link"
            >
              {open ? "Hide" : "Details"}
            </button>
          ) : null}
        </ScanMeta>
      </div>

      <span className="vex-scan-value">{usd ?? ""}</span>

      <ScanState outcome={outcome} />

      <ExpandRegion
        id={detailId}
        open={open}
        triggerRef={triggerRef}
        outerClassName="vex-scan-expand"
      >
        <dl className="vex-scan-detail">
          {explains ? (
            <>
              <dt>What happened</dt>
              <dd>{whatHappened(entry, outcome.word)}</dd>
              <dt>Next step</dt>
              <dd>
                {nextStep(entry)}{" "}
                <button type="button" onClick={askVex} className="vex-scan-link">
                  Ask Vex to check it
                </button>
              </dd>
            </>
          ) : null}
          {entry.failureCode !== null || entry.failureReason !== null ? (
            <>
              <dt>Failure</dt>
              <dd className="vex-num">
                {entry.failureCode ?? "unknown"}
                {entry.failureReason !== null ? ` - ${entry.failureReason}` : ""}
              </dd>
            </>
          ) : null}
          {fee !== null ? (
            <>
              <dt>Vex fee</dt>
              <dd>
                {fee}
                {feeUsd !== null ? <span className="text-ink-tertiary"> ({feeUsd})</span> : null}
              </dd>
            </>
          ) : null}
          {entry.providerOrderId !== null ? (
            <>
              <dt>Order</dt>
              <dd className="vex-num">{entry.providerOrderId}</dd>
            </>
          ) : null}
          {entry.status === "pending" ? (
            <>
              <dt>Last check</dt>
              <dd>{lastChecked ?? "Not checked yet since this started"}</dd>
            </>
          ) : null}
          {signal === "verification_stalled" ? (
            <>
              <dt>Stalled</dt>
              <dd>
                {entry.stalledReason !== null
                  ? `Could not conclude: ${entry.stalledReason}. Still pending - this is not a failure.`
                  : "Repeated checks could not conclude. Still pending - this is not a failure."}
              </dd>
            </>
          ) : null}
          {entry.legs.length > 0 ? (
            <>
              <dt>Legs</dt>
              <dd>
                <ul className="vex-scan-legs-list">
                  {entry.legs.map((leg, index) => (
                    <LegRow
                      key={`${leg.role ?? "leg"}:${index}:${leg.txHash ?? "none"}`}
                      leg={leg}
                    />
                  ))}
                </ul>
              </dd>
            </>
          ) : null}
        </dl>
      </ExpandRegion>
    </div>
  );
}
