import type { LighterClient } from "@tools/lighter/client.js";
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

export type ExecuteApprovedLighterCreateOrderResult =
  | {
      readonly status: "api_accepted";
      readonly intentId: string;
      readonly environment: LighterOrderReadyForSignerPlan["environment"];
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
  readonly client: Pick<LighterClient, "sendTx">;
  readonly intents: Pick<
    typeof lighterOrderExecutionIntentsRepo,
    "markSigned" | "markSubmitted" | "markApiAccepted" | "markAmbiguous"
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

    return {
      status: "api_accepted",
      intentId: plan.intentId,
      environment: plan.environment,
      executionState: "api_accepted",
      signerTxHash: signed.txHash,
      submittedTxHash: response.tx_hash,
      submitCode: response.code,
      predictedExecutionTimeMs: response.predicted_execution_time_ms,
      volumeQuotaRemaining: accepted.volumeQuotaRemaining,
      message:
        "Lighter accepted the signed order submission at the API boundary. Vex still needs provider order-state evidence before reporting open, filled, canceled, or rejected.",
    };
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
    readonly client: Pick<LighterClient, "sendTx">;
  },
): ExecuteApprovedLighterCreateOrderDeps {
  return {
    liveTradingEnabled: isLighterLiveTradingEnabled,
    reserveNonce: reserveLighterOrderNonceForSigning,
    intents: lighterOrderExecutionIntentsRepo,
    ...overrides,
  };
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
