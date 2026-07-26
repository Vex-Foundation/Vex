/**
 * Validation and auth helpers for Jupiter Swap API V2.
 */

import { VexError, ErrorCodes } from "../../../../errors.js";
import {
  requireJupiterApiKey as requireSharedJupiterApiKey,
  resolveJupiterApiKey as resolveSharedJupiterApiKey,
} from "../../shared/jupiter-auth.js";
import { isBase64 } from "../../shared/schemas.js";
import { validateSolanaAddress } from "../../shared/solana-validation.js";
import type {
  JupiterSwapBuildParams,
  JupiterSwapComputeUnitPricePercentile,
  JupiterSwapExecuteRequest,
  JupiterSwapOrderParams,
  JupiterSwapSubmitRequest,
} from "./types.js";

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}

/**
 * Every numeric knob Jupiter's Swap API V2 accepts here is an INTEGER by
 * contract (basis points, account counts, slot counts). This helper used to
 * range-check WITHOUT an integrality test, which was a total-loss hole:
 * Jupiter ACCEPTS a fractional `slippageBps` and answers with
 * `otherAmountThreshold = 0` — a swap that will take ANY output, including
 * near-zero. Reproduced live at `50.5`, `50.9`, and most dangerously `0.5`
 * (a caller meaning "0.5%" got total-loss tolerance), with no error and a
 * normal-looking quote.
 *
 * REJECT, NEVER COERCE: `0.5` could mean 0.5 bps or 0.5%, so rounding or
 * flooring would be guessing on a price-protection parameter.
 *
 * Mirrors `../jupiter-prediction/prediction-api/validation/helpers.ts`'s
 * `assertIntegerInRange`, which already had this right — the swap module was
 * the one that drifted. Kept as a SEPARATE implementation rather than a shared
 * import: this is the defense-in-depth layer under the protocol-manifest gate
 * (`@vex-agent/tools/protocols/runtime/bps-param.ts`), and `src/tools` must not
 * import from `src/vex-agent` (one-way dependency direction).
 */
function assertIntegerInRange(
  name: string,
  value: number,
  min: number,
  max: number,
): void {
  if (!Number.isInteger(value)) {
    throw new VexError(
      ErrorCodes.INVALID_AMOUNT,
      `Invalid ${name}: ${value}`,
      `${name} must be a whole number between ${min} and ${max}.${bpsPercentReadingHint(name, value)}`,
    );
  }
  if (value < min || value > max) {
    throw new VexError(
      ErrorCodes.INVALID_AMOUNT,
      `Invalid ${name}: ${value}`,
      `${name} must be between ${min} and ${max}.`,
    );
  }
}

/**
 * For a basis-point param, name the correct form for the value the caller most
 * plausibly meant (the common mistake is passing a percentage: `0.5` for
 * "0.5%"). Suggestion only — nothing is coerced. Silent when the param is not
 * a bps field or the percent reading is not itself a whole number of bps.
 */
function bpsPercentReadingHint(name: string, value: number): string {
  if (!name.endsWith("Bps")) return "";
  const asBps = Math.round(value * 100);
  if (asBps / 100 !== value) return "";
  return ` If you meant ${value}%, pass ${asBps}.`;
}

function assertNonNegativeInteger(name: string, value: number): void {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    throw new VexError(
      ErrorCodes.INVALID_AMOUNT,
      `Invalid ${name}: ${value}`,
      `${name} must be a non-negative integer (lamports).`,
    );
  }
}

function assertPositiveIntegerString(name: string, value: string): void {
  if (!/^\d+$/.test(value)) {
    throw new VexError(
      ErrorCodes.INVALID_AMOUNT,
      `Invalid ${name}: ${value}`,
      `${name} must be a base-10 integer string in smallest units.`,
    );
  }

  if (BigInt(value) <= 0n) {
    throw new VexError(
      ErrorCodes.INVALID_AMOUNT,
      `Invalid ${name}: ${value}`,
      `${name} must be greater than 0.`,
    );
  }
}

