import {
  getLighterClient,
  type LighterClient,
  type LighterPrivilegedAccountAuth,
} from "@tools/lighter/client.js";
import type { LighterTradingCredentialVaultReference } from "@tools/lighter/trading-credentials.js";
import type { LighterEnvironment } from "@tools/lighter/types.js";
import * as lighterNonceStateRepo from "@vex-agent/db/repos/lighter-nonce-state.js";
import * as lighterOrderExecutionIntentsRepo from "@vex-agent/db/repos/lighter-order-execution-intents.js";
import type { LighterOrderExecutionIntentRow } from "@vex-agent/db/repos/lighter-order-execution-intents.js";
import logger from "@utils/logger.js";
import { lighterOrderNonceReservationId } from "./nonce-reservation.js";
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
  isLighterExpiredUnsubmittedState,
  LIGHTER_EXPIRED_UNSUBMITTED_GUIDANCE,
  LighterOrderEvidenceConflictError,
  lighterOrderEvidenceJson,
  lighterOrderIdFromTrade,
  lighterTradeEvidenceJson,
  stateFromActiveLighterOrder,
  stateFromInactiveLighterOrder,
  type LighterOrderEvidenceScope,
} from "./order-evidence.js";

/**
 * Evidence-only reconciliation for unresolved Lighter order intents.
 *
 * A signed order can be stranded (crash, lost sendTx response, unread
 * sequencer outcome) with its nonce reservation still held, which blocks every
 * later order on the same (environment, account, apiKey). This module resolves
 * those states from provider evidence and provable nonce facts only. It never
 * signs an order and never calls sendTx. When a privileged account-auth resolver
 * is installed (main process only), it derives a short-lived READ-ONLY account
 * auth token from the saved trading key so the order can be classified from
 * account evidence. That token authorizes account reads only; it is never used
 * to sign or submit an order.
 *
 * Release rules are deliberately narrow. A reservation is freed only when:
 *  - the live nextNonce moved past the reserved nonce (the nonce is spent, so
 *    the reservation no longer guards anything), or
 *  - the signed transaction provably never left Vex.
 * Anything else stays reserved with wait guidance instead of a blind retry.
 *
 * Create-order repair must not use the locally approved order expiry as proof
 * that a signed transaction is dead. Ordinary market and limit IOC orders are
 * signed with a nil wire OrderExpiry, so that local timestamp does not
 * constrain the sequencer.
 */

/**
 * Keep the unattended sweep inside Lighter's documented request budget.
 * Each row performs one public nextNonce read (weight 6), so five rows consume
 * at most 30 weight per five-minute run. Authenticated order-history reads are
 * intentionally excluded from the unattended path because inactive-orders is
 * documented at weight 100; users can request the full evidence path through
 * `lighter.order.status` when an outcome still needs classification.
 */
export const LIGHTER_ORDER_BACKGROUND_REPAIR_LIMIT = 5;

/**
 * Candidate window the background sweep rotates through when the first page
 * comes back FULL, so a row that never resolves cannot keep the five oldest
 * slots forever and starve the sixth. Reading the window is one local SQL
 * query; the Lighter request budget is unchanged, because only the selected
 * LIGHTER_ORDER_BACKGROUND_REPAIR_LIMIT rows perform a provider read.
 */
export const LIGHTER_ORDER_BACKGROUND_REPAIR_ROTATION_WINDOW = 100;

/**
 * How long one rotation slot lasts. The starting offset is derived from the
 * wall clock rather than from process memory, so the rotation survives a
 * restart: with W recoverable rows every row is examined within
 * ceil(W / LIGHTER_ORDER_BACKGROUND_REPAIR_LIMIT) periods.
 */
export const LIGHTER_ORDER_BACKGROUND_REPAIR_ROTATION_PERIOD_MS = 5 * 60_000;

