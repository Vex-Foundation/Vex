import type { LighterClient } from "@tools/lighter/client.js";
import type { LighterAccountOrder, LighterTrade } from "@tools/lighter/types.js";
import {
  buildLighterAccountAuthSigningInput,
  buildLighterCreateOrderSigningInput,
  createLighterAccountAuthWithAdapter,
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
import * as lighterOrderPreviewsRepo from "@vex-agent/db/repos/lighter-order-previews.js";
import * as lighterNonceStateRepo from "@vex-agent/db/repos/lighter-nonce-state.js";
import {
  reserveLighterOrderNonceForSigning,
  type LighterOrderNonceReservation,
} from "./nonce-reservation.js";
import type { LighterOrderReadyForSignerPlan } from "./execution-plan.js";
import {
  findMatchingLighterOrder,
  findMatchingLighterTrade,
  lighterOrderEvidenceJson,
  lighterOrderIdFromTrade,
  lighterTradeEvidenceJson,
  stateFromActiveLighterOrder,
  stateFromInactiveLighterOrder,
} from "./order-evidence.js";
import { revalidateApprovedLighterOrder } from "./pre-submit-revalidation.js";
import { assertLighterPhaseOneOrderPolicy } from "@tools/lighter/order-policy.js";
import { assertLighterTradingApiKeyIndexAllowed } from "@tools/lighter/trading-credentials.js";

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
const ACCOUNT_AUTH_TTL_SECONDS = 10 * 60;
const PROVIDER_OUTCOME_ACTIVE_ATTEMPTS = 3;
const PROVIDER_OUTCOME_MIN_DELAY_MS = 100;
const PROVIDER_OUTCOME_MAX_DELAY_MS = 2_000;
const FRESH_PUBLIC_READ = { fresh: true } as const;

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
  readonly secretReader: LighterTradingSecretReader;
  readonly reserveNonce: typeof reserveLighterOrderNonceForSigning;
  readonly signer: LighterSignerAdapter;
  readonly client: Pick<
    LighterClient,
    | "sendTx"
    | "getApiKeys"
    | "getNextNonce"
    | "getMarketDetails"
    | "getOrderBookOrders"
    | "getAccount"
    | "getAccountActiveOrders"
    | "getAccountInactiveOrders"
    | "getAccountTrades"
  >;
  readonly nonceState: Pick<typeof lighterNonceStateRepo, "recordExecutionObserved">;
  readonly previews: Pick<typeof lighterOrderPreviewsRepo, "findFreshById">;
  readonly now: () => number;
  readonly wait: (delayMs: number) => Promise<void>;
  readonly intents: Pick<
    typeof lighterOrderExecutionIntentsRepo,
    | "markSigned"
    | "markPreSubmitRevalidated"
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
  assertLighterTradingApiKeyIndexAllowed(plan.environment, plan.apiKeyIndex);
  assertLighterPhaseOneOrderPolicy(plan.orderType, plan.timeInForce);
  await revalidateLiveOrderState(plan, deps);
  // Prove the exact registered provider key and current nonce before asking
  // the encrypted vault for private key material. Besides minimizing secret
  // exposure time, this keeps every provider-read refusal truthful: no private
  // trading key has been loaded when public identity evidence is unavailable.
  const providerCredential = await readLiveProviderCredential(plan, deps);
  const secret = await loadLighterTradingSecretMaterial(
    plan.credentialReference,
    deps.secretReader,
  );
  const auth = await createLighterAccountAuthWithAdapter(
    buildLighterAccountAuthSigningInput({
      order: unsignedOrder,
      secret,
      deadlineUnixSeconds: Math.floor(deps.now() / 1_000) + ACCOUNT_AUTH_TTL_SECONDS,
    }),
    deps.signer,
  );
  assertProviderPublicKeyMatches(providerCredential.publicKey, auth.publicKey);
  const [, observedNonce] = await Promise.all([
    assertProviderOutcomeRepairReady(plan, unsignedOrder, auth.authToken, deps),
    deps.nonceState.recordExecutionObserved({
      environment: plan.environment,
      accountIndex: plan.accountIndex,
      apiKeyIndex: plan.apiKeyIndex,
      nonce: providerCredential.nextNonce,
      publicKey: providerCredential.publicKey,
      transactionTime: providerCredential.transactionTime,
    }),
  ]);
  if (observedNonce === null) {
    throw blockedBeforeSubmit(
      "The live Lighter nonce has not advanced beyond an unresolved local reservation. No order was signed or submitted. "
      + "Run lighter.order.status to reconcile the stuck reservation from provider evidence before preparing another order.",
    );
  }
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
    } catch (error) {
      const reason = sendTxAmbiguousReason(error);
      await markAmbiguous(deps, plan, reason);
      return ambiguous(plan, reason, signed.txHash);
    }

    if (response.code !== 200) {
      await markAmbiguous(deps, plan, PROVIDER_CODE_AMBIGUOUS_REASON);
      return ambiguous(plan, PROVIDER_CODE_AMBIGUOUS_REASON, signed.txHash);
    }
    if (response.tx_hash !== signed.txHash) {
      await markAmbiguous(deps, plan, PROVIDER_HASH_MISMATCH_AMBIGUOUS_REASON);
      return ambiguous(plan, PROVIDER_HASH_MISMATCH_AMBIGUOUS_REASON, signed.txHash);
    }

    let accepted: Awaited<ReturnType<typeof lighterOrderExecutionIntentsRepo.markApiAccepted>>;
    try {
      accepted = await deps.intents.markApiAccepted({
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
    } catch {
      await markAmbiguous(deps, plan, API_ACCEPTED_PERSIST_AMBIGUOUS_REASON);
      return ambiguous(plan, API_ACCEPTED_PERSIST_AMBIGUOUS_REASON, signed.txHash);
    }
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
      accountAuthToken: auth.authToken,
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
      | "sendTx"
      | "getApiKeys"
      | "getNextNonce"
      | "getMarketDetails"
      | "getOrderBookOrders"
      | "getAccount"
      | "getAccountActiveOrders"
      | "getAccountInactiveOrders"
      | "getAccountTrades"
    >;
  },
): ExecuteApprovedLighterCreateOrderDeps {
  return {
    reserveNonce: reserveLighterOrderNonceForSigning,
    intents: lighterOrderExecutionIntentsRepo,
    nonceState: lighterNonceStateRepo,
    previews: lighterOrderPreviewsRepo,
    now: Date.now,
    wait: (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
    ...overrides,
  };
}

async function revalidateLiveOrderState(
  plan: LighterOrderReadyForSignerPlan,
  deps: ExecuteApprovedLighterCreateOrderDeps,
): Promise<void> {
  const approvedPreview = await deps.previews.findFreshById(
    plan.sessionId,
    plan.environment,
    plan.previewId,
  );
  if (approvedPreview === null) {
    throw blockedBeforeSubmit(
      "The exact approved Lighter preview is no longer fresh or available. No trading key was loaded and no order was signed or submitted.",
    );
  }

  let market: Awaited<ReturnType<LighterClient["getMarketDetails"]>>;
  let orderBook: Awaited<ReturnType<LighterClient["getOrderBookOrders"]>>;
  let account: Awaited<ReturnType<LighterClient["getAccount"]>>;
  try {
    [market, orderBook, account] = await Promise.all([
      deps.client.getMarketDetails(plan.environment, {
        marketId: plan.marketIndex,
        filter: "all",
      }, FRESH_PUBLIC_READ),
      deps.client.getOrderBookOrders(plan.environment, {
        marketId: plan.marketIndex,
        limit: 250,
      }, FRESH_PUBLIC_READ),
      deps.client.getAccount(plan.environment, {
        by: "index",
        value: plan.accountIndex,
      }, FRESH_PUBLIC_READ),
    ]);
  } catch {
    throw blockedBeforeSubmit(
      "Live Lighter market or account state is unavailable for post-approval revalidation. No trading key was loaded and no order was signed or submitted.",
    );
  }
  const marketDetail = [
    ...market.order_book_details,
    ...market.spot_order_book_details,
  ].find((detail) => detail.market_id === plan.marketIndex);
  if (marketDetail === undefined) {
    throw blockedBeforeSubmit(
      "Lighter did not return the approved market during post-approval revalidation. No trading key was loaded and no order was signed or submitted.",
    );
  }

  const evidence = revalidateApprovedLighterOrder({
    plan,
    approvedPreview,
    context: { market: marketDetail, orderBook, account },
    nowMs: deps.now(),
  });
  const persisted = await deps.intents.markPreSubmitRevalidated({
    intentId: plan.intentId,
    sessionId: plan.sessionId,
    environment: plan.environment,
    evidence: { ...evidence },
  });
  if (persisted === null) {
    throw blockedBeforeSubmit(
      "Lighter pre-submit revalidation evidence could not be persisted. No trading key was loaded and no order was signed or submitted.",
    );
  }
}

async function readLiveProviderCredential(
  plan: LighterOrderReadyForSignerPlan,
  deps: ExecuteApprovedLighterCreateOrderDeps,
): Promise<{
  readonly publicKey: string;
  readonly nextNonce: number;
  readonly transactionTime: number;
}> {
  let apiKeys: Awaited<ReturnType<LighterClient["getApiKeys"]>>;
  let nextNonce: Awaited<ReturnType<LighterClient["getNextNonce"]>>;
  try {
    [apiKeys, nextNonce] = await Promise.all([
      deps.client.getApiKeys(plan.environment, {
        accountIndex: plan.accountIndex,
        apiKeyIndex: plan.apiKeyIndex,
      }, FRESH_PUBLIC_READ),
      deps.client.getNextNonce(plan.environment, {
        accountIndex: plan.accountIndex,
        apiKeyIndex: plan.apiKeyIndex,
      }, FRESH_PUBLIC_READ),
    ]);
  } catch {
    throw blockedBeforeSubmit(
      "Lighter API-key identity or next nonce is unavailable. No trading key was loaded and no order was signed or submitted.",
    );
  }
  const matches = apiKeys.api_keys.filter((key) =>
    key.account_index === plan.accountIndex && key.api_key_index === plan.apiKeyIndex);
  const key = matches[0];
  if (matches.length !== 1 || key === undefined) {
    throw blockedBeforeSubmit(
      "The exact Lighter trading API key is not registered for the approved account scope. No trading key was loaded and no order was signed or submitted.",
    );
  }
  return {
    publicKey: key.public_key,
    nextNonce: nextNonce.nonce,
    transactionTime: key.transaction_time,
  };
}

function assertProviderPublicKeyMatches(providerPublicKey: string, signerPublicKey: string): void {
  const normalize = (value: string) => value.trim().replace(/^0x/i, "").toLowerCase();
  if (normalize(providerPublicKey) !== normalize(signerPublicKey)) {
    throw blockedBeforeSubmit(
      "The encrypted Lighter trading key does not match the public key registered for the approved account scope. No nonce was reserved and no order was signed or submitted.",
    );
  }
}

async function assertProviderOutcomeRepairReady(
  plan: LighterOrderReadyForSignerPlan,
  unsignedOrder: LighterUnsignedCreateOrderRequest,
  accountAuthToken: string,
  deps: ExecuteApprovedLighterCreateOrderDeps,
): Promise<void> {
  const privilegedAuth = { token: accountAuthToken, accountIndex: plan.accountIndex };
  let activeOrders: Awaited<ReturnType<LighterClient["getAccountActiveOrders"]>>;
  let inactiveOrders: Awaited<ReturnType<LighterClient["getAccountInactiveOrders"]>>;
  let trades: Awaited<ReturnType<LighterClient["getAccountTrades"]>>;
  try {
    [activeOrders, inactiveOrders, trades] = await Promise.all([
      deps.client.getAccountActiveOrders(plan.environment, {
        accountIndex: plan.accountIndex,
        marketId: plan.marketIndex,
        marketType: "all",
      }, privilegedAuth),
      deps.client.getAccountInactiveOrders(plan.environment, {
        accountIndex: plan.accountIndex,
        marketId: plan.marketIndex,
        marketType: "all",
        limit: 100,
      }, privilegedAuth),
      deps.client.getAccountTrades(plan.environment, {
        accountIndex: plan.accountIndex,
        limit: 100,
        sortBy: "timestamp",
      }, privilegedAuth),
    ]);
  } catch {
    throw blockedBeforeSubmit(
      "Lighter provider outcome repair is unavailable before submission. No order was signed or submitted.",
    );
  }

  const existingOrder = findMatchingLighterOrder(
    [...activeOrders.orders, ...inactiveOrders.orders],
    plan,
    unsignedOrder.clientOrderIndex,
  );
  const existingTrade = findMatchingLighterTrade(
    trades.trades,
    plan,
    unsignedOrder.clientOrderIndex,
    "__vex_preflight_no_tx_hash__",
  );
  if (existingOrder !== null || existingTrade !== null) {
    throw blockedBeforeSubmit(
      "A Lighter order or trade with the same Vex client order id is already visible before submission. No order was signed or submitted.",
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
  readonly accountAuthToken: string;
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
    accountAuthToken,
  } = input;

  try {
    const delayMs = providerOutcomeDelayMs(predictedExecutionTimeMs);
    for (let attempt = 0; attempt < PROVIDER_OUTCOME_ACTIVE_ATTEMPTS; attempt += 1) {
      const activeOrders = await deps.client.getAccountActiveOrders(
        plan.environment,
        {
          accountIndex: plan.accountIndex,
          marketId: plan.marketIndex,
          marketType: "all",
        },
        { token: accountAuthToken, accountIndex: plan.accountIndex },
      );
      const active = findMatchingLighterOrder(activeOrders.orders, plan, unsignedOrder.clientOrderIndex);
      if (active !== null) {
        return persistProviderOutcomeSafely({
          plan,
          unsignedOrder,
          deps,
          signerTxHash,
          submittedTxHash,
          source: "active_order",
          state: stateFromActiveLighterOrder(active),
          providerOrderId: active.order_id,
          providerOrderStatus: active.status ?? null,
          providerOutcomeJson: lighterOrderEvidenceJson("active_order", active, unsignedOrder.clientOrderIndex),
          submitCode,
          predictedExecutionTimeMs,
          volumeQuotaRemaining,
        });
      }
      if (attempt < PROVIDER_OUTCOME_ACTIVE_ATTEMPTS - 1) {
        await deps.wait(delayMs * (attempt + 1));
      }
    }

    const inactiveOrders = await deps.client.getAccountInactiveOrders(
      plan.environment,
      {
        accountIndex: plan.accountIndex,
        marketId: plan.marketIndex,
        marketType: "all",
        limit: 100,
      },
      { token: accountAuthToken, accountIndex: plan.accountIndex },
    );
    const inactive = findMatchingLighterOrder(inactiveOrders.orders, plan, unsignedOrder.clientOrderIndex);
    if (inactive !== null) {
      return persistProviderOutcomeSafely({
        plan,
        unsignedOrder,
        deps,
        signerTxHash,
        submittedTxHash,
        source: "inactive_order",
        state: stateFromInactiveLighterOrder(inactive),
        providerOrderId: inactive.order_id,
        providerOrderStatus: inactive.status ?? null,
        providerOutcomeJson: lighterOrderEvidenceJson("inactive_order", inactive, unsignedOrder.clientOrderIndex),
        submitCode,
        predictedExecutionTimeMs,
        volumeQuotaRemaining,
      });
    }

    const trades = await deps.client.getAccountTrades(
      plan.environment,
      {
        accountIndex: plan.accountIndex,
        limit: 100,
        sortBy: "timestamp",
      },
      { token: accountAuthToken, accountIndex: plan.accountIndex },
    );
    const trade = findMatchingLighterTrade(
      trades.trades,
      plan,
      unsignedOrder.clientOrderIndex,
      submittedTxHash,
    );
    if (trade !== null) {
      return persistProviderOutcomeSafely({
        plan,
        unsignedOrder,
        deps,
        signerTxHash,
        submittedTxHash,
        source: "account_trade",
        state: "partially_filled",
        providerOrderId: lighterOrderIdFromTrade(trade, plan),
        providerOrderStatus: "trade_seen",
        providerOutcomeJson: lighterTradeEvidenceJson(trade, plan, unsignedOrder.clientOrderIndex),
        submitCode,
        predictedExecutionTimeMs,
        volumeQuotaRemaining,
      });
    }
  } catch {
    await markAmbiguous(deps, plan, PROVIDER_OUTCOME_READ_AMBIGUOUS_REASON);
    return ambiguous(plan, PROVIDER_OUTCOME_READ_AMBIGUOUS_REASON, signerTxHash);
  }

  let persisted: Awaited<ReturnType<ExecuteApprovedLighterCreateOrderDeps["intents"]["markProviderOutcome"]>>;
  try {
    persisted = await deps.intents.markProviderOutcome({
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
  } catch {
    await markAmbiguous(deps, plan, PROVIDER_OUTCOME_PERSIST_AMBIGUOUS_REASON);
    return ambiguous(plan, PROVIDER_OUTCOME_PERSIST_AMBIGUOUS_REASON, signerTxHash);
  }
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

function providerOutcomeDelayMs(predictedExecutionTimeMs: number): number {
  if (!Number.isFinite(predictedExecutionTimeMs)) return PROVIDER_OUTCOME_MIN_DELAY_MS;
  return Math.min(
    PROVIDER_OUTCOME_MAX_DELAY_MS,
    Math.max(PROVIDER_OUTCOME_MIN_DELAY_MS, Math.ceil(predictedExecutionTimeMs)),
  );
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

async function persistProviderOutcomeSafely(
  input: Parameters<typeof persistProviderOutcome>[0],
): Promise<ExecuteApprovedLighterCreateOrderResult> {
  try {
    return await persistProviderOutcome(input);
  } catch {
    await markAmbiguous(input.deps, input.plan, PROVIDER_OUTCOME_PERSIST_AMBIGUOUS_REASON);
    return ambiguous(input.plan, PROVIDER_OUTCOME_PERSIST_AMBIGUOUS_REASON, input.signerTxHash);
  }
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

// Builds the ambiguous reason for a failed `sendTx`. Only the VexError code and
// numeric HTTP status are appended — never the error message, which could echo
// provider-returned signed payload material. Non-VexError throws fall back to the
// bare reason so nothing untrusted is ever persisted or returned.
function sendTxAmbiguousReason(error: unknown): string {
  if (error instanceof VexError) {
    const parts = [`code=${error.code}`];
    if (typeof error.httpStatus === "number") {
      parts.push(`http=${error.httpStatus}`);
    }
    return `${SENDTX_AMBIGUOUS_REASON}:${parts.join(",")}`;
  }
  return SENDTX_AMBIGUOUS_REASON;
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
