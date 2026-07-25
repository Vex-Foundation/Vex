/**
 * Swap/bridge prequote recording (Stage 6c / 8c).
 *
 * RECORDER — for a SUCCESSFUL swap QUOTE this module computes:
 *   1. a deterministic match-hash over the trade identity (reused verbatim by
 *      the Stage-7 execute gate so record-time and gate-time hashes collide),
 *   2. a 3-state token-safety verdict (`pass` | `fail` | `unknown`),
 *   3. a bounded, structural-only `safetyDetail` payload,
 * then records a `swap_prequotes` row. Recording is best-effort: any failure is
 * swallowed (logged structurally) so it never alters the quote's ToolResult. A
 * missing prequote is safe — the Stage-7 gate blocks the execute instead.
 *
 * NEVER persist or log raw provider/HTTP/DB/error text — only bounded structural
 * labels.
 */

import { randomUUID } from "node:crypto";

import type { ChainFamily } from "@tools/khalani/types.js";
import { resolveSelectedAddress } from "@vex-agent/tools/internal/wallet/resolve.js";
import logger from "@utils/logger.js";

import { VexError } from "../../../../errors.js";
import type { ProtocolExecutionContext } from "../types.js";
import * as prequoteRepo from "@vex-agent/db/repos/swap-prequotes.js";
import type {
  CreatePrequoteInput,
  PrequoteFamily,
} from "@vex-agent/db/repos/swap-prequotes.js";

import { PREQUOTE_QUOTE_TOOLS, PREQUOTE_MAX_AGE_MS } from "./registry.js";
import { computePrequoteMatchHash } from "./identity/hash.js";
import type { BridgeMatchInput } from "./identity/hash.js";
import { buildBridgeIdentity } from "./identity/bridge.js";
import { buildRelayBridgeIdentity, isValidRelayQuoteShape } from "./identity/relay-bridge.js";
import { buildPendleRedeemIdentity } from "./identity/pendle-redeem.js";
import { buildPendleMintIdentity, buildPendleRedeemPyIdentity } from "./identity/pendle-py.js";
import { buildPendleLpAddIdentity, buildPendleLpRemoveIdentity } from "./identity/pendle-lp.js";
import { extractQuote, extractPendleQuote, extractPendlePyQuote, extractPendleLpQuote } from "./safety/extract.js";
import { canonSlippageBps, readParamSlippageBps } from "./slippage.js";
import { canonicalizeJupiterFeeTail, resolveJupiterFeeSwapKnobs } from "@tools/solana-ecosystem/jupiter/jupiter-swaps/fee-swap.js";

// ── Recorder ──────────────────────────────────────────────────────────────

function familyToChainFamily(family: PrequoteFamily): ChainFamily {
  // PrequoteFamily and ChainFamily share the same inhabitants; keep them
  // separate types but bridge here at the single call site.
  return family;
}

/**
 * Best-effort `swap_prequotes` write. The DB call is the only throw site left in
 * the recorder, so it is isolated here to honour the "never throws to caller"
 * contract. Only a bounded structural reason is logged — never raw provider/DB
 * text. Returns true on a successful write.
 */
async function writePrequoteRow(toolId: string, input: CreatePrequoteInput): Promise<boolean> {
  try {
    await prequoteRepo.create(input);
    return true;
  } catch (err) {
    const reason =
      err instanceof VexError
        ? err.code
        : err instanceof Error
          ? err.constructor.name
          : "write_failed";
    logger.warn("protocol.prequote.skipped", { toolId, reason });
    return false;
  }
}

/**
 * Record a prequote from a successful quote. Best-effort: resolves the would-be
 * signing address (skips on a wallet-scope throw — never fabricates an address),
 * validates + extracts the quote, computes the match-hash + verdict, and writes
 * the row. Never throws to the caller; structural logs only. Dispatches by the
 * registered `kind`: a `swap` quote records a token-safety verdict; a `bridge`
 * quote always records verdict `unknown` (a Khalani route proves availability,
 * NOT token safety — Codex requirement #3).
 */