/** Ambiguous reasons proving the signed transaction was never sent to Lighter. */
const NEVER_SUBMITTED_AMBIGUOUS_REASONS: ReadonlySet<string> = new Set([
  "signing_failed_after_nonce_reservation",
  "signed_state_persist_failed",
  "submitted_state_persist_failed",
]);

export type LighterOrderRepairResolution =
  | "already_terminal"
  | "expired_unsubmitted"
  | "provider_evidence"
  | "nonce_reset_consumed"
  | "nonce_released_never_submitted"
  | "nonce_released_expired_unconsumed"
  | "awaiting_provider"
  | "degraded";

export interface LighterOrderRepairReport {
  readonly intentId: string;
  readonly sessionId: string;
  readonly environment: LighterEnvironment;
  readonly accountIndex: number;
  readonly apiKeyIndex: number;
  readonly marketIndex: number;
  readonly side: "buy" | "sell";
  readonly clientOrderIndex: string | null;
  readonly stateBefore: LighterOrderExecutionIntentRow["executionState"];
  readonly stateAfter: LighterOrderExecutionIntentRow["executionState"];
  readonly resolution: LighterOrderRepairResolution;
  readonly evidenceSource: "active_order" | "inactive_order" | "account_trade" | null;
  readonly nonceBlockedBefore: boolean;
  readonly nonceBlockedAfter: boolean;
  readonly liveNextNonce: number | null;
  readonly reservedNonce: string | null;
  readonly providerEvidence?: Record<string, unknown> | null;
  readonly guidance: string;
}

export interface LighterOrderRepairSweepReport {
  readonly examined: number;
  /** More recoverable rows exist than this sweep examined. */
  readonly hasMore: boolean;
  /** Rows the rotation could choose from, so the bound reports itself. */
  readonly candidates: number;
  readonly advanced: number;
  readonly awaiting: number;
  readonly degraded: number;
  readonly errors: number;
  readonly reports: readonly LighterOrderRepairReport[];
}

// Derives a short-lived READ-ONLY account auth token from a saved trading key so
// repair can classify orders. Returns null when a token cannot be derived
// (locked vault, signer unavailable, unknown scope).
// Installed by the main process only; agent code never sees key material.
export type LighterRepairPrivilegedAccountAuthResolver = (
  reference: LighterTradingCredentialVaultReference,
) => Promise<LighterPrivilegedAccountAuth | null>;

let configuredPrivilegedAuthResolver: LighterRepairPrivilegedAccountAuthResolver | null = null;

export function configureLighterRepairPrivilegedAccountAuthResolver(
  resolver: LighterRepairPrivilegedAccountAuthResolver | null,
): () => void {
  configuredPrivilegedAuthResolver = resolver;
  return () => {
    if (configuredPrivilegedAuthResolver === resolver) configuredPrivilegedAuthResolver = null;
  };
}

export interface LighterOrderRepairDeps {
  readonly client: Pick<
    LighterClient,
    "getNextNonce" | "getAccountActiveOrders" | "getAccountInactiveOrders" | "getAccountTrades"
  >;
  readonly intents: Pick<
    typeof lighterOrderExecutionIntentsRepo,
    "listUnresolved" | "findByIntentIdAnySession" | "markRepairResolved" | "markEvidenceConflict"
  >;
  readonly nonceState: Pick<
    typeof lighterNonceStateRepo,
    "find" | "releaseReservation" | "recordExecutionObserved"
  >;
  // Optional: derive a read-only account auth token from the saved trading key.
  // Absent in pure agent runtime.
  readonly resolvePrivilegedAccountAuth?: LighterRepairPrivilegedAccountAuthResolver;
  /**
   * The fill observation boundary. Optional for the same reason
   * `resolvePrivilegedAccountAuth` is: a caller that assembles its own deps
   * must not reach the provider or write the ledger by accident. Production
   * arrives through {@link defaultLighterOrderRepairDeps}.
   */
  readonly fills?: LighterFillObservationDeps;
  readonly now: () => number;
}

