/**
 * Shared Vex-fee fixtures for the prequote and approval-card suites.
 *
 * A helper MODULE, not a spec: it exports data builders only, so each suite
 * still owns its own arrangement and assertions. It exists because a
 * fee-bearing quote now MUST state its fee (the recorder skips the row
 * otherwise) and a fee-bearing gated execute MUST find that statement on its
 * matched row (the gate blocks otherwise), so a dozen suites need the same two
 * shapes and twelve hand-copied literals would drift the moment the schema does.
 *
 * Two shapes, deliberately distinct:
 *   - {@link venueBridgeVexFee} / {@link venueSwapVexFee} are what a VENUE emits
 *     in `result.data.vexFee` (the `bridgedAmountRaw` / `swappedAmountRaw`
 *     spelling, the USD estimate, the prose note) - the recorder's input.
 *   - {@link rowVexFee} is the PERSISTED block a row's `safety_detail` carries
 *     after projection - the gate's input.
 */

/** Venue disclosure as `src/tools/bridge-fee/fee-disclosure.ts` builds it. */
export function venueBridgeVexFee(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    charged: true,
    bps: 25,
    chargedOn: "currency_in",
    tokenAddress: "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    tokenSymbol: "USDC",
    tokenDecimals: 6,
    feeAmountRaw: "2500",
    feeAmountDecimal: "0.0025",
    feeUsdEstimate: "0.0025",
    receiver: "0xTREASURY",
    bridgedAmountRaw: "997500",
    totalDebitedRaw: "1000000",
    note: "Vex charges 25 bps on the input token of every bridge.",
    ...overrides,
  };
}

/** Venue disclosure as the Uniswap and KyberSwap builders emit it. */
export function venueSwapVexFee(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    charged: true,
    bps: 25,
    chargedOn: "currency_in",
    tokenAddress: "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    tokenSymbol: "USDC",
    tokenDecimals: 6,
    feeAmountRaw: "2500",
    feeAmountDecimal: "0.0025",
    receiver: "0xTREASURY",
    swappedAmountRaw: "997500",
    totalDebitedRaw: "1000000",
    note: "Vex charges 25 bps on the input token of every swap.",
    ...overrides,
  };
}

/** The projected block a recorded row carries in `safety_detail.vexFee`. */
export function rowVexFee(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    v: "vex-fee-v1",
    charged: true,
    bps: 25,
    chargedOn: "currency_in",
    tokenAddress: "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    tokenSymbol: "USDC",
    tokenDecimals: 6,
    feeAmountRaw: "2500",
    feeAmountDecimal: "0.0025",
    receiver: "0xTREASURY",
    totalDebitedRaw: "1000000",
    netAmountRaw: "997500",
    collection: "separate_transfer_after_success",
    ...overrides,
  };
}
