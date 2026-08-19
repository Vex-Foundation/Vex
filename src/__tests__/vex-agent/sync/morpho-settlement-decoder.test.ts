/**
 * What a Morpho receipt PROVES, and what it refuses to claim.
 *
 * The decoder's whole job is to be the thing that cannot be talked into
 * reporting a fill. So the cases below are mostly refusals, and each one is a
 * way a settlement could be invented:
 *
 *   - a share mint with no asset movement (the deposit never actually paid);
 *   - an asset movement with no shares (the wallet paid and received nothing);
 *   - an asset leg LARGER than the intent authorised, which cannot be this
 *     operation and is more likely another transfer in the same transaction;
 *   - an approval row, where nothing moved at all and a confident zero would be
 *     the worst possible answer;
 *   - an ERC-721 `Transfer`, whose third topic is a token id and not an amount.
 *
 * THE SHARE LEG IS DELIBERATELY UNBOUNDED. It is the market-dependent side and
 * the entire reason amounts are decoded rather than echoed from the quote;
 * whether it matches what was quoted is answered separately, by the absolute-
 * tolerance comparison, and reported to the user rather than used to suppress
 * the truth.
 *
 * The log shapes below are hand-built rather than captured wholesale because the
 * property under test is the net-delta rule, and a hand-built log can express
 * the adversarial shapes a clean fork capture never contains. The clean deposit
 * and withdrawal shapes match what the fork run produced.
 */

import { describe, it, expect } from "vitest";

import {
  decodeMorphoSettlement,
  type MorphoSettlementLog,
} from "@vex-agent/sync/morpho-settlement-decoder.js";

const WALLET = "0xaaaabbbbccccddddeeeeffff0000111122223333";
const ASSET = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const VAULT = "0xc1256ae5ff1cf2719d4937adb3bbccab2e00a2ca";
const ADAPTER = "0xb98c948cfa24072e58935bc004a8a7b376ae746a";
const ZERO = "0x0000000000000000000000000000000000000000";

const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

const DEPOSIT_ASSETS = 1_000_000n;
const MINTED_SHARES = 970_000_000_000_000_000n;

function pad(address: string): string {
  return `0x${"0".repeat(24)}${address.slice(2).toLowerCase()}`;
}

function word(value: bigint): string {
  return `0x${value.toString(16).padStart(64, "0")}`;
}

function transfer(token: string, from: string, to: string, amount: bigint): MorphoSettlementLog {
  return { address: token, topics: [TRANSFER_TOPIC, pad(from), pad(to)], data: word(amount) };
}

/** The shape a real deposit produces: asset out through the adapter, shares minted in. */
function depositLogs(): MorphoSettlementLog[] {
  return [
    transfer(ASSET, WALLET, ADAPTER, DEPOSIT_ASSETS),
    transfer(ASSET, ADAPTER, VAULT, DEPOSIT_ASSETS),
    transfer(VAULT, ZERO, WALLET, MINTED_SHARES),
  ];
}

/** The shape a real withdrawal produces: shares burned, assets paid straight out. */
function withdrawLogs(): MorphoSettlementLog[] {
  return [
    transfer(VAULT, WALLET, ZERO, MINTED_SHARES),
    transfer(ASSET, VAULT, WALLET, DEPOSIT_ASSETS),
  ];
}

function decodeDeposit(logs: MorphoSettlementLog[], overrides: Record<string, unknown> = {}) {
  return decodeMorphoSettlement({
    logs,
    walletAddress: WALLET,
    eventRole: "lend_deposit",
    tokenInAddress: ASSET,
    tokenOutAddress: VAULT,
    amountInRaw: DEPOSIT_ASSETS.toString(),
    amountOutRaw: MINTED_SHARES.toString(),
    ...overrides,
  });
}

function decodeWithdraw(logs: MorphoSettlementLog[], overrides: Record<string, unknown> = {}) {
  return decodeMorphoSettlement({
    logs,
    walletAddress: WALLET,
    eventRole: "lend_withdraw",
    tokenInAddress: VAULT,
    tokenOutAddress: ASSET,
    amountInRaw: MINTED_SHARES.toString(),
    amountOutRaw: DEPOSIT_ASSETS.toString(),
    ...overrides,
  });
}

