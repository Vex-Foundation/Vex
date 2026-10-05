import { persistLighterSigningEvidence, type LighterEvidenceWritePorts } from "./execution-boundary.js";
import { assertIntentAuthority, LighterIntentRefusal } from "./intent-expiry.js";
import { lighterSignerRunExited } from "@tools/lighter/signer-binary-adapter.js";
import { readLighterSignedTxExpiredAtMs } from "@tools/lighter/signed-tx-expiry.js";
import {
  revalidateLighterOrderFees,
  readLighterOrderAccountFeeTicks,
  type LighterOrderFeeClient,
  type LighterOrderFeeReadSnapshot,
} from "./order-fees.js";
import { getLighterFeePolicy, lighterIntegratorFeesEqual } from "@tools/lighter/fee-policy.js";
import { resolveLighterReadOnlyAccountAuth } from "./read-account-auth.js";
import { lighterOrderMarginFitNeedsLiveReads, readLighterMarginFitDepthBook } from "./margin-fit-guard.js";
import {
  judgeLighterSigningOwnership,
  LIGHTER_SIGNING_OWNERSHIP_RECHECK,
  type LighterSigningOwnershipWallet,
} from "./signing-ownership.js";
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
import type { LighterOrderExecutionIntentState } from "@vex-agent/db/repos/lighter-order-execution-intents.js";
import * as lighterOrderPreviewsRepo from "@vex-agent/db/repos/lighter-order-previews.js";
import type { LighterOrderPreviewRow } from "@vex-agent/db/repos/lighter-order-previews.js";
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
  reportedLighterFilledBaseSize,
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
  type LighterCapitalShareExecuteSnapshot,
} from "./capital-share-policy.js";
import { assertLighterPhaseOneOrderPolicy } from "@tools/lighter/order-policy.js";
import { assertLighterTradingApiKeyIndexAllowed } from "@tools/lighter/trading-credentials.js";
import {
  observeLighterNonceWithRecovery,
  runLighterNonceRecovery,
  type LighterNonceRecoveryRunner,
} from "./nonce-commit-recovery.js";
import { isLighterUnreachable, withLighterBeforeSendFailures, type LighterSendPhase } from "./before-send.js";
import {
  LIGHTER_READ_AUTH_CACHE,
  lighterReadAuthCache,
  normalizeLighterPublicKey,
  type LighterReadAuthCache,
  type LighterReadAuthCacheScope,
} from "./read-auth-cache.js";
import {
  LIGHTER_STREAM_REVALIDATION,
  lighterOrderBookFromStream,
  takeFreshLighterStreamOrderBook,
  type LighterStreamOrderBookReader,
} from "./stream-revalidation.js";

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

/**
 * The same three states, read back off a row the stream already committed.
 *
 * Reuses the set above deliberately: "this order can consume no more capital"
 * and "this outcome is final enough to report" are the same question, and
 * answering them from two lists is how `canceled` came to be reported as an
 * unknown outcome while `filled` was not.
 */
function isTerminalProviderExecutionState(
  state: LighterOrderExecutionIntentState,
): state is "filled" | "canceled" | "rejected" {
  return LIGHTER_CREATE_SETTLED_PROVIDER_STATES.has(state);
}

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

/**
 * SWITCH `LIGHTER_ORDER_PARALLEL_PREFLIGHT` (default OFF).
 *
 * ON reads the provider credential (registered key and `/nextNonce`) while the
 * post-approval revalidation runs, instead of after it. The trading key is
 * still loaded only after BOTH have succeeded, and when both fail the refusal
 * is the one the sequential path gives (revalidation first, then the
 * credential), so every refusal and every durable write is unchanged.
 *
 * ON for the owner's live canary; `false` is the rollback. The risk:
 * `/nextNonce` is read earlier than the sequential path, by the length of the
 * revalidation. A concurrent Vex action on the same API key that
 * consumes a nonce inside that wider window leaves this order signed with a
 * stale nonce, which Lighter refuses (recorded ambiguous and reconciled, never
 * resent). Only a live canary can show that window is immaterial in practice.
 */
export const LIGHTER_ORDER_PARALLEL_PREFLIGHT = true;

/**
 * SWITCH `LIGHTER_REVALIDATION_SINGLE_SNAPSHOT`.
 *
 * ON gathers the post-approval revalidation's reads into one snapshot instead
 * of letting the fee, fee-tier and capital-share checks each read again:
 *
 * - the fee check's system config and collector account join the first batch
 *   (market details, order book, account), because they are public reads;
 * - the read-only account auth is resolved ONCE, at the point the fee check
 *   resolves it today (after the first batch proved the market), and its
 *   account-limits read is shared by the fee check, the spot fee-tier check,
 *   the margin-fit check and the capital share;
 * - the fee check's trader account, the capital share's account and market
 *   details, and the margin-fit check's market details are the first batch's
 *   `fresh` reads of the same query;
 * - the margin-fit book depth read starts beside the auth, only for an order
 *   that check would read for.
 *
 * Every check still runs in today's order over those values, and each shared
 * read is awaited only where today's code issues it, so a read that fails
 * refuses exactly where, and with exactly what, it refuses today. No secret is
 * touched earlier than today: the auth is never resolved before the first
 * batch succeeded, and the trading key still loads only after revalidation
 * and the credential read both succeed. OFF (`false`) is today's path.
 */