export function defaultLighterOrderRepairDeps(): LighterOrderRepairDeps {
  return {
    client: getLighterClient(),
    intents: lighterOrderExecutionIntentsRepo,
    nonceState: lighterNonceStateRepo,
    resolvePrivilegedAccountAuth: configuredPrivilegedAuthResolver ?? undefined,
    fills: defaultLighterFillObservationDeps(),
    now: Date.now,
  };
}

export async function repairUnresolvedLighterOrders(
  input: { readonly environment?: LighterEnvironment; readonly limit?: number },
  deps: LighterOrderRepairDeps = defaultLighterOrderRepairDeps(),
): Promise<LighterOrderRepairReport[]> {
  const intents = await deps.intents.listUnresolved(input.environment, input.limit ?? 10);
  const reports: LighterOrderRepairReport[] = [];
  for (const intent of intents) {
    reports.push(await repairLighterOrderIntent(intent, deps));
  }
  return reports;
}

/**
 * Bounded unattended recovery for startup and periodic sync.
 *
 * This deliberately disables account-auth derivation and authenticated order
 * history. It can still unblock a consumed nonce, release a transaction proven
 * never submitted. It cannot classify
 * a live order's terminal outcome; that remains the full, user-driven repair
 * path above (and a future low-cost stream consumer).
 *
 * One malformed or temporarily unavailable intent must not prevent recovery of
 * the other accounts in the sweep. Errors are counted without persisting raw
 * provider responses or credential material.
 */
export async function repairUnresolvedLighterOrdersInBackground(
  input: {
    readonly environment?: LighterEnvironment;
    readonly limit?: number;
  } = {},
  deps: LighterOrderRepairDeps = defaultLighterOrderRepairDeps(),
): Promise<LighterOrderRepairSweepReport> {
  const limit = Math.max(
    1,
    Math.min(input.limit ?? LIGHTER_ORDER_BACKGROUND_REPAIR_LIMIT, LIGHTER_ORDER_BACKGROUND_REPAIR_LIMIT),
  );
  const page = await deps.intents.listUnresolved(input.environment, limit);
  // A page that is not full is the whole recoverable set: everything in it is
  // examined, so no rotation is needed and no extra query is issued.
  let candidates: readonly LighterOrderExecutionIntentRow[] = page;
  if (page.length >= limit) {
    candidates = await deps.intents.listUnresolved(
      input.environment,
      LIGHTER_ORDER_BACKGROUND_REPAIR_ROTATION_WINDOW,
    );
  }
  const intents = selectRotatingSlice(candidates, limit, deps.now());
  const backgroundDeps: LighterOrderRepairDeps = {
    ...deps,
    resolvePrivilegedAccountAuth: undefined,
  };
  const reports: LighterOrderRepairReport[] = [];
  let advanced = 0;
  let awaiting = 0;
  let degraded = 0;
  let errors = 0;

  for (const intent of intents) {
    try {
      const report = await repairLighterOrderIntent(intent, backgroundDeps);
      reports.push(report);
      if (isRepairAdvance(report.resolution)) advanced += 1;
      else if (report.resolution === "awaiting_provider") awaiting += 1;
      else if (report.resolution === "degraded") degraded += 1;
    } catch {
      errors += 1;
    }
  }

  return {
    examined: intents.length,
    hasMore: candidates.length > intents.length,
    candidates: candidates.length,
    advanced,
    awaiting,
    degraded,
    errors,
    reports,
  };
}

/**
 * Fair selection inside the candidate window. Oldest-first is the right order
 * for a first pass, but repeated oldest-first sweeps starve every row after
 * the first `limit`, so the starting point rotates with the wall clock and the
 * window is walked cyclically from there.
 */
