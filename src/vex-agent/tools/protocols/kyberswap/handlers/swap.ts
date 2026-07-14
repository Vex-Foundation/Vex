/**
 * KyberSwap swap + chain + token handlers.
 *
 * Shared executeKyberSwap() is used by both swap.sell and swap.buy.
 */

import { getKyberAggregatorClient } from "@tools/kyberswap/aggregator/client.js";
import { getKyberTokenApiClient } from "@tools/kyberswap/token-api/client.js";
import { getKyberCommonClient } from "@tools/kyberswap/common/client.js";
import { getKyberChains, resolveChainSlug, slugToChainId } from "@tools/kyberswap/chains.js";
import {
  getKyberEvmClients,
  ensureKyberAllowance,
  sendKyberTransaction,
  verifyRouterAddress,
} from "@tools/kyberswap/evm-utils.js";
import {
  META_AGGREGATION_ROUTER_V2,
  NATIVE_TOKEN_ADDRESS,
  KYBERSWAP_FEE_BPS,
  KYBERSWAP_FEE_CHARGE_BY,
  KYBERSWAP_FEE_RECEIVER,
} from "@tools/kyberswap/constants.js";
import { ensureErc20Balance } from "@tools/evm-chains/erc20-balance-guard.js";
import { resolveTokenMetadataStrict, requireFeature, resolveChainWithId } from "@tools/kyberswap/helpers.js";
import { formatRouteSummary } from "../helpers.js";
import logger from "@utils/logger.js";
import { isRecord } from "@utils/validation-helpers.js";
import { VexError, ErrorCodes } from "../../../../../errors.js";
import type { ChainWallet } from "@tools/wallet/multi-auth.js";
import { resolveSigningWallet, walletScopeErrorToResult } from "@vex-agent/tools/internal/wallet/resolve.js";

import { parseUnits, formatUnits, getAddress, type Address, type Hex } from "viem";
import type { ToolResult } from "../../../types.js";
import type { ProtocolHandler, ProtocolExecutionContext } from "../../types.js";
import { str, num, ok, fail } from "../../handler-helpers.js";

// ── Read-only token safety surfacing for kyberswap.swap.quote (Stage 6b) ──
//
// The quote is informational: it surfaces honeypot / fee-on-transfer risk so
// the agent can see EVM token danger at quote time. It NEVER aborts — gating
// stays in executeKyberSwap. Each leg is one of:
//  - { native: true }                   native sentinel — no honeypot concept
//  - { isHoneypot, isFOT, tax }          live token API audit
//  - { checkFailed: true, reason }       fail-soft: bounded reason class only

/**
 * Bounded failure class for a swallowed honeypot/FoT check.
 *
 * NEVER carries raw provider/HTTP text. It is derived defensively from the
 * caught value's VexError code / numeric status / message keywords so neither
 * the log payload nor the quote output can leak URLs, HTML, API keys, or status
 * bodies.
 */
type SafetyCheckFailureReason = "timeout" | "rate_limited" | "kyber_error" | "unavailable";

type QuoteSafetyLeg =
  | { readonly native: true }
  | { readonly isHoneypot: boolean; readonly isFOT: boolean; readonly tax: number }
  | { readonly checkFailed: true; readonly reason: SafetyCheckFailureReason };

interface QuoteSafety {
  readonly tokenIn: QuoteSafetyLeg;
  readonly tokenOut: QuoteSafetyLeg;
}

/**
 * Classify a caught (untrusted) value into a bounded failure reason.
 *
 * Defensive: treats the value as `unknown`, inspects only a VexError `code`, a
 * numeric `status`, and lowercased keyword matches on a string `message`. The
 * raw message text is NEVER returned or logged — only one of the four bounded
 * literals leaves this function.
 */
function classifySafetyCheckFailure(err: unknown): SafetyCheckFailureReason {
  const code = err instanceof VexError ? err.code : undefined;
  if (code === ErrorCodes.KYBER_TIMEOUT || code === ErrorCodes.HTTP_TIMEOUT) return "timeout";
  if (code === ErrorCodes.KYBER_RATE_LIMITED) return "rate_limited";
  if (typeof code === "string" && code.startsWith("KYBER_")) return "kyber_error";

  const record = isRecord(err) ? err : undefined;
  const status = record && typeof record.status === "number" ? record.status : undefined;
  if (status === 429) return "rate_limited";
  if (status === 408 || status === 504) return "timeout";

  const message = record && typeof record.message === "string" ? record.message.toLowerCase() : "";
  if (message.includes("429") || message.includes("rate limit") || message.includes("too many requests")) {
    return "rate_limited";
  }
  if (message.includes("timeout") || message.includes("timed out") || message.includes("etimedout") || message.includes("abort")) {
    return "timeout";
  }
  return "unavailable";
}

