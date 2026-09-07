import {
  decodeEventLog,
  getAddress,
  type Address,
  type Hex,
  type TransactionReceipt,
} from "viem";

import { ErrorCodes, VexError } from "../../../errors.js";
import {
  LIGHTER_CORE_WITHDRAW_ERC20_ABI,
  LIGHTER_CORE_WITHDRAW_GATEWAY_ABI,
} from "./core-preflight.js";

export const LIGHTER_CORE_WITHDRAW_REQUIRED_CONFIRMATIONS = 12;

export interface LighterCoreWithdrawalSettlementProof {
  readonly transactionHash: Hex;
  readonly blockNumber: string;
  readonly blockHash: Hex;
  readonly confirmations: number;
  readonly gatewayEventLogIndex: number;
  readonly transferLogIndex: number;
  readonly owner: Address;
  readonly gatewayAddress: Address;
  readonly tokenAddress: Address;
  readonly assetIndex: 3;
  readonly amountUnits: string;
}

export function proveLighterCoreWithdrawalSettlement(input: {
  readonly receipt: TransactionReceipt;
  readonly canonicalBlockHash: Hex;
  readonly latestBlockNumber: bigint;
  readonly owner: string;
  readonly gatewayAddress: string;
  readonly tokenAddress: string;
  readonly amountUnits: bigint;
  readonly requiredConfirmations?: number;
}): LighterCoreWithdrawalSettlementProof {
  const owner = address(input.owner, "owner");
  const gateway = address(input.gatewayAddress, "gateway");
  const token = address(input.tokenAddress, "USDC token");
  if (input.amountUnits <= 0n) throw invalid("Settlement amount must be positive.");
  if (input.receipt.status !== "success") throw invalid("The Ethereum withdrawal transaction did not succeed.");
  if (input.receipt.blockHash !== input.canonicalBlockHash) {
    throw invalid("The Ethereum withdrawal receipt is not in the canonical block.");
  }
  if (input.latestBlockNumber < input.receipt.blockNumber) {
    throw invalid("Ethereum latest block is behind the withdrawal receipt.");
  }
  const confirmationsBig = input.latestBlockNumber - input.receipt.blockNumber + 1n;
  if (confirmationsBig > BigInt(Number.MAX_SAFE_INTEGER)) throw invalid("Ethereum confirmation depth is invalid.");
  const confirmations = Number(confirmationsBig);
  const required = input.requiredConfirmations ?? LIGHTER_CORE_WITHDRAW_REQUIRED_CONFIRMATIONS;
  if (!Number.isSafeInteger(required) || required < 1) throw invalid("Required confirmation depth is invalid.");

  const gatewayMatches: number[] = [];
  const transferMatches: number[] = [];
  for (const log of input.receipt.logs) {
    if (getAddress(log.address) === gateway) {
      try {
        const decoded = decodeEventLog({
          abi: LIGHTER_CORE_WITHDRAW_GATEWAY_ABI,
          eventName: "WithdrawPending",
          data: log.data,
          topics: log.topics,
          strict: true,
        });
        if (
          getAddress(decoded.args.owner) === owner
          && decoded.args.assetIndex === 3
          && decoded.args.baseAmount === input.amountUnits
        ) gatewayMatches.push(log.logIndex ?? -1);
      } catch {
        // A gateway may emit unrelated events in the same transaction.
      }
    }
    if (getAddress(log.address) === token) {
      try {
        const decoded = decodeEventLog({
          abi: LIGHTER_CORE_WITHDRAW_ERC20_ABI,
          eventName: "Transfer",
          data: log.data,
          topics: log.topics,
          strict: true,
        });
        if (
          getAddress(decoded.args.from) === gateway
          && getAddress(decoded.args.to) === owner
          && decoded.args.value === input.amountUnits
        ) transferMatches.push(log.logIndex ?? -1);
      } catch {
        // USDC may emit unrelated events in the same transaction.
      }
    }
  }
  if (gatewayMatches.length !== 1) {
    throw invalid("Ethereum settlement did not contain exactly one matching Core WithdrawPending event.");
  }
  if (transferMatches.length !== 1) {
    throw invalid("Ethereum settlement did not contain exactly one matching gateway-to-owner USDC transfer.");
  }
  if (confirmations < required) {
    throw new LighterSettlementConfirmingError(confirmations, required);
  }
  return {
    transactionHash: input.receipt.transactionHash,
    blockNumber: input.receipt.blockNumber.toString(10),
    blockHash: input.receipt.blockHash,
    confirmations,
    gatewayEventLogIndex: gatewayMatches[0]!,
    transferLogIndex: transferMatches[0]!,
    owner,
    gatewayAddress: gateway,
    tokenAddress: token,
    assetIndex: 3,
    amountUnits: input.amountUnits.toString(10),
  };
}

export class LighterSettlementConfirmingError extends Error {
  readonly confirmations: number;
  readonly requiredConfirmations: number;

  constructor(confirmations: number, requiredConfirmations: number) {
    super(`Ethereum settlement has ${confirmations}/${requiredConfirmations} required confirmations.`);
    this.name = "LighterSettlementConfirmingError";
    this.confirmations = confirmations;
    this.requiredConfirmations = requiredConfirmations;
  }
}

function address(value: string, field: string): Address {
  try {
    return getAddress(value);
  } catch {
    throw invalid(`Settlement ${field} address is invalid.`);
  }
}

function invalid(message: string): VexError {
  return new VexError(
    ErrorCodes.LIGHTER_INVALID_REQUEST,
    message,
    "The Core withdrawal remains unresolved; do not mark delivery complete or retry submission.",
  );
}
