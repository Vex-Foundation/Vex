import type { Result } from "../../../ipc/result.js";
import type {
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
}
