/**
 * Live signing dependencies for the approved Lighter deposit executor.
 *
 * Builds the real approve/deposit leg runners on the environment's settlement
 * Uniswap EVM clients and `signStageBroadcast` (which stages the tx hash before
 * broadcast and returns a confirmed/reverted/ambiguous outcome). The private key
 * is passed in by the privileged handler that resolved the signing wallet; this
 * module never resolves or stores key material and is reachable only from the
 * exact approved-intent handler. Both legs are non-payable (value 0), so there is
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
import {
  markLegacyEvmNonceAccepted,
  reserveLegacyEvmNonce,
  stageLegacyEvmNonce,
  terminalizeLegacyEvmNonce,
  type LegacyEvmNoncePurpose,
  type LegacyEvmNonceReservation,
} from "@vex-agent/db/repos/evm-nonce-reservations.js";
import * as onboardingIntentsRepo from "@vex-agent/db/repos/lighter-onboarding-intents.js";
import { withSessionControlLock } from "@vex-agent/engine/runtime/lease-and-status/session-control-lock.js";
import {
  getLocalChainRpcUrl,
  getLocalChain,
} from "@tools/evm-chains/registry.js";
import {
  type LighterEnvironment,
} from "../constants.js";
import { getLighterFundingDeployment } from "./deployments.js";
import type { LegOutcome, LighterDepositExecutionDeps } from "./deposit-execution.js";
import type { LighterStagedEvmTransaction } from "@vex-agent/db/repos/lighter-onboarding-intents.js";
import {
  projectLighterDepositReceipt,
  type LighterDepositReceipt,
} from "./deposit-evidence.js";
import {
  LIGHTER_DEPOSIT_FEE_PREFLIGHT_COMPLETE,
  readLighterDepositPreflight,
} from "./deposit-preflight.js";
import {
  assertLighterDepositPreflightWithinApproval,
  runtimeFeeSafetyLimit,
} from "./deposit-pre-sign.js";
import type { LighterDepositSignedFeeCeiling } from "./deposit-pre-sign.js";
import logger from "@utils/logger.js";

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
  /** Exact approved funding environment; selects chain, token, and gateway identity. */
  readonly environment: LighterEnvironment;
  /** The Vex wallet L1 private key, resolved by the privileged handler. */
  readonly privateKey: Hex;
  /** Owning host session; every lifecycle write serializes through its lock. */
  readonly sessionId: string;
  /** Re-prove the cross-process chain-wallet lease at signing boundaries. */
  readonly assertExecutionLease: () => Promise<void>;
}

