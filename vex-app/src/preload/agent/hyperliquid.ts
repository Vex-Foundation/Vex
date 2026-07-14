import { CH, EV } from "../../shared/ipc/channels.js";
import {
  hyperliquidPositionsDtoSchema,
  hyperliquidPositionsReadInputSchema,
  hyperliquidCandlesReadInputSchema,
  hyperliquidCandleUpdateEventSchema,
  hyperliquidMarketsReadInputSchema,
  hyperliquidMidsUpdateEventSchema,
  hyperliquidBookReadInputSchema,
  hyperliquidAccountReadInputSchema,
  hyperliquidRiskAcknowledgementInputSchema,
  hyperliquidRiskProposalConfirmInputSchema,
  hyperliquidSessionRiskPolicySetInputSchema,
  hyperliquidSessionRiskPolicyReadInputSchema,
  hyperliquidRiskProposalDtoSchema,
  hyperliquidRiskProposalsDtoSchema,
  hyperliquidRiskProposalsReadInputSchema,
  hyperliquidWatchLiveInputSchema,
  hyperliquidUnwatchLiveInputSchema,
  hyperliquidWorkspaceEnterInputSchema,
  hyperliquidWorkspaceExitInputSchema,
  hyperliquidWorkspaceModeReadInputSchema,
  hyperliquidWorkspaceModeEventSchema,
  type HyperliquidPositionsReadInput,
  type HyperliquidCandlesReadInput,
  type HyperliquidMarketsReadInput,
  type HyperliquidBookReadInput,
  type HyperliquidAccountReadInput,
  type HyperliquidRiskProposalConfirmInput,
  type HyperliquidSessionRiskPolicySetInput,
  type HyperliquidSessionRiskPolicyReadInput,
  type HyperliquidRiskProposalsReadInput,
  type HyperliquidWatchLiveInput,
  type HyperliquidUnwatchLiveInput,
  type HyperliquidWorkspaceEnterAccepted,
  type HyperliquidWorkspaceEnterInput,
  type HyperliquidWorkspaceExitInput,
  type HyperliquidWorkspaceModeReadInput,
  type HyperliquidWorkspaceModeEvent,
} from "../../shared/schemas/hyperliquid.js";
import type { HyperliquidBridge } from "../../shared/types/bridge/agent/hyperliquid.js";
import { invokeWithSchema, subscribe } from "../_dispatch.js";

export const hyperliquid = {
  getPositions(input: HyperliquidPositionsReadInput) {
    return invokeWithSchema(CH.hyperliquid.getPositions, input, hyperliquidPositionsReadInputSchema);
  },
  getCandles(input: HyperliquidCandlesReadInput) {
    return invokeWithSchema(CH.hyperliquid.getCandles, input, hyperliquidCandlesReadInputSchema);
  },
  getMarkets(input: HyperliquidMarketsReadInput) {
    return invokeWithSchema(CH.hyperliquid.getMarkets, input, hyperliquidMarketsReadInputSchema);
  },
  getBook(input: HyperliquidBookReadInput) {
    return invokeWithSchema(CH.hyperliquid.getBook, input, hyperliquidBookReadInputSchema);
  },
  getWorkspaceMode(input: HyperliquidWorkspaceModeReadInput) {
    return invokeWithSchema(CH.hyperliquid.getWorkspaceMode, input, hyperliquidWorkspaceModeReadInputSchema);
  },
  getOpenOrders(input: HyperliquidAccountReadInput) {
    return invokeWithSchema(CH.hyperliquid.getOpenOrders, input, hyperliquidAccountReadInputSchema);
  },
  getTwapHistory(input: HyperliquidAccountReadInput) {
    return invokeWithSchema(CH.hyperliquid.getTwapHistory, input, hyperliquidAccountReadInputSchema);
  },
  getTradeHistory(input: HyperliquidAccountReadInput) {
    return invokeWithSchema(CH.hyperliquid.getTradeHistory, input, hyperliquidAccountReadInputSchema);
  },
  getFundingHistory(input: HyperliquidAccountReadInput) {
    return invokeWithSchema(CH.hyperliquid.getFundingHistory, input, hyperliquidAccountReadInputSchema);
  },
  getOrderHistory(input: HyperliquidAccountReadInput) {
    return invokeWithSchema(CH.hyperliquid.getOrderHistory, input, hyperliquidAccountReadInputSchema);
  },
  listRiskProposals(input: HyperliquidRiskProposalsReadInput) {
    return invokeWithSchema(CH.hyperliquid.listRiskProposals, input, hyperliquidRiskProposalsReadInputSchema);
  },
  confirmRiskProposal(input: HyperliquidRiskProposalConfirmInput) {
    return invokeWithSchema(CH.hyperliquid.confirmRiskProposal, input, hyperliquidRiskProposalConfirmInputSchema);
  },
  setSessionRiskPolicy(input: HyperliquidSessionRiskPolicySetInput) {
    return invokeWithSchema(CH.hyperliquid.setSessionRiskPolicy, input, hyperliquidSessionRiskPolicySetInputSchema);
  },
  getSessionRiskPolicy(input: HyperliquidSessionRiskPolicyReadInput) {
    return invokeWithSchema(CH.hyperliquid.getSessionRiskPolicy, input, hyperliquidSessionRiskPolicyReadInputSchema);
  },
  acknowledgeRisk() {
    return invokeWithSchema(CH.hyperliquid.acknowledgeRisk, { acknowledged: true }, hyperliquidRiskAcknowledgementInputSchema);
  },
  enterWorkspace(input: HyperliquidWorkspaceEnterInput) {
    return invokeWithSchema<HyperliquidWorkspaceEnterAccepted, HyperliquidWorkspaceEnterInput>(CH.hyperliquid.enterWorkspace, input, hyperliquidWorkspaceEnterInputSchema);
  },
  exitWorkspace(input: HyperliquidWorkspaceExitInput) {
    return invokeWithSchema<HyperliquidWorkspaceModeEvent, HyperliquidWorkspaceExitInput>(CH.hyperliquid.exitWorkspace, input, hyperliquidWorkspaceExitInputSchema);
  },
  watchLive(input: HyperliquidWatchLiveInput) {
    return invokeWithSchema(CH.hyperliquid.watchLive, input, hyperliquidWatchLiveInputSchema);
  },
  unwatchLive(input: HyperliquidUnwatchLiveInput) {
    return invokeWithSchema(CH.hyperliquid.unwatchLive, input, hyperliquidUnwatchLiveInputSchema);
  },
  onPositionsUpdate(callback) {
    return subscribe(EV.hyperliquid.positionsUpdate, hyperliquidPositionsDtoSchema, callback);
  },
  onRiskProposalUpdate(callback) {
    return subscribe(EV.hyperliquid.riskProposalUpdate, hyperliquidRiskProposalDtoSchema, callback);
  },
  onWorkspaceMode(callback) {
    return subscribe(EV.hyperliquid.workspaceMode, hyperliquidWorkspaceModeEventSchema, callback);
  },
  onCandleUpdate(callback) {
    return subscribe(EV.hyperliquid.candleUpdate, hyperliquidCandleUpdateEventSchema, callback);
  },
  onMidsUpdate(callback) {
    return subscribe(EV.hyperliquid.midsUpdate, hyperliquidMidsUpdateEventSchema, callback);
  },
} satisfies HyperliquidBridge;
