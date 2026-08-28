import { buildLighterUnsignedOcoRequest } from "@tools/lighter/oco-order.js";
import type { LighterEnvironment } from "@tools/lighter/types.js";
import * as intentsRepo from "@vex-agent/db/repos/lighter-oco-execution-intents.js";
import type { LighterOcoExecutionIntentRow } from "@vex-agent/db/repos/lighter-oco-execution-intents.js";
import * as nonceRepo from "@vex-agent/db/repos/lighter-nonce-state.js";
import { classifyOcoEvidence } from "./oco-order-execution.js";
import { defaultLighterOrderRepairDeps } from "./order-repair.js";

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
  readonly resolution: "already_terminal" | "provider_evidence" | "awaiting_provider" | "nonce_released_never_submitted" | "degraded";
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
    holds && reserved === nextNonce && intent.ambiguousReason !== null
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