export async function recordPrequoteFromQuote(
  toolId: string,
  params: Record<string, unknown>,
  resultData: Record<string, unknown>,
  context: ProtocolExecutionContext,
): Promise<void> {
  const registered = PREQUOTE_QUOTE_TOOLS[toolId];
  if (!registered) return;

  const sessionId = context.sessionId;
  if (!sessionId) {
    logger.warn("protocol.prequote.skipped", { toolId, reason: "no_session" });
    return;
  }

  if (registered.kind === "bridge") {
    await recordBridgePrequote(toolId, sessionId, registered.provider, params, resultData, context);
    return;
  }
  if (registered.kind === "pendle") {
    await recordPendlePrequote(toolId, sessionId, registered, params, resultData, context);
    return;
  }
  if (registered.kind === "pendle-py") {
    await recordPendlePyPrequote(toolId, sessionId, registered, params, resultData, context);
    return;
  }
  if (registered.kind === "pendle-lp") {
    await recordPendleLpPrequote(toolId, sessionId, registered, params, resultData, context);
    return;
  }
  await recordSwapPrequote(toolId, sessionId, registered, params, resultData, context);
}

/**
 * Record a Pendle LP prequote (P5). `pendle.lp.quote` records EITHER an `lp_add`
 * prequote (direction "add" — token → LP) OR an `lp_remove` prequote (direction
 * "remove" — LP → token), decided from the echoed `direction`. Each uses its
 * dedicated identity (never the swap / mint / redeem one). Best-effort: a
 * wallet-scope / identity throw is a bounded skip.
 */
async function recordPendleLpPrequote(
  toolId: string,
  sessionId: string,
  registered: { readonly family: PrequoteFamily; readonly provider: string },
  params: Record<string, unknown>,
  resultData: Record<string, unknown>,
  context: ProtocolExecutionContext,
): Promise<void> {
  const extracted = extractPendleLpQuote(params, resultData);
  if (!extracted) {
    logger.warn("protocol.prequote.skipped", { toolId, reason: "shape_invalid" });
    return;
  }
  const expiresAt = new Date(Date.now() + PREQUOTE_MAX_AGE_MS).toISOString();

  if (extracted.direction === "add") {
    let identity;
    try {
      identity = await buildPendleLpAddIdentity(sessionId, params, context);
    } catch (err) {
      const reason = err instanceof VexError ? err.code : "pendle_lp_add_identity_failed";
      logger.warn("protocol.prequote.skipped", { toolId, reason });
      return;
    }
    const input: CreatePrequoteInput = {
      prequoteId: `prequote-${randomUUID()}`,
      sessionId,
      matchHash: computePrequoteMatchHash(identity),
      kind: "lp_add",
      family: registered.family,
      provider: registered.provider,
      chainId: identity.chainId,
      walletAddress: identity.walletAddress,
      // Descriptive row columns (matching is via match_hash + kind): an add pays a
      // token to acquire the market's LP token.
      tokenIn: identity.tokenIn,
      tokenOut: identity.market,
      amount: identity.amount,
      slippageBps: extracted.slippageBps,
      safetyVerdict: extracted.verdict,
      safetyDetail: extracted.safetyDetail,
      routeRef: null,
      expiresAt,
    };
    if (await writePrequoteRow(toolId, input)) {
      logger.info("protocol.prequote.recorded", { toolId, family: registered.family, verdict: extracted.verdict });
    }
    return;
  }

  // Remove (direction "remove") — dedicated lp_remove identity.
  let identity;
  try {
    identity = await buildPendleLpRemoveIdentity(sessionId, params, context);
  } catch (err) {
    const reason = err instanceof VexError ? err.code : "pendle_lp_remove_identity_failed";
    logger.warn("protocol.prequote.skipped", { toolId, reason });
    return;
  }
  const input: CreatePrequoteInput = {
    prequoteId: `prequote-${randomUUID()}`,
    sessionId,
    matchHash: computePrequoteMatchHash(identity),
    kind: "lp_remove",
    family: registered.family,
    provider: registered.provider,
    chainId: identity.chainId,
    walletAddress: identity.walletAddress,
    // Descriptive: a remove burns the market's LP token into the output token.
    tokenIn: identity.market,
    tokenOut: identity.tokenOut,
    amount: identity.amount,
    slippageBps: extracted.slippageBps,
    safetyVerdict: extracted.verdict,
    safetyDetail: extracted.safetyDetail,
    routeRef: null,
    expiresAt,
  };
  if (await writePrequoteRow(toolId, input)) {
    logger.info("protocol.prequote.recorded", { toolId, family: registered.family, verdict: extracted.verdict });
  }
}

