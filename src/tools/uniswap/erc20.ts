/**
 * Uniswap ERC-20 helpers — metadata reads + spender allowlist validation.
 *
 * Approvals target ONLY a router in `UNISWAP_KNOWN_SPENDERS` (built from the
 * verified deployment registry), validated here. The allowance STAGING itself
 * (read current allowance, reset-if-needed, approve-exact, each as its own
 * durable, signed `agent_activity` broadcast) lives in the execute handler
 * (`tools/protocols/uniswap/handlers/swap.ts`) using `execute.ts`'s
 * `buildApproveTx` + staged sign/broadcast pair — per-broadcast durability
 * (plan §11.1) needs each approval on its own signed/persisted/confirmed
 * lifecycle, which a single blocking helper here could not provide.
 */

import type { Address, Chain, PublicClient, Transport } from "viem";

import { VexError, ErrorCodes } from "../../errors.js";
import logger from "../../utils/logger.js";
import { UNISWAP_ERC20_ABI } from "./abis.js";
import { UNISWAP_KNOWN_SPENDERS } from "./deployments.js";

export interface UniswapErc20Metadata {
  address: Address;
  symbol: string;
  decimals: number;
  isNative: false;
}

/** Read ERC-20 metadata directly from chain. decimals mandatory; symbol tolerant. */
export async function readUniswapErc20Metadata(
  client: PublicClient<Transport, Chain>,
  address: Address,
): Promise<UniswapErc20Metadata> {
  let decimals: number;
  try {
    decimals = await client.readContract({ address, abi: UNISWAP_ERC20_ABI, functionName: "decimals" });
  } catch {
    throw new VexError(
      ErrorCodes.KYBER_TOKEN_NOT_FOUND,
      `Cannot read decimals for ${address} — not a valid ERC-20 contract on this chain`,
      "Verify the token address and chain are correct.",
    );
  }
  let symbol = "UNKNOWN";
  try {
    symbol = await client.readContract({ address, abi: UNISWAP_ERC20_ABI, functionName: "symbol" });
  } catch {
    logger.debug({ event: "uniswap.erc20.symbol_failed", address });
  }
  return { address, symbol, decimals, isNative: false };
}

/** Verify a spender is an allowlisted Uniswap router. Throws otherwise. */
export function validateUniswapSpender(address: Address): void {
  if (!UNISWAP_KNOWN_SPENDERS.has(address.toLowerCase())) {
    throw new VexError(
      ErrorCodes.INVALID_SPENDER,
      `Spender ${address} is not a known Uniswap router`,
      "Approvals may only target a registered Uniswap V2 Router02 or V3 SwapRouter02.",
    );
  }
}

/** Read the current ERC-20 allowance a router holds for an owner. Pure read, no signer. */
export async function readUniswapAllowance(
  client: PublicClient<Transport, Chain>,
  token: Address,
  owner: Address,
  spender: Address,
): Promise<bigint> {
  return (await client.readContract({
    address: token,
    abi: UNISWAP_ERC20_ABI,
    functionName: "allowance",
    args: [owner, spender],
  })) as bigint;
}
