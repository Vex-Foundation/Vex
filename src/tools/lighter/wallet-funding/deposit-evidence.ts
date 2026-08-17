/**
 * Exact, read-only evidence checks for a Lighter Core L1 deposit.
 *
 * The Ethereum transaction receipt proves which Lighter account index the
 * gateway assigned. The Lighter API must then expose the transaction derived
 * from that exact L1 hash, with the same deposit fields, and the account lookup
 * must prove that exact index belongs to the depositing wallet. None of these
 * checks sign, submit, retry, or replace a transaction.
 */

import {
  decodeEventLog,
  getAddress,
  type Address,
  type Hex,
  type TransactionReceipt,
} from "viem";

import type {
  LighterAccountsByL1AddressResponse,
  LighterTxFromL1Response,
} from "../types.js";

export const LIGHTER_DEPOSIT_EVENT_ABI = [
  {
    type: "event",
    name: "Deposit",
    inputs: [
      { name: "toAccountIndex", type: "uint48", indexed: false },
      { name: "toAddress", type: "address", indexed: false },
      { name: "assetIndex", type: "uint16", indexed: false },
      { name: "routeType", type: "uint8", indexed: false },
      { name: "baseAmount", type: "uint128", indexed: false },
    ],
  },
] as const;

export interface LighterDepositReceiptLog {
  readonly address: string;
  readonly data: string;
  readonly topics: readonly string[];
}

export interface LighterDepositReceipt {
  readonly status: "success" | "reverted";
  readonly transactionHash: string;
  readonly blockHash: string;
  readonly blockNumber: bigint;
  readonly from: string;
  readonly to: string | null;
  readonly logs: readonly LighterDepositReceiptLog[];
}

export interface ExpectedLighterDeposit {
  readonly txHash: string;
  readonly gatewayAddress: string;
  readonly walletAddress: string;
  readonly recipientAddress: string;
  readonly assetIndex: number;
  readonly routeType: number;
  readonly amountUnits: bigint;
}

export interface LighterDepositL1Evidence {
  readonly txHash: string;
  readonly blockHash: string;
  readonly blockNumber: string;
  readonly accountIndex: number;
  readonly walletAddress: string;
  readonly assetIndex: number;
  readonly routeType: number;
  readonly amountUnits: string;
}

export interface LighterDepositCreditEvidence extends LighterDepositL1Evidence {
  readonly lighterTxHash: string;
  readonly lighterStatus: number;
  readonly lighterBlockHeight: number;
  readonly lighterExecutedAt: number;
}

/** Reduce a viem receipt to the public fields needed for deposit evidence. */
export function projectLighterDepositReceipt(
  receipt: TransactionReceipt,
): LighterDepositReceipt {
  return {
    status: receipt.status,
    transactionHash: receipt.transactionHash,
    blockHash: receipt.blockHash,
    blockNumber: receipt.blockNumber,
    from: receipt.from,
    to: receipt.to,
    logs: receipt.logs.map((log) => ({
      address: log.address,
      data: log.data,
      topics: log.topics,
    })),
  };
}

/** Decode and bind the single gateway Deposit event to the persisted intent. */
export function proveLighterDepositL1(
  receipt: LighterDepositReceipt,
  expected: ExpectedLighterDeposit,
): LighterDepositL1Evidence {
  if (receipt.status !== "success") {
    throw new Error("Ethereum does not prove a successful Lighter deposit.");
  }
  if (!sameHex(receipt.transactionHash, expected.txHash)) {
    throw new Error("Ethereum receipt hash does not match the staged Lighter deposit hash.");
  }
  if (receipt.to === null || !sameAddress(receipt.to, expected.gatewayAddress)) {
    throw new Error("Ethereum receipt target does not match the approved Lighter gateway.");
  }
  if (!sameAddress(receipt.from, expected.walletAddress)) {
    throw new Error("Ethereum receipt sender does not match the approved Vex wallet.");
  }

  const gatewayLogs = receipt.logs.filter((log) => sameAddress(log.address, expected.gatewayAddress));
  const decoded = gatewayLogs.flatMap((log) => {
    try {
      const event = decodeEventLog({
        abi: LIGHTER_DEPOSIT_EVENT_ABI,
        eventName: "Deposit",
        data: log.data as Hex,
        topics: log.topics as [Hex, ...Hex[]],
        strict: true,
      });
      return [event.args];
    } catch {
      return [];
    }
  });
  if (decoded.length !== 1) {
    throw new Error("Ethereum receipt must contain exactly one Lighter Deposit event.");
  }

  const event = decoded[0]!;
  if (!sameAddress(event.toAddress, expected.recipientAddress)) {
    throw new Error("Lighter Deposit event recipient does not match the approved wallet.");
  }
  if (event.assetIndex !== expected.assetIndex) {
    throw new Error("Lighter Deposit event asset index does not match the approved intent.");
  }
  if (event.routeType !== expected.routeType) {
    throw new Error("Lighter Deposit event route type does not match the approved intent.");
  }
  if (event.baseAmount !== expected.amountUnits) {
    throw new Error("Lighter Deposit event amount does not match the approved intent.");
  }

  return {
    txHash: receipt.transactionHash,
    blockHash: receipt.blockHash,
    blockNumber: receipt.blockNumber.toString(10),
    accountIndex: Number(event.toAccountIndex),
    walletAddress: getAddress(event.toAddress),
    assetIndex: event.assetIndex,
    routeType: event.routeType,
    amountUnits: event.baseAmount.toString(10),
  };
}