/**
 * Record a Pendle PY prequote (P4). `pendle.py.quote` records EITHER a `mint`
 * prequote (direction "mint" — token → PT+YT) OR a `redeem_py` prequote
 * (direction "redeem" — pre-expiry PT+YT → token), decided from the echoed
 * `direction`. Each uses its dedicated identity (never the swap / redeem one).
 * Best-effort: a wallet-scope / identity throw is a bounded skip.
 */
async function recordPendlePyPrequote(
  toolId: string,
  sessionId: string,
  registered: { readonly family: PrequoteFamily; readonly provider: string },
  params: Record<string, unknown>,
  resultData: Record<string, unknown>,
  context: ProtocolExecutionContext,
): Promise<void> {
  const extracted = extractPendlePyQuote(params, resultData);
  if (!extracted) {
    logger.warn("protocol.prequote.skipped", { toolId, reason: "shape_invalid" });
    return;
  }
  const expiresAt = new Date(Date.now() + PREQUOTE_MAX_AGE_MS).toISOString();

  if (extracted.direction === "mint") {
    let identity;
    try {
      identity = await buildPendleMintIdentity(sessionId, params, context);
    } catch (err) {
      const reason = err instanceof VexError ? err.code : "pendle_mint_identity_failed";
      logger.warn("protocol.prequote.skipped", { toolId, reason });
      return;
    }
    const input: CreatePrequoteInput = {
      prequoteId: `prequote-${randomUUID()}`,
      sessionId,
      matchHash: computePrequoteMatchHash(identity),
      kind: "mint",
      family: registered.family,
      provider: registered.provider,
      chainId: identity.chainId,
      walletAddress: identity.walletAddress,
      // Descriptive row columns (matching is via match_hash + kind): mint pays a
      // token to acquire the PT.
      tokenIn: identity.tokenIn,
      tokenOut: identity.ptAddress,
      amount: identity.amount,
      slippageBps: extracted.slippageBps,
      safetyVerdict: extracted.verdict,
      safetyDetail: extracted.safetyDetail,
      routeRef: null,
      expiresAt,
    };
    if (await writePrequoteRow(toolId, input)) {
      logger.info("protocol.prequote.recorded", { toolId, family: registered.family, verdict: extracted.verdict });
    }
    return;
  }

  // Pre-expiry redeem (direction "redeem") — dedicated redeem_py identity.
  let identity;
  try {
    identity = await buildPendleRedeemPyIdentity(sessionId, params, context);
  } catch (err) {
    const reason = err instanceof VexError ? err.code : "pendle_redeem_py_identity_failed";
    logger.warn("protocol.prequote.skipped", { toolId, reason });
    return;
  }
  const input: CreatePrequoteInput = {
    prequoteId: `prequote-${randomUUID()}`,
    sessionId,
    matchHash: computePrequoteMatchHash(identity),
    kind: "redeem_py",
    family: registered.family,
    provider: registered.provider,
    chainId: identity.chainId,
    walletAddress: identity.walletAddress,
    // Descriptive: py-redeem burns the PT (+YT) into the output token.
    tokenIn: identity.ptAddress,
    tokenOut: identity.outputToken,
    amount: identity.amount,
    slippageBps: extracted.slippageBps,
    safetyVerdict: extracted.verdict,
    safetyDetail: extracted.safetyDetail,
    routeRef: null,
    expiresAt,
  };
  if (await writePrequoteRow(toolId, input)) {
    logger.info("protocol.prequote.recorded", { toolId, family: registered.family, verdict: extracted.verdict });
  }
}

