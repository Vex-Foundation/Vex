/**
 * `bridge-activity-repair.ts` pure provider status mapping (dossier §2 table)
 * — split out (Card C5, move-only) once the parent file crossed the repo's
 * 500-line cap. See `bridge-activity-repair.ts`'s own module doc for the
 * full R6 correlation / B4 verification-gate design these mappers feed.
 */

import type { BridgeChainFamily } from "@vex-agent/db/repos/agent-activity.js";
import type {
  BridgeObservation,
  KhalaniOrderTx,
  KhalaniOrderView,
  RelayStatusView,
  StoredBridgeCorrelation,
} from "./bridge-activity-repair-contracts.js";

const KHALANI_PENDING: ReadonlySet<string> = new Set(["created", "deposited", "published", "refund_pending"]);

function readTx(
  transactions: Readonly<Record<string, KhalaniOrderTx | undefined>>,
  key: string,
): KhalaniOrderTx | undefined {
  const tx = transactions[key];
  return tx && typeof tx === "object" ? tx : undefined;
}

/** Family-aware identity equality: EVM addresses/hashes are case-insensitive, Solana signatures/mints are case-sensitive base58. */
function idEquals(family: BridgeChainFamily, a: string, b: string): boolean {
  const na = family === "eip155" ? a.trim().toLowerCase() : a.trim();
  const nb = family === "eip155" ? b.trim().toLowerCase() : b.trim();
  return na.length > 0 && na === nb;
}

/**
 * R6 identity correlation shared by both providers' terminal paths. Returns the
 * NAME of the first carried-and-stored field that disagrees, or `null` when every
 * asserted field matches. ONLY fields the payload actually carries AND Vex stored
 * are asserted; anything else is named-degraded (skipped). Route CHAINS are
 * handled by the caller (they map to `chain_mismatch`, a distinct B4 anomaly).
 * The destination RECIPIENT is deliberately NOT asserted — it is not stored, so
 * substituting the source wallet would be wrong (Blocker 7).
 */
function correlateKhalaniIdentity(order: KhalaniOrderView, c: StoredBridgeCorrelation): string | null {
  const originFamily = c.route.fromChainFamily;
  const destFamily = c.route.toChainFamily;
  if (c.providerOrderId && order.id && order.id !== c.providerOrderId) return "order_id";
  if (order.author && !idEquals(originFamily, order.author, c.author)) return "author";
  if (c.depositTxHash && order.depositTxHash && !idEquals(originFamily, order.depositTxHash, c.depositTxHash)) {
    return "deposit_hash";
  }
  if (c.tokenInAddress && order.fromToken && !idEquals(originFamily, order.fromToken, c.tokenInAddress)) {
    return "from_token";
  }
  if (c.tokenOutAddress && order.toToken && !idEquals(destFamily, order.toToken, c.tokenOutAddress)) {
    return "to_token";
  }
  if (c.quoteId && order.quoteId && order.quoteId !== c.quoteId) return "quote_id";
  if (c.routeId && order.routeId && order.routeId !== c.routeId) return "route_id";
  return null;
}

/**
 * Map a Khalani order onto a `BridgeObservation` (dossier §2). Pure. Unknown
 * statuses map to `pending` (never terminalize on an unrecognized status).
 * Terminal statuses (filled/refunded/failed) are first correlated against the
 * stored row (R6) — a route-chain mismatch → `chain_mismatch`, any other identity
 * mismatch → `correlation_mismatch` — BEFORE the on-chain verification runs.
 */
export function mapKhalaniOrderOutcome(order: KhalaniOrderView, c: StoredBridgeCorrelation): BridgeObservation {
  const route = c.route;
  const providerStatus = order.status;
  if (KHALANI_PENDING.has(order.status)) return { kind: "pending", providerStatus };

  const isTerminal = order.status === "filled" || order.status === "refunded" || order.status === "failed";
  if (isTerminal) {
    const chainsMatch = order.fromChainId === route.fromChainId && order.toChainId === route.toChainId;
    if (!chainsMatch) return { kind: "chain_mismatch", providerStatus };
    const mismatch = correlateKhalaniIdentity(order, c);
    if (mismatch) return { kind: "correlation_mismatch", providerStatus, field: mismatch };
  }

  if (order.status === "filled") {
    const fill = readTx(order.transactions, "fill");
    if (!fill?.txHash) return { kind: "filled_no_hash", providerStatus };
    // B4: a fill MUST name its destination chain, and it must be the stored one.
    // A missing fill chain is NOT acceptable for confirm (Blocker 7).
    if (fill.chainId === undefined || fill.chainId !== route.toChainId) {
      return { kind: "chain_mismatch", providerStatus };
    }
    return {
      kind: "confirmable",
      providerStatus,
      fillTxHashes: [fill.txHash],
      destChainId: route.toChainId,
      destChainFamily: route.toChainFamily,
    };
  }

  if (order.status === "refunded") {
    const refund = readTx(order.transactions, "refund");
    return {
      kind: "refunded",
      providerStatus,
      refundTxHash: refund?.txHash ?? null,
      refundChainId: refund?.chainId ?? route.fromChainId,
      refundChainFamily: route.fromChainFamily,
    };
  }

  if (order.status === "failed") return { kind: "failed", providerStatus };

  // Any unrecognized status: stay pending (never terminalize on the unknown).
  return { kind: "pending", providerStatus };
}

