import type { LighterClient } from "@tools/lighter/client.js";
import type { LighterAccountOrder, LighterTrade } from "@tools/lighter/types.js";
import {
  buildLighterCreateOrderSigningInput,
  signLighterCreateOrderWithAdapter,
  type LighterSignerAdapter,
} from "@tools/lighter/signer-adapter.js";
import type { LighterUnsignedCreateOrderRequest } from "@tools/lighter/signer-order.js";
import {
  loadLighterTradingSecretMaterial,
  type LighterTradingSecretReader,
} from "@tools/lighter/trading-secret.js";
import { ErrorCodes, VexError } from "../../../../errors.js";
import * as lighterOrderExecutionIntentsRepo from "@vex-agent/db/repos/lighter-order-execution-intents.js";
import {
  reserveLighterOrderNonceForSigning,
  type LighterOrderNonceReservation,
} from "./nonce-reservation.js";
import type { LighterOrderReadyForSignerPlan } from "./execution-plan.js";
import {
  LIGHTER_LIVE_TRADING_DISABLED_MESSAGE,
  isLighterLiveTradingEnabled,
} from "./execution-boundary.js";

const SENDTX_AMBIGUOUS_REASON = "sendtx_failed_after_submit_attempt";
const SIGNING_AMBIGUOUS_REASON = "signing_failed_after_nonce_reservation";
const API_ACCEPTED_PERSIST_AMBIGUOUS_REASON = "api_acceptance_persist_failed";
const PROVIDER_HASH_MISMATCH_AMBIGUOUS_REASON = "provider_tx_hash_mismatch";
const PROVIDER_CODE_AMBIGUOUS_REASON = "provider_non_acceptance_code";
const SIGNED_PERSIST_AMBIGUOUS_REASON = "signed_state_persist_failed";
const SUBMITTED_PERSIST_AMBIGUOUS_REASON = "submitted_state_persist_failed";
const SEQUENCER_PENDING_PERSIST_AMBIGUOUS_REASON = "sequencer_pending_persist_failed";
const PROVIDER_OUTCOME_READ_AMBIGUOUS_REASON = "provider_outcome_read_failed";
const PROVIDER_OUTCOME_PERSIST_AMBIGUOUS_REASON = "provider_outcome_persist_failed";

export type ExecuteApprovedLighterCreateOrderResult =
  | {
      readonly status: "sequencer_pending";
      readonly intentId: string;
      readonly environment: LighterOrderReadyForSignerPlan["environment"];
      readonly executionState: "sequencer_pending";
      readonly signerTxHash: string;
      readonly submittedTxHash: string;
      readonly submitCode: number;
      readonly predictedExecutionTimeMs: number;
      readonly volumeQuotaRemaining: string | null;
      readonly evidenceSource: "not_found" | "inactive_order";
      readonly clientOrderIndex: string;
      readonly providerOrderId: string | null;
      readonly providerOrderStatus: string | null;
      readonly message: string;
    }
  | {
      readonly status: "provider_confirmed";
      readonly intentId: string;
      readonly environment: LighterOrderReadyForSignerPlan["environment"];
      readonly executionState: "open" | "partially_filled" | "filled" | "canceled" | "rejected";
      readonly signerTxHash: string;
      readonly submittedTxHash: string;
      readonly evidenceSource: "active_order" | "inactive_order" | "account_trade";
      readonly clientOrderIndex: string;
      readonly providerOrderId: string | null;
      readonly providerOrderStatus: string | null;
      readonly message: string;
    }
  | {
      readonly status: "ambiguous";
      readonly intentId: string;
      readonly environment: LighterOrderReadyForSignerPlan["environment"];
      readonly executionState: "ambiguous";
      readonly reason: string;
      readonly signerTxHash: string | null;
      readonly message: string;
    };

