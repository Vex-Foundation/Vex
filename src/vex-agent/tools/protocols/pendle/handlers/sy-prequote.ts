/**
 * The SY family's prequote record + gate - the DRY-RUN-IN-TOOL pattern (R5d D3).
 *
 * Every other quote-gated Vex tool splits the contract across two toolIds: a
 * READ quote tool records the prequote (dispatched from
 * `prequote/registry.ts` by `runtime.ts`), and a separate EXECUTE tool is gated
 * on it (`prequote/gate.ts`). `pendle.sy.mint` / `pendle.sy.redeem` have no
 * separate quote tool: the SAME toolId records on `dryRun: true` and is gated on
 * the execute call, so the record and the gate live HERE instead of in the
 * central registries.
 *
 * The MECHANICS are copied, not reinvented, from the nearest existing family:
 *   - identity            → `prequote/identity/pendle-sy.ts`, called by BOTH
 *                           sides, exactly as `pendle-py.ts` is.
 *   - match hash          → `computePrequoteMatchHash`, unchanged.
 *   - row shape + reads   → `db/repos/swap-prequotes.ts`, unchanged; the DB
 *                           `kind` is the direction's OWN kind, `sy_mint` or
 *                           `sy_redeem` (migration 054). D3 shipped both under
 *                           `"swap"` with a comment conceding "no migration";
 *                           that left the wrap and the unwrap separated only by
 *                           which leg held the SY, and separated from an
 *                           ordinary swap only by the venue label. `kind` is a
 *                           predicate in BOTH gate reads, so it is the cheapest
 *                           place to make those confusions impossible.
 *   - recorder doctrine   → BEST-EFFORT: any failure is swallowed and logged
 *                           structurally, never altering the dry run's result. A
 *                           missing prequote is safe because the gate below
 *                           fails closed.
 *   - gate doctrine       → FAIL-CLOSED: any throw, a missing session, or an
 *                           un-buildable identity BLOCKS. A fresh `fail` verdict
 *                           dominates the latest row (gate guardrail #1).
 *
 * VERDICT is always `unknown`, deliberately. A Convert route proves the wrap is
 * ROUTABLE; it proves nothing about token safety, and there is no honeypot check
 * for an SY. That mirrors the bridge recorder's doctrine rather than claiming a
 * `pass` nobody computed.
 *
 * NEVER persist or log raw provider/HTTP/DB/error text - only bounded structural
 * labels.
 */

import { randomUUID } from "node:crypto";

import logger from "@utils/logger.js";
import * as prequoteRepo from "@vex-agent/db/repos/swap-prequotes.js";

import { VexError, ErrorCodes } from "../../../../../errors.js";
import type { ProtocolExecutionContext } from "../../types.js";
import {
  computePrequoteMatchHash,
  type SyMintMatchInput,
  type SyRedeemMatchInput,
} from "../../prequote/identity/hash.js";
import {
  buildPendleSyIdentity,
  PENDLE_SY_PREQUOTE_PROVIDER,
  type PendleSyDirection,
} from "../../prequote/identity/pendle-sy.js";
import { PREQUOTE_MAX_AGE_MS } from "../../prequote/registry.js";

/**
 * The DB `kind` an SY prequote is stored under - the direction's OWN kind
 * (migration 054), never the shared `"swap"` D3 used. Both gate reads scope on
 * `kind`, so this is what stops a `dryRun` of one direction from authorizing the
 * other's execute at the row level, independently of the digest.
 */
function syPrequoteKind(direction: PendleSyDirection): "sy_mint" | "sy_redeem" {
  return direction === "mint" ? "sy_mint" : "sy_redeem";
}

/**
 * The SY match identity, in the direction's own kind.
 *
 * `buildPendleSyIdentity` (owned by `prequote/identity/pendle-sy.ts`) returns the
 * swap-shaped identity it has always returned; this re-tags it into the
 * direction's dedicated identity so the DIRECTION rides in the first material
 * slot rather than depending on which leg holds the SY. `sy`/`token` are read
 * back off the built legs - for a mint the token is spent and the SY received,
 * for a redeem the reverse.
 *
 * ONE function, called by BOTH the recorder and the gate, so the two sides can
 * never disagree about the mapping - the property that matters for a match hash.
 * The leg convention is duplicated from the builder; if that builder is ever
 * given the R5d identities directly, this adapter should be deleted, not kept in
 * parallel.
 */
function buildSyMatchInput(
  sessionId: string,
  params: Record<string, unknown>,
  context: ProtocolExecutionContext,
  direction: PendleSyDirection,
): SyMintMatchInput | SyRedeemMatchInput {
  const identity = buildPendleSyIdentity(sessionId, params, context, direction);
  // The builder resolves the chain or throws, so this is unreachable - but the
  // swap-shaped return type admits null/undefined, and a defaulted chain id
  // would let two chains share a digest. Refuse rather than pick one.
  if (identity.chainId == null) {
    throw new VexError(ErrorCodes.PENDLE_API_ERROR, "Pendle SY identity has no chain.");
  }
  const common = {
    sessionId: identity.sessionId,
    provider: identity.provider,
    chainId: identity.chainId,
    walletAddress: identity.walletAddress,
    receiver: identity.recipient,
    sy: direction === "mint" ? identity.tokenOut : identity.tokenIn,
    token: direction === "mint" ? identity.tokenIn : identity.tokenOut,
    amount: identity.amount,
    slippageBps: identity.slippageBps,
  } as const;
  return direction === "mint"
    ? { kind: "sy_mint", ...common }
    : { kind: "sy_redeem", ...common };
}

