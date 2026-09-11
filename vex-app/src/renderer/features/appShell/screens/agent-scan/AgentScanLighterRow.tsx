/**
 * One Agent Scan feed row for a LIGHTER FILL - the venue's own matched trade,
 * attributed to a Vex order intent, plus its expandable detail.
 *
 * WHY A SECOND ROW COMPONENT AND NOT A BRANCH INSIDE `AgentScanRow`. The feed
 * is ONE time-ordered list over TWO ledgers, and the production pattern for a
 * heterogeneous list (VS Code's `IListVirtualDelegate.getTemplateId` +
 * one `IListRenderer` per template id) is exactly this: one list, one renderer
 * PER KIND chosen by the row's discriminator, never two lists merged in the
 * view and never one renderer branching on every field. The screen stays the
 * gate, `buildFeedRows` switches on `entry.source`, and each row component
 * owns its own grammar.
 *
 * THE ROW SAYS WHAT WAS SETTLED. A fill has no lifecycle: the venue matched
 * it, the economics are final, and there is neither a settlement-chain
 * transaction nor an explorer link to offer - so this file renders NO link and
 * NO status chip. What it does render is the one thing a perp row can hide:
 * that a fill was a LIQUIDATION, a deleverage or a market settlement, which is
 * the venue acting on the account and not a decision the user made.
 *
 * The drawer is always available, because the account half, the fee
 * provenance and the observed position are the audit answer this surface
 * exists to give.
 */

import { useId, useRef, useState, type JSX } from "react";
import type { AgentScanLighterFillEntry } from "@shared/schemas/agent-scan-lighter-entry.js";
import { ProtocolMark } from "../../../../components/common/ProtocolMark.js";
import { resolveProtocolMark } from "../../../../lib/protocol-marks.js";
import { ActivityChip } from "../../ActivityBadge.js";
import { ExpandRegion } from "../../../../components/ui/expand-region.js";
import { entryClockText } from "./agent-scan-display.js";
import {
  lighterAttentionTradeTypeText,
  lighterBlockHeightText,
  lighterEffectLabel,
  lighterEntryQuoteBeforeText,
  lighterExchangeFeeText,
  lighterIntegratorFeeText,
  lighterKindLabel,
  lighterLeverageChipText,
  lighterLeverageDrawerText,
  lighterPositionBeforeText,
  lighterSideLabel,
  lighterUsdFullText,
  lighterPositionNowLines,
  lighterRealizedPnlText,
  lighterDecimalText,
  lighterTradeText,
  lighterTradeTypeLabel,
  lighterUsdSettledText,
  lighterVenueLabel,
} from "./agent-scan-lighter-display.js";

/**
 * A labelled line in the expanded detail panel. The same grammar
 * `AgentScanRow` uses for its own drawer; it is duplicated rather than
 * exported across the two rows because it is four lines of layout with no
 * behaviour, and a shared "detail line" owner would be a seam with nothing
 * behind it.
 */
function DetailLine({
  label,
  children,
}: {
  readonly label: string;
  readonly children: React.ReactNode;
}): JSX.Element {
  return (
    <div className="flex gap-2">
      <span className="w-[92px] shrink-0 vex-micro-label uppercase text-ink-secondary">
        {label}
      </span>
      <span className="min-w-0 flex-1 text-[11px] leading-relaxed text-ink-secondary">
        {children}
      </span>
    </div>
  );
}

