import {
  getLighterClient,
  type LighterClient,
  type LighterPrivilegedAccountAuth,
} from "@tools/lighter/client.js";
import type {
  LighterAccountAllOrdersStreamMessage,
  LighterAccountAllPositionsStreamMessage,
  LighterAccountAllTradesStreamMessage,
  LighterAccountOrder,
  LighterAccountPosition,
  LighterEnvironment,
  LighterTrade,
} from "@tools/lighter/types.js";
import * as lifecycleIntentsRepo from "@vex-agent/db/repos/lighter-order-lifecycle-intents.js";
import type { LighterOrderLifecycleIntentRow } from "@vex-agent/db/repos/lighter-order-lifecycle-intents.js";
import * as nonceStateRepo from "@vex-agent/db/repos/lighter-nonce-state.js";
import * as orderIntentsRepo from "@vex-agent/db/repos/lighter-order-execution-intents.js";
import {
  defaultLighterAccountStreamReconciliationDeps,
  reconcileLighterAccountStreamMessage,
  type LighterAccountStreamReconciliationDeps,
} from "./account-stream-reconciliation.js";
import { averageFillPrice } from "./order-lifecycle.js";
import { resolveLighterReadOnlyAccountAuth } from "./read-account-auth.js";

export const LIGHTER_LIFECYCLE_REPAIR_EXPIRY_GRACE_MS = 10 * 60 * 1_000;

const NEVER_SUBMITTED_REASONS = new Set([
  "signing_failed_after_nonce_reservation",
  "signed_state_persist_failed",
  "submission_stage_persist_failed",
]);

export type LighterOrderLifecycleRepairResolution =
  | "already_terminal"
  | "provider_evidence"
  | "nonce_consumed_outcome_pending"
  | "nonce_released_never_submitted"
  | "nonce_released_expired_unconsumed"
  | "awaiting_provider"
  | "degraded";

export interface LighterOrderLifecycleRepairReport {
  readonly intentId: string;
  readonly environment: LighterEnvironment;
  readonly accountIndex: number;
  readonly apiKeyIndex: number;
  readonly actionType: LighterOrderLifecycleIntentRow["actionType"];
  readonly marketIndex: number | null;
  readonly providerOrderId: string | null;
  readonly stateBefore: LighterOrderLifecycleIntentRow["executionState"];
  readonly stateAfter: LighterOrderLifecycleIntentRow["executionState"];
  readonly resolution: LighterOrderLifecycleRepairResolution;
  readonly liveNextNonce: number | null;
  readonly reservedNonce: string | null;
  readonly nonceBlockedBefore: boolean;
  readonly nonceBlockedAfter: boolean;
  readonly executedAmount: string | null;
  readonly remainingAmount: string | null;
  readonly averageFillPrice: string | null;
  readonly resultingPosition: Record<string, unknown> | null;
  readonly providerStatus: string | null;
  readonly guidance: string;
}

export interface LighterOrderLifecycleRepairDeps {
  readonly client: Pick<
    LighterClient,
    "getAccount" | "getAccountActiveOrders" | "getAccountInactiveOrders" | "getAccountTrades" | "getNextNonce"
  >;
  readonly lifecycleIntents: Pick<
    typeof lifecycleIntentsRepo,
    "findByIntentIdAnySession" | "listStreamWatchable" | "markStreamEvidence"
  >;
  readonly orderIntents: Pick<typeof orderIntentsRepo, "listStreamWatchable" | "markStreamOutcome">;
  readonly nonceState: Pick<
    typeof nonceStateRepo,
    "find" | "recordExecutionObserved" | "releaseReservation"
  >;
  readonly resolveAuth: (
    environment: LighterEnvironment,
    accountIndex: number,
  ) => Promise<LighterPrivilegedAccountAuth | null>;
  readonly now: () => number;
}