describe("decodeMorphoSettlement: a clean deposit", () => {
  it("proves the asset spent and the shares minted from the receipt's own logs", () => {
    expect(decodeDeposit(depositLogs())).toEqual({
      executedAmountInRaw: DEPOSIT_ASSETS.toString(),
      executedAmountOutRaw: MINTED_SHARES.toString(),
    });
  });

  it("reads the wallet's NET delta, so the adapter hop in the middle is invisible", () => {
    // The asset travels wallet -> adapter -> vault inside one transaction. Only
    // the first leg is the wallet's, and the net delta says so without this
    // module knowing what an adapter is.
    const logs = [...depositLogs(), transfer(ASSET, ADAPTER, VAULT, 5n)];
    expect(decodeDeposit(logs)?.executedAmountInRaw).toBe(DEPOSIT_ASSETS.toString());
  });

  it("reports the shares the receipt proved even when they differ from the quote", () => {
    const drifted = MINTED_SHARES - 12_345n;
    const logs = [
      transfer(ASSET, WALLET, ADAPTER, DEPOSIT_ASSETS),
      transfer(VAULT, ZERO, WALLET, drifted),
    ];
    // The share leg is unbounded on purpose: recording the quoted figure here
    // would be recording a quote as a settlement.
    expect(decodeDeposit(logs)?.executedAmountOutRaw).toBe(drifted.toString());
  });
});

describe("decodeMorphoSettlement: a clean withdrawal", () => {
  it("proves the shares burned and the assets received", () => {
    expect(decodeWithdraw(withdrawLogs())).toEqual({
      executedAmountInRaw: MINTED_SHARES.toString(),
      executedAmountOutRaw: DEPOSIT_ASSETS.toString(),
    });
  });

  it("declines when the assets received exceed what the row asked for", () => {
    const logs = [
      transfer(VAULT, WALLET, ZERO, MINTED_SHARES),
      transfer(ASSET, VAULT, WALLET, DEPOSIT_ASSETS + 1n),
    ];
    expect(decodeWithdraw(logs)).toBeNull();
  });
});

describe("decodeMorphoSettlement: what it refuses to claim", () => {
  it("declines a deposit whose asset never left the wallet", () => {
    expect(decodeDeposit([transfer(VAULT, ZERO, WALLET, MINTED_SHARES)])).toBeNull();
  });

  it("declines a deposit that minted no shares to the wallet", () => {
    expect(decodeDeposit([transfer(ASSET, WALLET, ADAPTER, DEPOSIT_ASSETS)])).toBeNull();
  });

  it("declines a deposit whose asset leg exceeds the amount the intent authorised", () => {
    const logs = [
      transfer(ASSET, WALLET, ADAPTER, DEPOSIT_ASSETS + 1n),
      transfer(VAULT, ZERO, WALLET, MINTED_SHARES),
    ];
    expect(decodeDeposit(logs)).toBeNull();
  });

  it("declines when the row carries no recorded amount to bound the decode with", () => {
    expect(decodeDeposit(depositLogs(), { amountInRaw: null })).toBeNull();
    expect(decodeWithdraw(withdrawLogs(), { amountOutRaw: null })).toBeNull();
  });

  it("declines an EMPTY receipt rather than reporting a zero fill", () => {
    expect(decodeDeposit([])).toBeNull();
  });

  it("declines the allowance roles BY NAME, because an approval moves nothing", () => {
    for (const eventRole of ["allowance", "allowance_reset"]) {
      expect(decodeMorphoSettlement({
        logs: depositLogs(),
        walletAddress: WALLET,
        eventRole,
        tokenInAddress: ASSET,
        tokenOutAddress: null,
        amountInRaw: DEPOSIT_ASSETS.toString(),
        amountOutRaw: null,
      })).toBeNull();
    }
  });

  it("declines a role this venue does not write", () => {
    expect(decodeDeposit(depositLogs(), { eventRole: "swap" })).toBeNull();
  });

  it("ignores an ERC-721 Transfer, whose third topic is a token id and not an amount", () => {
    const erc721 = {
      address: VAULT,
      topics: [TRANSFER_TOPIC, pad(ZERO), pad(WALLET), word(MINTED_SHARES)],
      data: "0x",
    };
    expect(decodeDeposit([transfer(ASSET, WALLET, ADAPTER, DEPOSIT_ASSETS), erc721])).toBeNull();
  });

  it("ignores a malformed amount word instead of throwing on it", () => {
    const malformed = { address: VAULT, topics: [TRANSFER_TOPIC, pad(ZERO), pad(WALLET)], data: "0xnot-a-word" };
    expect(decodeDeposit([transfer(ASSET, WALLET, ADAPTER, DEPOSIT_ASSETS), malformed])).toBeNull();
  });

  it("declines when the row's wallet is not a readable address", () => {
    expect(decodeDeposit(depositLogs(), { walletAddress: "not-an-address" })).toBeNull();
  });
});
