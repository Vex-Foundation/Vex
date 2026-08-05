/**
 * The DUAL-LP family's prequote record + gate — the DRY-RUN-IN-TOOL pattern
 * (R5d card E3), mirroring `./sy-prequote.ts` one-for-one.
 *
 * `pendle.lp.removeDual` (LP → token + PT) and `pendle.lp.addKeepYt` (token → LP
 * + kept YT) have no separate `*.quote` toolId: the SAME toolId records the
 * authorization on a `dryRun: true` call and is gated on it when the call comes
 * back to execute. Record and gate therefore live HERE rather than in
 * `prequote/registry.ts` / `prequote/gate.ts`.
 *
 * WHAT DIFFERS FROM THE SY MODULE, and why:
 *
 *   - IDENTITY. The SY family had to ADAPT a swap-shaped builder into its R5d
 *     kind. These two kinds — `lp_remove_dual` / `lp_add_keep_yt`, migration 054
 *     — already ARE the identity (`prequote/identity/hash.ts`), so the match
 *     input is built directly and there is no second shape to keep in step.
 *   - RESOLVED INPUTS, not raw params. The builder takes the chain id, the
 *     RESOLVED market address and the resolved counterpart token the handler has
 *     already computed, because the handler must resolve them anyway (to refuse
 *     a matured destination, and to default `tokenOut` to the market's
 *     underlying). Both sides of the contract run the SAME handler code in the
 *     SAME order, so the two digests collide by construction — the property that
 *     matters — while a second catalogue lookup inside the gate is avoided.
 *     `slippageBps` is still read from the raw params through the shared
 *     canonicalizer, so an omitted value normalizes identically on both sides.
 *   - PROVIDER is plain `"pendle"`, matching the rest of the LP family. The SY
 *     pair needed a distinguishing venue label only because it reused the shared
 *     `swap` kind; here the KIND is the discriminant, and it is bound in the
 *     first slot of the hash material.
 *
 * Doctrine, unchanged from the SY module because it is the doctrine and not a
 * detail: the recorder is BEST-EFFORT (a failure is logged structurally and
 * never alters the dry run's result — safe, because the gate fails closed) and
 * the gate is FAIL-CLOSED (any throw, missing row, or fresh `fail` verdict
 * BLOCKS). `safetyVerdict` is `unknown` deliberately: a Convert route proves the
 * action is routable, and nothing more.
 *
 * NEVER persist or log raw provider/HTTP/DB/error text — only bounded structural
 * labels.
 */

import { randomUUID } from "node:crypto";

import logger from "@utils/logger.js";
import * as prequoteRepo from "@vex-agent/db/repos/swap-prequotes.js";

import { VexError } from "../../../../../errors.js";
import {
  computePrequoteMatchHash,
  type LpAddKeepYtMatchInput,
  type LpRemoveDualMatchInput,
} from "../../prequote/identity/hash.js";
import { canonSlippageBpsWithDefault } from "../../prequote/slippage.js";
import { PREQUOTE_MAX_AGE_MS } from "../../prequote/registry.js";
import { VEX_DEFAULT_SLIPPAGE_BPS } from "@vex-agent/tools/protocols/slippage-policy.js";

/** The venue label bound into every dual-LP digest — the LP family's own. */
export const PENDLE_LP_DUAL_PREQUOTE_PROVIDER = "pendle";

/** Which of the two dual actions a record/gate call is for. */
export type PendleLpDualKind = "lp_remove_dual" | "lp_add_keep_yt";

/**
 * The already-resolved legs a dual-LP identity binds. Every field here is a
 * value the handler DERIVED (a resolved chain id, a checksummed market address
 * from the catalogue, the output token after the underlying default) rather than
 * a raw model-supplied string — the raw params contribute only `slippageBps`,
 * through the shared canonicalizer.
 */
export interface PendleLpDualLegs {
  readonly chainId: number;
  readonly walletAddress: string;
  /** The Pendle market (== the LP token) being added to or removed from. */
  readonly market: string;
  /**
   * The leg the caller can vary: the TOKEN OUTPUT for a dual remove, the PAYMENT
   * TOKEN for a keep-YT add. The second instrument (the market's PT / YT) is not
   * a free parameter and is bound through `market`.
   */
  readonly token: string;
  /** Human decimal amount of the input leg, exactly as the caller wrote it. */
  readonly amount: string;
}

/**
 * ONE function, called by BOTH the recorder and the gate, so the two sides can
 * never disagree about the mapping — the only property a match hash needs.
 */
export function buildLpDualMatchInput(
  kind: PendleLpDualKind,
  sessionId: string,
  params: Record<string, unknown>,
  legs: PendleLpDualLegs,
): LpRemoveDualMatchInput | LpAddKeepYtMatchInput {
  const common = {
    sessionId,
    provider: PENDLE_LP_DUAL_PREQUOTE_PROVIDER,
    chainId: legs.chainId,
    walletAddress: legs.walletAddress,
    // No Pendle manifest exposes a `recipient`, and the calldata bind asserts
    // receiver == wallet before signing, so the receiver IS the wallet.
    receiver: legs.walletAddress,
    market: legs.market,
    amount: legs.amount,
    slippageBps: canonSlippageBpsWithDefault(params, VEX_DEFAULT_SLIPPAGE_BPS),
  } as const;
  return kind === "lp_remove_dual"
    ? { kind, ...common, tokenOut: legs.token }
    : { kind, ...common, tokenIn: legs.token };
}

/**
 * Bounded, structural-only provenance stored beside a dual-LP prequote. Nothing
 * here is model-supplied or provider text: the aggregator label is one of
 * Convert's own enum strings and the second instrument is the market's own.
 */
