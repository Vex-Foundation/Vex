/**
 * Agent-facing disclosure of the bridge integrator fee.
 *
 * ONE shape for both venues so the model sees identical field names on a
 * Khalani quote, a Relay quote, and either execute. Mirrors the Jupiter swap
 * precedent (`jupiter-swaps/fee-swap.ts`'s `feeAmountRaw`/`feeAmountDecimal`):
 * the raw atomic amount is always present, the human amount and USD degrade to
 * `null` rather than to a fabricated figure, and USD is labelled an ESTIMATE.
 *
 * `feeAmountRaw` is DEFINED as the amount debited from the user's wallet and
 * SENT to the treasury. For an ordinary token that is also the amount credited;
 * for a taxing token it is not, which is why `fee-eligibility.ts` declines the
 * fee on tokens it can prove are fee-on-transfer and why this note states the
 * semantics instead of leaving them implied.
 *
 * The fee is disclosure, NOT an approval gate — that is the owner's decision
 * (docs/whitepaper disclosure). It is exactly computable before any quote
 * exists, so it can be stated truthfully on every surface.
 */

import { formatUnits } from "viem";

import { BRIDGE_FEE_BPS, BRIDGE_FEE_CHARGE_BY } from "./constants.js";

interface BridgeFeeAmounts {
  /** Amount the venue was quoted for and actually bridges (`amount − fee`). */
  readonly bridgedAmountRaw: string;
  /** Amount the user is debited in total (the `amount` they asked for). */
  readonly totalDebitedRaw: string;
  readonly note: string;
}

export type BridgeFeeDisclosure =
  | (BridgeFeeAmounts & {
      readonly charged: true;
      readonly bps: number;
      /** Always `currency_in` — the fee is taken from the token the user sends. */
      readonly chargedOn: typeof BRIDGE_FEE_CHARGE_BY;
      readonly tokenAddress: string;
      readonly tokenSymbol: string | null;
      readonly tokenDecimals: number | null;
      /** Smallest units, exact — debited from the wallet and sent to the treasury. */
      readonly feeAmountRaw: string;
      /** Exact decimal string when decimals are known, else null (never a guess). */
      readonly feeAmountDecimal: string | null;
      /** Nullable ESTIMATE. */
      readonly feeUsdEstimate: string | null;
      /** Treasury address credited (EVM address, or the Solana treasury wallet whose ATA receives). */
      readonly receiver: string;
    })
  | (BridgeFeeAmounts & {
      readonly charged: false;
      readonly bps: 0;
      /** Plain-language reason no fee was taken. */
      readonly reason: string;
    });

const CHARGED_NOTE =
  `Vex charges ${BRIDGE_FEE_BPS} bps (0.25%) on the input token of every bridge, as a separate transfer to `
  + "the Vex treasury that runs AFTER the bridge deposit — a bridge that does not happen is never charged. "
  + "The quoted output is for the post-fee amount, so it is what actually arrives. `feeAmountRaw` is the "
  + "amount debited and sent to the treasury; USD figures are estimates.";

const SKIPPED_NOTE =
  "No Vex bridge fee was taken on this bridge. The full requested amount is quoted and bridged.";

export function buildBridgeFeeDisclosure(input: {
  readonly tokenAddress: string;
  readonly tokenSymbol?: string | undefined;
  readonly tokenDecimals?: number | undefined;
  readonly feeRaw: bigint;
  readonly bridgedRaw: bigint;
  readonly totalRaw: bigint;
  readonly receiver: string;
  readonly feeUsdEstimate?: string | undefined;
}): BridgeFeeDisclosure {
  const decimals = input.tokenDecimals;
  return {
    charged: true,
    bps: BRIDGE_FEE_BPS,
    chargedOn: BRIDGE_FEE_CHARGE_BY,
    tokenAddress: input.tokenAddress,
    tokenSymbol: input.tokenSymbol ?? null,
    tokenDecimals: decimals ?? null,
    feeAmountRaw: input.feeRaw.toString(),
    feeAmountDecimal: decimals === undefined ? null : formatUnits(input.feeRaw, decimals),
    feeUsdEstimate: input.feeUsdEstimate ?? null,
    receiver: input.receiver,
    bridgedAmountRaw: input.bridgedRaw.toString(),
    totalDebitedRaw: input.totalRaw.toString(),
    note: CHARGED_NOTE,
  };
}

/** No fee was taken — a dust amount, or a token Vex declines to skim. */
export function buildBridgeFeeSkippedDisclosure(input: {
  readonly reason: string;
  readonly totalRaw: bigint;
}): BridgeFeeDisclosure {
  return {
    charged: false,
    bps: 0,
    reason: input.reason,
    bridgedAmountRaw: input.totalRaw.toString(),
    totalDebitedRaw: input.totalRaw.toString(),
    note: SKIPPED_NOTE,
  };
}