export function defaultLighterOrderLifecycleRepairDeps(): LighterOrderLifecycleRepairDeps {
  return {
    client: getLighterClient(),
    lifecycleIntents: lifecycleIntentsRepo,
    orderIntents: orderIntentsRepo,
    nonceState: nonceStateRepo,
    resolveAuth: resolveLighterReadOnlyAccountAuth,
    now: Date.now,
  };
}

export async function repairUnresolvedLighterOrderLifecycles(
  input: { readonly environment: LighterEnvironment; readonly limit?: number },
  deps: LighterOrderLifecycleRepairDeps = defaultLighterOrderLifecycleRepairDeps(),
): Promise<LighterOrderLifecycleRepairReport[]> {
  const rows = await deps.lifecycleIntents.listStreamWatchable(
    input.environment,
    undefined,
    Math.max(1, Math.min(input.limit ?? 10, 100)),
  );
  const reports: LighterOrderLifecycleRepairReport[] = [];
  for (const row of rows) reports.push(await repairLighterOrderLifecycleIntent(row, deps));
  return reports;
}

export async function repairLighterOrderLifecycleIntent(
  intent: LighterOrderLifecycleIntentRow,
  deps: LighterOrderLifecycleRepairDeps = defaultLighterOrderLifecycleRepairDeps(),
): Promise<LighterOrderLifecycleRepairReport> {
  if (isTerminal(intent.executionState)) {
    return report(intent, intent, "already_terminal", null, null, false, false,
      `Lifecycle action is already ${intent.executionState}; no repair was needed.`);
  }

  let liveNextNonce: number;
  try {
    liveNextNonce = (await deps.client.getNextNonce(intent.environment, {
      accountIndex: intent.accountIndex,
      apiKeyIndex: intent.apiKeyIndex,
    })).nonce;
  } catch {
    return report(intent, intent, "degraded", null, intent.nonceValue, true, true,
      "Live Lighter nextNonce is unavailable. No local state changed and the action was not retried.");
  }

  const providerResolved = await reconcileProviderEvidence(intent, deps);
  if (providerResolved !== null && isTerminal(providerResolved.executionState)) {
    await observeLiveNonce(providerResolved, liveNextNonce, deps);
    return report(intent, providerResolved, "provider_evidence", liveNextNonce, intent.nonceValue, true, false,
      providerGuidance(providerResolved));
  }

  const current = providerResolved ?? intent;
  const nonce = await deps.nonceState.find(current.environment, current.accountIndex, current.apiKeyIndex);
  const holdsReservation = nonce !== null
    && nonce.status === "reserved"
    && nonce.reservationId === current.nonceReservationId
    && nonce.reservedNonce === current.nonceValue;
  if (!holdsReservation || nonce === null) {
    return report(intent, current, "awaiting_provider", liveNextNonce, current.nonceValue, false, false,
      "No exact provider outcome is available yet. The repair path did not sign, submit, or retry anything.");
  }

  const reserved = nonce.reservedNonce === null ? null : Number(nonce.reservedNonce);
  if (reserved === null || !Number.isSafeInteger(reserved)) {
    return report(intent, current, "degraded", liveNextNonce, nonce.reservedNonce, true, true,
      "The durable nonce reservation is malformed. No local state changed.");
  }
  if (liveNextNonce > reserved) {
    await deps.nonceState.recordExecutionObserved({
      environment: current.environment,
      accountIndex: current.accountIndex,
      apiKeyIndex: current.apiKeyIndex,
      nonce: liveNextNonce,
      publicKey: nonce.publicKey,
      transactionTime: null,
    });
    return report(intent, current, "nonce_consumed_outcome_pending", liveNextNonce, nonce.reservedNonce, true, false,
      "Lighter consumed the reserved nonce, so later actions are unblocked, but the exact lifecycle outcome still needs order/trade/position evidence. Do not retry it.");
  }
  if (liveNextNonce < reserved) {
    return report(intent, current, "degraded", liveNextNonce, nonce.reservedNonce, true, true,
      "Lighter nextNonce is behind the locally reserved nonce. Verify the exact environment and account before taking another action.");
  }

  if (neverLeftVex(current)) {
    return releaseUnconsumed(intent, current, deps, liveNextNonce, nonce.reservedNonce,
      "nonce_released_never_submitted",
      "The signed lifecycle transaction provably never reached submission.");
  }
  const releaseAt = current.signerExpiryMs === null
    ? null
    : current.signerExpiryMs + LIGHTER_LIFECYCLE_REPAIR_EXPIRY_GRACE_MS;
  if (releaseAt !== null && deps.now() > releaseAt) {
    return releaseUnconsumed(intent, current, deps, liveNextNonce, nonce.reservedNonce,
      "nonce_released_expired_unconsumed",
      "The signed lifecycle transaction expired while its nonce remained unconsumed.");
  }
  return report(intent, current, "awaiting_provider", liveNextNonce, nonce.reservedNonce, true, true,
    releaseAt === null
      ? "The provider outcome remains ambiguous and no signer expiry is durable. Keep the nonce reserved and do not retry."
      : `The provider outcome remains ambiguous. Keep the nonce reserved and check again after ${new Date(releaseAt).toISOString()}; do not retry.`);
}