/**
 * Resolve the read-only safety leg for a single resolved token.
 *
 * Native tokens have no honeypot concept and are marked, not checked.
 * Any failure of the (untrusted, network) honeypot check is swallowed into a
 * bounded `{ checkFailed: true, reason }` marker — raw provider/HTTP text
 * (URLs, HTML, keys, status bodies) is never propagated into the log payload
 * or the quote output.
 */
async function resolveQuoteSafetyLeg(
  chainId: number,
  token: { readonly address: Address; readonly isNative: boolean },
): Promise<QuoteSafetyLeg> {
  if (token.isNative) return { native: true };
  try {
    const info = await getKyberTokenApiClient().getHoneypotFotInfo(chainId, token.address);
    return { isHoneypot: info.isHoneypot, isFOT: info.isFOT, tax: info.tax };
  } catch (err) {
    // Read-only fail-soft: log only a bounded class (no raw provider/HTTP text).
    const reason = classifySafetyCheckFailure(err);
    logger.warn("kyberswap.swap.quote.safety_check_failed", {
      chainId,
      address: token.address,
      reason,
    });
    return { checkFailed: true, reason };
  }
}

/**
 * Vex integrator fee fields for GET /routes. Sourced ONLY from the
 * product-owner-reviewed venue constants (never from tool/model params) and
 * spread IDENTICALLY into the quote and the execute re-quote, so the route the
 * user was shown and the route that broadcasts carry the same fee line. Kyber
 * echoes these back inside `routeSummary.extraFee`, which POST /route/build
 * consumes verbatim — we never mutate the summary.
 */
const VEX_INTEGRATOR_FEE_ROUTE_PARAMS = {
  feeAmount: String(KYBERSWAP_FEE_BPS),
  isInBps: true,
  chargeFeeBy: KYBERSWAP_FEE_CHARGE_BY,
  feeReceiver: KYBERSWAP_FEE_RECEIVER,
} as const;

// ── Shared swap execution (sell + buy use same routing, differ in trade_side) ──

