/**
 * Live signing dependencies for the approved Lighter deposit executor.
 *
 * Builds the real approve/deposit leg runners on the existing Ethereum-mainnet
 * Uniswap EVM clients and `signStageBroadcast` (which stages the tx hash before
 * broadcast and returns a confirmed/reverted/ambiguous outcome). The private key
 * is passed in by the privileged handler that resolved the signing wallet; this
 * module never resolves or stores key material and is only reachable behind the
 * default-closed deposit gate. Both legs are non-payable (value 0), so there is
 * no native value to attribute.
 */

import {
  encodeFunctionData,
  getAddress,
  type Address,
  type Hex,
  type TransactionReceipt,
} from "viem";
import type { PoolClient } from "pg";

import { signStageBroadcast } from "@tools/evm-chains/staged-broadcast.js";
import { priorLegAnchorFrom } from "@tools/evm-chains/dependent-leg-gas-estimate.js";
import { getUniswapDeployment } from "@tools/uniswap/deployments.js";
import { getUniswapEvmClients } from "@tools/uniswap/evm-client.js";
import * as onboardingIntentsRepo from "@vex-agent/db/repos/lighter-onboarding-intents.js";
import { withSessionControlLock } from "@vex-agent/engine/runtime/lease-and-status/session-control-lock.js";
import { LIGHTER_DEPOSIT_RELEASE_GATE } from "./release-gates.js";
import {
  LIGHTER_CORE_MAINNET_USDC_ADDRESS,
  LIGHTER_DEPOSIT_CHAIN_ID,
} from "./constants.js";
import type { LegOutcome, LighterDepositExecutionDeps } from "./deposit-execution.js";
import {
  projectLighterDepositReceipt,
  type LighterDepositReceipt,
} from "./deposit-evidence.js";

const ERC20_ALLOWANCE_APPROVE_ABI = [
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

export interface LighterDepositSignerInput {
  /** The Vex wallet L1 private key, resolved by the privileged handler. */
  readonly privateKey: Hex;
  /** Owning host session; every lifecycle write serializes through its lock. */
  readonly sessionId: string;
  /** Re-prove the cross-process chain-wallet lease at signing boundaries. */
  readonly assertExecutionLease: () => Promise<void>;
}

/** Build the live deposit execution deps behind the (already-checked) gate. */
export function buildLighterDepositExecutionDeps(
  input: LighterDepositSignerInput,
): LighterDepositExecutionDeps {
  const deployment = getUniswapDeployment(LIGHTER_DEPOSIT_CHAIN_ID);
  if (!deployment) {
    throw new Error("Ethereum mainnet deployment is not configured for Lighter deposits.");
  }
  const clients = getUniswapEvmClients(deployment, input.privateKey);
  const usdc = getAddress(LIGHTER_CORE_MAINNET_USDC_ADDRESS);
  const writeUnderSessionLock = <T>(
    write: (client: PoolClient) => Promise<T>,
  ): Promise<T> => withSessionControlLock(input.sessionId, write);

  return {
    depositGateEnabled: () => LIGHTER_DEPOSIT_RELEASE_GATE.isEnabled(),
    assertExecutionLease: input.assertExecutionLease,

    async runApproveLegIfNeeded({ walletAddress, spender, amountUnits, onHashStaged }) {
      await input.assertExecutionLease();
      const owner = getAddress(walletAddress);
      const spenderAddr = getAddress(spender);
      const current = (await clients.publicClient.readContract({
        address: usdc,
        abi: ERC20_ALLOWANCE_APPROVE_ABI,
        functionName: "allowance",
        args: [owner, spenderAddr],
      })) as bigint;
      if (current >= amountUnits) {
        return { skipped: true };
      }
      await input.assertExecutionLease();
      const data = encodeFunctionData({
        abi: ERC20_ALLOWANCE_APPROVE_ABI,
        functionName: "approve",
        args: [spenderAddr, amountUnits],
      });
      const outcome = await runStaged(clients, { to: usdc, data, value: 0n }, onHashStaged);
      return {
        skipped: false,
        txHash: outcome.txHash,
        outcome: outcome.outcome,
        confirmedBlockNumber: outcome.receipt?.blockNumber,
        reason: outcome.reason,
      };
    },

    async runDepositLeg({ to, data, confirmedApprovalBlockNumber, onHashStaged }) {
      await input.assertExecutionLease();
      const outcome = await runStaged(
        clients,
        { to: getAddress(to), data: data as Hex, value: 0n },
        onHashStaged,
        confirmedApprovalBlockNumber,
      );
      return {
        txHash: outcome.txHash,
        outcome: outcome.outcome,
        receipt: outcome.receipt === undefined
          ? undefined
          : projectLighterDepositReceipt(outcome.receipt),
        reason: outcome.reason,
      };
    },

    intents: {
      markAllowanceVerified: (intentId) => writeUnderSessionLock((client) =>
        onboardingIntentsRepo.markAllowanceVerifiedWith(client, intentId)),
      markApproveSubmitted: (intentId, hash) => writeUnderSessionLock((client) =>
        onboardingIntentsRepo.markApproveSubmittedWith(client, intentId, hash)),
      markApproveConfirmed: (intentId) => writeUnderSessionLock((client) =>
        onboardingIntentsRepo.markApproveConfirmedWith(client, intentId)),
      markDepositSubmitted: (intentId, hash) => writeUnderSessionLock((client) =>
        onboardingIntentsRepo.markDepositSubmittedWith(client, intentId, hash)),
      markDepositConfirmed: (intentId, evidence) => writeUnderSessionLock((client) =>
        onboardingIntentsRepo.markDepositConfirmedWith(client, intentId, evidence)),
      markAmbiguous: (intentId, reason) => writeUnderSessionLock((client) =>
        onboardingIntentsRepo.markAmbiguousWith(client, intentId, reason)),
      markFailed: (intentId, reason) => writeUnderSessionLock((client) =>
        onboardingIntentsRepo.markFailedWith(client, intentId, reason)),
    },
  };
}

async function runStaged(
  clients: ReturnType<typeof getUniswapEvmClients>,
  tx: { readonly to: Address; readonly data: Hex; readonly value: bigint },
  onHashStaged: (txHash: string) => Promise<void>,
  confirmedPriorBlockNumber?: bigint,
): Promise<{
  readonly txHash: string;
  readonly outcome: LegOutcome;
  readonly receipt?: TransactionReceipt;
  readonly reason?: string;
}> {
  const result = await signStageBroadcast(
    clients.publicClient,
    clients.walletClient,
    tx,
    {
      onHashStaged: async (handles) => {
        await onHashStaged(handles.txHash);
      },
      onAccepted: async () => {},
    },
    priorLegAnchorFrom(confirmedPriorBlockNumber),
  );
  if (result.kind === "confirmed") {
    return { txHash: result.txHash, outcome: "confirmed", receipt: result.receipt };
  }
  if (result.kind === "reverted") {
    return { txHash: result.txHash, outcome: "reverted", receipt: result.receipt };
  }
  return { txHash: result.txHash, outcome: "ambiguous", reason: result.reason };
}
