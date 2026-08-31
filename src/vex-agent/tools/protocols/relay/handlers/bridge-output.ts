/**
 * Agent-grade output projection for Relay bridge results (Wave-3 W3b, §4).
 *
 * Pure, no IO, no recording: builds the structured, NEVER-truncated (OWNER RULE)
 * projection the model + feed consume — from→to chains explicit, human amounts,
 * USD verbatim-from-the-adapted-quote and always a NULLABLE ESTIMATE, per-leg
 * hashes structured. Raw smallest-unit amounts and provider jargon never leak
 * out; every agent-relevant FIELD is preserved.
 */

import { formatUnits } from "viem";

import { RELAY_NATIVE_CURRENCY } from "@tools/relay/chains.js";
import type { RelayChain } from "@tools/relay/types.js";
import type { RelayQuoteSide } from "@tools/relay/quote.js";
import {
  isVerifiedEvmBridgeAssetIdentity,
  type BridgeAssetIdentity,
} from "@vex-agent/tools/protocols/bridge-token-identity.js";

/** A bridge endpoint (origin / destination) projected for display. */
export interface BridgeEndpointDisplay {
  readonly id: number;
  readonly name: string;
}

/** One side (in / out) of the bridge projected for display — USD is a nullable estimate. */
export interface BridgeAmountDisplay {
  /** SYMBOL when known, else the currency address (never a bare zero-address). */
  readonly token: string;
  readonly tokenAddress: string;
  /**
   * HUMAN-readable amount, or null when Relay gave nothing convertible to human
   * units. NEVER a raw smallest-unit value — a raw fallback is preserved in
   * `amountRaw` and labelled explicitly by consumers (m6: no silent unit confusion).
   */
  readonly amount: string | null;
  /**
   * RAW smallest-unit amount VERBATIM (wei-scale), or null. Preserved so no value
   * is lost (OWNER RULE) even when the human amount is unavailable; it is NEVER
   * shown as if it were a human amount.
   */
  readonly amountRaw: string | null;
  /** Per-side USD ESTIMATE from the adapted quote — null unless finite. */
  readonly usd: string | null;
}

/** One execution/fill leg projected for the structured `legs[]` output. */
export interface BridgeOutputLeg {
  readonly role: string;
  readonly chainId: number;
  readonly chainName: string;
  /** Origin broadcast hash (Vex-signed) or provider-reported fill hash; null when unknown. */
  readonly txHash: string | null;
  readonly status: string;
}

/**
 * USD ESTIMATE for a Vex fee amount, derived from the quote side's own
 * per-side USD: `feeUsd = (sideUsd / sideHumanAmount) × feeHumanAmount`. Relay
 * prices the side, not the fee, so this is a proration and is labelled an
 * estimate everywhere it surfaces. Returns null — never a fabricated figure —
 * whenever decimals, USD, or a positive human amount is missing.
 */
export function relayFeeUsdEstimate(
  side: RelayQuoteSide,
  feeRaw: bigint,
  identity?: BridgeAssetIdentity,
): string | null {
  const direct = isVerifiedEvmBridgeAssetIdentity(identity) ? identity : undefined;
  const decimals = direct?.decimals ?? side.decimals;
  const { amountUsd } = side;
  if (decimals === null || amountUsd === null) return null;

  const humanAmount = side.amountRaw !== null && /^\d+$/.test(side.amountRaw)
    ? formatUnits(BigInt(side.amountRaw), decimals)
    : direct !== undefined
      ? null
      : side.amountFormatted;
  if (humanAmount === null) return null;

  const sideAmount = Number(humanAmount);
  const sideUsd = Number(amountUsd);
  const feeAmount = Number(formatUnits(feeRaw, decimals));
  if (!Number.isFinite(sideAmount) || sideAmount <= 0) return null;
  if (!Number.isFinite(sideUsd) || !Number.isFinite(feeAmount)) return null;

  const feeUsd = (sideUsd / sideAmount) * feeAmount;
  if (!Number.isFinite(feeUsd)) return null;
  return feeUsd.toFixed(6).replace(/\.?0+$/, "") || "0";
}

