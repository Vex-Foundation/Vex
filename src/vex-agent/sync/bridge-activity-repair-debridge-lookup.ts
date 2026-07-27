/**
 * deBridge (DLN) destination fill-hash recovery for the bridge repair sweep
 * (Card F2).
 *
 * WHY THIS EXISTS: a Khalani order routed through DeBridge (`routeId:
 * "DeBridge"`, `type: "external-intent-router"`) reaches `status: "filled"`
 * carrying `transactions = {deposit}` and nothing else — no fill hash under any
 * field (live capture 2026-07-26, executions 191/216/229). Without the hash the
 * B4 verifier has nothing to prove, so the logical row sits `pending` forever.
 * The hash does exist — in deBridge's own stats API, keyed by the Khalani
 * order's `externalOrderId` (the DLN order id).
 *
 * WHY IT IS PARANOID: reading it means trusting a THIRD provider's claim about
 * where our money went. So the recovered hash is admitted only when the DLN
 * record proves it settles OUR destination:
 *
 *   - the returned `orderId` is EXACTLY the id we asked for (no echo, no trust);
 *   - `state` is one of the settled states (`Fulfilled`/`SentUnlock`/`ClaimedUnlock`);
 *   - the take chain is our stored destination — across the two providers'
 *     DIFFERENT Solana numbering (deBridge 7565164 ↔ our stored Khalani
 *     20011000000). Relay's 792703809 is a THIRD numbering and is rejected;
 *   - the take token, the receiver, and `finalAmount` match our expectations
 *     exactly (no tolerance — an absolute equality on raw units);
 *   - the hash's SYNTAX matches the destination family.
 *
 * `finalAmount` is the amount compared, never `actualFulfillAmount`: the latter
 * is legitimately `null` on Solana fulfilments, so requiring it would refuse
 * every good Solana recovery.
 *
 * ANY doubt returns `null` and the row stays pending — including an expectation
 * Vex never recorded. A recording gap is never a reason to relax confirmation.
 * Nothing here confirms anything: a recovered hash still goes through the
 * unchanged `verifyBridgeLegOnChain` proof before the row moves.
 *
 * TRANSPORT: a FIXED host (no provider-supplied base), an `externalOrderId`
 * validated against `0x`+64 hex BEFORE it is interpolated into the URL (it comes
 * from a provider payload — SSRF guard), redirects refused, 15s timeout, no auth
 * headers, and no throw out of the sweep batch.
 *
 * Fixtures: `src/__tests__/vex-agent/sync/fixtures/debridge-fill-hash/`.
 */

import { z } from "zod";

import { summarizeProtocolError } from "@vex-agent/tools/protocols/runtime/errors.js";
import logger from "@utils/logger.js";
import type { BridgeChainFamily } from "@vex-agent/db/repos/agent-activity.js";
import type { DebridgeFillHashLookup } from "./bridge-activity-repair-contracts.js";
import { bridgeIdentityEquals } from "./bridge-activity-repair-status-map.js";

/** deBridge's public stats API. A CONSTANT — never assembled from provider input. */
export const DEBRIDGE_STATS_BASE_URL = "https://stats-api.dln.trade";

/** A DLN order id: `0x` + 64 hex. Validated BEFORE URL interpolation (provider-supplied → SSRF guard). */
const DLN_ORDER_ID_PATTERN = /^0x[0-9a-fA-F]{64}$/;

/** Destination hash syntax. Co-owned with `./bridge-activity-repair-verification.ts`, which re-checks it before probing. */
const EVM_TX_HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const SOLANA_SIGNATURE_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{43,90}$/;

/** Raw integer amount (no decimal point, no sign) — the only form we will compare. */
const RAW_AMOUNT_PATTERN = /^\d+$/;

/** DLN states in which a destination fulfilment has provably happened. Anything else → refuse. */
const SETTLED_DLN_STATES: ReadonlySet<string> = new Set(["Fulfilled", "SentUnlock", "ClaimedUnlock"]);

/** deBridge's own Solana chain id. Our logical rows store Khalani's `20011000000` for the same chain. */
const DEBRIDGE_SOLANA_CHAIN_ID = 7565164;
/** Khalani's Solana chain id — the value a Khalani-protocol logical row stores. */
const KHALANI_SOLANA_CHAIN_ID = 20011000000;
/** Relay's Solana chain id. A THIRD numbering; never a valid deBridge destination. */
const RELAY_SOLANA_CHAIN_ID = 792703809;

