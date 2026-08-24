/**
 * MANDATORY fee bounds, and the forbidden redirect fields.
 *
 * ## The policy, stated once
 *
 * Every fee cap is a REQUIRED CALLER INPUT. Nothing here derives a cap from a
 * network estimate and calls it authorization: an estimate is a hint about what
 * the network is charging, and turning a hint into a spending limit is Vex
 * inventing money policy on the user's behalf. A prepare called without bounds
 * therefore REFUSES BY NAME, and the refusal carries the current network
 * estimates as clearly LABELLED hints so a coding agent can pick caps and call
 * again. The approved bounds are then echoed in the prepare result, the approval
 * card and the confirm result, and confirm refuses before signing if any actual
 * field exceeds them.
 *
 * ## Forbidden redirect fields
 *
 * A caller-supplied `from`, fee payer, fee receiver or referral address is
 * refused BY NAME, not dropped. Strict unknown-key rejection alone does not
 * satisfy rule 90: a caller who passed `from` and got a silent success would
 * reasonably believe Vex honoured it, and the field it names is precisely the
 * one that redirects funds. The sender is the session's selected wallet, full
 * stop, and saying so is part of the refusal.
 *
 * ## No floating point
 *
 * Every value is a decimal integer string parsed to `bigint`. A gas price that
 * went through a JavaScript number would be wrong above 2^53 wei-per-gas-times-
 * gas-limit, which is an ordinary total on a busy chain.
 */

import type {
  Eip1559FeeBounds,
  LegacyEvmFeeBounds,
  SolanaFeeBounds,
} from "@vex-agent/db/contracts/wallet-transaction-intent.js";

import {
  accept,
  refuse,
  type TransactionOutcome,
  type TransactionRefusal,
} from "./refusal.js";

/**
 * Fields that can redirect who pays or who receives. Each maps to the sentence
 * the refusal uses, so the caller learns WHY the key is refused rather than
 * only that it is.
 */
export const FORBIDDEN_REDIRECT_FIELDS: ReadonlyMap<string, string> = new Map([
  ["from", "the sender is the wallet selected for this session, and a proposal does not get to choose it"],
  ["sender", "the sender is the wallet selected for this session, and a proposal does not get to choose it"],
  ["account", "the signing account is the wallet selected for this session"],
  ["signer", "the signing account is the wallet selected for this session"],
  ["feePayer", "the fee payer is the selected wallet; a proposal naming a different payer is a redirect"],
  ["payer", "the fee payer is the selected wallet; a proposal naming a different payer is a redirect"],
  ["feeReceiver", "Vex does not take a fee on this path, and no caller may name a fee recipient"],
  ["feeRecipient", "Vex does not take a fee on this path, and no caller may name a fee recipient"],
  ["referrer", "no referral or fee-sharing address is accepted on the generic signing path"],
  ["referralAddress", "no referral or fee-sharing address is accepted on the generic signing path"],
  ["refundAddress", "a refund destination is a fund destination, and it is not caller-supplied here"],
  ["walletAddress", "the wallet is the session's selection; use the wallet settings to change it"],
]);

/**
 * Refuse a caller-supplied redirect field BY NAME. Returns `null` when the
 * params carry none.
 */
export function forbiddenRedirectFieldRefusal(
  params: Record<string, unknown>,
): TransactionRefusal | null {
  for (const [key, why] of FORBIDDEN_REDIRECT_FIELDS) {
    if (!(key in params)) continue;
    return {
      code: "forbidden_field",
      message:
        `Refusing to prepare: \`${key}\` is not accepted by this tool - ${why}. It is named here `
        + "rather than ignored, because a caller who passed it and saw a success would reasonably "
        + "believe it was honoured. Remove the field and call again.",
      details: { field: key },
    };
  }
  return null;
}

// ── Integer parsing ───────────────────────────────────────────────────

const DECIMAL_INTEGER = /^(0|[1-9][0-9]{0,77})$/;