async function reconcileProviderEvidence(
  intent: LighterOrderLifecycleIntentRow,
  deps: LighterOrderLifecycleRepairDeps,
): Promise<LighterOrderLifecycleIntentRow | null> {
  let auth: LighterPrivilegedAccountAuth | undefined;
  try {
    auth = (await deps.resolveAuth(intent.environment, intent.accountIndex)) ?? undefined;
    const [active, inactive, trades, accountResponse] = await Promise.all([
      deps.client.getAccountActiveOrders(intent.environment, {
        accountIndex: intent.accountIndex,
        marketId: intent.marketIndex ?? undefined,
        marketType: "all",
      }, auth),
      deps.client.getAccountInactiveOrders(intent.environment, {
        accountIndex: intent.accountIndex,
        marketId: intent.marketIndex ?? undefined,
        marketType: "all",
        limit: 100,
      }, auth),
      deps.client.getAccountTrades(intent.environment, {
        accountIndex: intent.accountIndex,
        limit: 100,
        sortBy: "timestamp",
      }, auth),
      deps.client.getAccount(intent.environment, {
        by: "index",
        value: String(intent.accountIndex),
        activeOnly: false,
      }),
    ]);
    const streamDeps = streamDepsFrom(deps);
    await reconcileLighterAccountStreamMessage(
      intent.environment,
      intent.accountIndex,
      orderFrame(intent.accountIndex, active.orders),
      streamDeps,
    );
    await reconcileLighterAccountStreamMessage(
      intent.environment,
      intent.accountIndex,
      orderFrame(intent.accountIndex, inactive.orders),
      streamDeps,
    );
    await reconcileLighterAccountStreamMessage(
      intent.environment,
      intent.accountIndex,
      tradeFrame(intent.accountIndex, trades.trades),
      streamDeps,
    );
    const accountMatches = accountResponse.accounts.filter((account) =>
      (account.index ?? account.account_index) === intent.accountIndex);
    if (accountMatches.length === 1) {
      const positions = accountMatches[0]?.positions ?? [];
      await reconcileLighterAccountStreamMessage(
        intent.environment,
        intent.accountIndex,
        positionFrame(intent.accountIndex, positions),
        streamDeps,
      );
      let refreshed = await deps.lifecycleIntents.findByIntentIdAnySession(intent.intentId);
      if (
        refreshed !== null
        && refreshed.actionType === "close_position"
        && refreshed.marketIndex !== null
        && !positions.some((position) => position.market_id === refreshed!.marketIndex)
      ) {
        refreshed = await persistFlatPositionSnapshot(refreshed, deps);
      }
      return refreshed;
    }
    return deps.lifecycleIntents.findByIntentIdAnySession(intent.intentId);
  } catch {
    return deps.lifecycleIntents.findByIntentIdAnySession(intent.intentId);
  }
}