export function AgentScanLighterRow({
  entry,
}: {
  readonly entry: AgentScanLighterFillEntry;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const detailId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);

  const protocolMark = resolveProtocolMark("lighter");
  const clock = entryClockText(entry.createdAt);
  // A SPOT fill has no position, so it wears no leverage and shows no position
  // lines anywhere - not "1x", not an empty section.
  const leverageChip = entry.spot
    ? null
    : lighterLeverageChipText(entry.leverage);
  const attention = lighterAttentionTradeTypeText(entry.tradeType);
  const integratorFee = lighterIntegratorFeeText(entry.integratorFee);
  const exchangeFee = lighterExchangeFeeText(entry.exchangeFee);
  const realizedPnl = entry.spot ? null : lighterRealizedPnlText(entry);
  const entryQuoteBefore = entry.spot ? null : lighterEntryQuoteBeforeText(entry);
  const positionNowLines = entry.spot
    ? null
    : lighterPositionNowLines(entry.positionNow, {
        base: entry.baseAsset.symbol,
        quote: entry.quoteAsset.symbol,
      });

  // A plain <div>: the virtualized feed owns the <ul>/<li> structure, because
  // each row must sit in an absolutely-positioned measured wrapper.
  return (
    <div className="border-b border-line-2 px-1 py-2">
      <div className="flex items-center gap-2">
        <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center">
          <ProtocolMark mark={protocolMark} size={14} />
        </span>
        {/* The `ActivityBadge` chrome with LIGHTER's vocabulary: that
          * component's records are typed total over the `agent_activity`
          * database vocabulary, and a venue fill is not one of its rows. */}
        <ActivityChip
          tone="solid"
          text={`${lighterKindLabel(entry.spot)}·${lighterEffectLabel(entry.positionEffect)}`}
        />
        {attention !== null ? (
          // NOT a decision the user made. The word carries it, not the hue.
          <ActivityChip
            tone="accent"
            text={attention}
            title="The venue acted on this account - this fill was not a trade the user placed."
          />
        ) : null}

        {/* The line may be clipped by the row's width; the title carries the
          * sentence whole and the drawer below repeats every figure on its own
          * wrapping line, so a narrow window hides nothing. */}
        <span className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden whitespace-nowrap font-mono text-[11.5px] leading-none text-ink-primary">
          <span className="truncate" title={lighterTradeText(entry)}>{lighterTradeText(entry)}</span>
        </span>

        {/* SETTLED, not estimated: the venue's own USD notional for the match.
          * The title carries the figure whole, so the two-decimal cell hides
          * nothing. */}
        <span
          title={entry.usdAmount}
          className="shrink-0 font-mono text-[11.5px] tabular-nums text-ink-primary"
        >
          {lighterUsdSettledText(entry.usdAmount)}
        </span>
        {leverageChip !== null ? (
          <ActivityChip tone="paper" text={leverageChip} title="Leverage before this fill" />
        ) : null}
      </div>

      <div className="mt-1 flex items-center gap-2 pl-[22px] font-mono text-[10px] tabular-nums text-ink-tertiary">
        {clock !== null ? <span className="shrink-0">{clock}</span> : null}
        <button
          ref={triggerRef}
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-controls={detailId}
          aria-label={`${open ? "Hide" : "Show"} details for this fill`}
          className="ml-auto shrink-0 uppercase tracking-[0.14em] transition-colors hover:text-ink-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary"
        >
          {open ? "Hide" : "Details"}
        </button>
      </div>

      <ExpandRegion
        id={detailId}
        open={open}
        triggerRef={triggerRef}
        className="mt-2 flex flex-col gap-1.5 rounded-xl border border-line-1 bg-surface-1 px-3 py-2.5"
      >
        {/* THE SETTLED ECONOMICS, WHOLE. The feed line clips to the row's
          * width and truncates the cents; these lines wrap, so every figure
          * the venue recorded is readable at any width. */}
        <DetailLine label="Side">{lighterSideLabel(entry.side)}</DetailLine>
        <DetailLine label="Size">
          <span className="break-all">
            {lighterDecimalText(entry.baseSize)} {entry.baseAsset.symbol}
          </span>
        </DetailLine>
        <DetailLine label="Price">
          <span className="break-all">
            {lighterDecimalText(entry.price)} {entry.quoteAsset.symbol}
          </span>
        </DetailLine>
        <DetailLine label="Quote notional">
          <span className="break-all">
            {lighterDecimalText(entry.quoteNotional)} {entry.quoteAsset.symbol}
          </span>
        </DetailLine>
        <DetailLine label="USD">
          <span className="break-all">{lighterUsdFullText(entry.usdAmount)}</span>
        </DetailLine>
        {entry.spot ? null : (
          <DetailLine label="Effect">{lighterEffectLabel(entry.positionEffect)}</DetailLine>
        )}
        {entry.spot ? null : (
          <DetailLine label="Position before">
            {lighterPositionBeforeText(entry)}
          </DetailLine>
        )}
        {entryQuoteBefore !== null ? (
          <DetailLine label="Entry quote before">{entryQuoteBefore}</DetailLine>
        ) : null}
        {realizedPnl !== null ? (
          <DetailLine label="Realized PnL">{realizedPnl}</DetailLine>
        ) : null}
        {entry.spot ? null : (
          // A HISTORICAL fact. `unknown` when the ledger holds this row without
          // the fraction - never the account's current setting.
          <DetailLine label="Leverage">
            {lighterLeverageDrawerText(entry.leverage)}
          </DetailLine>
        )}
        {integratorFee !== null ? (
          <DetailLine label="Vex fee">{integratorFee}</DetailLine>
        ) : null}
        {exchangeFee !== null ? (
          <DetailLine label="Exchange fee">{exchangeFee}</DetailLine>
        ) : null}
        <DetailLine label="Trade type">{lighterTradeTypeLabel(entry.tradeType)}</DetailLine>
        <DetailLine label="Venue">{lighterVenueLabel(entry.environment)}</DetailLine>
        <DetailLine label="Block">
          <span className="font-mono text-[10px]">
            {lighterBlockHeightText(entry.blockHeight)}
          </span>
        </DetailLine>
        {entry.providerOrderId !== null ? (
          <DetailLine label="Order">
            <span className="font-mono text-[10px]">{entry.providerOrderId}</span>
          </DetailLine>
        ) : null}
        <DetailLine label="Trade id">
          <span className="font-mono text-[10px]">{entry.providerTradeId}</span>
        </DetailLine>
        <DetailLine label="Intent">
          <span className="font-mono text-[10px]">{entry.intentId}</span>
        </DetailLine>
        {positionNowLines !== null ? (
          <DetailLine label="Position now">
            <span className="flex flex-wrap items-baseline gap-x-2">
              {positionNowLines.map((line) => (
                <span key={line}>{line}</span>
              ))}
            </span>
          </DetailLine>
        ) : null}
      </ExpandRegion>
    </div>
  );
}
