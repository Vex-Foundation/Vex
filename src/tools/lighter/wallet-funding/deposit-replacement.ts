/** Exact identity and safety proof for externally repriced Lighter deposit legs. */

import { encodeFunctionData, getAddress } from "viem";

import type { ReceiptReplacementEvidence } from "@tools/evm-chains/receipt-guard.js";
import type { LighterOnboardingIntentRow } from "@vex-agent/db/repos/lighter-onboarding-intents.js";
import { persistedFeeSafetyLimit } from "./deposit-pre-sign.js";
import { buildLighterDepositCalldata } from "./deposit-calldata.js";
import { getLighterFundingDeployment } from "./deployments.js";

const APPROVE_ABI = [{
  type: "function",
  name: "approve",
  stateMutability: "nonpayable",
  inputs: [
    { name: "spender", type: "address" },
    { name: "amount", type: "uint256" },
  ],
  outputs: [{ name: "", type: "bool" }],
}] as const;

export interface LighterAcceptedReplacement {
  readonly originalTxHash: string;
  readonly replacementTxHash: string;
  readonly reason: "repriced";
  readonly observedAt: Date;
}

export function proveApprovedLighterDepositReplacement(input: {
  readonly intent: LighterOnboardingIntentRow;
  readonly stage: "approve" | "deposit";
  readonly replacement: ReceiptReplacementEvidence;
  readonly observedAt?: Date;
}): LighterAcceptedReplacement {
  const { intent, stage, replacement } = input;
  const funding = getLighterFundingDeployment(intent.environment);
  const originalHash = stage === "approve" ? intent.approveTxHash : intent.depositTxHash;
  const stagedFrom = stage === "approve" ? intent.approveTxFrom : intent.depositTxFrom;
  const stagedNonce = stage === "approve" ? intent.approveTxNonce : intent.depositTxNonce;
  if (
    originalHash === null
    || stagedFrom === null
    || stagedNonce === null
    || intent.amountUnits === null
    || intent.depositContract === null
    || intent.depositTo === null
    || intent.assetIndex === null
    || intent.routeType === null
    || !/^[1-9][0-9]*$/.test(intent.amountUnits)
    || intent.capability !== "deposit"
    || intent.chainId !== funding.settlementChainId
    || intent.assetIndex !== funding.settlementAssetIndex
    || intent.routeType !== funding.perpsRouteType
    || getAddress(intent.walletAddress) !== getAddress(intent.depositTo)
    || getAddress(intent.depositContract) !== funding.gatewayProxy
  ) {
    throw new Error(`Stored Lighter ${stage} transaction identity is incomplete.`);
  }
  if (
    replacement.reason !== "repriced"
    || !/^0x[0-9a-fA-F]{64}$/.test(replacement.replacedTxHash)
    || !/^0x[0-9a-fA-F]{64}$/.test(replacement.replacementTxHash)
    || replacement.replacedTxHash.toLowerCase() !== originalHash.toLowerCase()
    || replacement.replacementTxHash.toLowerCase() === originalHash.toLowerCase()
    || getAddress(replacement.fromAddress) !== getAddress(stagedFrom)
    || getAddress(replacement.fromAddress) !== getAddress(intent.walletAddress)
    || replacement.nonce.toString(10) !== stagedNonce
    || replacement.to === null
    || replacement.value !== 0n
  ) {
    throw new Error(`Settlement-chain replacement is not an exact fee-only ${stage} repricing.`);
  }

  const amountUnits = BigInt(intent.amountUnits);
  const expected = stage === "approve"
    ? {
        to: funding.settlementTokenProxy,
        data: encodeFunctionData({
          abi: APPROVE_ABI,
          functionName: "approve",
          args: [getAddress(intent.depositContract), amountUnits],
        }),
      }
    : buildLighterDepositCalldata({
        environment: intent.environment,
        to: intent.depositTo,
        amountUnits,
        assetIndex: intent.assetIndex,
        route: "perps",
      });
  if (
    getAddress(replacement.to) !== getAddress(expected.to)
    || replacement.data.toLowerCase() !== expected.data.toLowerCase()
  ) {
    throw new Error(`Settlement-chain replacement changed the approved ${stage} calldata.`);
  }

  const ceiling = persistedFeeSafetyLimit(intent, stage);
  if (
    replacement.maxFeePerGas === null
    || replacement.maxPriorityFeePerGas === null
    || replacement.gas > ceiling.gasLimit
    || replacement.maxFeePerGas > ceiling.maxFeePerGas
    || replacement.maxPriorityFeePerGas > ceiling.maxPriorityFeePerGas
    || replacement.gas * replacement.maxFeePerGas > ceiling.maxNetworkFeeWei
  ) {
    throw new Error(`Settlement-chain replacement exceeds the persisted ${stage} fee safety limit.`);
  }

  const observedAt = input.observedAt ?? new Date();
  if (!Number.isFinite(observedAt.getTime())) {
    throw new Error("Settlement-chain replacement observation time is invalid.");
  }
  return {
    originalTxHash: originalHash,
    replacementTxHash: replacement.replacementTxHash,
    reason: "repriced",
    observedAt: new Date(observedAt),
  };
}
