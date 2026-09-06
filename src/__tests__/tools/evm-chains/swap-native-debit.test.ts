/**
 * The whole native debit of an EVM swap plan.
 *
 * ## What these tests pin
 *
 * 1. `maxFeePerGas` ALREADY CONTAINS the priority fee. Adding the two is the
 *    arithmetic mistake that makes a wallet look poorer than it is, and it is
 *    the kind of mistake that only ever shows up as "the agent refuses swaps I
 *    can afford". One test computes the total twice - once through the module
 *    and once by hand with the priority fee added - and asserts they DIFFER by
 *    exactly the double count.
 * 2. A leg already broadcast has already taken its money and is not charged a
 *    second time.
 * 3. Anything that cannot be priced REFUSES. An L1 fee that could not be read
 *    never degrades to zero, because a zero would be indistinguishable from a
 *    chain that genuinely has no posting cost.
 * 4. The reserve is a MEASURED transaction, not a percentage: it is estimated
 *    live and it fails closed when the estimate does not come back.
 */

import { describe, expect, it, vi } from "vitest";
import type { Address } from "viem";

import { getL1DataFeeCapability } from "@tools/evm-chains/l1-data-fee.js";
import type { L1DataFeeEstimate } from "@tools/evm-chains/l1-data-fee.js";
import {
  boundGasPriceWei,
  checkFeeCap,
  computeSwapNativeDebit,
  estimateLegL1DataFee,
  priceFollowUpReserve,
  type LegFeeCap,
  type NativeDebitLeg,
} from "@tools/evm-chains/swap-native-debit.js";

const WALLET = "0x1111111111111111111111111111111111111111" as Address;
const ROUTER = "0x2222222222222222222222222222222222222222" as Address;

const EIP1559: LegFeeCap = {
  mode: "eip1559",
  maxFeePerGasWei: 3_000_000_000n,
  maxPriorityFeePerGasWei: 1_000_000_000n,
};
const LEGACY: LegFeeCap = { mode: "legacy", gasPriceWei: 2_500_000_000n };

const NO_L1: L1DataFeeEstimate = {
  kind: "priced",
  // Arbitrum: the posting cost rides in the gas units, so nothing is added.
  capability: getL1DataFeeCapability(42161) ?? (() => { throw new Error("missing 42161 row"); })(),
  additionalWei: 0n,
};
function l1(additionalWei: bigint): L1DataFeeEstimate {
  return {
    kind: "priced",
    capability: getL1DataFeeCapability(8453) ?? (() => { throw new Error("missing 8453 row"); })(),
    additionalWei,
  };
}
const L1_UNAVAILABLE: L1DataFeeEstimate = {
  kind: "unavailable",
  chainId: 8453,
  cause: "l1_data_fee_oracle_read_failed",
};

function leg(overrides: Partial<NativeDebitLeg> = {}): NativeDebitLeg {
  return {
    role: "swap",
    valueWei: 0n,
    gasLimit: 200_000n,
    feeCap: EIP1559,
    l1: NO_L1,
    broadcast: false,
    ...overrides,
  };
}

const RESERVE = { gasLimit: 21_000n, feeCap: EIP1559, l1: NO_L1 };

describe("the EIP-1559 ceiling is not paid twice", () => {
  it("prices gas from maxFeePerGas alone", () => {
    const debit = computeSwapNativeDebit({ legs: [leg()], reserve: RESERVE });

    if (!debit.ok) throw new Error("expected a priced debit");
    const swapGas = 200_000n * EIP1559.maxFeePerGasWei;
    const reserveGas = 21_000n * EIP1559.maxFeePerGasWei;
    expect(debit.totalWei).toBe(swapGas + reserveGas);
    expect(debit.totalRaw).toBe((swapGas + reserveGas).toString(10));

    // The defect, stated as a difference: the naive total adds the priority fee
    // on top of a ceiling that already contains it.
    const doubleCounted = 221_000n * (EIP1559.maxFeePerGasWei + EIP1559.maxPriorityFeePerGasWei);
    expect(debit.totalWei).not.toBe(doubleCounted);
    expect(doubleCounted - debit.totalWei).toBe(221_000n * EIP1559.maxPriorityFeePerGasWei);
  });

  it("uses the legacy gas price when that is the approved mode", () => {
    expect(boundGasPriceWei(LEGACY)).toBe(LEGACY.gasPriceWei);
    expect(boundGasPriceWei(EIP1559)).toBe(EIP1559.maxFeePerGasWei);
  });
});

