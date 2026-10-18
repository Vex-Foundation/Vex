/**
 * One token-history entry row (docs/design/R3-MINIMAL.md section 9.2): the
 * kind in caps, the `in → out` legs with the venue, the chain or route and the
 * time under them and the row's explorer links, the USD figure at the right,
 * and the state word with its consequence (`tokenHistoryOutcome` in
 * `token-history-display.ts`). Every row ends in a word. A bridge nests its
 * per-leg audit under the text column. The grid and its type are the shared
 * `.vex-scan-*` rules, the same ones the Agent Scan rows wear
 * (`agent-scan/ScanRowParts.tsx`).
 *
 * Honesty rules that live here:
 *  - leg token identity goes through the shared token-leg policy
 *    (`lib/token-leg-display.ts`) - a known mint address is the only thing
 *    that authorizes a brand ticker/logo; hostile symbols degrade safely;
 *  - an `estimated` bridge marks BOTH legs `~...` plus one trailing "est." tag,
 *    so a quoted amount never reads as an executed quantity (R14);
 *  - the USD figure is `usdText` untouched: an estimated one keeps its
 *    `~ ... est.` marker, a missing one prints no `$` at all;
 *  - explorer links are BUILT from `txRefs` through the shared allowlist
 *    (`txRefUrl`); an unresolved chain id renders no link, never a guess;
 *  - a pending bridge reads "Settling" - or "Status unknown" with "tracking
 *    delayed" when the durable sweep has fallen behind (R12) - and a refund
 *    reads "Refunded" with an idle fill, never as a destructive failure.
 */

import type { JSX } from "react";
import type {
  AmountField,
  TokenHistoryEntry,
  TokenHistoryTxRef,
} from "@shared/schemas/token-history.js";
import { TokenIcon } from "../../../../components/common/TokenIcon.js";
import { truncateAddress } from "../../../../lib/format.js";
import { resolveProtocolMark } from "../../../../lib/protocol-marks.js";
import { tokenDisplay } from "../../../../lib/token-leg-display.js";
import { ActivityBadge } from "../../ActivityBadge.js";
import { ScanKind, ScanMeta, ScanState, ScanTxLink } from "../agent-scan/ScanRowParts.js";
import { BridgeLegs } from "./BridgeLegsDetail.js";
import {
  entryDateText,
  primaryUsdField,
  quantityText,
  tokenHistoryOutcome,
  txRefUrl,
  unitPriceText,
  usdText,
} from "./token-history-display.js";

/**
 * The row's activity vocabulary. `activityKind` is the canonical engine kind
 * (server-DERIVED for a legacy `proj_activity` row, so it is always present on
 * the shapes that carry it); the DTO's own `kind` discriminant is the
 * structural fallback. A transfer entry carries no canonical vocabulary at all
 * - its discriminant IS the kind, and it has no event role to speak of.
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

/**
 * One leg's inline display: optional safe icon + quantity + policy-gated symbol
 * text. When `estimated` (a Q2 bridge quote), a renderable quantity is prefixed
 * `~` so it never reads as a settled quantity (R14) - paired with a single row
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
      <span className={amount.basis === "lower_bound" ? "min-w-0 whitespace-normal break-all" : "truncate"}>
        {shown} {display.text}
      </span>
    </span>
  );
}

/** The venue as the row names it: proper case when known, else its own text. */
function venueText(venue: string | null): string | null {
  if (venue === null || venue.trim().length === 0) return null;
  return resolveProtocolMark(venue)?.label ?? venue;
}

