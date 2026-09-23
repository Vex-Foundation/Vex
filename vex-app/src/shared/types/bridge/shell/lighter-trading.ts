import type { Result } from "../../../ipc/result.js";
import type { AbortableInvocation } from "../common.js";
import type {
  LighterAccountSetupStatus,
  LighterAccountSetupStatusInput,
  LighterKeyRegistrationReconcile,
  LighterKeyRegistrationReconcileInput,
  LighterTradingAccount,
  LighterTradingAccountActivityEvent,
  LighterTradingAccountInput,
  LighterTradingFills,
  LighterTradingFillsInput,
  LighterTradingCandleHistory,
  LighterTradingCandleHistoryInput,
  LighterTradingCandleSnapshotEvent,
  LighterTradingCandleStatusEvent,
  LighterTradingCandleSubscriptionStartInput,
  LighterTradingCandleSubscriptionStartResult,
  LighterTradingCandleSubscriptionStopInput,
  LighterTradingCandleSubscriptionStopResult,
  LighterTradingCandleUpdateEvent,
  LighterDeskPrepareInput,
  LighterDeskPrepareProgressEvent,
  LighterDeskPrepareResult,
  LighterOnboardingChecklist,
  LighterOnboardingChecklistInput,
  LighterTradingListMarketsInput,
  LighterTradingMarketList,
  LighterTradingPublicBookEvent,
  LighterTradingPublicMarketStatusEvent,
  LighterTradingPublicMarketSubscriptionStartInput,
  LighterTradingPublicMarketSubscriptionStartResult,
  LighterTradingPublicMarketSubscriptionStopInput,
  LighterTradingPublicMarketSubscriptionStopResult,
  LighterTradingPublicStatsEvent,
  LighterTradingPublicTradesEvent,
  LighterTradingSnapshot,
  LighterTradingSnapshotInput,
} from "../../../schemas/lighter-trading.js";
import type {
  LighterSetupPending,
  LighterSetupPendingInput,
  LighterSetupSettleInput,
  LighterSetupSettleResult,
} from "../../../schemas/lighter-setup-handoff.js";

/** Read-only, renderer-safe Lighter market data for the Light it up workspace. */
export interface LighterTradingBridge {
  /**
   * The REST reads are abortable so an unmounted panel or a superseded market
   * selection cancels the provider read instead of finishing it unobserved.
   * Consume the `AbortSignal` in the query function and call `cancel`.
   */
  readonly listMarkets: (
    input: LighterTradingListMarketsInput,
  ) => AbortableInvocation<LighterTradingMarketList>;
  readonly getSnapshot: (
    input: LighterTradingSnapshotInput,
  ) => AbortableInvocation<LighterTradingSnapshot>;
  /** Older candles for the chart's scroll-back; cancelled like the snapshot. */
  readonly getCandleHistory: (
    input: LighterTradingCandleHistoryInput,
  ) => AbortableInvocation<LighterTradingCandleHistory>;
  readonly getAccount: (
    input: LighterTradingAccountInput,
  ) => AbortableInvocation<LighterTradingAccount>;
  readonly listFills: (
    input: LighterTradingFillsInput,
  ) => AbortableInvocation<LighterTradingFills>;
  readonly startCandleSubscription: (
    input: LighterTradingCandleSubscriptionStartInput,
  ) => Promise<Result<LighterTradingCandleSubscriptionStartResult>>;
  readonly stopCandleSubscription: (
    input: LighterTradingCandleSubscriptionStopInput,
  ) => Promise<Result<LighterTradingCandleSubscriptionStopResult>>;
  readonly onCandleSnapshot: (
    callback: (event: LighterTradingCandleSnapshotEvent) => void,
  ) => () => void;
  readonly onCandleUpdate: (
    callback: (event: LighterTradingCandleUpdateEvent) => void,
  ) => () => void;
  readonly onCandleStatus: (
    callback: (event: LighterTradingCandleStatusEvent) => void,
  ) => () => void;
  readonly startPublicMarketSubscription: (
    input: LighterTradingPublicMarketSubscriptionStartInput,
  ) => Promise<Result<LighterTradingPublicMarketSubscriptionStartResult>>;
  readonly stopPublicMarketSubscription: (
    input: LighterTradingPublicMarketSubscriptionStopInput,
  ) => Promise<Result<LighterTradingPublicMarketSubscriptionStopResult>>;
  readonly onPublicBook: (
    callback: (event: LighterTradingPublicBookEvent) => void,
  ) => () => void;
  readonly onPublicTrades: (
    callback: (event: LighterTradingPublicTradesEvent) => void,
  ) => () => void;
  readonly onPublicStats: (
    callback: (event: LighterTradingPublicStatsEvent) => void,
  ) => () => void;
  readonly onPublicMarketStatus: (
    callback: (event: LighterTradingPublicMarketStatusEvent) => void,
  ) => () => void;
  readonly onAccountActivity: (
    callback: (event: LighterTradingAccountActivityEvent) => void,
  ) => () => void;
  /**
   * Desk lane: hands main a selector (ticket draft, position to close, order
   * to cancel). Main prepares the action with the Lighter tools and enqueues
   * an approval; the returned id is the card the user still has to confirm.
   */
  readonly prepareDeskAction: (
    input: LighterDeskPrepareInput,
  ) => Promise<Result<LighterDeskPrepareResult>>;
  readonly onDeskPrepareProgress: (
    callback: (event: LighterDeskPrepareProgressEvent) => void,
  ) => () => void;
  /**
   * The ticket gate's checklist: which of the three onboarding steps this
   * session's wallet has completed. Address-only reads; no key leaves main.
   */
  readonly getOnboardingChecklist: (
    input: LighterOnboardingChecklistInput,
  ) => AbortableInvocation<LighterOnboardingChecklist>;
  /**
   * The account-setup modal's read: wallet balance, minimum deposit and fee
   * terms for one environment, before and while the modal's chain runs.
   */
  readonly getAccountSetupStatus: (
    input: LighterAccountSetupStatusInput,
  ) => AbortableInvocation<LighterAccountSetupStatus>;
  /**
   * Carry a key registration that is already on chain the rest of the way.
   * Evidence-only: it can activate a credential whose change-pub-key
   * transaction has landed, and it cannot sign, submit or replace anything.
   */
  readonly reconcileKeyRegistration: (
    input: LighterKeyRegistrationReconcileInput,
  ) => Promise<Result<LighterKeyRegistrationReconcile>>;
  /** Recover an Agent-owned setup modal after a renderer reload/session switch. */
  readonly getPendingAgentSetup: (
    input: LighterSetupPendingInput,
  ) => Promise<Result<LighterSetupPending>>;
  /** Deliberately complete or cancel the exact modal that owns the parked call. */
  readonly settleAgentSetup: (
    input: LighterSetupSettleInput,
  ) => Promise<Result<LighterSetupSettleResult>>;
}
