import { buildLighterUnsignedOcoRequest } from "@tools/lighter/oco-order.js";
import type { LighterEnvironment } from "@tools/lighter/types.js";
import * as intentsRepo from "@vex-agent/db/repos/lighter-oco-execution-intents.js";
import type { LighterOcoExecutionIntentRow } from "@vex-agent/db/repos/lighter-oco-execution-intents.js";
import * as nonceRepo from "@vex-agent/db/repos/lighter-nonce-state.js";
import { classifyOcoEvidence } from "./oco-order-execution.js";
import {
  isLighterExpiredUnsubmittedState,
  LIGHTER_EXPIRED_UNSUBMITTED_GUIDANCE,
} from "./order-evidence.js";
import { defaultLighterOrderRepairDeps } from "./order-repair.js";
import { lighterLostSendReleaseAtMs } from "./lost-send-release.js";

const NEVER_SUBMITTED = new Set([
  "oco_signing_failed_after_nonce_reservation",
  "oco_signed_state_persist_failed",
  "oco_submitted_state_persist_failed",
]);

export interface LighterOcoRepairReport {
  readonly kind: "oco_protection";
  readonly intentId: string;
  readonly stateBefore: LighterOcoExecutionIntentRow["executionState"];
  readonly stateAfter: LighterOcoExecutionIntentRow["executionState"];
  readonly resolution: "already_terminal" | "awaiting_submission" | "expired_unsubmitted" | "provider_evidence" | "awaiting_provider" | "nonce_released_never_submitted" | "nonce_released_expired_unconsumed" | "degraded";
  readonly nonceBlockedAfter: boolean;
  readonly guidance: string;
  readonly evidence: Record<string, unknown> | null;
}

function groupFor(intent: LighterOcoExecutionIntentRow) {
  return buildLighterUnsignedOcoRequest({
    matchHash: intent.matchHash,
    environment: intent.environment,
    accountIndex: intent.accountIndex,
    apiKeyIndex: intent.apiKeyIndex,
    marketIndex: intent.marketIndex,
    side: intent.side,
    baseAmountInteger: intent.baseAmountInteger,
    orderExpiryMs: intent.orderExpiryMs,
    stopLoss: {
      matchHash: intent.stopLossMatchHash,
      priceInteger: intent.stopLossPriceInteger,
      triggerPriceInteger: intent.stopLossTriggerPriceInteger,
    },
    takeProfit: {
      matchHash: intent.takeProfitMatchHash,
      priceInteger: intent.takeProfitPriceInteger,
      triggerPriceInteger: intent.takeProfitTriggerPriceInteger,
    },
  });
}

