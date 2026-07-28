/**
 * The term-mobility family's prequote record + gate — the DRY-RUN-IN-TOOL
 * pattern (R5d card E4), for `pendle.pt.rollover`, `pendle.lp.transfer` and
 * `pendle.lp.toPt`.
 *
 * Same shape as `./sy-prequote.ts`, and deliberately so: the SAME toolId records
 * the authorization on a `dryRun: true` call and is gated on the execute call,
 * so neither the central `prequote/registry.ts` (which dispatches from a READ
 * quote tool) nor `prequote/gate.ts` (which gates a separate EXECUTE tool) can
 * carry it.
 *
 * WHAT IS DIFFERENT FROM THE SY FAMILY, and why it matters:
 *
 *   - The identities are built HERE, directly as the E1 match inputs
 *     (`PtRolloverMatchInput` / `LpTransferMatchInput` / `LpToPtMatchInput`),
 *     rather than through a swap-shaped builder that a second function then
 *     re-tags. E1 shipped these kinds precisely so the destination leg rides in
 *     its own bound slot; adapting a swap identity into them would reintroduce
 *     the leg-convention duplication `sy-prequote.ts` calls out.
 *   - The RESOLVED destination is what gets bound, not the raw param. The
 *     handler resolves the market/PT on BOTH sides (dry run and execute)
 *     independently, and passes the resolution in. A divergence between the two
 *     resolutions therefore changes the digest and BLOCKS, instead of two
 *     different destinations quietly agreeing because the caller typed the same
 *     string. This is the property `LpToPtMatchInput` documents for `ptOut`.
 *
 * Doctrine, unchanged from every other prequote in the tree:
 *   - recorder → BEST-EFFORT. Any failure is swallowed and logged structurally;
 *     a missing prequote is safe because the gate fails closed.
 *   - gate     → FAIL-CLOSED. Any throw, a missing session or an un-buildable
 *     identity BLOCKS, and a fresh `fail` verdict dominates the latest row.
 *   - verdict  → always `unknown`. A Convert route proves the move is ROUTABLE;
 *     it proves nothing about token safety, and there is no honeypot check for a
 *     Pendle market. Claiming `pass` would assert something nobody computed.
 *
 * NEVER persist or log raw provider/HTTP/DB/error text — only bounded structural
 * labels.
 */

import { randomUUID } from "node:crypto";

import { getAddress } from "viem";

import logger from "@utils/logger.js";
import * as prequoteRepo from "@vex-agent/db/repos/swap-prequotes.js";
import { resolveSelectedAddress } from "@vex-agent/tools/internal/wallet/resolve.js";
import { resolvePendleChainId } from "@tools/pendle/chains.js";

import { VexError, ErrorCodes } from "../../../../../errors.js";
import type { ProtocolExecutionContext } from "../../types.js";
import { canonSlippageBpsWithDefault } from "../../prequote/slippage.js";
import {
  computePrequoteMatchHash,
  type LpToPtMatchInput,
  type LpTransferMatchInput,
  type PtRolloverMatchInput,
} from "../../prequote/identity/hash.js";
import { PREQUOTE_MAX_AGE_MS } from "../../prequote/registry.js";

/**
 * The venue label bound into every term-mobility digest.
 *
 * NOT plain "pendle" (the PT/YT/PY/LP quote tools) and NOT "pendle-sy": the
 * provider is bound into all three materials, so this label alone makes a
 * `pendle.pt.buy` or `pendle.sy.mint` authorization structurally unable to
 * satisfy one of these executes. ONE label for the family is enough because the
 * three kinds already occupy the FIRST material slot and can never collide with
 * each other.
 */
export const PENDLE_TERM_PREQUOTE_PROVIDER = "pendle-term";

/**
 * Default slippage (bps) when the caller omits it — MUST match the handler's
 * `DEFAULT_SLIPPAGE_BPS` (`./shared.ts`) so a dry run without slippage
 * authorizes an execute without slippage. A PRESENT but invalid value is refused
 * by `canonSlippageBpsWithDefault`, never replaced by this default: a silent
 * fallback would let an out-of-contract slippage hash like an omitted one.
 */
const DEFAULT_SLIPPAGE_BPS = 50;

/** Which term-mobility action a prequote belongs to — also its DB `kind`. */
export type PendleTermAction = "pt_rollover" | "lp_transfer" | "lp_to_pt";

/**
 * The RESOLVED legs the identity binds, supplied by the handler after its own
 * lookups. Both legs are addresses the handler has already checksummed; the
 * source is whatever the caller named, the destination is what Vex resolved.
 */