/**
 * Prove Lighter executed the exact deposit and owns the event-selected account.
 * Status 3 is the current executed state observed from the live endpoint; any
 * other value remains uncredited rather than being guessed.
 */
export function proveLighterDepositCredit(input: {
  readonly l1: LighterDepositL1Evidence;
  readonly tx: LighterTxFromL1Response;
  readonly accounts: LighterAccountsByL1AddressResponse;
}): LighterDepositCreditEvidence {
  const { l1, tx, accounts } = input;
  if (tx.code !== 200 || tx.type !== 1 || tx.status !== 3) {
    throw new Error("Lighter has not exposed an executed deposit transaction for the exact L1 hash.");
  }
  if (tx.executed_at <= 0 || tx.block_height <= 0) {
    throw new Error("Lighter deposit transaction is not yet anchored to an executed L2 block.");
  }
  if (!sameAddress(tx.l1_address, l1.walletAddress) || tx.account_index !== l1.accountIndex) {
    throw new Error("Lighter transaction owner or account index does not match the L1 Deposit event.");
  }

  const info = readJsonObject(tx.info, "transaction info");
  assertDepositFields(info, {
    accountIndex: l1.accountIndex,
    l1Address: l1.walletAddress,
    assetIndex: l1.assetIndex,
    routeType: l1.routeType,
    amountUnits: BigInt(l1.amountUnits),
  }, {
    accountIndex: "AccountIndex",
    l1Address: "L1Address",
    assetIndex: "AssetIndex",
    routeType: "RouteType",
    amount: "Amount",
  });

  const eventInfo = readJsonObject(tx.event_info, "transaction event info");
  assertDepositFields(eventInfo, {
    accountIndex: l1.accountIndex,
    l1Address: l1.walletAddress,
    assetIndex: l1.assetIndex,
    routeType: l1.routeType,
    amountUnits: BigInt(l1.amountUnits),
  }, {
    accountIndex: "a",
    l1Address: "l",
    assetIndex: "ai",
    routeType: "rt",
    amount: "c",
  });

  if (accounts.code !== 200 || !sameAddress(accounts.l1_address, l1.walletAddress)) {
    throw new Error("Lighter account lookup is not bound to the depositing wallet.");
  }
  const owned = accounts.sub_accounts.filter((account) => account.index === l1.accountIndex);
  if (
    owned.length !== 1
    || owned[0]!.account_type !== 0
    || !sameAddress(owned[0]!.l1_address, l1.walletAddress)
  ) {
    throw new Error("The event-selected Lighter master account is not uniquely owned by the wallet.");
  }

  return {
    ...l1,
    lighterTxHash: tx.hash,
    lighterStatus: tx.status,
    lighterBlockHeight: tx.block_height,
    lighterExecutedAt: tx.executed_at,
  };
}

function assertDepositFields(
  value: Record<string, unknown>,
  expected: {
    readonly accountIndex: number;
    readonly l1Address: string;
    readonly assetIndex: number;
    readonly routeType: number;
    readonly amountUnits: bigint;
  },
  keys: {
    readonly accountIndex: string;
    readonly l1Address: string;
    readonly assetIndex: string;
    readonly routeType: string;
    readonly amount: string;
  },
): void {
  if (readSafeInteger(value[keys.accountIndex], keys.accountIndex) !== expected.accountIndex) {
    throw new Error("Lighter deposit account index evidence does not match Ethereum.");
  }
  const l1Address = value[keys.l1Address];
  if (typeof l1Address !== "string" || !sameAddress(l1Address, expected.l1Address)) {
    throw new Error("Lighter deposit address evidence does not match Ethereum.");
  }
  if (readSafeInteger(value[keys.assetIndex], keys.assetIndex) !== expected.assetIndex) {
    throw new Error("Lighter deposit asset evidence does not match Ethereum.");
  }
  if (readSafeInteger(value[keys.routeType], keys.routeType) !== expected.routeType) {
    throw new Error("Lighter deposit route evidence does not match Ethereum.");
  }
  if (readUnsignedBigInt(value[keys.amount], keys.amount) !== expected.amountUnits) {
    throw new Error("Lighter deposit amount evidence does not match Ethereum.");
  }
}

function readJsonObject(value: string, label: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`Lighter ${label} is not valid JSON.`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Lighter ${label} is not an object.`);
  }
  return parsed as Record<string, unknown>;
}

function readSafeInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Lighter deposit field ${field} is not a safe unsigned integer.`);
  }
  return value;
}

function readUnsignedBigInt(value: unknown, field: string): bigint {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`Lighter deposit field ${field} is not a safe unsigned integer.`);
    }
    return BigInt(value);
  }
  if (typeof value === "string" && /^(?:0|[1-9][0-9]*)$/.test(value)) {
    return BigInt(value);
  }
  throw new Error(`Lighter deposit field ${field} is not an unsigned integer.`);
}

function sameAddress(left: string, right: string): boolean {
  try {
    return getAddress(left) === getAddress(right);
  } catch {
    return false;
  }
}

function sameHex(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}
