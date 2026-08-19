import { randomUUID } from "node:crypto";

import {
  defaultLighterTradingVaultCredentialId,
  evaluateLighterTradingCredentialReadiness,
} from "@tools/lighter/trading-credentials.js";
import * as intentsRepo from "@vex-agent/db/repos/lighter-order-lifecycle-intents.js";
import type { LighterOrderLifecycleIntentRow } from "@vex-agent/db/repos/lighter-order-lifecycle-intents.js";
import { withSessionControlLock } from "@vex-agent/engine/runtime/lease-and-status/session-control-lock.js";
import type { ApprovalPreviewScalar, PreparedActionFollowUp } from "../../../types.js";
import type { ProtocolHandler } from "../../types.js";
import { fail, ok } from "../../handler-helpers.js";
import { getLighterClient } from "@tools/lighter/client.js";
import { readEnvironment } from "../params.js";
import { resolveLighterReadOnlyAccountAuth } from "../read-account-auth.js";
import {
  listLighterTradingCredentialScopes,
  resolveSavedLighterTradingCredentialScope,
  type LighterSavedTradingCredentialScope,
} from "../trading-credential-scope.js";
import {
  executeApprovedLighterCancelOne,
  getConfiguredLighterOrderLifecycleExecutionDeps,
  prepareLighterCancelOne,
} from "../order-lifecycle.js";
import { assertLighterCancelOneApprovalBinding } from "../order-lifecycle-approval-binding.js";

const PREPARE_TTL_MS = 2 * 60_000;