export function EntryRow({ entry }: { readonly entry: TokenHistoryEntry }): JSX.Element {
  const vocabulary = badgeVocabulary(entry);
  const date = entryDateText(entry.createdAt);
  const outcome = tokenHistoryOutcome(entry);
  const links = entry.txRefs
    .map((ref) => ({ ref, url: txRefUrl(ref) }))
    .filter(
      (candidate): candidate is { ref: TokenHistoryTxRef; url: string } =>
        candidate.url !== null,
    );

  // Meta line parts: the venue and the chain (or the route) per kind, then the
  // time. Each keeps its own element so it can be read on its own.
  const metaParts: { key: string; text: string; figure?: boolean }[] = [];
  if (entry.kind === "swap") {
    const venue = venueText(entry.venue);
    if (venue !== null) metaParts.push({ key: "venue", text: venue });
    if (entry.chain.length > 0) {
      metaParts.push({ key: "chain", text: entry.chain.toLowerCase() });
    }
  } else if (entry.kind === "bridge") {
    const venue = venueText(entry.venue);
    if (venue !== null) metaParts.push({ key: "venue", text: venue });
    metaParts.push({
      key: "route",
      text:
        entry.destinationChain !== null && entry.destinationChain.length > 0
          ? `${entry.originChain.toLowerCase()} → ${entry.destinationChain.toLowerCase()}`
          : entry.originChain.toLowerCase(),
    });
  } else if (entry.chain !== null && entry.chain.length > 0) {
    metaParts.push({ key: "chain", text: entry.chain.toLowerCase() });
  }
  if (date !== null) metaParts.push({ key: "time", text: date, figure: true });

  // Primary USD figure (swap/bridge legs; transfers carry no trade
  // economics). Output value leads; input value is the fallback. Carries its
  // own `usdProvenance` tag (C35): `usdText` renders an `"estimated"` figure
  // with an explicit `~ ... est.` marker, never as bare execution-time USD.
  const usdPrimary =
    entry.kind === "transfer"
      ? null
      : primaryUsdField(entry.input.valueUsd, entry.output.valueUsd);
  const unitPrice = entry.kind === "swap" ? unitPriceText(entry.unitPriceUsd) : null;
  // R14: a bridge whose displayed amounts are the QUOTE (not an independently
  // verified fill) marks both legs `~...` + a single trailing "est." tag, so a
  // quoted bridge amount never reads as an executed quantity.
  const bridgeEstimated = entry.kind === "bridge" && entry.amountBasis === "estimated";
  const hasNativeBound = entry.kind === "swap" && entry.input.amount.basis === "lower_bound";

  return (
    <li className="vex-scan-row">
      <ScanKind>
        {/* The kind and role only: the state is the word at the row's end. */}
        <ActivityBadge kind={vocabulary.kind} eventRole={vocabulary.role} status={null} />
      </ScanKind>

      <div className="vex-scan-what">
        <span className="vex-scan-legs" data-wrap={hasNativeBound ? "" : undefined}>
          {entry.kind === "transfer" ? (
            <>
              <span className="truncate">{quantityText(entry.amount)}</span>
              <span aria-hidden className="vex-scan-legs__arrow">→</span>
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
              <span aria-hidden className="vex-scan-legs__arrow">→</span>
              <LegText
                token={entry.output.token}
                symbol={entry.output.symbol}
                localSymbol={entry.output.localSymbol}
                amount={entry.output.amount}
                estimated={bridgeEstimated}
              />
              {bridgeEstimated ? <span className="vex-scan-est">est.</span> : null}
            </>
          )}
        </span>
        <ScanMeta parts={metaParts}>
          {links.length > 0
            ? links.map(({ ref, url }, index) => (
                <ScanTxLink
                  key={`${ref.chainId}:${ref.ref}`}
                  href={url}
                  label={`Open transaction on block explorer${links.length > 1 ? ` (${index + 1} of ${links.length})` : ""}`}
                  text={`TX${links.length > 1 ? ` ${index + 1}` : ""}`}
                />
              ))
            : null}
        </ScanMeta>
      </div>

      <span className="vex-scan-value">
        {usdPrimary !== null && usdPrimary.value !== null ? (
          <>
            {usdText(usdPrimary)}
            {unitPrice !== null ? (
              <span className="vex-scan-value__sub">@ {unitPrice}</span>
            ) : null}
          </>
        ) : null}
      </span>

      <ScanState outcome={outcome} />

      {/* Per-leg audit (bridges): deposit/approvals/fill/refund, each with its
       * own chain + explorer link, expandable so a multi-leg bridge shows once
       * (B8). agent_activity bridges carry per-leg hashes in `legs` (never
       * truncated); legacy bridges carry none and render nothing here. */}
      {entry.kind === "bridge" ? <BridgeLegs legs={entry.legs} /> : null}
    </li>
  );
}
