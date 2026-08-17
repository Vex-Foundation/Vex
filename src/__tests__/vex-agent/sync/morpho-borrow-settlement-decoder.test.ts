/**
 * What a Morpho BLUE MARKET receipt proves about a `lend_borrow_operate` row,
 * and every way it refuses to claim an amount it cannot prove.
 *
 * WHY THIS DECODER READS EVENTS AND NOT NET TRANSFER DELTAS. The vault lane can
 * use wallet-relative net deltas because a deposit and a withdrawal each move
 * exactly two ERC-20s and the wallet is on one side of both. A Blue market
 * operation cannot: a repayment denominated in SHARES has no amount anywhere in
 * the intent at all, and the wallet's own net delta for the loan token would be
 * confirmed by ANY transfer of that token in the same transaction - a fee, a
 * swap leg, a second unrelated repayment. Morpho Blue emits its own event for
 * each of the four operations, carrying the market id, the position owner and
 * the exact asset amount the protocol itself accounted for. That event is the
 * only thing that proves WHICH market moved and WHOSE position changed.
 *
 * THE ADVERSARIAL SHAPES BELOW ARE THE POINT. Each refusal case is a way a
 * settlement could be invented:
 *
 *   - the right event on the WRONG market (Blue is permissionless: anybody can
 *     open a market and repay into it in the same transaction);
 *   - the right event for the wrong ONBEHALF (somebody else's position);
 *   - the right event from a contract that is not Blue (a look-alike emitting
 *     the same topic);
 *   - TWO matching events, where which one this row settled is not proven;
 *   - an amount ABOVE what the row authorised before broadcasting.
 *
 * THE REPAY-BY-SHARES CASE IS THE ONE THAT MOST NEEDS THIS. Its row is written
 * with `amountRaw = null` because the asset amount is decided on chain, so there
 * is no bound to hold it against and nothing but the event itself can say what
 * was paid.
 */

import { describe, it, expect } from "vitest";
import { encodeAbiParameters, pad, toHex } from "viem";

import {
  decodeMorphoBorrowSettlement,
  morphoBorrowRouteProvenance,
  readMorphoBorrowRouteProvenance,
  type MorphoSettlementLog,
} from "@vex-agent/sync/morpho-settlement-decoder.js";

const WALLET = "0xaaaabbbbccccddddeeeeffff0000111122223333";
const STRANGER = "0x1111222233334444555566667777888899990000";
const BLUE = "0xbbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb";
const IMPOSTOR = "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
const MARKET = `0x${"a1".repeat(32)}`;
const OTHER_MARKET = `0x${"b2".repeat(32)}`;

/** cbBTC collateral at 8 decimals, USDC debt at 6 - the pair the engine was proven against. */
const COLLATERAL_ASSETS = 5_000_000n;
const LOAN_ASSETS = 500_000_000n;
/** What a repay-by-shares actually consumed, knowable only from this event. */
const REPAID_ASSETS = 500_000_001n;
const REPAID_SHARES = 500_000_000_000_000n;

const TOPICS = {
  SupplyCollateral: "0xa3b9472a1399e17e123f3c2e6586c23e504184d504de59cdaa2b375e880c6184",
  WithdrawCollateral: "0xe80ebd7cc9223d7382aab2e0d1d6155c65651f83d53c8b9b06901d167e321142",
  Borrow: "0x570954540bed6b1304a87dfe815a5eda4a648f7097a16240dcd85c9b5fd42a43",
  Repay: "0x52acb05cebbd3cd39715469f22afbf5a17496295ef3bc9bb5944056c63ccaa09",
} as const;

function addr(value: string): string {
  return pad(value as `0x${string}`, { size: 32 });
}

/** `SupplyCollateral(id indexed, caller indexed, onBehalf indexed, assets)`. */
function supplyCollateralLog(over: Partial<{ blue: string; market: string; onBehalf: string; assets: bigint }> = {}): MorphoSettlementLog {
  return {
    address: over.blue ?? BLUE,
    topics: [TOPICS.SupplyCollateral, over.market ?? MARKET, addr(WALLET), addr(over.onBehalf ?? WALLET)],
    data: toHex(over.assets ?? COLLATERAL_ASSETS, { size: 32 }),
  };
}

