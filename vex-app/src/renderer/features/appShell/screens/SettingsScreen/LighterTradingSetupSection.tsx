/**
 * Settings -> Lighter -> Trading setup, for ONE wallet's Lighter account.
 *
 * This is the seam between the bridge and three presentational pieces, and it
 * owns exactly the state that spans them: which proposal is open, which market
 * is busy, and what the last outcome said. The capital-share field, the leverage
 * table and the confirmation modal hold no bridge knowledge at all, which is
 * what makes their states testable without a `window.vex`.
 *
 * THE CONSENT CONTRACT (plan section 7). Apply does not sign and does not decide
 * what would be signed: it sends a SELECTOR (market, whole-number leverage,
 * margin mode) to main, which resolves it against live account and market state
 * and persists a proposal. The modal renders that proposal; Confirm sends only
 * its id. Nothing on this side can widen, refresh or restate the terms, and an
 * expired proposal is re-prepared rather than re-confirmed.
 *
 * RECOVERY IS DURABLE, NOT REMEMBERED. What is still unresolved comes from the
 * overview, which reads main's own intents table, so a change Vex started and
 * cannot yet call settled is still on this card after the screen closes, the
 * card remounts or the app restarts. This component's own map of intent ids
 * covers one window only: a confirmation whose invocation never answered,
 * before the overview has been read again.
 *
 * A refusal reaches the person in main's own words. That includes the case this
 * app cares most about - "an agent order is settling on this account" - which is
 * a real, actionable cause and must never be flattened into a generic failure.
 */

