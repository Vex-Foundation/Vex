/**
 * Uniswap swap handlers — quote (read) + sell/buy (mutating).
 *
 * Keyless on-chain quoting (QuoterV2 + V2 getAmountsOut, best route) and
 * broadcast (V2 Router02 / V3 SwapRouter02) via the uniswap substrate under
 * `@tools/uniswap`. The quote embeds a structural SAFETY block (factory
 * allowlist + DexScreener min-liquidity + FoT signal) that the prequote
 * extractor re-validates into the pass/fail/unknown doctrine.
 *
 * Tokens are ADDRESS-ONLY (or native ETH) — Uniswap has no symbol search, so a
 * bare symbol is rejected (resolve it with a discovery tool first). This mirrors
 * kyberswap's strict resolution and keeps the quote symmetric with the execute
 * (so the prequote match-hash collides).
 */

import { parseUnits, formatUnits, getAddress, isAddress, type Address, type Hex } from "viem";

import { resolveUniswapDeployment } from "@tools/uniswap/chains.js";
import { getUniswapPublicClient, getUniswapEvmClients } from "@tools/uniswap/evm-client.js";
import { readUniswapErc20Metadata } from "@tools/uniswap/erc20.js";
import { ensureUniswapAllowanceExact } from "@tools/uniswap/erc20.js";
import { quoteBestRoute, applySlippage } from "@tools/uniswap/quote.js";
import { buildSwapTx, sendUniswapTransaction, NATIVE_TOKEN_ADDRESS } from "@tools/uniswap/execute.js";
import { checkRouteFactories, probeFotSignal, UNISWAP_MIN_LIQUIDITY_USD } from "@tools/uniswap/safety.js";
import type { UniswapDeployment } from "@tools/uniswap/deployments.js";
import type { UniswapToken, UniswapRoute } from "@tools/uniswap/types.js";
import { getDexScreenerClient } from "@tools/dexscreener/client.js";
import { getLocalChain } from "@tools/evm-chains/registry.js";
import { ensureErc20Balance } from "@tools/evm-chains/erc20-balance-guard.js";
import { pinTrackedToken } from "@vex-agent/db/repos/tracked-tokens.js";

import type { ChainWallet } from "@tools/wallet/multi-auth.js";
import { resolveSigningWallet, walletScopeErrorToResult } from "@vex-agent/tools/internal/wallet/resolve.js";
import { VexError, ErrorCodes } from "../../../../../errors.js";
import logger from "@utils/logger.js";
import type { ToolResult } from "../../../types.js";
import type { ProtocolHandler, ProtocolExecutionContext } from "../../types.js";
import { str, num, ok, fail } from "../../handler-helpers.js";

const DEFAULT_SLIPPAGE_BPS = 50;
const DEFAULT_DEADLINE_SECONDS = 600; // ~10 min

/** Native symbol per chain (display only — the routed address is always WETH). */
const NATIVE_SYMBOL: Record<number, string> = { 137: "POL", 56: "BNB" };

function nativeSymbolFor(chainId: number): string {
  return NATIVE_SYMBOL[chainId] ?? "ETH";
}

function isNativeInput(input: string): boolean {
  const lower = input.toLowerCase();
  return lower === "native" || lower === "eth" || lower === NATIVE_TOKEN_ADDRESS.toLowerCase();
}

/**
 * Resolve a token leg. Native ("eth"/"native"/sentinel) routes as WETH; a hex
 * address reads metadata on-chain; a bare symbol is rejected (address-only).
 */
async function resolveUniswapToken(
  deployment: UniswapDeployment,
  input: string,
): Promise<UniswapToken> {
  if (isNativeInput(input)) {
    return { address: getAddress(deployment.weth), symbol: nativeSymbolFor(deployment.chainId), decimals: 18, isNative: true };
  }
  if (!isAddress(input)) {
    throw new VexError(
      ErrorCodes.KYBER_TOKEN_NOT_FOUND,
      `Token "${input}" is not a valid address. Uniswap has no symbol search — pass the exact contract address (resolve it with a discovery tool first) or native ETH.`,
    );
  }
  const client = getUniswapPublicClient(deployment);
  const meta = await readUniswapErc20Metadata(client, getAddress(input));
  return { address: meta.address, symbol: meta.symbol, decimals: meta.decimals, isNative: false };
}

