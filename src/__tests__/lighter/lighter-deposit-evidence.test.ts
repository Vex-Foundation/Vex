import { describe, expect, it } from "vitest";
import { encodeAbiParameters, encodeEventTopics } from "viem";

import {
  LIGHTER_DEPOSIT_EVENT_ABI,
  proveLighterDepositCredit,
  proveLighterDepositL1,
  type LighterDepositL1Evidence,
  type LighterDepositReceipt,
} from "@tools/lighter/wallet-funding/deposit-evidence.js";
import type {
  LighterAccountsByL1AddressResponse,
  LighterTxFromL1Response,
} from "@tools/lighter/types.js";

const TX_HASH = `0x${"a".repeat(64)}`;
const BLOCK_HASH = `0x${"b".repeat(64)}`;
const GATEWAY = "0x3B4D794a66304F130a4Db8F2551B0070dfCf5ca7";
const WALLET = "0x1111111111111111111111111111111111111111";

function receipt(overrides: Partial<LighterDepositReceipt> = {}): LighterDepositReceipt {
  const topics = encodeEventTopics({ abi: LIGHTER_DEPOSIT_EVENT_ABI, eventName: "Deposit" });
  const data = encodeAbiParameters(
    [
      { type: "uint48" },
      { type: "address" },
      { type: "uint16" },
      { type: "uint8" },
      { type: "uint128" },
    ],
    [42, WALLET, 3, 0, 11_000_000n],
  );
  return {
    status: "success",
    transactionHash: TX_HASH,
    blockHash: BLOCK_HASH,
    blockNumber: 23_456_789n,
    from: WALLET,
    to: GATEWAY,
    logs: [{ address: GATEWAY, topics, data }],
    ...overrides,
  };
}

function l1(): LighterDepositL1Evidence {
  return proveLighterDepositL1(receipt(), {
    txHash: TX_HASH,
    gatewayAddress: GATEWAY,
    walletAddress: WALLET,
    recipientAddress: WALLET,
    assetIndex: 3,
    routeType: 0,
    amountUnits: 11_000_000n,
  });
}

function tx(overrides: Partial<LighterTxFromL1Response> = {}): LighterTxFromL1Response {
  return {
    code: 200,
    hash: "00000000001d24152900000130000000000000000000000000000000000000000000000000000000",
    type: 1,
    info: JSON.stringify({
      AccountIndex: 42,
      L1Address: WALLET,
      AssetIndex: 3,
      RouteType: 0,
      Amount: 11_000_000,
    }),
    event_info: JSON.stringify({
      a: 42,
      l: WALLET,
      ai: 3,
      rt: 0,
      c: 11_000_000,
      ic: false,
      ae: "",
    }),
    status: 3,
    transaction_index: 178,
    l1_address: WALLET,
    account_index: 42,
    nonce: -1,
    expire_at: 9_223_372_036_854_775_807,
    block_height: 313_485_202,
    queued_at: 1_786_949_159_112,
    executed_at: 1_786_949_159_112,
    sequence_index: 114_939_818_073,
    parent_hash: "",
    api_key_index: 0,
    transaction_time: 1_786_949_159_275_021,
    committed_at: 0,
    verified_at: 0,
    ...overrides,
  };
}

function accounts(
  overrides: Partial<LighterAccountsByL1AddressResponse> = {},
): LighterAccountsByL1AddressResponse {
  return {
    code: 200,
    l1_address: WALLET,
    sub_accounts: [
      { account_type: 1, index: 99, l1_address: WALLET },
      { account_type: 0, index: 42, l1_address: WALLET },
    ],
    ...overrides,
  };
}

describe("Lighter exact deposit evidence", () => {
  it("extracts the account index returned by the exact Ethereum Deposit event", () => {
    expect(l1()).toEqual({
      txHash: TX_HASH,
      blockHash: BLOCK_HASH,
      blockNumber: "23456789",
      accountIndex: 42,
      walletAddress: WALLET,
      assetIndex: 3,
      routeType: 0,
      amountUnits: "11000000",
    });
  });

  it("rejects receipts whose gateway event differs from the approved amount", () => {
    expect(() => proveLighterDepositL1(receipt(), {
      txHash: TX_HASH,
      gatewayAddress: GATEWAY,
      walletAddress: WALLET,
      recipientAddress: WALLET,
      assetIndex: 3,
      routeType: 0,
      amountUnits: 12_000_000n,
    })).toThrow("amount does not match");
  });

  it("rejects receipts with more than one gateway Deposit event", () => {
    const original = receipt();
    expect(() => proveLighterDepositL1({
      ...original,
      logs: [...original.logs, original.logs[0]!],
    }, {
      txHash: TX_HASH,
      gatewayAddress: GATEWAY,
      walletAddress: WALLET,
      recipientAddress: WALLET,
      assetIndex: 3,
      routeType: 0,
      amountUnits: 11_000_000n,
    })).toThrow("exactly one");
  });

  it("proves the exact executed Lighter transaction and event-selected owner", () => {
    const proof = proveLighterDepositCredit({ l1: l1(), tx: tx(), accounts: accounts() });

    expect(proof).toMatchObject({
      accountIndex: 42,
      lighterStatus: 3,
      lighterBlockHeight: 313_485_202,
      lighterExecutedAt: 1_786_949_159_112,
    });
  });

  it("keeps non-executed Lighter transaction states uncredited", () => {
    expect(() => proveLighterDepositCredit({
      l1: l1(),
      tx: tx({ status: 2, executed_at: 0 }),
      accounts: accounts(),
    })).toThrow("has not exposed an executed deposit");
  });

  it("rejects any Lighter transaction field that differs from the L1 event", () => {
    expect(() => proveLighterDepositCredit({
      l1: l1(),
      tx: tx({ info: JSON.stringify({
        AccountIndex: 42,
        L1Address: WALLET,
        AssetIndex: 3,
        RouteType: 0,
        Amount: 12_000_000,
      }) }),
      accounts: accounts(),
    })).toThrow("amount evidence does not match");
  });

  it("rejects ownership responses that omit the exact event-selected master account", () => {
    expect(() => proveLighterDepositCredit({
      l1: l1(),
      tx: tx(),
      accounts: accounts({
        sub_accounts: [{ account_type: 0, index: 41, l1_address: WALLET }],
      }),
    })).toThrow("master account is not uniquely owned");
  });
});