/**
 * Record a Pendle prequote (Wave 5). The single `pendle.pt.quote` tool records
 * EITHER a `swap` prequote (buy / early-exit sell — Convert action `swap`) OR a
 * `redeem` prequote (matured PT — Convert action `redeem-py`), decided from the
 * echoed `action`. A redeem uses the dedicated redeem identity (never the swap or
 * bridge one). Best-effort: a wallet-scope / identity throw is a bounded skip.
 */
async function recordPendlePrequote(
  toolId: string,
  sessionId: string,
  registered: { readonly family: PrequoteFamily; readonly provider: string },
  params: Record<string, unknown>,
  resultData: Record<string, unknown>,
  context: ProtocolExecutionContext,
): Promise<void> {
  let walletAddress: string;
  try {
    walletAddress = resolveSelectedAddress(
      context.walletResolution,
      context.walletPolicy,
      familyToChainFamily(registered.family),
    );
  } catch (err) {
    const reason = err instanceof VexError ? err.code : "wallet_unresolved";
    logger.warn("protocol.prequote.skipped", { toolId, reason });
    return;
  }

  const extracted = extractPendleQuote(params, resultData);
  if (!extracted) {
    logger.warn("protocol.prequote.skipped", { toolId, reason: "shape_invalid" });
    return;
  }
  const expiresAt = new Date(Date.now() + PREQUOTE_MAX_AGE_MS).toISOString();

  // Redeem path — dedicated identity (provider/wallet/chainId/pt/yt/amount/receiver).
  if (extracted.action === "redeem") {
    let identity;
    try {
      identity = await buildPendleRedeemIdentity(sessionId, params, context);
    } catch (err) {
      const reason = err instanceof VexError ? err.code : "pendle_redeem_identity_failed";
      logger.warn("protocol.prequote.skipped", { toolId, reason });
      return;
    }
    const input: CreatePrequoteInput = {
      prequoteId: `prequote-${randomUUID()}`,
      sessionId,
      matchHash: computePrequoteMatchHash(identity),
      kind: "redeem",
      family: registered.family,
      provider: registered.provider,
      chainId: identity.chainId,
      walletAddress: identity.walletAddress,
      tokenIn: identity.ptAddress,
      tokenOut: extracted.tokenOut,
      amount: identity.amount,
      slippageBps: extracted.slippageBps,
      safetyVerdict: extracted.verdict,
      safetyDetail: extracted.safetyDetail,
      routeRef: null,
      expiresAt,
    };
    if (await writePrequoteRow(toolId, input)) {
      logger.info("protocol.prequote.recorded", { toolId, family: registered.family, verdict: extracted.verdict });
    }
    return;
  }

  // Swap path (buy / early-exit sell) — same money/safety leg as the other swaps:
  // recipient defaults to self, approveExact false, slippage from the quote params.
  const matchHash = computePrequoteMatchHash({
    kind: "swap",
    sessionId,
    family: registered.family,
    provider: registered.provider,
    chainId: extracted.chainId,
    walletAddress,
    tokenIn: extracted.tokenIn,
    tokenOut: extracted.tokenOut,
    amount: extracted.amount,
    recipient: walletAddress,
    approveExact: false,
    slippageBps: canonSlippageBps(readParamSlippageBps(params)),
  });
  const input: CreatePrequoteInput = {
    prequoteId: `prequote-${randomUUID()}`,
    sessionId,
    matchHash,
    kind: "swap",
    family: registered.family,
    provider: registered.provider,
    chainId: extracted.chainId,
    walletAddress,
    tokenIn: extracted.tokenIn,
    tokenOut: extracted.tokenOut,
    amount: extracted.amount,
    slippageBps: extracted.slippageBps,
    safetyVerdict: extracted.verdict,
    safetyDetail: extracted.safetyDetail,
    routeRef: null,
    expiresAt,
  };
  if (await writePrequoteRow(toolId, input)) {
    logger.info("protocol.prequote.recorded", { toolId, family: registered.family, verdict: extracted.verdict });
  }
}