export function selectRotatingSlice<T>(
  rows: readonly T[],
  limit: number,
  nowMs: number,
): readonly T[] {
  if (rows.length <= limit) return rows;
  const period = Math.max(1, Math.floor(nowMs / LIGHTER_ORDER_BACKGROUND_REPAIR_ROTATION_PERIOD_MS));
  const start = ((period * limit) % rows.length + rows.length) % rows.length;
  const selected: T[] = [];
  for (let offset = 0; offset < limit; offset += 1) {
    const row = rows[(start + offset) % rows.length];
    if (row !== undefined) selected.push(row);
  }
  return selected;
}

export async function repairLighterOrderIntent(
  intent: LighterOrderExecutionIntentRow,
  deps: LighterOrderRepairDeps = defaultLighterOrderRepairDeps(),
): Promise<LighterOrderRepairReport> {
  const base = baseReport(intent);
  if (isLighterExpiredUnsubmittedState(intent.executionState)) {
    return {
      ...base,
      resolution: "expired_unsubmitted",
      guidance: LIGHTER_EXPIRED_UNSUBMITTED_GUIDANCE,
    };
  }
  if (!isUnresolvedState(intent.executionState)
    && intent.executionState !== "open"
    && intent.executionState !== "partially_filled") {
    // THE SELF-HEALING ARM. An order that settled from ORDER evidence has a
    // terminal outcome and, before the follow-up read existed, no fill in the
    // ledger at all - measured live on 2026-09-08. Repair is the only path
    // that revisits such an intent, so it asks the ledger once and, when the
    // fill is genuinely missing, reads the account's trades once to supply it.
    // Nothing about the durable outcome is touched either way.
    await repairMissingFillLedgerRows(intent, deps);
    return {
      ...base,
      resolution: "already_terminal",
      guidance: `Intent is already in state ${intent.executionState}; nothing to repair.`,
    };
  }

  let liveNextNonce: number | null = null;
  try {
    const next = await deps.client.getNextNonce(intent.environment, {
      accountIndex: intent.accountIndex,
      apiKeyIndex: intent.apiKeyIndex,
    });
    liveNextNonce = next.nonce;
  } catch {
    return {
      ...base,
      resolution: "degraded",
      guidance:
        "Live Lighter nextNonce is unreachable, so nothing can be proven. No local state was changed; retry when the provider is reachable.",
    };
  }

  const evidence = await resolveFromProviderEvidence(intent, deps, liveNextNonce);
  if (evidence !== null) return evidence;

  return resolveFromNonceFacts(intent, deps, liveNextNonce);
}

/**
 * One bounded follow-up read for a TERMINAL intent whose fills never reached
 * the ledger.
 *
 * Bounded three ways, in this order, so a repeated repair costs nothing: the
 * intent must be filled or partially filled (a canceled or rejected order
 * moved no money), the ledger must hold no row for it, and a read-only account
 * token must be derivable. The unattended background sweep passes no auth
 * resolver at all, so it never spends an authenticated request here.
 *
 * Never throws and never changes durable state: this is the ledger catching
 * up with an outcome that is already settled.
 */
async function repairMissingFillLedgerRows(
  intent: LighterOrderExecutionIntentRow,
  deps: LighterOrderRepairDeps,
): Promise<void> {
  if (intent.executionState !== "filled" && intent.executionState !== "partially_filled") return;
  if (deps.fills === undefined || intent.clientOrderIndex === null) return;
  const auth = deps.resolvePrivilegedAccountAuth
    ? await deps.resolvePrivilegedAccountAuth(intent.credentialRefJson)
    : null;
  if (auth === null) return;

  const report = await observeLighterFillsFromAccountTrades({
    intent: {
      intentId: intent.intentId,
      environment: intent.environment,
      accountIndex: intent.accountIndex,
      marketIndex: intent.marketIndex,
      side: intent.side,
      clientOrderIndex: intent.clientOrderIndex,
    },
    authorizedFees: intent.integratorFees ?? null,
    deps: deps.fills,
    read: {
      // Bound through a closure: the production client is a class instance
      // whose method needs its receiver.
      getAccountTrades: (environment, params, tradeAuth) =>
        deps.client.getAccountTrades(environment, params, tradeAuth),
      auth,
      submittedTxHash: intent.submittedTxHash ?? "__vex_repair_no_tx_hash__",
    },
    onlyWhenLedgerAlreadyEmpty: true,
  });
  logger.info("lighter.fill_observation.follow_up", {
    site: "order_repair_already_terminal",
    intentId: intent.intentId,
    state: intent.executionState,
    observed: report.observed,
    recorded: report.recorded,
    duplicates: report.duplicates,
    failed: report.failed,
  });
}

