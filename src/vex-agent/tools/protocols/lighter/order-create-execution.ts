import { persistLighterSigningEvidence, type LighterEvidenceWritePorts } from "./execution-boundary.js";
import { assertIntentAuthority, LighterIntentRefusal } from "./intent-expiry.js";
import { lighterSignerRunExited } from "@tools/lighter/signer-binary-adapter.js";
import { revalidateLighterOrderFees, readLighterOrderAccountFeeTicks, type LighterOrderFeeClient } from "./order-fees.js";
import { lighterIntegratorFeesEqual } from "@tools/lighter/fee-policy.js";
import type { LighterClient } from "@tools/lighter/client.js";
import type { LighterAccountOrder, LighterTrade } from "@tools/lighter/types.js";
import {
  buildLighterAccountAuthSigningInput,
  buildLighterCreateOrderSigningInput,
  createLighterAccountAuthWithAdapter,
  signLighterCreateOrderWithAdapter,
  type LighterSignerAdapter,
} from "@tools/lighter/signer-adapter.js";
import {
  buildLighterUnsignedCreateOrderRequest,
  type LighterUnsignedCreateOrderRequest,
} from "@tools/lighter/signer-order.js";
import {
  loadLighterTradingSecretMaterial,
  type LighterTradingSecretReader,
} from "@tools/lighter/trading-secret.js";
import { ErrorCodes, VexError } from "../../../../errors.js";
import logger from "@utils/logger.js";
import * as lighterOrderExecutionIntentsRepo from "@vex-agent/db/repos/lighter-order-execution-intents.js";
import * as lighterOrderPreviewsRepo from "@vex-agent/db/repos/lighter-order-previews.js";
import * as lighterNonceStateRepo from "@vex-agent/db/repos/lighter-nonce-state.js";
import {
  reserveLighterOrderNonceForSigning,
  type LighterOrderNonceReservation,
} from "./nonce-reservation.js";
import type { LighterOrderReadyForSignerPlan } from "./execution-plan.js";
import {
  defaultLighterFillObservationDeps,
  matchingLighterTrades,
  observeLighterFills,
  observeLighterFillsFromAccountTrades,
  type LighterFillObservationDeps,
} from "./fill-observation.js";
import {
  buildLighterOrderEvidenceScope,
  findMatchingLighterOrder,
  findMatchingLighterTrade,
  LighterOrderEvidenceConflictError,
  lighterOrderEvidenceJson,
  lighterOrderIdFromTrade,
  lighterTradeEvidenceJson,
  stateFromActiveLighterOrder,
  stateFromInactiveLighterOrder,
  type LighterOrderEvidenceScope,
} from "./order-evidence.js";
import {
  revalidateApprovedLighterOrder,
  type LighterOrderPreSubmitRevalidationEvidence,
} from "./pre-submit-revalidation.js";
import {
  markLighterOrderCapitalCommitmentSettled,
  readmitLighterOrderCapitalCommitmentAtExecute,
  retireLighterOrderCapitalCommitment,
} from "./capital-share-policy.js";
import { assertLighterPhaseOneOrderPolicy } from "@tools/lighter/order-policy.js";
import { assertLighterTradingApiKeyIndexAllowed } from "@tools/lighter/trading-credentials.js";

/**
 * The provider states that PROVE this create order can consume no more capital.
 *
 * `open` and `partially_filled` are deliberately absent: a resting order still
 * holds the margin its commitment reserved, and retiring on them was the gap
 * that let a second order be admitted against capital counted in neither the
 * provider's numbers nor the ledger. `sequencer_pending` has no evidence at all
 * yet.
 */