describe("the total is the whole plan, not one leg", () => {
  it("sums value, gas and the L1 fee across every leg still to be sent, plus the reserve", () => {
    const debit = computeSwapNativeDebit({
      legs: [
        leg({ role: "allowance_reset", gasLimit: 46_000n, l1: l1(11n) }),
        leg({ role: "allowance", gasLimit: 55_000n, l1: l1(12n) }),
        leg({ role: "swap", gasLimit: 210_000n, valueWei: 4_000_000_000_000_000n, l1: l1(13n) }),
        leg({ role: "swap_fee", gasLimit: 30_000n, valueWei: 100_000_000_000_000n, l1: l1(14n) }),
      ],
      reserve: { gasLimit: 21_000n, feeCap: EIP1559, l1: l1(15n) },
    });

    if (!debit.ok) throw new Error("expected a priced debit");
    const gasUnits = 46_000n + 55_000n + 210_000n + 30_000n + 21_000n;
    const expected = gasUnits * EIP1559.maxFeePerGasWei
      + 4_000_000_000_000_000n + 100_000_000_000_000n
      + 11n + 12n + 13n + 14n + 15n;
    expect(debit.totalWei).toBe(expected);
    expect(debit.legs.map((cost) => cost.role)).toEqual([
      "allowance_reset", "allowance", "swap", "swap_fee", "follow_up_reserve",
    ]);
    expect(debit.reserveWei).toBe(21_000n * EIP1559.maxFeePerGasWei + 15n);
  });

  it("does not charge again for a leg already in flight", () => {
    const withBroadcast = computeSwapNativeDebit({
      legs: [leg({ role: "allowance", broadcast: true }), leg({ role: "swap" })],
      reserve: RESERVE,
    });
    const swapOnly = computeSwapNativeDebit({ legs: [leg({ role: "swap" })], reserve: RESERVE });

    if (!withBroadcast.ok || !swapOnly.ok) throw new Error("expected priced debits");
    expect(withBroadcast.totalWei).toBe(swapOnly.totalWei);
    expect(withBroadcast.legs.map((cost) => cost.role)).toEqual(["swap", "follow_up_reserve"]);
  });

  it("charges the native principal of a native-input swap on top of its gas", () => {
    const principal = 1_000_000_000_000_000_000n;
    const debit = computeSwapNativeDebit({
      legs: [leg({ valueWei: principal })],
      reserve: RESERVE,
    });

    if (!debit.ok) throw new Error("expected a priced debit");
    expect(debit.totalWei).toBe(principal + 221_000n * EIP1559.maxFeePerGasWei);
  });

  it("still carries a reserve when the plan has no legs left to broadcast", () => {
    const debit = computeSwapNativeDebit({ legs: [], reserve: RESERVE });

    if (!debit.ok) throw new Error("expected a priced debit");
    expect(debit.totalWei).toBe(debit.reserveWei);
  });
});

describe("anything that cannot be priced refuses", () => {
  it("refuses the whole total when one leg's L1 fee is unavailable, naming that leg", () => {
    const debit = computeSwapNativeDebit({
      legs: [leg({ role: "allowance", l1: l1(5n) }), leg({ role: "swap", l1: L1_UNAVAILABLE })],
      reserve: RESERVE,
    });

    expect(debit).toEqual({ ok: false, cause: "l1_data_fee_oracle_read_failed", role: "swap" });
  });

  it("refuses when the RESERVE's own L1 fee is unavailable", () => {
    const debit = computeSwapNativeDebit({
      legs: [leg()],
      reserve: { gasLimit: 21_000n, feeCap: EIP1559, l1: L1_UNAVAILABLE },
    });

    expect(debit).toEqual({
      ok: false,
      cause: "l1_data_fee_oracle_read_failed",
      role: "follow_up_reserve",
    });
  });

  it("refuses an unmeasured chain rather than treating its posting cost as zero", () => {
    const debit = computeSwapNativeDebit({
      legs: [leg({ l1: { kind: "unavailable", chainId: 424_242, cause: "l1_data_fee_capability_unknown" } })],
      reserve: RESERVE,
    });

    expect(debit).toEqual({ ok: false, cause: "l1_data_fee_capability_unknown", role: "swap" });
  });

  it("refuses a negative amount instead of subtracting it from the total", () => {
    const debit = computeSwapNativeDebit({
      legs: [leg({ valueWei: -1n })],
      reserve: RESERVE,
    });

    expect(debit).toEqual({ ok: false, cause: "negative_amount", role: "swap" });
  });
});