export interface PendleTermLegs {
  readonly source: string;
  readonly destination: string;
  /** Human decimal amount of the SOURCE leg, exactly as the caller passed it. */
  readonly amount: string;
}

function requireChainId(params: Record<string, unknown>): number {
  const raw = params.chain;
  const chainId = resolvePendleChainId(typeof raw === "string" ? raw.trim() : "");
  if (chainId === undefined) {
    throw new VexError(ErrorCodes.PENDLE_API_ERROR, "Pendle term identity on an unsupported chain.");
  }
  return chainId;
}

function requireAddr(raw: string, label: string): string {
  try {
    return getAddress(raw);
  } catch {
    throw new VexError(ErrorCodes.PENDLE_TOKEN_NOT_FOUND, `Pendle term ${label} is not a valid address.`);
  }
}

/**
 * Build the kind's match input. ONE function, called by BOTH the recorder and
 * the gate, so the two sides can never disagree about which field is which — the
 * only property a match hash actually needs.
 *
 * Throws (never guesses) on a missing leg, an unsupported chain, a malformed
 * address, a same-address pair, or an out-of-contract slippage.
 */
export function buildPendleTermMatchInput(
  action: PendleTermAction,
  sessionId: string,
  params: Record<string, unknown>,
  context: ProtocolExecutionContext,
  legs: PendleTermLegs,
): PtRolloverMatchInput | LpTransferMatchInput | LpToPtMatchInput {
  if (!legs.source || !legs.destination || !legs.amount) {
    throw new VexError(ErrorCodes.AGENT_VALIDATION_ERROR, "Pendle term identity missing a leg or the amount.");
  }
  const chainId = requireChainId(params);
  const source = requireAddr(legs.source, "source leg");
  const destination = requireAddr(legs.destination, "destination leg");
  // `lp_to_pt` is the ONE action whose two legs are different token TYPES of the
  // same market, so an equal pair there means the market resolved to itself as
  // its own PT — as impossible as a rollover into the PT it starts from.
  if (source.toLowerCase() === destination.toLowerCase()) {
    throw new VexError(ErrorCodes.PENDLE_TOKEN_NOT_FOUND, "Pendle term identity has the same address on both legs.");
  }
  const wallet = resolveSelectedAddress(context.walletResolution, context.walletPolicy, "eip155");
  const common = {
    sessionId,
    provider: PENDLE_TERM_PREQUOTE_PROVIDER,
    chainId,
    walletAddress: wallet,
    // No `recipient` param exists on any Pendle manifest and the calldata bind
    // asserts receiver == wallet before signing, so the receiver IS the wallet.
    receiver: wallet,
    amount: legs.amount,
    slippageBps: canonSlippageBpsWithDefault(params, DEFAULT_SLIPPAGE_BPS),
  } as const;
  switch (action) {
    case "pt_rollover":
      return { kind: "pt_rollover", ...common, fromPt: source, toPt: destination };
    case "lp_transfer":
      return { kind: "lp_transfer", ...common, fromMarket: source, toMarket: destination };
    case "lp_to_pt":
      return { kind: "lp_to_pt", ...common, market: source, ptOut: destination };
  }
}

/**
 * Bounded, structural-only provenance stored beside a term-mobility prequote.
 * Nothing here is model-supplied or provider text: the aggregator label is one
 * of Convert's own enum strings and the addresses are Vex's own resolutions.
 */
export interface PendleTermRouteRef {
  readonly action: PendleTermAction;
  readonly source: string;
  readonly destination: string;
  readonly aggregator: string | null;
}

/**
 * Record the prequote a later execute must match. Called by the handlers ONLY
 * after the dry run has fully validated the route (Router pin, sender/value/
 * approval binds, reflector pin where applicable, per-leg calldata bind and the
 * price floor) — an unsafe route must never leave an authorization behind.
 *
 * Never throws to the caller.
 */
