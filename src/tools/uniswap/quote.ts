/**
 * Keyless on-chain Uniswap quoting — best route across V2 + V3.
 *
 * Reads only (QuoterV2 / V2 getAmountsOut / V2 getReserves) via `eth_call`; no
 * key, no broadcast. Candidate routes are fired with `Promise.allSettled` so a
 * missing pool (a revert) simply drops that candidate instead of failing the
 * whole quote. The best `amountOut` across every successful candidate wins.
 *
 * Route space (bounded):
 *   - V2: direct [in,out] + 2-hop [in,C,out] for each connector C.
 *   - V3: 1-hop across the chain's fee tiers + 2-hop [in,f1,C,f2,out] for each
 *     connector C over the non-dust fee tiers.
 * Native legs route as WETH (the router wraps/unwraps); `path` carries WETH.
 */

import {
  encodePacked,
  getAddress,
  type Address,
  type PublicClient,
  type Chain,
  type Transport,
} from "viem";

import {
  UNISWAP_V2_ROUTER_ABI,
  UNISWAP_V2_FACTORY_ABI,
  UNISWAP_V2_PAIR_ABI,
  UNISWAP_V3_QUOTER_V2_ABI,
} from "./abis.js";
import type { UniswapDeployment } from "./deployments.js";
import type { UniswapRoute, UniswapToken } from "./types.js";
import { VexError, ErrorCodes } from "../../errors.js";

/** Fee tiers used for the intermediate hops of a V3 2-hop route (skip the 0.01% dust tier). */
const V3_MULTIHOP_FEE_TIERS = [500, 3000, 10000] as const;

/** Distinct connector set for a pair, excluding the two legs themselves. */
function connectorsFor(
  deployment: UniswapDeployment,
  tokenIn: Address,
  tokenOut: Address,
): Address[] {
  const seen = new Set<string>([tokenIn.toLowerCase(), tokenOut.toLowerCase()]);
  const out: Address[] = [];
  for (const candidate of [deployment.weth, ...deployment.connectors]) {
    const lower = candidate.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    out.push(getAddress(candidate));
  }
  return out;
}

async function quoteV2Path(
  client: PublicClient<Transport, Chain>,
  router: Address,
  amountIn: bigint,
  path: readonly Address[],
): Promise<UniswapRoute | null> {
  try {
    const amounts = (await client.readContract({
      address: router,
      abi: UNISWAP_V2_ROUTER_ABI,
      functionName: "getAmountsOut",
      args: [amountIn, path as Address[]],
    })) as readonly bigint[];
    const amountOut = amounts[amounts.length - 1];
    if (amountOut === undefined || amountOut <= 0n) return null;
    return { version: "v2", path: [...path], amountOut };
  } catch {
    return null;
  }
}

async function quoteV3Single(
  client: PublicClient<Transport, Chain>,
  quoter: Address,
  tokenIn: Address,
  tokenOut: Address,
  amountIn: bigint,
  fee: number,
): Promise<UniswapRoute | null> {
  try {
    const result = (await client.readContract({
      address: quoter,
      abi: UNISWAP_V3_QUOTER_V2_ABI,
      functionName: "quoteExactInputSingle",
      args: [{ tokenIn, tokenOut, amountIn, fee, sqrtPriceLimitX96: 0n }],
    })) as readonly [bigint, bigint, number, bigint];
    const amountOut = result[0];
    if (amountOut <= 0n) return null;
    return { version: "v3", path: [tokenIn, tokenOut], fees: [fee], amountOut, gasEstimate: result[3] };
  } catch {
    return null;
  }
}

function encodeV3Path(tokens: readonly Address[], fees: readonly number[]): `0x${string}` {
  // path = token0 (fee0 token1)+ — alternating address/uint24.
  const types: string[] = ["address"];
  const values: unknown[] = [tokens[0]];
  for (let i = 0; i < fees.length; i += 1) {
    types.push("uint24", "address");
    values.push(fees[i], tokens[i + 1]);
  }
  return encodePacked(types, values);
}

async function quoteV3MultiHop(
  client: PublicClient<Transport, Chain>,
  quoter: Address,
  tokenIn: Address,
  connector: Address,
  tokenOut: Address,
  amountIn: bigint,
  fee1: number,
  fee2: number,
): Promise<UniswapRoute | null> {
  try {
    const path = encodeV3Path([tokenIn, connector, tokenOut], [fee1, fee2]);
    const result = (await client.readContract({
      address: quoter,
      abi: UNISWAP_V3_QUOTER_V2_ABI,
      functionName: "quoteExactInput",
      args: [path, amountIn],
    })) as readonly [bigint, readonly bigint[], readonly number[], bigint];
    const amountOut = result[0];
    if (amountOut <= 0n) return null;
    return {
      version: "v3",
      path: [tokenIn, connector, tokenOut],
      fees: [fee1, fee2],
      amountOut,
      gasEstimate: result[3],
    };
  } catch {
    return null;
  }
}

/**
 * Best-effort V2 price impact for a DIRECT [in,out] route, from the pair
 * reserves (spot vs execution price). Undefined for multi-hop / V3 / on any
 * read failure — purely informational, never gates.
 */
