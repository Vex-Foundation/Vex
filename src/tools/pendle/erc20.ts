/**
 * Pendle ERC-20 helpers — balance reads + EXACT-amount allowance to the PINNED
 * Router only.
 *
 * The Convert API's `requiredApprovals` carry NO spender field — the spender is
 * IMPLICITLY the Router. So every approval here targets `PENDLE_ROUTER` and only
 * `PENDLE_ROUTER`; a caller passing any other spender is a bug and throws. The
 * approval is for the EXACT amount (never maxUint256) — a minimal standing
 * allowance surface.
 */

import {
  getAddress,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type Transport,
  type WalletClient,
  type Account,
} from "viem";

import { VexError, ErrorCodes } from "../../errors.js";
import { gasLimitWithHeadroom } from "@tools/evm-chains/gas-limit-headroom.js";
import { waitForSuccessfulReceipt } from "@tools/evm-chains/receipt-guard.js";
import logger from "../../utils/logger.js";
import { PENDLE_ERC20_ABI, PENDLE_ROUTER } from "./constants.js";

/** Read an owner's ERC-20 balance (0 on read failure — never throws). */
export async function readPendleErc20Balance(
  client: PublicClient<Transport, Chain>,
  token: Address,
  owner: Address,
): Promise<bigint> {
  try {
    return (await client.readContract({
      address: token,
      abi: PENDLE_ERC20_ABI,
      functionName: "balanceOf",
      args: [owner],
    })) as bigint;
  } catch {
    return 0n;
  }
}

/** Assert the spender is the pinned Pendle Router; throw otherwise. */
export function assertPendleRouterSpender(spender: Address): void {
  if (getAddress(spender) !== PENDLE_ROUTER) {
    throw new VexError(
      ErrorCodes.INVALID_SPENDER,
      `Spender ${spender} is not the pinned Pendle Router.`,
      "Pendle approvals may only target the canonical Router.",
    );
  }
}

/**
 * Ensure the Router's allowance for `token` is EXACTLY `requiredAmount` (Codex
 * fund-safety fix: a stale LARGER Router allowance would make over-spend real, so
 * `current > required` is reset to exact, not skipped). When `current !=
 * required` and non-zero, the allowance is zeroed first (USDT-style tokens
 * require it; doing it universally is safe) and then set to the exact amount.
 * Returns the approval tx hash(es), or null when the allowance already equals
 * the required amount exactly.
 */
export async function ensurePendleAllowanceExact(
  publicClient: PublicClient<Transport, Chain>,
  walletClient: WalletClient<Transport, Chain, Account>,
  token: Address,
  spender: Address,
  requiredAmount: bigint,
): Promise<{ txHash: Hex; resetTxHash?: Hex } | null> {
  assertPendleRouterSpender(spender);
  const owner = walletClient.account.address;

  const currentAllowance = (await publicClient.readContract({
    address: token,
    abi: PENDLE_ERC20_ABI,
    functionName: "allowance",
    args: [owner, spender],
  })) as bigint;

  if (currentAllowance === requiredAmount) {
    logger.debug({ event: "pendle.allowance.exact", token, spender });
    return null;
  }

  let resetTxHash: Hex | undefined;
  if (currentAllowance > 0n) {
    try {
      // Estimated explicitly so the approve is signed with the shared headroom
      // instead of `writeContract`'s internal bare estimate (see
      // `gasLimitWithHeadroom` for the on-chain loss that proves why a bare
      // estimate is unsafe). Kept INSIDE this try so a would-revert approve
      // still throws before anything is signed AND still lands on the existing
      // APPROVAL_FAILED classification, exactly as the internal estimate did.
      const resetGasEstimate = await publicClient.estimateContractGas({
        account: walletClient.account,
        address: getAddress(token),
        abi: PENDLE_ERC20_ABI,
        functionName: "approve",
        args: [spender, 0n],
      });
      resetTxHash = await walletClient.writeContract({
        account: walletClient.account,
        chain: walletClient.chain,
        address: getAddress(token),
        abi: PENDLE_ERC20_ABI,
        functionName: "approve",
        args: [spender, 0n],
        gas: gasLimitWithHeadroom(resetGasEstimate),
      });
      await waitForSuccessfulReceipt(publicClient, resetTxHash, {
        code: ErrorCodes.APPROVAL_FAILED,
        what: "Allowance-reset transaction",
        hint: "The existing allowance was not cleared, so the follow-up approve would be blocked. Check the transaction hash before retrying.",
      });
    } catch (err) {
      if (err instanceof VexError) throw err;
      throw new VexError(ErrorCodes.APPROVAL_FAILED, `Failed to reset allowance: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  try {
    // Same headroom discipline as the reset leg above.
    const gasEstimate = await publicClient.estimateContractGas({
      account: walletClient.account,
      address: getAddress(token),
      abi: PENDLE_ERC20_ABI,
      functionName: "approve",
      args: [spender, requiredAmount],
    });
    const txHash = await walletClient.writeContract({
      account: walletClient.account,
      chain: walletClient.chain,
      address: getAddress(token),
      abi: PENDLE_ERC20_ABI,
      functionName: "approve",
      args: [spender, requiredAmount],
      gas: gasLimitWithHeadroom(gasEstimate),
    });
    await waitForSuccessfulReceipt(publicClient, txHash, {
      code: ErrorCodes.APPROVAL_FAILED,
      what: "Approval transaction",
      hint: "The Pendle Router was not granted an allowance. Check the transaction hash before retrying.",
    });
    return resetTxHash ? { txHash, resetTxHash } : { txHash };
  } catch (err) {
    if (err instanceof VexError) throw err;
    throw new VexError(ErrorCodes.APPROVAL_FAILED, `Failed to approve: ${err instanceof Error ? err.message : String(err)}`);
  }
}
