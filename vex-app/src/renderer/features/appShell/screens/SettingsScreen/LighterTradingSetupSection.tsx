/**
 * Settings -> Lighter -> Trading setup, for ONE wallet's Lighter account.
 *
 * This is the seam between the bridge and the presentational pieces, and it
 * owns exactly the state that spans them: the capital-share write, and which
 * market's leverage sheet is open. The leverage change itself (prepare ->
 * confirm -> reconcile, busy market, outcomes) lives in
 * `useLighterLeverageChange`, shared with the desk ticket, so the two surfaces
 * cannot drift. The capital-share field, the leverage table, the sheet and the
 * confirmation modal hold no bridge knowledge at all, which is what makes their
 * states testable without a `window.vex`.
 *
 * The consent contract and the recovery rules are documented on the hook.
 */

import { useCallback, useState, type JSX } from "react";
import type { LighterIntegrationEnvironment } from "@shared/schemas/lighter-integration.js";
import { Button } from "../../../../components/ui/button.js";
import {
  useLighterTradingLimits,
  useSetLighterTradingLimits,
} from "../../../../lib/api/lighter-trading-limits.js";
import {
  LighterCapitalShareCard,
  type CapitalShareReadState,
  type CapitalShareWriteState,
} from "./LighterCapitalShareCard.js";
import { LighterLeverageTable } from "./LighterLeverageTable.js";
import { LighterLeverageConfirmModal } from "./LighterLeverageConfirmModal.js";
import { LighterLeverageSheet } from "./LighterLeverageSheet.js";
import { useLighterLeverageChange } from "./useLighterLeverageChange.js";
import {
  formatRecordedInstant,
  isRevisionConflict,
  isVaultLocked,
  type LeverageOutcomeView,
  type UnresolvedLeverageIntent,
  type UnresolvedLeverageIntents,
} from "./lighter-leverage-view.js";
import {
  LEVERAGE_LOADING,
  OUTCOME_RECONCILE,
  TRADING_SETUP_INTRO,
  TRADING_SETUP_TITLE,
  UNRESOLVED_INTRO,
  UNRESOLVED_TITLE,
  leverageReadFailed,
  unresolvedIntentLine,
  unresolvedReconcileLabel,
  unresolvedStateLabel,
  unresolvedUnreadableNote,
} from "./lighter-trading-setup-copy.js";

export interface LighterTradingSetupSectionProps {
  readonly environment: LighterIntegrationEnvironment;
  readonly walletAddress: string;
}

export function LighterTradingSetupSection({
  environment,
  walletAddress,
}: LighterTradingSetupSectionProps): JSX.Element {
  // One scope object per render is fine: every hook below keys its cache on the
  // two VALUES, not on this object's identity.
  const scope = { environment, walletAddress };
  const limits = useLighterTradingLimits(scope);
  const setLimits = useSetLighterTradingLimits();
  const change = useLighterLeverageChange(scope);
  const { overview, unresolved, busyMarketId, outcomes, proposal } = change;

  const [write, setWrite] = useState<CapitalShareWriteState>({ kind: "idle" });
  // Which market's leverage sheet is open. The sheet reads its row from the
  // overview on every render, so a change shows in it as soon as the overview
  // is re-read; the table row behind it says the same thing.
  const [sheetMarketId, setSheetMarketId] = useState<number | null>(null);
  const closeSheet = useCallback((): void => setSheetMarketId(null), []);

  const onSaveShare = useCallback(
    (percent: number | null, expectedRevision: number | null): void => {
      setWrite({ kind: "saving" });
      void setLimits
        .mutateAsync({ environment, walletAddress, agentCapitalSharePercent: percent, expectedRevision })
        .then((result) => {
          // No refetch here: the adapter invalidates this scope on every
          // settlement, conflict included.
          if (result.ok) {
            setWrite({ kind: "saved" });
            return;
          }
          setWrite(
            isRevisionConflict(result.error.code)
              ? { kind: "conflict" }
              : { kind: "failed", reason: result.error.message },
          );
        })
        .catch(() => {
          setWrite({ kind: "failed", reason: "The request did not reach Vex." });
        });
    },
    [environment, setLimits, walletAddress],
  );

  const onReloadShare = useCallback((): void => {
    setWrite({ kind: "idle" });
    void limits.refetch();
  }, [limits]);

  const read: CapitalShareReadState = limits.isPending
    ? { kind: "loading" }
    : limits.data === undefined
      ? { kind: "failed", reason: "Vex did not answer." }
      : limits.data.ok
        ? {
            kind: "ready",
            percent: limits.data.data.agentCapitalSharePercent,
            revision: limits.data.data.revision,
          }
        : { kind: "failed", reason: limits.data.error.message };

  const overviewData =
    overview.data !== undefined && overview.data.ok ? overview.data.data : null;
  const vaultLocked = overviewData !== null && isVaultLocked(overviewData.vaultState);
  const sheetRow =
    overviewData === null || sheetMarketId === null
      ? null
      : (overviewData.markets.find((row) => row.marketId === sheetMarketId) ?? null);

  return (
    <section
      aria-label={TRADING_SETUP_TITLE}
      className="rounded-xl border border-line-1 p-4"
      data-vex-lighter-trading-setup={walletAddress}
    >
      <h2 className="vex-micro-label uppercase text-ink-secondary">
        {TRADING_SETUP_TITLE}
      </h2>
      <p className="mt-1 text-[12px] leading-[18px] text-ink-secondary">
        {TRADING_SETUP_INTRO}
      </p>

      <div className="mt-4">
        <LighterCapitalShareCard
          read={read}
          write={write}
          onSave={onSaveShare}
          onReload={onReloadShare}
        />
      </div>

      <div className="mt-5 border-t border-line-1 pt-4">
        {overview.isPending ? (
          <p className="text-[13px] leading-[20px] text-ink-secondary" data-vex-lighter-leverage-loading>
            {LEVERAGE_LOADING}
          </p>
        ) : overview.data === undefined || !overview.data.ok ? (
          <p className="text-[13px] leading-[20px] text-warning" data-vex-lighter-leverage-failed>
            {leverageReadFailed(
              overview.data === undefined ? "Vex did not answer." : overview.data.error.message,
            )}
          </p>
        ) : (
          <LighterLeverageTable
            markets={overview.data.data.markets}
            omitted={overview.data.data.omitted}
            vaultLocked={isVaultLocked(overview.data.data.vaultState)}
            busyMarketId={busyMarketId}
            outcomes={outcomes}
            onChange={(row) => setSheetMarketId(row.marketId)}
            onReconcile={change.onReconcile}
          />
        )}
      </div>

      <LighterUnresolvedChanges
        unresolved={unresolved}
        reconciling={change.reconciling}
        outcomes={outcomes}
        onReconcile={change.onReconcileIntent}
      />

      {sheetRow === null ? null : (
        <LighterLeverageSheet
          key={sheetRow.marketId}
          symbol={sheetRow.symbol}
          row={sheetRow}
          notice={null}
          vaultLocked={vaultLocked}
          busy={busyMarketId !== null}
          outcome={outcomes.get(sheetRow.marketId) ?? null}
          onApply={change.onApply}
          onReconcile={change.onReconcile}
          onClose={closeSheet}
        />
      )}

      {proposal === null ? null : (
        <LighterLeverageConfirmModal
          proposal={proposal.value}
          environment={environment}
          submitting={change.submitting}
          onCancel={change.closeProposal}
          onConfirm={change.onConfirm}
        />
      )}
    </section>
  );
}