function requireIntegerString(
  params: Record<string, unknown>,
  key: string,
): TransactionOutcome<bigint> {
  const raw = params[key];
  if (raw === undefined || raw === null || raw === "") {
    return refuse("missing_fee_bounds", `Missing required fee bound \`${key}\`.`, { field: key });
  }
  if (typeof raw !== "string") {
    return refuse(
      "invalid_input",
      `\`${key}\` must be a decimal integer STRING in base units, never a JSON number: a number loses `
      + "precision above 2^53, and fee arithmetic crosses that routinely.",
      { field: key },
    );
  }
  if (!DECIMAL_INTEGER.test(raw)) {
    return refuse(
      "invalid_input",
      `\`${key}\` must be a non-negative decimal integer string in base units.`,
      { field: key },
    );
  }
  return accept(BigInt(raw));
}

// ── EVM ───────────────────────────────────────────────────────────────

/** Labelled current-network hints carried in a missing-bounds refusal. */
export interface EvmFeeEstimates {
  readonly suggestedGasLimit: string;
  readonly suggestedMaxFeePerGasWei: string;
  readonly suggestedMaxPriorityFeePerGasWei: string;
  readonly suggestedGasPriceWei: string;
  readonly supportsEip1559: boolean;
}

export type EvmFeeBounds = Eip1559FeeBounds | LegacyEvmFeeBounds;

/**
 * Parse the REQUIRED EVM caps. The pricing mode is chosen by which caps the
 * caller supplied, never guessed: an EIP-1559 pair, or a legacy `gasPriceWei`.
 * Supplying both is refused rather than silently preferring one, because the two
 * authorize different maximum totals.
 */
export function parseEvmFeeBounds(
  params: Record<string, unknown>,
  estimates: EvmFeeEstimates,
): TransactionOutcome<EvmFeeBounds> {
  const has = (key: string): boolean =>
    params[key] !== undefined && params[key] !== null && params[key] !== "";

  const wants1559 = has("maxFeePerGasWei") || has("maxPriorityFeePerGasWei");
  const wantsLegacy = has("gasPriceWei");

  if (wants1559 && wantsLegacy) {
    return refuse(
      "invalid_input",
      "Refusing to prepare: `gasPriceWei` and the EIP-1559 caps (`maxFeePerGasWei`, "
      + "`maxPriorityFeePerGasWei`) authorize different maximum totals, so exactly one pricing mode "
      + "must be supplied. Pass the 1559 pair on a chain that supports it, or `gasPriceWei` on one "
      + "that does not.",
    );
  }
  if (!wants1559 && !wantsLegacy) {
    return refuseMissingEvmBounds(estimates);
  }

  const gasLimit = requireIntegerString(params, "gasLimit");
  if (!gasLimit.ok) {
    return gasLimit.refusal.code === "missing_fee_bounds"
      ? refuseMissingEvmBounds(estimates)
      : gasLimit;
  }
  if (gasLimit.value === 0n) {
    return refuse("invalid_input", "`gasLimit` must be greater than zero.", { field: "gasLimit" });
  }

  if (wantsLegacy) {
    const gasPrice = requireIntegerString(params, "gasPriceWei");
    if (!gasPrice.ok) {
      return gasPrice.refusal.code === "missing_fee_bounds"
        ? refuseMissingEvmBounds(estimates)
        : gasPrice;
    }
    return accept<EvmFeeBounds>({
      mode: "legacy",
      gasLimit: gasLimit.value.toString(),
      gasPriceWei: gasPrice.value.toString(),
      maxTotalFeeWei: (gasLimit.value * gasPrice.value).toString(),
    });
  }

  const maxFee = requireIntegerString(params, "maxFeePerGasWei");
  if (!maxFee.ok) {
    return maxFee.refusal.code === "missing_fee_bounds" ? refuseMissingEvmBounds(estimates) : maxFee;
  }
  const maxPriority = requireIntegerString(params, "maxPriorityFeePerGasWei");
  if (!maxPriority.ok) {
    return maxPriority.refusal.code === "missing_fee_bounds"
      ? refuseMissingEvmBounds(estimates)
      : maxPriority;
  }
  if (maxPriority.value > maxFee.value) {
    return refuse(
      "invalid_input",
      "`maxPriorityFeePerGasWei` cannot exceed `maxFeePerGasWei`: the priority tip is paid out of the "
      + "total the max fee caps, so the chain would reject the transaction.",
    );
  }
  return accept<EvmFeeBounds>({
    mode: "eip1559",
    gasLimit: gasLimit.value.toString(),
    maxFeePerGasWei: maxFee.value.toString(),
    maxPriorityFeePerGasWei: maxPriority.value.toString(),
    // The number the user authorizes: the chain can charge at most
    // gasLimit * maxFeePerGas, whatever it actually consumes.
    maxTotalFeeWei: (gasLimit.value * maxFee.value).toString(),
  });
}

