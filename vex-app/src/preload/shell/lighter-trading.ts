import { CH, EV } from "../../shared/ipc/channels.js";
import {
  lighterTradingCandleSnapshotEventSchema,
  lighterTradingCandleStatusEventSchema,
  lighterTradingCandleSubscriptionStartInputSchema,
  lighterTradingCandleSubscriptionStopInputSchema,
  lighterTradingCandleUpdateEventSchema,
  lighterTradingListMarketsInputSchema,
  lighterTradingSnapshotInputSchema,
} from "../../shared/schemas/lighter-trading.js";
import type { LighterTradingBridge } from "../../shared/types/bridge/shell/lighter-trading.js";
import { invokeWithSchema, subscribe } from "../_dispatch.js";

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
  startCandleSubscription(input) {
    return invokeWithSchema(
      CH.lighterTrading.startCandleSubscription,
      input,
      lighterTradingCandleSubscriptionStartInputSchema,
    );
  },
  stopCandleSubscription(input) {
    return invokeWithSchema(
      CH.lighterTrading.stopCandleSubscription,
      input,
      lighterTradingCandleSubscriptionStopInputSchema,
    );
  },
  onCandleSnapshot(callback) {
    return subscribe(
      EV.lighterTrading.candleSnapshot,
      lighterTradingCandleSnapshotEventSchema,
      callback,
    );
  },
  onCandleUpdate(callback) {
    return subscribe(
      EV.lighterTrading.candleUpdate,
      lighterTradingCandleUpdateEventSchema,
      callback,
    );
  },
  onCandleStatus(callback) {
    return subscribe(
      EV.lighterTrading.candleStatus,
      lighterTradingCandleStatusEventSchema,
      callback,
    );
  },
} satisfies LighterTradingBridge;