async function computeV2DirectPriceImpact(
  client: PublicClient<Transport, Chain>,
  deployment: UniswapDeployment,
  tokenIn: Address,
  tokenOut: Address,
  amountIn: bigint,
  amountOut: bigint,
): Promise<number | undefined> {
  if (!deployment.v2) return undefined;
  try {
    const pair = (await client.readContract({
      address: deployment.v2.factory,
      abi: UNISWAP_V2_FACTORY_ABI,
      functionName: "getPair",
      args: [tokenIn, tokenOut],
    })) as Address;
    if (/^0x0+$/.test(pair)) return undefined;
    const [reserve0, reserve1] = (await client.readContract({
      address: pair,
      abi: UNISWAP_V2_PAIR_ABI,
      functionName: "getReserves",
    })) as readonly [bigint, bigint, number];
    // token0 is the lower address; orient reserves to (in, out).
    const inIsToken0 = tokenIn.toLowerCase() < tokenOut.toLowerCase();
    const reserveIn = inIsToken0 ? reserve0 : reserve1;
    const reserveOut = inIsToken0 ? reserve1 : reserve0;
    if (reserveIn <= 0n || reserveOut <= 0n) return undefined;
    // Spot out per in (before trade) vs realized out per in. Use float — this is
    // an informational estimate, not settlement math.
    const spot = Number(reserveOut) / Number(reserveIn);
    const realized = Number(amountOut) / Number(amountIn);
    if (spot <= 0) return undefined;
    const impact = 1 - realized / spot;
    return impact > 0 && Number.isFinite(impact) ? impact : 0;
  } catch {
    return undefined;
  }
}

export interface QuoteRouteArgs {
  readonly deployment: UniswapDeployment;
  readonly tokenIn: UniswapToken;
  readonly tokenOut: UniswapToken;
  readonly amountIn: bigint;
}

/**
 * Quote the best route across V2 + V3. Returns the winning `UniswapRoute` plus a
 * best-effort price impact, or `null` when no route yields output (no pool /
 * fully illiquid). Native legs are already resolved to WETH by the caller.
 */
export async function quoteBestRoute(
  client: PublicClient<Transport, Chain>,
  args: QuoteRouteArgs,
): Promise<{ route: UniswapRoute; priceImpact?: number } | null> {
  const { deployment, tokenIn, tokenOut, amountIn } = args;
  const inAddr = tokenIn.address;
  const outAddr = tokenOut.address;
  if (inAddr.toLowerCase() === outAddr.toLowerCase()) return null;

  const connectors = connectorsFor(deployment, inAddr, outAddr);
  const candidates: Promise<UniswapRoute | null>[] = [];

  // ── V2 ──
  if (deployment.v2) {
    const router = deployment.v2.router02;
    candidates.push(quoteV2Path(client, router, amountIn, [inAddr, outAddr]));
    for (const c of connectors) {
      candidates.push(quoteV2Path(client, router, amountIn, [inAddr, c, outAddr]));
    }
  }

  // ── V3 ──
  if (deployment.v3) {
    const quoter = deployment.v3.quoterV2;
    for (const fee of deployment.v3.feeTiers) {
      candidates.push(quoteV3Single(client, quoter, inAddr, outAddr, amountIn, fee));
    }
    for (const c of connectors) {
      for (const fee1 of V3_MULTIHOP_FEE_TIERS) {
        for (const fee2 of V3_MULTIHOP_FEE_TIERS) {
          candidates.push(quoteV3MultiHop(client, quoter, inAddr, c, outAddr, amountIn, fee1, fee2));
        }
      }
    }
  }

  const settled = await Promise.allSettled(candidates);
  let best: UniswapRoute | null = null;
  for (const s of settled) {
    if (s.status !== "fulfilled" || s.value === null) continue;
    if (best === null || s.value.amountOut > best.amountOut) best = s.value;
  }
  if (best === null) return null;

  const priceImpact =
    best.version === "v2" && best.path.length === 2
      ? await computeV2DirectPriceImpact(client, deployment, inAddr, outAddr, amountIn, best.amountOut)
      : undefined;

  return priceImpact !== undefined ? { route: best, priceImpact } : { route: best };
}

/**
 * minAmountOut = amountOut * (10000 - slippageBps) / 10000, floored.
 *
 * REJECTS an out-of-domain tolerance; it used to
 * `Math.max(0, Math.min(10_000, Math.floor(bps)))`, which silently turned a
 * caller's 50,000 into a 100% tolerance — a minAmountOut of zero, accepting any
 * output at all — with no error and a normal-looking quote. Same doctrine as
 * `runtime/bps-param.ts`: reject, never coerce, at a price-protection boundary.
 *
 * This bounds the ARITHMETIC domain only. Vex's product ceiling (currently 1000
 * bps) is a separate, stricter rule enforced at the handler
 * (`slippage-policy.ts`), which is the layer that may hold a product opinion —
 * `src/tools/**` must not import `src/vex-agent/**`.
 */
export function applySlippage(amountOut: bigint, slippageBps: number): bigint {
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > 10_000) {
    throw new VexError(
      ErrorCodes.INVALID_AMOUNT,
      `Invalid slippageBps: ${slippageBps}`,
      "slippageBps must be a whole number of basis points between 0 and 10000 (1 bps = 0.01%).",
    );
  }
  return (amountOut * (10_000n - BigInt(slippageBps))) / 10_000n;
}
