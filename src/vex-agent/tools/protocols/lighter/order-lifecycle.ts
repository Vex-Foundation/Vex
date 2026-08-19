import { createHash } from "node:crypto";

import type { LighterAccountOrder } from "@tools/lighter/types.js";
import {
  getLighterClient,
  type LighterClient,
  type LighterPrivilegedAccountAuth,
} from "@tools/lighter/client.js";
import {
  buildLighterAccountAuthSigningInputForScope,
  createLighterAccountAuthWithAdapter,
  type LighterSignerAdapter,
} from "@tools/lighter/signer-adapter.js";
import {
  buildLighterCancelOrderSigningInput,
  type LighterOrderLifecycleSignerAdapter,
} from "@tools/lighter/signer-order-lifecycle.js";
import {
  loadLighterTradingSecretMaterial,
  type LighterTradingSecretReader,
} from "@tools/lighter/trading-secret.js";
import { ErrorCodes, VexError } from "../../../../errors.js";
import { withTransaction } from "@vex-agent/db/client.js";
import * as intentsRepo from "@vex-agent/db/repos/lighter-order-lifecycle-intents.js";
import type { LighterOrderLifecycleIntentRow } from "@vex-agent/db/repos/lighter-order-lifecycle-intents.js";
import * as nonceRepo from "@vex-agent/db/repos/lighter-nonce-state.js";

const AUTH_TTL_SECONDS = 10 * 60;
const SIGNER_EXPIRY_MS = 60_000;
const MAX_RECONCILIATION_ATTEMPTS = 4;

export interface LighterLifecycleOrderSnapshot {
  readonly orderId: string;
  readonly clientOrderId: string;
  readonly marketIndex: number;
  readonly ownerAccountIndex: number;
  readonly initialBaseAmount: string;
  readonly remainingBaseAmount: string;
  readonly filledBaseAmount: string;
  readonly filledQuoteAmount: string;
  readonly price: string;
  readonly status: string;
  readonly side: string;
  readonly type: string;
  readonly timeInForce: string;
  readonly reduceOnly: boolean;
}

export interface LighterCancelOnePreparation {
  readonly environment: LighterOrderLifecycleIntentRow["environment"];
  readonly accountIndex: number;
  readonly apiKeyIndex: number;
  readonly marketIndex: number;
  readonly providerOrderId: string;
  readonly snapshot: LighterLifecycleOrderSnapshot;
  readonly matchHash: string;
}

export type ExecuteApprovedLighterCancelOneResult =
  | {
      readonly status: "canceled";
      readonly intentId: string;
      readonly signerTxHash: string;
      readonly submittedTxHash: string;
      readonly providerOrderId: string;
      readonly providerStatus: string;
      readonly executedAmount: string;
      readonly remainingAmount: string;
      readonly averageFillPrice: string | null;
    }
  | {
      readonly status: "sequencer_pending" | "ambiguous";
      readonly intentId: string;
      readonly signerTxHash: string | null;
      readonly submittedTxHash: string | null;
      readonly reason: string;
    };

export interface LighterOrderLifecycleExecutionDeps {
  readonly secretReader: LighterTradingSecretReader;
  readonly authSigner: LighterSignerAdapter;
  readonly lifecycleSigner: LighterOrderLifecycleSignerAdapter;
  readonly client: Pick<
    LighterClient,
    "getAccountActiveOrders" | "getAccountInactiveOrders" | "getApiKeys" | "getNextNonce" | "sendTx"
  >;
  readonly intents: Pick<
    typeof intentsRepo,
    | "markPreSubmitRevalidated"
    | "attachNonceReservationWith"
    | "markSigned"
    | "markSubmissionStaged"
    | "markApiAccepted"
    | "markProviderOutcome"
    | "markAmbiguous"
  >;
  readonly nonceState: Pick<typeof nonceRepo, "recordExecutionObserved" | "reserveObservedWith">;
  readonly transaction: typeof withTransaction;
  readonly now: () => number;
  readonly wait: (delayMs: number) => Promise<void>;
}

