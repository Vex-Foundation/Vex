/**
 * Shared Pendle handler helpers — used by BOTH the PT (`handlers/pt.ts`) and the
 * YT + claim (`handlers/yt.ts`) surfaces.
 *
 * These are fund-safety-adjacent (chain resolution, ON-CHAIN decimal reads,
 * slippage normalization), so they live in ONE place: duplicating
 * `resolveInputToken` in particular would risk a divergent decimals read feeding
 * `parseUnits` on one surface but not the other. Model-facing failures stay
 * bounded + code-keyed — upstream error text NEVER reaches the model.
 */

import { formatUnits, getAddress, type Address } from "viem";

import { PENDLE_NATIVE_TOKEN, PENDLE_ERC20_ABI } from "@tools/pendle/constants.js";
import { getPendleChain, resolvePendleChainId, type PendleChain } from "@tools/pendle/chains.js";
import { getPendlePublicClient } from "@tools/pendle/evm-client.js";
import type { PendleAsset } from "@tools/pendle/types.js";

import { VexError, ErrorCodes } from "../../../../../errors.js";
import logger from "@utils/logger.js";
import { priceUsdFor } from "../market-lookup.js";

/** Default slippage (bps) when the caller omits it — matches the redeem identity builder. */
export const DEFAULT_SLIPPAGE_BPS = 50;

export function isNativeInput(input: string): boolean {
  const lower = input.trim().toLowerCase();
  return lower === "native" || lower === "eth" || lower === PENDLE_NATIVE_TOKEN.toLowerCase();
}

/**
 * Convert a caller-supplied basis-point tolerance to the fraction Pendle's
 * Convert API expects. An OMITTED value takes {@link DEFAULT_SLIPPAGE_BPS};
 * an INVALID one is rejected.
 *
 * This used to read `bps !== undefined && bps >= 0 ? bps : DEFAULT_SLIPPAGE_BPS`,
 * which silently substituted 50 bps for a negative input — a caller that passes
 * `-1` has made an error, and quietly trading with a tolerance they never asked
 * for hides it at a price-protection boundary. A fractional value is rejected
 * for the same reason it is at the manifest gate: `0.5` could mean 0.5 bps or
 * 0.5%, and rounding a price-protection parameter is guessing.
 *
 * Defense-in-depth only — `unit: "bps"` on the Pendle manifests
 * (`runtime/bps-param.ts`) rejects both cases before any handler runs. Every
 * caller sits inside a handler-level `try/catch` that returns `fail(...)`.
 *
 * The 5000 bps cap below is PRE-EXISTING and deliberately left untouched;
 * changing or removing it is a separate, owner-gated decision.
 */
export function slippageFraction(bps: number | undefined): number {
  if (bps === undefined) return DEFAULT_SLIPPAGE_BPS / 10_000;
  if (!Number.isInteger(bps) || bps < 0) {
    throw new VexError(
      ErrorCodes.INVALID_AMOUNT,
      `Invalid slippageBps: ${bps}`,
      "slippageBps must be a whole, non-negative number of basis points (1 bps = 0.01%).",
    );
  }
  return Math.min(bps, 5000) / 10_000;
}

/** Model-facing failure detail — code-keyed + bounded, never upstream text. */
export function failureDetail(toolId: string, err: unknown): string {
  logger.warn("pendle.handler.error", {
    toolId,
    code: err instanceof VexError ? err.code : "UNEXPECTED",
    error: (err instanceof Error ? err.message : String(err)).slice(0, 200),
  });
  if (err instanceof VexError) return err.hint ? `${err.code}: ${err.hint}` : err.code;
  return "unexpected error";
}

/**
 * Resolve the requested chain to a supported Pendle chain entry, or throw a clear
 * VexError. Returns the full registry entry so callers get the id, slug, and
 * wrapped-native for hints.
 */
export function requirePendleChain(chain: string): PendleChain {
  const chainId = resolvePendleChainId(chain);
  const entry = chainId !== undefined ? getPendleChain(chainId) : undefined;
  if (!entry) {
    throw new VexError(ErrorCodes.PENDLE_API_ERROR, `Pendle does not support chain "${chain}".`);
  }
  return entry;
}

/** The advisory "pass wrapped native" hint for the resolved chain. */
export function wrappedNativeHint(chain: PendleChain): string {
  if (chain.wrappedNative) {
    return `Pass ${chain.wrappedNative.symbol} (${chain.wrappedNative.address}) for ${chain.nativeSymbol} exposure.`;
  }
  return `Pass the chain's wrapped native token address for ${chain.nativeSymbol} exposure.`;
}

export interface InputToken {
  address: Address;
  isNative: boolean;
  decimals: number;
}

/**
 * Resolve the input token leg on the RESOLVED chain. Native input is REJECTED for
 * the mutating Pendle paths (this wave): the shared prequote gate canonicalizes
 * native to a different sentinel than Pendle's Convert API, which would make a
 * native buy fail the quote↔execute identity match. Users wanting native
 * exposure pass the chain's wrapped-native token. Decimals are read on-chain
 * from the resolved chain's client.
 */
export async function resolveInputToken(chain: PendleChain, raw: string): Promise<InputToken> {
  if (isNativeInput(raw)) {
    throw new VexError(
      ErrorCodes.PENDLE_TOKEN_NOT_FOUND,
      "Pendle trades require an ERC-20 input token — native currency is not supported here.",
      wrappedNativeHint(chain),
    );
  }
  let address: Address;
  try {
    address = getAddress(raw);
  } catch {
    throw new VexError(ErrorCodes.PENDLE_TOKEN_NOT_FOUND, `Pendle input token "${raw}" is not a valid address or native currency.`);
  }
  const client = getPendlePublicClient(chain.chainId);
  let decimals: number;
  try {
    decimals = Number(await client.readContract({ address, abi: PENDLE_ERC20_ABI, functionName: "decimals" }));
  } catch {
    throw new VexError(ErrorCodes.PENDLE_TOKEN_NOT_FOUND, `Cannot read decimals for ${address} on ${chain.slug} — not an ERC-20 there.`);
  }
  return { address, isNative: false, decimals };
}

/** A valid checksummed address, or a bounded token-not-found error. */
export function requireTokenAddress(raw: string): Address {
  try {
    return getAddress(raw);
  } catch {
    throw new VexError(ErrorCodes.PENDLE_TOKEN_NOT_FOUND, `Pendle token "${raw}" is not a valid address.`);
  }
}

export function humanAmount(wei: string | bigint, decimals: number | null): number {
  const n = Number(formatUnits(BigInt(wei), decimals ?? 18));
  return Number.isFinite(n) ? n : 0;
}

/** USD value of a leg from the Pendle asset map, with a best-effort fallback. */
export function legUsd(assetMap: Map<string, PendleAsset>, address: string, human: number): number | null {
  const price = priceUsdFor(assetMap, address);
  if (price === null) return null;
  const usd = human * price;
  return Number.isFinite(usd) ? usd : null;
}
