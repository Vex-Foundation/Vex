/** V4 authority re-read at the last signing boundary, shared by every pre-swap leg. */
import { getAddress, type Address } from "viem";
import { applySlippage } from "@tools/uniswap/quote.js";
import { quoteBoundV4Pool } from "@tools/uniswap/v4-quote.js";
import { v4Refusal } from "@tools/uniswap/v4-pool.js";
import { readUniswapErc20Metadata, validateUniswapSpender } from "@tools/uniswap/erc20.js";
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
}): Promise<QuotedRoute> {
  input.signal?.throwIfAborted();
  const { approved, deployment, client } = input;
  if (!approved.v4 || approved.chainId !== deployment.chainId || approved.v4.recipient.toLowerCase() !== input.wallet.toLowerCase()) throw v4Refusal("chain or recipient differs from approval");
  if (Date.parse(approved.expiresAt) <= Date.now()) throw v4Refusal("approved quote expired");
  const minAmountOut = applySlippage(BigInt(approved.approvedAmountOutRaw), approved.slippageBps);
  if (minAmountOut <= 0n || minAmountOut.toString() !== approved.approvedMinOutRaw) throw v4Refusal("approved output floor is inconsistent");
  for (const token of [approved.tokenIn, approved.tokenOut]) {
    if (token.isNative) { if (token.decimals !== 18) throw v4Refusal("native decimals changed"); continue; }
    const fresh = await readUniswapErc20Metadata(client, getAddress(token.address));
    if (fresh.decimals !== token.decimals) throw v4Refusal("token decimals changed");
  }
  validateUniswapSpender(approved.v4.route.permit2, deployment.chainId);
  validateUniswapSpender(approved.v4.route.universalRouter, deployment.chainId);
  const route = await quoteBoundV4Pool(client, deployment, approved.v4.route, BigInt(approved.swapAmountRaw));
  const actualIn = route.path[0], actualOut = route.path[1];
  for (const [token, currency] of [[approved.tokenIn, actualIn], [approved.tokenOut, actualOut]] as const) {
    const expected = token.isNative ? deployment.weth : token.address;
    const routed = currency === "0x0000000000000000000000000000000000000000" ? deployment.weth : currency;
    if (routed?.toLowerCase() !== expected.toLowerCase()) throw v4Refusal("pool direction differs from the requested tokens");
  }
  if (route.amountOut < minAmountOut) throw v4Refusal("fresh quote is below the approved minimum output");
  input.signal?.throwIfAborted();
  return { route, amountOut: route.amountOut, minAmountOut, slippageBps: approved.slippageBps };
}
