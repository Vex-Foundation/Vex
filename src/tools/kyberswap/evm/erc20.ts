/**
 * KyberSwap ERC-20 operations: metadata reads, spender validation, and
 * transaction sending. Allowance planning lives in `evm/allowance-plan.ts`
 * (read-only decision, separated from broadcasting per plan §11.1).
 */

import {
  getAddress,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type WalletClient,
  type Transport,
} from "viem";
import { VexError, ErrorCodes } from "../../../errors.js";
import { waitForSuccessfulReceipt } from "@tools/evm-chains/receipt-guard.js";
import { KYBER_KNOWN_SPENDERS } from "../constants.js";
import logger from "../../../utils/logger.js";
import type { KyberChainSlug } from "../types.js";
import { ERC20_ABI, getKyberPublicClient } from "./config.js";

// ── On-chain ERC-20 metadata ────────────────────────────────────────

export interface Erc20Metadata {
  address: Address;
  symbol: string;
  name: string;
  decimals: number;
  isNative: false;
}

/**
 * Read ERC-20 metadata directly from chain.
 *
 * Tolerant handling:
 * - decimals() — mandatory, throw if missing (not a valid ERC-20)
 * - symbol() — optional, some tokens return bytes32 or revert → "UNKNOWN"
 * - name() — optional, some tokens revert → "Unknown Token"
 */
export async function readErc20Metadata(slug: KyberChainSlug, address: Address): Promise<Erc20Metadata> {
  const client = getKyberPublicClient(slug);

  // decimals — mandatory
  let decimals: number;
  try {
    decimals = await client.readContract({
      address,
      abi: ERC20_ABI,
      functionName: "decimals",
    });
  } catch (err) {
    throw new VexError(
      ErrorCodes.KYBER_TOKEN_NOT_FOUND,
      `Cannot read decimals for ${address} on ${slug} — not a valid ERC-20 contract`,
      "Verify the token address and chain are correct.",
    );
  }

  // symbol — optional, tolerant
  let symbol = "UNKNOWN";
  try {
    symbol = await client.readContract({
      address,
      abi: ERC20_ABI,
      functionName: "symbol",
    });
  } catch {
    logger.debug({ event: "kyberswap.erc20.symbol_failed", address, slug });
  }

  // name — optional, tolerant
  let name = "Unknown Token";
  try {
    name = await client.readContract({
      address,
      abi: ERC20_ABI,
      functionName: "name",
    });
  } catch {
    logger.debug({ event: "kyberswap.erc20.name_failed", address, slug });
  }

  return { address, symbol, name, decimals, isNative: false as const };
}

// ── Spender validation ──────────────────────────────────────────────

/** Verify a spender address is in the KyberSwap known contracts allowlist. */
export function validateKyberSpender(address: Address): void {
  if (!KYBER_KNOWN_SPENDERS.has(address.toLowerCase())) {
    throw new VexError(
      ErrorCodes.INVALID_SPENDER,
      `Spender ${address} is not a known KyberSwap contract`,
      `Known: MetaAggregationRouterV2`,
    );
  }
}

/** Verify the router address from API response matches the expected constant. */
export function verifyRouterAddress(actual: Address, expected: Address): void {
  if (getAddress(actual) !== getAddress(expected)) {
    throw new VexError(
      ErrorCodes.KYBER_API_ERROR,
      `Router address mismatch: API returned ${actual}, expected ${expected}`,
      "This may indicate an API issue. Do not approve or send transactions.",
    );
  }
}

// ── Transaction sending ─────────────────────────────────────────────

/**
 * Send a pre-built KyberSwap transaction and return both hash and receipt —
 * the receipt-truth primitive generic `ChainRead`-style consumers use to
 * extract logs (originally built for zap.in's NFT position extraction; kept
 * as a general reusable primitive after the Agent Scan teardown — see
 * `evm/receipt-logs.ts`'s `extractMintedNftId`, its remaining consumer).
 *
 * The swap execute handler does NOT use this atomic send+wait shape for its
 * own broadcasts — it needs the tx hash persisted BEFORE broadcasting (plan
 * §11.1), which requires the sign/broadcast split in `staged-broadcast.ts`.
 */
export async function sendKyberTransactionWithReceipt(
  publicClient: PublicClient<Transport, Chain>,
  walletClient: WalletClient<Transport, Chain>,
  params: { to: Address; data: Hex; value?: bigint },
): Promise<{ hash: Hex; receipt: { logs: Array<{ address: string; topics: string[]; data: string }> } }> {
  try {
    const hash = await walletClient.sendTransaction({
      account: walletClient.account!,
      to: params.to,
      data: params.data,
      value: params.value ?? 0n,
      chain: walletClient.chain,
    });
    const receipt = await waitForSuccessfulReceipt(publicClient, hash, {
      code: ErrorCodes.SWAP_FAILED,
      what: "Transaction",
      hint: "No swap was confirmed. Check the transaction hash before retrying.",
    });
    return {
      hash,
      receipt: {
        logs: receipt.logs.map(l => ({
          address: l.address,
          topics: l.topics as string[],
          data: l.data,
        })),
      },
    };
  } catch (err) {
    if (err instanceof VexError) throw err;
    throw new VexError(ErrorCodes.SWAP_FAILED, `Transaction failed: ${err instanceof Error ? err.message : err}`);
  }
}
