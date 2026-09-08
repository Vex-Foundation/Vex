import { persistLighterSigningEvidence, type LighterEvidenceWritePorts } from "./execution-boundary.js";
import { assertIntentAuthority, LighterIntentRefusal, lighterSignerExited, lighterSignerResolutionExited } from "./intent-expiry.js";
import type { LighterClient } from "@tools/lighter/client.js";
import {
  buildLighterAccountAuthSigningInputForScope,
  createLighterAccountAuthWithAdapter,
  type LighterSignerAdapter,
} from "@tools/lighter/signer-adapter.js";
import {
  buildLighterWithdrawalSigningInput,
  signLighterWithdrawalWithAdapter,
  type LighterWithdrawalSignerAdapter,
} from "@tools/lighter/signer-withdrawal.js";
import {
  loadLighterTradingSecretMaterial,
  type LighterTradingSecretReader,
} from "@tools/lighter/trading-secret.js";
import type { LighterCoreWithdrawalPreflightSnapshot } from "@tools/lighter/withdrawal/core-preflight.js";
import type { LighterRhcWithdrawalPreflightSnapshot } from "@tools/lighter/withdrawal/rhc-preflight.js";
import { getLighterSecureWithdrawalProfile } from "@tools/lighter/withdrawal/profiles.js";
import { ErrorCodes, VexError } from "../../../../errors.js";
import * as nonceStateRepo from "@vex-agent/db/repos/lighter-nonce-state.js";
import * as withdrawalIntentsRepo from "@vex-agent/db/repos/lighter-withdrawal-intents.js";
import {
  reserveLighterWithdrawalNonceForSigning,
  type LighterWithdrawalNonceReservation,
} from "./withdrawal-nonce-reservation.js";
import type {
  LighterCoreWithdrawalReadyForSignerPlan,
  LighterWithdrawalReadyForSignerPlan,
} from "./withdrawal-execution-plan.js";

const ACCOUNT_AUTH_TTL_SECONDS = 10 * 60;
const SIGNER_EXPIRY_LEAD_MS = 2 * 60_000;

export interface ExecuteApprovedLighterCoreWithdrawalDeps {
  readonly secretReader: LighterTradingSecretReader;
  readonly authSigner: LighterSignerAdapter;
  readonly withdrawalSigner: LighterWithdrawalSignerAdapter;
  readonly client: Pick<LighterClient, "sendTx">;
  readonly readPreflight: (
    plan: LighterWithdrawalReadyForSignerPlan,
  ) => Promise<LighterCoreWithdrawalPreflightSnapshot | LighterRhcWithdrawalPreflightSnapshot>;
  readonly nonceState: LighterEvidenceWritePorts<Pick<typeof nonceStateRepo, "recordExecutionObserved">>
    & Pick<typeof nonceStateRepo, "releaseUnsubmittedReservation">;
  readonly reserveNonce: (
    plan: LighterWithdrawalReadyForSignerPlan,
  ) => Promise<Pick<LighterWithdrawalNonceReservation, "reservationId" | "nonceValue">>;
  readonly intents: LighterEvidenceWritePorts<Pick<typeof withdrawalIntentsRepo,
    "markPreSubmitRevalidated" | "markSigned" | "markSubmissionStaged" | "markApiAccepted" | "markAmbiguous">>
    & Pick<typeof withdrawalIntentsRepo, "markSendAttemptStarted" | "markExpiredUnsubmitted" | "markUnsubmittedRefused">;
  readonly now: () => number;
}

export type ExecuteApprovedLighterCoreWithdrawalResult =
  | {
    readonly status: "submitted";
    readonly intentId: string;
    readonly executionState: "api_accepted";
    readonly signerTxHash: string;
    readonly submittedTxHash: string;
    readonly submitCode: number;
    readonly predictedExecutionTimeMs: number;
    readonly volumeQuotaRemaining: string | null;
    readonly message: string;
  }
  | {
    readonly status: "ambiguous";
    readonly intentId: string;
    readonly executionState: "ambiguous";
    readonly signerTxHash: string | null;
    readonly reason: string;
    readonly message: string;
  };

let configuredDeps: ExecuteApprovedLighterCoreWithdrawalDeps | null = null;