const LIGHTER_CREATE_SETTLED_PROVIDER_STATES: ReadonlySet<string> = new Set([
  "filled",
  "canceled",
  "rejected",
]);

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
const MIN_WIRE_ORDER_EXPIRY_REMAINING_MS = 5 * 60 * 1_000;

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
      readonly providerEvidence?: Record<string, unknown>;
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
  readonly client: LighterOrderFeeClient & Pick<
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
  readonly nonceState: LighterEvidenceWritePorts<Pick<typeof lighterNonceStateRepo, "recordExecutionObserved">>
    & Pick<typeof lighterNonceStateRepo, "releaseUnsubmittedReservation">;
  readonly previews: Pick<typeof lighterOrderPreviewsRepo, "findFreshById">;
  /**
   * The fill observation boundary. Optional so a caller that assembles its own
   * deps neither reaches the provider nor writes the ledger by accident;
   * production arrives through {@link defaultLighterCreateOrderExecutionDeps}.
   */
  readonly fills?: LighterFillObservationDeps;
  readonly now: () => number;
  readonly wait: (delayMs: number) => Promise<void>;
  readonly intents: LighterEvidenceWritePorts<Pick<typeof lighterOrderExecutionIntentsRepo,
    "markSigned" | "markPreSubmitRevalidated" | "markSubmitted" | "markSequencerPending" | "markProviderOutcome" | "markAmbiguous">>
    & Pick<typeof lighterOrderExecutionIntentsRepo, "markSendAttemptStarted" | "markExpiredUnsubmitted" | "markUnsubmittedRefused" | "findByIntentIdAnySession">
    & { readonly markApiAccepted: (...args: Parameters<typeof lighterOrderExecutionIntentsRepo.markApiAccepted>) => Promise<{ readonly volumeQuotaRemaining: string | null } | null> };
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
  readonly unsignedOrder?: LighterUnsignedCreateOrderRequest;
  readonly deps: ExecuteApprovedLighterCreateOrderDeps;
  readonly abortSignal?: AbortSignal;
}): Promise<ExecuteApprovedLighterCreateOrderResult> {
  const { plan, deps } = input;
  const assertAuthority = (phase: Parameters<typeof assertIntentAuthority>[2]): void =>
    assertIntentAuthority(plan.expiresAt, deps.now(), phase, input.abortSignal);
  assertAuthority("before_reservation");
  const unsignedOrder = buildLighterUnsignedCreateOrderRequest(plan);
  if (input.unsignedOrder !== undefined) {
    assertUnsignedOrderMatchesApprovedPlan(input.unsignedOrder, unsignedOrder);
  }
  assertLighterTradingApiKeyIndexAllowed(plan.environment, plan.apiKeyIndex);
  assertLighterPhaseOneOrderPolicy(plan.orderType, plan.timeInForce);
  const revalidationEvidence = await revalidateLiveOrderState(plan, deps);
  const evidenceScope = buildLighterOrderEvidenceScope({
    approved: plan,
    baseDecimals: revalidationEvidence.baseDecimals,
    priceDecimals: revalidationEvidence.priceDecimals,
    signedOrderExpiryMs: unsignedOrder.orderExpiryMs,
  });
  // Prove the exact registered provider key and current nonce before asking
  // the encrypted vault for private key material. Besides minimizing secret
  // exposure time, this keeps every provider-read refusal truthful: no private
  // trading key has been loaded when public identity evidence is unavailable.
  const providerCredential = await readLiveProviderCredential(plan, deps);
  const secret = await loadLighterTradingSecretMaterial(
    plan.credentialReference,
    deps.secretReader,
  );
  assertAuthority("before_reservation");
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
    assertProviderOutcomeRepairReady(plan, evidenceScope, unsignedOrder, auth.authToken, deps),
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
  assertWireOrderExpiryBeforeSigning(unsignedOrder, deps.now());
  assertAuthority("before_reservation");
  const nonce = await deps.reserveNonce(plan);
  let signerTxHash: string | null = null;
  let signingStarted = false;
  let signerExited = false;
  let sendAdmissionStarted = false;

  try {
    assertAuthority("after_reservation");
    assertAuthority("before_signing");
    assertWireOrderExpiryBeforeSigning(unsignedOrder, deps.now());
    signingStarted = true;
    const signingInput = buildLighterCreateOrderSigningInput({
      order: unsignedOrder,
      secret,
      nonce: nonce.nonceValue,
    });
    const signed = await signLighterCreateOrderWithAdapter(signingInput, deps.signer);
    signerExited = lighterSignerRunExited({ kind: "resolved" });
    signerTxHash = signed.txHash;

    const signedIntent = await persistLighterSigningEvidence(() => deps.intents.markSigned({
      intentId: plan.intentId,
      sessionId: plan.sessionId,
      environment: plan.environment,
      nonceReservationId: nonce.reservationId,
      nonceValue: nonce.nonceValue,
      clientOrderIndex: unsignedOrder.clientOrderIndex,
      signerTxHash: signed.txHash,
    }));
    if (signedIntent === null) {
      await markAmbiguous(deps, plan, SIGNED_PERSIST_AMBIGUOUS_REASON);
      throw blockedBeforeSubmit(
        `Lighter order execution intent ${plan.intentId} could not persist signed state.`,
      );
    }

    // Signing and durable state writes can take time after the last public
    // revalidation. Recheck the provider's five-minute minimum immediately
    // before the durable pre-send transition; an expired signed transaction is
    // left in `signed` for evidence-based nonce repair and is never submitted.
    assertAuthority("after_signing");
    assertWireOrderExpiryBeforeSubmission(unsignedOrder, deps.now());

    const submitted = await deps.intents.markSubmitted({
      intentId: plan.intentId,
      sessionId: plan.sessionId,
      environment: plan.environment,
      signerTxHash: signed.txHash,
    });
    if (submitted === null) {
      assertAuthority("before_submission");
      throw new LighterIntentRefusal("submission_admission_refused");
    }

    assertAuthority("before_submission");
    sendAdmissionStarted = true;
    const admitted = await deps.intents.markSendAttemptStarted({
      intentId: plan.intentId, sessionId: plan.sessionId, signerTxHash: signed.txHash,
    });
    if (!admitted) {
      sendAdmissionStarted = false;
      throw new LighterIntentRefusal("submission_admission_refused");
    }
    assertAuthority("before_submission");
    assertWireOrderExpiryBeforeSubmission(unsignedOrder, deps.now());

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

    let accepted: Awaited<ReturnType<ExecuteApprovedLighterCreateOrderDeps["intents"]["markApiAccepted"]>>;
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
      evidenceScope,
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
    signerExited ||= lighterSignerRunExited({ kind: "rejected", error });
    if (!sendAdmissionStarted && (!signingStarted
      || (signerExited && (error instanceof LighterIntentRefusal || signerTxHash === null)))) {
      const refused = signerTxHash === null
        ? await deps.intents.markUnsubmittedRefused({
          intentId: plan.intentId, sessionId: plan.sessionId, reservationId: nonce.reservationId, reason: error instanceof LighterIntentRefusal ? error.reason : "pre_sign_refused",
        })
        : await deps.intents.markExpiredUnsubmitted({
          intentId: plan.intentId, sessionId: plan.sessionId, reservationId: nonce.reservationId,
          signerTxHash, reason: error instanceof LighterIntentRefusal ? error.reason : "pre_sign_refused",
        });
      if (refused) {
        await deps.nonceState.releaseUnsubmittedReservation({
          environment: plan.environment, accountIndex: plan.accountIndex, apiKeyIndex: plan.apiKeyIndex,
          reservationId: nonce.reservationId, nonceValue: nonce.nonceValue,
        });
        // Both transitions above are proof this order was NEVER sent: one is
        // taken before any signature exists, the other only while
        // `send_attempt_started_at IS NULL`. Nothing on the account can be
        // covering the commitment, so it is retired here rather than waiting
        // out the observation lag at the next admission.
        await retireLighterOrderCapitalCommitment({
          intentId: plan.intentId,
          reason: signerTxHash === null ? "refused_unsubmitted" : "expired_unsubmitted",
        });
      }
    } else if (signerTxHash === null || error instanceof LighterIntentRefusal) {
      await markAmbiguous(deps, plan, error instanceof LighterIntentRefusal ? error.reason : SIGNING_AMBIGUOUS_REASON);
    }
    throw error;
  }
}