export interface ExecuteApprovedLighterCreateOrderDeps {
  readonly liveTradingEnabled: () => boolean;
  readonly secretReader: LighterTradingSecretReader;
  readonly reserveNonce: typeof reserveLighterOrderNonceForSigning;
  readonly signer: LighterSignerAdapter;
  readonly client: Pick<
    LighterClient,
    "sendTx" | "getAccountActiveOrders" | "getAccountInactiveOrders" | "getAccountTrades"
  >;
  readonly intents: Pick<
    typeof lighterOrderExecutionIntentsRepo,
    | "markSigned"
    | "markSubmitted"
    | "markApiAccepted"
    | "markSequencerPending"
    | "markProviderOutcome"
    | "markAmbiguous"
  >;
}

let configuredDeps: ExecuteApprovedLighterCreateOrderDeps | null = null;

export function configureLighterCreateOrderExecutionDeps(
  deps: ExecuteApprovedLighterCreateOrderDeps,
): () => void {
  configuredDeps = deps;
  return () => {
    if (configuredDeps === deps) configuredDeps = null;
  };
}

export function getConfiguredLighterCreateOrderExecutionDeps(): ExecuteApprovedLighterCreateOrderDeps | null {
  return configuredDeps;
}

export async function executeApprovedLighterCreateOrder(input: {
  readonly plan: LighterOrderReadyForSignerPlan;
  readonly unsignedOrder: LighterUnsignedCreateOrderRequest;
  readonly deps: ExecuteApprovedLighterCreateOrderDeps;
}): Promise<ExecuteApprovedLighterCreateOrderResult> {
  const { plan, unsignedOrder, deps } = input;
  if (!deps.liveTradingEnabled()) {
    throw new VexError(
      ErrorCodes.LIGHTER_INVALID_REQUEST,
      LIGHTER_LIVE_TRADING_DISABLED_MESSAGE,
      "Ask to start the live Lighter trading milestone before enabling signer or sendTx behavior.",
    );
  }

  await assertProviderOutcomeRepairReady(plan, unsignedOrder, deps);

  const secret = await loadLighterTradingSecretMaterial(
    plan.credentialReference,
    deps.secretReader,
  );
  const nonce = await deps.reserveNonce(plan);
  let signerTxHash: string | null = null;

  try {
    const signingInput = buildLighterCreateOrderSigningInput({
      order: unsignedOrder,
      secret,
      nonce: nonce.nonceValue,
    });
    const signed = await signLighterCreateOrderWithAdapter(signingInput, deps.signer);
    signerTxHash = signed.txHash;

    const signedIntent = await deps.intents.markSigned({
      intentId: plan.intentId,
      sessionId: plan.sessionId,
      environment: plan.environment,
      nonceReservationId: nonce.reservationId,
      nonceValue: nonce.nonceValue,
      clientOrderIndex: unsignedOrder.clientOrderIndex,
      signerTxHash: signed.txHash,
    });
    if (signedIntent === null) {
      await markAmbiguous(deps, plan, SIGNED_PERSIST_AMBIGUOUS_REASON);
      throw blockedBeforeSubmit(
        `Lighter order execution intent ${plan.intentId} could not persist signed state.`,
      );
    }

    const submitted = await deps.intents.markSubmitted({
      intentId: plan.intentId,
      sessionId: plan.sessionId,
      environment: plan.environment,
      signerTxHash: signed.txHash,
    });
    if (submitted === null) {
      await markAmbiguous(deps, plan, SUBMITTED_PERSIST_AMBIGUOUS_REASON);
      throw blockedBeforeSubmit(
        `Lighter order execution intent ${plan.intentId} could not persist submitted state before provider submission.`,
      );
    }

    let response: Awaited<ReturnType<LighterClient["sendTx"]>>;
    try {
      response = await deps.client.sendTx(plan.environment, {
        txType: signed.txType,
        txInfo: signed.txInfo,
      });
    } catch {
      await markAmbiguous(deps, plan, SENDTX_AMBIGUOUS_REASON);
      return ambiguous(plan, SENDTX_AMBIGUOUS_REASON, signed.txHash);
    }

    if (response.code !== 200) {
      await markAmbiguous(deps, plan, PROVIDER_CODE_AMBIGUOUS_REASON);
      return ambiguous(plan, PROVIDER_CODE_AMBIGUOUS_REASON, signed.txHash);
    }
    if (response.tx_hash !== signed.txHash) {
      await markAmbiguous(deps, plan, PROVIDER_HASH_MISMATCH_AMBIGUOUS_REASON);
      return ambiguous(plan, PROVIDER_HASH_MISMATCH_AMBIGUOUS_REASON, signed.txHash);
    }

    const accepted = await deps.intents.markApiAccepted({
      intentId: plan.intentId,
      sessionId: plan.sessionId,
      environment: plan.environment,
      signerTxHash: signed.txHash,
      submittedTxHash: response.tx_hash,
      submitCode: response.code,
      submitMessage: response.message ?? null,
      predictedExecutionTimeMs: response.predicted_execution_time_ms,
      volumeQuotaRemaining: response.volume_quota_remaining ?? null,
    });
    if (accepted === null) {
      await markAmbiguous(deps, plan, API_ACCEPTED_PERSIST_AMBIGUOUS_REASON);
      return ambiguous(plan, API_ACCEPTED_PERSIST_AMBIGUOUS_REASON, signed.txHash);
    }

    const pending = await deps.intents.markSequencerPending({
      intentId: plan.intentId,
      sessionId: plan.sessionId,
      environment: plan.environment,
      signerTxHash: signed.txHash,
      submittedTxHash: response.tx_hash,
    });
    if (pending === null) {
      await markAmbiguous(deps, plan, SEQUENCER_PENDING_PERSIST_AMBIGUOUS_REASON);
      return ambiguous(plan, SEQUENCER_PENDING_PERSIST_AMBIGUOUS_REASON, signed.txHash);
    }

    return reconcileProviderOutcome({
      plan,
      unsignedOrder,
      deps,
      signerTxHash: signed.txHash,
      submittedTxHash: response.tx_hash,
      submitCode: response.code,
      predictedExecutionTimeMs: response.predicted_execution_time_ms,
      volumeQuotaRemaining: accepted.volumeQuotaRemaining,
    });
  } catch (error) {
    if (nonce !== null && signerTxHash === null) {
      await markAmbiguous(deps, plan, SIGNING_AMBIGUOUS_REASON);
    }
    throw error;
  }
}