/** `WithdrawCollateral(id indexed, caller, onBehalf indexed, receiver indexed, assets)`. */
function withdrawCollateralLog(over: Partial<{ market: string; onBehalf: string; assets: bigint }> = {}): MorphoSettlementLog {
  return {
    address: BLUE,
    topics: [TOPICS.WithdrawCollateral, over.market ?? MARKET, addr(over.onBehalf ?? WALLET), addr(WALLET)],
    data: encodeAbiParameters(
      [{ type: "address" }, { type: "uint256" }],
      [WALLET as `0x${string}`, over.assets ?? COLLATERAL_ASSETS],
    ),
  };
}

/** `Borrow(id indexed, caller, onBehalf indexed, receiver indexed, assets, shares)`. */
function borrowLog(over: Partial<{ market: string; onBehalf: string; assets: bigint }> = {}): MorphoSettlementLog {
  return {
    address: BLUE,
    topics: [TOPICS.Borrow, over.market ?? MARKET, addr(over.onBehalf ?? WALLET), addr(WALLET)],
    data: encodeAbiParameters(
      [{ type: "address" }, { type: "uint256" }, { type: "uint256" }],
      [WALLET as `0x${string}`, over.assets ?? LOAN_ASSETS, 1n],
    ),
  };
}

/** `Repay(id indexed, caller indexed, onBehalf indexed, assets, shares)`. */
function repayLog(over: Partial<{ market: string; onBehalf: string; assets: bigint }> = {}): MorphoSettlementLog {
  return {
    address: BLUE,
    topics: [TOPICS.Repay, over.market ?? MARKET, addr(WALLET), addr(over.onBehalf ?? WALLET)],
    data: encodeAbiParameters(
      [{ type: "uint256" }, { type: "uint256" }],
      [over.assets ?? REPAID_ASSETS, REPAID_SHARES],
    ),
  };
}

/** An ordinary ERC-20 Transfer of the same token, which must prove NOTHING here. */
const NOISE: MorphoSettlementLog = {
  address: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
  topics: [
    "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
    addr(WALLET),
    addr(BLUE),
  ],
  data: toHex(999_999_999n, { size: 32 }),
};

function decode(
  operation: "supply_collateral" | "withdraw_collateral" | "borrow" | "repay",
  logs: MorphoSettlementLog[],
  amountRaw: string | null,
) {
  // Both columns travel and the decoder reads the one its operation's direction
  // names, so no caller has to restate that mapping. The bound goes on the
  // matching column here; the test below proves a bound on the OTHER column is
  // ignored, which is what a decoder reading the wrong one would silently do.
  const inbound = operation === "supply_collateral" || operation === "repay";
  return decodeMorphoBorrowSettlement({
    logs,
    walletAddress: WALLET,
    provenance: { operation, marketId: MARKET, blueAddress: BLUE },
    amountInRaw: inbound ? amountRaw : null,
    amountOutRaw: inbound ? null : amountRaw,
  });
}