export const LIGHTER_REVALIDATION_SINGLE_SNAPSHOT = true;

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
  /**
   * One recovery pass for a nonce an earlier action still holds, run at the
   * commit point before refusing. Absent in a caller's own deps, which then
   * refuse on the first observation as before.
   */
  readonly recoverNonce?: LighterNonceRecoveryRunner;
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
  /** Overrides {@link LIGHTER_ORDER_PARALLEL_PREFLIGHT}; absent uses the constant. */
  readonly parallelPreflight?: boolean;
  /**
   * The read-only token cache. Absent uses the process cache when
   * `LIGHTER_READ_AUTH_CACHE` is ON and none when it is OFF; null disables it.
   */
  readonly readAuthCache?: LighterReadAuthCache | null;
  /** Overrides `LIGHTER_STREAM_REVALIDATION`; absent uses the constant. */
  readonly streamRevalidation?: boolean;
  /** The main-process public book reader; absent or null always reads REST. */
  readonly streamOrderBook?: LighterStreamOrderBookReader | null;
  /** Overrides {@link LIGHTER_REVALIDATION_SINGLE_SNAPSHOT}; absent uses the constant. */
  readonly revalidationSingleSnapshot?: boolean;
  /** Overrides `LIGHTER_SIGNING_OWNERSHIP_RECHECK` (`signing-ownership.ts`); absent uses the constant. */
  readonly signingOwnershipRecheck?: boolean;
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
  /**
   * The approve call's own session wallet, resolved as the preview resolves
   * it (`resolveLighterSigningOwnershipWallet`). Read only while
   * `LIGHTER_SIGNING_OWNERSHIP_RECHECK` is ON, which refuses without it.
   */
  readonly sessionWallet?: LighterSigningOwnershipWallet;
}): Promise<ExecuteApprovedLighterCreateOrderResult> {
  return withLighterBeforeSendFailures((sendPhase) => runApprovedLighterCreateOrder(input, sendPhase));
}

