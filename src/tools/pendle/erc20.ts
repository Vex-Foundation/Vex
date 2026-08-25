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
  encodeFunctionData,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type Transport,
  type WalletClient,
  type Account,
} from "viem";

import { VexError, ErrorCodes } from "../../errors.js";
import {
  signStageBroadcast,
  type StagedBroadcastHooks,
} from "@tools/evm-chains/staged-broadcast.js";
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

export interface PendleAllowanceStaging {
  readonly hooks: StagedBroadcastHooks;
  /** Definitive receipt observed. Durable cleanup is best-effort bookkeeping. */
  readonly terminalize: () => Promise<void>;
}

export type CreatePendleAllowanceStaging = () => PendleAllowanceStaging;

async function sendStagedPendleApproval(
  publicClient: PublicClient<Transport, Chain>,
  walletClient: WalletClient<Transport, Chain, Account>,
  token: Address,
  spender: Address,
  amount: bigint,
  createStaging: CreatePendleAllowanceStaging | undefined,
  label: string,
): Promise<Hex> {
  if (createStaging === undefined) {
    throw new VexError(
      ErrorCodes.APPROVAL_FAILED,
      "Refusing to sign a Pendle approval without a durable nonce reservation owner.",
    );
  }
  const staging = createStaging();
  const outcome = await signStageBroadcast(
    publicClient,
    walletClient,
    {
      to: getAddress(token),
      data: encodeFunctionData({
        abi: PENDLE_ERC20_ABI,
        functionName: "approve",
        args: [spender, amount],
      }),
      value: 0n,
    },
    staging.hooks,
  );
  if (outcome.kind === "ambiguous") {
    throw new VexError(
      ErrorCodes.APPROVAL_FAILED,
      `${label} outcome is unresolved for ${outcome.txHash}.`,
      "Check the transaction hash before retrying. Do not resubmit automatically.",
    );
  }
  await staging.terminalize().catch(() => undefined);
  if (outcome.kind === "reverted") {
    throw new VexError(ErrorCodes.APPROVAL_FAILED, `${label} reverted on-chain.`);
  }
  return outcome.txHash;
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
  createStaging?: CreatePendleAllowanceStaging,
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
      resetTxHash = await sendStagedPendleApproval(
        publicClient,
        walletClient,
        token,
        spender,
        0n,
        createStaging,
        "Allowance-reset transaction",
      );
    } catch (err) {
      if (err instanceof VexError) throw err;
      throw new VexError(ErrorCodes.APPROVAL_FAILED, `Failed to reset allowance: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  try {
    const txHash = await sendStagedPendleApproval(
      publicClient,
      walletClient,
      token,
      spender,
      requiredAmount,
      createStaging,
      "Approval transaction",
    );
    return resetTxHash ? { txHash, resetTxHash } : { txHash };
  } catch (err) {
    if (err instanceof VexError) throw err;
    throw new VexError(ErrorCodes.APPROVAL_FAILED, `Failed to approve: ${err instanceof Error ? err.message : String(err)}`);
  }
}