export function configureLighterCoreWithdrawalExecutionDeps(
  deps: ExecuteApprovedLighterCoreWithdrawalDeps,
): () => void {
  configuredDeps = deps;
  return () => {
    if (configuredDeps === deps) configuredDeps = null;
  };
}

export function getConfiguredLighterCoreWithdrawalExecutionDeps(): ExecuteApprovedLighterCoreWithdrawalDeps | null {
  return configuredDeps;
}

export function defaultLighterCoreWithdrawalExecutionDeps(input: {
  readonly secretReader: LighterTradingSecretReader;
  readonly authSigner: LighterSignerAdapter;
  readonly withdrawalSigner: LighterWithdrawalSignerAdapter;
  readonly client: Pick<LighterClient, "sendTx">;
  readonly readPreflight: ExecuteApprovedLighterCoreWithdrawalDeps["readPreflight"];
}): ExecuteApprovedLighterCoreWithdrawalDeps {
  return {
    ...input,
    nonceState: nonceStateRepo,
    reserveNonce: reserveLighterWithdrawalNonceForSigning,
    intents: withdrawalIntentsRepo,
    now: Date.now,
  };
}

export async function executeApprovedLighterCoreWithdrawal(input: {
  readonly plan: LighterCoreWithdrawalReadyForSignerPlan;
  readonly deps: ExecuteApprovedLighterCoreWithdrawalDeps;
  readonly abortSignal?: AbortSignal;
}): Promise<ExecuteApprovedLighterCoreWithdrawalResult> {
  return executeApprovedLighterWithdrawal(input);
}

