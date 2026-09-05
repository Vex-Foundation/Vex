/**
 * Shared builders for the BOUND Vex fee statement a bridge execute revalidates
 * against, plus the shape `findFreshMatchedPrequote` returns around it.
 *
 * A helper MODULE, not a spec: data builders only, so every suite still writes
 * its own arrangement and its own assertions. It exists because both bridge
 * venues now read the approved statement in the pre-sign window, so five
 * handler suites need the same two shapes, and five hand-copied literals would
 * drift the moment the schema does. Sibling of the prequote lane's
 * `vex-fee-fixtures.ts`, which builds the same block for the recorder and gate
 * suites; this one builds it for the EXECUTORS, where the receiver has to be
 * the real treasury constant or the comparison legitimately refuses.
 */

import { BRIDGE_FEE_BPS, BRIDGE_FEE_RECEIVER_EVM } from "@tools/bridge-fee/index.js";
import type { VexFeePreview } from "@vex-agent/tools/protocols/prequote/fee-disclosure.js";

/** The block a row carries when the quote stated a fee would be taken. */
export function boundChargedVexFee(input: {
  readonly feeAmountRaw: string;
  readonly netAmountRaw: string;
  readonly totalDebitedRaw: string;
  readonly tokenAddress?: string;
  readonly tokenSymbol?: string | null;
  readonly tokenDecimals?: number | null;
  readonly feeAmountDecimal?: string | null;
  readonly receiver?: string;
}): VexFeePreview {
  return {
    v: "vex-fee-v1",
    charged: true,
    bps: BRIDGE_FEE_BPS,
    chargedOn: "currency_in",
    tokenAddress: input.tokenAddress ?? "0x0000000000000000000000000000000000000000",
    tokenSymbol: input.tokenSymbol ?? "ETH",
    tokenDecimals: input.tokenDecimals ?? 18,
    feeAmountRaw: input.feeAmountRaw,
    feeAmountDecimal: input.feeAmountDecimal ?? null,
    receiver: input.receiver ?? BRIDGE_FEE_RECEIVER_EVM,
    totalDebitedRaw: input.totalDebitedRaw,
    netAmountRaw: input.netAmountRaw,
    collection: "separate_transfer_after_success",
  };
}

/** The block a row carries when the quote declined the fee (dust, FoT, honeypot). */
export function boundSkippedVexFee(input: {
  readonly totalDebitedRaw: string;
  readonly reason?: string;
}): VexFeePreview {
  return {
    v: "vex-fee-v1",
    charged: false,
    bps: 0,
    reason: input.reason ?? "25 bps of the requested amount floors to 0 in smallest units",
    totalDebitedRaw: input.totalDebitedRaw,
    netAmountRaw: input.totalDebitedRaw,
    collection: "separate_transfer_after_success",
  };
}

/**
 * What `findFreshMatchedPrequote` returns for an authorized row. Only the three
 * members the executors read are populated; the row itself is a stand-in,
 * because a handler that reached its fee revalidation has already been past
 * every check that reads the rest of it.
 */
export function matchedPrequoteWithVexFee(vexFee: VexFeePreview | undefined): {
  readonly ok: true;
  readonly prequote: { readonly prequoteId: string; readonly safetyDetail: Record<string, unknown> };
  readonly spendability: undefined;
  readonly vexFee: VexFeePreview | undefined;
} {
  return {
    ok: true,
    prequote: { prequoteId: "pq-test", safetyDetail: {} },
    spendability: undefined,
    vexFee,
  };
}