/** Resolve the chain param to a deployment, or throw a clean error. */
function requireDeployment(chain: string): UniswapDeployment {
  const deployment = resolveUniswapDeployment(chain);
  if (!deployment) {
    throw new VexError(
      ErrorCodes.KYBER_UNSUPPORTED_CHAIN,
      `Uniswap has no verified deployment for chain "${chain}".`,
      "Uniswap is a fallback venue on Robinhood Chain and the major EVM chains; prefer kyberswap, which is primary wherever it is supported.",
    );
  }
  return deployment;
}

// ── Safety block (embedded in the quote result; re-validated by the extractor) ──

type UniswapSafetyBlock = {
  factory: { checked: true; allowlisted: boolean } | { checkFailed: true };
  liquidity:
    | { checked: true; usd: number | null; aboveThreshold: boolean }
    | { checkFailed: true; reason: string };
  fot: { suspected: boolean };
};

async function checkOutputLiquidity(
  deployment: UniswapDeployment,
  tokenOut: UniswapToken,
): Promise<UniswapSafetyBlock["liquidity"]> {
  // Native output → WETH: liquidity is not a scam signal for the native wrapper.
  if (tokenOut.isNative) return { checked: true, usd: null, aboveThreshold: true };
  try {
    const pairs = await getDexScreenerClient().getTokens(deployment.key, tokenOut.address);
    let bestUsd: number | null = null;
    for (const pair of pairs) {
      if (pair.baseToken?.address?.toLowerCase() !== tokenOut.address.toLowerCase()) continue;
      const usd = pair.liquidity?.usd ?? null;
      if (usd !== null && (bestUsd === null || usd > bestUsd)) bestUsd = usd;
    }
    return { checked: true, usd: bestUsd, aboveThreshold: bestUsd !== null && bestUsd >= UNISWAP_MIN_LIQUIDITY_USD };
  } catch {
    return { checkFailed: true, reason: "unavailable" };
  }
}

interface QuotedRoute {
  route: UniswapRoute;
  amountOut: bigint;
  minAmountOut: bigint;
  priceImpact?: number;
  slippageBps: number;
}

async function computeQuote(
  deployment: UniswapDeployment,
  tokenIn: UniswapToken,
  tokenOut: UniswapToken,
  amountIn: bigint,
  slippageBps: number,
): Promise<QuotedRoute> {
  const client = getUniswapPublicClient(deployment);
  const best = await quoteBestRoute(client, { deployment, tokenIn, tokenOut, amountIn });
  if (!best) {
    throw new VexError(
      ErrorCodes.KYBER_ROUTE_NOT_FOUND,
      `No Uniswap route found for ${tokenIn.symbol} → ${tokenOut.symbol} on ${deployment.name}.`,
      "The pair may have no liquidity on this chain.",
    );
  }
  return {
    route: best.route,
    amountOut: best.route.amountOut,
    minAmountOut: applySlippage(best.route.amountOut, slippageBps),
    ...(best.priceImpact !== undefined ? { priceImpact: best.priceImpact } : {}),
    slippageBps,
  };
}

function routerFor(deployment: UniswapDeployment, route: UniswapRoute): Address {
  const router = route.version === "v2" ? deployment.v2?.router02 : deployment.v3?.swapRouter02;
  if (!router) throw new VexError(ErrorCodes.SWAP_FAILED, `No ${route.version} router on ${deployment.name}.`);
  return getAddress(router);
}

// ── Quote handler (read-only) ────────────────────────────────────────────────