async function runApprovedLighterCreateOrder(input: {
  readonly plan: LighterOrderReadyForSignerPlan;
  readonly unsignedOrder?: LighterUnsignedCreateOrderRequest;
  readonly deps: ExecuteApprovedLighterCreateOrderDeps;
  readonly abortSignal?: AbortSignal;
  readonly sessionWallet?: LighterSigningOwnershipWallet;
}, sendPhase: LighterSendPhase): Promise<ExecuteApprovedLighterCreateOrderResult> {
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
  const readAuthCache = resolveReadAuthCache(deps);
  // Started now, judged later at exactly the point the sequential path reads:
  // a cached-token answer is used only after the fresh key proof below, and
  // any doubt about it falls back to today's read with the fresh token.
  const cachedRepairReads = startCachedRepairReads(plan, deps, readAuthCache);
  const timing = new LighterOrderTiming();
  const { evidenceScope, providerCredential } = (deps.parallelPreflight ?? LIGHTER_ORDER_PARALLEL_PREFLIGHT)
    ? await runParallelPreflightReads(plan, unsignedOrder, deps, timing, input.sessionWallet)
    : await runSequentialPreflightReads(plan, unsignedOrder, deps, timing, input.sessionWallet);
  const secret = await timing.measure("keyLoadMs", () => loadLighterTradingSecretMaterial(
    plan.credentialReference,
    deps.secretReader,
  ));
  assertAuthority("before_reservation");
  const authDeadlineUnixSeconds = Math.floor(deps.now() / 1_000) + ACCOUNT_AUTH_TTL_SECONDS;
  const auth = await timing.measure("authMs", () => createLighterAccountAuthWithAdapter(
    buildLighterAccountAuthSigningInput({
      order: unsignedOrder,
      secret,
      deadlineUnixSeconds: authDeadlineUnixSeconds,
    }),
    deps.signer,
  ));
  assertProviderPublicKeyMatches(providerCredential.publicKey, auth.publicKey);
  timing.start("nonceReserveMs");
  const [, observedNonce] = await Promise.all([
    readAuthCache === null
      ? assertProviderOutcomeRepairReady(plan, evidenceScope, unsignedOrder, auth.authToken, deps)
      : assertProviderOutcomeRepairReadyWithCache({
        plan,
        evidenceScope,
        unsignedOrder,
        auth,
        authDeadlineUnixSeconds,
        deps,
        cache: readAuthCache,
        cached: cachedRepairReads,
      }),
    observeLighterNonceWithRecovery({
      scope: { environment: plan.environment, accountIndex: plan.accountIndex },
      observe: () => deps.nonceState.recordExecutionObserved({
        environment: plan.environment,
        accountIndex: plan.accountIndex,
        apiKeyIndex: plan.apiKeyIndex,
        nonce: providerCredential.nextNonce,
        publicKey: providerCredential.publicKey,
        transactionTime: providerCredential.transactionTime,
      }),
      recover: deps.recoverNonce,
    }),
  ]);
  if (observedNonce === null) {
    throw new VexError(
      ErrorCodes.LIGHTER_INVALID_REQUEST,
      `A previous Lighter action on ${plan.environment.toUpperCase()} account ${plan.accountIndex} still holds this account's nonce and its outcome is not yet proven. This order was not signed or submitted; Vex clears the blocking reservation automatically. Try again shortly.`,
      "Vex releases the earlier action's reservation only after it has enough evidence that doing so is safe.",
    );
  }
  assertWireOrderExpiryBeforeSigning(unsignedOrder, deps.now());
  assertAuthority("before_reservation");
  sendPhase.reserving = true;
  const nonce = await deps.reserveNonce(plan);
  timing.stop("nonceReserveMs");
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
    timing.start("signMs");
    const signed = await signLighterCreateOrderWithAdapter(signingInput, deps.signer);
    timing.stop("signMs");
    signerExited = lighterSignerRunExited({ kind: "resolved" });
    // Read before the hash is recorded: an expiry that contradicts the SDK
    // default throws here, while this signature still exists only in memory,
    // so the refusal below releases the nonce as provably unsent.
    const signerExpiryMs = readLighterSignedTxExpiredAtMs(signed.txInfo, deps.now());
    signerTxHash = signed.txHash;

    const signedIntent = await persistLighterSigningEvidence(() => deps.intents.markSigned({
      intentId: plan.intentId,
      sessionId: plan.sessionId,
      environment: plan.environment,
      nonceReservationId: nonce.reservationId,
      nonceValue: nonce.nonceValue,
      clientOrderIndex: unsignedOrder.clientOrderIndex,
      signerTxHash: signed.txHash,
      signerExpiryMs,
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
      timing.start("sendMs");
      response = await deps.client.sendTx(plan.environment, {
        txType: signed.txType,
        txInfo: signed.txInfo,
      });
      timing.stop("sendMs");
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
    timing.log(plan.intentId);

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
    "Ask Vex in chat to check this order before starting a fresh preview and approval.",
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
    recoverNonce: runLighterNonceRecovery,
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
  timing?: LighterOrderTiming,
  sessionWallet?: LighterSigningOwnershipWallet,
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
  // `LIGHTER_REVALIDATION_SINGLE_SNAPSHOT`: the fee check's two public reads
  // join the first batch. Nothing here is awaited until the fee check itself.
  const snapshotFeeReads = (deps.revalidationSingleSnapshot ?? LIGHTER_REVALIDATION_SINGLE_SNAPSHOT)
    ? startSnapshotFeePublicReads(plan, deps)
    : undefined;

  // `LIGHTER_STREAM_REVALIDATION`: decided once, before any read, so OFF (or
  // no live book young enough) issues exactly today's three REST reads.
  const streamBook = takeFreshLighterStreamOrderBook({
    enabled: deps.streamRevalidation ?? LIGHTER_STREAM_REVALIDATION,
    reader: deps.streamOrderBook,
    environment: plan.environment,
    marketId: plan.marketIndex,
    nowMs: deps.now(),
  });
  let market: Awaited<ReturnType<LighterClient["getMarketDetails"]>>;
  let restOrderBook: Awaited<ReturnType<LighterClient["getOrderBookOrders"]>> | null;
  let account: Awaited<ReturnType<LighterClient["getAccount"]>>;
  try {
    [market, restOrderBook, account] = await Promise.all([
      deps.client.getMarketDetails(plan.environment, {
        marketId: plan.marketIndex,
        filter: "all",
      }, FRESH_PUBLIC_READ),
      streamBook === null ? readRevalidationOrderBook(plan, deps) : null,
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
  } catch (error) {
    restateRevalidationReadFailure(error);
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
  // The stream book stands in only for the market type REST just reported;
  // any other answer reads the REST book now, refusing as today on failure.
  const streamBookUsed = streamBook !== null && streamBook.snapshot.marketType === marketDetail.market_type
    ? streamBook
    : null;
  let orderBook: Awaited<ReturnType<LighterClient["getOrderBookOrders"]>>;
  if (restOrderBook !== null) {
    orderBook = restOrderBook;
  } else if (streamBookUsed !== null) {
    orderBook = lighterOrderBookFromStream(streamBookUsed.snapshot);
  } else {
    try {
      orderBook = await readRevalidationOrderBook(plan, deps);
    } catch (error) {
      restateRevalidationReadFailure(error);
    }
  }

  // Started only now, after the first batch proved the market: the read-only
  // auth is resolved no earlier than the fee check below resolves it today.
  const snapshot = snapshotFeeReads === undefined
    ? null
    : startRevalidationSnapshot({ plan, deps, approvedPreview, market, account, feeReads: snapshotFeeReads });
  await revalidateLighterOrderFees({
    client: deps.client, environment: plan.environment, accountIndex: plan.accountIndex, market: marketDetail, account,
    reduceOnly: plan.reduceOnly, side: plan.side, integratorFees: plan.integratorFees,
    ...(snapshot?.fees === undefined ? {} : { snapshot: snapshot.fees }),
  });
  const accountTakerFeeTicks = marketDetail.market_type === "spot" && plan.side === "buy"
    ? await readLighterOrderAccountFeeTicks(deps.client, plan.environment, plan.accountIndex, snapshot?.feeTier) : undefined;
  // RE-ADMISSION at the commit point, against the account and the limits row as
  // they are NOW. `excludeIntentId` keeps this intent's own commitment from
  // counting against itself; the user may have withdrawn collateral or lowered
  // the share since approval, and either must refuse before anything is signed.
  await readmitLighterOrderCapitalCommitmentAtExecute({
    intentId: plan.intentId,
    preview: approvedPreview,
    client: deps.client,
    ...(snapshot?.capital === undefined ? {} : { snapshot: snapshot.capital }),
  });
  const evidence = revalidateApprovedLighterOrder({
    plan,
    approvedPreview,
    context: { market: marketDetail, orderBook, account, ...(accountTakerFeeTicks === undefined ? {} : { accountTakerFeeTicks }) },
    nowMs: deps.now(),
  });
  // `LIGHTER_SIGNING_OWNERSHIP_RECHECK`: last of the revalidation's checks, so
  // every existing refusal keeps its precedence, and before the evidence is
  // written, so a refused order records no passed revalidation.
  if (deps.signingOwnershipRecheck ?? LIGHTER_SIGNING_OWNERSHIP_RECHECK) {
    assertSessionWalletStillOwnsAccount(plan, account, sessionWallet);
  }
  const persisted = await deps.intents.markPreSubmitRevalidated({
    intentId: plan.intentId,
    sessionId: plan.sessionId,
    environment: plan.environment,
    evidence: {
      ...evidence,
      // Named only when the stream supplied the book, so OFF writes today's row.
      ...(streamBookUsed === null ? {} : { orderBookSource: "public_stream", orderBookAgeMs: streamBookUsed.ageMs }),
    },
  });
  if (persisted === null) {
    throw blockedBeforeSubmit(
      "Lighter pre-submit revalidation evidence could not be persisted. No trading key was loaded and no order was signed or submitted.",
    );
  }
  timing?.recordDecision(persisted);
  return evidence;
}

/**
 * The session wallet must still own the approved account, judged from the
 * revalidation's own fresh account read. Numbers and enums only are logged.
 */
function assertSessionWalletStillOwnsAccount(
  plan: LighterOrderReadyForSignerPlan,
  account: Awaited<ReturnType<LighterClient["getAccount"]>>,
  sessionWallet: LighterSigningOwnershipWallet | undefined,
): void {
  const outcome = judgeLighterSigningOwnership({ accountIndex: plan.accountIndex, account, wallet: sessionWallet });
  if (outcome.kind === "refused") throw blockedBeforeSubmit(outcome.reason);
  try {
    logger.info("lighter.order.signing_ownership_recheck", {
      outcome: outcome.kind,
      ...(outcome.kind === "matched" ? { accountTypeReported: outcome.accountTypeReported ? 1 : 0 } : {}),
    });
  } catch {
    // A log sink failure must never change an order's outcome.
  }
}

interface SnapshotFeePublicReads {
  readonly systemConfig: () => Promise<Awaited<ReturnType<NonNullable<LighterOrderFeeClient["getSystemConfig"]>>>>;
  readonly collectorAccount: () => Promise<Awaited<ReturnType<LighterClient["getAccount"]>>>;
}

/**
 * The fee check's public reads, started beside the first batch. Null (start
 * nothing) exactly when the fee check would read nothing: no fee policy for
 * this environment, or a client without the live fee reads, which the fee
 * check refuses or skips before any read.
 */
function startSnapshotFeePublicReads(
  plan: LighterOrderReadyForSignerPlan,
  deps: ExecuteApprovedLighterCreateOrderDeps,
): SnapshotFeePublicReads | null {
  const policy = getLighterFeePolicy(plan.environment);
  const { client } = deps;
  if (policy === null || !client.getAccount || !client.getSystemConfig || !client.getAccountLimits) return null;
  const systemConfig = settledLater(client.getSystemConfig(plan.environment, FRESH_PUBLIC_READ));
  const collectorAccount = settledLater(client.getAccount(plan.environment, {
    by: "index",
    value: policy.collectorAccountIndex,
  }, FRESH_PUBLIC_READ));
  return { systemConfig: () => systemConfig, collectorAccount: () => collectorAccount };
}

interface RevalidationSnapshot {
  /** Absent when the fee check reads nothing; it then runs exactly as today. */
  readonly fees?: LighterOrderFeeReadSnapshot;
  readonly feeTier: Pick<LighterOrderFeeReadSnapshot, "resolveAuth" | "accountLimits">;
  /** Absent when the preview names another scope than the plan (refused later). */
  readonly capital?: LighterCapitalShareExecuteSnapshot;
}

/**
 * The rest of the snapshot, started once the first batch proved the market.
 *
 * The auth and the account limits are shared and resolved at most once; each
 * consumer awaits the same promise at its own point, so a failure reaches
 * every consumer with that consumer's own handling. They start eagerly only
 * when the fee check will read them anyway (a fee policy applies); otherwise
 * the first consumer that reads them today starts them.
 */
function startRevalidationSnapshot(input: {
  readonly plan: LighterOrderReadyForSignerPlan;
  readonly deps: ExecuteApprovedLighterCreateOrderDeps;
  readonly approvedPreview: LighterOrderPreviewRow;
  readonly market: Awaited<ReturnType<LighterClient["getMarketDetails"]>>;
  readonly account: Awaited<ReturnType<LighterClient["getAccount"]>>;
  readonly feeReads: SnapshotFeePublicReads | null;
}): RevalidationSnapshot {
  const { plan, deps, approvedPreview, feeReads } = input;
  const resolveAuth = sharedRead(() => resolveLighterReadOnlyAccountAuth(plan.environment, plan.accountIndex));
  const accountLimits = sharedRead(async () => {
    const auth = await resolveAuth();
    // Unreachable through the checks, which each test both before reading.
    if (auth === null || !deps.client.getAccountLimits) {
      throw new Error("Lighter account limits were requested without a read-only account auth.");
    }
    return deps.client.getAccountLimits(plan.environment, { accountIndex: plan.accountIndex }, auth);
  });
  const depthBook = sharedRead(() => readLighterMarginFitDepthBook(deps.client, plan.environment, plan.marketIndex));

  if (feeReads !== null) {
    // The fee check resolves the auth next and, when it is non-null, reads the
    // limits with it: both start now instead of one after the other.
    void resolveAuth().then((auth) => {
      if (auth !== null) void accountLimits();
    }, () => undefined);
  }

  // The re-admission reads the preview's own scope. When that differs from the
  // plan (the pure revalidation refuses such a row afterwards) it keeps every
  // one of its own reads, exactly as today.
  const sameScope = approvedPreview.environment === plan.environment
    && approvedPreview.accountIndex === plan.accountIndex
    && approvedPreview.marketIndex === plan.marketIndex;
  if (sameScope) {
    const accountRow = input.account.accounts.find(
      (row) => (row.index ?? row.account_index) === plan.accountIndex,
    );
    if (accountRow !== undefined && lighterOrderMarginFitNeedsLiveReads(accountRow, approvedPreview)) {
      void depthBook();
    }
  }

  return {
    ...(feeReads === null ? {} : {
      fees: {
        traderAccount: input.account,
        systemConfig: feeReads.systemConfig,
        collectorAccount: feeReads.collectorAccount,
        resolveAuth,
        accountLimits,
      },
    }),
    feeTier: { resolveAuth, accountLimits },
    ...(sameScope
      ? { capital: { account: input.account, marketDetails: input.market, resolveAuth, accountLimits, depthBook } }
      : {}),
  };
}

/**
 * A read started now and awaited later, maybe never: its rejection is marked
 * handled here so an unconsumed failure is not an unhandled rejection, while
 * every consumer that awaits it still receives that rejection.
 */
function settledLater<T>(promise: Promise<T>): Promise<T> {
  promise.catch(() => undefined);
  return promise;
}

/** Started on first use, then the same promise for every consumer. */
function sharedRead<T>(start: () => Promise<T>): () => Promise<T> {
  let started: Promise<T> | null = null;
  return () => {
    started ??= settledLater(start());
    return started;
  };
}

type LighterOrderTimingPhase =
  | "revalidationMs"
  | "credentialMs"
  | "keyLoadMs"
  | "authMs"
  | "nonceReserveMs"
  | "signMs"
  | "sendMs";

/**
 * `[lighter-order-timing]`: one line per order that reached API acceptance,
 * numbers only beside the intent id (no prices, keys, tokens or other ids), so
 * the owner can compare phases before and after a speed switch.
 * `nonceReserveMs` runs from the key proof to the reserved nonce (duplicate
 * evidence check, nonce observation and reservation). Purely observational:
 * nothing here can change or fail an order.
 */
class LighterOrderTiming {
  private readonly started = new Map<LighterOrderTimingPhase, number>();
  private readonly durations = new Map<LighterOrderTimingPhase, number>();
  private decidedAtMs: number | null = null;

  start(phase: LighterOrderTimingPhase): void {
    this.started.set(phase, performance.now());
  }

  stop(phase: LighterOrderTimingPhase): void {
    const started = this.started.get(phase);
    if (started !== undefined) this.durations.set(phase, Math.round(performance.now() - started));
  }

  async measure<T>(phase: LighterOrderTimingPhase, run: () => Promise<T>): Promise<T> {
    this.start(phase);
    const value = await run();
    this.stop(phase);
    return value;
  }

  /** The intent row the revalidation write returned carries the approval instant. */
  recordDecision(row: object): void {
    const decidedAt = "decidedAt" in row ? row.decidedAt : null;
    const parsed = typeof decidedAt === "string" ? Date.parse(decidedAt) : Number.NaN;
    this.decidedAtMs = Number.isFinite(parsed) ? parsed : null;
  }

  log(intentId: string): void {
    try {
      logger.info("[lighter-order-timing]", {
        intentId,
        ...Object.fromEntries(this.durations),
        ...(this.decidedAtMs === null ? {} : { decisionToApiAcceptedMs: Date.now() - this.decidedAtMs }),
      });
    } catch {
      // A log sink failure must never turn an accepted order into an error.
    }
  }
}

function readRevalidationOrderBook(
  plan: LighterOrderReadyForSignerPlan,
  deps: ExecuteApprovedLighterCreateOrderDeps,
): Promise<Awaited<ReturnType<LighterClient["getOrderBookOrders"]>>> {
  return deps.client.getOrderBookOrders(plan.environment, {
    marketId: plan.marketIndex,
    limit: 250,
  }, FRESH_PUBLIC_READ);
}

function restateRevalidationReadFailure(error: unknown): never {
  // Unreachable Lighter is restated plainly by the execution's before-send wrapper.
  if (isLighterUnreachable(error)) throw error;
  throw blockedBeforeSubmit(
    "Live Lighter market or account state is unavailable for post-approval revalidation. No trading key was loaded and no order was signed or submitted.",
  );
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
  } catch (error) {
    // Unreachable Lighter is restated plainly by the execution's before-send wrapper.
    if (isLighterUnreachable(error)) throw error;
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

interface PreflightReads {
  readonly evidenceScope: LighterOrderEvidenceScope;
  readonly providerCredential: Awaited<ReturnType<typeof readLiveProviderCredential>>;
}

/** Today's order: revalidate, build the evidence scope, then read the credential. */
async function runSequentialPreflightReads(
  plan: LighterOrderReadyForSignerPlan,
  unsignedOrder: LighterUnsignedCreateOrderRequest,
  deps: ExecuteApprovedLighterCreateOrderDeps,
  timing: LighterOrderTiming,
  sessionWallet?: LighterSigningOwnershipWallet,
): Promise<PreflightReads> {
  const revalidationEvidence = await timing.measure("revalidationMs", () => revalidateLiveOrderState(plan, deps, timing, sessionWallet));
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
  const providerCredential = await timing.measure("credentialMs", () => readLiveProviderCredential(plan, deps));
  return { evidenceScope, providerCredential };
}

/**
 * `LIGHTER_ORDER_PARALLEL_PREFLIGHT` ON: the same two steps, overlapped.
 *
 * Both are awaited to settlement before anything else happens, so the trading
 * key is still loaded only after BOTH succeeded. The refusal precedence is the
 * sequential one: a revalidation or evidence-scope failure wins over a
 * credential failure, whichever settled first, so two failures report exactly
 * what today's order would.
 */
async function runParallelPreflightReads(
  plan: LighterOrderReadyForSignerPlan,
  unsignedOrder: LighterUnsignedCreateOrderRequest,
  deps: ExecuteApprovedLighterCreateOrderDeps,
  timing: LighterOrderTiming,
  sessionWallet?: LighterSigningOwnershipWallet,
): Promise<PreflightReads> {
  const [revalidation, credential] = await Promise.allSettled([
    timing.measure("revalidationMs", () => revalidateLiveOrderState(plan, deps, timing, sessionWallet)).then((revalidationEvidence) => buildLighterOrderEvidenceScope({
      approved: plan,
      baseDecimals: revalidationEvidence.baseDecimals,
      priceDecimals: revalidationEvidence.priceDecimals,
      signedOrderExpiryMs: unsignedOrder.orderExpiryMs,
    })),
    timing.measure("credentialMs", () => readLiveProviderCredential(plan, deps)),
  ]);
  if (revalidation.status === "rejected") throw revalidation.reason;
  if (credential.status === "rejected") throw credential.reason;
  return { evidenceScope: revalidation.value, providerCredential: credential.value };
}

function resolveReadAuthCache(deps: ExecuteApprovedLighterCreateOrderDeps): LighterReadAuthCache | null {
  if (deps.readAuthCache !== undefined) return deps.readAuthCache;
  return LIGHTER_READ_AUTH_CACHE ? lighterReadAuthCache : null;
}

function readAuthCacheScope(plan: LighterOrderReadyForSignerPlan): LighterReadAuthCacheScope {
  return { environment: plan.environment, accountIndex: plan.accountIndex, apiKeyIndex: plan.apiKeyIndex };
}

interface ProviderOutcomeRepairLists {
  readonly activeOrders: Awaited<ReturnType<LighterClient["getAccountActiveOrders"]>>;
  readonly inactiveOrders: Awaited<ReturnType<LighterClient["getAccountInactiveOrders"]>>;
  readonly trades: Awaited<ReturnType<LighterClient["getAccountTrades"]>>;
}

type CachedRepairReadOutcome =
  | { readonly ok: true; readonly publicKey: string; readonly lists: ProviderOutcomeRepairLists }
  | { readonly ok: false };

interface CachedRepairReads {
  /** Never rejects: a failed read is an `ok: false` answer, never a refusal. */
  readonly outcome: Promise<CachedRepairReadOutcome>;
}

/**
 * `LIGHTER_READ_AUTH_CACHE` ON with a usable entry: start the duplicate
 * evidence reads with the cached READ-ONLY token now, beside revalidation.
 * Nothing is decided here; the answer is judged after the fresh key proof.
 */
function startCachedRepairReads(
  plan: LighterOrderReadyForSignerPlan,
  deps: ExecuteApprovedLighterCreateOrderDeps,
  cache: LighterReadAuthCache | null,
): CachedRepairReads | null {
  if (cache === null) return null;
  const entry = cache.get(readAuthCacheScope(plan), deps.now());
  if (entry === null) return null;
  return {
    outcome: readProviderOutcomeRepairLists(plan, entry.token, deps).then(
      (lists): CachedRepairReadOutcome => ({ ok: true, publicKey: entry.publicKey, lists }),
      (): CachedRepairReadOutcome => ({ ok: false }),
    ),
  };
}

/**
 * The cached-token answer is used only when every read succeeded AND the token
 * was minted for the very key the fresh mint just proved against the
 * provider's registered key. Anything else (an auth error, any other failure,
 * a rotated key) drops the entry and runs today's read with the fresh token,
 * so a refusal can only ever come from the path that exists today.
 */
async function assertProviderOutcomeRepairReadyWithCache(input: {
  readonly plan: LighterOrderReadyForSignerPlan;
  readonly evidenceScope: LighterOrderEvidenceScope;
  readonly unsignedOrder: LighterUnsignedCreateOrderRequest;
  readonly auth: { readonly authToken: string; readonly publicKey: string };
  readonly authDeadlineUnixSeconds: number;
  readonly deps: ExecuteApprovedLighterCreateOrderDeps;
  readonly cache: LighterReadAuthCache;
  readonly cached: CachedRepairReads | null;
}): Promise<void> {
  const { plan, evidenceScope, unsignedOrder, auth, deps, cache } = input;
  const scope = readAuthCacheScope(plan);
  if (input.cached !== null) {
    const cached = await input.cached.outcome;
    if (cached.ok && cached.publicKey === normalizeLighterPublicKey(auth.publicKey)) {
      assertNoExistingClientOrderEvidence(cached.lists, evidenceScope, unsignedOrder);
      return;
    }
    cache.invalidate(scope);
  }
  try {
    await assertProviderOutcomeRepairReady(plan, evidenceScope, unsignedOrder, auth.authToken, deps);
  } catch (error) {
    cache.invalidate(scope);
    throw error;
  }
  // Lighter just accepted this token for all three reads: only now is it
  // remembered, and only the read-only token, never the key it came from.
  cache.remember(scope, {
    token: auth.authToken,
    publicKey: auth.publicKey,
    deadlineUnixSeconds: input.authDeadlineUnixSeconds,
  }, deps.now());
}

async function readProviderOutcomeRepairLists(
  plan: LighterOrderReadyForSignerPlan,
  accountAuthToken: string,
  deps: ExecuteApprovedLighterCreateOrderDeps,
): Promise<ProviderOutcomeRepairLists> {
  const privilegedAuth = { token: accountAuthToken, accountIndex: plan.accountIndex };
  return await Promise.all([
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
  ]).then(([activeOrders, inactiveOrders, trades]) => ({ activeOrders, inactiveOrders, trades }));
}

async function assertProviderOutcomeRepairReady(
  plan: LighterOrderReadyForSignerPlan,
  evidenceScope: LighterOrderEvidenceScope,
  unsignedOrder: LighterUnsignedCreateOrderRequest,
  accountAuthToken: string,
  deps: ExecuteApprovedLighterCreateOrderDeps,
): Promise<void> {
  let lists: ProviderOutcomeRepairLists;
  try {
    lists = await readProviderOutcomeRepairLists(plan, accountAuthToken, deps);
  } catch (error) {
    // Unreachable Lighter is restated plainly by the execution's before-send wrapper.
    if (isLighterUnreachable(error)) throw error;
    throw blockedBeforeSubmit(
      "Lighter provider outcome repair is unavailable before submission. No order was signed or submitted.",
    );
  }
  assertNoExistingClientOrderEvidence(lists, evidenceScope, unsignedOrder);
}

function assertNoExistingClientOrderEvidence(
  lists: ProviderOutcomeRepairLists,
  evidenceScope: LighterOrderEvidenceScope,
  unsignedOrder: LighterUnsignedCreateOrderRequest,
): void {
  const existingOrder = findMatchingLighterOrder(
    [...lists.activeOrders.orders, ...lists.inactiveOrders.orders],
    evidenceScope,
    unsignedOrder.clientOrderIndex,
  );
  const existingTrade = findMatchingLighterTrade(
    lists.trades.trades,
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
    // BOTH LISTS ON EVERY ATTEMPT, because a resting order and a finished one
    // are not two phases of the same wait - they are two places the SAME
    // answer can appear, and which one it lands in is decided before the first
    // read. This polled only active orders, three times, and fell through to
    // inactive once at the end. A market IOC never rests: it is inactive from
    // the moment it executes, so every one of those three reads was a
    // guaranteed miss and the waits between them were spent waiting for a row
    // that could not arrive. Nine of nine orders on this account resolved from
    // `inactive_order`; the active poll had never once hit.
    for (let attempt = 0; attempt < PROVIDER_OUTCOME_ACTIVE_ATTEMPTS; attempt += 1) {
      const [activeOrders, inactiveOrders] = await Promise.all([
        deps.client.getAccountActiveOrders(
          plan.environment,
          {
            accountIndex: plan.accountIndex,
            marketId: plan.marketIndex,
            marketType: "all",
          },
          { token: accountAuthToken, accountIndex: plan.accountIndex },
        ),
        deps.client.getAccountInactiveOrders(
          plan.environment,
          {
            accountIndex: plan.accountIndex,
            marketId: plan.marketIndex,
            marketType: "all",
            limit: 100,
          },
          { token: accountAuthToken, accountIndex: plan.accountIndex },
        ),
      ]);
      // Active first, and only as a tie-break: an order is in one list or the
      // other, and preferring the live row keeps a still-working order from
      // being read as finished by a stale inactive page.
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
      if (attempt < PROVIDER_OUTCOME_ACTIVE_ATTEMPTS - 1) {
        // Recomputed each time against the clock, so the wait tracks the time
        // still left until the provider expects to have executed rather than a
        // figure taken before the first read.
        const delayMs = providerOutcomeDelayMs(predictedExecutionTimeMs, deps.now());
        await deps.wait(delayMs * (attempt + 1));
      }
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

/**
 * How long to wait before asking the provider again.
 *
 * `predicted_execution_time_ms` is an INSTANT, not a duration: Lighter answers
 * `sendTx` with the wall-clock time it expects the order to execute at. This
 * read it as a length and handed the clamp an epoch figure, so
 * `min(2000, max(100, 1.79e12))` pinned every wait to the 2s ceiling and the
 * loop slept its full budget on every order, however fast the order actually
 * was. Measured on a live RHC fill: the prediction landed BEFORE `sendTx` even
 * returned, and the poll still slept six seconds.
 *
 * Taking the remaining time against a caller-supplied clock also makes the
 * wait self-correcting across attempts, rather than a figure computed once
 * before the first read and then reused while it goes stale.
 *
 * A deployment that ever answers with a genuine duration lands far in the past
 * under this reading and clamps to the floor, which is the safe direction:
 * Vex polls sooner and reads the provider's own evidence either way.
 */
function providerOutcomeDelayMs(predictedExecutionAtMs: number, nowMs: number): number {
  const remainingMs = predictedExecutionAtMs - nowMs;
  if (!Number.isFinite(remainingMs)) return PROVIDER_OUTCOME_MIN_DELAY_MS;
  return Math.min(
    PROVIDER_OUTCOME_MAX_DELAY_MS,
    Math.max(PROVIDER_OUTCOME_MIN_DELAY_MS, Math.ceil(remainingMs)),
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
    const streamed = current !== null
      && current.sessionId === input.plan.sessionId
      && current.environment === input.plan.environment
      && current.approvalStatus === "approved"
      && current.clientOrderIndex === input.unsignedOrder.clientOrderIndex
      && current.providerOrderId === input.providerOrderId
      && current.providerOutcomeSource === "inactive_order"
      && isTerminalProviderExecutionState(current.executionState)
      ? current.executionState
      : null;
    if (current !== null && streamed !== null) {
      // The stream committed the terminal outcome while this read was in
      // flight, so the ledger write that belongs to it was never made here.
      // EVERY terminal state belongs here, not only `filled`: the refusal
      // above is the transition guard doing its job, and reporting a proven
      // cancel or rejection as ambiguous told the desk an outcome was unknown
      // when the row beside it already said exactly what happened.
      await observeFillsFromOrderEvidence(input, streamed, "inactive_order");
      await markLighterOrderCapitalCommitmentSettled(input.plan.intentId);
      return {
        status: "provider_confirmed",
        intentId: input.plan.intentId,
        environment: input.plan.environment,
        executionState: streamed,
        signerTxHash: input.signerTxHash,
        submittedTxHash: input.submittedTxHash,
        evidenceSource: "inactive_order",
        clientOrderIndex: input.unsignedOrder.clientOrderIndex,
        providerOrderId: current.providerOrderId,
        providerOrderStatus: current.providerOrderStatus,
        providerEvidence: current.providerOutcomeJson ?? undefined,
        message: `Lighter provider evidence confirmed order state ${streamed}.`,
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
 * AND ONLY WHILE THE LEDGER IS STILL BEHIND THE VENUE. The account order
 * stream watches the same order this dispatch is settling, and on a fast fill
 * it records the trade first; this read then re-derived the market, the assets
 * and the trade page to discover it held nothing new. Measured live: six
 * seconds on the trader's critical path to report `recorded: 0,
 * duplicates: 1`.
 *
 * The gate is a COMPLETENESS test, not an existence test - it asks whether the
 * recorded quantity has caught up with the quantity the provider reported for
 * THIS order, and reads whenever it has not, or whenever either figure cannot
 * be read. That is what makes it safe here: a partial fill recorded by the
 * stream does not excuse the rest, and an evidence row carrying no filled
 * quantity still reads. Nothing is skipped on the strength of a row merely
 * existing, which is the mistake that loses a late second fill for good.
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
    onlyWhenLedgerIncomplete: {
      reportedFilledBaseSize: reportedLighterFilledBaseSize(
        input.providerOutcomeJson["filledBaseAmount"],
      ),
    },
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
