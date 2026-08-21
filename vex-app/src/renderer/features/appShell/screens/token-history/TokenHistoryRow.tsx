/**
 * One token-history entry row — the kind/side stamp, the `in → out` legs,
 * the USD primary figure, the venue/chain meta line, explorer links, and (for
 * bridges) the expandable per-leg audit.
 *
 * Extracted MOVE-ONLY from `TokenHistoryScreen.tsx` (Agent Scan renderer
 * round): the screen file had grown past 650 lines carrying the gate, the
 * row, the bridge detail, and the field formatters at once. Behavior is
 * byte-identical to the inline version — `TokenHistoryScreen.test.tsx` and
 * its row sibling pin every rule below.
 *
 * Honesty rules that live here (unchanged by the extraction):
 *  - leg token identity goes through the shared token-leg policy
 *    (`lib/token-leg-display.ts`) — a known mint address is the only thing
 *    that authorizes a brand ticker/logo; hostile symbols degrade safely;
 *  - an `estimated` bridge marks BOTH legs `~…` plus one trailing "est." tag,
 *    so a quoted amount never reads as an executed quantity (R14);
 *  - a pending bridge reads "settling" — or "tracking delayed" when the
 *    durable sweep has fallen behind (R12) — and a refund reads "refunded" in
 *    a neutral tone, never as a destructive failure.
 */

import type { JSX } from "react";
import { IconArrowUpRight } from "../../../../components/icons/index.js";
import type {
  AmountField,
  TokenHistoryEntry,
  TokenHistoryTxRef,
} from "@shared/schemas/token-history.js";
import { isBridgeTrackingStale } from "@shared/bridge-tracking.js";
import { ProtocolMark } from "../../../../components/common/ProtocolMark.js";
import { TokenIcon } from "../../../../components/common/TokenIcon.js";
import { truncateAddress } from "../../../../lib/format.js";
import { resolveProtocolMark } from "../../../../lib/protocol-marks.js";
import { tokenDisplay } from "../../../../lib/token-leg-display.js";
import {
  ActivityBadge,
  ActivityChip,
  type ActivityTone,
} from "../../ActivityBadge.js";
import { BridgeLegs } from "./BridgeLegsDetail.js";
import {
  entryDateText,
  primaryUsdField,
  quantityText,
  txRefUrl,
  unitPriceText,
  usdText,
} from "./token-history-display.js";

/**
 * The row's activity vocabulary. `activityKind` is the canonical engine kind
 * (server-DERIVED for a legacy `proj_activity` row, so it is always present on
 * the shapes that carry it); the DTO's own `kind` discriminant is the
 * structural fallback. A transfer entry carries no canonical vocabulary at all
 * — its discriminant IS the kind, and it has no event role to speak of.
 *
 * `productType`/`tradeSide` are deliberately NOT read here any more: the
 * SPOT/·SELL taxonomy they encoded was minted in SQL and never matched what
 * the engine actually recorded.
 */
function badgeVocabulary(entry: TokenHistoryEntry): {
  readonly kind: string;
  readonly role: string | null;
} {
  if (entry.kind === "transfer") return { kind: entry.kind, role: null };
  return {
    kind: entry.activityKind ?? entry.kind,
    role: entry.eventRole ?? null,
  };
}

/** The venue that executed this row, for the protocol mark. */
function entryProtocol(entry: TokenHistoryEntry): string | null {
  return entry.kind === "transfer" ? null : entry.venue;
}

/**
 * One leg's inline display: optional safe icon + quantity + policy-gated symbol
 * text. When `estimated` (a Q2 bridge quote), a renderable quantity is prefixed
 * `~` so it never reads as a settled quantity (R14) — paired with a single row
 * "est." marker in `EntryRow`.
 */
function LegText({
  token,
  symbol,
  localSymbol,
  amount,
  estimated = false,
}: {
  readonly token: string | null;
  readonly symbol: string | null;
  readonly localSymbol: string | null;
  readonly amount: AmountField;
  readonly estimated?: boolean;
}): JSX.Element {
  const display = tokenDisplay(token, symbol, localSymbol);
  const quantity = quantityText(amount);
  const shown = estimated && quantity !== "-" ? `~${quantity}` : quantity;
  return (
    <span
      title={display.full ?? undefined}
      className="inline-flex min-w-0 items-center gap-1"
    >
      {display.iconSymbol !== null ? (
        <TokenIcon symbol={display.iconSymbol} size={12} />
      ) : null}
      <span className="truncate">
        {shown} {display.text}
      </span>
    </span>
  );
}