export function defaultLighterCreateOrderExecutionDeps(
  overrides: Partial<ExecuteApprovedLighterCreateOrderDeps> & {
    readonly secretReader: LighterTradingSecretReader;
    readonly signer: LighterSignerAdapter;
    readonly client: Pick<
      LighterClient,
      "sendTx" | "getAccountActiveOrders" | "getAccountInactiveOrders" | "getAccountTrades"
    >;
  },
): ExecuteApprovedLighterCreateOrderDeps {
  return {
    liveTradingEnabled: isLighterLiveTradingEnabled,
    reserveNonce: reserveLighterOrderNonceForSigning,
    intents: lighterOrderExecutionIntentsRepo,
    ...overrides,
  };
}

async function assertProviderOutcomeRepairReady(
  plan: LighterOrderReadyForSignerPlan,
  unsignedOrder: LighterUnsignedCreateOrderRequest,
  deps: ExecuteApprovedLighterCreateOrderDeps,
): Promise<void> {
  let activeOrders: Awaited<ReturnType<LighterClient["getAccountActiveOrders"]>>;
  try {
    activeOrders = await deps.client.getAccountActiveOrders(plan.environment, {
      accountIndex: plan.accountIndex,
      marketId: plan.marketIndex,
      marketType: "all",
    });
  } catch {
    throw blockedBeforeSubmit(
      "Lighter provider outcome repair is unavailable before submission. No order was signed or submitted.",
    );
  }

  const existing = findMatchingOrder(activeOrders.orders, plan, unsignedOrder.clientOrderIndex);
  if (existing !== null) {
    throw blockedBeforeSubmit(
      "A Lighter order with the same Vex client order id is already visible before submission. No order was signed or submitted.",
    );
  }
}

