/**
 * KyberSwap ERC-20 operations: metadata reads, spender validation,
 * allowance management, and transaction sending.
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
      `Known: MetaAggregationRouterV2, DSLOProtocol, KSZapRouterPosition, KSZapRouterPermit`,
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

// ── Allowance management ────────────────────────────────────────────

export interface ApproveResult {
  txHash: Hex;
  resetTxHash?: Hex;
}

/**
 * Ensure ERC-20 allowance is sufficient. Approve if needed.
 * Handles USDT-style tokens that require reset to 0 before new approval.
 *
 * Approves the EXACT `requiredAmount` when short (never an unlimited
 * `maxUint256`) — the exact-amount doctrine mirrors Uniswap's
 * `ensureUniswapAllowanceExact` (`src/tools/uniswap/erc20.ts`): a smaller
 * standing-allowance surface, so a compromised router can pull only what this
 * one operation needs. The former `approveExact` opt-in (default unlimited) was
 * REMOVED, not merely defaulted to exact: the Stage-9 prequote identity binds
 * `approveExact` into the swap match-hash and the recorder pins it `false`, so
 * an execute passing `approveExact: true` produced a divergent digest and was
 * already BLOCKED (no_quote) by the gate — the opt-in was dead on arrival. The
 * `approveExact` param is likewise gone from the kyberswap swap/zap manifests,
 * so the dispatcher rejects it as an unknown param before a handler runs.
 *
 * Callers that genuinely need an unlimited standing allowance (zap-out /
 * zap-migrate ERC-20 LP-share exits, where the router-pulled amount is not
 * determinable pre-build) pass `maxUint256` AS `requiredAmount` explicitly and
 * document why at the call site.
 *
 * @param publicClient - viem PublicClient for the target chain
 * @param walletClient - viem WalletClient for signing
 * @param token - ERC-20 token address
 * @param spender - Spender to approve (validated against KYBER_KNOWN_SPENDERS)
 * @param requiredAmount - Exact allowance to grant when the current one is short
 */
export async function ensureKyberAllowance(
  publicClient: PublicClient<Transport, Chain>,
  walletClient: WalletClient<Transport, Chain>,
  token: Address,
  spender: Address,
  requiredAmount: bigint,
): Promise<ApproveResult | null> {
  validateKyberSpender(spender);

  const owner = walletClient.account!.address;

  const currentAllowance = await publicClient.readContract({
    address: token,
    abi: ERC20_ABI,
    functionName: "allowance",
    args: [owner, spender],
  });

  if (currentAllowance >= requiredAmount) {
    logger.debug({ event: "kyberswap.allowance.sufficient", token, spender, current: currentAllowance.toString() });
    return null;
  }

  let resetTxHash: Hex | undefined;

  // USDT-style reset: if current > 0 and < required, reset to 0 first
  if (currentAllowance > 0n && currentAllowance < requiredAmount) {
    logger.debug({ event: "kyberswap.allowance.reset", token, spender });
    try {
      resetTxHash = await walletClient.writeContract({
        account: walletClient.account!,
        address: token,
        abi: ERC20_ABI,
        functionName: "approve",
        args: [spender, 0n],
      });
      await waitForSuccessfulReceipt(publicClient, resetTxHash, {
        code: ErrorCodes.APPROVAL_FAILED,
        what: "Allowance-reset transaction",
        hint: "The existing allowance was not cleared, so the follow-up approve would be blocked. Check the transaction hash before retrying.",
      });
    } catch (err) {
      if (err instanceof VexError) throw err;
      throw new VexError(ErrorCodes.APPROVAL_FAILED, `Failed to reset allowance: ${err instanceof Error ? err.message : err}`);
    }
  }

  const approveAmount = requiredAmount;

  try {
    logger.debug({ event: "kyberswap.allowance.approve", token, spender, amount: approveAmount.toString() });
    const txHash = await walletClient.writeContract({
      account: walletClient.account!,
      address: token,
      abi: ERC20_ABI,
      functionName: "approve",
      args: [spender, approveAmount],
    });
    await waitForSuccessfulReceipt(publicClient, txHash, {
      code: ErrorCodes.APPROVAL_FAILED,
      what: "Approval transaction",
      hint: "The router was not granted an allowance. Check the transaction hash before retrying.",
    });
    return { txHash, resetTxHash };
  } catch (err) {
    if (err instanceof VexError) throw err;
    throw new VexError(ErrorCodes.APPROVAL_FAILED, `Failed to approve: ${err instanceof Error ? err.message : err}`);
  }
}

// ── Transaction sending ─────────────────────────────────────────────

/**
 * Send a pre-built KyberSwap transaction (swap, cancel, zap).
 *
 * @returns Transaction hash
 */
export async function sendKyberTransaction(
  publicClient: PublicClient<Transport, Chain>,
  walletClient: WalletClient<Transport, Chain>,
  params: { to: Address; data: Hex; value?: bigint },
): Promise<Hex> {
  try {
    const txHash = await walletClient.sendTransaction({
      account: walletClient.account!,
      to: params.to,
      data: params.data,
      value: params.value ?? 0n,
      chain: walletClient.chain,
    });
    await waitForSuccessfulReceipt(publicClient, txHash, {
      code: ErrorCodes.SWAP_FAILED,
      what: "Transaction",
      hint: "No swap was confirmed. Check the transaction hash before retrying.",
    });
    return txHash;
  } catch (err) {
    if (err instanceof VexError) throw err;
    throw new VexError(ErrorCodes.SWAP_FAILED, `Transaction failed: ${err instanceof Error ? err.message : err}`);
  }
}

/**
 * Send a KyberSwap transaction and return both hash and receipt.
 * Used by zap.in to extract NFT position ID from receipt logs.
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
