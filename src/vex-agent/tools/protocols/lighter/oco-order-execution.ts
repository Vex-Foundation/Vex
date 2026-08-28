import { LIGHTER_ENDPOINTS, type LighterEnvironment } from "@tools/lighter/constants.js";
import type { LighterClient } from "@tools/lighter/client.js";
import {
  buildLighterAccountAuthSigningInput,
  createLighterAccountAuthWithAdapter,
  type LighterSignerAdapter,
} from "@tools/lighter/signer-adapter.js";
import {
  buildLighterCreateGroupedOrdersSigningInput,
  signLighterCreateGroupedOrdersWithAdapter,
  type LighterGroupedOrderSignerAdapter,
} from "@tools/lighter/signer-grouped-orders.js";
import type { LighterUnsignedOcoRequest } from "@tools/lighter/oco-order.js";
import {
  loadLighterTradingSecretMaterial,
  type LighterTradingSecretReader,
} from "@tools/lighter/trading-secret.js";
import type { LighterAccountOrder, LighterTrade } from "@tools/lighter/types.js";
import { LIGHTER_ORDER_PREVIEW_FRESHNESS_MS } from "@tools/lighter/order-preview.js";
import { ErrorCodes, VexError } from "../../../../errors.js";
import { withTransaction } from "@vex-agent/db/client.js";
import * as intentsRepo from "@vex-agent/db/repos/lighter-oco-execution-intents.js";
import * as nonceRepo from "@vex-agent/db/repos/lighter-nonce-state.js";
import * as previewsRepo from "@vex-agent/db/repos/lighter-order-previews.js";
import {
  findMatchingLighterOrder,
  findMatchingLighterTrade,
  lighterOrderEvidenceJson,
  lighterOrderIdFromTrade,
  lighterTradeEvidenceJson,
  stateFromActiveLighterOrder,
  stateFromInactiveLighterOrder,
} from "./order-evidence.js";
import type { LighterOcoExecutionPlan } from "./oco-execution-plan.js";
import { ocoLegRevalidationPlan } from "./oco-execution-plan.js";
import { revalidateApprovedLighterOrder } from "./pre-submit-revalidation.js";

const FRESH = { fresh: true } as const;
const AUTH_TTL_SECONDS = 10 * 60;
const ACTIVE_ATTEMPTS = 3;

export type ExecuteApprovedLighterOcoResult =
  | {
      readonly status: "active" | "resolved" | "rejected";
      readonly intentId: string;
      readonly executionState: "active" | "resolved" | "rejected";
      readonly signerTxHash: string;
      readonly submittedTxHash: string;
      readonly stopLossClientOrderIndex: string;
      readonly takeProfitClientOrderIndex: string;
      readonly evidence: Record<string, unknown>;
    }
  | {
      readonly status: "sequencer_pending";
      readonly intentId: string;
      readonly executionState: "sequencer_pending";
      readonly signerTxHash: string;
      readonly submittedTxHash: string;
      readonly stopLossClientOrderIndex: string;
      readonly takeProfitClientOrderIndex: string;
      readonly evidence: Record<string, unknown>;
    }
  | {
      readonly status: "ambiguous";
      readonly intentId: string;
      readonly executionState: "ambiguous";
      readonly reason: string;
      readonly signerTxHash: string | null;
    };

export interface LighterOcoExecutionDeps {
  readonly secretReader: LighterTradingSecretReader;
  readonly authSigner: LighterSignerAdapter;
  readonly groupedSigner: LighterGroupedOrderSignerAdapter;
  readonly client: Pick<LighterClient,
    | "sendTx" | "getApiKeys" | "getNextNonce" | "getMarketDetails"
    | "getOrderBookOrders" | "getAccount" | "getAccountActiveOrders"
    | "getAccountInactiveOrders" | "getAccountTrades">;
  readonly intents: Pick<typeof intentsRepo,
    | "markPreSubmitRevalidated" | "attachNonceReservationWith" | "markSigned"
    | "markSubmitted" | "markApiAccepted" | "markSequencerPending"
    | "markProviderOutcome" | "markAmbiguous">;
  readonly previews: Pick<typeof previewsRepo, "findFreshById">;
  readonly nonceState: Pick<typeof nonceRepo, "recordExecutionObserved" | "reserveObservedWith">;
  readonly transaction: typeof withTransaction;
  readonly now: () => number;
  readonly wait: (delayMs: number) => Promise<void>;
}

