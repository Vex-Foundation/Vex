/**
 * One leverage change flow for both surfaces that offer it: the Settings table
 * and the desk's ticket chip. Both open the same sheet and the same confirm
 * modal, so both run the same prepare -> confirm -> reconcile orchestration.
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
 * card remounts or the app restarts. This hook's own map of intent ids covers
 * one window only: a confirmation whose invocation never answered, before the
 * overview has been read again.
 *
 * A refusal reaches the person in main's own words. That includes the case this
 * app cares most about - "an agent order is settling on this account" - which is
 * a real, actionable cause and must never be flattened into a generic failure.
 */

import { useCallback, useMemo, useState } from "react";
import type { Result } from "@shared/ipc/result.js";
import type { LighterIntegrationEnvironment } from "@shared/schemas/lighter-integration.js";
import type { LighterLeverageOverview } from "@shared/schemas/lighter-trading-limits.js";
import type { UseQueryResult } from "@tanstack/react-query";
import {
  useConfirmLighterLeverage,
  useCancelLighterLeverage,
  useLighterLeverageOverview,
  usePrepareLighterLeverage,
  useReconcileLighterLeverage,
} from "../../../../lib/api/lighter-trading-limits.js";
import type { LighterLeverageIssuedProposal } from "./LighterLeverageConfirmModal.js";
import {
  describeApplyOutcome,
  readUnresolvedIntents,
  reconcileIntentIdForMarket,
  type LeverageOutcomeView,
  type LighterLeverageMarketRow,
  type UnresolvedLeverageIntent,
  type UnresolvedLeverageIntents,
} from "./lighter-leverage-view.js";
import type { LeverageMarginMode, LeverageSelection } from "./LighterLeverageSheet.js";
import { outcomeAlreadyConfigured, outcomeFailed } from "./lighter-trading-setup-copy.js";

export interface LighterLeverageChange {
  readonly overview: UseQueryResult<Result<LighterLeverageOverview>>;
  readonly unresolved: UnresolvedLeverageIntents;
  /** The market whose change is in flight; every Apply is disabled while set. */
  readonly busyMarketId: number | null;
  readonly outcomes: ReadonlyMap<number, LeverageOutcomeView>;
  readonly reconciling: ReadonlySet<string>;
  readonly proposal: { readonly value: LighterLeverageIssuedProposal; readonly marketId: number } | null;
  readonly submitting: boolean;
  readonly cancelling: boolean;
  readonly proposalError: string | null;
  readonly onApply: (
    row: LighterLeverageMarketRow,
    leverage: LeverageSelection,
    marginMode: LeverageMarginMode,
  ) => void;
  readonly closeProposal: () => void;
  readonly onConfirm: (proposalId: string) => void;
  readonly onReconcile: (row: LighterLeverageMarketRow) => void;
  readonly onReconcileIntent: (intent: UnresolvedLeverageIntent) => void;
}

export function useLighterLeverageChange(scope: {
  readonly environment: LighterIntegrationEnvironment;
  readonly walletAddress: string;
}): LighterLeverageChange {
  const { environment, walletAddress } = scope;
  const overview = useLighterLeverageOverview(scope);
  const prepare = usePrepareLighterLeverage();
  // Both settle-paths invalidate the limits, the overview and the trading
  // account read inside the adapter, so this hook never refetches by hand:
  // a second read here would only race the adapter's own.
  const confirm = useConfirmLighterLeverage(scope);
  const cancel = useCancelLighterLeverage(scope);
  const reconcile = useReconcileLighterLeverage(scope);

  const [proposal, setProposal] = useState<LighterLeverageChange["proposal"]>(null);
  const [submitting, setSubmitting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [proposalError, setProposalError] = useState<string | null>(null);
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
   * not something this hook remembered.
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

  const onApply = useCallback(
    (row: LighterLeverageMarketRow, leverage: LeverageSelection, marginMode: LeverageMarginMode): void => {
      setBusyMarketId(row.marketId);
      setProposalError(null);
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

  const clearProposal = useCallback((): void => {
    setProposal(null);
    setBusyMarketId(null);
  }, []);

  const closeProposal = useCallback((): void => {
    const open = proposal;
    if (open === null || cancelling || submitting) return;
    const proposalId = open.value.proposalId;
    setCancelling(true);
    setProposalError(null);
    void cancel
      .mutateAsync({ proposalId })
      .then((result) => {
        setCancelling(false);
        if (!result.ok) {
          setProposalError(outcomeFailed(result.error.message));
          return;
        }
        setProposal((current) =>
          current?.value.proposalId === proposalId ? null : current,
        );
        setBusyMarketId(null);
      })
      .catch(() => {
        setCancelling(false);
        setProposalError(outcomeFailed("The cancellation did not reach Vex."));
      });
  }, [cancel, cancelling, proposal, submitting]);

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
          clearProposal();
          if (!result.ok) {
            recordOutcome(open.marketId, {
              tone: "warning",
              message: outcomeFailed(result.error.message),
              reconcilable: result.error.code === "internal.unexpected",
            });
            return;
          }
          recordOutcome(open.marketId, describeApplyOutcome(open.value.symbol, result.data));
        })
        .catch(() => {
          setSubmitting(false);
          clearProposal();
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
    [clearProposal, confirm, proposal, recordOutcome],
  );

  /**
   * ONE reconcile path for both surfaces. Reconcile is a READ of what Lighter
   * did with an intent main already holds; it never signs, which is why the
   * only thing it needs is the intent id. Its outcome is recorded against the
   * market, so the sheet, the table row and the unresolved list state the same
   * answer.
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
      const intentId = reconcileIntentIdForMarket(row.marketId, unresolved.rows, sessionIntentIds);
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

  return {
    overview,
    unresolved,
    busyMarketId,
    outcomes,
    reconciling,
    proposal,
    submitting,
    cancelling,
    proposalError,
    onApply,
    closeProposal,
    onConfirm,
    onReconcile,
    onReconcileIntent,
  };
}
