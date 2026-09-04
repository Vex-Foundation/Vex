/**
 * Token-leg resolution for Uniswap - ADDRESS-ONLY (or native).
 *
 * Uniswap has no symbol search, so a bare symbol is rejected rather than
 * guessed at. This mirrors kyberswap's strict resolution and keeps the quote
 * symmetric with the execute (so the prequote match-hash collides).
 */

import { getAddress, isAddress } from "viem";

import { getUniswapPublicClient } from "@tools/uniswap/evm-client.js";
import { readUniswapErc20Metadata } from "@tools/uniswap/erc20.js";
import type { UniswapDeployment } from "@tools/uniswap/deployments.js";
import type { UniswapToken } from "@tools/uniswap/types.js";

import { VexError, ErrorCodes } from "../../../../../../errors.js";
import { isNativeInput, nativeSymbolFor } from "./chain-native.js";

/**
 * Resolve a token leg. Native ("eth"/"native"/sentinel) routes as WETH; a hex
 * address reads metadata on-chain; a bare symbol is rejected (address-only).
 */
export async function resolveUniswapToken(
  deployment: UniswapDeployment,
  input: string,
): Promise<UniswapToken> {
  if (isNativeInput(input)) {
    return { address: getAddress(deployment.weth), symbol: nativeSymbolFor(deployment.chainId), decimals: 18, isNative: true };
  }
  if (!isAddress(input)) {
    throw new VexError(
      ErrorCodes.KYBER_TOKEN_NOT_FOUND,
      `Token "${input}" is not a valid address. Uniswap has no symbol search - pass the exact contract address (resolve it with a discovery tool first) or native ETH.`,
    );
  }
  const client = getUniswapPublicClient(deployment);
  const meta = await readUniswapErc20Metadata(client, getAddress(input));
  return { address: meta.address, symbol: meta.symbol, decimals: meta.decimals, isNative: false };
}