describe("morpho borrow settlement decoder: the four operations", () => {
  it("proves a supply_collateral from Blue's own event", () => {
    expect(decode("supply_collateral", [NOISE, supplyCollateralLog()], COLLATERAL_ASSETS.toString())).toEqual({
      kind: "decoded",
      direction: "in",
      executedAmountRaw: COLLATERAL_ASSETS.toString(),
    });
  });

  it("proves a withdraw_collateral as a leg the wallet RECEIVES", () => {
    expect(decode("withdraw_collateral", [withdrawCollateralLog()], COLLATERAL_ASSETS.toString())).toEqual({
      kind: "decoded",
      direction: "out",
      executedAmountRaw: COLLATERAL_ASSETS.toString(),
    });
  });

  it("proves a borrow as a leg the wallet RECEIVES, in the LOAN token's scale", () => {
    expect(decode("borrow", [borrowLog()], LOAN_ASSETS.toString())).toEqual({
      kind: "decoded",
      direction: "out",
      executedAmountRaw: LOAN_ASSETS.toString(),
    });
  });

  it("proves a repay by ASSETS as a leg the wallet SENDS", () => {
    const logs = [repayLog({ assets: LOAN_ASSETS })];
    expect(decode("repay", logs, LOAN_ASSETS.toString())).toEqual({
      kind: "decoded",
      direction: "in",
      executedAmountRaw: LOAN_ASSETS.toString(),
    });
  });

  it("fills in a repay by SHARES, whose row was written with no amount at all", () => {
    // The whole reason this decoder exists. The row's `amountRaw` is null
    // because the asset cost of burning a share count is decided on chain, so
    // the event is the ONLY statement of what was paid - and it is larger than
    // the amount originally borrowed, exactly as accrued interest requires.
    expect(decode("repay", [repayLog()], null)).toEqual({
      kind: "decoded",
      direction: "in",
      executedAmountRaw: REPAID_ASSETS.toString(),
    });
    expect(REPAID_ASSETS).toBeGreaterThan(LOAN_ASSETS);
  });

  it("reports what Blue APPLIED to the debt, not what the transaction pulled", () => {
    // Fork capture, Base 2026-08-17: a shares repay builds THREE legs, because
    // the SDK deliberately OVER-PULLS (the exact asset cost of burning a share
    // count is not knowable in advance) and sweeps the residual back. The
    // capture pulled 500,005,281 raw USDC against a debt of 500,000,001.
    //
    // THIS IS THE CASE THAT KILLS A NET-DELTA DECODE. The wallet's net delta
    // here is the pull minus the refund, which happens to be right only because
    // the refund landed in the same receipt; the amount the PROTOCOL applied is
    // the only number that is true by construction, and it is the one recorded.
    const PULLED = 500_005_281n;
    const logs: MorphoSettlementLog[] = [
      { ...NOISE, data: toHex(PULLED, { size: 32 }) },
      repayLog(),
      { ...NOISE, topics: [NOISE.topics[0]!, addr(BLUE), addr(WALLET)], data: toHex(PULLED - REPAID_ASSETS, { size: 32 }) },
    ];
    expect(decode("repay", logs, null)).toEqual({
      kind: "decoded",
      direction: "in",
      executedAmountRaw: REPAID_ASSETS.toString(),
    });
  });
});