async function reconcileProviderOutcome(input: {
  readonly plan: LighterOrderReadyForSignerPlan;
  readonly unsignedOrder: LighterUnsignedCreateOrderRequest;
  readonly deps: ExecuteApprovedLighterCreateOrderDeps;
  readonly signerTxHash: string;
  readonly submittedTxHash: string;
  readonly submitCode: number;
  readonly predictedExecutionTimeMs: number;
  readonly volumeQuotaRemaining: string | null;
}): Promise<ExecuteApprovedLighterCreateOrderResult> {
  const {
    plan,
    unsignedOrder,
    deps,
    signerTxHash,
    submittedTxHash,
    submitCode,
    predictedExecutionTimeMs,
    volumeQuotaRemaining,
  } = input;

  try {
    const activeOrders = await deps.client.getAccountActiveOrders(plan.environment, {
      accountIndex: plan.accountIndex,
      marketId: plan.marketIndex,
      marketType: "all",
    });
    const active = findMatchingOrder(activeOrders.orders, plan, unsignedOrder.clientOrderIndex);
    if (active !== null) {
      return persistProviderOutcome({
        plan,
        unsignedOrder,
        deps,
        signerTxHash,
        submittedTxHash,
        source: "active_order",
        state: stateFromActiveOrder(active),
        providerOrderId: active.order_id,
        providerOrderStatus: active.status ?? null,
        providerOutcomeJson: orderEvidence("active_order", active, unsignedOrder.clientOrderIndex),
        submitCode,
        predictedExecutionTimeMs,
        volumeQuotaRemaining,
      });
    }

    const inactiveOrders = await deps.client.getAccountInactiveOrders(plan.environment, {
      accountIndex: plan.accountIndex,
      marketId: plan.marketIndex,
      marketType: "all",
      limit: 100,
    });
    const inactive = findMatchingOrder(inactiveOrders.orders, plan, unsignedOrder.clientOrderIndex);
    if (inactive !== null) {
      return persistProviderOutcome({
        plan,
        unsignedOrder,
        deps,
        signerTxHash,
        submittedTxHash,
        source: "inactive_order",
        state: stateFromInactiveOrder(inactive),
        providerOrderId: inactive.order_id,
        providerOrderStatus: inactive.status ?? null,
        providerOutcomeJson: orderEvidence("inactive_order", inactive, unsignedOrder.clientOrderIndex),
        submitCode,
        predictedExecutionTimeMs,
        volumeQuotaRemaining,
      });
    }

    const trades = await deps.client.getAccountTrades(plan.environment, {
      accountIndex: plan.accountIndex,
      limit: 100,
      sortBy: "timestamp",
    });
    const trade = findMatchingTrade(
      trades.trades,
      plan,
      unsignedOrder.clientOrderIndex,
      submittedTxHash,
    );
    if (trade !== null) {
      return persistProviderOutcome({
        plan,
        unsignedOrder,
        deps,
        signerTxHash,
        submittedTxHash,
        source: "account_trade",
        state: "partially_filled",
        providerOrderId: orderIdFromTrade(trade, plan),
        providerOrderStatus: "trade_seen",
        providerOutcomeJson: tradeEvidence(trade, plan, unsignedOrder.clientOrderIndex),
        submitCode,
        predictedExecutionTimeMs,
        volumeQuotaRemaining,
      });
    }
  } catch {
    await markAmbiguous(deps, plan, PROVIDER_OUTCOME_READ_AMBIGUOUS_REASON);
    return ambiguous(plan, PROVIDER_OUTCOME_READ_AMBIGUOUS_REASON, signerTxHash);
  }

  const persisted = await deps.intents.markProviderOutcome({
    intentId: plan.intentId,
    sessionId: plan.sessionId,
    environment: plan.environment,
    state: "sequencer_pending",
    source: "not_found",
    providerOrderId: null,
    providerOrderStatus: null,
    providerOutcomeJson: {
      source: "not_found",
      clientOrderIndex: unsignedOrder.clientOrderIndex,
      checkedEndpoints: ["accountActiveOrders", "accountInactiveOrders", "trades"],
    },
  });
  if (persisted === null) {
    await markAmbiguous(deps, plan, PROVIDER_OUTCOME_PERSIST_AMBIGUOUS_REASON);
    return ambiguous(plan, PROVIDER_OUTCOME_PERSIST_AMBIGUOUS_REASON, signerTxHash);
  }

  return {
    status: "sequencer_pending",
    intentId: plan.intentId,
    environment: plan.environment,
    executionState: "sequencer_pending",
    signerTxHash,
    submittedTxHash,
    submitCode,
    predictedExecutionTimeMs,
    volumeQuotaRemaining,
    evidenceSource: "not_found",
    clientOrderIndex: unsignedOrder.clientOrderIndex,
    providerOrderId: null,
    providerOrderStatus: null,
    message:
      "Lighter accepted the signed order submission, but the order was not visible in account order or trade reads yet. Vex recorded sequencer_pending and will not retry sendTx without reconciliation.",
  };
}

