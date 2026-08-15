import {
  getLighterClient,
  type LighterClient,
  type LighterPrivilegedAccountAuth,
} from "@tools/lighter/client.js";
import { getLighterReadOnlyCredentialStatus } from "@tools/lighter/credentials.js";
import type { LighterTradingCredentialVaultReference } from "@tools/lighter/trading-credentials.js";
import type { LighterEnvironment } from "@tools/lighter/types.js";
import * as lighterNonceStateRepo from "@vex-agent/db/repos/lighter-nonce-state.js";
import * as lighterOrderExecutionIntentsRepo from "@vex-agent/db/repos/lighter-order-execution-intents.js";
import type { LighterOrderExecutionIntentRow } from "@vex-agent/db/repos/lighter-order-execution-intents.js";
import { lighterOrderNonceReservationId } from "./nonce-reservation.js";
import {
  findMatchingLighterOrder,
  findMatchingLighterTrade,
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
 * signs an order and never calls sendTx. Account reads use a read-only token
 * when one is configured; otherwise, if a privileged account-auth resolver is
 * installed (main process only), it derives a short-lived READ-ONLY account
 * auth token from the saved trading key so one-key setups can still classify a
 * stranded order from account evidence. That token authorizes account reads
 * only — it is never used to sign or submit an order.
 *
 * Release rules are deliberately narrow. A reservation is freed only when:
 *  - the live nextNonce moved past the reserved nonce (the nonce is spent, so
 *    the reservation no longer guards anything), or
 *  - the signed transaction provably never left Vex, or
 *  - the order's own expiry (plus grace) has passed while the nonce stayed
 *    unconsumed — Lighter advances nonces on sequencer acceptance, so an
 *    unconsumed nonce after expiry proves the create can no longer execute.
 * Anything else stays reserved with wait guidance instead of a blind retry.
 */

/** Order expiry slack before an unconsumed nonce is treated as proof of death. */
export const LIGHTER_ORDER_REPAIR_EXPIRY_GRACE_MS = 10 * 60 * 1000;

/** Ambiguous reasons proving the signed transaction was never sent to Lighter. */
const NEVER_SUBMITTED_AMBIGUOUS_REASONS: ReadonlySet<string> = new Set([
  "signing_failed_after_nonce_reservation",
  "signed_state_persist_failed",
  "submitted_state_persist_failed",
]);

export type LighterOrderRepairResolution =
  | "already_terminal"
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
  readonly guidance: string;
}

// Derives a short-lived READ-ONLY account auth token from a saved trading key so
// repair can classify orders when no read-only token exists. Returns null when a
// token cannot be derived (locked vault, signer unavailable, unknown scope).
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
    "listUnresolved" | "findByIntentIdAnySession" | "markRepairResolved"
  >;
  readonly nonceState: Pick<
    typeof lighterNonceStateRepo,
    "find" | "releaseReservation" | "recordExecutionObserved"
  >;
  readonly hasReadOnlyCredential: (environment: LighterEnvironment) => boolean;
  // Optional: derive a read-only account auth token from the saved trading key
  // when no read-only token is configured. Absent in pure agent runtime.
  readonly resolvePrivilegedAccountAuth?: LighterRepairPrivilegedAccountAuthResolver;
  readonly now: () => number;
}

export function defaultLighterOrderRepairDeps(): LighterOrderRepairDeps {
  return {
    client: getLighterClient(),
    intents: lighterOrderExecutionIntentsRepo,
    nonceState: lighterNonceStateRepo,
    hasReadOnlyCredential: (environment) =>
      getLighterReadOnlyCredentialStatus(environment).configured,
    resolvePrivilegedAccountAuth: configuredPrivilegedAuthResolver ?? undefined,
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

export async function repairLighterOrderIntent(
  intent: LighterOrderExecutionIntentRow,
  deps: LighterOrderRepairDeps = defaultLighterOrderRepairDeps(),
): Promise<LighterOrderRepairReport> {
  const base = baseReport(intent);
  if (!isUnresolvedState(intent.executionState)) {
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

async function resolveFromProviderEvidence(
  intent: LighterOrderExecutionIntentRow,
  deps: LighterOrderRepairDeps,
  liveNextNonce: number,
): Promise<LighterOrderRepairReport | null> {
  const base = baseReport(intent, liveNextNonce);
  if (intent.clientOrderIndex === null) return null;

  // Prefer a configured read-only token. Otherwise derive a short-lived
  // read-only account auth token from the saved trading key so one-key setups
  // can still read account evidence. If neither is available, defer to nonce facts.
  let privilegedAuth: LighterPrivilegedAccountAuth | undefined;
  if (!deps.hasReadOnlyCredential(intent.environment)) {
    const derived = deps.resolvePrivilegedAccountAuth
      ? await deps.resolvePrivilegedAccountAuth(intent.credentialRefJson)
      : null;
    if (derived === null) return null;
    privilegedAuth = derived;
  }

  const scope: LighterOrderEvidenceScope = {
    accountIndex: intent.accountIndex,
    marketIndex: intent.marketIndex,
    side: intent.side,
  };
  try {
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
  } catch {
    // Authenticated evidence is optional for repair; fall back to nonce facts.
    return null;
  }
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
    nonceBlockedAfter,
    guidance:
      outcome.state === "open" || outcome.state === "partially_filled"
        ? `Provider evidence shows the order is ${outcome.state}; it is live on Lighter, not lost.`
        : `Provider evidence resolved the order as ${outcome.state}.`,
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
        + "unproven; run this again with a read-only token configured to classify it from account evidence.",
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
    const expiryDeadline = intent.orderExpiryMs + LIGHTER_ORDER_REPAIR_EXPIRY_GRACE_MS;
    if (deps.now() > expiryDeadline) {
      return releaseAndReject(intent, deps, base, reservedNonce, liveNextNonce, {
        repair: "nonce_release_expired_unconsumed",
        resolution: "nonce_released_expired_unconsumed",
        detail:
          "The order expiry passed with the reserved nonce unconsumed. Lighter advances nonces on sequencer "
          + "acceptance, so the submitted create can no longer execute.",
      });
    }
    return {
      ...base,
      reservedNonce,
      resolution: "awaiting_provider",
      guidance:
        `The submission may still reach the sequencer, so the nonce stays reserved. Check again after `
        + `${new Date(expiryDeadline).toISOString()}; if the nonce is still unconsumed then, repair will release it. `
        + "Do not resubmit the order in the meantime.",
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
    guidance: "",
  };
}
