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
  executeApprovedLighterCancelAll,
  executeApprovedLighterCancelOne,
  executeApprovedLighterClosePosition,
  executeApprovedLighterModifyOrder,
  getConfiguredLighterOrderLifecycleExecutionDeps,
  prepareLighterCancelAll,
  prepareLighterCancelOne,
  prepareLighterClosePosition,
  prepareLighterModifyOrder,
} from "../order-lifecycle.js";
import {
  assertLighterCancelAllApprovalBinding,
  assertLighterCancelOneApprovalBinding,
  assertLighterClosePositionApprovalBinding,
  assertLighterModifyOrderApprovalBinding,
} from "../order-lifecycle-approval-binding.js";

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
    const accountWide = await intentsRepo.findLiveAccountWideCancel({
      environment: environment.value,
      accountIndex: scope.value.accountIndex,
    });
    if (accountWide !== null) {
      return fail(`An account-wide Lighter cancellation already exists in state ${accountWide.executionState}.`);
    }
    const existing = await intentsRepo.findLiveOrderTarget({
      environment: environment.value,
      accountIndex: scope.value.accountIndex,
      marketIndex: marketId.value,
      providerOrderId: orderId.value,
    });
    if (existing !== null) {
      if (existing.actionType === "cancel_one" && existing.approvalStatus === "approval_pending" && existing.matchHash === prepared.matchHash) {
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

  "lighter.order.modify.prepare": async (params, context) => {
    if (!context.sessionId) return fail("Lighter order modification preparation requires a host session id.");
    const environment = readEnvironment(params);
    if (!environment.ok) return fail(environment.reason);
    const marketId = readMarketId(params.marketId);
    if (!marketId.ok) return fail(marketId.reason);
    const orderId = readProviderOrderId(params.orderId);
    if (!orderId.ok) return fail(orderId.reason);
    const totalBaseAmount = readPositiveDecimal(params.totalBaseAmountIn, "totalBaseAmountIn");
    if (!totalBaseAmount.ok) return fail(totalBaseAmount.reason);
    const price = readPositiveDecimal(params.price, "price");
    if (!price.ok) return fail(price.reason);
    const accountIndex = readOptionalAccountIndex(params.accountIndex);
    if (!accountIndex.ok) return fail(accountIndex.reason);
    const scope = resolveScope(environment.value, accountIndex.value);
    if (!scope.ok) return fail(scope.reason);
    const readiness = evaluateLighterTradingCredentialReadiness({
      ...scope.value,
      vaultCredentialId: defaultLighterTradingVaultCredentialId(scope.value),
    });
    if (!readiness.ready) return fail("Managed Lighter trading access is not ready for this account.");
    const client = getLighterClient();
    const auth = await resolveLighterReadOnlyAccountAuth(environment.value, scope.value.accountIndex);
    let prepared;
    try {
      const markets = await client.getMarkets(environment.value, { filter: "all" });
      const market = markets.order_books.find((candidate) => candidate.market_id === marketId.value);
      if (market === undefined || market.status !== "active") {
        return fail("The exact Lighter market is not active in this environment.");
      }
      prepared = await prepareLighterModifyOrder({
        environment: environment.value,
        accountIndex: scope.value.accountIndex,
        apiKeyIndex: scope.value.apiKeyIndex,
        marketIndex: marketId.value,
        providerOrderId: orderId.value,
        requestedBaseAmount: totalBaseAmount.value,
        requestedPrice: price.value,
        sizeDecimals: market.supported_size_decimals,
        priceDecimals: market.supported_price_decimals,
        ...(auth === null ? {} : { auth }),
        client,
      });
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
    const accountWide = await intentsRepo.findLiveAccountWideCancel({
      environment: environment.value,
      accountIndex: scope.value.accountIndex,
    });
    if (accountWide !== null) {
      return fail(`An account-wide Lighter cancellation already exists in state ${accountWide.executionState}.`);
    }
    const existing = await intentsRepo.findLiveOrderTarget({
      environment: environment.value,
      accountIndex: scope.value.accountIndex,
      marketIndex: marketId.value,
      providerOrderId: orderId.value,
    });
    if (existing !== null) {
      if (existing.actionType === "modify" && existing.approvalStatus === "approval_pending" && existing.matchHash === prepared.matchHash) {
        return {
          ...ok(preparedPayload(existing, "approval_prepared_existing")),
          preparedActionFollowUp: modifyFollowUp(existing),
        };
      }
      return fail(`A live Lighter ${existing.actionType} action already exists for provider order ${orderId.value} in state ${existing.executionState}.`);
    }
    const expiresAt = new Date(Date.now() + PREPARE_TTL_MS).toISOString();
    const created = await withSessionControlLock(context.sessionId, (dbClient) =>
      intentsRepo.createApprovalPendingWith(dbClient, {
        intentId: `lighter-lifecycle-${randomUUID()}`,
        sessionId: context.sessionId!,
        matchHash: prepared.matchHash,
        environment: prepared.environment,
        accountIndex: prepared.accountIndex,
        apiKeyIndex: prepared.apiKeyIndex,
        actionType: "modify",
        marketIndex: prepared.marketIndex,
        providerOrderId: prepared.providerOrderId,
        requestedBaseAmountInteger: prepared.requestedBaseAmountInteger,
        requestedPriceInteger: prepared.requestedPriceInteger,
        providerSnapshotJson: {
          ...prepared.snapshot,
          marketSizeDecimals: prepared.sizeDecimals,
          marketPriceDecimals: prepared.priceDecimals,
          requestedBaseAmount: prepared.requestedBaseAmount,
          requestedPrice: prepared.requestedPrice,
        },
        credentialRefJson: readiness.reference,
        expiresAt,
      }),
    );
    if (created === null) return fail("The exact Lighter modification intent could not be persisted.");
    return {
      ...ok(preparedPayload(created, "approval_prepared")),
      preparedActionFollowUp: modifyFollowUp(created),
    };
  },

  "lighter.order.modify": async (params, context) => {
    if (!context.sessionId) return fail("Lighter order modification requires a host session id.");
    const intentId = readIntentId(params.intentId);
    if (!intentId.ok) return fail(intentId.reason);
    if (!context.approved || !context.approvalId) {
      return { success: false, output: "Lighter order modification requires its exact approved Vex approval card.", pendingApproval: true };
    }
    const intent = await intentsRepo.findByIntentId(context.sessionId, intentId.value);
    if (intent === null) return fail(`No Lighter lifecycle intent ${intentId.value} exists in this session.`);
    try {
      await assertLighterModifyOrderApprovalBinding({
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
        reason: "approved modification resumed after expiry",
      });
      return fail("The exact Lighter modification approval expired. Prepare it again from fresh provider state.");
    }
    const approved = await intentsRepo.markApprovalDecision({
      intentId: intent.intentId,
      decision: "approved",
      approvalId: context.approvalId,
      reason: "user approved exact Lighter provider order modification",
    });
    if (approved === null) return fail("The Lighter modification intent has already left approval-pending state.");
    const deps = getConfiguredLighterOrderLifecycleExecutionDeps();
    if (deps === null) return fail("Privileged Lighter modification dependencies are unavailable. Nothing was signed or submitted.");
    try {
      const result = await executeApprovedLighterModifyOrder(approved, deps);
      return ok({
        source: "vex_lighter_order_modify",
        ...result,
        userGuidance: result.status === "modified" || result.status === "modified_then_terminal"
          ? "Tell the user the exact provider order was modified and report effective amount, price, executed amount, remaining amount, average fill, and provider status."
          : "Tell the user modification was submitted but is not yet proven final; reconcile before any retry.",
      });
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
  },

  "lighter.order.cancelAll.prepare": async (params, context) => {
    if (!context.sessionId) return fail("Lighter account-wide cancellation preparation requires a host session id.");
    const environment = readEnvironment(params);
    if (!environment.ok) return fail(environment.reason);
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
      prepared = await prepareLighterCancelAll({
        environment: environment.value,
        accountIndex: scope.value.accountIndex,
        apiKeyIndex: scope.value.apiKeyIndex,
        ...(auth === null ? {} : { auth }),
        client: getLighterClient(),
      });
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
    const existing = await intentsRepo.findAnyLiveOrderMutation({
      environment: environment.value,
      accountIndex: scope.value.accountIndex,
    });
    if (existing !== null) {
      if (existing.actionType === "cancel_all" && existing.approvalStatus === "approval_pending" && existing.matchHash === prepared.matchHash) {
        return {
          ...ok(preparedPayload(existing, "approval_prepared_existing")),
          preparedActionFollowUp: cancelAllFollowUp(existing),
        };
      }
      return fail(`A live Lighter ${existing.actionType} action already exists for this account in state ${existing.executionState}.`);
    }
    const expiresAt = new Date(Date.now() + PREPARE_TTL_MS).toISOString();
    const created = await withSessionControlLock(context.sessionId, (dbClient) =>
      intentsRepo.createApprovalPendingWith(dbClient, {
        intentId: `lighter-lifecycle-${randomUUID()}`,
        sessionId: context.sessionId!,
        matchHash: prepared.matchHash,
        environment: prepared.environment,
        accountIndex: prepared.accountIndex,
        apiKeyIndex: prepared.apiKeyIndex,
        actionType: "cancel_all",
        marketIndex: null,
        providerOrderId: null,
        providerSnapshotJson: {
          orders: prepared.orders,
          orderCount: prepared.orders.length,
          timeInForce: 0,
          cancelAtMs: "0",
        },
        credentialRefJson: readiness.reference,
        expiresAt,
      }),
    );
    if (created === null) return fail("The exact Lighter cancel-all intent could not be persisted.");
    return {
      ...ok(preparedPayload(created, "approval_prepared")),
      preparedActionFollowUp: cancelAllFollowUp(created),
    };
  },

  "lighter.order.cancelAll": async (params, context) => {
    if (!context.sessionId) return fail("Lighter account-wide cancellation requires a host session id.");
    const intentId = readIntentId(params.intentId);
    if (!intentId.ok) return fail(intentId.reason);
    if (!context.approved || !context.approvalId) {
      return { success: false, output: "Lighter cancel-all requires its exact approved Vex approval card.", pendingApproval: true };
    }
    const intent = await intentsRepo.findByIntentId(context.sessionId, intentId.value);
    if (intent === null) return fail(`No Lighter lifecycle intent ${intentId.value} exists in this session.`);
    try {
      await assertLighterCancelAllApprovalBinding({
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
        reason: "approved cancel-all resumed after expiry",
      });
      return fail("The exact Lighter cancel-all approval expired. Prepare it again from fresh provider state.");
    }
    const approved = await intentsRepo.markApprovalDecision({
      intentId: intent.intentId,
      decision: "approved",
      approvalId: context.approvalId,
      reason: "user approved exact account-wide Lighter order cancellation",
    });
    if (approved === null) return fail("The Lighter cancel-all intent has already left approval-pending state.");
    const deps = getConfiguredLighterOrderLifecycleExecutionDeps();
    if (deps === null) return fail("Privileged Lighter cancel-all dependencies are unavailable. Nothing was signed or submitted.");
    try {
      const result = await executeApprovedLighterCancelAll(approved, deps);
      return ok({
        source: "vex_lighter_order_cancel_all",
        ...result,
        userGuidance: result.status === "cancel_all_completed"
          ? "Tell the user the account has no active orders and report each exact order's final status, executed amount, remaining amount, and average fill. Distinguish orders that filled before cancellation."
          : "Tell the user cancel-all was submitted but the exact approved order set is not yet proven terminal; reconcile before any retry.",
      });
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
  },

  "lighter.position.close.prepare": async (params, context) => {
    if (!context.sessionId) return fail("Lighter position-close preparation requires a host session id.");
    const environment = readEnvironment(params);
    if (!environment.ok) return fail(environment.reason);
    const marketId = readMarketId(params.marketId);
    if (!marketId.ok) return fail(marketId.reason);
    const maxSlippageBps = readSlippageBps(params.slippageBps);
    if (!maxSlippageBps.ok) return fail(maxSlippageBps.reason);
    const accountIndex = readOptionalAccountIndex(params.accountIndex);
    if (!accountIndex.ok) return fail(accountIndex.reason);
    const scope = resolveScope(environment.value, accountIndex.value);
    if (!scope.ok) return fail(scope.reason);
    const readiness = evaluateLighterTradingCredentialReadiness({
      ...scope.value,
      vaultCredentialId: defaultLighterTradingVaultCredentialId(scope.value),
    });
    if (!readiness.ready) return fail("Managed Lighter trading access is not ready for this account.");
    let prepared;
    try {
      prepared = await prepareLighterClosePosition({
        environment: environment.value,
        accountIndex: scope.value.accountIndex,
        apiKeyIndex: scope.value.apiKeyIndex,
        marketIndex: marketId.value,
        maxSlippageBps: maxSlippageBps.value,
        client: getLighterClient(),
      });
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
    const existing = await intentsRepo.findAnyLiveOrderMutation({
      environment: environment.value,
      accountIndex: scope.value.accountIndex,
    });
    if (existing !== null) {
      if (existing.actionType === "close_position" && existing.approvalStatus === "approval_pending" && existing.matchHash === prepared.matchHash) {
        return {
          ...ok(preparedPayload(existing, "approval_prepared_existing")),
          preparedActionFollowUp: closePositionFollowUp(existing),
        };
      }
      return fail(`A live Lighter ${existing.actionType} action already exists for this account in state ${existing.executionState}.`);
    }
    const expiresAt = new Date(Date.now() + PREPARE_TTL_MS).toISOString();
    const created = await withSessionControlLock(context.sessionId, (dbClient) =>
      intentsRepo.createApprovalPendingWith(dbClient, {
        intentId: `lighter-lifecycle-${randomUUID()}`,
        sessionId: context.sessionId!,
        matchHash: prepared.matchHash,
        environment: prepared.environment,
        accountIndex: prepared.accountIndex,
        apiKeyIndex: prepared.apiKeyIndex,
        actionType: "close_position",
        marketIndex: prepared.marketIndex,
        providerOrderId: null,
        requestedBaseAmountInteger: prepared.baseAmountInteger,
        requestedPriceInteger: prepared.priceInteger,
        requestedSide: prepared.closingSide,
        reduceOnly: true,
        providerSnapshotJson: {
          position: prepared.position,
          closingSide: prepared.closingSide,
          baseAmount: prepared.baseAmount,
          worstAcceptablePrice: prepared.worstAcceptablePrice,
          maxSlippageBps: prepared.maxSlippageBps,
          marketSizeDecimals: prepared.sizeDecimals,
          marketPriceDecimals: prepared.priceDecimals,
          bookEvidence: prepared.bookEvidence,
          orderType: "market",
          timeInForce: "immediate-or-cancel",
          reduceOnly: true,
        },
        credentialRefJson: readiness.reference,
        expiresAt,
      }),
    );
    if (created === null) return fail("The exact Lighter position-close intent could not be persisted.");
    return {
      ...ok(preparedPayload(created, "approval_prepared")),
      preparedActionFollowUp: closePositionFollowUp(created),
    };
  },

  "lighter.position.close": async (params, context) => {
    if (!context.sessionId) return fail("Lighter position close requires a host session id.");
    const intentId = readIntentId(params.intentId);
    if (!intentId.ok) return fail(intentId.reason);
    if (!context.approved || !context.approvalId) {
      return { success: false, output: "Lighter position close requires its exact approved Vex approval card.", pendingApproval: true };
    }
    const intent = await intentsRepo.findByIntentId(context.sessionId, intentId.value);
    if (intent === null) return fail(`No Lighter lifecycle intent ${intentId.value} exists in this session.`);
    try {
      await assertLighterClosePositionApprovalBinding({
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
        reason: "approved position close resumed after expiry",
      });
      return fail("The exact Lighter position-close approval expired. Prepare it again from fresh position and book state.");
    }
    const approved = await intentsRepo.markApprovalDecision({
      intentId: intent.intentId,
      decision: "approved",
      approvalId: context.approvalId,
      reason: "user approved exact reduce-only Lighter position close",
    });
    if (approved === null) return fail("The Lighter position-close intent has already left approval-pending state.");
    const deps = getConfiguredLighterOrderLifecycleExecutionDeps();
    if (deps === null) return fail("Privileged Lighter close-position dependencies are unavailable. Nothing was signed or submitted.");
    try {
      const result = await executeApprovedLighterClosePosition(approved, deps);
      return ok({
        source: "vex_lighter_position_close",
        ...result,
        userGuidance: result.status === "closed" || result.status === "partially_closed"
          ? "Report the exact fill, average fill price, provider order status, and resulting position. If partially closed, state clearly that no automatic retry occurred."
          : "Tell the user the reduce-only close was submitted but final order and position evidence is pending; reconcile before any retry.",
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

function modifyFollowUp(intent: LighterOrderLifecycleIntentRow): PreparedActionFollowUp {
  const snapshot = intent.providerSnapshotJson;
  const requestedBaseAmount = scalarString(snapshot.requestedBaseAmount);
  const requestedPrice = scalarString(snapshot.requestedPrice);
  const criticalArgs: Record<string, ApprovalPreviewScalar> = {
    toolId: "lighter.order.modify",
    intentId: intent.intentId,
    actionType: "modify",
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
    requestedBaseAmount,
    requestedBaseAmountInteger: intent.requestedBaseAmountInteger,
    requestedPrice,
    requestedPriceInteger: intent.requestedPriceInteger,
    matchHash: intent.matchHash,
    summary: `Modify exact Lighter order ${intent.providerOrderId} on market ${intent.marketIndex} from total ${scalarString(snapshot.initialBaseAmount)} at ${scalarString(snapshot.price)} to total ${requestedBaseAmount} at ${requestedPrice}; ${scalarString(snapshot.filledBaseAmount)} has already filled.`,
  };
  return {
    toolName: "execute_tool",
    args: { toolId: "lighter.order.modify", params: { intentId: intent.intentId } },
    expiresAt: intent.expiresAt,
    approvalPreview: { toolName: "order.modify", namespace: "lighter", criticalArgs },
  };
}

function cancelAllFollowUp(intent: LighterOrderLifecycleIntentRow): PreparedActionFollowUp {
  const orders = Array.isArray(intent.providerSnapshotJson.orders)
    ? intent.providerSnapshotJson.orders as Record<string, unknown>[] : [];
  const orderIdentities = orders.map((order) => `${order.marketIndex}:${order.orderId}`).join(",");
  const criticalArgs: Record<string, ApprovalPreviewScalar> = {
    toolId: "lighter.order.cancelAll",
    intentId: intent.intentId,
    actionType: "cancel_all",
    environment: intent.environment,
    accountIndex: intent.accountIndex,
    apiKeyIndex: intent.apiKeyIndex,
    orderCount: orders.length,
    orderIdentities,
    timeInForce: 0,
    cancelAtMs: "0",
    matchHash: intent.matchHash,
    summary: `Immediately cancel every active Lighter order in account ${intent.accountIndex} on ${intent.environment}. This approval covers exactly ${orders.length} active order${orders.length === 1 ? "" : "s"}; it will be refused if that set changes.`,
  };
  return {
    toolName: "execute_tool",
    args: { toolId: "lighter.order.cancelAll", params: { intentId: intent.intentId } },
    expiresAt: intent.expiresAt,
    approvalPreview: { toolName: "order.cancelAll", namespace: "lighter", criticalArgs },
  };
}

function closePositionFollowUp(intent: LighterOrderLifecycleIntentRow): PreparedActionFollowUp {
  const snapshot = intent.providerSnapshotJson;
  const position = snapshot.position !== null && typeof snapshot.position === "object" && !Array.isArray(snapshot.position)
    ? snapshot.position as Record<string, unknown> : {};
  const criticalArgs: Record<string, ApprovalPreviewScalar> = {
    toolId: "lighter.position.close",
    intentId: intent.intentId,
    actionType: "close_position",
    environment: intent.environment,
    accountIndex: intent.accountIndex,
    apiKeyIndex: intent.apiKeyIndex,
    marketIndex: intent.marketIndex,
    symbol: scalarString(position.symbol),
    positionSide: scalarString(position.side),
    positionAmount: scalarString(position.position),
    averageEntryPrice: scalarString(position.averageEntryPrice),
    closingSide: intent.requestedSide,
    baseAmount: scalarString(snapshot.baseAmount),
    baseAmountInteger: intent.requestedBaseAmountInteger,
    worstAcceptablePrice: scalarString(snapshot.worstAcceptablePrice),
    priceInteger: intent.requestedPriceInteger,
    maxSlippageBps: typeof snapshot.maxSlippageBps === "number" ? snapshot.maxSlippageBps : -1,
    reduceOnly: true,
    orderType: "market",
    timeInForce: "immediate-or-cancel",
    matchHash: intent.matchHash,
    summary: `Close the entire ${scalarString(position.position)} ${scalarString(position.symbol)} ${scalarString(position.side)} position with one reduce-only market IOC ${intent.requestedSide} order. Worst acceptable price ${scalarString(snapshot.worstAcceptablePrice)}; maximum slippage ${String(snapshot.maxSlippageBps)} bps. No automatic retry.`,
  };
  return {
    toolName: "execute_tool",
    args: { toolId: "lighter.position.close", params: { intentId: intent.intentId } },
    expiresAt: intent.expiresAt,
    approvalPreview: { toolName: "position.close", namespace: "lighter", criticalArgs },
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
    message: `Exact Lighter ${intent.actionType === "modify" ? "order modification" : intent.actionType === "cancel_all" ? "account-wide cancellation" : intent.actionType === "close_position" ? "reduce-only position close" : "order cancellation"} prepared; approve the trusted card before anything is signed or submitted.`,
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

function readPositiveDecimal(value: unknown, field: string): { ok: true; value: string } | { ok: false; reason: string } {
  if (typeof value !== "string") return { ok: false, reason: `${field} must be a positive decimal string.` };
  const trimmed = value.trim();
  if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(trimmed) || /^0(?:\.0+)?$/.test(trimmed)) {
    return { ok: false, reason: `${field} must be a positive decimal string.` };
  }
  return { ok: true, value: trimmed };
}

function readSlippageBps(value: unknown): { ok: true; value: number } | { ok: false; reason: string } {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 500
    ? { ok: true, value }
    : { ok: false, reason: "maxSlippageBps must be an explicit integer from 1 through 500." };
}

function scalarString(value: unknown): string { return typeof value === "string" ? value : ""; }