function refuseMissingEvmBounds(estimates: EvmFeeEstimates): TransactionOutcome<EvmFeeBounds> {
  return refuse(
    "missing_fee_bounds",
    "Refusing to prepare: this tool requires explicit fee caps, and none were supplied. Vex does not "
    + "turn a network estimate into a spending limit on your behalf. Pass `gasLimit` plus either the "
    + "EIP-1559 pair (`maxFeePerGasWei`, `maxPriorityFeePerGasWei`) or the legacy `gasPriceWei`, all "
    + "as RAW decimal integer strings. The values below are the CURRENT NETWORK ESTIMATE and are "
    + "HINTS ONLY - they are not a recommendation and nothing was prepared from them.",
    {
      hintSuggestedGasLimit: estimates.suggestedGasLimit,
      hintSuggestedMaxFeePerGasWei: estimates.suggestedMaxFeePerGasWei,
      hintSuggestedMaxPriorityFeePerGasWei: estimates.suggestedMaxPriorityFeePerGasWei,
      hintSuggestedGasPriceWei: estimates.suggestedGasPriceWei,
      hintChainSupportsEip1559: String(estimates.supportsEip1559),
    },
  );
}

// ── Solana ────────────────────────────────────────────────────────────

/**
 * Lamports per signature - the CURRENT protocol default for the base fee.
 *
 * This is a HINT FLOOR only: it labels the missing-bounds refusal and seeds the
 * prepare-time base-fee estimate. It is NOT the authorization basis for the fee.
 * The exact charge is queried from the node via `getFeeForMessage` at prepare
 * and again immediately before signing (see {@link assertQueriedSolanaMessageFee}),
 * so a future protocol change to the per-signature charge, or a multi-signature
 * message, is caught by the queried fee rather than assumed away by this constant.
 */
export const SOLANA_LAMPORTS_PER_SIGNATURE = 5000n;
const MICRO_LAMPORTS_PER_LAMPORT = 1_000_000n;

/**
 * The EXACT network fee for a message, queried via `getFeeForMessage`, against
 * the approved total fee cap. Called at PREPARE (so nothing is prepared whose
 * real fee already exceeds the caps the caller set) and again immediately before
 * SIGNING (so the authorization is proven against the fee schedule in force at
 * the signing moment, not the one assumed when the intent was created).
 *
 * An unqueryable fee (`null`) is refused, not defaulted: authorizing a signature
 * against a fee nobody could read is exactly the guess this check removes.
 */
export function assertQueriedSolanaMessageFee(
  queriedLamports: number | null,
  bounds: SolanaFeeBounds,
  phase: "prepare" | "confirm",
): TransactionOutcome<void> {
  const nothing =
    phase === "prepare"
      ? "Nothing was prepared and nothing was signed."
      : "Nothing was signed and no fee was paid.";
  if (queriedLamports === null) {
    return refuse(
      "invalid_input",
      "Refusing to "
      + (phase === "prepare" ? "prepare" : "sign")
      + ": the network fee for this exact message could not be queried, so it cannot be shown to be "
      + `within the authorized total fee cap. ${nothing} Try again once the node is reachable.`,
    );
  }
  if (!Number.isSafeInteger(queriedLamports) || queriedLamports < 0) {
    return refuse(
      "invalid_input",
      "Refusing to "
      + (phase === "prepare" ? "prepare" : "sign")
      + `: the network returned a fee value that is not a valid lamport count. ${nothing}`,
    );
  }
  const queried = BigInt(queriedLamports);
  const boundTotal = BigInt(bounds.maxTotalFeeLamports);
  if (queried > boundTotal) {
    return refuse(
      "invalid_input",
      "Refusing to "
      + (phase === "prepare" ? "prepare" : "sign")
      + `: the network quotes ${queried.toString()} lamports for this message, above the `
      + `${boundTotal.toString()} lamport total that was authorized. ${nothing}`,
      {
        queriedMessageFeeLamports: queried.toString(),
        approvedMaxTotalFeeLamports: boundTotal.toString(),
      },
    );
  }
  return accept(undefined);
}