async function resolveFromProviderEvidence(
  intent: LighterOrderExecutionIntentRow,
  deps: LighterOrderRepairDeps,
  liveNextNonce: number,
): Promise<LighterOrderRepairReport | null> {
  const base = baseReport(intent, liveNextNonce);
  if (intent.clientOrderIndex === null) return null;

  // Derive a short-lived read-only account auth token from the saved trading
  // key so one-key setups can still read account evidence. If unavailable,
  // defer to nonce facts.
  const derived = deps.resolvePrivilegedAccountAuth
    ? await deps.resolvePrivilegedAccountAuth(intent.credentialRefJson)
    : null;
  if (derived === null) return null;
  const privilegedAuth: LighterPrivilegedAccountAuth = derived;

  try {
    const scope = exactEvidenceScopeFromIntent(intent);
    if (scope === null) return null;
    const [activeOrders, inactiveOrders, trades] = await Promise.all([
      deps.client.getAccountActiveOrders(intent.environment, {
        accountIndex: intent.accountIndex,
        marketId: intent.marketIndex,
        marketType: "all",
      }, privilegedAuth),
      deps.client.getAccountInactiveOrders(intent.environment, {
        accountIndex: intent.accountIndex,
        marketId: intent.marketIndex,
        marketType: "all",
        limit: 100,
      }, privilegedAuth),
      deps.client.getAccountTrades(intent.environment, {
        accountIndex: intent.accountIndex,
        limit: 100,
        sortBy: "timestamp",
      }, privilegedAuth),
    ]);

    // THE OBSERVATION BOUNDARY, BEFORE THE EVIDENCE BRANCHES. An order row
    // classifies this intent and returns below without ever reaching the trade
    // branch, so a ledger write hung off that branch would silently drop every
    // trade this same read already returned. The ledger is idempotent by
    // canonical identity, so re-observing a trade a previous sweep already
    // recorded writes nothing new.
    if (deps.fills !== undefined) {
      await observeLighterFills({
        intent: {
          intentId: intent.intentId,
          environment: intent.environment,
          accountIndex: intent.accountIndex,
          marketIndex: intent.marketIndex,
          side: intent.side,
          clientOrderIndex: intent.clientOrderIndex,
        },
        trades: matchingLighterTrades(
          trades.trades,
          scope,
          intent.clientOrderIndex,
          intent.submittedTxHash ?? "__vex_repair_no_tx_hash__",
        ),
        authorizedFees: intent.integratorFees ?? null,
        deps: deps.fills,
      });
    }

    const active = findMatchingLighterOrder(activeOrders.orders, scope, intent.clientOrderIndex);
    if (active !== null) {
      return persistEvidence(intent, deps, base, {
        state: stateFromActiveLighterOrder(active),
        source: "active_order",
        providerOrderId: active.order_id,
        providerOrderStatus: active.status ?? null,
        json: lighterOrderEvidenceJson("active_order", active, intent.clientOrderIndex),
      }, liveNextNonce);
    }

    const inactive = findMatchingLighterOrder(inactiveOrders.orders, scope, intent.clientOrderIndex);
    if (inactive !== null) {
      return persistEvidence(intent, deps, base, {
        state: stateFromInactiveLighterOrder(inactive),
        source: "inactive_order",
        providerOrderId: inactive.order_id,
        providerOrderStatus: inactive.status ?? null,
        json: lighterOrderEvidenceJson("inactive_order", inactive, intent.clientOrderIndex),
      }, liveNextNonce);
    }

    const trade = findMatchingLighterTrade(
      trades.trades,
      scope,
      intent.clientOrderIndex,
      intent.submittedTxHash ?? "__vex_repair_no_tx_hash__",
    );
    if (trade !== null) {
      return persistEvidence(intent, deps, base, {
        state: "partially_filled",
        source: "account_trade",
        providerOrderId: lighterOrderIdFromTrade(trade, scope),
        providerOrderStatus: "trade_seen",
        json: lighterTradeEvidenceJson(trade, scope, intent.clientOrderIndex),
      }, liveNextNonce);
    }
    return null;
  } catch (error) {
    if (error instanceof LighterOrderEvidenceConflictError) {
      let conflicted: LighterOrderExecutionIntentRow | null = null;
      try {
        conflicted = await deps.intents.markEvidenceConflict({
          intentId: intent.intentId,
          environment: intent.environment,
          reason: "provider_order_semantic_conflict",
        });
      } catch {
        // The conflict remains explicit in this report even if its durable
        // transition raced or storage is temporarily unavailable.
      }
      return {
        ...base,
        stateAfter: conflicted?.executionState ?? intent.executionState,
        resolution: "degraded",
        guidance:
          `${error.message} `
          + "Treat the outcome as ambiguous, do not resubmit, and investigate the provider evidence before trading on this key.",
      };
    }
    // Authenticated evidence is optional for repair; fall back to nonce facts.
    return null;
  }
}