// ── Boundary schema (untrusted provider payload → typed) ─────────────────────

/** Every DLN identity travels as `{stringValue, bytesValue|Base64Value, bytesArrayValue}`; only `stringValue` is consumed. */
const dlnIdentitySchema = z.object({ stringValue: z.string().min(1) });

const dlnChainIdSchema = z.object({ bigIntegerValue: z.number().int().positive() });

const dlnTakeOfferSchema = z.object({
  chainId: dlnChainIdSchema,
  tokenAddress: dlnIdentitySchema,
  /** The amount actually owed on the destination. `actualFulfillAmount` is display-only and null on Solana. */
  finalAmount: z.object({ stringValue: z.string().regex(RAW_AMOUNT_PATTERN) }),
});

/**
 * The give (source) side is validated for SHAPE but not compared: the lookup
 * contract carries destination expectations only. A payload missing it is a
 * different resource than the order record we asked for → malformed, refused.
 */
const dlnGiveOfferSchema = z.object({
  chainId: dlnChainIdSchema,
  tokenAddress: dlnIdentitySchema,
});

const dlnOrderSchema = z.object({
  orderId: dlnIdentitySchema,
  state: z.string().min(1),
  receiverDst: dlnIdentitySchema,
  giveOfferWithMetadata: dlnGiveOfferSchema,
  takeOfferWithMetadata: dlnTakeOfferSchema,
  fulfilledDstEventMetadata: z.object({ transactionHash: dlnIdentitySchema }),
});

// ── Pure resolution (validate + correlate) ───────────────────────────────────

/**
 * Validate an untrusted DLN order payload and return its destination fill hash
 * ONLY when every expectation in `expected` is proven. `null` otherwise, with a
 * named reason logged (reason CODES and ids only — never raw provider values).
 */
export function resolveDebridgeFillHash(
  raw: unknown,
  expected: DebridgeFillHashLookup,
): { txHash: string } | null {
  const missing = unrecordedExpectation(expected);
  if (missing) {
    logger.warn("bridge.repair.debridge_expectation_unrecorded", {
      externalOrderId: expected.externalOrderId,
      field: missing,
    });
    return null;
  }

  // State first: an order that was never fulfilled has no fulfilment block at
  // all, and "not settled yet" is a far more useful reason than "malformed".
  const state = z.object({ state: z.string() }).safeParse(raw);
  if (!state.success || !SETTLED_DLN_STATES.has(state.data.state)) {
    return refuse(expected, "unsettled_or_unknown_state");
  }

  const parsed = dlnOrderSchema.safeParse(raw);
  if (!parsed.success) return refuse(expected, "malformed_payload");
  const order = parsed.data;

  // The record must be the one we asked for — a DLN order id is hex, so compare
  // case-insensitively, but never accept a substring or a different id.
  if (order.orderId.stringValue.trim().toLowerCase() !== expected.externalOrderId.trim().toLowerCase()) {
    return refuse(expected, "order_id_echo_mismatch");
  }

  const takeChainId = order.takeOfferWithMetadata.chainId.bigIntegerValue;
  if (!takeChainMatchesExpected(takeChainId, expected.expectedDestChainId)) {
    return refuse(expected, "dest_chain_mismatch");
  }

  const family = expected.expectedDestChainFamily;
  if (
    expected.expectedTokenOutAddress === null
    || !bridgeIdentityEquals(family, order.takeOfferWithMetadata.tokenAddress.stringValue, expected.expectedTokenOutAddress)
  ) {
    return refuse(expected, "dest_token_mismatch");
  }

  if (
    expected.expectedRecipient === null
    || !bridgeIdentityEquals(family, order.receiverDst.stringValue, expected.expectedRecipient)
  ) {
    return refuse(expected, "recipient_mismatch");
  }

  if (!rawAmountsEqual(order.takeOfferWithMetadata.finalAmount.stringValue, expected.expectedDestAmount)) {
    return refuse(expected, "dest_amount_mismatch");
  }

  const txHash = order.fulfilledDstEventMetadata.transactionHash.stringValue.trim();
  if (!fillHashMatchesFamily(txHash, family)) return refuse(expected, "fill_hash_family_mismatch");

  return { txHash };
}

