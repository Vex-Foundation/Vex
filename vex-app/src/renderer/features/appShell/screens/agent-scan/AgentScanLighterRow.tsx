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
 * no lifecycle word. What it does render is the one thing a perp row can hide:
 * that a fill was a LIQUIDATION, a deleverage or a market settlement, which is
 * the venue acting on the account and not a decision the user made.
 *
 * The drawer is always available, because the account half, the fee
 * provenance and the observed position are the audit answer this surface
 * exists to give.
 *
 * R3 (docs/design/R3-MINIMAL.md section 9.2): the same grid as the activity
 * arm, and a last word like every row. A fill ends in "Filled", its own word:
 * the venue matched it and the economics are final, so it neither waits nor
 * reads as a chain confirmation. A fill the venue forced (a liquidation, a
 * deleverage, a settlement) says so under the word.
 */

import { useId, useRef, useState, type JSX } from "react";
import type { AgentScanLighterFillEntry } from "@shared/schemas/agent-scan-lighter-entry.js";
import { ActivityChip } from "../../ActivityBadge.js";
import { ExpandRegion } from "../../../../components/ui/expand-region.js";
import { entryClockText } from "./agent-scan-display.js";
import { lighterFillFollowUpMessage } from "./event-follow-up.js";
import { useUiStore } from "../../../../stores/uiStore.js";
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
import { ScanKind, ScanMeta, ScanState, type ScanOutcome } from "./ScanRowParts.js";

/** How a fill ends: the venue's own word, and who acted when it was not the user. */
function fillOutcome(attention: string | null): ScanOutcome {
  return {
    state: "done",
    word: "Filled",
    notes:
      attention === null
        ? []
        : [
            {
              text: attention,
              title:
                "The venue acted on this account - this fill was not a trade the user placed.",
            },
          ],
  };
}

export function AgentScanLighterRow({
  entry,
}: {
  readonly entry: AgentScanLighterFillEntry;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const openCreateSession = useUiStore((state) => state.openCreateSession);
  const detailId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);

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
  const trade = lighterTradeText(entry);

  const metaParts = [
    { key: "venue", text: lighterVenueLabel(entry.environment) },
    ...(clock !== null ? [{ key: "time", text: clock, figure: true }] : []),
  ];

  // A plain <div>: the virtualized feed owns the <ul>/<li> structure, because
  // each row must sit in an absolutely-positioned measured wrapper.
  return (
    <div className="vex-scan-row" data-open={open ? "" : undefined}>
      <ScanKind>
        {/* The `ActivityBadge` words with LIGHTER's vocabulary: that
          * component's records are typed total over the `agent_activity`
          * database vocabulary, and a venue fill is not one of its rows. */}
        <ActivityChip
          tone="solid"
          text={`${lighterKindLabel(entry.spot)}·${lighterEffectLabel(entry.positionEffect)}`}
        />
      </ScanKind>

      <div className="vex-scan-what">
        {/* The line may be clipped by the row's width; the title carries the
          * sentence whole and the drawer below repeats every figure on its own
          * wrapping line, so a narrow window hides nothing. */}
        <span className="vex-scan-legs">
          <span className="min-w-0 truncate" title={trade}>{trade}</span>
        </span>
        <ScanMeta parts={metaParts}>
          <button
            type="button"
            onClick={() => openCreateSession(lighterFillFollowUpMessage(entry))}
            aria-label="Ask Vex about this fill"
            className="vex-scan-link"
          >
            Ask Vex
          </button>
          <button
            ref={triggerRef}
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            aria-controls={detailId}
            aria-label={`${open ? "Hide" : "Show"} details for this fill`}
            className="vex-scan-link"
          >
            {open ? "Hide" : "Details"}
          </button>
        </ScanMeta>
      </div>

      {/* SETTLED, not estimated: the venue's own USD notional for the match.
        * The title carries the figure whole, so the two-decimal cell hides
        * nothing. The leverage in force sits under it. */}
      <span className="vex-scan-value">
        <span title={entry.usdAmount}>{lighterUsdSettledText(entry.usdAmount)}</span>
        {leverageChip !== null ? (
          <span className="vex-scan-value__sub" title="Leverage before this fill">
            {leverageChip}
          </span>
        ) : null}
      </span>

      <ScanState outcome={fillOutcome(attention)} />

      <ExpandRegion
        id={detailId}
        open={open}
        triggerRef={triggerRef}
        outerClassName="vex-scan-expand"
      >
        {/* THE SETTLED ECONOMICS, WHOLE. The feed line clips to the row's
          * width and truncates the cents; these lines wrap, so every figure
          * the venue recorded is readable at any width. */}
        <dl className="vex-scan-detail">
          <dt>Side</dt>
          <dd>{lighterSideLabel(entry.side)}</dd>
          <dt>Size</dt>
          <dd className="vex-num">
            {lighterDecimalText(entry.baseSize)} {entry.baseAsset.symbol}
          </dd>
          <dt>Price</dt>
          <dd className="vex-num">
            {lighterDecimalText(entry.price)} {entry.quoteAsset.symbol}
          </dd>
          <dt>Quote notional</dt>
          <dd className="vex-num">
            {lighterDecimalText(entry.quoteNotional)} {entry.quoteAsset.symbol}
          </dd>
          <dt>USD</dt>
          <dd className="vex-num">{lighterUsdFullText(entry.usdAmount)}</dd>
          {entry.spot ? null : (
            <>
              <dt>Effect</dt>
              <dd>{lighterEffectLabel(entry.positionEffect)}</dd>
              <dt>Position before</dt>
              <dd>{lighterPositionBeforeText(entry)}</dd>
            </>
          )}
          {entryQuoteBefore !== null ? (
            <>
              <dt>Entry quote before</dt>
              <dd>{entryQuoteBefore}</dd>
            </>
          ) : null}
          {realizedPnl !== null ? (
            <>
              <dt>Realized PnL</dt>
              <dd>{realizedPnl}</dd>
            </>
          ) : null}
          {entry.spot ? null : (
            // A HISTORICAL fact. `unknown` when the ledger holds this row without
            // the fraction - never the account's current setting.
            <>
              <dt>Leverage</dt>
              <dd>{lighterLeverageDrawerText(entry.leverage)}</dd>
            </>
          )}
          {integratorFee !== null ? (
            <>
              <dt>Vex fee</dt>
              <dd>{integratorFee}</dd>
            </>
          ) : null}
          {exchangeFee !== null ? (
            <>
              <dt>Exchange fee</dt>
              <dd>{exchangeFee}</dd>
            </>
          ) : null}
          <dt>Trade type</dt>
          <dd>{lighterTradeTypeLabel(entry.tradeType)}</dd>
          <dt>Block</dt>
          <dd className="vex-num">{lighterBlockHeightText(entry.blockHeight)}</dd>
          {entry.providerOrderId !== null ? (
            <>
              <dt>Order</dt>
              <dd className="vex-num">{entry.providerOrderId}</dd>
            </>
          ) : null}
          <dt>Trade id</dt>
          <dd className="vex-num">{entry.providerTradeId}</dd>
          <dt>Intent</dt>
          <dd className="vex-num">{entry.intentId}</dd>
          {positionNowLines !== null ? (
            <>
              <dt>Position now</dt>
              <dd>
                <span className="flex flex-wrap items-baseline gap-x-2">
                  {positionNowLines.map((line) => (
                    <span key={line}>{line}</span>
                  ))}
                </span>
              </dd>
            </>
          ) : null}
        </dl>
      </ExpandRegion>
    </div>
  );
}