function exactEvidenceScopeFromIntent(
  intent: LighterOrderExecutionIntentRow,
): LighterOrderEvidenceScope | null {
  const baseDecimals = intent.preSubmitRevalidationJson?.baseDecimals;
  const priceDecimals = intent.preSubmitRevalidationJson?.priceDecimals;
  if (!Number.isInteger(baseDecimals) || !Number.isInteger(priceDecimals)) return null;
  const ordinaryIoc = intent.timeInForce === "immediate-or-cancel"
    && intent.orderType !== "stop-loss"
    && intent.orderType !== "stop-loss-limit"
    && intent.orderType !== "take-profit"
    && intent.orderType !== "take-profit-limit";
  return buildLighterOrderEvidenceScope({
    approved: intent,
    baseDecimals: baseDecimals as number,
    priceDecimals: priceDecimals as number,
    signedOrderExpiryMs: ordinaryIoc ? 0 : intent.orderExpiryMs,
  });
}

async function persistEvidence(
  intent: LighterOrderExecutionIntentRow,
  deps: LighterOrderRepairDeps,
  base: LighterOrderRepairReport,
  outcome: {
    readonly state: lighterOrderExecutionIntentsRepo.LighterProviderOutcomeExecutionState;
    readonly source: "active_order" | "inactive_order" | "account_trade";
    readonly providerOrderId: string | null;
    readonly providerOrderStatus: string | null;
    readonly json: Record<string, unknown>;
  },
  liveNextNonce: number,
): Promise<LighterOrderRepairReport> {
  const resolved = await deps.intents.markRepairResolved({
    intentId: intent.intentId,
    environment: intent.environment,
    state: outcome.state,
    source: outcome.source,
    providerOrderId: outcome.providerOrderId,
    providerOrderStatus: outcome.providerOrderStatus,
    providerOutcomeJson: { ...outcome.json, repair: "provider_evidence", liveNextNonce },
  });
  const nonceBlockedAfter = await refreshNonceAfterEvidence(intent, deps, liveNextNonce);
  return {
    ...base,
    stateAfter: resolved?.executionState ?? intent.executionState,
    resolution: "provider_evidence",
    evidenceSource: outcome.source,
    providerEvidence: outcome.json,
    nonceBlockedAfter,
    guidance:
      outcome.source === "account_trade"
        ? "A matching trade confirms a fill occurred. Its size is not necessarily the total filled; check the exact order history for final status before calling it fully or partially filled. Do not resubmit."
        : `Provider evidence shows the order is ${outcome.state}. Report the actual filled and remaining amounts from providerEvidence, and use averageExecutionPrice rather than the order price.`,
  };
}