export async function repairLighterOcoIntent(
  intent: LighterOcoExecutionIntentRow,
): Promise<LighterOcoRepairReport> {
  if (isLighterExpiredUnsubmittedState(intent.executionState)) {
    // Terminal for recovery: no provider read is spent, nothing is resubmitted,
    // and the outcome is reported under its own name instead of "ambiguous".
    return report(intent, intent.executionState, "expired_unsubmitted",
      intent.nonceReservationId !== null,
      LIGHTER_EXPIRED_UNSUBMITTED_GUIDANCE, intent.providerOutcomeJson);
  }
  if (intent.executionState === "signed"
    || (intent.executionState === "approval_pending" && intent.nonceReservationId !== null)) {
    const expiry = Date.parse(intent.expiresAt);
    if (!Number.isFinite(expiry) || intent.nonceReservationId !== `lighter-oco:${intent.intentId}`
      || intent.nonceValue === null) {
      return report(intent, intent.executionState, "degraded", true,
        "The pre-send reservation identity or consent expiry is incomplete. Keep this OCO blocked for reconciliation.", null);
    }
    if (expiry > Date.now()) {
      return report(intent, intent.executionState, "awaiting_submission", true,
        "This OCO still has valid consent and may be signing. Its nonce remains reserved; do not retry it.", null);
    }
    const retired = await intentsRepo.expirePreSendNonceReservation({
      intentId: intent.intentId, sessionId: intent.sessionId, environment: intent.environment,
      accountIndex: intent.accountIndex, apiKeyIndex: intent.apiKeyIndex,
      reservationId: intent.nonceReservationId, nonceValue: intent.nonceValue,
      expectedState: intent.executionState, signerTxHash: intent.signerTxHash,
    });
    return retired === null
      ? report(intent, intent.executionState, "degraded", true,
        "The expired pre-send OCO could not be atomically retired. Its state or evidence changed; keep it blocked and refresh its exact status.", null)
      : report(intent, retired.executionState, "nonce_released_never_submitted", false,
        "The expired pre-send OCO was atomically retired and its exact nonce reservation released. Nothing was submitted or retried.", null);
  }
  const terminal = ["active", "resolved", "rejected"].includes(intent.executionState);
  const deps = defaultLighterOrderRepairDeps();
  let nextNonce: number;
  try {
    nextNonce = (await deps.client.getNextNonce(intent.environment, {
      accountIndex: intent.accountIndex,
      apiKeyIndex: intent.apiKeyIndex,
    })).nonce;
  } catch {
    return report(intent, intent.executionState, "degraded", true,
      "Live Lighter nonce evidence is unavailable. No state changed and the OCO must not be retried.", null);
  }

  if (terminal) {
    const nonceBlockedAfter = await refreshConsumedNonce(intent, nextNonce);
    return report(intent, intent.executionState, "already_terminal", nonceBlockedAfter,
      `OCO intent is already ${intent.executionState}.`, intent.providerOutcomeJson);
  }

  const group = groupFor(intent);
  if (
    intent.stopLossClientOrderIndex !== null
    && intent.takeProfitClientOrderIndex !== null
    && group.orders[0].clientOrderIndex === intent.stopLossClientOrderIndex
    && group.orders[1].clientOrderIndex === intent.takeProfitClientOrderIndex
    && deps.resolvePrivilegedAccountAuth !== undefined
  ) {
    const auth = await deps.resolvePrivilegedAccountAuth(intent.credentialRefJson);
    if (auth !== null) {
      try {
        const [active, inactive, trades] = await Promise.all([
          deps.client.getAccountActiveOrders(intent.environment, { accountIndex: intent.accountIndex, marketId: intent.marketIndex, marketType: "all" }, auth),
          deps.client.getAccountInactiveOrders(intent.environment, { accountIndex: intent.accountIndex, marketId: intent.marketIndex, marketType: "all", limit: 100 }, auth),
          deps.client.getAccountTrades(intent.environment, { accountIndex: intent.accountIndex, limit: 100, sortBy: "timestamp" }, auth),
        ]);
        const outcome = classifyOcoEvidence(intent, group, active.orders, inactive.orders, trades.trades, intent.submittedTxHash ?? "");
        if (outcome.state !== "sequencer_pending") {
          const updated = await intentsRepo.markProviderOutcome({
            intentId: intent.intentId,
            sessionId: intent.sessionId,
            environment: intent.environment,
            state: outcome.state,
            evidence: { ...outcome.evidence, repair: "authenticated_provider_evidence", liveNextNonce: nextNonce },
          });
          const nonceBlockedAfter = await refreshConsumedNonce(intent, nextNonce);
          return report(intent, updated?.executionState ?? intent.executionState, "provider_evidence", nonceBlockedAfter,
            outcome.state === "active"
              ? "Both exact native OCO children are active on Lighter."
              : outcome.state === "resolved"
                ? "One exact OCO child executed and its sibling ended."
                : "Both exact OCO children ended; this position is not protected by the group.", outcome.evidence);
        }
        await intentsRepo.markSequencerPending({
          intentId: intent.intentId,
          sessionId: intent.sessionId,
          environment: intent.environment,
          evidence: outcome.evidence,
        });
      } catch {
        // Nonce facts below remain safe when authenticated evidence is unavailable.
      }
    }
  }

  const nonce = await nonceRepo.find(intent.environment, intent.accountIndex, intent.apiKeyIndex);
  const holds = nonce?.status === "reserved" && nonce.reservationId === `lighter-oco:${intent.intentId}`;
  const reserved = nonce?.reservedNonce === null || nonce?.reservedNonce === undefined
    ? null : Number(nonce.reservedNonce);
  if (holds && reserved !== null && nextNonce > reserved) {
    const nonceBlockedAfter = await refreshConsumedNonce(intent, nextNonce);
    return report(intent, intent.executionState, "awaiting_provider", nonceBlockedAfter,
      "The OCO nonce was consumed, but both exact child outcomes are not yet proven. New signing is unblocked; do not retry this OCO.", null);
  }
  if (
    holds && reserved === nextNonce && intent.sendAttemptStartedAt == null && intent.ambiguousReason !== null
    && NEVER_SUBMITTED.has(intent.ambiguousReason)
  ) {
    const released = await nonceRepo.releaseReservation({
      environment: intent.environment,
      accountIndex: intent.accountIndex,
      apiKeyIndex: intent.apiKeyIndex,
      reservationId: `lighter-oco:${intent.intentId}`,
      providerNonce: nextNonce,
    });
    if (released !== null) {
      const updated = await intentsRepo.markProviderOutcome({
        intentId: intent.intentId,
        sessionId: intent.sessionId,
        environment: intent.environment,
        state: "rejected",
        evidence: { repair: "nonce_release_never_submitted", liveNextNonce: nextNonce },
      });
      return report(intent, updated?.executionState ?? "rejected", "nonce_released_never_submitted", false,
        "The grouped transaction provably never left Vex. Its nonce was released and no OCO protection was created.", null);
    }
  }
  // A grouped send that may have left Vex and never landed. The nonce is still
  // unconsumed, so it has not executed; once its signed expiry has passed it
  // never can. Without this bound it held the account's nonce forever.
  const releaseAt = lighterLostSendReleaseAtMs(intent);
  if (holds && reserved === nextNonce && releaseAt !== null && Date.now() > releaseAt) {
    const released = await nonceRepo.releaseReservation({
      environment: intent.environment,
      accountIndex: intent.accountIndex,
      apiKeyIndex: intent.apiKeyIndex,
      reservationId: `lighter-oco:${intent.intentId}`,
      providerNonce: nextNonce,
    });
    if (released !== null) {
      const updated = await intentsRepo.markProviderOutcome({
        intentId: intent.intentId,
        sessionId: intent.sessionId,
        environment: intent.environment,
        state: "rejected",
        evidence: { repair: "nonce_release_expired_unconsumed", liveNextNonce: nextNonce },
      });
      return report(intent, updated?.executionState ?? "rejected", "nonce_released_expired_unconsumed", false,
        "The signed grouped transaction expired while Lighter had still not consumed its nonce, so it can no longer execute. "
        + "Its nonce was released and no OCO protection was created.", null);
    }
  }
  return report(intent, intent.executionState, "awaiting_provider", holds,
    "Both exact OCO children are not yet proven. Wait and check again; do not retry or claim the position is protected.", null);
}