async function recordSwapPrequote(
  toolId: string,
  sessionId: string,
  registered: { readonly family: PrequoteFamily; readonly provider: string },
  params: Record<string, unknown>,
  resultData: Record<string, unknown>,
  context: ProtocolExecutionContext,
): Promise<void> {
  // Resolve the SELECTED address (never decrypts a key). A wallet-scope throw
  // (no wallet selected for this family) is a valid skip — fail-closed, never
  // fabricate.
  let walletAddress: string;
  try {
    walletAddress = resolveSelectedAddress(
      context.walletResolution,
      context.walletPolicy,
      familyToChainFamily(registered.family),
    );
  } catch (err) {
    const reason = err instanceof VexError ? err.code : "wallet_unresolved";
    logger.warn("protocol.prequote.skipped", { toolId, reason });
    return;
  }

  const extracted = extractQuote(toolId, params, resultData);
  if (!extracted) {
    logger.warn("protocol.prequote.skipped", { toolId, reason: "shape_invalid" });
    return;
  }

  // W5 (design §6 R4): Jupiter fee-bearing tail, read from the QUOTE PARAMS
  // (same convention as `slippageBps` below) so it stays in lockstep with the
  // gate, which reads the SAME knobs from the execute params. Best-effort — a
  // malformed knob (e.g. an out-of-range tipLamports) is a bounded skip, never
  // a thrown recorder failure; every non-Jupiter provider leaves this
  // `undefined` (the hash tail then canonicalizes to "").
  let jupiterTail: ReturnType<typeof canonicalizeJupiterFeeTail> | undefined;
  if (registered.provider === "jupiter") {
    try {
      jupiterTail = canonicalizeJupiterFeeTail(resolveJupiterFeeSwapKnobs(params), extracted.tokenIn);
    } catch (err) {
      const reason = err instanceof VexError ? err.code : "jupiter_knobs_invalid";
      logger.warn("protocol.prequote.skipped", { toolId, reason });
      return;
    }
  }

  // Stage 9: bind the execute-only money/safety leg. The QUOTE carries none of
  // recipient/approveExact, so default them to what the executor uses when they
  // are omitted (output-to-self == the resolved selected wallet; approveExact
  // false). `slippageBps` is read from the QUOTE PARAMS (not the echoed quote
  // response) so it stays in lockstep with the gate, which reads it from the
  // execute params. Solana has no recipient/approveExact concept — self/false
  // are inert constants there.
  const matchHash = computePrequoteMatchHash({
    kind: "swap",
    sessionId,
    family: registered.family,
    // Venue binding (LOCKED #4) — the quoting provider is part of the identity.
    provider: registered.provider,
    chainId: extracted.chainId,
    walletAddress,
    tokenIn: extracted.tokenIn,
    tokenOut: extracted.tokenOut,
    amount: extracted.amount,
    recipient: walletAddress,
    approveExact: false,
    slippageBps: canonSlippageBps(readParamSlippageBps(params)),
    ...jupiterTail,
  });

  const input: CreatePrequoteInput = {
    prequoteId: `prequote-${randomUUID()}`,
    sessionId,
    matchHash,
    kind: "swap",
    family: registered.family,
    provider: registered.provider,
    chainId: extracted.chainId,
    walletAddress,
    tokenIn: extracted.tokenIn,
    tokenOut: extracted.tokenOut,
    amount: extracted.amount,
    slippageBps: extracted.slippageBps,
    safetyVerdict: extracted.verdict,
    safetyDetail: extracted.safetyDetail,
    // Structural-only route facts — today the Vex-computed KyberSwap price
    // floor `kyberswap.swap.execute` holds the built calldata to. Null for
    // every other swap venue (they build their own calldata, so the floor
    // never leaves the handler).
    routeRef: extracted.routeRef ?? null,
    expiresAt: new Date(Date.now() + PREQUOTE_MAX_AGE_MS).toISOString(),
  };

  if (await writePrequoteRow(toolId, input)) {
    logger.info("protocol.prequote.recorded", {
      toolId,
      family: registered.family,
      verdict: extracted.verdict,
    });
  }
}