/** Provider evidence implies the sequencer accepted the transaction, so the live nextNonce should reset the reservation. */
async function refreshNonceAfterEvidence(
  intent: LighterOrderExecutionIntentRow,
  deps: LighterOrderRepairDeps,
  liveNextNonce: number,
): Promise<boolean> {
  const row = await deps.nonceState.find(
    intent.environment,
    intent.accountIndex,
    intent.apiKeyIndex,
  );
  if (row === null || row.status === "observed") return false;
  const reset = await deps.nonceState.recordExecutionObserved({
    environment: intent.environment,
    accountIndex: intent.accountIndex,
    apiKeyIndex: intent.apiKeyIndex,
    nonce: liveNextNonce,
    publicKey: row.publicKey,
    transactionTime: null,
  });
  return reset === null;
}

async function resolveFromNonceFacts(
  intent: LighterOrderExecutionIntentRow,
  deps: LighterOrderRepairDeps,
  liveNextNonce: number,
): Promise<LighterOrderRepairReport> {
  let base = baseReport(intent, liveNextNonce);
  const row = await deps.nonceState.find(
    intent.environment,
    intent.accountIndex,
    intent.apiKeyIndex,
  );
  const reservationId = lighterOrderNonceReservationId(intent.intentId);
  const holdsReservation =
    row !== null && row.status === "reserved" && row.reservationId === reservationId;

  if (!holdsReservation) {
    return {
      ...base,
      nonceBlockedBefore: false,
      nonceBlockedAfter: false,
      resolution: "awaiting_provider",
      guidance:
        "This intent holds no nonce reservation, and no provider evidence names its client order id yet. "
        + "If a read-only Lighter token is configured, run this again after the provider settles; do not resubmit the order blindly.",
    };
  }

  base = { ...base, nonceBlockedBefore: true, nonceBlockedAfter: true };
  const reservedNonce = row.reservedNonce;
  const reserved = reservedNonce === null ? null : Number(reservedNonce);
  if (reserved !== null && liveNextNonce > reserved) {
    await deps.nonceState.recordExecutionObserved({
      environment: intent.environment,
      accountIndex: intent.accountIndex,
      apiKeyIndex: intent.apiKeyIndex,
      nonce: liveNextNonce,
      publicKey: row.publicKey,
      transactionTime: null,
    });
    return {
      ...base,
      reservedNonce,
      nonceBlockedAfter: false,
      resolution: "nonce_reset_consumed",
      guidance:
        "The reserved nonce was consumed on Lighter, so new orders are unblocked. The order outcome itself is still "
        + "unproven; unlock Vex and run this again so bounded read-only account authorization can be derived from the saved trading credential.",
    };
  }

  if (reserved !== null && liveNextNonce === reserved) {
    if (neverLeftVex(intent)) {
      return releaseAndReject(intent, deps, base, reservedNonce, liveNextNonce, {
        repair: "nonce_release_never_submitted",
        resolution: "nonce_released_never_submitted",
        detail: "The signed transaction never left Vex, so the reserved nonce could not have been consumed.",
      });
    }
    return {
      ...base,
      reservedNonce,
      resolution: "awaiting_provider",
      guidance:
        "The submission may still reach the sequencer, so the nonce stays reserved. The approved preview expiry "
        + "is not a signed sequencer expiry for ordinary IOC create orders. Wait for provider evidence or proof that the "
        + "transaction never left Vex. Do not resubmit the order in the meantime.",
    };
  }

  return {
    ...base,
    reservedNonce,
    resolution: "degraded",
    guidance:
      "The live nextNonce is behind the locally reserved nonce, which should be impossible. No local state was "
      + "changed; verify the environment and account index before trading on this key.",
  };
}

