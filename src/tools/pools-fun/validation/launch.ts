/**
 * Validators for the launch-preparation endpoints.
 *
 * STRICTER THAN THE READ VALIDATORS, on purpose. A discover row feeds a
 * screener, so a display field that arrives null is tolerated; everything here
 * feeds a SIGNING path, where a missing or malformed field is not a degraded
 * answer but an unusable one. So every field is required and typed, and a
 * response that does not carry all of them is refused rather than patched.
 *
 * These validators prove SHAPE only. They prove nothing about whether the
 * calldata does what the response claims - that is the calldata verifier's job,
 * and it re-derives every one of these values from the decoded tuple and from
 * the chain rather than believing the JSON.
 */

import { z } from "zod";
import type {
  PoolsDevBuyQuote,
  PoolsImageUpload,
  PoolsLaunchConfig,
  PoolsPrepareResponse,
} from "../types.js";
import { address, displayNumber, displayString, parseOrThrow } from "./_shared.js";

/** A non-negative integer in smallest units, as the provider sends it. */
const rawAmount = z.string().regex(/^\d+$/, { error: "expected a raw integer amount string" });

/**
 * `value`, which the provider sends HEX-encoded while every sibling amount on
 * the same response is decimal (measured 2026-08-19).
 *
 * Both encodings are accepted and NORMALISED to decimal, so the split stops at
 * this boundary instead of reaching a refusal message or a UI. This is an
 * encoding normalisation, not a tolerance: the value is unchanged, and a string
 * that is neither encoding is still refused.
 */
const weiAmount = z
  .string()
  .regex(/^(\d+|0x[0-9a-fA-F]+)$/, { error: "expected a decimal or 0x-hex wei amount" })
  .transform((raw) => BigInt(raw).toString());

/**
 * The launchpad's resolution of the fee recipient. `address` is strict - it is
 * what the verifier holds the signed tuple to - and `display` is a UI label.
 */
const resolvedFeeRecipient = z.object({
  address,
  display: displayString,
});

/** The response's paired-asset block. Informational; see `PoolsPreparedPairedAsset`. */
const preparedPairedAsset = z.object({
  address,
  kind: displayString,
  symbol: displayString,
  decimals: displayNumber,
});

/** `0x` + 64 hex: the CREATE2 salt the backend mined. */
const salt = z.string().regex(/^0x[0-9a-fA-F]{64}$/, { error: "expected a 32-byte salt" });

/** Non-empty calldata. Its CONTENTS are proven by the verifier, not here. */
const calldata = z.string().regex(/^0x[0-9a-fA-F]+$/, { error: "expected hex calldata" });

const prepareResponseSchema: z.ZodType<PoolsPrepareResponse> = z.object({
  requiresReprepare: z.boolean(),
  to: address,
  data: calldata,
  value: weiAmount,
  predictedTokenAddress: address,
  predictedPoolAddress: address,
  salt,
  metadataUri: z.string().min(1),
  devBuyMinOut: rawAmount,
  devBuyAmountIn: rawAmount,
  deploymentFeeWei: rawAmount,
  nativeDevBuyWei: rawAmount,
  deadline: rawAmount,
  pairedAsset: preparedPairedAsset,
  tokenSymbol: z.string().min(1),
  feeRecipient: resolvedFeeRecipient,
});

const launchConfigSchema: z.ZodType<PoolsLaunchConfig> = z.object({
  deploymentFeeWei: rawAmount,
  gatewayVersion: z.number().int().nonnegative(),
});

const imageUploadSchema: z.ZodType<PoolsImageUpload> = z.object({
  url: z.string().url({ error: "expected an absolute URL" }),
});

const devBuyQuoteSchema: z.ZodType<PoolsDevBuyQuote> = z.object({
  devBuyAmountIn: rawAmount,
  devBuyAmountOut: rawAmount,
  totalSupply: rawAmount,
});

export function validatePrepareResponse(raw: unknown): PoolsPrepareResponse {
  return parseOrThrow(prepareResponseSchema, raw);
}

export function validateLaunchConfig(raw: unknown): PoolsLaunchConfig {
  return parseOrThrow(launchConfigSchema, raw);
}

export function validateImageUpload(raw: unknown): PoolsImageUpload {
  return parseOrThrow(imageUploadSchema, raw);
}

export function validateDevBuyQuote(raw: unknown): PoolsDevBuyQuote {
  return parseOrThrow(devBuyQuoteSchema, raw);
}