/**
 * Bridge status chip (Agent Scan Phase 2). A `pending` bridge reads "settling"
 * (the durable sweep tracks it — it is NOT a failure); a `bridge_refunded`
 * failure reads "refunded" in a NEUTRAL tone (money returned ≠ a completed
 * bridge, but ≠ a loss either — distinct from a destructive `failed`); any
 * other failure reads "failed" (destructive). `confirmed`/`null` → no chip.
 */
const BRIDGE_STATUS_TONE = {
  settling: "accent",
  refunded: "paper",
  failed: "danger",
} as const satisfies Record<string, ActivityTone>;

function bridgeStatusChip(
  entry: Extract<TokenHistoryEntry, { kind: "bridge" }>,
): { readonly text: string; readonly tone: keyof typeof BRIDGE_STATUS_TONE; readonly title: string | undefined } | null {
  if (entry.status === "pending") {
    // R12: a pending bridge is normally "settling — tracked automatically", BUT
    // if the sweep has not successfully checked its order status in a long time
    // (last_checked_at, or createdAt before the first check, is stale) the
    // tracking is DELAYED — say so honestly instead of the reassuring default.
    if (isBridgeTrackingStale(entry.lastCheckedAt, entry.createdAt)) {
      const checked =
        entry.lastCheckedAt !== null
          ? (entryDateText(entry.lastCheckedAt) ?? "an unknown time")
          : null;
      return {
        text: "tracking delayed",
        tone: "settling",
        title:
          checked !== null
            ? `Tracking delayed - last checked ${checked}`
            : "Tracking delayed - not yet checked since the bridge started",
      };
    }
    return { text: "settling", tone: "settling", title: "Still settling - tracked automatically" };
  }
  if (entry.status === "failed") {
    if (entry.failureCode === "bridge_refunded") {
      return {
        text: "refunded",
        tone: "refunded",
        title: "Funds returned to the origin chain - not a completed bridge",
      };
    }
    return { text: "failed", tone: "failed", title: entry.failureCode ?? undefined };
  }
  return null;
}