function assertRequiredTogether(
  leftName: string,
  leftValue: unknown,
  rightName: string,
  rightValue: unknown,
): void {
  if (Boolean(leftValue) !== Boolean(rightValue)) {
    throw new VexError(
      ErrorCodes.SOLANA_SWAP_FAILED,
      `${leftName} and ${rightName} must be provided together.`,
    );
  }
}

function assertMutuallyExclusive(
  leftName: string,
  leftValue: unknown,
  rightName: string,
  rightValue: unknown,
): void {
  if (leftValue && rightValue) {
    throw new VexError(
      ErrorCodes.SOLANA_SWAP_FAILED,
      `${leftName} and ${rightName} are mutually exclusive.`,
    );
  }
}

function assertComputeUnitPricePercentile(value: JupiterSwapComputeUnitPricePercentile): void {
  if (typeof value === "string") {
    if (value !== "medium" && value !== "high" && value !== "veryHigh") {
      throw new VexError(
        ErrorCodes.SOLANA_SWAP_FAILED,
        `Unsupported computeUnitPricePercentile: ${value}`,
        "Supported values: medium, high, veryHigh, or an integer 0-10000 bps.",
      );
    }
    return;
  }
  // Official contract: an INTEGER 0-10000 bps — a fractional percentile is a
  // caller bug, not a roundable value.
  if (!Number.isInteger(value)) {
    throw new VexError(
      ErrorCodes.SOLANA_SWAP_FAILED,
      `computeUnitPricePercentile must be an integer (got ${value}).`,
      "Supported values: medium, high, veryHigh, or an integer 0-10000 bps.",
    );
  }
  assertIntegerInRange("computeUnitPricePercentile", value, 0, 10_000);
}

function normalizeCsvValue(value?: string | string[]): string | undefined {
  if (!isDefined(value)) return undefined;
  if (Array.isArray(value)) {
    const normalized = value.map((item) => item.trim()).filter(Boolean);
    return normalized.length > 0 ? normalized.join(",") : undefined;
  }
  const normalized = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return normalized.length > 0 ? normalized.join(",") : undefined;
}

export function resolveJupiterApiKey(): string {
  return resolveSharedJupiterApiKey();
}

export function requireJupiterApiKey(): string {
  return requireSharedJupiterApiKey({
    feature: "Jupiter Swap API V2",
    errorCode: ErrorCodes.SOLANA_SWAP_FAILED,
  });
}

export function getJupiterSwapHeaders(extraHeaders: Record<string, string> = {}): Record<string, string> {
  return {
    "x-api-key": requireJupiterApiKey(),
    ...extraHeaders,
  };
}

export function validateJupiterSwapOrderParams(params: JupiterSwapOrderParams): void {
  validateSolanaAddress(params.inputMint);
  validateSolanaAddress(params.outputMint);
  assertPositiveIntegerString("amount", params.amount);

  if (params.taker) validateSolanaAddress(params.taker);
  if (params.receiver) validateSolanaAddress(params.receiver);
  if (params.payer) validateSolanaAddress(params.payer);

  if (params.swapMode && params.swapMode !== "ExactIn") {
    throw new VexError(
      ErrorCodes.SOLANA_SWAP_FAILED,
      `Unsupported swapMode: ${params.swapMode}`,
      "Jupiter Swap API V2 currently supports only ExactIn.",
    );
  }

  if (isDefined(params.slippageBps)) assertIntegerInRange("slippageBps", params.slippageBps, 0, 10_000);
  if (isDefined(params.referralFee)) assertIntegerInRange("referralFee", params.referralFee, 50, 255);
  // Lamports are integral by definition; the old `< 0`-only checks let a
  // fractional value through to the query string. Same class as the
  // `slippageBps` hole above.
  if (isDefined(params.priorityFeeLamports)) assertNonNegativeInteger("priorityFeeLamports", params.priorityFeeLamports);
  if (isDefined(params.jitoTipLamports)) assertNonNegativeInteger("jitoTipLamports", params.jitoTipLamports);

  assertRequiredTogether("referralAccount", params.referralAccount, "referralFee", params.referralFee);
}

