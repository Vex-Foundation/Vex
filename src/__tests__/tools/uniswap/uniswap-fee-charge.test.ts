/**
 * The Uniswap fee arithmetic — exact bigint, truncating, and `fee + net`
 * ALWAYS equal to the total the user asked to spend.
 *
 * The handler test (`uniswap-fee-ordering.test.ts`) pins the ordering; this
 * pins the numbers, including the two cases a rounding mistake hides in: an
 * amount that does not divide evenly, and one small enough that 25 bps floors
 * to zero.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { UniswapToken } from "@tools/uniswap/types.js";

const getHoneypotFotInfo = vi.fn();

vi.mock("@tools/kyberswap/token-api/client.js", () => ({
  getKyberTokenApiClient: vi.fn(() => ({ getHoneypotFotInfo: (...a: unknown[]) => getHoneypotFotInfo(...a) })),
}));

const { resolveUniswapFeeCharge, UNISWAP_FEE_BPS, UNISWAP_FEE_RECEIVER_EVM } = await import("@tools/uniswap/fee/index.js");

const CHAIN_ID = 4663;
const ERC20: UniswapToken = {
  address: "0x8Ff92566f2e81BDd68EDfAa8cde73942A723796b",
  symbol: "TKN", decimals: 6, isNative: false,
};
const NATIVE: UniswapToken = {
  address: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
  symbol: "ETH", decimals: 18, isNative: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  getHoneypotFotInfo.mockResolvedValue({ isHoneypot: false, isFOT: false, tax: 0 });
});

describe("resolveUniswapFeeCharge", () => {
  it("charges exactly 25 bps and leaves the remainder for the swap", async () => {
    const charge = await resolveUniswapFeeCharge({ chainId: CHAIN_ID, tokenIn: ERC20, amountInRaw: 1_000_000n });

    expect(UNISWAP_FEE_BPS).toBe(25);
    expect(charge.feeRaw).toBe(2_500n);
    expect(charge.swapAmountRaw).toBe(997_500n);
    expect(charge.feeRaw! + charge.swapAmountRaw).toBe(charge.totalRaw);
  });

  it("TRUNCATES — a remainder is never rounded up, so the user is never charged a unit Vex did not earn", async () => {
    // 999 × 25 / 10000 = 2.4975 → 2.
    const charge = await resolveUniswapFeeCharge({ chainId: CHAIN_ID, tokenIn: ERC20, amountInRaw: 999n });

    expect(charge.feeRaw).toBe(2n);
    expect(charge.swapAmountRaw).toBe(997n);
    expect(charge.feeRaw! + charge.swapAmountRaw).toBe(999n);
  });

  it("DUST: a fee that floors to zero means NO leg at all — never a zero-value transfer", async () => {
    const charge = await resolveUniswapFeeCharge({ chainId: CHAIN_ID, tokenIn: ERC20, amountInRaw: 399n });

    expect(charge.feeRaw).toBeNull();
    expect(charge.feeTokenAddress).toBeNull();
    expect(charge.swapAmountRaw).toBe(399n);
    expect(charge.disclosure.charged).toBe(false);
  });

  it("discloses the exact raw amount, its decimal form, and the treasury that receives it", async () => {
    const charge = await resolveUniswapFeeCharge({ chainId: CHAIN_ID, tokenIn: ERC20, amountInRaw: 1_000_000n });

    expect(charge.disclosure).toMatchObject({
      charged: true,
      bps: 25,
      chargedOn: "currency_in",
      feeAmountRaw: "2500",
      // 6 decimals — the raw amount and the readable one must never disagree.
      feeAmountDecimal: "0.0025",
      tokenDecimals: 6,
      swappedAmountRaw: "997500",
      totalDebitedRaw: "1000000",
      receiver: UNISWAP_FEE_RECEIVER_EVM,
    });
  });

  it("a NATIVE input is identified by the shared sentinel, never by the deployment's WETH", async () => {
    const charge = await resolveUniswapFeeCharge({ chainId: CHAIN_ID, tokenIn: NATIVE, amountInRaw: 10n ** 18n });

    expect(charge.feeTokenAddress?.toLowerCase()).toBe("0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee");
    // Native coins have no transfer hook — the eligibility oracle is not consulted.
    expect(getHoneypotFotInfo).not.toHaveBeenCalled();
  });

  it("declines the fee on a fee-on-transfer token and states why, leaving the FULL amount to the swap", async () => {
    getHoneypotFotInfo.mockResolvedValue({ isHoneypot: false, isFOT: true, tax: 3 });

    const charge = await resolveUniswapFeeCharge({ chainId: CHAIN_ID, tokenIn: ERC20, amountInRaw: 1_000_000n });

    expect(charge.feeRaw).toBeNull();
    expect(charge.swapAmountRaw).toBe(1_000_000n);
    expect(charge.disclosure.charged).toBe(false);
    if (!charge.disclosure.charged) expect(charge.disclosure.reason).toContain("fee-on-transfer");
  });

  it("FAIL-SOFT: an eligibility-oracle outage charges the fee rather than silently skipping revenue", async () => {
    getHoneypotFotInfo.mockRejectedValue(new Error("429"));

    const charge = await resolveUniswapFeeCharge({ chainId: CHAIN_ID, tokenIn: ERC20, amountInRaw: 1_000_000n });

    expect(charge.feeRaw).toBe(2_500n);
  });
});