/** Build the live deposit execution dependencies for an exact approved intent. */
export function buildLighterDepositExecutionDeps(
  input: LighterDepositSignerInput,
): LighterDepositExecutionDeps {
  const funding = getLighterFundingDeployment(input.environment);
  const deployment = getUniswapDeployment(funding.settlementChainId);
  if (!deployment || deployment.chainId !== funding.settlementChainId) {
    throw new Error(`${funding.settlementNetworkName} is not configured for Lighter deposits.`);
  }
  const signerRpcUrl = input.environment === "rhc"
    ? rhcRpcUrl(funding.settlementChainId)
    : null;
  const clients = getUniswapEvmClients(deployment, input.privateKey);
  const settlementToken = funding.settlementTokenProxy;
  const writeUnderSessionLock = <T>(
    write: (client: PoolClient) => Promise<T>,
  ): Promise<T> => withSessionControlLock(input.sessionId, write);

  return {
    depositFeePreflightComplete: () => LIGHTER_DEPOSIT_FEE_PREFLIGHT_COMPLETE,
    assertExecutionLease: input.assertExecutionLease,
    async assertFreshPreSignPreflight(intent, stage) {
      if (intent.amountUnits === null || !/^[1-9][0-9]*$/.test(intent.amountUnits)) {
        throw new Error("The approved Lighter deposit amount is missing or invalid.");
      }
      if (
        input.environment === "rhc"
        && rhcRpcUrl(funding.settlementChainId) !== signerRpcUrl
      ) {
        throw new Error(
          "The Robinhood Chain RPC changed after the signer client was created. Nothing was signed or submitted.",
        );
      }
      const fresh = await readLighterDepositPreflight({
        environment: input.environment,
        walletAddress: intent.walletAddress,
        amountUnits: BigInt(intent.amountUnits),
        routeType: intent.routeType ?? 0,
        publicClient: clients.publicClient,
      });
      if (intent.executionState === "approve_confirmed" && fresh.approvalRequired) {
        throw new Error(
          `The confirmed ${funding.settlementSymbol} allowance is no longer sufficient. Nothing was signed or submitted.`,
        );
      }
      assertLighterDepositPreflightWithinApproval({ intent, fresh, stage });
      return runtimeFeeSafetyLimit(fresh, stage === "deposit" ? "deposit" : "approve");
    },

    async runApproveLegIfNeeded({
      walletAddress,
      spender,
      amountUnits,
      feeCeiling,
      onHashStaged,
    }) {
      await input.assertExecutionLease();
      const owner = getAddress(walletAddress);
      const spenderAddr = getAddress(spender);
      const current = (await clients.publicClient.readContract({
        address: settlementToken,
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
      const outcome = await runStaged(
        clients,
        { to: settlementToken, data, value: 0n },
        "lighter_deposit_approve",
        onHashStaged,
        undefined,
        feeCeiling,
      );
      return {
        skipped: false,
        txHash: outcome.txHash,
        outcome: outcome.outcome,
        confirmedBlockNumber: outcome.receipt?.blockNumber,
        replacement: outcome.replacement,
        reason: outcome.reason,
      };
    },

    async runDepositLeg({
      to,
      data,
      confirmedApprovalBlockNumber,
      feeCeiling,
      onHashStaged,
    }) {
      await input.assertExecutionLease();
      const outcome = await runStaged(
        clients,
        { to: getAddress(to), data: data as Hex, value: 0n },
        "lighter_deposit",
        onHashStaged,
        confirmedApprovalBlockNumber,
        feeCeiling,
      );
      return {
        txHash: outcome.txHash,
        outcome: outcome.outcome,
        receipt: outcome.receipt === undefined
          ? undefined
          : projectLighterDepositReceipt(outcome.receipt),
        replacement: outcome.replacement,
        reason: outcome.reason,
      };
    },

    intents: {
      markAllowanceVerified: (intentId) => writeUnderSessionLock((client) =>
        onboardingIntentsRepo.markAllowanceVerifiedWith(client, intentId)),
      markApproveSubmitted: (intentId, transaction) => writeUnderSessionLock((client) =>
        onboardingIntentsRepo.markApproveSubmittedWith(client, intentId, transaction)),
      markApproveConfirmed: (intentId, txHash) => writeUnderSessionLock((client) =>
        onboardingIntentsRepo.markApproveConfirmedWith(client, intentId, txHash)),
      markDepositSubmitted: (intentId, transaction) => writeUnderSessionLock((client) =>
        onboardingIntentsRepo.markDepositSubmittedWith(client, intentId, transaction)),
      recordApproveReplacement: (intentId, replacement) => writeUnderSessionLock((client) =>
        onboardingIntentsRepo.recordApproveReplacementWith(client, intentId, replacement)),
      recordDepositReplacement: (intentId, replacement) => writeUnderSessionLock((client) =>
        onboardingIntentsRepo.recordDepositReplacementWith(client, intentId, replacement)),
      markDepositConfirmed: (intentId, evidence) => writeUnderSessionLock((client) =>
        onboardingIntentsRepo.markDepositConfirmedWith(client, intentId, evidence)),
      markAmbiguous: (intentId, reason) => writeUnderSessionLock((client) =>
        onboardingIntentsRepo.markAmbiguousWith(client, intentId, reason)),
      markFailed: (intentId, reason) => writeUnderSessionLock((client) =>
        onboardingIntentsRepo.markFailedWith(client, intentId, reason)),
    },
  };
}

function rhcRpcUrl(chainId: number): string {
  const localChain = getLocalChain(chainId);
  if (localChain === undefined) {
    throw new Error(
      "Robinhood Chain is not configured for deposit execution. Nothing was signed or submitted.",
    );
  }
  return getLocalChainRpcUrl(localChain);
}

async function runStaged(
  clients: ReturnType<typeof getUniswapEvmClients>,
  tx: { readonly to: Address; readonly data: Hex; readonly value: bigint },
  noncePurpose: LegacyEvmNoncePurpose,
  onHashStaged: (transaction: LighterStagedEvmTransaction) => Promise<void>,
  confirmedPriorBlockNumber?: bigint,
  feeCeiling?: LighterDepositSignedFeeCeiling,
): Promise<{
  readonly txHash: string;
  readonly outcome: LegOutcome;
  readonly receipt?: TransactionReceipt;
  readonly replacement?: import("@tools/evm-chains/receipt-guard.js").ReceiptReplacementEvidence;
  readonly reason?: string;
}> {
  const nonceState: { reservation: LegacyEvmNonceReservation | null } = { reservation: null };
  const result = await signStageBroadcast(
    clients.publicClient,
    clients.walletClient,
    tx,
    {
      onNonceReserved: async (request) => {
        if (nonceState.reservation !== null) {
          throw new Error("Lighter settlement nonce was reserved more than once.");
        }
        nonceState.reservation = await reserveLegacyEvmNonce(request, noncePurpose);
        return nonceState.reservation.nonce;
      },
      onHashStaged: async (handles) => {
        await onHashStaged({
          txHash: handles.txHash,
          fromAddress: handles.fromAddress,
          nonce: handles.nonce,
        });
        if (nonceState.reservation === null) {
          throw new Error("Lighter settlement hash reached staging without a nonce reservation.");
        }
        await stageLegacyEvmNonce(nonceState.reservation.id, handles);
      },
      onAccepted: async () => {
        if (nonceState.reservation === null) {
          throw new Error("Lighter settlement submit was accepted without a nonce reservation.");
        }
        await markLegacyEvmNonceAccepted(nonceState.reservation.id);
      },
    },
    priorLegAnchorFrom(confirmedPriorBlockNumber),
    undefined,
    feeCeiling,
  );
  if (result.kind !== "ambiguous" && nonceState.reservation !== null) {
    try {
      await terminalizeLegacyEvmNonce(nonceState.reservation.id);
    } catch (cause) {
      logger.warn("lighter.deposit.evm_nonce_terminal_write_failed", {
        reservationId: nonceState.reservation.id,
        errorKind: cause instanceof Error ? cause.name : "UnknownError",
      });
    }
  }
  if (result.kind === "confirmed") {
    return {
      txHash: result.txHash,
      outcome: "confirmed",
      receipt: result.receipt,
      replacement: result.replacement,
    };
  }
  if (result.kind === "reverted") {
    return {
      txHash: result.txHash,
      outcome: "reverted",
      receipt: result.receipt,
      replacement: result.replacement,
    };
  }
  return { txHash: result.txHash, outcome: "ambiguous", reason: result.reason };
}