/**
 * Bounded structural-only safetyDetail for a bridge prequote. A successful
 * Khalani quote proves route availability, NOT token safety — so the verdict is
 * ALWAYS `unknown` and the detail says exactly that (object shape, no raw text).
 */
const BRIDGE_SAFETY_DETAIL: Record<string, unknown> = {
  bridge: true,
  note: "route-only; no token-safety check",
};

/**
 * Record a bridge prequote from a successful `khalani.quote.get`. The identity
 * comes from the QUOTE params via the SHARED `buildBridgeIdentity` (the same
 * builder the execute gate uses), so quote↔execute hashes collide. Verdict is
 * ALWAYS `unknown`. Best-effort: an identity-build throw (unresolved chain /
 * wallet-scope) is a bounded skip, never a fabricated row.
 */
async function recordBridgePrequote(
  toolId: string,
  sessionId: string,
  provider: string,
  params: Record<string, unknown>,
  resultData: Record<string, unknown>,
  context: ProtocolExecutionContext,
): Promise<void> {
  // Relay gets its OWN extraction (LOCKED #5): validate the quote's step shape
  // (transaction steps only, chainIds ∈ {origin, destination}) BEFORE recording,
  // so a malformed quote never seeds the gate. Khalani route availability is
  // proven by its own quote validation upstream.
  if (provider === "relay" && !isValidRelayQuoteShape(resultData)) {
    logger.warn("protocol.prequote.skipped", { toolId, reason: "relay_shape_invalid" });
    return;
  }

  let identity: BridgeMatchInput;
  try {
    identity =
      provider === "relay"
        ? await buildRelayBridgeIdentity(sessionId, params, context)
        : await buildBridgeIdentity(sessionId, params, context);
  } catch (err) {
    const reason = err instanceof VexError ? err.code : "bridge_identity_failed";
    logger.warn("protocol.prequote.skipped", { toolId, reason });
    return;
  }

  const matchHash = computePrequoteMatchHash(identity);
  const input: CreatePrequoteInput = {
    prequoteId: `prequote-${randomUUID()}`,
    sessionId,
    matchHash,
    kind: "bridge",
    // Bridge prequote `family` is the SOURCE family (where the signer lives) —
    // mirrors the verdict provider/family pairing the gate reads back by kind.
    family: identity.sourceFamily,
    provider,
    // Bridge rows have two chain ids; only the SOURCE id maps onto the single
    // `chain_id` column (the dest id is part of the match-hash, not a column).
    chainId: identity.fromChainId,
    walletAddress: identity.sourceWallet,
    tokenIn: identity.fromToken,
    tokenOut: identity.toToken,
    amount: identity.amount,
    slippageBps: null,
    safetyVerdict: "unknown",
    safetyDetail: BRIDGE_SAFETY_DETAIL,
    routeRef: null,
    expiresAt: new Date(Date.now() + PREQUOTE_MAX_AGE_MS).toISOString(),
  };

  if (await writePrequoteRow(toolId, input)) {
    logger.info("protocol.prequote.recorded", {
      toolId,
      family: identity.sourceFamily,
      verdict: "unknown",
    });
  }
}
