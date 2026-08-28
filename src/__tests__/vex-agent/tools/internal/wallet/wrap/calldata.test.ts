/**
 * The derived transaction triple, byte for byte.
 *
 * The property under test is the one the lane's whole comparison strategy rests
 * on: `deposit()` calldata is a CONSTANT, identical for a one-wei wrap and a
 * whole-balance wrap on every chain, so the amount is only ever visible in
 * `valueWei`. Every assertion here therefore states the FULL `{to, data,
 * valueWei}` triple rather than the calldata alone - a test that checked only
 * `data` would pass while the transaction moved a different quantity of the
 * user's funds, which is precisely the defect the production comparison exists
 * to catch.
 */

import { describe, expect, it } from "vitest";

import {
  deriveWrapTransaction,
  isWrapDirection,
  wrapLegs,
  wrapTransactionsEqual,
  WRAP_DIRECTIONS,
} from "@vex-agent/tools/internal/wallet/wrap/calldata.js";
import type { WrappedNativeContract } from "@tools/evm-chains/wrapped-native.js";

const CONTRACT: WrappedNativeContract = {
  chainId: 8453,
  slug: "base",
  address: "0x4200000000000000000000000000000000000006",
  symbol: "WETH",
  decimals: 18,
  verifiedAt: "2026-08-28",
};

const DEPOSIT_SELECTOR = "0xd0e30db0";

describe("wrap builds deposit() with the amount in value, never in calldata", () => {
  it("emits the whole triple for one wei", () => {
    expect(deriveWrapTransaction({ direction: "wrap", contract: CONTRACT, amountRaw: 1n })).toEqual({
      to: "0x4200000000000000000000000000000000000006",
      data: DEPOSIT_SELECTOR,
      valueWei: "1",
    });
  });

  it("emits the whole triple for a whole-ether amount", () => {
    expect(
      deriveWrapTransaction({
        direction: "wrap",
        contract: CONTRACT,
        amountRaw: 1_000_000_000_000_000_000n,
      }),
    ).toEqual({
      to: "0x4200000000000000000000000000000000000006",
      data: DEPOSIT_SELECTOR,
      valueWei: "1000000000000000000",
    });
  });

  it("produces IDENTICAL calldata for two amounts a billion-fold apart", () => {
    // Stated as its own assertion because it is the invariant that makes
    // calldata-only comparison unsafe, and a reviewer should see it named.
    const small = deriveWrapTransaction({ direction: "wrap", contract: CONTRACT, amountRaw: 1n });
    const large = deriveWrapTransaction({
      direction: "wrap",
      contract: CONTRACT,
      amountRaw: 1_000_000_000_000_000_000n,
    });
    expect(small.data).toBe(large.data);
    expect(small.valueWei).not.toBe(large.valueWei);
  });
});

describe("unwrap builds withdraw(uint256) with the amount in calldata and no value", () => {
  it("left-pads one wei into a single 32-byte word", () => {
    expect(
      deriveWrapTransaction({ direction: "unwrap", contract: CONTRACT, amountRaw: 1n }),
    ).toEqual({
      to: "0x4200000000000000000000000000000000000006",
      data: `0x2e1a7d4d${"0".repeat(63)}1`,
      valueWei: "0",
    });
  });

  it("left-pads a whole-ether amount into a single 32-byte word", () => {
    const tx = deriveWrapTransaction({
      direction: "unwrap",
      contract: CONTRACT,
      amountRaw: 1_000_000_000_000_000_000n,
    });
    expect(tx).toEqual({
      to: "0x4200000000000000000000000000000000000006",
      data: "0x2e1a7d4d0000000000000000000000000000000000000000000000000de0b6b3a7640000",
      valueWei: "0",
    });
    // Selector plus exactly one word, and not a byte more.
    expect(tx.data).toHaveLength(2 + 8 + 64);
  });

  it("encodes the maximum uint256 without overflow or truncation", () => {
    const max = 2n ** 256n - 1n;
    expect(
      deriveWrapTransaction({ direction: "unwrap", contract: CONTRACT, amountRaw: max }).data,
    ).toBe(`0x2e1a7d4d${"f".repeat(64)}`);
  });
});

describe("a non-positive amount is refused rather than encoded", () => {
  for (const direction of WRAP_DIRECTIONS) {
    it(`throws on zero for ${direction}`, () => {
      expect(() =>
        deriveWrapTransaction({ direction, contract: CONTRACT, amountRaw: 0n }),
      ).toThrow(/positive integer/);
    });

    it(`throws on a negative amount for ${direction}`, () => {
      expect(() =>
        deriveWrapTransaction({ direction, contract: CONTRACT, amountRaw: -1n }),
      ).toThrow(/positive integer/);
    });
  }
});

describe("wrapTransactionsEqual compares the whole triple", () => {
  const base = deriveWrapTransaction({ direction: "wrap", contract: CONTRACT, amountRaw: 1n });

  it("is true for the same triple", () => {
    expect(wrapTransactionsEqual(base, { ...base })).toBe(true);
  });

  it("is FALSE when only valueWei differs while to and data are identical", () => {
    // The case the whole triple exists for. Both transactions call the same
    // contract with the same bytes; only the quantity of the user's funds moved
    // is different, and a calldata-only comparison would call them equal.
    const tampered = { ...base, valueWei: "1000000000000000000" };
    expect(tampered.to).toBe(base.to);
    expect(tampered.data).toBe(base.data);
    expect(wrapTransactionsEqual(base, tampered)).toBe(false);
  });

  it("is false when only `to` differs", () => {
    expect(
      wrapTransactionsEqual(base, { ...base, to: "0x1111111111111111111111111111111111111111" }),
    ).toBe(false);
  });

  it("is false when only `data` differs", () => {
    expect(wrapTransactionsEqual(base, { ...base, data: "0x2e1a7d4d" })).toBe(false);
  });
});

describe("direction vocabulary", () => {
  it("accepts exactly the two directions and nothing else", () => {
    expect(WRAP_DIRECTIONS).toEqual(["wrap", "unwrap"]);
    expect(isWrapDirection("wrap")).toBe(true);
    expect(isWrapDirection("unwrap")).toBe(true);
    for (const bad of ["WRAP", "deposit", "", null, undefined, 0, {}]) {
      expect(isWrapDirection(bad)).toBe(false);
    }
  });

  it("names the native leg on the side the direction actually spends", () => {
    expect(wrapLegs("wrap")).toEqual({ inputIsNative: true, outputIsNative: false });
    expect(wrapLegs("unwrap")).toEqual({ inputIsNative: false, outputIsNative: true });
  });
});
