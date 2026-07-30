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

import { getAddress, type Address } from "viem";

import { PENDLE_NATIVE_TOKEN, PENDLE_ERC20_ABI } from "@tools/pendle/constants.js";
import { getPendleChain, resolvePendleChainId, type PendleChain } from "@tools/pendle/chains.js";
import { getPendlePublicClient } from "@tools/pendle/evm-client.js";
import type { PendleAsset } from "@tools/pendle/types.js";
import type { AgentActivityLegInput } from "@vex-agent/db/repos/agent-activity.js";

import { VexError, ErrorCodes } from "../../../../../errors.js";
import logger from "@utils/logger.js";
import type { ToolResult } from "../../../types.js";
import { formatRawAmount } from "../../amount-display.js";
import { checkSlippageBps } from "../../slippage-policy.js";
import { priceUsdFor } from "../market-lookup.js";
import type { PendleBroadcastResult } from "./signed-broadcast.js";

/** Default slippage (bps) when the caller omits it — matches the redeem identity builder. */
export const DEFAULT_SLIPPAGE_BPS = 50;

export function isNativeInput(input: string): boolean {
  const lower = input.trim().toLowerCase();
  return lower === "native" || lower === "eth" || lower === PENDLE_NATIVE_TOKEN.toLowerCase();
}

/** The tolerance a Pendle trade runs at, in the two forms the path needs. */
export interface PendleSlippage {
  /**
   * Whole basis points — what the PRICE FLOOR is computed from
   * (`calldata/price-floor.ts`).
   */
  readonly bps: number;
  /** The same tolerance as the fraction Pendle's Convert API expects. */
  readonly fraction: number;
}

/**
 * Resolve a caller-supplied basis-point tolerance for a Pendle trade. An
 * OMITTED value takes {@link DEFAULT_SLIPPAGE_BPS}; an INVALID or
 * OUT-OF-POLICY one is REJECTED.
 *
 * Two defects closed here, both at a price-protection boundary:
 *
 * 1. This used to read `bps !== undefined && bps >= 0 ? bps : DEFAULT_SLIPPAGE_BPS`,
 *    silently substituting 50 bps for a negative input. A caller that passes
 *    `-1` has made an error, and quietly trading with a tolerance they never
 *    asked for hides it. A fractional value is rejected for the same reason it
 *    is at the manifest gate: `0.5` could mean 0.5 bps or 0.5%, and rounding a
 *    price-protection parameter is guessing.
 *
 * 2. Pendle then CLAMPED with `Math.min(bps, 5000)` — the only venue in the tree
 *    exempt from `protocols/slippage-policy.ts`, which every other venue obeys
 *    and which is explicit that out-of-range is "REJECTED, never clamped"
 *    (`VEX_MAX_SLIPPAGE_BPS = 1000`). Because the clamp applied identically on
 *    the quote and the execute, the prequote digests still collided and a
 *    `slippageBps: 999999` trade executed at 50% tolerance with nothing
 *    surfaced. Pendle now runs the shared policy check (owner decision Q8, G-40
 *    / P1-4); no venue maximum is passed because Pendle publishes none below
 *    Vex's, which is the fail-safe reading.
 *
 * Returning BOTH forms from ONE resolution is deliberate: the quote is sent the
 * fraction and the floor is derived from the bps, and if those ever came from
 * separate calls the guard could hold a route to a tolerance the caller did not
 * trade at.
 *
 * `toolId` names the offending call for the agent, matching KyberSwap's
 * `resolveKyberSlippageBps`. Every caller sits inside a handler-level
 * `try/catch` that returns `fail(...)`.
 */
export function resolvePendleSlippage(toolId: string, bps: number | undefined): PendleSlippage {
  const value = bps ?? DEFAULT_SLIPPAGE_BPS;
  const violation = checkSlippageBps(`Parameter "slippageBps" for ${toolId}`, value);
  if (violation !== null) {
    throw new VexError(ErrorCodes.INVALID_AMOUNT, `Invalid slippageBps: ${value}`, violation);
  }
  return { bps: value, fraction: value / 10_000 };
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

/**
 * Pendle's display reading of a wei amount. The conversion is owned by
 * `protocols/amount-display.ts`; this keeps Pendle's own contract — the 18-
 * decimal default, the numeric result, and the deliberate THROW on a
 * malformed `wei` (`BigInt` below, unchanged) rather than a silent zero.
 */
export function humanAmount(wei: string | bigint, decimals: number | null): number {
  const n = Number(formatRawAmount(BigInt(wei), decimals ?? 18));
  return Number.isFinite(n) ? n : 0;
}

/**
 * Build one `agent_activity` leg. Every field the row needs to be READABLE
 * travels together (rules/90): a raw amount whose decimals are unknown is the
 * canonical thousandfold-error shape — `"1047061"` is 1.05 at 6 decimals and
 * 0.00105 at 9 — so an unknown `decimals` also drops the human rendering rather
 * than pairing a raw amount with a guessed one.
 */
export function legInput(
  address: string,
  symbol: string | null | undefined,
  decimals: number | null | undefined,
  amountRaw: string,
  amountHuman: string,
): AgentActivityLegInput {
  return {
    tokenAddress: address,
    ...(symbol ? { tokenSymbol: symbol } : {}),
    ...(decimals !== null && decimals !== undefined
      ? { tokenDecimals: decimals, amountRaw, amountHuman }
      : { amountRaw }),
  };
}

/**
 * The ONE model-facing wording for a Pendle broadcast that did not end in a
 * proven fill — reverted, unprovable, or a claim that swept nothing.
 *
 * Always `success: false`, deliberately: `runtime/capture.ts` skips capture on a
 * failed result, and a mined-but-unproven trade must NOT project a lot from
 * amounts nobody decoded. The durable row already exists and carries the truth;
 * this is what the AGENT is told, and it never claims more than the evidence
 * supports.
 */
export function unsettledResult(toolId: string, broadcast: PendleBroadcastResult): ToolResult {
  if (broadcast.kind === "confirmed") {
    throw new Error("unsettledResult: called with a confirmed broadcast");
  }
  logger.warn("pendle.handler.unsettled", {
    toolId,
    kind: broadcast.kind,
    ...(broadcast.kind === "unproven" ? { reason: broadcast.reason } : {}),
  });
  return {
    success: false,
    // The hash is appended AFTER the owned sentence, never woven into it: the
    // sentence is the contract and must stay quotable verbatim, but an agent
    // that cannot see the hash cannot check the transaction on an explorer,
    // which is the one useful thing it can still do.
    output: `${toolId}: ${broadcast.message} (tx ${broadcast.txHash})`,
    data: { _executionId: broadcast.executionId, txHash: broadcast.txHash, status: broadcast.kind },
  };
}

/** USD value of a leg from the Pendle asset map, with a best-effort fallback. */
export function legUsd(assetMap: Map<string, PendleAsset>, address: string, human: number): number | null {
  const price = priceUsdFor(assetMap, address);
  if (price === null) return null;
  const usd = human * price;
  return Number.isFinite(usd) ? usd : null;
}