/**
 * The changes Vex started on Lighter and cannot yet call settled.
 *
 * DURABLE BY CONSTRUCTION: every row here comes from main's own intents table
 * through the overview, so closing Settings, remounting this card or restarting
 * Vex does not lose a single one. The list offers exactly one action, and it is
 * a read: Reconcile asks Lighter what happened to an intent main already holds.
 * Nothing on this surface can sign again.
 *
 * The section renders nothing when there is nothing unresolved, which is the
 * normal state and must not occupy the card with an empty heading.
 */
function LighterUnresolvedChanges({
  unresolved,
  reconciling,
  outcomes,
  onReconcile,
}: {
  readonly unresolved: UnresolvedLeverageIntents;
  readonly reconciling: ReadonlySet<string>;
  readonly outcomes: ReadonlyMap<number, LeverageOutcomeView>;
  readonly onReconcile: (intent: UnresolvedLeverageIntent) => void;
}): JSX.Element | null {
  if (unresolved.rows.length === 0 && unresolved.unreadable === 0) return null;
  return (
    <section
      aria-label={UNRESOLVED_TITLE}
      className="mt-5 border-t border-line-1 pt-4"
      data-vex-lighter-leverage-unresolved
    >
      <h3 className="vex-micro-label uppercase text-ink-secondary">{UNRESOLVED_TITLE}</h3>
      <p className="mt-1 text-[12px] leading-[18px] text-ink-secondary">{UNRESOLVED_INTRO}</p>
      <ul className="mt-3 flex flex-col gap-2">
        {unresolved.rows.map((intent) => {
          const outcome = outcomes.get(intent.marketId) ?? null;
          return (
            <li
              key={intent.intentId}
              className="flex flex-wrap items-center gap-2 text-[13px] leading-[20px] text-ink-primary"
              data-vex-lighter-leverage-unresolved-row={intent.symbol}
            >
              <span>
                {unresolvedIntentLine(
                  intent.symbol,
                  unresolvedStateLabel(intent.executionState),
                  formatRecordedInstant(intent.updatedAt),
                )}
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={reconciling.has(intent.intentId)}
                aria-label={unresolvedReconcileLabel(intent.symbol)}
                onClick={() => onReconcile(intent)}
              >
                {OUTCOME_RECONCILE}
              </Button>
              {outcome === null ? null : (
                <span
                  role="status"
                  aria-live="polite"
                  className={
                    outcome.tone === "warning"
                      ? "text-[12px] leading-[18px] text-warning"
                      : outcome.tone === "success"
                        ? "text-[12px] leading-[18px] text-ink-primary"
                        : "text-[12px] leading-[18px] text-ink-secondary"
                  }
                >
                  {outcome.message}
                </span>
              )}
            </li>
          );
        })}
      </ul>
      {unresolved.unreadable === 0 ? null : (
        <p
          className="mt-2 text-[12px] leading-[18px] text-warning"
          data-vex-lighter-leverage-unresolved-unreadable
        >
          {unresolvedUnreadableNote(unresolved.unreadable)}
        </p>
      )}
    </section>
  );
}
