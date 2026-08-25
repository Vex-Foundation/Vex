import type { Result } from "../../../ipc/result.js";
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
  readonly listMarkets: (
    input: LighterTradingListMarketsInput,
  ) => Promise<Result<LighterTradingMarketList>>;
  readonly getSnapshot: (
    input: LighterTradingSnapshotInput,
  ) => Promise<Result<LighterTradingSnapshot>>;
  readonly getAccount: (
    input: LighterTradingAccountInput,
  ) => Promise<Result<LighterTradingAccount>>;
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