async function releaseAndReject(
  intent: LighterOrderExecutionIntentRow,
  deps: LighterOrderRepairDeps,
  base: LighterOrderRepairReport,
  reservedNonce: string | null,
  liveNextNonce: number,
  detail: {
    readonly repair: string;
    readonly resolution: "nonce_released_never_submitted" | "nonce_released_expired_unconsumed";
    readonly detail: string;
  },
): Promise<LighterOrderRepairReport> {
  const released = await deps.nonceState.releaseReservation({
    environment: intent.environment,
    accountIndex: intent.accountIndex,
    apiKeyIndex: intent.apiKeyIndex,
    reservationId: lighterOrderNonceReservationId(intent.intentId),
    providerNonce: liveNextNonce,
  });
  if (released === null) {
    return {
      ...base,
      reservedNonce,
      resolution: "degraded",
      guidance:
        "The stuck reservation could not be released; its identity no longer matches. Run repair again to re-read the state.",
    };
  }
  const resolved = await deps.intents.markRepairResolved({
    intentId: intent.intentId,
    environment: intent.environment,
    state: "rejected",
    source: "not_found",
    providerOrderId: null,
    providerOrderStatus: null,
    providerOutcomeJson: {
      repair: detail.repair,
      detail: detail.detail,
      liveNextNonce,
      reservedNonce,
      ambiguousReason: intent.ambiguousReason,
      checkedEndpoints: ["nextNonce"],
    },
  });
  return {
    ...base,
    stateAfter: resolved?.executionState ?? intent.executionState,
    reservedNonce,
    nonceBlockedAfter: false,
    resolution: detail.resolution,
    guidance: `${detail.detail} The nonce reservation was released and the intent was marked rejected; new orders on this account and API key are unblocked.`,
  };
}

function neverLeftVex(intent: LighterOrderExecutionIntentRow): boolean {
  if (intent.executionState === "signed") return true;
  return (
    intent.executionState === "ambiguous"
    && intent.ambiguousReason !== null
    && NEVER_SUBMITTED_AMBIGUOUS_REASONS.has(intent.ambiguousReason)
    && intent.submittedAt === null
  );
}

function isUnresolvedState(
  state: LighterOrderExecutionIntentRow["executionState"],
): boolean {
  return (
    lighterOrderExecutionIntentsRepo.LIGHTER_ORDER_UNRESOLVED_EXECUTION_STATES as readonly string[]
  ).includes(state);
}

function isRepairAdvance(resolution: LighterOrderRepairResolution): boolean {
  return (
    resolution === "provider_evidence"
    || resolution === "nonce_reset_consumed"
    || resolution === "nonce_released_never_submitted"
    || resolution === "nonce_released_expired_unconsumed"
  );
}

function baseReport(
  intent: LighterOrderExecutionIntentRow,
  liveNextNonce: number | null = null,
): LighterOrderRepairReport {
  return {
    intentId: intent.intentId,
    sessionId: intent.sessionId,
    environment: intent.environment,
    accountIndex: intent.accountIndex,
    apiKeyIndex: intent.apiKeyIndex,
    marketIndex: intent.marketIndex,
    side: intent.side,
    clientOrderIndex: intent.clientOrderIndex,
    stateBefore: intent.executionState,
    stateAfter: intent.executionState,
    resolution: "awaiting_provider",
    evidenceSource: null,
    nonceBlockedBefore: intent.nonceReservationId !== null,
    nonceBlockedAfter: intent.nonceReservationId !== null,
    liveNextNonce,
    reservedNonce: null,
    providerEvidence: intent.providerOutcomeJson,
    guidance: "",
  };
}