export function validateJupiterSwapBuildParams(params: JupiterSwapBuildParams): void {
  validateSolanaAddress(params.inputMint);
  validateSolanaAddress(params.outputMint);
  validateSolanaAddress(params.taker);
  assertPositiveIntegerString("amount", params.amount);

  if (params.mode && params.mode !== "fast") {
    throw new VexError(
      ErrorCodes.SOLANA_SWAP_FAILED,
      `Unsupported build mode: ${params.mode}`,
      "Supported build mode: fast.",
    );
  }

  if (isDefined(params.slippageBps)) assertIntegerInRange("slippageBps", params.slippageBps, 0, 10_000);
  if (isDefined(params.platformFeeBps)) assertIntegerInRange("platformFeeBps", params.platformFeeBps, 0, 10_000);
  if (isDefined(params.maxAccounts)) assertIntegerInRange("maxAccounts", params.maxAccounts, 1, 64);
  if (isDefined(params.blockhashSlotsToExpiry)) {
    assertIntegerInRange("blockhashSlotsToExpiry", params.blockhashSlotsToExpiry, 1, 300);
  }
  if (isDefined(params.tipAmount)) assertNonNegativeInteger("tipAmount", params.tipAmount);
  if (isDefined(params.computeUnitPricePercentile)) {
    assertComputeUnitPricePercentile(params.computeUnitPricePercentile);
  }

  if (params.payer) validateSolanaAddress(params.payer);
  if (params.feeAccount) validateSolanaAddress(params.feeAccount);
  if (params.destinationTokenAccount) validateSolanaAddress(params.destinationTokenAccount);
  if (params.nativeDestinationAccount) validateSolanaAddress(params.nativeDestinationAccount);

  assertMutuallyExclusive("dexes", params.dexes, "excludeDexes", params.excludeDexes);
  assertMutuallyExclusive(
    "destinationTokenAccount",
    params.destinationTokenAccount,
    "nativeDestinationAccount",
    params.nativeDestinationAccount,
  );
  if ((params.platformFeeBps ?? 0) > 0 && !params.feeAccount) {
    throw new VexError(
      ErrorCodes.SOLANA_SWAP_FAILED,
      "feeAccount is required when platformFeeBps is positive.",
    );
  }
}

export function validateJupiterSwapExecuteRequest(request: JupiterSwapExecuteRequest): void {
  if (!request.signedTransaction.trim()) {
    throw new VexError(
      ErrorCodes.SOLANA_SWAP_FAILED,
      "signedTransaction is required for /execute.",
    );
  }
  if (!request.requestId.trim()) {
    throw new VexError(
      ErrorCodes.SOLANA_SWAP_FAILED,
      "requestId is required for /execute.",
    );
  }
}

export function normalizeOrderQueryParams(params: JupiterSwapOrderParams): Record<string, string> {
  validateJupiterSwapOrderParams(params);

  const query: Record<string, string | undefined> = {
    inputMint: validateSolanaAddress(params.inputMint),
    outputMint: validateSolanaAddress(params.outputMint),
    amount: params.amount,
    taker: params.taker ? validateSolanaAddress(params.taker) : undefined,
    receiver: params.receiver ? validateSolanaAddress(params.receiver) : undefined,
    swapMode: params.swapMode,
    slippageBps: isDefined(params.slippageBps) ? String(params.slippageBps) : undefined,
    referralAccount: params.referralAccount ? validateSolanaAddress(params.referralAccount) : undefined,
    referralFee: isDefined(params.referralFee) ? String(params.referralFee) : undefined,
    payer: params.payer ? validateSolanaAddress(params.payer) : undefined,
    priorityFeeLamports: isDefined(params.priorityFeeLamports) ? String(params.priorityFeeLamports) : undefined,
    jitoTipLamports: isDefined(params.jitoTipLamports) ? String(params.jitoTipLamports) : undefined,
    broadcastFeeType: params.broadcastFeeType,
    excludeRouters: normalizeCsvValue(params.excludeRouters),
    excludeDexes: normalizeCsvValue(params.excludeDexes),
  };

  return Object.fromEntries(
    Object.entries(query).filter((entry): entry is [string, string] => Boolean(entry[1])),
  );
}