import { useCallback, useMemo, useState, type JSX } from "react";
import type { LighterIntegrationEnvironment } from "@shared/schemas/lighter-integration.js";
import { Button } from "../../../../components/ui/button.js";
import {
  useConfirmLighterLeverage,
  useLighterLeverageOverview,
  useLighterTradingLimits,
  usePrepareLighterLeverage,
  useReconcileLighterLeverage,
  useSetLighterTradingLimits,
} from "../../../../lib/api/lighter-trading-limits.js";
import {
  LighterCapitalShareCard,
  type CapitalShareReadState,
  type CapitalShareWriteState,
} from "./LighterCapitalShareCard.js";
import { LighterLeverageTable } from "./LighterLeverageTable.js";
import {
  LighterLeverageConfirmModal,
  type LighterLeverageIssuedProposal,
} from "./LighterLeverageConfirmModal.js";
import {
  describeApplyOutcome,
  formatRecordedInstant,
  isRevisionConflict,
  isVaultLocked,
  readUnresolvedIntents,
  reconcileIntentIdForMarket,
  type LeverageOutcomeView,
  type LighterLeverageMarketRow,
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
  outcomeAlreadyConfigured,
  outcomeFailed,
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
  const overview = useLighterLeverageOverview(scope);
  const setLimits = useSetLighterTradingLimits();
  const prepare = usePrepareLighterLeverage();
  // Both settle-paths invalidate the limits, the overview and the trading
  // account read inside the adapter, so this component never refetches by hand:
  // a second read here would only race the adapter's own.
  const confirm = useConfirmLighterLeverage(scope);
  const reconcile = useReconcileLighterLeverage(scope);

  const [write, setWrite] = useState<CapitalShareWriteState>({ kind: "idle" });
  const [proposal, setProposal] = useState<{
    readonly value: LighterLeverageIssuedProposal;
    readonly marketId: number;
  } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [busyMarketId, setBusyMarketId] = useState<number | null>(null);
  const [outcomes, setOutcomes] = useState<ReadonlyMap<number, LeverageOutcomeView>>(
    () => new Map<number, LeverageOutcomeView>(),
  );
  // The in-session half of the reconcile record: an id written BEFORE the
  // invocation, so a confirmation that never answers still has something to
  // reconcile before the overview has been re-read. The durable list below is
  // the authority; this map only covers that one window.
  const [sessionIntentIds, setSessionIntentIds] = useState<ReadonlyMap<number, string>>(
    () => new Map<number, string>(),
  );
  const [reconciling, setReconciling] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );

  /**
   * The unresolved changes main still holds for this account, read from the
   * overview on every visit. This is what makes recovery survive a remount, a
   * closed Settings screen and a restart: the list is main's durable record,
   * not something this component remembered.
   */
  const unresolved: UnresolvedLeverageIntents = useMemo(
    () =>
      overview.data !== undefined && overview.data.ok
        ? readUnresolvedIntents(overview.data.data)
        : { rows: [], unreadable: 0 },
    [overview.data],
  );

  const recordOutcome = useCallback(
    (marketId: number, outcome: LeverageOutcomeView): void => {
      setOutcomes((previous) => {
        const next = new Map(previous);
        next.set(marketId, outcome);
        return next;
      });
    },
    [],
  );

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

  const onApply = useCallback(
    (row: LighterLeverageMarketRow, leverage: number, marginMode: "cross" | "isolated"): void => {
      setBusyMarketId(row.marketId);
      setOutcomes((previous) => {
        const next = new Map(previous);
        next.delete(row.marketId);
        return next;
      });
      void prepare
        .mutateAsync({ environment, walletAddress, marketId: row.marketId, leverage, marginMode })
        .then((result) => {
          if (!result.ok) {
            setBusyMarketId(null);
            recordOutcome(row.marketId, {
              tone: "warning",
              message: outcomeFailed(result.error.message),
              reconcilable: false,
            });
            return;
          }
          if (result.data.kind === "already_configured") {
            setBusyMarketId(null);
            recordOutcome(row.marketId, {
              tone: "neutral",
              message: outcomeAlreadyConfigured(
                row.symbol,
                result.data.current.leverageDisplay,
                result.data.current.marginMode,
              ),
              reconcilable: false,
            });
            return;
          }
          setProposal({ value: result.data, marketId: row.marketId });
        })
        .catch(() => {
          setBusyMarketId(null);
          recordOutcome(row.marketId, {
            tone: "warning",
            message: outcomeFailed("The request did not reach Vex."),
            reconcilable: false,
          });
        });
    },
    [environment, prepare, recordOutcome, walletAddress],
  );

  const closeProposal = useCallback((): void => {
    setProposal(null);
    setBusyMarketId(null);
  }, []);

  const onConfirm = useCallback(
    (proposalId: string): void => {
      const open = proposal;
      if (open === null) return;
      setSubmitting(true);
      // Recorded BEFORE the call. If the invocation never answers, main may
      // still have signed, and the only honest recovery is to read the outcome
      // by this proposal id rather than to ask again.
      setSessionIntentIds((previous) => {
        const next = new Map(previous);
        next.set(open.marketId, proposalId);
        return next;
      });
      void confirm
        .mutateAsync({ proposalId })
        .then((result) => {
          setSubmitting(false);
          closeProposal();
          if (!result.ok) {
            recordOutcome(open.marketId, {
              tone: "warning",
              message: outcomeFailed(result.error.message),
              reconcilable: false,
            });
            return;
          }
          recordOutcome(open.marketId, describeApplyOutcome(open.value.symbol, result.data));
        })
        .catch(() => {
          setSubmitting(false);
          closeProposal();
          // An invocation that never answered is NOT a failed change: main may
          // have signed. It is reported as unresolved, and Reconcile is the
          // only way this surface learns the truth.
          recordOutcome(open.marketId, {
            tone: "warning",
            message: outcomeFailed("Vex did not answer, so the outcome is unknown."),
            reconcilable: true,
          });
        });
    },
    [closeProposal, confirm, proposal, recordOutcome],
  );

  /**
   * ONE reconcile path for both surfaces. Reconcile is a READ of what Lighter
   * did with an intent main already holds; it never signs, which is why the
   * only thing it needs is the intent id. Its outcome is recorded against the
   * market, so the table row and the unresolved list state the same answer.
   */
  const runReconcile = useCallback(
    (marketId: number, symbol: string, intentId: string): void => {
      setReconciling((previous) => new Set(previous).add(intentId));
      const settle = (): void => {
        setReconciling((previous) => {
          const next = new Set(previous);
          next.delete(intentId);
          return next;
        });
      };
      void reconcile
        .mutateAsync({ proposalId: intentId })
        .then((result) => {
          settle();
          if (!result.ok) {
            recordOutcome(marketId, {
              tone: "warning",
              message: outcomeFailed(result.error.message),
              reconcilable: true,
            });
            return;
          }
          recordOutcome(marketId, describeApplyOutcome(symbol, result.data));
        })
        .catch(() => {
          settle();
          recordOutcome(marketId, {
            tone: "warning",
            message: outcomeFailed("Vex did not answer, so the outcome is still unknown."),
            reconcilable: true,
          });
        });
    },
    [recordOutcome, reconcile],
  );

  const onReconcile = useCallback(
    (row: LighterLeverageMarketRow): void => {
      const intentId = reconcileIntentIdForMarket(
        row.marketId,
        unresolved.rows,
        sessionIntentIds,
      );
      if (intentId === null) return;
      runReconcile(row.marketId, row.symbol, intentId);
    },
    [runReconcile, sessionIntentIds, unresolved.rows],
  );

  const onReconcileIntent = useCallback(
    (intent: UnresolvedLeverageIntent): void => {
      runReconcile(intent.marketId, intent.symbol, intent.intentId);
    },
    [runReconcile],
  );

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
            onApply={onApply}
            onReconcile={onReconcile}
          />
        )}
      </div>

      <LighterUnresolvedChanges
        unresolved={unresolved}
        reconciling={reconciling}
        outcomes={outcomes}
        onReconcile={onReconcileIntent}
      />

      {proposal === null ? null : (
        <LighterLeverageConfirmModal
          proposal={proposal.value}
          environment={environment}
          submitting={submitting}
          onCancel={closeProposal}
          onConfirm={onConfirm}
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
