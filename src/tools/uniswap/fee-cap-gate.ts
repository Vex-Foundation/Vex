/** Approved per-gas ceilings and their live check. Gas units remain measured per transaction.
* The execute facade re-exports the existing refusal classes. No RPC follows its final signing fence.
*/
import type { PublicClient, Transport, Chain } from "viem";
import { boundGasPriceWei, checkFeeCap, type LegFeeCap } from "@tools/evm-chains/swap-native-debit.js";

export interface UniswapLegFeeBounds {
  readonly cap: LegFeeCap;
}

export type UniswapLiveFeeMarketRefusalKind = "approved_gas_price_exceeded" | "live_fee_market_unreadable" | "pricing_mode_changed";

export class UniswapLiveFeeMarketRefusal extends Error {
  constructor(readonly kind: UniswapLiveFeeMarketRefusalKind, readonly retryable: boolean, message: string, options?: {
    readonly cause?: unknown;
  }) {
    super(message, options);
    this.name = "UniswapLiveFeeMarketRefusal";
  }
}

export class UniswapApprovedGasPriceExceededError extends UniswapLiveFeeMarketRefusal {
  constructor(field: string, liveRaw: string, approvedRaw: string) {
    super("approved_gas_price_exceeded", false, `Refused before signing: the gas price moved past what you approved - the chain now asks `
      + `${liveRaw} for ${field} and this quote was approved at ${approvedRaw}. Signing at the `
      + "approved ceiling would broadcast an underpriced transaction that sits pending instead of "
      + "settling. Nothing was signed and nothing was broadcast. Request a fresh "
      + "uniswap__swap_quote and execute against that.");
    this.name = "UniswapApprovedGasPriceExceededError";
  }
}

export class UniswapLiveFeeRequirementUnreadableError extends UniswapLiveFeeMarketRefusal {
  constructor(cause: unknown) {
    super("live_fee_market_unreadable", true, "Refused before signing: the current gas market could not be read, so this quote's approved "
      + "gas ceiling could not be shown to still cover what the chain requires. Signing on an "
      + "unknown requirement risks broadcasting an underpriced transaction that sits pending "
      + "instead of settling. Nothing was signed and nothing was broadcast. Retry this execute in "
      + "a moment; if the node stays unreachable, request a fresh uniswap__swap_quote.", { cause });
    this.name = "UniswapLiveFeeRequirementUnreadableError";
  }
}

export class UniswapApprovedGasPricingModeChangedError extends UniswapLiveFeeMarketRefusal {
  constructor(liveMode: LegFeeCap["mode"], approvedMode: LegFeeCap["mode"]) {
    super("pricing_mode_changed", false, `Refused before signing: the chain changed pricing mode under your approval - it now prices `
      + `gas as ${liveMode} and this quote was approved under ${approvedMode}. Those are different `
      + "quantities, so the approved ceiling cannot be shown to still cover what the chain "
      + "requires. Nothing was signed and nothing was broadcast. Request a fresh "
      + "uniswap__swap_quote and execute against that.");
    this.name = "UniswapApprovedGasPricingModeChangedError";
  }
}

export class UniswapFeeCapExceededError extends Error {
  constructor(field: string, requiredRaw: string, approvedRaw: string) {
    super(`Refused before signing: this leg's ${field} is now ${requiredRaw}, above the ${approvedRaw} `
      + "this execute's native-debit total was computed under. Nothing was signed and nothing was "
      + "broadcast. Request a fresh uniswap__swap_quote and execute against that.");
    this.name = "UniswapFeeCapExceededError";
  }
}

export function assertWithinLegFeeBounds(request: {
  readonly gasPrice?: bigint | undefined;
  readonly maxFeePerGas?: bigint | undefined;
  readonly maxPriorityFeePerGas?: bigint | undefined;
}, bounds: UniswapLegFeeBounds): void {
  if (request.maxFeePerGas === undefined && request.gasPrice === undefined) {
    throw new UniswapFeeCapExceededError("fee price", "unstated", boundGasPriceWei(bounds.cap).toString(10));
  }
  const current: LegFeeCap = request.maxFeePerGas !== undefined
    ? {
      mode: "eip1559",
      maxFeePerGasWei: request.maxFeePerGas,
      maxPriorityFeePerGasWei: request.maxPriorityFeePerGas ?? 0n,
    }
    : { mode: "legacy", gasPriceWei: request.gasPrice ?? 0n };
  const verdict = checkFeeCap({ gasLimit: 0n, cap: current }, { gasLimit: 0n, cap: bounds.cap });
  if (!verdict.withinCap) {
    throw new UniswapFeeCapExceededError(verdict.field, verdict.requiredRaw, verdict.approvedRaw);
  }
}

export async function assertApprovedCapStillSuffices(publicClient: PublicClient<Transport, Chain>, bounds: UniswapLegFeeBounds): Promise<void> {
  let reading: LiveFeeRequirement;
  try {
    reading = await readLiveFeeRequirement(publicClient);
  }
  catch (cause) {
    throw new UniswapLiveFeeRequirementUnreadableError(cause);
  }
  const live = reading.cap;
  if (live.mode !== bounds.cap.mode) {
    if (!reading.modeIsAuthoritative) {
      throw new UniswapLiveFeeRequirementUnreadableError(reading.suggestionFailure);
    }
    throw new UniswapApprovedGasPricingModeChangedError(live.mode, bounds.cap.mode);
  }
  if (live.mode === "eip1559" && bounds.cap.mode === "eip1559") {
    if (live.maxFeePerGasWei > bounds.cap.maxFeePerGasWei) {
      throw new UniswapApprovedGasPriceExceededError("maxFeePerGas", live.maxFeePerGasWei.toString(10), bounds.cap.maxFeePerGasWei.toString(10));
    }
    if (live.maxPriorityFeePerGasWei > bounds.cap.maxPriorityFeePerGasWei) {
      throw new UniswapApprovedGasPriceExceededError("maxPriorityFeePerGas", live.maxPriorityFeePerGasWei.toString(10), bounds.cap.maxPriorityFeePerGasWei.toString(10));
    }
    return;
  }
  if (live.mode === "legacy" && bounds.cap.mode === "legacy"
    && live.gasPriceWei > bounds.cap.gasPriceWei) {
    throw new UniswapApprovedGasPriceExceededError("gasPrice", live.gasPriceWei.toString(10), bounds.cap.gasPriceWei.toString(10));
  }
}

interface LiveFeeRequirement {
  readonly cap: LegFeeCap;
  readonly modeIsAuthoritative: boolean;
  readonly suggestionFailure?: unknown;
}

async function readLiveFeeRequirement(publicClient: PublicClient<Transport, Chain>): Promise<LiveFeeRequirement> {
  let suggestionFailure: unknown;
  try {
    const fees = await publicClient.estimateFeesPerGas();
    if (fees.maxFeePerGas !== undefined) {
      return {
        cap: {
          mode: "eip1559",
          maxFeePerGasWei: fees.maxFeePerGas,
          maxPriorityFeePerGasWei: fees.maxPriorityFeePerGas ?? 0n,
        },
        modeIsAuthoritative: true,
      };
    }
    if (fees.gasPrice !== undefined) {
      return { cap: { mode: "legacy", gasPriceWei: fees.gasPrice }, modeIsAuthoritative: true };
    }
    suggestionFailure = new Error("estimateFeesPerGas returned no price");
  }
  catch (err) {
    suggestionFailure = err;
  }
  return {
    cap: { mode: "legacy", gasPriceWei: await publicClient.getGasPrice() },
    modeIsAuthoritative: false,
    suggestionFailure,
  };
}
