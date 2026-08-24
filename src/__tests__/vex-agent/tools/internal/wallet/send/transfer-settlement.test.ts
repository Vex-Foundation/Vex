/**
 * `send/transfer-settlement.ts` - what an EVM receipt proves a transfer moved
 *
 *
 * THE DEFECT THESE GUARD AGAINST: `transfer` returns `bool`. A token that
 * returns `false`, or a fee-on-transfer token that delivers less, does NOT
 * revert, so `receipt.status === "success"` proves inclusion and nothing about
 * the amount. Writing the requested amount into `executed_amount_in_raw` on that
 * evidence records a request as settled truth.
 *
 * Pure functions, real log fixtures, no chain.
 */

import { describe, it, expect } from "vitest";

import {
  proveErc20Transfer,
  proveErc721Transfer,
  type ReceiptLog,
} from "@vex-agent/tools/internal/wallet/send/transfer-settlement.js";

const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const TOKEN = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";
const FROM = "0xabcdef1234567890abcdef1234567890abcdef12";
const TO = "0xffcf8fdee72ac11b5c542428b35eef5769c409f0";
const OTHER = "0x1111111111111111111111111111111111111111";
const AMOUNT = 25_000_000n;

function padded(address: string): string {
  return `0x000000000000000000000000${address.slice(2).toLowerCase()}`;
}

function amountData(value: bigint): string {
  return `0x${value.toString(16).padStart(64, "0")}`;
}

function erc20Log(overrides: Partial<ReceiptLog> = {}): ReceiptLog {
  return {
    address: TOKEN,
    topics: [TRANSFER_TOPIC, padded(FROM), padded(TO)],
    data: amountData(AMOUNT),
    ...overrides,
  };
}

const erc20Input = {
  tokenAddress: TOKEN,
  from: FROM,
  to: TO,
  expectedAmountRaw: AMOUNT,
};

describe("proveErc20Transfer", () => {
  it("proves the amount when the log matches contract, sender, recipient and amount", () => {
    expect(proveErc20Transfer({ logs: [erc20Log()], ...erc20Input })).toBe(AMOUNT);
  });

  it("matches irrespective of address casing on either side", () => {
    const log = erc20Log({ address: TOKEN.toUpperCase().replace("0X", "0x") });
    expect(proveErc20Transfer({ logs: [log], ...erc20Input })).toBe(AMOUNT);
  });

  it("finds its log among unrelated ones in the same receipt", () => {
    const noise: ReceiptLog = {
      address: OTHER,
      topics: [TRANSFER_TOPIC, padded(OTHER), padded(TO)],
      data: amountData(999n),
    };
    expect(proveErc20Transfer({ logs: [noise, erc20Log()], ...erc20Input })).toBe(AMOUNT);
  });

  it("proves NOTHING when the receipt carries no Transfer log at all", () => {
    // The `transfer` that returned `false` without reverting.
    expect(proveErc20Transfer({ logs: [], ...erc20Input })).toBeNull();
  });

  it("proves NOTHING when the amount differs - a fee-on-transfer shortfall is not the requested amount", () => {
    const short = erc20Log({ data: amountData(AMOUNT - 1n) });
    expect(proveErc20Transfer({ logs: [short], ...erc20Input })).toBeNull();
  });

  it("proves NOTHING when the log belongs to a different token contract", () => {
    expect(proveErc20Transfer({ logs: [erc20Log({ address: OTHER })], ...erc20Input })).toBeNull();
  });

  it("proves NOTHING when the recipient is not the one we sent to", () => {
    const wrongTo = erc20Log({ topics: [TRANSFER_TOPIC, padded(FROM), padded(OTHER)] });
    expect(proveErc20Transfer({ logs: [wrongTo], ...erc20Input })).toBeNull();
  });

  it("proves NOTHING when the sender is not our wallet", () => {
    const wrongFrom = erc20Log({ topics: [TRANSFER_TOPIC, padded(OTHER), padded(TO)] });
    expect(proveErc20Transfer({ logs: [wrongFrom], ...erc20Input })).toBeNull();
  });

  it("ignores an ERC-721 log on the same contract - a token id is not an amount", () => {
    const erc721 = erc20Log({
      topics: [TRANSFER_TOPIC, padded(FROM), padded(TO), amountData(AMOUNT)],
      data: "0x",
    });
    expect(proveErc20Transfer({ logs: [erc721], ...erc20Input })).toBeNull();
  });

  it("proves NOTHING for empty or malformed log data rather than reading it as zero", () => {
    for (const data of ["0x", "", "not-hex"]) {
      expect(proveErc20Transfer({ logs: [erc20Log({ data })], ...erc20Input })).toBeNull();
    }
  });

  it("proves a genuine zero-amount transfer when that is what the log says", () => {
    // A zero the receipt states IS proven, and is different from unproven.
    const zeroLog = erc20Log({ data: amountData(0n) });
    expect(
      proveErc20Transfer({ logs: [zeroLog], ...erc20Input, expectedAmountRaw: 0n }),
    ).toBe(0n);
  });
});

describe("proveErc721Transfer", () => {
  const TOKEN_ID = 7n;
  const input = { contractAddress: TOKEN, from: FROM, to: TO, tokenId: TOKEN_ID };

  function erc721Log(overrides: Partial<ReceiptLog> = {}): ReceiptLog {
    return {
      address: TOKEN,
      topics: [TRANSFER_TOPIC, padded(FROM), padded(TO), amountData(TOKEN_ID)],
      data: "0x",
      ...overrides,
    };
  }

  it("proves ONE item moved when the token id matches", () => {
    expect(proveErc721Transfer({ logs: [erc721Log()], ...input })).toBe(1n);
  });

  it("proves NOTHING for a different token id", () => {
    const other = erc721Log({ topics: [TRANSFER_TOPIC, padded(FROM), padded(TO), amountData(8n)] });
    expect(proveErc721Transfer({ logs: [other], ...input })).toBeNull();
  });

  it("proves NOTHING when there is no log", () => {
    expect(proveErc721Transfer({ logs: [], ...input })).toBeNull();
  });

  it("ignores a 3-topic ERC-20 log - an amount is not a token id", () => {
    expect(proveErc721Transfer({ logs: [erc20Log()], ...input })).toBeNull();
  });

  it("proves NOTHING when the recipient differs", () => {
    const wrongTo = erc721Log({
      topics: [TRANSFER_TOPIC, padded(FROM), padded(OTHER), amountData(TOKEN_ID)],
    });
    expect(proveErc721Transfer({ logs: [wrongTo], ...input })).toBeNull();
  });
});
