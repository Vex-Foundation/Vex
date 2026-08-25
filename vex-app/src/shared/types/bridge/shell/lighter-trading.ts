import type { Result } from "../../../ipc/result.js";
import type {
  LighterTradingCandleSnapshotEvent,
  LighterTradingCandleStatusEvent,
  LighterTradingCandleSubscriptionStartInput,
  LighterTradingCandleSubscriptionStartResult,
  LighterTradingCandleSubscriptionStopInput,
  LighterTradingCandleSubscriptionStopResult,
  LighterTradingCandleUpdateEvent,
  LighterTradingListMarketsInput,
  LighterTradingMarketList,
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
}