export async function executeApprovedLighterWithdrawal(input: {
  readonly plan: LighterWithdrawalReadyForSignerPlan;
  readonly deps: ExecuteApprovedLighterCoreWithdrawalDeps;
  readonly abortSignal?: AbortSignal;
}): Promise<ExecuteApprovedLighterCoreWithdrawalResult> {
  const { plan, deps } = input;
  const assertAuthority = (phase: Parameters<typeof assertIntentAuthority>[2]): void =>
    assertIntentAuthority(plan.expiresAt, deps.now(), phase, input.abortSignal);
  assertAuthority("before_reservation");
  const profile = getLighterSecureWithdrawalProfile(plan.environment);
  const fresh = await deps.readPreflight(plan);
  assertFreshPreflightMatchesApprovedPlan(plan, fresh);
  const revalidated = await deps.intents.markPreSubmitRevalidated({
    intentId: plan.intentId,
    sessionId: plan.sessionId,
    evidence: Object.fromEntries(Object.entries(fresh)),
  });
  if (revalidated === null) throw blocked(`The approved ${profile.sourceName} withdrawal could not persist fresh pre-submit evidence.`);

  const secret = await loadLighterTradingSecretMaterial(plan.credentialReference, deps.secretReader);
  assertAuthority("before_reservation");
  const auth = await createLighterAccountAuthWithAdapter(
    buildLighterAccountAuthSigningInputForScope({
      environment: plan.environment,
      accountIndex: plan.accountIndex,
      apiKeyIndex: plan.apiKeyIndex,
      secret,
      deadlineUnixSeconds: Math.floor(deps.now() / 1_000) + ACCOUNT_AUTH_TTL_SECONDS,
    }),
    deps.authSigner,
  );
  if (canonicalPublicKey(auth.publicKey) !== canonicalPublicKey(fresh.registeredPublicKey)) {
    throw blocked(`The locally encrypted ${profile.sourceName} credential does not match the live registered public key.`);
  }
  const observed = await deps.nonceState.recordExecutionObserved({
    environment: plan.environment,
    accountIndex: plan.accountIndex,
    apiKeyIndex: plan.apiKeyIndex,
    nonce: Number(fresh.nextNonce),
    publicKey: fresh.registeredPublicKey,
    transactionTime: Number(fresh.keyTransactionTime),
  });
  if (observed === null) {
    throw blocked(`The live ${profile.sourceName} nonce cannot advance past an unresolved local transaction reservation.`);
  }

  assertAuthority("before_reservation");
  const reservation = await deps.reserveNonce(plan);
  let signerTxHash: string | null = null;
  let signingStarted = false;
  let signerExited = false;
  let sendAdmissionStarted = false;
  try {
    assertAuthority("after_reservation");
    assertAuthority("before_signing");
    signingStarted = true;
    const signerExpiryMs = deps.now() + SIGNER_EXPIRY_LEAD_MS;
    const signed = await signLighterWithdrawalWithAdapter(
      buildLighterWithdrawalSigningInput({
        environment: plan.environment,
        accountIndex: plan.accountIndex,
        apiKeyIndex: plan.apiKeyIndex,
        nonce: reservation.nonceValue,
        expiredAt: String(signerExpiryMs),
        amountUnits: plan.amountUnits,
        matchHash: plan.matchHash,
        secret,
        nowMs: deps.now(),
      }),
      deps.withdrawalSigner,
    );
    signerExited = lighterSignerResolutionExited(signed);
    signerTxHash = signed.txHash;
    const persistedSigned = await persistLighterSigningEvidence(() => deps.intents.markSigned({
      intentId: plan.intentId,
      sessionId: plan.sessionId,
      reservationId: reservation.reservationId,
      nonceValue: reservation.nonceValue,
      signerTxHash: signed.txHash,
      signerExpiryMs,
    }));
    if (persistedSigned === null) return await ambiguous(deps, plan, "signed_state_persist_failed", signed.txHash);

    assertAuthority("after_signing");
    const staged = await deps.intents.markSubmissionStaged({
      intentId: plan.intentId,
      sessionId: plan.sessionId,
      signerTxHash: signed.txHash,
    });
    if (staged === null) throw new LighterIntentRefusal("submission_admission_refused");

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
    if (deps.now() >= signerExpiryMs) throw blocked("The signed withdrawal wire expiry elapsed before send.");

    let response: Awaited<ReturnType<LighterClient["sendTx"]>>;
    try {
      response = await deps.client.sendTx(plan.environment, { txType: 13, txInfo: signed.txInfo });
    } catch {
      return await ambiguous(deps, plan, "sendtx_outcome_unknown", signed.txHash);
    }
    if (response.code !== 200) return await ambiguous(deps, plan, "provider_non_acceptance_code", signed.txHash);
    if (response.tx_hash !== signed.txHash) return await ambiguous(deps, plan, "provider_tx_hash_mismatch", signed.txHash);

    let accepted: Awaited<ReturnType<ExecuteApprovedLighterCoreWithdrawalDeps["intents"]["markApiAccepted"]>>;
    try {
      accepted = await deps.intents.markApiAccepted({
        intentId: plan.intentId,
        sessionId: plan.sessionId,
        signerTxHash: signed.txHash,
        submittedTxHash: response.tx_hash,
        submitCode: response.code,
        submitMessage: response.message ?? null,
        predictedExecutionTimeMs: response.predicted_execution_time_ms,
        volumeQuotaRemaining: response.volume_quota_remaining ?? null,
        settlementScanFromBlock: plan.settlementScanFromBlock,
      });
    } catch {
      return await ambiguous(deps, plan, "api_acceptance_persist_failed", signed.txHash);
    }
    if (accepted === null) return await ambiguous(deps, plan, "api_acceptance_persist_failed", signed.txHash);
    return {
      status: "submitted",
      intentId: plan.intentId,
      executionState: "api_accepted",
      signerTxHash: signed.txHash,
      submittedTxHash: response.tx_hash,
      submitCode: response.code,
      predictedExecutionTimeMs: response.predicted_execution_time_ms,
      volumeQuotaRemaining: response.volume_quota_remaining === undefined
        ? null
        : String(response.volume_quota_remaining),
      message: `The exact ${profile.sourceName} ${profile.assetSymbol} secure withdrawal was accepted by Lighter and is awaiting L2 and ${profile.settlementNetworkName} settlement proof.`,
    };
  } catch (error) {
    signerExited ||= lighterSignerExited(error);
    if (!sendAdmissionStarted && (!signingStarted || (error instanceof LighterIntentRefusal && signerExited))) {
      const refused = signerTxHash === null
        ? await deps.intents.markUnsubmittedRefused({
          intentId: plan.intentId, sessionId: plan.sessionId, reservationId: reservation.reservationId, reason: error instanceof LighterIntentRefusal ? error.reason : "pre_sign_refused",
        })
        : await deps.intents.markExpiredUnsubmitted({
          intentId: plan.intentId, sessionId: plan.sessionId, reservationId: reservation.reservationId,
          signerTxHash, reason: error instanceof LighterIntentRefusal ? error.reason : "pre_sign_refused",
        });
      if (refused) await deps.nonceState.releaseUnsubmittedReservation({
        environment: plan.environment, accountIndex: plan.accountIndex, apiKeyIndex: plan.apiKeyIndex,
        reservationId: reservation.reservationId, nonceValue: reservation.nonceValue,
      });
    } else if (signerTxHash === null || error instanceof LighterIntentRefusal) {
      await ambiguous(deps, plan, error instanceof LighterIntentRefusal ? error.reason : "failure_after_nonce_reservation", signerTxHash);
    }
    throw error;
  }
}

