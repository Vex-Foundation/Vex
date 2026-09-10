/** Per-execute V4 binding with fresh quote and decimal checks before each signature. */
import { getAddress, type Address } from "viem";
import { applySlippage } from "@tools/uniswap/quote.js";
import { quoteBoundV4Pool, quoteFreshV4Pool } from "@tools/uniswap/v4-quote.js";
import type { V4RouteBinding } from "@tools/uniswap/v4-types.js";
import type { UniswapToken } from "@tools/uniswap/types.js";
import { v4Refusal } from "@tools/uniswap/v4-pool.js";
import { validateUniswapSpender } from "@tools/uniswap/erc20.js";
import { UNISWAP_ERC20_ABI } from "@tools/uniswap/abis.js";
import type { UniswapDeployment } from "@tools/uniswap/deployments.js";
import type { getUniswapPublicClient } from "@tools/uniswap/evm-client.js";
import type { UniswapExecutionSnapshot } from "../../../quote-authority/uniswap.js";
import type { QuotedRoute } from "./route-quote.js";

export async function revalidateV4Quote(input: {
  readonly client: ReturnType<typeof getUniswapPublicClient>;
  readonly deployment: UniswapDeployment;
  readonly approved: UniswapExecutionSnapshot;
  readonly wallet: Address;
  readonly signal?: AbortSignal;
  /** Fresh per-execute data only. The final quote still simulates live state. */
  readonly freshBinding?: V4RouteBinding;
  readonly resolvedTokens?: readonly UniswapToken[];
}): Promise<QuotedRoute> {
  input.signal?.throwIfAborted();
  const { approved, deployment, client } = input;
  if (!approved.v4 || approved.chainId !== deployment.chainId || approved.v4.recipient.toLowerCase() !== input.wallet.toLowerCase()) throw v4Refusal("chain or recipient differs from approval");
  if (Date.parse(approved.expiresAt) <= Date.now()) throw v4Refusal("approved quote expired");
  const minAmountOut = applySlippage(BigInt(approved.approvedAmountOutRaw), approved.slippageBps);
  if (minAmountOut <= 0n || minAmountOut.toString() !== approved.approvedMinOutRaw) throw v4Refusal("approved output floor is inconsistent");
  for (const token of [approved.tokenIn, approved.tokenOut]) {
    if (token.isNative) { if (token.decimals !== 18) throw v4Refusal("native decimals changed"); continue; }
    const resolved = input.resolvedTokens?.find(t => t.address.toLowerCase() === token.address.toLowerCase());
    const decimals = resolved?.decimals ?? await client.readContract({ address: getAddress(token.address), abi: UNISWAP_ERC20_ABI, functionName: "decimals" });
    if (decimals !== token.decimals) throw v4Refusal("token decimals changed");
  }
  validateUniswapSpender(approved.v4.route.permit2, deployment.chainId);
  validateUniswapSpender(approved.v4.route.universalRouter, deployment.chainId);
  const route = input.freshBinding
    ? await quoteFreshV4Pool(client, deployment, approved.v4.route, input.freshBinding, BigInt(approved.swapAmountRaw))
    : await quoteBoundV4Pool(client, deployment, approved.v4.route, BigInt(approved.swapAmountRaw));
  const actualIn = route.path[0], actualOut = route.path[1];
  for (const [token, currency] of [[approved.tokenIn, actualIn], [approved.tokenOut, actualOut]] as const) {
    const expected = token.isNative ? deployment.weth : token.address;
    const routed = currency === "0x0000000000000000000000000000000000000000" ? deployment.weth : currency;
    if (routed?.toLowerCase() !== expected.toLowerCase()) throw v4Refusal("pool direction differs from the requested tokens");
  }
  if (route.amountOut < minAmountOut) throw v4Refusal("fresh quote is below the approved minimum output");
  input.signal?.throwIfAborted();
  return { route, amountOut: route.amountOut, minAmountOut, slippageBps: approved.slippageBps,
    v4FeeObservation: {
      approvedLpFee: approved.v4.route.observedLpFee,
      currentLpFee: route.v4.observedLpFee,
      protection: "A dynamic fee may increase only within the unchanged approved output floor: the fresh quote must meet it and the router enforces it on-chain.",
    },
  };
}