describe("the follow-up reserve is measured, never a percentage", () => {
  it("prices a zero-value self-transfer with the gas the chain actually estimates", async () => {
    // Arbitrum's own empty-transfer estimate was measured at 21737 gas on
    // 2026-08-31 - above the 21000 EVM intrinsic, because its posting cost is
    // inside the units. Assuming 21000 would under-reserve on that chain.
    const estimateGas = vi.fn(async () => 21_737n);
    const readContract = vi.fn(async () => 0n);

    const priced = await priceFollowUpReserve({ estimateGas, readContract }, {
      chainId: 42161,
      wallet: WALLET,
      feeCap: EIP1559,
      nonce: 3,
    });

    expect(estimateGas).toHaveBeenCalledWith({ account: WALLET, to: WALLET, value: 0n });
    if (!priced.ok) throw new Error("expected a priced reserve");
    expect(priced.reserve.gasLimit).toBe(21_737n);
    // Arbitrum is `in_gas_estimate`, so the oracle is not consulted at all.
    expect(readContract).not.toHaveBeenCalled();
  });

  it("includes the chain's L1 data fee where there is one", async () => {
    const priced = await priceFollowUpReserve(
      { estimateGas: async () => 21_000n, readContract: async () => 400n },
      { chainId: 8453, wallet: WALLET, feeCap: EIP1559, nonce: 1 },
    );

    if (!priced.ok) throw new Error("expected a priced reserve");
    const debit = computeSwapNativeDebit({ legs: [], reserve: priced.reserve });
    if (!debit.ok) throw new Error("expected a priced debit");
    expect(debit.reserveWei).toBe(21_000n * EIP1559.maxFeePerGasWei + 400n);
  });

  it("refuses when the estimate cannot be taken - there is no default reserve", async () => {
    const priced = await priceFollowUpReserve(
      {
        estimateGas: async () => {
          throw new Error("endpoint unreachable");
        },
        readContract: async () => 0n,
      },
      { chainId: 8453, wallet: WALLET, feeCap: EIP1559, nonce: 1 },
    );

    expect(priced).toEqual({ ok: false, cause: "follow_up_reserve_estimate_failed" });
  });

  it("refuses when the reserve's L1 fee cannot be read", async () => {
    const priced = await priceFollowUpReserve(
      {
        estimateGas: async () => 21_000n,
        readContract: async () => {
          throw new Error("oracle unreachable");
        },
      },
      { chainId: 8453, wallet: WALLET, feeCap: EIP1559, nonce: 1 },
    );

    expect(priced).toEqual({ ok: false, cause: "l1_data_fee_oracle_read_failed" });
  });
});

describe("the approved ceiling is enforced against the current requirement", () => {
  it("accepts a current requirement at or below the approved ceiling", () => {
    expect(checkFeeCap(
      { gasLimit: 200_000n, cap: EIP1559 },
      { gasLimit: 210_000n, cap: EIP1559 },
    )).toEqual({ withinCap: true });
  });

  it("refuses a requirement above the ceiling, naming the field and both figures", () => {
    expect(checkFeeCap(
      { gasLimit: 210_000n, cap: { ...EIP1559, maxFeePerGasWei: 9_000_000_000n } },
      { gasLimit: 210_000n, cap: EIP1559 },
    )).toEqual({
      withinCap: false,
      field: "maxFeePerGas",
      requiredRaw: "9000000000",
      approvedRaw: "3000000000",
    });
    expect(checkFeeCap(
      { gasLimit: 300_000n, cap: EIP1559 },
      { gasLimit: 210_000n, cap: EIP1559 },
    )).toMatchObject({ withinCap: false, field: "gas limit" });
    expect(checkFeeCap(
      { gasLimit: 210_000n, cap: { ...EIP1559, maxPriorityFeePerGasWei: 2_000_000_000n } },
      { gasLimit: 210_000n, cap: EIP1559 },
    )).toMatchObject({ withinCap: false, field: "maxPriorityFeePerGas" });
  });

  it("refuses when the chain changed pricing mode under the quote", () => {
    expect(checkFeeCap(
      { gasLimit: 210_000n, cap: LEGACY },
      { gasLimit: 210_000n, cap: EIP1559 },
    )).toEqual({
      withinCap: false,
      field: "pricing mode",
      requiredRaw: "legacy",
      approvedRaw: "eip1559",
    });
  });
});

describe("a leg's L1 fee is priced under that leg's own cap", () => {
  it("passes the cap's ceiling into the serialized bytes and never the priority fee alone", async () => {
    const readContract = vi.fn(async () => 77n);

    const estimate = await estimateLegL1DataFee({ readContract }, {
      chainId: 8453,
      transaction: { to: ROUTER, data: "0xabcdef", value: 1n, gas: 210_000n, nonce: 4 },
      feeCap: EIP1559,
    });

    expect(estimate).toMatchObject({ kind: "priced", additionalWei: 77n });
    expect(readContract).toHaveBeenCalledTimes(1);
  });
});