export function assertFreshPreflightMatchesApprovedPlan(
  plan: LighterWithdrawalReadyForSignerPlan,
  fresh: LighterCoreWithdrawalPreflightSnapshot | LighterRhcWithdrawalPreflightSnapshot,
): void {
  const profile = getLighterSecureWithdrawalProfile(plan.environment);
  if (
    fresh.environment !== plan.environment
    || fresh.operationClass !== "secure_l2_withdrawal"
    || fresh.signingChainId !== profile.signingChainId
    || fresh.settlementChainId !== profile.settlementChainId
    || fresh.accountIndex !== plan.accountIndex
    || fresh.apiKeyIndex !== plan.apiKeyIndex
    || fresh.walletAddress.toLowerCase() !== plan.walletAddress.toLowerCase()
    || fresh.destinationAddress.toLowerCase() !== plan.destinationAddress.toLowerCase()
    || fresh.assetIndex !== profile.assetIndex
    || fresh.assetSymbol !== profile.assetSymbol
    || fresh.assetDecimals !== profile.assetDecimals
    || fresh.routeType !== profile.routeType
    || fresh.amountUnits !== plan.amountUnits
    || fresh.settlementTokenAddress.toLowerCase() !== plan.settlementTokenAddress.toLowerCase()
    || fresh.gatewayAddress.toLowerCase() !== plan.gatewayAddress.toLowerCase()
    || fresh.gatewayImplementationAddress.toLowerCase() !== plan.gatewayImplementation.toLowerCase()
    || fresh.gatewayCodeHash !== plan.gatewayCodeHash
    || fresh.settlementTokenCodeHash !== plan.settlementTokenCodeHash
    || fresh.pendingBalanceUnits !== "0"
    || fresh.nonterminalWithdrawalCount !== 0
  ) {
    throw blocked(`Fresh ${profile.sourceName} account or ${profile.settlementNetworkName} evidence no longer matches the approved withdrawal.`);
  }
}

async function ambiguous(
  deps: ExecuteApprovedLighterCoreWithdrawalDeps,
  plan: LighterWithdrawalReadyForSignerPlan,
  reason: string,
  signerTxHash: string | null,
): Promise<Extract<ExecuteApprovedLighterCoreWithdrawalResult, { status: "ambiguous" }>> {
  await deps.intents.markAmbiguous({ intentId: plan.intentId, sessionId: plan.sessionId, reason });
  return {
    status: "ambiguous",
    intentId: plan.intentId,
    executionState: "ambiguous",
    signerTxHash,
    reason,
    message: `The ${plan.environment.toUpperCase()} withdrawal outcome is uncertain. Vex will reconcile the exact transaction hash and will not retry blindly.`,
  };
}

function canonicalPublicKey(value: string): string {
  const canonical = value.trim().toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]{80}$/.test(canonical)) throw blocked("Lighter returned an invalid registered public key.");
  return canonical;
}

function blocked(message: string): VexError {
  return new VexError(
    ErrorCodes.LIGHTER_INVALID_REQUEST,
    message,
    "No retry is permitted without reconciling the durable environment-scoped withdrawal intent.",
  );
}

export const DEFAULT_LIGHTER_WITHDRAWAL_RESERVE_NONCE = reserveLighterWithdrawalNonceForSigning;