function wireOrderExpiryHasRequiredRemainingTime(
  order: LighterUnsignedCreateOrderRequest,
  nowMs: number,
): boolean {
  return order.orderExpiryMs === 0
    || order.orderExpiryMs >= nowMs + MIN_WIRE_ORDER_EXPIRY_REMAINING_MS;
}

function assertWireOrderExpiryBeforeSigning(
  order: LighterUnsignedCreateOrderRequest,
  nowMs: number,
): void {
  if (wireOrderExpiryHasRequiredRemainingTime(order, nowMs)) return;
  throw blockedBeforeSubmit(
    "The approved Lighter wire order expiry fell below the provider's five-minute minimum while live checks were running. No nonce was reserved and no order was signed or submitted.",
  );
}

function assertWireOrderExpiryBeforeSubmission(
  order: LighterUnsignedCreateOrderRequest,
  nowMs: number,
): void {
  if (wireOrderExpiryHasRequiredRemainingTime(order, nowMs)) return;
  throw new VexError(
    ErrorCodes.LIGHTER_INVALID_REQUEST,
    "The signed Lighter order fell below the provider's five-minute expiry minimum before submission, so Vex did not send it.",
    "Run lighter.order.status to release the provably unsubmitted nonce reservation, then restart from a fresh preview and approval.",
  );
}