export function EntryRow({ entry }: { readonly entry: TokenHistoryEntry }): JSX.Element {
  const vocabulary = badgeVocabulary(entry);
  const protocolMark = resolveProtocolMark(entryProtocol(entry));
  const date = entryDateText(entry.createdAt);
  const bridgeChip = entry.kind === "bridge" ? bridgeStatusChip(entry) : null;
  const links = entry.txRefs
    .map((ref) => ({ ref, url: txRefUrl(ref) }))
    .filter(
      (candidate): candidate is { ref: TokenHistoryTxRef; url: string } =>
        candidate.url !== null,
    );

  // Meta line parts: venue/chain context per kind, mono and muted.
  const meta: string[] = [];
  if (entry.kind === "swap") {
    if (entry.venue !== null && entry.venue.length > 0) {
      meta.push(entry.venue.toUpperCase());
    }
    if (entry.chain.length > 0) meta.push(entry.chain.toLowerCase());
  } else if (entry.kind === "bridge") {
    if (entry.venue !== null && entry.venue.length > 0) {
      meta.push(entry.venue.toUpperCase());
    }
    meta.push(
      entry.destinationChain !== null && entry.destinationChain.length > 0
        ? `${entry.originChain.toLowerCase()} → ${entry.destinationChain.toLowerCase()}`
        : entry.originChain.toLowerCase(),
    );
  } else {
    if (entry.chain !== null && entry.chain.length > 0) {
      meta.push(entry.chain.toLowerCase());
    }
    if (entry.status.length > 0) meta.push(entry.status.toLowerCase());
  }

  // Primary USD figure (swap/bridge legs; transfers carry no trade
  // economics). Output value leads; input value is the fallback. Carries its
  // own `usdProvenance` tag (C35) — `usdText` renders an `"estimated"` figure
  // with an explicit `~ … est.` marker, never as bare execution-time USD.
  const usdPrimary =
    entry.kind === "transfer"
      ? null
      : primaryUsdField(entry.input.valueUsd, entry.output.valueUsd);
  const unitPrice = entry.kind === "swap" ? unitPriceText(entry.unitPriceUsd) : null;
  // R14: a bridge whose displayed amounts are the QUOTE (not an independently
  // verified fill) marks both legs `~…` + a single trailing "est." tag, so a
  // quoted bridge amount never reads as an executed quantity.
  const bridgeEstimated = entry.kind === "bridge" && entry.amountBasis === "estimated";

  return (
    <li className="border-b border-line-2 py-2 last:border-b-0">
      <div className="flex items-center gap-2">
        {/* Fixed-width slot so rows stay aligned whether or not the venue
         * resolves to a mark (a transfer has no venue at all). */}
        <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center">
          <ProtocolMark mark={protocolMark} size={14} />
        </span>
        <ActivityBadge
          kind={vocabulary.kind}
          eventRole={vocabulary.role}
          // A bridge speaks its OWN richer lifecycle below (settling /
          // tracking delayed / refunded); only a swap's status rides the badge.
          status={entry.kind === "swap" ? entry.status : null}
          statusTitle={
            entry.kind === "swap" && entry.status === "failed"
              ? (entry.failureCode ?? undefined)
              : undefined
          }
        />
        {bridgeChip !== null ? (
          <ActivityChip
            tone={BRIDGE_STATUS_TONE[bridgeChip.tone]}
            text={bridgeChip.text}
            title={bridgeChip.title}
          />
        ) : null}
        <span className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden whitespace-nowrap font-mono text-[11.5px] leading-none text-ink-primary">
          {entry.kind === "transfer" ? (
            <>
              <span className="truncate">{quantityText(entry.amount)}</span>
              <span className="shrink-0 text-ink-tertiary">→</span>
              <span className="truncate" title={entry.toAddress}>
                {truncateAddress(entry.toAddress)}
              </span>
            </>
          ) : (
            <>
              <LegText
                token={entry.input.token}
                symbol={entry.input.symbol}
                localSymbol={entry.input.localSymbol}
                amount={entry.input.amount}
                estimated={bridgeEstimated}
              />
              <span className="shrink-0 text-ink-tertiary">→</span>
              <LegText
                token={entry.output.token}
                symbol={entry.output.symbol}
                localSymbol={entry.output.localSymbol}
                amount={entry.output.amount}
                estimated={bridgeEstimated}
              />
              {bridgeEstimated ? (
                <span className="shrink-0 vex-doto-label uppercase text-ink-secondary">
                  est.
                </span>
              ) : null}
            </>
          )}
        </span>
        {usdPrimary !== null && usdPrimary.value !== null ? (
          <span className="shrink-0 font-mono text-[11.5px] tabular-nums text-ink-primary">
            {usdText(usdPrimary)}
            {unitPrice !== null ? (
              <span className="text-ink-tertiary"> @ {unitPrice}</span>
            ) : null}
          </span>
        ) : null}
      </div>
      <div className="mt-1 flex items-center gap-2 pl-[22px] font-mono text-[10px] tabular-nums text-ink-tertiary">
        {meta.length > 0 ? <span className="truncate">{meta.join(" · ")}</span> : null}
        {date !== null ? <span className="shrink-0">{date}</span> : null}
        {links.map(({ ref, url }, index) => (
          <a
            key={`${ref.chainId}:${ref.ref}`}
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={`Open transaction on block explorer${links.length > 1 ? ` (${index + 1} of ${links.length})` : ""}`}
            className="inline-flex shrink-0 items-center gap-0.5 rounded-[3px] uppercase tracking-[0.14em] transition-colors hover:text-ink-primary focus-visible:text-ink-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary"
          >
            TX{links.length > 1 ? ` ${index + 1}` : ""}
            <IconArrowUpRight size={11} />
          </a>
        ))}
      </div>
      {/* Per-leg audit (bridges) — deposit/approvals/fill/refund, each with its
       * own chain + explorer link, expandable so a multi-leg bridge shows once
       * (B8). agent_activity bridges carry per-leg hashes in `legs` (never
       * truncated); legacy bridges carry none and render nothing here. */}
      {entry.kind === "bridge" ? <BridgeLegs legs={entry.legs} /> : null}
    </li>
  );
}