export interface SolanaFeeEstimates {
  readonly suggestedComputeUnitLimit: string;
  readonly suggestedComputeUnitPriceMicroLamports: string;
}

/**
 * Parse the REQUIRED Solana caps.
 *
 * The priority fee is charged on the REQUESTED compute-unit limit, not on the
 * units actually consumed, so the limit is a spending input and not a
 * performance knob. Both it and the price are caller-supplied; the base fee is
 * the protocol's own per-signature charge and is computed, not authorized.
 */
export function parseSolanaFeeBounds(
  params: Record<string, unknown>,
  signatureCount: number,
  estimates: SolanaFeeEstimates,
): TransactionOutcome<SolanaFeeBounds> {
  const limit = requireIntegerString(params, "computeUnitLimit");
  if (!limit.ok) {
    return limit.refusal.code === "missing_fee_bounds" ? refuseMissingSolanaBounds(estimates) : limit;
  }
  if (limit.value === 0n) {
    return refuse("invalid_input", "`computeUnitLimit` must be greater than zero.", {
      field: "computeUnitLimit",
    });
  }
  const price = requireIntegerString(params, "computeUnitPriceMicroLamports");
  if (!price.ok) {
    return price.refusal.code === "missing_fee_bounds" ? refuseMissingSolanaBounds(estimates) : price;
  }

  const baseFee = SOLANA_LAMPORTS_PER_SIGNATURE * BigInt(Math.max(signatureCount, 1));
  // Ceiling division in integers: the runtime rounds the micro-lamport product
  // UP to whole lamports, and a bound that rounded down would be a bound the
  // actual charge exceeds by one lamport on most transactions.
  const priorityFee =
    (limit.value * price.value + MICRO_LAMPORTS_PER_LAMPORT - 1n) / MICRO_LAMPORTS_PER_LAMPORT;

  return accept<SolanaFeeBounds>({
    mode: "solana",
    computeUnitLimit: limit.value.toString(),
    computeUnitPriceMicroLamports: price.value.toString(),
    baseFeeLamports: baseFee.toString(),
    maxPriorityFeeLamports: priorityFee.toString(),
    maxTotalFeeLamports: (baseFee + priorityFee).toString(),
  });
}

function refuseMissingSolanaBounds(
  estimates: SolanaFeeEstimates,
): TransactionOutcome<SolanaFeeBounds> {
  return refuse(
    "missing_fee_bounds",
    "Refusing to prepare: this tool requires explicit fee caps, and none were supplied. Pass "
    + "`computeUnitLimit` and `computeUnitPriceMicroLamports` as decimal integer strings. The "
    + "priority fee is charged on the REQUESTED compute-unit limit rather than on the units actually "
    + "used, so the limit is part of what you are authorizing. The values below are the CURRENT "
    + "NETWORK ESTIMATE and are HINTS ONLY - nothing was prepared from them.",
    {
      hintSuggestedComputeUnitLimit: estimates.suggestedComputeUnitLimit,
      hintSuggestedComputeUnitPriceMicroLamports: estimates.suggestedComputeUnitPriceMicroLamports,
      hintBaseFeeLamportsPerSignature: SOLANA_LAMPORTS_PER_SIGNATURE.toString(),
    },
  );
}