export async function recordPendleTermPrequote(
  toolId: string,
  action: PendleTermAction,
  sessionId: string,
  params: Record<string, unknown>,
  context: ProtocolExecutionContext,
  legs: PendleTermLegs,
  routeRef: PendleTermRouteRef,
): Promise<void> {
  try {
    const identity = buildPendleTermMatchInput(action, sessionId, params, context, legs);
    await prequoteRepo.create({
      prequoteId: randomUUID(),
      sessionId,
      matchHash: computePrequoteMatchHash(identity),
      kind: action,
      family: "eip155",
      provider: PENDLE_TERM_PREQUOTE_PROVIDER,
      chainId: identity.chainId,
      walletAddress: identity.walletAddress,
      // Display legs keep the in/out orientation the feed expects; the identity
      // binds them by role.
      tokenIn: legs.source,
      tokenOut: legs.destination,
      amount: identity.amount,
      slippageBps: identity.slippageBps === "" ? null : Number(identity.slippageBps),
      safetyVerdict: "unknown",
      safetyDetail: { pendleTerm: { action } },
      routeRef: {
        action: routeRef.action,
        source: routeRef.source,
        destination: routeRef.destination,
        aggregator: routeRef.aggregator,
      },
      expiresAt: new Date(Date.now() + PREQUOTE_MAX_AGE_MS).toISOString(),
    });
  } catch (err) {
    logger.warn("pendle.term.prequote.skipped", {
      toolId,
      action,
      reason: err instanceof VexError ? err.code : err instanceof Error ? err.constructor.name : "record_failed",
    });
  }
}

/**
 * The gate's answer. A block carries a bounded structural `reason` for the log
 * and the agent-facing `message` the handler surfaces — never row contents,
 * addresses, or raw error text.
 */
export type PendleTermGateDecision =
  | { readonly kind: "allow" }
  | { readonly kind: "block"; readonly reason: "no_quote" | "safety_fail" | "gate_error"; readonly message: string };

function blockMessage(toolId: string, reason: "no_quote" | "safety_fail" | "gate_error"): string {
  const dryRun = `Call ${toolId} with dryRun: true using EXACTLY the same params first, then retry.`;
  switch (reason) {
    case "no_quote":
      return (
        `${toolId} blocked: no fresh dry run for these exact params — the execute must use EXACTLY the same `
        + `chain, source and destination legs, amountIn and slippageBps (same value, or omitted on both sides). ${dryRun}`
      );
    case "safety_fail":
      return `${toolId} blocked: the dry run for these params was flagged unsafe. Do not retry.`;
    case "gate_error":
      return `${toolId} blocked: could not verify a fresh dry run. ${dryRun}`;
  }
}

/**
 * Gate a term-mobility execute on a fresh matching dry run. FAILS CLOSED: any
 * throw (an un-buildable identity, a wallet-scope error, a DB failure) blocks.
 *
 * Ordering mirrors the central gate: a fresh `fail` verdict is checked FIRST, so
 * a flagged move can never be authorized by a later `unknown` row for the same
 * identity.
 */
export async function gatePendleTermExecute(
  toolId: string,
  action: PendleTermAction,
  sessionId: string,
  params: Record<string, unknown>,
  context: ProtocolExecutionContext,
  legs: PendleTermLegs,
): Promise<PendleTermGateDecision> {
  let matchHash: string;
  try {
    matchHash = computePrequoteMatchHash(buildPendleTermMatchInput(action, sessionId, params, context, legs));
  } catch (err) {
    logger.info("pendle.term.gate.blocked", {
      toolId,
      action,
      reason: "gate_error",
      code: err instanceof VexError ? err.code : "UNEXPECTED",
    });
    return { kind: "block", reason: "gate_error", message: blockMessage(toolId, "gate_error") };
  }

  try {
    if (await prequoteRepo.existsFreshFailByMatch(sessionId, matchHash, action)) {
      logger.info("pendle.term.gate.blocked", { toolId, action, reason: "safety_fail" });
      return { kind: "block", reason: "safety_fail", message: blockMessage(toolId, "safety_fail") };
    }
    const matched = await prequoteRepo.findLatestFreshByMatch(sessionId, matchHash, action);
    if (!matched || matched.provider !== PENDLE_TERM_PREQUOTE_PROVIDER) {
      logger.info("pendle.term.gate.blocked", { toolId, action, reason: "no_quote" });
      return { kind: "block", reason: "no_quote", message: blockMessage(toolId, "no_quote") };
    }
    if (matched.safetyVerdict === "fail") {
      logger.info("pendle.term.gate.blocked", { toolId, action, reason: "safety_fail" });
      return { kind: "block", reason: "safety_fail", message: blockMessage(toolId, "safety_fail") };
    }
    return { kind: "allow" };
  } catch (err) {
    logger.warn("pendle.term.gate.error", {
      toolId,
      action,
      code: err instanceof VexError ? err.code : "UNEXPECTED",
    });
    return { kind: "block", reason: "gate_error", message: blockMessage(toolId, "gate_error") };
  }
}
