import type { Result } from "../../../ipc/result.js";
import type { AbortableInvocation } from "../common.js";
import type {
  LighterTradingAccount,
  LighterTradingAccountInput,
  LighterTradingCandleSnapshotEvent,
  LighterTradingCandleStatusEvent,
  LighterTradingCandleSubscriptionStartInput,
  LighterTradingCandleSubscriptionStartResult,
  LighterTradingCandleSubscriptionStopInput,
  LighterTradingCandleSubscriptionStopResult,
  LighterTradingCandleUpdateEvent,
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
  readonly getAccount: (
    input: LighterTradingAccountInput,
  ) => AbortableInvocation<LighterTradingAccount>;
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
}