async function uniswapSwapQuote(p: Record<string, unknown>): Promise<ToolResult> {
  const chain = str(p, "chain"), tokenInRaw = str(p, "tokenIn"), tokenOutRaw = str(p, "tokenOut"), amountInRaw = str(p, "amountIn");
  if (!chain || !tokenInRaw || !tokenOutRaw || !amountInRaw) return fail("Missing required: chain, tokenIn, tokenOut, amountIn");

  const deployment = requireDeployment(chain);
  const tokenIn = await resolveUniswapToken(deployment, tokenInRaw);
  const tokenOut = await resolveUniswapToken(deployment, tokenOutRaw);
  if (tokenIn.address.toLowerCase() === tokenOut.address.toLowerCase() && tokenIn.isNative === tokenOut.isNative) {
    return fail("tokenIn and tokenOut resolve to the same token.");
  }
  const amountIn = parseUnits(amountInRaw, tokenIn.decimals);
  const slippageBps = num(p, "slippageBps") ?? DEFAULT_SLIPPAGE_BPS;

  const quoted = await computeQuote(deployment, tokenIn, tokenOut, amountIn, slippageBps);

  // Safety signals (LOCKED #5): factory allowlist + min-liquidity + FoT — never gate here.
  const client = getUniswapPublicClient(deployment);
  const [factory, liquidity, fotSuspected] = await Promise.all([
    checkRouteFactories(client, deployment, quoted.route),
    checkOutputLiquidity(deployment, tokenOut),
    tokenOut.isNative ? Promise.resolve(false) : probeFotSignal(client, deployment, tokenOut.address),
  ]);
  const safety: UniswapSafetyBlock = { factory, liquidity, fot: { suspected: fotSuspected } };

  return ok({
    chain: deployment.key,
    chainId: deployment.chainId,
    tokenIn: { address: tokenIn.address, symbol: tokenIn.symbol, decimals: tokenIn.decimals, isNative: tokenIn.isNative },
    tokenOut: { address: tokenOut.address, symbol: tokenOut.symbol, decimals: tokenOut.decimals, isNative: tokenOut.isNative },
    route: { version: quoted.route.version, path: quoted.route.path, fees: quoted.route.fees ?? null },
    amountIn: amountInRaw,
    amountInRaw: amountIn.toString(),
    amountOut: formatUnits(quoted.amountOut, tokenOut.decimals),
    amountOutRaw: quoted.amountOut.toString(),
    minAmountOut: formatUnits(quoted.minAmountOut, tokenOut.decimals),
    minAmountOutRaw: quoted.minAmountOut.toString(),
    slippageBps,
    priceImpact: quoted.priceImpact ?? null,
    gasEstimate: quoted.route.gasEstimate?.toString() ?? null,
    router: routerFor(deployment, quoted.route),
    spender: tokenIn.isNative ? null : routerFor(deployment, quoted.route),
    safety,
  });
}

// ── Execute (sell + buy share routing; differ only in trade side) ─────────────