let configuredDeps: LighterOcoExecutionDeps | null = null;

export function configureLighterOcoExecutionDeps(deps: LighterOcoExecutionDeps): () => void {
  configuredDeps = deps;
  return () => { if (configuredDeps === deps) configuredDeps = null; };
}

export function getConfiguredLighterOcoExecutionDeps(): LighterOcoExecutionDeps | null {
  return configuredDeps;
}

export function defaultLighterOcoExecutionDeps(input: {
  readonly secretReader: LighterTradingSecretReader;
  readonly authSigner: LighterSignerAdapter;
  readonly groupedSigner: LighterGroupedOrderSignerAdapter;
  readonly client: LighterOcoExecutionDeps["client"];
}): LighterOcoExecutionDeps {
  return {
    ...input,
    intents: intentsRepo,
    previews: previewsRepo,
    nonceState: nonceRepo,
    transaction: withTransaction,
    now: Date.now,
    wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}

export async function executeApprovedLighterOco(input: {
  readonly plan: LighterOcoExecutionPlan;
  readonly group: LighterUnsignedOcoRequest;
  readonly deps: LighterOcoExecutionDeps;
}): Promise<ExecuteApprovedLighterOcoResult> {
  const { plan, group, deps } = input;
  await revalidate(plan, deps);
  const credential = await readCredential(plan, deps);
  const secret = await loadLighterTradingSecretMaterial(plan.credentialReference, deps.secretReader);
  const auth = await createLighterAccountAuthWithAdapter(
    buildLighterAccountAuthSigningInput({
      order: group.orders[0],
      secret,
      deadlineUnixSeconds: Math.floor(deps.now() / 1000) + AUTH_TTL_SECONDS,
    }),
    deps.authSigner,
  );
  if (normalizeKey(credential.publicKey) !== normalizeKey(auth.publicKey)) {
    throw blocked("The local Lighter trading key does not match the registered account key.");
  }
  await assertNoExistingChildren(plan, group, auth.authToken, deps);
  const observed = await deps.nonceState.recordExecutionObserved({
    environment: plan.environment,
    accountIndex: plan.accountIndex,
    apiKeyIndex: plan.apiKeyIndex,
    nonce: credential.nextNonce,
    publicKey: credential.publicKey,
    transactionTime: credential.transactionTime,
  });
  if (observed === null) {
    throw blocked("The live Lighter nonce is blocked by an unresolved local reservation.");
  }
  const reservation = await reserveNonce(plan, deps);
  let signerTxHash: string | null = null;
  try {
    const signed = await signLighterCreateGroupedOrdersWithAdapter(
      buildLighterCreateGroupedOrdersSigningInput({
        group,
        secret,
        nonce: reservation.nonceValue,
        restBaseUrl: LIGHTER_ENDPOINTS[plan.environment].restBaseUrl,
      }),
      deps.groupedSigner,
    );
    signerTxHash = signed.txHash;
    let persistedSigned;
    try {
      persistedSigned = await deps.intents.markSigned({
        intentId: plan.intentId,
        sessionId: plan.sessionId,
        environment: plan.environment,
        reservationId: reservation.reservationId,
        nonceValue: reservation.nonceValue,
        stopLossClientOrderIndex: group.orders[0].clientOrderIndex,
        takeProfitClientOrderIndex: group.orders[1].clientOrderIndex,
        signerTxHash: signed.txHash,
      });
    } catch {
      await markAmbiguous(plan, deps, "oco_signed_state_persist_failed");
      throw blocked("The signed OCO state could not be persisted before submission.");
    }
    if (persistedSigned === null) {
      await markAmbiguous(plan, deps, "oco_signed_state_persist_failed");
      throw blocked("The signed OCO state could not be persisted before submission.");
    }
    let staged;
    try {
      staged = await deps.intents.markSubmitted({
        intentId: plan.intentId, sessionId: plan.sessionId,
        environment: plan.environment, signerTxHash: signed.txHash,
      });
    } catch {
      await markAmbiguous(plan, deps, "oco_submitted_state_persist_failed");
      throw blocked("The OCO submission stage could not be persisted before sendTx.");
    }
    if (staged === null) {
      await markAmbiguous(plan, deps, "oco_submitted_state_persist_failed");
      throw blocked("The OCO submission stage could not be persisted before sendTx.");
    }
    let response: Awaited<ReturnType<LighterClient["sendTx"]>>;
    try {
      response = await deps.client.sendTx(plan.environment, {
        txType: signed.txType,
        txInfo: signed.txInfo,
      });
    } catch (error) {
      const reason = structuralSendFailure(error);
      await markAmbiguous(plan, deps, reason);
      return ambiguous(plan, reason, signed.txHash);
    }
    if (response.code !== 200 || response.tx_hash !== signed.txHash) {
      const reason = response.code !== 200 ? "oco_provider_non_acceptance_code" : "oco_provider_tx_hash_mismatch";
      await markAmbiguous(plan, deps, reason);
      return ambiguous(plan, reason, signed.txHash);
    }
    let accepted;
    try {
      accepted = await deps.intents.markApiAccepted({
        intentId: plan.intentId, sessionId: plan.sessionId, environment: plan.environment,
        signerTxHash: signed.txHash, submittedTxHash: response.tx_hash,
        submitCode: response.code, submitMessage: response.message ?? null,
        predictedExecutionTimeMs: response.predicted_execution_time_ms,
        volumeQuotaRemaining: response.volume_quota_remaining ?? null,
      });
    } catch {
      await markAmbiguous(plan, deps, "oco_api_acceptance_persist_failed");
      return ambiguous(plan, "oco_api_acceptance_persist_failed", signed.txHash);
    }
    if (accepted === null) {
      await markAmbiguous(plan, deps, "oco_api_acceptance_persist_failed");
      return ambiguous(plan, "oco_api_acceptance_persist_failed", signed.txHash);
    }
    let pending;
    try {
      pending = await deps.intents.markSequencerPending({
        intentId: plan.intentId, sessionId: plan.sessionId, environment: plan.environment,
      });
    } catch {
      await markAmbiguous(plan, deps, "oco_sequencer_pending_persist_failed");
      return ambiguous(plan, "oco_sequencer_pending_persist_failed", signed.txHash);
    }
    if (pending === null) {
      await markAmbiguous(plan, deps, "oco_sequencer_pending_persist_failed");
      return ambiguous(plan, "oco_sequencer_pending_persist_failed", signed.txHash);
    }
    return await reconcileOco({
      plan, group, deps, authToken: auth.authToken,
      signerTxHash: signed.txHash, submittedTxHash: response.tx_hash,
      predictedExecutionTimeMs: response.predicted_execution_time_ms,
    });
  } catch (error) {
    if (signerTxHash === null) await markAmbiguous(plan, deps, "oco_signing_failed_after_nonce_reservation");
    throw error;
  }
}

async function revalidate(plan: LighterOcoExecutionPlan, deps: LighterOcoExecutionDeps): Promise<void> {
  const [stopLoss, takeProfit] = await Promise.all([
    deps.previews.findFreshById(plan.sessionId, plan.environment, plan.stopLossPreviewId),
    deps.previews.findFreshById(plan.sessionId, plan.environment, plan.takeProfitPreviewId),
  ]);
  if (stopLoss === null || takeProfit === null) {
    throw blocked("One or both exact OCO child previews are no longer fresh.");
  }
  let marketResponse: Awaited<ReturnType<LighterClient["getMarketDetails"]>>;
  let orderBook: Awaited<ReturnType<LighterClient["getOrderBookOrders"]>>;
  let account: Awaited<ReturnType<LighterClient["getAccount"]>>;
  try {
    [marketResponse, orderBook, account] = await Promise.all([
      deps.client.getMarketDetails(plan.environment, { marketId: plan.marketIndex, filter: "all" }, FRESH),
      deps.client.getOrderBookOrders(plan.environment, { marketId: plan.marketIndex, limit: 250 }, FRESH),
      deps.client.getAccount(plan.environment, { by: "index", value: plan.accountIndex }, FRESH),
    ]);
  } catch {
    throw blocked("Fresh Lighter market, book, or position evidence is unavailable for OCO revalidation.");
  }
  const market = marketResponse.order_book_details.find((row) => row.market_id === plan.marketIndex);
  if (market === undefined || market.market_type !== "perp") {
    throw blocked("The approved perpetual market is unavailable during OCO revalidation.");
  }
  const previewNowMs = Date.parse(stopLoss.expiresAt) - LIGHTER_ORDER_PREVIEW_FRESHNESS_MS;
  const stopEvidence = revalidateApprovedLighterOrder({
    plan: ocoLegRevalidationPlan(plan, "stop-loss"), approvedPreview: stopLoss,
    context: { market, orderBook, account }, nowMs: previewNowMs,
  });
  const takeEvidence = revalidateApprovedLighterOrder({
    plan: ocoLegRevalidationPlan(plan, "take-profit"), approvedPreview: takeProfit,
    context: { market, orderBook, account }, nowMs: previewNowMs,
  });
  const persisted = await deps.intents.markPreSubmitRevalidated({
    intentId: plan.intentId, sessionId: plan.sessionId, environment: plan.environment,
    evidence: {
      kind: "lighter_oco_pre_submit_revalidation",
      checkedAt: new Date(deps.now()).toISOString(),
      stopLoss: stopEvidence,
      takeProfit: takeEvidence,
      groupChecks: ["same_position", "same_size", "same_side", "same_expiry", "both_reduce_only"],
    },
  });
  if (persisted === null) throw blocked("OCO revalidation evidence could not be persisted.");
}

async function readCredential(plan: LighterOcoExecutionPlan, deps: LighterOcoExecutionDeps): Promise<{
  readonly publicKey: string; readonly nextNonce: number; readonly transactionTime: number;
}> {
  let keys: Awaited<ReturnType<LighterClient["getApiKeys"]>>;
  let nonce: Awaited<ReturnType<LighterClient["getNextNonce"]>>;
  try {
    [keys, nonce] = await Promise.all([
      deps.client.getApiKeys(plan.environment, { accountIndex: plan.accountIndex, apiKeyIndex: plan.apiKeyIndex }, FRESH),
      deps.client.getNextNonce(plan.environment, { accountIndex: plan.accountIndex, apiKeyIndex: plan.apiKeyIndex }, FRESH),
    ]);
  } catch {
    throw blocked("Lighter API-key identity or next nonce is unavailable.");
  }
  const matches = keys.api_keys.filter((key) =>
    key.account_index === plan.accountIndex && key.api_key_index === plan.apiKeyIndex);
  const key = matches[0];
  if (matches.length !== 1 || key === undefined) throw blocked("The exact registered Lighter API key is unavailable.");
  return { publicKey: key.public_key, nextNonce: nonce.nonce, transactionTime: key.transaction_time };
}

async function assertNoExistingChildren(
  plan: LighterOcoExecutionPlan,
  group: LighterUnsignedOcoRequest,
  authToken: string,
  deps: LighterOcoExecutionDeps,
): Promise<void> {
  const auth = { token: authToken, accountIndex: plan.accountIndex };
  let active: Awaited<ReturnType<LighterClient["getAccountActiveOrders"]>>;
  let inactive: Awaited<ReturnType<LighterClient["getAccountInactiveOrders"]>>;
  let trades: Awaited<ReturnType<LighterClient["getAccountTrades"]>>;
  try {
    [active, inactive, trades] = await Promise.all([
      deps.client.getAccountActiveOrders(plan.environment, { accountIndex: plan.accountIndex, marketId: plan.marketIndex, marketType: "all" }, auth),
      deps.client.getAccountInactiveOrders(plan.environment, { accountIndex: plan.accountIndex, marketId: plan.marketIndex, marketType: "all", limit: 100 }, auth),
      deps.client.getAccountTrades(plan.environment, { accountIndex: plan.accountIndex, limit: 100, sortBy: "timestamp" }, auth),
    ]);
  } catch {
    throw blocked("Authenticated OCO outcome repair is unavailable before submission.");
  }
  for (const order of group.orders) {
    if (
      findMatchingLighterOrder([...active.orders, ...inactive.orders], plan, order.clientOrderIndex) !== null
      || findMatchingLighterTrade(trades.trades, plan, order.clientOrderIndex, "__vex_oco_preflight__") !== null
    ) throw blocked("A child client-order id already exists before OCO submission.");
  }
}

async function reserveNonce(plan: LighterOcoExecutionPlan, deps: LighterOcoExecutionDeps): Promise<{
  readonly reservationId: string; readonly nonceValue: string;
}> {
  return deps.transaction(async (client) => {
    const reservationId = `lighter-oco:${plan.intentId}`;
    const reserved = await deps.nonceState.reserveObservedWith(client, {
      environment: plan.environment, accountIndex: plan.accountIndex,
      apiKeyIndex: plan.apiKeyIndex, reservationId,
    });
    if (reserved?.reservedNonce == null || reserved.reservationId == null) {
      throw blocked("No observed Lighter nonce is available for this OCO group.");
    }
    const attached = await deps.intents.attachNonceReservationWith(client, {
      intentId: plan.intentId, sessionId: plan.sessionId, environment: plan.environment,
      accountIndex: plan.accountIndex, apiKeyIndex: plan.apiKeyIndex,
      reservationId: reserved.reservationId, nonceValue: reserved.reservedNonce,
    });
    if (attached === null) throw blocked("The OCO nonce reservation could not be attached atomically.");
    return { reservationId: reserved.reservationId, nonceValue: reserved.reservedNonce };
  });
}

async function reconcileOco(input: {
  readonly plan: LighterOcoExecutionPlan; readonly group: LighterUnsignedOcoRequest;
  readonly deps: LighterOcoExecutionDeps; readonly authToken: string;
  readonly signerTxHash: string; readonly submittedTxHash: string;
  readonly predictedExecutionTimeMs: number;
}): Promise<ExecuteApprovedLighterOcoResult> {
  const { plan, group, deps } = input;
  const auth = { token: input.authToken, accountIndex: plan.accountIndex };
  try {
    const delay = Math.min(2_000, Math.max(100, Math.ceil(input.predictedExecutionTimeMs || 100)));
    for (let attempt = 0; attempt < ACTIVE_ATTEMPTS; attempt += 1) {
      const active = await deps.client.getAccountActiveOrders(plan.environment, {
        accountIndex: plan.accountIndex, marketId: plan.marketIndex, marketType: "all",
      }, auth);
      const evidence = classifyOcoEvidence(plan, group, active.orders, [], [], input.submittedTxHash);
      if (evidence.state === "active") return persistOutcome(input, evidence);
      if (attempt < ACTIVE_ATTEMPTS - 1) await deps.wait(delay * (attempt + 1));
    }
    const [active, inactive, trades] = await Promise.all([
      deps.client.getAccountActiveOrders(plan.environment, { accountIndex: plan.accountIndex, marketId: plan.marketIndex, marketType: "all" }, auth),
      deps.client.getAccountInactiveOrders(plan.environment, { accountIndex: plan.accountIndex, marketId: plan.marketIndex, marketType: "all", limit: 100 }, auth),
      deps.client.getAccountTrades(plan.environment, { accountIndex: plan.accountIndex, limit: 100, sortBy: "timestamp" }, auth),
    ]);
    return persistOutcome(input, classifyOcoEvidence(plan, group, active.orders, inactive.orders, trades.trades, input.submittedTxHash));
  } catch {
    await markAmbiguous(plan, deps, "oco_provider_outcome_read_failed");
    return ambiguous(plan, "oco_provider_outcome_read_failed", input.signerTxHash);
  }
}

export function classifyOcoEvidence(
  plan: Pick<LighterOcoExecutionPlan, "accountIndex" | "marketIndex" | "side">,
  group: LighterUnsignedOcoRequest,
  active: readonly LighterAccountOrder[],
  inactive: readonly LighterAccountOrder[],
  trades: readonly LighterTrade[],
  _submittedTxHash: string,
): { readonly state: "active" | "resolved" | "rejected" | "sequencer_pending"; readonly evidence: Record<string, unknown> } {
  const leg = (index: 0 | 1, name: "stop_loss" | "take_profit") => {
    const clientOrderIndex = group.orders[index].clientOrderIndex;
    const activeOrder = findMatchingLighterOrder(active, plan, clientOrderIndex);
    if (activeOrder !== null) return { name, state: stateFromActiveLighterOrder(activeOrder),
      source: "active_order", evidence: lighterOrderEvidenceJson("active_order", activeOrder, clientOrderIndex) };
    const inactiveOrder = findMatchingLighterOrder(inactive, plan, clientOrderIndex);
    if (inactiveOrder !== null) return { name, state: stateFromInactiveLighterOrder(inactiveOrder),
      source: "inactive_order", evidence: lighterOrderEvidenceJson("inactive_order", inactiveOrder, clientOrderIndex) };
    // Grouped transactions share one transaction hash across both children, so
    // tx-hash fallback could incorrectly attribute one fill to both legs. OCO
    // reconciliation therefore requires the exact child client-order index.
    const trade = findMatchingLighterTrade(trades, plan, clientOrderIndex, "__vex_oco_child_id_only__");
    if (trade !== null) return { name, state: "partially_filled", source: "account_trade",
      evidence: { ...lighterTradeEvidenceJson(trade, plan, clientOrderIndex), orderId: lighterOrderIdFromTrade(trade, plan) } };
    return { name, state: "not_found", source: "not_found", evidence: { clientOrderIndex } };
  };
  const stopLoss = leg(0, "stop_loss");
  const takeProfit = leg(1, "take_profit");
  const states = [stopLoss.state, takeProfit.state];
  const bothActive = states.every((state) => state === "open" || state === "partially_filled");
  const hasFill = states.some((state) => state === "filled" || state === "partially_filled");
  const siblingEnded = states.some((state) => state === "canceled" || state === "rejected");
  const bothRejected = states.every((state) => state === "canceled" || state === "rejected");
  const state = bothActive ? "active" : hasFill && siblingEnded ? "resolved" : bothRejected ? "rejected" : "sequencer_pending";
  return {
    state,
    evidence: {
      kind: "lighter_oco_provider_evidence",
      groupingType: "one-cancels-the-other",
      stopLoss,
      takeProfit,
      completePairVisible: state === "active" || state === "resolved" || state === "rejected",
    },
  };
}

async function persistOutcome(
  input: Parameters<typeof reconcileOco>[0],
  outcome: ReturnType<typeof classifyOcoEvidence>,
): Promise<ExecuteApprovedLighterOcoResult> {
  const persisted = await input.deps.intents.markProviderOutcome({
    intentId: input.plan.intentId, sessionId: input.plan.sessionId,
    environment: input.plan.environment, state: outcome.state, evidence: outcome.evidence,
  });
  if (persisted === null) {
    await markAmbiguous(input.plan, input.deps, "oco_provider_outcome_persist_failed");
    return ambiguous(input.plan, "oco_provider_outcome_persist_failed", input.signerTxHash);
  }
  const common = {
    intentId: input.plan.intentId,
    signerTxHash: input.signerTxHash,
    submittedTxHash: input.submittedTxHash,
    stopLossClientOrderIndex: input.group.orders[0].clientOrderIndex,
    takeProfitClientOrderIndex: input.group.orders[1].clientOrderIndex,
    evidence: outcome.evidence,
  };
  if (outcome.state === "active" || outcome.state === "resolved" || outcome.state === "rejected") {
    return { status: outcome.state, executionState: outcome.state, ...common };
  }
  return { status: "sequencer_pending", executionState: "sequencer_pending", ...common };
}

function normalizeKey(value: string): string {
  return value.trim().replace(/^0x/i, "").toLowerCase();
}

function structuralSendFailure(error: unknown): string {
  if (error instanceof VexError) {
    return `oco_sendtx_failed_after_submit_attempt:code=${error.code}${
      typeof error.httpStatus === "number" ? `,http=${error.httpStatus}` : ""}`;
  }
  return "oco_sendtx_failed_after_submit_attempt";
}

async function markAmbiguous(
  plan: LighterOcoExecutionPlan,
  deps: LighterOcoExecutionDeps,
  reason: string,
): Promise<void> {
  await deps.intents.markAmbiguous({
    intentId: plan.intentId, sessionId: plan.sessionId,
    environment: plan.environment, reason,
  });
}

function ambiguous(
  plan: LighterOcoExecutionPlan,
  reason: string,
  signerTxHash: string | null,
): ExecuteApprovedLighterOcoResult {
  return { status: "ambiguous", executionState: "ambiguous", intentId: plan.intentId, reason, signerTxHash };
}

function blocked(reason: string): VexError {
  return new VexError(
    ErrorCodes.LIGHTER_INVALID_REQUEST,
    `${reason} No grouped order was submitted.`,
    "Run lighter.order.status for unresolved state, or restart from a fresh OCO preview when safe.",
  );
}