export function normalizeBuildQueryParams(params: JupiterSwapBuildParams): Record<string, string> {
  validateJupiterSwapBuildParams(params);

  const query: Record<string, string | undefined> = {
    inputMint: validateSolanaAddress(params.inputMint),
    outputMint: validateSolanaAddress(params.outputMint),
    amount: params.amount,
    taker: validateSolanaAddress(params.taker),
    slippageBps: isDefined(params.slippageBps) ? String(params.slippageBps) : undefined,
    mode: params.mode,
    dexes: normalizeCsvValue(params.dexes),
    excludeDexes: normalizeCsvValue(params.excludeDexes),
    platformFeeBps: isDefined(params.platformFeeBps) ? String(params.platformFeeBps) : undefined,
    feeAccount: params.feeAccount ? validateSolanaAddress(params.feeAccount) : undefined,
    maxAccounts: isDefined(params.maxAccounts) ? String(params.maxAccounts) : undefined,
    payer: params.payer ? validateSolanaAddress(params.payer) : undefined,
    wrapAndUnwrapSol: isDefined(params.wrapAndUnwrapSol) ? String(params.wrapAndUnwrapSol) : undefined,
    destinationTokenAccount: params.destinationTokenAccount
      ? validateSolanaAddress(params.destinationTokenAccount)
      : undefined,
    nativeDestinationAccount: params.nativeDestinationAccount
      ? validateSolanaAddress(params.nativeDestinationAccount)
      : undefined,
    blockhashSlotsToExpiry: isDefined(params.blockhashSlotsToExpiry)
      ? String(params.blockhashSlotsToExpiry)
      : undefined,
    tipAmount: isDefined(params.tipAmount) ? String(params.tipAmount) : undefined,
    computeUnitPricePercentile: isDefined(params.computeUnitPricePercentile)
      ? String(params.computeUnitPricePercentile)
      : undefined,
    forJitoBundle: isDefined(params.forJitoBundle) ? String(params.forJitoBundle) : undefined,
  };

  return Object.fromEntries(
    Object.entries(query).filter((entry): entry is [string, string] => Boolean(entry[1])),
  );
}

export function validateJupiterSwapSubmitRequest(request: JupiterSwapSubmitRequest): void {
  const signedTransaction = request.signedTransaction.trim();
  if (!signedTransaction) {
    throw new VexError(
      ErrorCodes.SOLANA_SWAP_FAILED,
      "signedTransaction is required for /tx/v1/submit.",
    );
  }
  // The client serializes the request VERBATIM (client.ts JSON.stringify) —
  // validating a trimmed copy while sending the original would let
  // whitespace-wrapped base64 pass here and different bytes go on the wire.
  // Reject the mismatch outright instead of silently normalizing.
  if (signedTransaction !== request.signedTransaction) {
    throw new VexError(
      ErrorCodes.SOLANA_SWAP_FAILED,
      "signedTransaction must not carry surrounding whitespace.",
    );
  }
  if (!isBase64(signedTransaction)) {
    throw new VexError(
      ErrorCodes.SOLANA_SWAP_FAILED,
      "signedTransaction must be base64-encoded for /tx/v1/submit.",
    );
  }
}