/**
 * Bounded, structural-only provenance stored beside an SY prequote. Nothing here
 * is model-supplied or provider text: the aggregator label is one of Convert's
 * own enum strings and the SY is the address the caller asked for.
 */
export interface PendleSyRouteRef {
  readonly direction: PendleSyDirection;
  readonly sy: string;
  readonly aggregator: string | null;
}

/**
 * Record the prequote a later execute must match. Called by the SY handlers ONLY
 * after the dry run has fully validated the route (Router pin, sender/value/
 * approval binds, calldata intent bind and the price floor) - an unsafe route
 * must never leave an authorization behind.
 *
 * Never throws to the caller.
 */
export async function recordPendleSyPrequote(
  toolId: string,
  sessionId: string,
  params: Record<string, unknown>,
  context: ProtocolExecutionContext,
  direction: PendleSyDirection,
  routeRef: PendleSyRouteRef,
): Promise<void> {
  try {
    const identity = buildSyMatchInput(sessionId, params, context, direction);
    await prequoteRepo.create({
      prequoteId: randomUUID(),
      sessionId,
      matchHash: computePrequoteMatchHash(identity),
      kind: syPrequoteKind(direction),
      family: "eip155",
      provider: PENDLE_SY_PREQUOTE_PROVIDER,
      chainId: identity.chainId,
      walletAddress: identity.walletAddress,
      // The row's display legs keep the in/out orientation the feed expects; the
      // identity binds them by role.
      tokenIn: direction === "mint" ? identity.token : identity.sy,
      tokenOut: direction === "mint" ? identity.sy : identity.token,
      amount: identity.amount,
      slippageBps: identity.slippageBps === "" ? null : Number(identity.slippageBps),
      safetyVerdict: "unknown",
      safetyDetail: { syWrap: { direction: routeRef.direction } },
      routeRef: { direction: routeRef.direction, sy: routeRef.sy, aggregator: routeRef.aggregator },
      expiresAt: new Date(Date.now() + PREQUOTE_MAX_AGE_MS).toISOString(),
    });
  } catch (err) {
    logger.warn("pendle.sy.prequote.skipped", {
      toolId,
      reason: err instanceof VexError ? err.code : err instanceof Error ? err.constructor.name : "record_failed",
    });
  }
}

/**
 * The gate's answer. A block carries a bounded structural `reason` for the log
 * and the agent-facing `message` the handler surfaces - never row contents,
 * addresses, or raw error text.
 */
export type PendleSyGateDecision =
  | { readonly kind: "allow" }
  | { readonly kind: "block"; readonly reason: "no_quote" | "safety_fail" | "gate_error"; readonly message: string };

function blockMessage(toolId: string, reason: "no_quote" | "safety_fail" | "gate_error"): string {
  const dryRun = `Call ${toolId} with dryRun: true using EXACTLY the same params first, then retry.`;
  switch (reason) {
    case "no_quote":
      return (
        `${toolId} blocked: no fresh dry run for these exact params - the execute must use EXACTLY the same `
        + `chain, sy, token, amountIn and slippageBps (same value, or omitted on both sides). ${dryRun}`
      );
    case "safety_fail":
      return `${toolId} blocked: the dry run for these params was flagged unsafe. Do not retry.`;
    case "gate_error":
      return `${toolId} blocked: could not verify a fresh dry run. ${dryRun}`;
  }
}

/**
 * Gate an SY execute on a fresh matching dry run. FAILS CLOSED: any throw (an
 * un-buildable identity, a wallet-scope error, a DB failure) blocks.
 *
 * Ordering mirrors the central gate: a fresh `fail` verdict is checked FIRST so a
 * flagged wrap can never be authorized by a later `unknown` row for the same
 * identity.
 */
export async function gatePendleSyExecute(
  toolId: string,
  sessionId: string,
  params: Record<string, unknown>,
  context: ProtocolExecutionContext,
  direction: PendleSyDirection,
): Promise<PendleSyGateDecision> {
  const kind = syPrequoteKind(direction);
  let matchHash: string;
  try {
    matchHash = computePrequoteMatchHash(buildSyMatchInput(sessionId, params, context, direction));
  } catch (err) {
    logger.info("pendle.sy.gate.blocked", {
      toolId,
      reason: "gate_error",
      code: err instanceof VexError ? err.code : "UNEXPECTED",
    });
    return { kind: "block", reason: "gate_error", message: blockMessage(toolId, "gate_error") };
  }

  try {
    if (await prequoteRepo.existsFreshFailByMatch(sessionId, matchHash, kind)) {
      logger.info("pendle.sy.gate.blocked", { toolId, reason: "safety_fail" });
      return { kind: "block", reason: "safety_fail", message: blockMessage(toolId, "safety_fail") };
    }
    const matched = await prequoteRepo.findLatestFreshByMatch(sessionId, matchHash, kind);
    if (!matched || matched.provider !== PENDLE_SY_PREQUOTE_PROVIDER) {
      logger.info("pendle.sy.gate.blocked", { toolId, reason: "no_quote" });
      return { kind: "block", reason: "no_quote", message: blockMessage(toolId, "no_quote") };
    }
    if (matched.safetyVerdict === "fail") {
      logger.info("pendle.sy.gate.blocked", { toolId, reason: "safety_fail" });
      return { kind: "block", reason: "safety_fail", message: blockMessage(toolId, "safety_fail") };
    }
    return { kind: "allow" };
  } catch (err) {
    logger.warn("pendle.sy.gate.error", {
      toolId,
      code: err instanceof VexError ? err.code : "UNEXPECTED",
    });
    return { kind: "block", reason: "gate_error", message: blockMessage(toolId, "gate_error") };
  }
}
