/** Fee policies enforced on the exact request the staged broadcaster signs. */
/** Approval-visible hard ceilings enforced on the transaction being signed. */
export interface StagedFeeExposureLimit {
  readonly gasLimit: bigint;
  readonly maxFeePerGas: bigint;
  readonly maxPriorityFeePerGas: bigint;
  readonly maxNetworkFeeWei: bigint;
}

/**
 * The APPROVED fee ceiling for this transaction, enforced on the request that is
 * actually serialized.
 *
 * WHY IT IS A PARAMETER AND NOT AN ASSUMPTION. Without it,
 * `prepareTransactionRequest` fills whatever fees the node suggests, and the
 * signed bytes commit the user to them. On a venue path that is tolerable
 * because the user authorized a trade, not a gas price; on the generic signing
 * path the fee caps ARE part of what the user approved, so a request whose
 * fields exceed them must never be signed. Omitting it keeps every existing
 * caller's behaviour byte for byte.
 *
 * Every value is a `bigint` in base units: gas UNITS for `gasLimit`, wei for
 * the prices. No floating point reaches this type.
 */
export type StagedFeeBounds =
  | {
      readonly mode: "eip1559";
      readonly gasLimit: bigint;
      readonly maxFeePerGasWei: bigint;
      readonly maxPriorityFeePerGasWei: bigint;
    }
  | {
      readonly mode: "legacy";
      readonly gasLimit: bigint;
      readonly gasPriceWei: bigint;
    };

/** Per-gas approval for a dependent fee leg whose gas is measured after settlement. */
export type StagedGasPriceBounds =
  | (Omit<Extract<StagedFeeBounds, { mode: "eip1559" }>, "gasLimit"> & { readonly gasLimit?: never })
  | (Omit<Extract<StagedFeeBounds, { mode: "legacy" }>, "gasLimit"> & { readonly gasLimit?: never });
export type StagedFeePolicy = StagedFeeBounds | StagedGasPriceBounds | StagedFeeExposureLimit;

export function isFeeExposureLimit(policy: StagedFeePolicy): policy is StagedFeeExposureLimit {
  return !("mode" in policy);
}

/**
 * A prepared request exceeded the approved ceiling, so NOTHING was signed.
 *
 * Its own error type because the caller's answer is specific: this is not an
 * RPC failure and not a revert, it is a refusal, and the transaction may be
 * prepared again under caps the user chooses. `field` names which cap was
 * exceeded, and both values travel as decimal strings.
 */
export class StagedFeeBoundsExceededError extends Error {
  readonly field: string;
  readonly actual: string;
  readonly approved: string;

  constructor(field: string, actual: bigint, approved: bigint) {
    super(
      `Refusing to sign: the prepared transaction's ${field} is ${actual.toString()}, above the `
      + `approved ceiling of ${approved.toString()}. Nothing was signed and nothing was broadcast.`,
    );
    this.name = "StagedFeeBoundsExceededError";
    this.field = field;
    this.actual = actual.toString();
    this.approved = approved.toString();
  }
}

/**
 * Refuse any prepared field above its ceiling. Called on the request that is
 * about to be serialized, so what is checked is what would be signed.
 *
 * A field the request does not carry is not a hole: viem fills exactly one
 * pricing mode, and the mode the caller authorized is the mode it asked for. An
 * absent field means the node priced the transaction the other way, which is a
 * mismatch the caps cannot cover, so it refuses too.
 */
export function assertWithinFeeBounds(
  request: { gas?: bigint; maxFeePerGas?: bigint; maxPriorityFeePerGas?: bigint; gasPrice?: bigint },
  bounds: StagedFeeBounds | StagedGasPriceBounds,
): void {
  const gas = request.gas;
  if (bounds.gasLimit !== undefined && (gas === undefined || gas > bounds.gasLimit)) {
    throw new StagedFeeBoundsExceededError("gas limit", gas ?? 0n, bounds.gasLimit);
  }
  if (bounds.mode === "eip1559") {
    const maxFee = request.maxFeePerGas;
    const priority = request.maxPriorityFeePerGas;
    if (maxFee === undefined || maxFee > bounds.maxFeePerGasWei) {
      throw new StagedFeeBoundsExceededError("maxFeePerGas", maxFee ?? 0n, bounds.maxFeePerGasWei);
    }
    if (priority === undefined || priority > bounds.maxPriorityFeePerGasWei) {
      throw new StagedFeeBoundsExceededError(
        "maxPriorityFeePerGas",
        priority ?? 0n,
        bounds.maxPriorityFeePerGasWei,
      );
    }
    return;
  }
  const gasPrice = request.gasPrice;
  if (gasPrice === undefined || gasPrice > bounds.gasPriceWei) {
    throw new StagedFeeBoundsExceededError("gasPrice", gasPrice ?? 0n, bounds.gasPriceWei);
  }
}

