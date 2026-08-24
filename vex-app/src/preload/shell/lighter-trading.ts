import { CH } from "../../shared/ipc/channels.js";
import {
  lighterTradingListMarketsInputSchema,
  lighterTradingSnapshotInputSchema,
} from "../../shared/schemas/lighter-trading.js";
import type { LighterTradingBridge } from "../../shared/types/bridge/shell/lighter-trading.js";
import { invokeWithSchema } from "../_dispatch.js";

export const lighterTrading = {
  listMarkets(input) {
    return invokeWithSchema(
      CH.lighterTrading.listMarkets,
      input,
      lighterTradingListMarketsInputSchema,
    );
  },
  getSnapshot(input) {
    return invokeWithSchema(
      CH.lighterTrading.getSnapshot,
      input,
      lighterTradingSnapshotInputSchema,
    );
  },
} satisfies LighterTradingBridge;