export const LIGHTER_ORDER_LIFECYCLE_HANDLERS: Record<string, ProtocolHandler> = {
  "lighter.order.cancel.prepare": async (params, context) => {
    if (!context.sessionId) return fail("Lighter order cancellation preparation requires a host session id.");
    const environment = readEnvironment(params);
    if (!environment.ok) return fail(environment.reason);
    const marketId = readMarketId(params.marketId);
    if (!marketId.ok) return fail(marketId.reason);
    const orderId = readProviderOrderId(params.orderId);
    if (!orderId.ok) return fail(orderId.reason);
    const accountIndex = readOptionalAccountIndex(params.accountIndex);
    if (!accountIndex.ok) return fail(accountIndex.reason);
    const scope = resolveScope(environment.value, accountIndex.value);
    if (!scope.ok) return fail(scope.reason);
    const readiness = evaluateLighterTradingCredentialReadiness({
      ...scope.value,
      vaultCredentialId: defaultLighterTradingVaultCredentialId(scope.value),
    });
    if (!readiness.ready) return fail("Managed Lighter trading access is not ready for this account.");
    const auth = await resolveLighterReadOnlyAccountAuth(environment.value, scope.value.accountIndex);
    let prepared;
    try {
      prepared = await prepareLighterCancelOne({
        environment: environment.value,
        accountIndex: scope.value.accountIndex,
        apiKeyIndex: scope.value.apiKeyIndex,
        marketIndex: marketId.value,
        providerOrderId: orderId.value,
        ...(auth === null ? {} : { auth }),
        client: getLighterClient(),
      });
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
    const existing = await intentsRepo.findLiveTarget({
      environment: environment.value,
      accountIndex: scope.value.accountIndex,
      actionType: "cancel_one",
      marketIndex: marketId.value,
      providerOrderId: orderId.value,
    });
    if (existing !== null) {
      if (existing.approvalStatus === "approval_pending" && existing.matchHash === prepared.matchHash) {
        return {
          ...ok(preparedPayload(existing, "approval_prepared_existing")),
          preparedActionFollowUp: cancelFollowUp(existing),
        };
      }
      return fail(`A live Lighter cancellation already exists for provider order ${orderId.value} in state ${existing.executionState}.`);
    }
    const expiresAt = new Date(Date.now() + PREPARE_TTL_MS).toISOString();
    const created = await withSessionControlLock(context.sessionId, (client) =>
      intentsRepo.createApprovalPendingWith(client, {
        intentId: `lighter-lifecycle-${randomUUID()}`,
        sessionId: context.sessionId!,
        matchHash: prepared.matchHash,
        environment: prepared.environment,
        accountIndex: prepared.accountIndex,
        apiKeyIndex: prepared.apiKeyIndex,
        actionType: "cancel_one",
        marketIndex: prepared.marketIndex,
        providerOrderId: prepared.providerOrderId,
        providerSnapshotJson: { ...prepared.snapshot },
        credentialRefJson: readiness.reference,
        expiresAt,
      }),
    );
    if (created === null) return fail("The exact Lighter cancellation intent could not be persisted.");
    return {
      ...ok(preparedPayload(created, "approval_prepared")),
      preparedActionFollowUp: cancelFollowUp(created),
    };
  },

  "lighter.order.cancel": async (params, context) => {
    if (!context.sessionId) return fail("Lighter order cancellation requires a host session id.");
    const intentId = readIntentId(params.intentId);
    if (!intentId.ok) return fail(intentId.reason);
    if (!context.approved || !context.approvalId) {
      return { success: false, output: "Lighter order cancellation requires its exact approved Vex approval card.", pendingApproval: true };
    }
    const intent = await intentsRepo.findByIntentId(context.sessionId, intentId.value);
    if (intent === null) return fail(`No Lighter lifecycle intent ${intentId.value} exists in this session.`);
    try {
      await assertLighterCancelOneApprovalBinding({
        approvalId: context.approvalId,
        sessionId: context.sessionId,
        intent,
      });
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
    if (Date.parse(intent.expiresAt) <= Date.now()) {
      await intentsRepo.markApprovalDecision({
        intentId: intent.intentId,
        decision: "expired",
        approvalId: context.approvalId,
        reason: "approved cancellation resumed after expiry",
      });
      return fail("The exact Lighter cancellation approval expired. Prepare it again from fresh provider state.");
    }
    const approved = await intentsRepo.markApprovalDecision({
      intentId: intent.intentId,
      decision: "approved",
      approvalId: context.approvalId,
      reason: "user approved exact Lighter provider order cancellation",
    });
    if (approved === null) return fail("The Lighter cancellation intent has already left approval-pending state.");
    const deps = getConfiguredLighterOrderLifecycleExecutionDeps();
    if (deps === null) return fail("Privileged Lighter cancellation dependencies are unavailable. Nothing was signed or submitted.");
    try {
      const result = await executeApprovedLighterCancelOne(approved, deps);
      return ok({
        source: "vex_lighter_order_cancel",
        ...result,
        userGuidance: result.status === "canceled"
          ? "Tell the user the exact provider order was canceled and report any executed amount, remaining amount, and average fill."
          : "Tell the user cancellation was submitted but is not yet proven final; reconcile before any retry.",
      });
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
  },
};

function cancelFollowUp(intent: LighterOrderLifecycleIntentRow): PreparedActionFollowUp {
  const snapshot = intent.providerSnapshotJson;
  const criticalArgs: Record<string, ApprovalPreviewScalar> = {
    toolId: "lighter.order.cancel",
    intentId: intent.intentId,
    actionType: "cancel_one",
    environment: intent.environment,
    accountIndex: intent.accountIndex,
    apiKeyIndex: intent.apiKeyIndex,
    marketIndex: intent.marketIndex,
    providerOrderId: intent.providerOrderId,
    clientOrderId: scalarString(snapshot.clientOrderId),
    side: scalarString(snapshot.side),
    orderType: scalarString(snapshot.type),
    timeInForce: scalarString(snapshot.timeInForce),
    price: scalarString(snapshot.price),
    initialBaseAmount: scalarString(snapshot.initialBaseAmount),
    remainingBaseAmount: scalarString(snapshot.remainingBaseAmount),
    filledBaseAmount: scalarString(snapshot.filledBaseAmount),
    matchHash: intent.matchHash,
    summary: `Cancel exact Lighter order ${intent.providerOrderId} on market ${intent.marketIndex}; ${scalarString(snapshot.remainingBaseAmount)} remains open and ${scalarString(snapshot.filledBaseAmount)} has filled.`,
  };
  return {
    toolName: "execute_tool",
    args: { toolId: "lighter.order.cancel", params: { intentId: intent.intentId } },
    expiresAt: intent.expiresAt,
    approvalPreview: { toolName: "order.cancel", namespace: "lighter", criticalArgs },
  };
}

function preparedPayload(intent: LighterOrderLifecycleIntentRow, status: string): Record<string, unknown> {
  return {
    source: "vex_lighter_order_lifecycle_intent",
    status,
    intentId: intent.intentId,
    actionType: intent.actionType,
    environment: intent.environment,
    accountIndex: intent.accountIndex,
    marketIndex: intent.marketIndex,
    providerOrderId: intent.providerOrderId,
    approvalStatus: intent.approvalStatus,
    executionState: intent.executionState,
    expiresAt: intent.expiresAt,
    message: "Exact Lighter order cancellation prepared; approve the trusted card before anything is signed or submitted.",
  };
}

function resolveScope(environment: "core" | "rhc", accountIndex: number | null):
  | { readonly ok: true; readonly value: LighterSavedTradingCredentialScope }
  | { readonly ok: false; readonly reason: string } {
  if (accountIndex !== null) {
    const scope = resolveSavedLighterTradingCredentialScope(environment, accountIndex);
    return scope === null
      ? { ok: false, reason: "No managed Lighter trading credential exists for that account." }
      : { ok: true, value: scope };
  }
  const scopes = listLighterTradingCredentialScopes(environment);
  if (scopes.length !== 1) {
    return { ok: false, reason: scopes.length === 0
      ? "No managed Lighter account exists in this environment."
      : "More than one managed Lighter account exists; specify accountIndex." };
  }
  return { ok: true, value: scopes[0]! };
}

function readMarketId(value: unknown): { ok: true; value: number } | { ok: false; reason: string } {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 65_535
    ? { ok: true, value }
    : { ok: false, reason: "marketId must be an integer from 0 through 65535." };
}

function readOptionalAccountIndex(value: unknown): { ok: true; value: number | null } | { ok: false; reason: string } {
  if (value === undefined) return { ok: true, value: null };
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? { ok: true, value }
    : { ok: false, reason: "accountIndex must be a safe non-negative integer." };
}

function readProviderOrderId(value: unknown): { ok: true; value: string } | { ok: false; reason: string } {
  if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value) || BigInt(value) > (1n << 60n) - 1n) {
    return { ok: false, reason: "orderId must be the exact positive decimal provider order_id string." };
  }
  return { ok: true, value };
}

function readIntentId(value: unknown): { ok: true; value: string } | { ok: false; reason: string } {
  return typeof value === "string" && /^lighter-lifecycle-[0-9a-f-]{36}$/i.test(value)
    ? { ok: true, value }
    : { ok: false, reason: "intentId must be the exact prepared Lighter lifecycle intent id." };
}

function scalarString(value: unknown): string { return typeof value === "string" ? value : ""; }