async function persistProviderOutcome(input: {
  readonly plan: LighterOrderReadyForSignerPlan;
  readonly unsignedOrder: LighterUnsignedCreateOrderRequest;
  readonly deps: ExecuteApprovedLighterCreateOrderDeps;
  readonly signerTxHash: string;
  readonly submittedTxHash: string;
  readonly source: "active_order" | "inactive_order" | "account_trade";
  readonly state: "open" | "partially_filled" | "filled" | "canceled" | "rejected" | "sequencer_pending";
  readonly providerOrderId: string | null;
  readonly providerOrderStatus: string | null;
  readonly providerOutcomeJson: Record<string, unknown>;
  readonly submitCode: number;
  readonly predictedExecutionTimeMs: number;
  readonly volumeQuotaRemaining: string | null;
}): Promise<ExecuteApprovedLighterCreateOrderResult> {
  const persisted = await input.deps.intents.markProviderOutcome({
    intentId: input.plan.intentId,
    sessionId: input.plan.sessionId,
    environment: input.plan.environment,
    state: input.state,
    source: input.source,
    providerOrderId: input.providerOrderId,
    providerOrderStatus: input.providerOrderStatus,
    providerOutcomeJson: input.providerOutcomeJson,
  });
  if (persisted === null) {
    await markAmbiguous(input.deps, input.plan, PROVIDER_OUTCOME_PERSIST_AMBIGUOUS_REASON);
    return ambiguous(input.plan, PROVIDER_OUTCOME_PERSIST_AMBIGUOUS_REASON, input.signerTxHash);
  }
  if (input.state === "sequencer_pending") {
    return {
      status: "sequencer_pending",
      intentId: input.plan.intentId,
      environment: input.plan.environment,
      executionState: "sequencer_pending",
      signerTxHash: input.signerTxHash,
      submittedTxHash: input.submittedTxHash,
      submitCode: input.submitCode,
      predictedExecutionTimeMs: input.predictedExecutionTimeMs,
      volumeQuotaRemaining: input.volumeQuotaRemaining,
      evidenceSource: input.source === "inactive_order" ? "inactive_order" : "not_found",
      clientOrderIndex: input.unsignedOrder.clientOrderIndex,
      providerOrderId: input.providerOrderId,
      providerOrderStatus: input.providerOrderStatus,
      message:
        "Lighter accepted the signed order submission, but final provider order classification is still pending. Vex will not retry sendTx without reconciliation.",
    };
  }
  return {
    status: "provider_confirmed",
    intentId: input.plan.intentId,
    environment: input.plan.environment,
    executionState: input.state,
    signerTxHash: input.signerTxHash,
    submittedTxHash: input.submittedTxHash,
    evidenceSource: input.source,
    clientOrderIndex: input.unsignedOrder.clientOrderIndex,
    providerOrderId: input.providerOrderId,
    providerOrderStatus: input.providerOrderStatus,
    message: `Lighter provider evidence confirmed order state ${input.state}.`,
  };
}

function findMatchingOrder(
  orders: readonly LighterAccountOrder[],
  plan: LighterOrderReadyForSignerPlan,
  clientOrderIndex: string,
): LighterAccountOrder | null {
  return orders.find((order) =>
    order.owner_account_index === plan.accountIndex
    && order.market_index === plan.marketIndex
    && order.client_order_id === clientOrderIndex
  ) ?? null;
}