export async function repairUnresolvedLighterOco(
  environment: LighterEnvironment,
  limit = 5,
): Promise<LighterOcoRepairReport[]> {
  const rows = await intentsRepo.listUnresolved(environment, limit);
  const reports: LighterOcoRepairReport[] = [];
  for (const row of rows) reports.push(await repairLighterOcoIntent(row));
  return reports;
}

const LIGHTER_OCO_BACKGROUND_REPAIR_LIMIT = 5;

export interface LighterOcoRepairSweepReport {
  readonly examined: number;
  readonly advanced: number;
  readonly awaiting: number;
  readonly degraded: number;
  readonly errors: number;
}

/** Resolutions that moved an OCO forward or freed its nonce. */
const LIGHTER_OCO_ADVANCE_RESOLUTIONS: ReadonlySet<LighterOcoRepairReport["resolution"]> = new Set([
  "already_terminal",
  "expired_unsubmitted",
  "provider_evidence",
  "nonce_released_never_submitted",
  "nonce_released_expired_unconsumed",
]);

/**
 * Bounded, unattended recovery for periodic sync - the OCO twin of the order
 * and lifecycle background sweeps. It frees only what provable, expiry-gated
 * facts allow and never signs, submits, or retries; a stuck OCO reservation no
 * one is actively retrying is released here instead of blocking the account.
 */
export async function repairUnresolvedLighterOcoInBackground(
  input: { readonly environment?: LighterEnvironment; readonly limit?: number } = {},
): Promise<LighterOcoRepairSweepReport> {
  const limit = Math.max(
    1,
    Math.min(input.limit ?? LIGHTER_OCO_BACKGROUND_REPAIR_LIMIT, LIGHTER_OCO_BACKGROUND_REPAIR_LIMIT),
  );
  const rows = await intentsRepo.listUnresolved(input.environment, limit);
  let advanced = 0;
  let awaiting = 0;
  let degraded = 0;
  let errors = 0;
  for (const row of rows) {
    try {
      const report = await repairLighterOcoIntent(row);
      if (LIGHTER_OCO_ADVANCE_RESOLUTIONS.has(report.resolution)) advanced += 1;
      else if (report.resolution === "degraded") degraded += 1;
      else awaiting += 1;
    } catch {
      errors += 1;
    }
  }
  return { examined: rows.length, advanced, awaiting, degraded, errors };
}

async function refreshConsumedNonce(intent: LighterOcoExecutionIntentRow, nextNonce: number): Promise<boolean> {
  const row = await nonceRepo.find(intent.environment, intent.accountIndex, intent.apiKeyIndex);
  if (row === null || row.status === "observed") return false;
  const reset = await nonceRepo.recordExecutionObserved({
    environment: intent.environment,
    accountIndex: intent.accountIndex,
    apiKeyIndex: intent.apiKeyIndex,
    nonce: nextNonce,
    publicKey: row.publicKey,
    transactionTime: null,
  });
  return reset === null;
}

function report(
  intent: LighterOcoExecutionIntentRow,
  stateAfter: LighterOcoExecutionIntentRow["executionState"],
  resolution: LighterOcoRepairReport["resolution"],
  nonceBlockedAfter: boolean,
  guidance: string,
  evidence: Record<string, unknown> | null,
): LighterOcoRepairReport {
  return { kind: "oco_protection", intentId: intent.intentId, stateBefore: intent.executionState,
    stateAfter, resolution, nonceBlockedAfter, guidance, evidence };
}