async function executeKyberSwap(p: Record<string, unknown>, side: "buy" | "sell", context: ProtocolExecutionContext): Promise<ToolResult> {
  const chain = str(p, "chain"), tokenInRaw = str(p, "tokenIn"), tokenOutRaw = str(p, "tokenOut"), amountInRaw = str(p, "amountIn");
  if (!chain || !tokenInRaw || !tokenOutRaw || !amountInRaw) return fail("Missing required: chain, tokenIn, tokenOut, amountIn");

  const slug = resolveChainSlug(chain);
  requireFeature(slug, "aggregator");
  const chainId = slugToChainId(slug);
  // Strict: address-only for mutating swaps — symbols rejected
  const tokenIn = await resolveTokenMetadataStrict(tokenInRaw, chainId);
  const tokenOut = await resolveTokenMetadataStrict(tokenOutRaw, chainId);

  // Token safety gate — the ONLY hard block here is a CONFIRMED honeypot
  // (owner doctrine). FoT/high-tax is warn-only (the model decides, even in
  // full-autonomous + full-agent modes). The check call is fail-SOFT: a THROW
  // means the safety check is UNAVAILABLE (API down / 429 / timeout), which the
  // prequote gate already recorded as 'unknown' and allowed per doctrine — so a
  // transient external-API failure must NOT abort a legit trade. We emit ONE
  // bounded structural warn (a reason CLASS only — never raw provider/HTTP text)
  // and PROCEED. Confirmed honeypot caught here (even if the quote's check was
  // down) STILL aborts — that is the one hard gate.
  if (!tokenIn.isNative) {
    try {
      const inCheck = await getKyberTokenApiClient().getHoneypotFotInfo(chainId, tokenIn.address);
      if (inCheck.isHoneypot) return fail(`Token ${tokenIn.symbol} (${tokenIn.address}) flagged as honeypot. Aborting swap.`);
      if (inCheck.isFOT && inCheck.tax > 0) logger.warn("kyberswap.swap.fot_warning", { token: tokenIn.symbol, address: tokenIn.address, tax: inCheck.tax });
    } catch (err) {
      logger.warn("kyberswap.swap.safety_check_failed", { address: tokenIn.address, reason: classifySafetyCheckFailure(err) });
    }
  }
  if (!tokenOut.isNative) {
    try {
      const outCheck = await getKyberTokenApiClient().getHoneypotFotInfo(chainId, tokenOut.address);
      if (outCheck.isHoneypot) return fail(`Token ${tokenOut.symbol} (${tokenOut.address}) flagged as honeypot. Aborting swap.`);
      if (outCheck.isFOT && outCheck.tax > 0) logger.warn("kyberswap.swap.fot_warning", { token: tokenOut.symbol, address: tokenOut.address, tax: outCheck.tax });
    } catch (err) {
      logger.warn("kyberswap.swap.safety_check_failed", { address: tokenOut.address, reason: classifySafetyCheckFailure(err) });
    }
  }
  const amountIn = parseUnits(amountInRaw, tokenIn.decimals);

  const routeResp = await getKyberAggregatorClient().getRoute(slug, {
    tokenIn: tokenIn.address,
    tokenOut: tokenOut.address,
    amountIn: amountIn.toString(),
    ...VEX_INTEGRATOR_FEE_ROUTE_PARAMS,
  });
  const { routeSummary, routerAddress } = routeResp.data;
  verifyRouterAddress(routerAddress, META_AGGREGATION_ROUTER_V2);

  if (p.dryRun === true) {
    return ok({ dryRun: true, side, chain: slug, routeSummary: formatRouteSummary(routeSummary), routerAddress });
  }

  // Per-session signing wallet (puzzle 5 phase 5D-protocols) — resolved AFTER the
  // dryRun gate so a preview never decrypts a key. Real broadcast only.
  let signer: ChainWallet;
  try {
    signer = resolveSigningWallet(context.walletResolution, context.walletPolicy, "eip155");
  } catch (err) {
    return walletScopeErrorToResult(err);
  }
  if (signer.family !== "eip155") return fail("Resolved wallet family mismatch.");

  const { publicClient, walletClient } = getKyberEvmClients(slug, signer.privateKey);
  if (tokenIn.address.toLowerCase() !== NATIVE_TOKEN_ADDRESS.toLowerCase()) {
    await ensureErc20Balance(publicClient, {
      token: tokenIn.address,
      owner: getAddress(signer.address),
      required: amountIn,
      decimals: tokenIn.decimals,
      label: tokenIn.symbol,
    });
    await ensureKyberAllowance(publicClient, walletClient, tokenIn.address, routerAddress, amountIn);
  }

  const slippage = num(p, "slippageBps") ?? 50;
  const buildResp = await getKyberAggregatorClient().buildRoute(slug, {
    routeSummary,
    sender: signer.address,
    recipient: (str(p, "recipient") || signer.address) as Address,
    slippageTolerance: slippage,
  });

  // Verify the BUILD-response router before broadcasting: the tx is sent to
  // buildResp.data.routerAddress (and approvals were granted to the router), so
  // an attacker-controlled build router is a direct theft vector. Fail closed
  // on mismatch — the route-response check above only guards the approval step.
  verifyRouterAddress(buildResp.data.routerAddress, META_AGGREGATION_ROUTER_V2);

  const txHash = await sendKyberTransaction(publicClient, walletClient, {
    to: getAddress(buildResp.data.routerAddress),
    data: buildResp.data.data as Hex,
    value: BigInt(buildResp.data.transactionValue),
  });

  const inputIsNative = tokenIn.address.toLowerCase() === NATIVE_TOKEN_ADDRESS.toLowerCase();
  const outputIsNative = tokenOut.address.toLowerCase() === NATIVE_TOKEN_ADDRESS.toLowerCase();
  const hasNativeLeg = inputIsNative || outputIsNative;

  // Benchmark: only when native token is one leg
  const { resolveChainBenchmark } = await import("@vex-agent/sync/benchmark.js");
  const benchmarkAssetKey = hasNativeLeg ? resolveChainBenchmark(slug) : undefined;

  return {
    success: true,
    output: JSON.stringify({ txHash, side, chain: slug, tokenIn: tokenIn.symbol, tokenOut: tokenOut.symbol, amountIn: buildResp.data.amountIn, amountOut: buildResp.data.amountOut, amountInUsd: buildResp.data.amountInUsd, amountOutUsd: buildResp.data.amountOutUsd }, null, 2),
    data: { txHash, _tradeCapture: {
      type: "swap", chain: slug, status: "executed",
      inputToken: tokenIn.symbol, outputToken: tokenOut.symbol,
      inputTokenAddress: tokenIn.address, outputTokenAddress: tokenOut.address,
      inputAmount: buildResp.data.amountIn, outputAmount: buildResp.data.amountOut,
      signature: txHash, walletAddress: signer.address, tradeSide: side,
      instrumentKey: `${slug}:${side === "buy" ? tokenOut.address : tokenIn.address}`,
      inputValueUsd: buildResp.data.amountInUsd, outputValueUsd: buildResp.data.amountOutUsd,
      feeValueUsd: buildResp.data.gasUsd, valuationSource: "kyberswap_exact",
      benchmarkAssetKey: benchmarkAssetKey ?? undefined,
      settlementAssetKey: side === "buy" ? tokenIn.symbol : tokenOut.symbol,
      inputValueNative: inputIsNative ? formatUnits(amountIn, tokenIn.decimals) : undefined,
      outputValueNative: outputIsNative ? formatUnits(BigInt(buildResp.data.amountOut), tokenOut.decimals) : undefined,
      meta: { dex: "kyberswap", side },
    } },
  };
}