async function executeUniswapSwap(
  p: Record<string, unknown>,
  side: "buy" | "sell",
  context: ProtocolExecutionContext,
): Promise<ToolResult> {
  const chain = str(p, "chain"), tokenInRaw = str(p, "tokenIn"), tokenOutRaw = str(p, "tokenOut"), amountInRaw = str(p, "amountIn");
  if (!chain || !tokenInRaw || !tokenOutRaw || !amountInRaw) return fail("Missing required: chain, tokenIn, tokenOut, amountIn");

  const deployment = requireDeployment(chain);
  const tokenIn = await resolveUniswapToken(deployment, tokenInRaw);
  const tokenOut = await resolveUniswapToken(deployment, tokenOutRaw);
  const amountIn = parseUnits(amountInRaw, tokenIn.decimals);
  const slippageBps = num(p, "slippageBps") ?? DEFAULT_SLIPPAGE_BPS;

  const quoted = await computeQuote(deployment, tokenIn, tokenOut, amountIn, slippageBps);

  if (p.dryRun === true) {
    return ok({
      dryRun: true, side, chain: deployment.key,
      route: { version: quoted.route.version, path: quoted.route.path, fees: quoted.route.fees ?? null },
      amountOut: formatUnits(quoted.amountOut, tokenOut.decimals),
      minAmountOut: formatUnits(quoted.minAmountOut, tokenOut.decimals),
      router: routerFor(deployment, quoted.route),
    });
  }

  // Per-session signing wallet — resolved AFTER dryRun so a preview never decrypts a key.
  let signer: ChainWallet;
  try {
    signer = resolveSigningWallet(context.walletResolution, context.walletPolicy, "eip155");
  } catch (err) {
    return walletScopeErrorToResult(err);
  }
  if (signer.family !== "eip155") return fail("Resolved wallet family mismatch.");

  const { publicClient, walletClient } = getUniswapEvmClients(deployment, signer.privateKey as Hex);
  const router = routerFor(deployment, quoted.route);

  // Guard the ERC-20 input balance before changing allowance or broadcasting.
  if (!tokenIn.isNative) {
    await ensureErc20Balance(publicClient, {
      token: tokenIn.address,
      owner: getAddress(signer.address),
      required: amountIn,
      decimals: tokenIn.decimals,
      label: tokenIn.symbol,
    });
    await ensureUniswapAllowanceExact(publicClient, walletClient, tokenIn.address, router, amountIn);
  }

  const recipientParam = str(p, "recipient");
  const recipient = recipientParam && isAddress(recipientParam) ? getAddress(recipientParam) : getAddress(signer.address);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + DEFAULT_DEADLINE_SECONDS);

  const tx = buildSwapTx({
    deployment,
    route: quoted.route,
    amountIn,
    minAmountOut: quoted.minAmountOut,
    recipient,
    deadline,
    tokenInIsNative: tokenIn.isNative,
    tokenOutIsNative: tokenOut.isNative,
  });

  const txHash = await sendUniswapTransaction(publicClient, walletClient, tx);
  const amountOutHuman = formatUnits(quoted.amountOut, tokenOut.decimals);

  logger.info("uniswap.swap.executed", { chain: deployment.key, version: quoted.route.version, side });

  // Auto-pin (fail-soft): non-native legs of a swap on a LOCAL chain join the
  // tracked_tokens set (seed ∪ pins) so balance scans and the portfolio keep
  // seeing them. A DB bookmark — never allowed to fail the swap result.
  if (getLocalChain(deployment.chainId)) {
    for (const leg of [tokenIn, tokenOut]) {
      if (leg.isNative) continue;
      try {
        await pinTrackedToken({
          walletAddress: signer.address,
          chainId: deployment.chainId,
          tokenAddress: leg.address,
          source: "swap",
        });
      } catch (err) {
        logger.warn("uniswap.swap.auto_pin_failed", {
          chain: deployment.key,
          error: err instanceof Error ? err.name : "unknown",
        });
      }
    }
  }

  return {
    success: true,
    output: JSON.stringify({
      txHash, side, chain: deployment.key,
      tokenIn: tokenIn.symbol, tokenOut: tokenOut.symbol,
      amountIn: amountInRaw, amountOut: amountOutHuman,
      route: { version: quoted.route.version, path: quoted.route.path },
    }, null, 2),
    data: {
      txHash,
      _tradeCapture: {
        type: "swap",
        chain: deployment.key, // aligned with tools/evm-chains activityChainKeys ("robinhood")
        status: "executed",
        inputToken: tokenIn.symbol,
        outputToken: tokenOut.symbol,
        inputTokenAddress: tokenIn.address,
        outputTokenAddress: tokenOut.address,
        inputAmount: amountInRaw,
        // Quote-derived output can overstate an FoT recipient amount; receipt-log
        // or balance-delta settlement measurement is tracked separately.
        outputAmount: amountOutHuman,
        signature: txHash,
        walletAddress: signer.address,
        tradeSide: side,
        instrumentKey: `${deployment.key}:${side === "buy" ? tokenOut.address : tokenIn.address}`,
        valuationSource: "none",
        settlementAssetKey: side === "buy" ? tokenIn.symbol : tokenOut.symbol,
        meta: { dex: "uniswap", version: quoted.route.version, side },
      },
    },
  };
}

// ── Handler map ──────────────────────────────────────────────────────────────

export const UNISWAP_SWAP_HANDLERS: Record<string, ProtocolHandler> = {
  "uniswap.swap.quote": (p) => uniswapSwapQuote(p),
  "uniswap.swap.sell": (p, ctx) => executeUniswapSwap(p, "sell", ctx),
  "uniswap.swap.buy": (p, ctx) => executeUniswapSwap(p, "buy", ctx),
};