/** Curated display name for a chain from the live Relay registry (displayName → name → id). */
export function relayChainDisplayName(chainId: number, chains: readonly RelayChain[]): string {
  const chain = chains.find((c) => c.id === chainId);
  return chain?.displayName ?? chain?.name ?? String(chainId);
}

export function relayChainDisplay(chainId: number, chains: readonly RelayChain[]): BridgeEndpointDisplay {
  return { id: chainId, name: relayChainDisplayName(chainId, chains) };
}

/**
 * Project one quote side (currencyIn / currencyOut) for display. Symbol
 * precedence: quote metadata → the chain's native-currency symbol (zero-address
 * native) → the raw currency address. HUMAN amount precedence: Relay's
 * `amountFormatted` → `formatUnits(amountRaw, decimals)` → null. The raw
 * smallest-unit value (`side.amountRaw` or the `rawFallback` the caller passes)
 * is NEVER promoted into the human `amount` (m6: that was the unit-confusion
 * bug); it is preserved verbatim in `amountRaw` so nothing is lost. USD is passed
 * through verbatim (already finite-validated + nullable by the adapter). No
 * network calls — everything comes from the quote + cached chains.
 */
export function bridgeSideDisplay(
  side: RelayQuoteSide,
  currencyAddress: string,
  chainId: number,
  chains: readonly RelayChain[],
  rawFallback?: string,
  identity?: BridgeAssetIdentity,
): BridgeAmountDisplay {
  const nativeSymbol = currencyAddress === RELAY_NATIVE_CURRENCY
    ? chains.find((c) => c.id === chainId)?.currency?.symbol
    : undefined;
  const direct = isVerifiedEvmBridgeAssetIdentity(identity) ? identity : undefined;
  const token = direct !== undefined
    ? direct.symbol
    : side.symbol ?? nativeSymbol ?? currencyAddress;

  const decimals = direct?.decimals ?? side.decimals;
  let amount = direct !== undefined ? null : side.amountFormatted;
  if (side.amountRaw !== null && decimals !== null && /^\d+$/.test(side.amountRaw)) {
    amount = formatUnits(BigInt(side.amountRaw), decimals);
  } else if (amount === null && rawFallback !== undefined && decimals !== null && /^\d+$/.test(rawFallback)) {
    amount = formatUnits(BigInt(rawFallback), decimals);
  }
  // The raw fallback is a smallest-unit value — keep it verbatim, but never as
  // the human `amount` (a consumer labels it "<raw> (raw units)" when needed).
  const amountRaw = side.amountRaw ?? rawFallback ?? null;

  return { token, tokenAddress: currencyAddress, amount, amountRaw, usd: side.amountUsd };
}

/**
 * The lead summary line, e.g.
 *   "Bridging 0.001 ETH from Base to Robinhood Chain via Relay (~$2.94 in, est.)".
 * USD is appended only when present, and always marked an estimate. When no human
 * amount is available the raw smallest-unit value is labelled explicitly (m6:
 * "<raw> (raw units)") rather than shown as if it were a human amount; with
 * neither, the amount is omitted ("the requested amount").
 */
export function bridgeSummaryLine(
  inSide: BridgeAmountDisplay,
  from: BridgeEndpointDisplay,
  to: BridgeEndpointDisplay,
): string {
  const amount =
    inSide.amount
    ?? (inSide.amountRaw !== null ? `${inSide.amountRaw} (raw units)` : "the requested amount");
  const usd = inSide.usd !== null ? ` (~$${inSide.usd} in, est.)` : "";
  return `Bridging ${amount} ${inSide.token} from ${from.name} to ${to.name} via Relay${usd}`;
}