// ── Handler map ──────────────────────────────────────────────────

export const SWAP_HANDLERS: Record<string, ProtocolHandler> = {
  // ── Chains ───────────────────────────────────────────────────────
  "kyberswap.chains": async () => ok(getKyberChains()),
  "kyberswap.chains.supported": async () => ok(await getKyberCommonClient().getSupportedChains()),

  // ── Tokens ───────────────────────────────────────────────────────
  "kyberswap.tokens.check": async (p) => {
    const chain = str(p, "chain"), address = str(p, "address");
    if (!chain || !address) return fail("Missing required: chain, address");
    const { chainId } = resolveChainWithId(chain);
    const info = await getKyberTokenApiClient().getHoneypotFotInfo(chainId, address);
    return ok({ chain, chainId, address, ...info });
  },

  // ── Swap ─────────────────────────────────────────────────────────
  "kyberswap.swap.quote": async (p) => {
    const chain = str(p, "chain"), tokenInRaw = str(p, "tokenIn"), tokenOutRaw = str(p, "tokenOut"), amountInRaw = str(p, "amountIn");
    if (!chain || !tokenInRaw || !tokenOutRaw || !amountInRaw) return fail("Missing required: chain, tokenIn, tokenOut, amountIn");

    const slug = resolveChainSlug(chain);
    requireFeature(slug, "aggregator");
    const chainId = slugToChainId(slug);
    // Strict: address-only (+ native sentinel/keyword) — symbols are NOT
    // resolved via Kyber's DEX search here. A symbol like "USDC" can match the
    // wrong contract (e.g. axlUSDC) and seed a prequote for the wrong token, so
    // the quote resolution is symmetric with execute (resolveTokenMetadataStrict)
    // and EVM symbols must be resolved with token_find first. Native ETH/native
    // still quotes — resolveTokenMetadataStrict accepts it via isNativeTokenInput.
    const tokenIn = await resolveTokenMetadataStrict(tokenInRaw, chainId);
    const tokenOut = await resolveTokenMetadataStrict(tokenOutRaw, chainId);
    const amountIn = parseUnits(amountInRaw, tokenIn.decimals).toString();

    // Read-only token safety + route fetched in parallel — additive, never gates.
    const [response, safetyIn, safetyOut] = await Promise.all([
      getKyberAggregatorClient().getRoute(slug, {
        tokenIn: tokenIn.address,
        tokenOut: tokenOut.address,
        amountIn,
        ...VEX_INTEGRATOR_FEE_ROUTE_PARAMS,
      }),
      resolveQuoteSafetyLeg(chainId, tokenIn),
      resolveQuoteSafetyLeg(chainId, tokenOut),
    ]);
    const safety: QuoteSafety = { tokenIn: safetyIn, tokenOut: safetyOut };

    return ok({
      chain: slug, chainId,
      tokenIn: { address: tokenIn.address, symbol: tokenIn.symbol, decimals: tokenIn.decimals },
      tokenOut: { address: tokenOut.address, symbol: tokenOut.symbol, decimals: tokenOut.decimals },
      routeSummary: formatRouteSummary(response.data.routeSummary),
      routerAddress: response.data.routerAddress,
      safety,
    });
  },

  "kyberswap.swap.sell": (p, ctx) => executeKyberSwap(p, "sell", ctx),
  "kyberswap.swap.buy": (p, ctx) => executeKyberSwap(p, "buy", ctx),
};