async function persistFlatPositionSnapshot(
  intent: LighterOrderLifecycleIntentRow,
  deps: LighterOrderLifecycleRepairDeps,
): Promise<LighterOrderLifecycleIntentRow> {
  const existing = intent.providerOutcomeJson;
  if (existing?.kind !== "lighter_lifecycle_stream_evidence" || asRecord(existing.closeOrder) === null) return intent;
  const evidence = {
    ...existing,
    resultingPosition: null,
    positionSnapshotConfirmed: true,
    positionEvidenceSource: "account_rest_full_snapshot_absence",
    disposition: "closed",
  };
  return await deps.lifecycleIntents.markStreamEvidence({
    intentId: intent.intentId,
    environment: intent.environment,
    accountIndex: intent.accountIndex,
    state: "completed",
    evidence,
  }) ?? intent;
}

async function releaseUnconsumed(
  original: LighterOrderLifecycleIntentRow,
  current: LighterOrderLifecycleIntentRow,
  deps: LighterOrderLifecycleRepairDeps,
  liveNextNonce: number,
  reservedNonce: string | null,
  resolution: "nonce_released_never_submitted" | "nonce_released_expired_unconsumed",
  detail: string,
): Promise<LighterOrderLifecycleRepairReport> {
  if (current.nonceReservationId === null) {
    return report(original, current, "degraded", liveNextNonce, reservedNonce, true, true,
      "The lifecycle reservation identity is missing, so it could not be released.");
  }
  const released = await deps.nonceState.releaseReservation({
    environment: current.environment,
    accountIndex: current.accountIndex,
    apiKeyIndex: current.apiKeyIndex,
    reservationId: current.nonceReservationId,
    providerNonce: liveNextNonce,
  });
  if (released === null) {
    return report(original, current, "degraded", liveNextNonce, reservedNonce, true, true,
      "The exact nonce reservation changed before release. Run status again to refresh it.");
  }
  const resolved = await deps.lifecycleIntents.markStreamEvidence({
    intentId: current.intentId,
    environment: current.environment,
    accountIndex: current.accountIndex,
    state: "rejected",
    evidence: {
      kind: "lighter_lifecycle_repair",
      resolution,
      detail,
      liveNextNonce,
      reservedNonce,
      ambiguousReason: current.ambiguousReason,
    },
  }) ?? current;
  return report(original, resolved, resolution, liveNextNonce, reservedNonce, true, false,
    `${detail} The exact nonce reservation was released; no transaction was retried.`);
}

function streamDepsFrom(deps: LighterOrderLifecycleRepairDeps): LighterAccountStreamReconciliationDeps {
  return {
    ...defaultLighterAccountStreamReconciliationDeps(),
    client: deps.client,
    orderIntents: deps.orderIntents,
    lifecycleIntents: deps.lifecycleIntents,
    nonceState: deps.nonceState,
    orderTransport: "account_orders_resnapshot",
  };
}

function orderFrame(accountIndex: number, orders: readonly LighterAccountOrder[]): LighterAccountAllOrdersStreamMessage {
  const byMarket: Record<string, LighterAccountOrder[]> = {};
  for (const order of orders) (byMarket[String(order.market_index)] ??= []).push(order);
  return { type: "update/account_all_orders", channel: `account_all_orders:${accountIndex}`, orders: byMarket };
}

function tradeFrame(accountIndex: number, trades: readonly LighterTrade[]): LighterAccountAllTradesStreamMessage {
  const byMarket: Record<string, LighterTrade[]> = {};
  for (const trade of trades) (byMarket[String(trade.market_id)] ??= []).push(trade);
  return { type: "update/account_all_trades", channel: `account_all_trades:${accountIndex}`, trades: byMarket };
}