/**
 * Fetch and resolve the destination fill hash for one DLN order. Never throws:
 * every failure path (bad id, unrecorded expectation, transport error, non-200,
 * non-JSON body, unproven record) returns `null` so one bad row cannot abort the
 * sweep batch.
 */
export async function fetchDebridgeFillHash(
  input: DebridgeFillHashLookup,
): Promise<{ txHash: string } | null> {
  // SSRF guard: `externalOrderId` arrives inside a provider payload, so its
  // syntax is proven BEFORE it can influence a URL. `encodeURIComponent` is the
  // second defense, not the first.
  if (!DLN_ORDER_ID_PATTERN.test(input.externalOrderId)) {
    logger.warn("bridge.repair.debridge_lookup_rejected", { reason: "malformed_external_order_id" });
    return null;
  }

  const missing = unrecordedExpectation(input);
  if (missing) {
    // Refuse before spending a request we could never accept the answer to.
    logger.warn("bridge.repair.debridge_expectation_unrecorded", {
      externalOrderId: input.externalOrderId,
      field: missing,
    });
    return null;
  }

  let payload: unknown;
  try {
    const response = await fetch(
      `${DEBRIDGE_STATS_BASE_URL}/api/Orders/${encodeURIComponent(input.externalOrderId)}`,
      {
        method: "GET",
        headers: { accept: "application/json" },
        // A 3xx to a re-pointed (possibly private) host is refused, not followed.
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (!response.ok) {
      logger.warn("bridge.repair.debridge_lookup_rejected", {
        externalOrderId: input.externalOrderId,
        reason: "http_status",
        status: response.status,
      });
      return null;
    }
    payload = await response.json();
  } catch (err) {
    logger.warn("bridge.repair.debridge_lookup_failed", {
      externalOrderId: input.externalOrderId,
      error: summarizeProtocolError(err).message,
    });
    return null;
  }

  return resolveDebridgeFillHash(payload, input);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** The NAME of the first expectation Vex never recorded, or `null` when all three are present. */
function unrecordedExpectation(expected: DebridgeFillHashLookup): string | null {
  if (expected.expectedTokenOutAddress === null) return "expectedTokenOutAddress";
  if (expected.expectedRecipient === null) return "expectedRecipient";
  if (expected.expectedDestAmount === null) return "expectedDestAmount";
  return null;
}

function refuse(expected: DebridgeFillHashLookup, reason: string): null {
  logger.warn("bridge.repair.debridge_lookup_rejected", {
    externalOrderId: expected.externalOrderId,
    reason,
  });
  return null;
}

/**
 * The take chain must be our stored destination, pinned in BOTH directions
 * across the providers' different Solana numbering: deBridge's 7565164 satisfies
 * a stored Khalani 20011000000 and nothing else, and a stored Solana destination
 * accepts nothing but deBridge's Solana id. Relay's 792703809 is a third
 * numbering that a deBridge order can never carry — reject it explicitly rather
 * than let it fall through a generic equality.
 */
function takeChainMatchesExpected(takeChainId: number, expectedDestChainId: number): boolean {
  if (expectedDestChainId === RELAY_SOLANA_CHAIN_ID || takeChainId === RELAY_SOLANA_CHAIN_ID) return false;
  if (expectedDestChainId === KHALANI_SOLANA_CHAIN_ID) return takeChainId === DEBRIDGE_SOLANA_CHAIN_ID;
  if (takeChainId === DEBRIDGE_SOLANA_CHAIN_ID) return false;
  return takeChainId === expectedDestChainId;
}

/**
 * Raw-unit equality, EXACT (rule: a tolerance on a money comparison must never
 * scale with trade size — here there is no tolerance at all). Compared as
 * integers so `"0022073193"` and `"22073193"` agree, and anything that is not a
 * plain non-negative integer is refused rather than coerced.
 */
function rawAmountsEqual(providerAmount: string, expectedAmount: string | null): boolean {
  if (expectedAmount === null) return false;
  const expectedRaw = expectedAmount.trim();
  if (!RAW_AMOUNT_PATTERN.test(providerAmount) || !RAW_AMOUNT_PATTERN.test(expectedRaw)) return false;
  return BigInt(providerAmount) === BigInt(expectedRaw);
}

function fillHashMatchesFamily(txHash: string, family: BridgeChainFamily): boolean {
  return family === "solana" ? SOLANA_SIGNATURE_PATTERN.test(txHash) : EVM_TX_HASH_PATTERN.test(txHash);
}