const LIGHTER_UNSIGNED_ORDER_FIELDS = [
  "kind",
  "environment",
  "accountIndex",
  "apiKeyIndex",
  "marketIndex",
  "clientOrderIndex",
  "baseAmountInteger",
  "priceInteger",
  "isAsk",
  "orderTypeCode",
  "timeInForceCode",
  "reduceOnly",
  "triggerPriceInteger",
  "orderExpiryMs",
  "matchHash",
] as const satisfies readonly (keyof LighterUnsignedCreateOrderRequest)[];

function assertUnsignedOrderMatchesApprovedPlan(
  supplied: LighterUnsignedCreateOrderRequest,
  canonical: LighterUnsignedCreateOrderRequest,
): void {
  const mismatch = LIGHTER_UNSIGNED_ORDER_FIELDS.find(
    (field) => supplied[field] !== canonical[field],
  );
  if (mismatch !== undefined || !lighterIntegratorFeesEqual(supplied.integratorFees, canonical.integratorFees)) {
    throw blockedBeforeSubmit(
      `Caller-supplied Lighter unsigned order field ${mismatch ?? "integratorFees"} does not match the canonical order derived from the approved plan. No provider state was read, no trading key was loaded, and no nonce was reserved.`,
    );
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
    fills: defaultLighterFillObservationDeps(),
    now: Date.now,
    wait: (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
    ...overrides,
  };
}

async function revalidateLiveOrderState(
  plan: LighterOrderReadyForSignerPlan,
  deps: ExecuteApprovedLighterCreateOrderDeps,
): Promise<LighterOrderPreSubmitRevalidationEvidence> {
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
        // `false`: the position row carrying this market's
        // `initial_margin_fraction` may exist with no OPEN POSITION, and
        // `activeOnly: true` hides exactly that row. Revalidating the capital
        // share against a hidden row would price the order at the market
        // default instead of the account's own leverage.
        activeOnly: false,
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

  await revalidateLighterOrderFees({ client: deps.client, environment: plan.environment, accountIndex: plan.accountIndex, market: marketDetail, account, reduceOnly: plan.reduceOnly, side: plan.side, integratorFees: plan.integratorFees });
  const accountTakerFeeTicks = marketDetail.market_type === "spot" && plan.side === "buy"
    ? await readLighterOrderAccountFeeTicks(deps.client, plan.environment, plan.accountIndex) : undefined;
  // RE-ADMISSION at the commit point, against the account and the limits row as
  // they are NOW. `excludeIntentId` keeps this intent's own commitment from
  // counting against itself; the user may have withdrawn collateral or lowered
  // the share since approval, and either must refuse before anything is signed.
  await readmitLighterOrderCapitalCommitmentAtExecute({
    intentId: plan.intentId,
    preview: approvedPreview,
    client: deps.client,
  });
  const evidence = revalidateApprovedLighterOrder({
    plan,
    approvedPreview,
    context: { market: marketDetail, orderBook, account, ...(accountTakerFeeTicks === undefined ? {} : { accountTakerFeeTicks }) },
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
  return evidence;
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
  evidenceScope: LighterOrderEvidenceScope,
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
    evidenceScope,
    unsignedOrder.clientOrderIndex,
  );
  const existingTrade = findMatchingLighterTrade(
    trades.trades,
    evidenceScope,
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
  readonly evidenceScope: LighterOrderEvidenceScope;
  readonly unsignedOrder: LighterUnsignedCreateOrderRequest;
  readonly deps: ExecuteApprovedLighterCreateOrderDeps;
  readonly abortSignal?: AbortSignal;
  readonly signerTxHash: string;
  readonly submittedTxHash: string;
  readonly submitCode: number;
  readonly predictedExecutionTimeMs: number;
  readonly volumeQuotaRemaining: string | null;
  readonly accountAuthToken: string;
}): Promise<ExecuteApprovedLighterCreateOrderResult> {
  const {
    plan,
    evidenceScope,
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
      const active = findMatchingLighterOrder(
        activeOrders.orders,
        evidenceScope,
        unsignedOrder.clientOrderIndex,
      );
      if (active !== null) {
        return persistProviderOutcomeSafely({
          plan,
          unsignedOrder,
          deps,
          accountAuthToken,
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
    const inactive = findMatchingLighterOrder(
      inactiveOrders.orders,
      evidenceScope,
      unsignedOrder.clientOrderIndex,
    );
    if (inactive !== null) {
      return persistProviderOutcomeSafely({
        plan,
        unsignedOrder,
        deps,
        accountAuthToken,
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
    // THE OBSERVATION BOUNDARY. Every trade this read returned for the order
    // becomes a ledger row, whether or not the outcome below advances the
    // intent - a partially-filled order can arrive with several trades and the
    // outcome carries only one of them as evidence. `observeLighterFills`
    // never throws, so a ledger failure can never reach the `catch` around
    // this block and turn a confirmed provider outcome into an ambiguous one;
    // the next observation of the same trade records it, idempotently.
    if (deps.fills !== undefined) {
      await observeLighterFills({
        intent: {
          intentId: plan.intentId,
          environment: plan.environment,
          accountIndex: plan.accountIndex,
          marketIndex: plan.marketIndex,
          side: plan.side,
          clientOrderIndex: unsignedOrder.clientOrderIndex,
        },
        trades: matchingLighterTrades(
          trades.trades,
          evidenceScope,
          unsignedOrder.clientOrderIndex,
          submittedTxHash,
        ),
        authorizedFees: plan.integratorFees ?? null,
        deps: deps.fills,
      });
    }

    const trade = findMatchingLighterTrade(
      trades.trades,
      evidenceScope,
      unsignedOrder.clientOrderIndex,
      submittedTxHash,
    );
    if (trade !== null) {
      return persistProviderOutcomeSafely({
        plan,
        unsignedOrder,
        deps,
        accountAuthToken,
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
  } catch (error) {
    const reason = error instanceof LighterOrderEvidenceConflictError
      ? error.message
      : PROVIDER_OUTCOME_READ_AMBIGUOUS_REASON;
    await markAmbiguous(deps, plan, reason);
    return ambiguous(plan, reason, signerTxHash);
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
  readonly abortSignal?: AbortSignal;
  /** The short-lived READ-ONLY account token this settlement already holds. */
  readonly accountAuthToken: string;
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
  if (persisted !== null) await observeFillsFromOrderEvidence(input, input.state, input.source);
  if (persisted !== null && LIGHTER_CREATE_SETTLED_PROVIDER_STATES.has(input.state)) {
    // STAMP the settlement, do not retire. The order is terminal, so from here
    // the provider's own numbers carry it: a fill becomes position margin
    // inside `cross_initial_margin_requirement`, and a cancel or rejection
    // committed nothing at all. But those numbers only reach a session that
    // READS THE ACCOUNT AFTER this moment; a session holding a snapshot taken
    // before the fill would see the capital nowhere. The commitment therefore
    // keeps counting until the observation lag has run from this stamp.
    //
    // `open`, `partially_filled` and `sequencer_pending` stamp nothing: those
    // orders can still consume the capital they reserved, so the commitment is
    // simply still true. `ambiguous` likewise.
    await markLighterOrderCapitalCommitmentSettled(input.plan.intentId);
  }
  if (persisted === null) {
    // A stream update can confirm the order while the REST lookup is in flight.
    const current = await input.deps.intents.findByIntentIdAnySession(input.plan.intentId);
    if (current !== null
      && current.sessionId === input.plan.sessionId
      && current.environment === input.plan.environment
      && current.approvalStatus === "approved"
      && current.clientOrderIndex === input.unsignedOrder.clientOrderIndex
      && current.providerOrderId === input.providerOrderId
      && current.executionState === "filled"
      && current.providerOutcomeSource === "inactive_order") {
      // The stream committed the terminal outcome while this read was in
      // flight, so the ledger write that belongs to it was never made here.
      await observeFillsFromOrderEvidence(input, "filled", "inactive_order");
      return {
        status: "provider_confirmed",
        intentId: input.plan.intentId,
        environment: input.plan.environment,
        executionState: "filled",
        signerTxHash: input.signerTxHash,
        submittedTxHash: input.submittedTxHash,
        evidenceSource: "inactive_order",
        clientOrderIndex: input.unsignedOrder.clientOrderIndex,
        providerOrderId: current.providerOrderId,
        providerOrderStatus: current.providerOrderStatus,
        providerEvidence: current.providerOutcomeJson ?? undefined,
        message: "Lighter provider evidence confirmed order state filled.",
      };
    }
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
    providerEvidence: input.providerOutcomeJson,
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

/**
 * THE TERMINAL COMMIT POINT FOR AN ORDER-SHAPED CONFIRMATION.
 *
 * An order row tells Vex the order filled; it never names the trades that
 * filled it, so nothing has reached the fill ledger by the time this outcome
 * commits. Measured live on 2026-09-08: an IOC buy confirmed `filled` from
 * `inactive_order` evidence left `lighter_fills` empty, and AgentScan would
 * never have heard of the fill.
 *
 * ONE bounded follow-up read, after the outcome is durable, and only for a
 * state that means money moved. The `account_trade` source is excluded because
 * the trade branch above already observed the very page it classified from,
 * and reading again would spend a second privileged request for nothing.
 *
 * The read never throws and never changes the committed outcome; its counts
 * are logged so an operator can see that it ran and what it found.
 */
async function observeFillsFromOrderEvidence(
  input: Parameters<typeof persistProviderOutcome>[0],
  state: Parameters<typeof persistProviderOutcome>[0]["state"],
  source: Parameters<typeof persistProviderOutcome>[0]["source"],
): Promise<void> {
  if (state !== "filled" && state !== "partially_filled") return;
  if (source !== "active_order" && source !== "inactive_order") return;
  const fills = input.deps.fills;
  if (fills === undefined) return;
  const report = await observeLighterFillsFromAccountTrades({
    intent: {
      intentId: input.plan.intentId,
      environment: input.plan.environment,
      accountIndex: input.plan.accountIndex,
      marketIndex: input.plan.marketIndex,
      side: input.plan.side,
      clientOrderIndex: input.unsignedOrder.clientOrderIndex,
    },
    authorizedFees: input.plan.integratorFees ?? null,
    deps: fills,
    read: {
      // Bound through a closure: the production client is a class instance
      // whose method needs its receiver.
      getAccountTrades: (environment, params, auth) =>
        input.deps.client.getAccountTrades(environment, params, auth),
      auth: { token: input.accountAuthToken, accountIndex: input.plan.accountIndex },
      submittedTxHash: input.submittedTxHash,
    },
  });
  logger.info("lighter.fill_observation.follow_up", {
    site: "order_create_execution",
    intentId: input.plan.intentId,
    evidenceSource: source,
    state,
    observed: report.observed,
    recorded: report.recorded,
    duplicates: report.duplicates,
    failed: report.failed,
  });
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
// numeric HTTP status are appended - never the error message, which could echo
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