function positionFrame(
  accountIndex: number,
  positions: readonly LighterAccountPosition[],
): LighterAccountAllPositionsStreamMessage {
  const byMarket: Record<string, LighterAccountPosition> = {};
  for (const position of positions) byMarket[String(position.market_id)] = position;
  return {
    type: "subscribed/account_all_positions",
    channel: `account_all_positions:${accountIndex}`,
    positions: byMarket,
    shares: [],
  };
}

async function observeLiveNonce(
  intent: LighterOrderLifecycleIntentRow,
  liveNextNonce: number,
  deps: LighterOrderLifecycleRepairDeps,
): Promise<void> {
  const nonce = await deps.nonceState.find(intent.environment, intent.accountIndex, intent.apiKeyIndex);
  if (nonce === null || nonce.status === "observed") return;
  await deps.nonceState.recordExecutionObserved({
    environment: intent.environment,
    accountIndex: intent.accountIndex,
    apiKeyIndex: intent.apiKeyIndex,
    nonce: liveNextNonce,
    publicKey: nonce.publicKey,
    transactionTime: null,
  });
}

function neverLeftVex(intent: LighterOrderLifecycleIntentRow): boolean {
  return intent.executionState === "signed"
    || (
      intent.executionState === "ambiguous"
      && intent.ambiguousReason !== null
      && NEVER_SUBMITTED_REASONS.has(intent.ambiguousReason)
    );
}

function isTerminal(state: LighterOrderLifecycleIntentRow["executionState"]): boolean {
  return state === "completed" || state === "rejected" || state === "expired";
}

function report(
  before: LighterOrderLifecycleIntentRow,
  after: LighterOrderLifecycleIntentRow,
  resolution: LighterOrderLifecycleRepairResolution,
  liveNextNonce: number | null,
  reservedNonce: string | null,
  nonceBlockedBefore: boolean,
  nonceBlockedAfter: boolean,
  guidance: string,
): LighterOrderLifecycleRepairReport {
  const outcome = projectedOutcome(after.providerOutcomeJson);
  return {
    intentId: after.intentId,
    environment: after.environment,
    accountIndex: after.accountIndex,
    apiKeyIndex: after.apiKeyIndex,
    actionType: after.actionType,
    marketIndex: after.marketIndex,
    providerOrderId: after.providerOrderId,
    stateBefore: before.executionState,
    stateAfter: after.executionState,
    resolution,
    liveNextNonce,
    reservedNonce,
    nonceBlockedBefore,
    nonceBlockedAfter,
    ...outcome,
    guidance,
  };
}

function projectedOutcome(evidence: Record<string, unknown> | null): {
  executedAmount: string | null;
  remainingAmount: string | null;
  averageFillPrice: string | null;
  resultingPosition: Record<string, unknown> | null;
  providerStatus: string | null;
} {
  const closeOrder = asRecord(evidence?.closeOrder)
    ?? asRecord(asRecord(evidence?.order))
    ?? asRecord(evidence?.terminalOrder)
    ?? asRecord(evidence?.modifiedOrder);
  const base = stringField(closeOrder, "filledBaseAmount");
  const quote = stringField(closeOrder, "filledQuoteAmount");
  return {
    executedAmount: base,
    remainingAmount: stringField(closeOrder, "remainingBaseAmount"),
    averageFillPrice: base === null || quote === null ? null : averageFillPrice(base, quote),
    resultingPosition: asRecord(evidence?.resultingPosition),
    providerStatus: stringField(closeOrder, "status"),
  };
}

function providerGuidance(intent: LighterOrderLifecycleIntentRow): string {
  const projected = projectedOutcome(intent.providerOutcomeJson);
  return intent.actionType === "close_position"
    ? `Provider evidence resolved the close as ${intent.providerOutcomeJson?.disposition ?? intent.executionState}; executed ${projected.executedAmount ?? "unknown"}, remaining order amount ${projected.remainingAmount ?? "unknown"}.`
    : `Provider evidence resolved the ${intent.actionType} action as ${intent.executionState}.`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringField(value: Record<string, unknown> | null, key: string): string | null {
  return typeof value?.[key] === "string" ? value[key] as string : null;
}