let configuredDeps: LighterOrderLifecycleExecutionDeps | null = null;

export function configureLighterOrderLifecycleExecutionDeps(
  deps: LighterOrderLifecycleExecutionDeps,
): () => void {
  configuredDeps = deps;
  return () => { if (configuredDeps === deps) configuredDeps = null; };
}

export function getConfiguredLighterOrderLifecycleExecutionDeps(): LighterOrderLifecycleExecutionDeps | null {
  return configuredDeps;
}

export function defaultLighterOrderLifecycleExecutionDeps(input: {
  readonly secretReader: LighterTradingSecretReader;
  readonly authSigner: LighterSignerAdapter;
  readonly lifecycleSigner: LighterOrderLifecycleSignerAdapter;
  readonly client?: LighterOrderLifecycleExecutionDeps["client"];
}): LighterOrderLifecycleExecutionDeps {
  return {
    ...input,
    client: input.client ?? getLighterClient(),
    intents: intentsRepo,
    nonceState: nonceRepo,
    transaction: withTransaction,
    now: Date.now,
    wait: (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
  };
}

export async function prepareLighterCancelOne(input: {
  readonly environment: LighterOrderLifecycleIntentRow["environment"];
  readonly accountIndex: number;
  readonly apiKeyIndex: number;
  readonly marketIndex: number;
  readonly providerOrderId: string;
  readonly auth: LighterPrivilegedAccountAuth;
  readonly client?: Pick<LighterClient, "getAccountActiveOrders">;
}): Promise<LighterCancelOnePreparation> {
  assertProviderOrderId(input.providerOrderId);
  const client = input.client ?? getLighterClient();
  const response = await client.getAccountActiveOrders(input.environment, {
    accountIndex: input.accountIndex,
    marketId: input.marketIndex,
  }, input.auth);
  const order = findExactOrder(response.orders, input);
  if (order === null || normalizeStatus(order.status) !== "open") {
    throw blocked("The exact Lighter provider order is not active and open.");
  }
  const snapshot = lifecycleSnapshot(order);
  return {
    environment: input.environment,
    accountIndex: input.accountIndex,
    apiKeyIndex: input.apiKeyIndex,
    marketIndex: input.marketIndex,
    providerOrderId: input.providerOrderId,
    snapshot,
    matchHash: lifecycleMatchHash({
      actionType: "cancel_one",
      environment: input.environment,
      accountIndex: input.accountIndex,
      apiKeyIndex: input.apiKeyIndex,
      snapshot,
    }),
  };
}

export async function executeApprovedLighterCancelOne(
  intent: LighterOrderLifecycleIntentRow,
  deps: LighterOrderLifecycleExecutionDeps,
): Promise<ExecuteApprovedLighterCancelOneResult> {
  assertCancelableIntent(intent, deps.now());
  const secret = await loadLighterTradingSecretMaterial(intent.credentialRefJson, deps.secretReader);
  const authResult = await createLighterAccountAuthWithAdapter(
    buildLighterAccountAuthSigningInputForScope({
      environment: intent.environment,
      accountIndex: intent.accountIndex,
      apiKeyIndex: intent.apiKeyIndex,
      secret,
      deadlineUnixSeconds: Math.floor(deps.now() / 1_000) + AUTH_TTL_SECONDS,
    }),
    deps.authSigner,
  );
  const auth: LighterPrivilegedAccountAuth = { token: authResult.authToken, accountIndex: intent.accountIndex };
  const active = await deps.client.getAccountActiveOrders(intent.environment, {
    accountIndex: intent.accountIndex,
    marketId: intent.marketIndex!,
  }, auth);
  const liveOrder = findExactOrder(active.orders, {
    accountIndex: intent.accountIndex,
    marketIndex: intent.marketIndex!,
    providerOrderId: intent.providerOrderId!,
  });
  if (liveOrder === null || normalizeStatus(liveOrder.status) !== "open") {
    throw blocked("The approved Lighter order is no longer active and open.");
  }
  const liveSnapshot = lifecycleSnapshot(liveOrder);
  if (!sameSnapshot(intent.providerSnapshotJson, liveSnapshot)) {
    throw blocked("The approved Lighter order changed before cancel submission.");
  }

  const apiKeys = await deps.client.getApiKeys(intent.environment, {
    accountIndex: intent.accountIndex,
    apiKeyIndex: intent.apiKeyIndex,
  });
  const providerKey = apiKeys.api_keys.find((candidate) =>
    candidate.account_index === intent.accountIndex && candidate.api_key_index === intent.apiKeyIndex);
  if (providerKey === undefined || canonicalKey(providerKey.public_key) !== canonicalKey(authResult.publicKey)) {
    throw blocked("The registered Lighter trading credential changed.");
  }
  const nextNonce = await deps.client.getNextNonce(intent.environment, {
    accountIndex: intent.accountIndex,
    apiKeyIndex: intent.apiKeyIndex,
  });
  if (nextNonce.nonce !== providerKey.nonce) {
    throw blocked("Lighter returned inconsistent nonce evidence.");
  }
  const evidence = {
    kind: "lighter_cancel_one_pre_submit_revalidation",
    checkedAt: new Date(deps.now()).toISOString(),
    order: liveSnapshot,
    publicKey: canonicalKey(providerKey.public_key),
    nextNonce: nextNonce.nonce,
  };
  const revalidated = await deps.intents.markPreSubmitRevalidated({
    intentId: intent.intentId,
    sessionId: intent.sessionId,
    evidence,
  });
  if (revalidated === null) throw blocked("The cancel intent could not persist revalidation.");
  const observed = await deps.nonceState.recordExecutionObserved({
    environment: intent.environment,
    accountIndex: intent.accountIndex,
    apiKeyIndex: intent.apiKeyIndex,
    nonce: nextNonce.nonce,
    publicKey: canonicalKey(providerKey.public_key),
    transactionTime: providerKey.transaction_time,
  });
  if (observed === null) throw blocked("A previous Lighter nonce remains unresolved.");

  const reservationId = `lighter-lifecycle:${intent.intentId}`;
  const reserved = await deps.transaction(async (client) => {
    const nonce = await deps.nonceState.reserveObservedWith(client, {
      environment: intent.environment,
      accountIndex: intent.accountIndex,
      apiKeyIndex: intent.apiKeyIndex,
      reservationId,
    });
    if (nonce?.reservedNonce == null || nonce.reservationId !== reservationId) {
      throw blocked("The live Lighter nonce could not be reserved.");
    }
    const attached = await deps.intents.attachNonceReservationWith(client, {
      intentId: intent.intentId,
      sessionId: intent.sessionId,
      reservationId,
      nonceValue: nonce.reservedNonce,
    });
    if (attached === null) throw blocked("The cancel intent could not attach its nonce reservation.");
    return nonce.reservedNonce;
  });

  let signerTxHash: string | null = null;
  try {
    const signerExpiryMs = deps.now() + SIGNER_EXPIRY_MS;
    const signed = await deps.lifecycleSigner.signCancelOrder(buildLighterCancelOrderSigningInput({
      environment: intent.environment,
      accountIndex: intent.accountIndex,
      apiKeyIndex: intent.apiKeyIndex,
      nonce: reserved,
      expiredAt: String(signerExpiryMs),
      marketIndex: intent.marketIndex!,
      providerOrderId: intent.providerOrderId!,
      secret,
    }));
    signerTxHash = signed.txHash;
    const signedRow = await deps.intents.markSigned({
      intentId: intent.intentId,
      sessionId: intent.sessionId,
      reservationId,
      signerTxHash: signed.txHash,
      signerExpiryMs,
    });
    if (signedRow === null) return markAndReturnAmbiguous(deps, intent, "signed_state_persist_failed", signed.txHash);
    const staged = await deps.intents.markSubmissionStaged({
      intentId: intent.intentId,
      sessionId: intent.sessionId,
      signerTxHash: signed.txHash,
    });
    if (staged === null) return markAndReturnAmbiguous(deps, intent, "submission_stage_persist_failed", signed.txHash);

    let response;
    try {
      response = await deps.client.sendTx(intent.environment, { txType: signed.txType, txInfo: signed.txInfo });
    } catch {
      return markAndReturnAmbiguous(deps, intent, "send_tx_transport_ambiguous", signed.txHash);
    }
    if (response.code !== 200 || response.tx_hash !== signed.txHash) {
      return markAndReturnAmbiguous(deps, intent, "send_tx_acceptance_mismatch", signed.txHash);
    }
    const accepted = await deps.intents.markApiAccepted({
      intentId: intent.intentId,
      sessionId: intent.sessionId,
      signerTxHash: signed.txHash,
      submittedTxHash: response.tx_hash,
      submitCode: response.code,
      submitMessage: response.message ?? null,
      predictedExecutionTimeMs: response.predicted_execution_time_ms,
      volumeQuotaRemaining: response.volume_quota_remaining == null ? null : String(response.volume_quota_remaining),
    });
    if (accepted === null) return markAndReturnAmbiguous(deps, intent, "api_acceptance_persist_failed", signed.txHash);

    for (let attempt = 0; attempt < MAX_RECONCILIATION_ATTEMPTS; attempt += 1) {
      if (attempt > 0) await deps.wait(Math.min(2_000, 250 * (2 ** attempt)));
      const [activeOrders, inactiveOrders] = await Promise.all([
        deps.client.getAccountActiveOrders(intent.environment, { accountIndex: intent.accountIndex, marketId: intent.marketIndex! }, auth),
        deps.client.getAccountInactiveOrders(intent.environment, { accountIndex: intent.accountIndex, marketId: intent.marketIndex!, limit: 100 }, auth),
      ]);
      const stillActive = findExactOrder(activeOrders.orders, {
        accountIndex: intent.accountIndex, marketIndex: intent.marketIndex!, providerOrderId: intent.providerOrderId!,
      });
      const inactive = findExactOrder(inactiveOrders.orders, {
        accountIndex: intent.accountIndex, marketIndex: intent.marketIndex!, providerOrderId: intent.providerOrderId!,
      });
      if (stillActive !== null) continue;
      if (inactive !== null && isCanceledStatus(inactive.status)) {
        const outcome = lifecycleSnapshot(inactive);
        await deps.intents.markProviderOutcome({ intentId: intent.intentId, state: "completed", evidence: {
          kind: "lighter_cancel_one_outcome", order: outcome,
        } });
        return {
          status: "canceled",
          intentId: intent.intentId,
          signerTxHash: signed.txHash,
          submittedTxHash: response.tx_hash,
          providerOrderId: intent.providerOrderId!,
          providerStatus: outcome.status,
          executedAmount: outcome.filledBaseAmount,
          remainingAmount: outcome.remainingBaseAmount,
          averageFillPrice: averageFillPrice(outcome.filledBaseAmount, outcome.filledQuoteAmount),
        };
      }
    }
    await deps.intents.markProviderOutcome({ intentId: intent.intentId, state: "sequencer_pending", evidence: {
      kind: "lighter_cancel_one_pending", providerOrderId: intent.providerOrderId,
    } });
    return {
      status: "sequencer_pending",
      intentId: intent.intentId,
      signerTxHash: signed.txHash,
      submittedTxHash: response.tx_hash,
      reason: "Provider accepted the cancel transaction; exact inactive-order evidence is pending.",
    };
  } catch (error) {
    if (signerTxHash === null) await deps.intents.markAmbiguous({ intentId: intent.intentId, reason: "signing_failed_after_nonce_reservation" });
    throw error;
  }
}

async function markAndReturnAmbiguous(
  deps: LighterOrderLifecycleExecutionDeps,
  intent: LighterOrderLifecycleIntentRow,
  reason: string,
  signerTxHash: string,
): Promise<ExecuteApprovedLighterCancelOneResult> {
  await deps.intents.markAmbiguous({ intentId: intent.intentId, reason });
  return { status: "ambiguous", intentId: intent.intentId, signerTxHash, submittedTxHash: null, reason };
}

function assertCancelableIntent(intent: LighterOrderLifecycleIntentRow, nowMs: number): void {
  if (
    intent.actionType !== "cancel_one" || intent.approvalStatus !== "approved"
    || intent.executionState !== "approved" || intent.marketIndex === null || intent.providerOrderId === null
    || Date.parse(intent.expiresAt) <= nowMs
  ) throw blocked("The Lighter cancel intent is not approved, fresh, and exact.");
}

function findExactOrder(
  orders: readonly LighterAccountOrder[],
  target: { readonly accountIndex: number; readonly marketIndex: number; readonly providerOrderId: string },
): LighterAccountOrder | null {
  const matches = orders.filter((order) =>
    order.order_id === target.providerOrderId
    && order.owner_account_index === target.accountIndex
    && order.market_index === target.marketIndex);
  if (matches.length > 1) throw blocked("Lighter returned duplicate exact order identities.");
  return matches[0] ?? null;
}

export function lifecycleSnapshot(order: LighterAccountOrder): LighterLifecycleOrderSnapshot {
  assertProviderOrderId(order.order_id);
  return {
    orderId: order.order_id,
    clientOrderId: order.client_order_id,
    marketIndex: order.market_index,
    ownerAccountIndex: order.owner_account_index,
    initialBaseAmount: order.initial_base_amount,
    remainingBaseAmount: order.remaining_base_amount ?? "0",
    filledBaseAmount: order.filled_base_amount ?? "0",
    filledQuoteAmount: order.filled_quote_amount ?? "0",
    price: order.price,
    status: order.status ?? "",
    side: order.side ?? (order.is_ask === true ? "sell" : order.is_ask === false ? "buy" : ""),
    type: order.type ?? "",
    timeInForce: order.time_in_force ?? "",
    reduceOnly: order.reduce_only ?? false,
  };
}

export function lifecycleMatchHash(value: object): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function sameSnapshot(stored: Record<string, unknown>, live: LighterLifecycleOrderSnapshot): boolean {
  return lifecycleMatchHash(stored) === lifecycleMatchHash(live);
}

function assertProviderOrderId(value: string): void {
  if (!/^[1-9]\d*$/.test(value) || BigInt(value) > (1n << 60n) - 1n) {
    throw blocked("The provider order identity is invalid or outside the official range.");
  }
}

function canonicalKey(value: string): string { return value.toLowerCase().replace(/^0x/, ""); }
function normalizeStatus(value: string | undefined): string { return value?.trim().toLowerCase() ?? ""; }
function isCanceledStatus(value: string | undefined): boolean {
  const status = normalizeStatus(value);
  return status.startsWith("canceled") || status.includes("cancelled");
}

function averageFillPrice(base: string, quote: string): string | null {
  const baseParts = decimalParts(base);
  const quoteParts = decimalParts(quote);
  if (baseParts === null || quoteParts === null || baseParts.integer === 0n) return null;
  const scale = 18;
  const numerator = quoteParts.integer * (10n ** BigInt(baseParts.scale + scale));
  const denominator = baseParts.integer * (10n ** BigInt(quoteParts.scale));
  const scaled = numerator / denominator;
  const padded = scaled.toString().padStart(scale + 1, "0");
  const whole = padded.slice(0, -scale);
  const fraction = padded.slice(-scale).replace(/0+$/, "");
  return fraction.length === 0 ? whole : `${whole}.${fraction}`;
}

function decimalParts(value: string): { readonly integer: bigint; readonly scale: number } | null {
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) return null;
  const [whole, fraction = ""] = value.split(".");
  return { integer: BigInt(`${whole}${fraction}`), scale: fraction.length };
}

function blocked(message: string): VexError {
  return new VexError(
    ErrorCodes.LIGHTER_INVALID_REQUEST,
    `${message} No lifecycle transaction was submitted.`,
    "Refresh the exact Lighter order and prepare a new approval-gated action.",
  );
}
