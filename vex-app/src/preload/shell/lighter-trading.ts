import { CH, EV } from "../../shared/ipc/channels.js";
import {
  lighterTradingAccountActivityEventSchema,
  lighterTradingAccountInputSchema,
  lighterTradingCandleSnapshotEventSchema,
  lighterTradingCandleStatusEventSchema,
  lighterTradingCandleSubscriptionStartInputSchema,
  lighterTradingCandleSubscriptionStopInputSchema,
  lighterTradingCandleUpdateEventSchema,
  lighterTradingCandleHistoryInputSchema,
  lighterAccountSetupStatusInputSchema,
  lighterDeskPrepareInputSchema,
  lighterOnboardingChecklistInputSchema,
  lighterTradingFillsInputSchema,
  lighterTradingListMarketsInputSchema,
  lighterTradingPublicBookEventSchema,
  lighterTradingPublicMarketStatusEventSchema,
  lighterTradingPublicMarketSubscriptionStartInputSchema,
  lighterTradingPublicMarketSubscriptionStopInputSchema,
  lighterTradingPublicStatsEventSchema,
  lighterTradingPublicTradesEventSchema,
  lighterTradingSnapshotInputSchema,
} from "../../shared/schemas/lighter-trading.js";
import type { LighterTradingBridge } from "../../shared/types/bridge/shell/lighter-trading.js";
import {
  lighterSetupPendingInputSchema,
  lighterSetupSettleInputSchema,
} from "../../shared/schemas/lighter-setup-handoff.js";
import { abortableInvoke, invokeWithSchema, subscribe } from "../_dispatch.js";

export const lighterTrading = {
  // The three REST reads are abortable: closing the workspace, switching
  // market or unmounting the panel cancels them, which is what reaches main's
  // `ctx.signal` and stops the provider read behind it.
  listMarkets(input) {
    return abortableInvoke(
      CH.lighterTrading.listMarkets,
      input,
      lighterTradingListMarketsInputSchema,
    );
  },
  getSnapshot(input) {
    return abortableInvoke(
      CH.lighterTrading.getSnapshot,
      input,
      lighterTradingSnapshotInputSchema,
    );
  },
  getCandleHistory(input) {
    return abortableInvoke(
      CH.lighterTrading.getCandleHistory,
      input,
      lighterTradingCandleHistoryInputSchema,
    );
  },
  getAccount(input) {
    return abortableInvoke(
      CH.lighterTrading.getAccount,
      input,
      lighterTradingAccountInputSchema,
    );
  },
  listFills(input) {
    return abortableInvoke(
      CH.lighterTrading.listFills,
      input,
      lighterTradingFillsInputSchema,
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
  startPublicMarketSubscription(input) {
    return invokeWithSchema(
      CH.lighterTrading.startPublicMarketSubscription,
      input,
      lighterTradingPublicMarketSubscriptionStartInputSchema,
    );
  },
  stopPublicMarketSubscription(input) {
    return invokeWithSchema(
      CH.lighterTrading.stopPublicMarketSubscription,
      input,
      lighterTradingPublicMarketSubscriptionStopInputSchema,
    );
  },
  prepareDeskAction(input) {
    return invokeWithSchema(
      CH.lighterTrading.prepareDeskAction,
      input,
      lighterDeskPrepareInputSchema,
    );
  },
  getOnboardingChecklist(input) {
    return abortableInvoke(
      CH.lighterTrading.getOnboardingChecklist,
      input,
      lighterOnboardingChecklistInputSchema,
    );
  },
  getAccountSetupStatus(input) {
    return abortableInvoke(
      CH.lighterTrading.getAccountSetupStatus,
      input,
      lighterAccountSetupStatusInputSchema,
    );
  },
  getPendingAgentSetup(input) {
    return invokeWithSchema(
      CH.lighterTrading.getPendingAgentSetup,
      input,
      lighterSetupPendingInputSchema,
    );
  },
  settleAgentSetup(input) {
    return invokeWithSchema(
      CH.lighterTrading.settleAgentSetup,
      input,
      lighterSetupSettleInputSchema,
    );
  },
  onPublicBook(callback) {
    return subscribe(
      EV.lighterTrading.publicBook,
      lighterTradingPublicBookEventSchema,
      callback,
    );
  },
  onPublicTrades(callback) {
    return subscribe(
      EV.lighterTrading.publicTrades,
      lighterTradingPublicTradesEventSchema,
      callback,
    );
  },
  onPublicStats(callback) {
    return subscribe(
      EV.lighterTrading.publicStats,
      lighterTradingPublicStatsEventSchema,
      callback,
    );
  },
  onPublicMarketStatus(callback) {
    return subscribe(
      EV.lighterTrading.publicMarketStatus,
      lighterTradingPublicMarketStatusEventSchema,
      callback,
    );
  },
  onAccountActivity(callback) {
    return subscribe(
      EV.lighterTrading.accountActivity,
      lighterTradingAccountActivityEventSchema,
      callback,
    );
  },
} satisfies LighterTradingBridge;