describe("morpho borrow settlement decoder: what it refuses to claim", () => {
  it("declines when the row never persisted which market and operation to read", () => {
    const result = decodeMorphoBorrowSettlement({
      logs: [borrowLog()],
      walletAddress: WALLET,
      provenance: null,
      amountInRaw: null,
      amountOutRaw: LOAN_ASSETS.toString(),
    });
    expect(result.kind).toBe("declined");
    expect(result).toMatchObject({ reason: expect.stringContaining("did not persist") });
  });

  it("declines an event emitted by a contract that is not this chain's Morpho Blue", () => {
    const result = decode("supply_collateral", [supplyCollateralLog({ blue: IMPOSTOR })], COLLATERAL_ASSETS.toString());
    expect(result).toMatchObject({ kind: "declined", reason: expect.stringContaining("no Morpho Blue SupplyCollateral") });
  });

  it("declines an event for a DIFFERENT market in the same transaction", () => {
    const result = decode("borrow", [borrowLog({ market: OTHER_MARKET })], LOAN_ASSETS.toString());
    expect(result).toMatchObject({ kind: "declined", reason: expect.stringContaining("no Morpho Blue Borrow") });
  });

  it("declines an event that changed somebody ELSE's position", () => {
    const result = decode("repay", [repayLog({ onBehalf: STRANGER })], null);
    expect(result).toMatchObject({ kind: "declined", reason: expect.stringContaining("no Morpho Blue Repay") });
  });

  it("declines when TWO matching events leave it unproven which one this row settled", () => {
    const result = decode(
      "supply_collateral",
      [supplyCollateralLog(), supplyCollateralLog({ assets: 1n })],
      COLLATERAL_ASSETS.toString(),
    );
    expect(result).toMatchObject({
      kind: "declined",
      reason: expect.stringContaining("2 Morpho Blue SupplyCollateral events"),
    });
    expect(result).toMatchObject({ kind: "declined", reason: expect.stringContaining("not proven") });
  });

  it("declines an amount ABOVE what the row authorised before broadcasting", () => {
    const result = decode(
      "borrow",
      [borrowLog({ assets: LOAN_ASSETS + 1n })],
      LOAN_ASSETS.toString(),
    );
    expect(result).toMatchObject({ kind: "declined", reason: expect.stringContaining("exceeds") });
  });

  it("reads the bound from the column its own direction names, and ignores the other", () => {
    // A borrow's leg is on the OUT side. A number sitting in `amount_in_raw`
    // says nothing about it, so it must neither bound it nor decline it.
    const decoded = decodeMorphoBorrowSettlement({
      logs: [borrowLog()],
      walletAddress: WALLET,
      provenance: { operation: "borrow", marketId: MARKET, blueAddress: BLUE },
      amountInRaw: "1",
      amountOutRaw: LOAN_ASSETS.toString(),
    });
    expect(decoded).toMatchObject({ kind: "decoded", executedAmountRaw: LOAN_ASSETS.toString() });

    // And the bound it DOES read still bites.
    const declined = decodeMorphoBorrowSettlement({
      logs: [borrowLog()],
      walletAddress: WALLET,
      provenance: { operation: "borrow", marketId: MARKET, blueAddress: BLUE },
      amountInRaw: LOAN_ASSETS.toString(),
      amountOutRaw: "1",
    });
    expect(declined).toMatchObject({ kind: "declined", reason: expect.stringContaining("exceeds") });
  });

  it("declines a zero amount rather than reporting a fill of nothing", () => {
    const result = decode("supply_collateral", [supplyCollateralLog({ assets: 0n })], COLLATERAL_ASSETS.toString());
    expect(result).toMatchObject({ kind: "declined", reason: expect.stringContaining("zero") });
  });

  it("declines a wallet address that is not an EVM address", () => {
    const result = decodeMorphoBorrowSettlement({
      logs: [borrowLog()],
      walletAddress: "not-an-address",
      provenance: { operation: "borrow", marketId: MARKET, blueAddress: BLUE },
      amountInRaw: null,
      amountOutRaw: LOAN_ASSETS.toString(),
    });
    expect(result.kind).toBe("declined");
  });

  it("never reads an ERC-20 Transfer as a borrow settlement", () => {
    const result = decode("repay", [NOISE], null);
    expect(result).toMatchObject({ kind: "declined", reason: expect.stringContaining("no Morpho Blue Repay") });
  });
});

describe("morpho borrow route provenance: one owner, written and read here", () => {
  it("round-trips the three facts a borrow receipt must be read against", () => {
    const written = morphoBorrowRouteProvenance({
      operation: "repay",
      marketId: MARKET.toUpperCase(),
      blueAddress: BLUE.toUpperCase(),
    });
    expect(readMorphoBorrowRouteProvenance(written)).toEqual({
      operation: "repay",
      marketId: MARKET,
      blueAddress: BLUE,
    });
  });

  it("reads nothing from a row that has no provenance, and from a malformed one", () => {
    expect(readMorphoBorrowRouteProvenance(null)).toBeNull();
    expect(readMorphoBorrowRouteProvenance({})).toBeNull();
    expect(readMorphoBorrowRouteProvenance({
      morphoBorrow: { operation: "liquidate", marketId: MARKET, blueAddress: BLUE },
    })).toBeNull();
    expect(readMorphoBorrowRouteProvenance({
      morphoBorrow: { operation: "borrow", marketId: "0xdeadbeef", blueAddress: BLUE },
    })).toBeNull();
    expect(readMorphoBorrowRouteProvenance({
      morphoBorrow: { operation: "borrow", marketId: MARKET, blueAddress: "morpho" },
    })).toBeNull();
  });
});