const RELAY_PENDING: ReadonlySet<string> = new Set(["waiting", "depositing", "pending", "submitted", "delayed"]);

/** The Relay DESTINATION fill collection, normalized in ONE place: `txHashes[]` first, tolerated legacy `destinationTxHashes[]` fallback. */
export function relayDestinationHashes(status: RelayStatusView): readonly string[] {
  const canonical = status.txHashes;
  if (canonical && canonical.length > 0) return canonical;
  return status.destinationTxHashes ?? [];
}

/**
 * R6 identity correlation for Relay's thin keyless status/v3. Only the origin
 * deposit hash (`inTxHashes[]`) is carried against a stored value — the stored
 * deposit hash must appear in the origin collection. Tokens/author/quote/route
 * ids and the recipient are NOT carried by keyless status/v3 → named-degraded
 * (dossier gap; `/requests/v3` + an API key would carry them). Route chains are
 * handled by the caller.
 */
function correlateRelayIdentity(status: RelayStatusView, c: StoredBridgeCorrelation): string | null {
  const origin = status.inTxHashes;
  if (c.depositTxHash && origin && origin.length > 0) {
    const present = origin.some((h) => typeof h === "string" && idEquals(c.route.fromChainFamily, h, c.depositTxHash!));
    if (!present) return "deposit_hash";
  }
  return null;
}

/**
 * Map a Relay `/intents/status/v3` payload onto a `BridgeObservation` (dossier
 * §2). Pure. Destination hashes are read from `txHashes[]` (tolerating legacy
 * `destinationTxHashes[]`); origin `inTxHashes[]` feeds the R6 deposit
 * correlation; `originChainId`/`destinationChainId` (when present) are the B4
 * route match — when the payload OMITS them the chain check is named-degraded and
 * deferred to the RPC `eth_chainId` echo in `verifyFill`. Keyless Relay refunds
 * carry no reliable refund-hash field (dossier §2/§5 named gap) — the logical row
 * is still terminalized `bridge_refunded`, just without a refund evidence row.
 */
export function mapRelayStatusOutcome(status: RelayStatusView, c: StoredBridgeCorrelation): BridgeObservation {
  const route = c.route;
  const providerStatus = status.status;
  if (RELAY_PENDING.has(status.status)) return { kind: "pending", providerStatus };

  const isTerminal = status.status === "success" || status.status === "refund" || status.status === "failure";
  if (isTerminal) {
    // Route echo present → assert it; absent → named-degraded (RPC echo is the backstop).
    if (status.originChainId !== undefined && status.originChainId !== route.fromChainId) {
      return { kind: "chain_mismatch", providerStatus };
    }
    if (status.destinationChainId !== undefined && status.destinationChainId !== route.toChainId) {
      return { kind: "chain_mismatch", providerStatus };
    }
    const mismatch = correlateRelayIdentity(status, c);
    if (mismatch) return { kind: "correlation_mismatch", providerStatus, field: mismatch };
  }

  if (status.status === "success") {
    const hashes = relayDestinationHashes(status).filter((h) => typeof h === "string" && h.trim().length > 0);
    if (hashes.length === 0) return { kind: "filled_no_hash", providerStatus };
    return {
      kind: "confirmable",
      providerStatus,
      fillTxHashes: hashes,
      destChainId: route.toChainId,
      destChainFamily: route.toChainFamily,
    };
  }

  if (status.status === "refund") {
    return {
      kind: "refunded",
      providerStatus,
      // Keyless Relay exposes no reliable refund-hash field (named gap) — terminalize without evidence.
      refundTxHash: null,
      refundChainId: route.fromChainId,
      refundChainFamily: route.fromChainFamily,
    };
  }

  if (status.status === "failure") return { kind: "failed", providerStatus };

  return { kind: "pending", providerStatus };
}
