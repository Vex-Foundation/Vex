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
} from "viem";

import { signStageBroadcast } from "@tools/evm-chains/staged-broadcast.js";
import { getUniswapDeployment } from "@tools/uniswap/deployments.js";
import { getUniswapEvmClients } from "@tools/uniswap/evm-client.js";
import * as onboardingIntentsRepo from "@vex-agent/db/repos/lighter-onboarding-intents.js";
import { LIGHTER_DEPOSIT_RELEASE_GATE } from "./release-gates.js";
import {
  LIGHTER_CORE_MAINNET_USDC_ADDRESS,
  LIGHTER_DEPOSIT_CHAIN_ID,
} from "./constants.js";
import { buildLighterOnboardingReaders } from "./onboarding-readers.js";
import type { LegOutcome, LighterDepositExecutionDeps } from "./deposit-execution.js";

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
  const readers = buildLighterOnboardingReaders();
  const usdc = getAddress(LIGHTER_CORE_MAINNET_USDC_ADDRESS);

  return {
    depositGateEnabled: () => LIGHTER_DEPOSIT_RELEASE_GATE.isEnabled(),

    async runApproveLegIfNeeded({ walletAddress, spender, amountUnits, onHashStaged }) {
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
      const data = encodeFunctionData({
        abi: ERC20_ALLOWANCE_APPROVE_ABI,
        functionName: "approve",
        args: [spenderAddr, amountUnits],
      });
      const outcome = await runStaged(clients, { to: usdc, data, value: 0n }, onHashStaged);
      return { skipped: false, txHash: outcome.txHash, outcome: outcome.outcome, reason: outcome.reason };
    },

    async runDepositLeg({ to, data, onHashStaged }) {
      const outcome = await runStaged(
        clients,
        { to: getAddress(to), data: data as Hex, value: 0n },
        onHashStaged,
      );
      return { txHash: outcome.txHash, outcome: outcome.outcome, reason: outcome.reason };
    },

    async resolveAccountIndex(walletAddress) {
      const account = await readers.readLighterAccount("core", walletAddress);
      return account?.account_index ?? null;
    },

    intents: {
      markAllowanceVerified: (intentId) => onboardingIntentsRepo.markAllowanceVerified(intentId),
      markApproveSubmitted: (intentId, hash) => onboardingIntentsRepo.markApproveSubmitted(intentId, hash),
      markApproveConfirmed: (intentId) => onboardingIntentsRepo.markApproveConfirmed(intentId),
      markDepositSubmitted: (intentId, hash) => onboardingIntentsRepo.markDepositSubmitted(intentId, hash),
      markDepositConfirmed: (intentId) => onboardingIntentsRepo.markDepositConfirmed(intentId),
      markCredited: (intentId, accountIndex) => onboardingIntentsRepo.markCredited(intentId, accountIndex),
      markAmbiguous: (intentId, reason) => onboardingIntentsRepo.markAmbiguous(intentId, reason),
      markFailed: (intentId, reason) => onboardingIntentsRepo.markFailed(intentId, reason),
    },
  };
}

async function runStaged(
  clients: ReturnType<typeof getUniswapEvmClients>,
  tx: { readonly to: Address; readonly data: Hex; readonly value: bigint },
  onHashStaged: (txHash: string) => Promise<void>,
): Promise<{ readonly txHash: string; readonly outcome: LegOutcome; readonly reason?: string }> {
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
  );
  if (result.kind === "confirmed") return { txHash: result.txHash, outcome: "confirmed" };
  if (result.kind === "reverted") return { txHash: result.txHash, outcome: "reverted" };
  return { txHash: result.txHash, outcome: "ambiguous", reason: result.reason };
}