export interface PendleLpDualRouteRef {
  /** The market's PT (dual remove) or YT (keep-YT add) — the second output leg. */
  readonly secondLeg: string;
  readonly aggregator: string | null;
}

/**
 * Record the prequote a later execute must match. Called ONLY after the dry run
 * has fully validated the route (Router pin, sender/value/approval binds, the
 * calldata intent bind and BOTH price floors) — an unsafe route must never leave
 * an authorization behind.
 *
 * Never throws to the caller.
 */
export async function recordPendleLpDualPrequote(
  toolId: string,
  kind: PendleLpDualKind,
  sessionId: string,
  params: Record<string, unknown>,
  legs: PendleLpDualLegs,
  routeRef: PendleLpDualRouteRef,
): Promise<void> {
  try {
    const identity = buildLpDualMatchInput(kind, sessionId, params, legs);
    await prequoteRepo.create({
      prequoteId: randomUUID(),
      sessionId,
      matchHash: computePrequoteMatchHash(identity),
      kind,
      family: "eip155",
      provider: PENDLE_LP_DUAL_PREQUOTE_PROVIDER,
      chainId: legs.chainId,
      walletAddress: legs.walletAddress,
      // The row's display legs keep the in/out orientation the feed expects: a
      // dual remove spends the LP, a keep-YT add spends the payment token.
      tokenIn: kind === "lp_remove_dual" ? legs.market : legs.token,
      tokenOut: kind === "lp_remove_dual" ? legs.token : legs.market,
      amount: legs.amount,
      slippageBps: identity.slippageBps === "" ? null : Number(identity.slippageBps),
      safetyVerdict: "unknown",
      safetyDetail: { lpDual: { kind } },
      routeRef: { kind, market: legs.market, secondLeg: routeRef.secondLeg, aggregator: routeRef.aggregator },
      expiresAt: new Date(Date.now() + PREQUOTE_MAX_AGE_MS).toISOString(),
    });
  } catch (err) {
    logger.warn("pendle.lp_dual.prequote.skipped", {
      toolId,
      reason: err instanceof VexError ? err.code : err instanceof Error ? err.constructor.name : "record_failed",
    });
  }
}

/**
 * The gate's answer. A block carries a bounded structural `reason` for the log
 * and the agent-facing `message` the handler surfaces — never row contents,
 * addresses, or raw error text.
 */
export type PendleLpDualGateDecision =
  | { readonly kind: "allow" }
  | { readonly kind: "block"; readonly reason: "no_quote" | "safety_fail" | "gate_error"; readonly message: string };

type BlockReason = "no_quote" | "safety_fail" | "gate_error";

function blockMessage(toolId: string, reason: BlockReason): string {
  const dryRun = `Call ${toolId} with dryRun: true using EXACTLY the same params first, then retry.`;
  switch (reason) {
    case "no_quote":
      return (
        `${toolId} blocked: no fresh dry run for these exact params — the execute must use EXACTLY the same `
        + `chain, market, token leg, amountIn and slippageBps (same value, or omitted on both sides). ${dryRun}`
      );
    case "safety_fail":
      return `${toolId} blocked: the dry run for these params was flagged unsafe. Do not retry.`;
    case "gate_error":
      return `${toolId} blocked: could not verify a fresh dry run. ${dryRun}`;
  }
}

/**
 * Gate a dual-LP execute on a fresh matching dry run. FAILS CLOSED: any throw (an
 * un-buildable identity, a DB failure) blocks.
 *
 * Ordering mirrors the central gate: a fresh `fail` verdict is checked FIRST so a
 * flagged route can never be authorized by a later `unknown` row for the same
 * identity.
 */
export async function gatePendleLpDualExecute(
  toolId: string,
  kind: PendleLpDualKind,
  sessionId: string,
  params: Record<string, unknown>,
  legs: PendleLpDualLegs,
): Promise<PendleLpDualGateDecision> {
  let matchHash: string;
  try {
    matchHash = computePrequoteMatchHash(buildLpDualMatchInput(kind, sessionId, params, legs));
  } catch (err) {
    logger.info("pendle.lp_dual.gate.blocked", {
      toolId,
      reason: "gate_error",
      code: err instanceof VexError ? err.code : "UNEXPECTED",
    });
    return { kind: "block", reason: "gate_error", message: blockMessage(toolId, "gate_error") };
  }

  try {
    if (await prequoteRepo.existsFreshFailByMatch(sessionId, matchHash, kind)) {
      logger.info("pendle.lp_dual.gate.blocked", { toolId, reason: "safety_fail" });
      return { kind: "block", reason: "safety_fail", message: blockMessage(toolId, "safety_fail") };
    }
    const matched = await prequoteRepo.findLatestFreshByMatch(sessionId, matchHash, kind);
    if (!matched || matched.provider !== PENDLE_LP_DUAL_PREQUOTE_PROVIDER) {
      logger.info("pendle.lp_dual.gate.blocked", { toolId, reason: "no_quote" });
      return { kind: "block", reason: "no_quote", message: blockMessage(toolId, "no_quote") };
    }
    if (matched.safetyVerdict === "fail") {
      logger.info("pendle.lp_dual.gate.blocked", { toolId, reason: "safety_fail" });
      return { kind: "block", reason: "safety_fail", message: blockMessage(toolId, "safety_fail") };
    }
    return { kind: "allow" };
  } catch (err) {
    logger.warn("pendle.lp_dual.gate.error", {
      toolId,
      code: err instanceof VexError ? err.code : "UNEXPECTED",
    });
    return { kind: "block", reason: "gate_error", message: blockMessage(toolId, "gate_error") };
  }
}