function findMatchingTrade(
  trades: readonly LighterTrade[],
  plan: LighterOrderReadyForSignerPlan,
  clientOrderIndex: string,
  submittedTxHash: string,
): LighterTrade | null {
  return trades.find((trade) => {
    if (trade.market_id !== plan.marketIndex) return false;
    if (trade.tx_hash === submittedTxHash) return true;
    if (plan.side === "buy") {
      return trade.bid_account_id === plan.accountIndex && trade.bid_client_id_str === clientOrderIndex;
    }
    return trade.ask_account_id === plan.accountIndex && trade.ask_client_id_str === clientOrderIndex;
  }) ?? null;
}

function stateFromActiveOrder(order: LighterAccountOrder): "open" | "partially_filled" {
  return decimalGreaterThanZero(order.filled_base_amount) ? "partially_filled" : "open";
}

function stateFromInactiveOrder(
  order: LighterAccountOrder,
): "sequencer_pending" | "partially_filled" | "filled" | "canceled" | "rejected" {
  const status = (order.status ?? "").toLowerCase();
  if (status.includes("fill")) return "filled";
  if (status.includes("cancel") || status.includes("expire")) return "canceled";
  if (status.includes("reject") || status.includes("fail")) return "rejected";
  if (decimalGreaterThanZero(order.filled_base_amount)) return "partially_filled";
  return "sequencer_pending";
}

function decimalGreaterThanZero(value: string | undefined): boolean {
  if (value === undefined || !/^\d+(?:\.\d+)?$/.test(value)) return false;
  return Number(value) > 0;
}

function orderEvidence(
  source: "active_order" | "inactive_order",
  order: LighterAccountOrder,
  clientOrderIndex: string,
): Record<string, unknown> {
  return {
    source,
    clientOrderIndex,
    orderId: order.order_id,
    marketIndex: order.market_index,
    ownerAccountIndex: order.owner_account_index,
    status: order.status ?? null,
    remainingBaseAmount: order.remaining_base_amount ?? null,
    filledBaseAmount: order.filled_base_amount ?? null,
    filledQuoteAmount: order.filled_quote_amount ?? null,
  };
}

function tradeEvidence(
  trade: LighterTrade,
  plan: LighterOrderReadyForSignerPlan,
  clientOrderIndex: string,
): Record<string, unknown> {
  return {
    source: "account_trade",
    clientOrderIndex,
    tradeId: trade.trade_id_str,
    orderId: orderIdFromTrade(trade, plan),
    marketIndex: trade.market_id,
    size: trade.size,
    price: trade.price,
    accountSide: plan.side,
  };
}

function orderIdFromTrade(trade: LighterTrade, plan: LighterOrderReadyForSignerPlan): string {
  return plan.side === "buy" ? trade.bid_id_str : trade.ask_id_str;
}

function ambiguous(
  plan: LighterOrderReadyForSignerPlan,
  reason: string,
  signerTxHash: string | null,
): ExecuteApprovedLighterCreateOrderResult {
  return {
    status: "ambiguous",
    intentId: plan.intentId,
    environment: plan.environment,
    executionState: "ambiguous",
    reason,
    signerTxHash,
    message:
      "The Lighter order submission state is ambiguous. Vex must reconcile the nonce and provider order state before any retry.",
  };
}

async function markAmbiguous(
  deps: ExecuteApprovedLighterCreateOrderDeps,
  plan: LighterOrderReadyForSignerPlan,
  reason: string,
): Promise<void> {
  await deps.intents.markAmbiguous({
    intentId: plan.intentId,
    sessionId: plan.sessionId,
    environment: plan.environment,
    reason,
  });
}

function blockedBeforeSubmit(message: string): VexError {
  return new VexError(
    ErrorCodes.LIGHTER_INVALID_REQUEST,
    message,
    "Restart from a fresh Lighter preview and approval before attempting submission.",
  );
}
