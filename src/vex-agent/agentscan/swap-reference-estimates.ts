import { swapPriceReferenceSchema, valueSwapAtReference } from "@tools/evm-chains/swap-price-reference.js";
import { getWrappedNativeContract } from "@tools/evm-chains/wrapped-native.js";

/** Undefined means a legacy row; null amounts mean present but unusable reference evidence. */
export function swapReferenceEstimates(activity: Record<string, unknown>): {
  usdInEst: string | null; usdOutEst: string | null;
} | undefined {
  const provenance = activity.route_provenance;
  if (typeof provenance !== "object" || provenance === null || !("swapPriceReference" in provenance)) return undefined;
  const absent = { usdInEst: null, usdOutEst: null };
  const parsed = swapPriceReferenceSchema.safeParse(provenance.swapPriceReference);
  if (!parsed.success || String(parsed.data.chainId) !== String(activity.chain_id)) return absent;
  const reference = parsed.data;
  const matches = (address: unknown, expected: string): boolean => {
    if (typeof address === "string") return address.toLowerCase() === expected.toLowerCase();
    return address == null && getWrappedNativeContract(reference.chainId)?.address.toLowerCase() === expected.toLowerCase();
  };
  if (!matches(activity.token_in_address, reference.tokenIn) || !matches(activity.token_out_address, reference.tokenOut)
    || typeof activity.amount_in_raw !== "string" || typeof activity.amount_out_raw !== "string"
    || typeof activity.token_in_decimals !== "number" || typeof activity.token_out_decimals !== "number") return absent;
  try {
    const values = valueSwapAtReference(reference, {
      amountInRaw: activity.amount_in_raw, amountOutRaw: activity.amount_out_raw,
      inputDecimals: activity.token_in_decimals, outputDecimals: activity.token_out_decimals,
    });
    return { usdInEst: values.amountInUsd, usdOutEst: values.amountOutUsd };
  } catch { return absent; }
}
