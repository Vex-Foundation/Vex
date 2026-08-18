/**
 * Money, asset and percent primitives shared by every Morpho projection.
 *
 * This module owns the two disciplines rules/90 makes non-negotiable for this
 * protocol, and it owns them in ONE place so neither tool can drift.
 *
 * MONEY. Every raw base-unit amount is projected as
 * `{raw, decimals, symbol, human, usd}`. `human` is rendered by exact decimal
 * string arithmetic over the BigInt - never through `Number` - because a
 * u256 in a double is a silent loss on exactly the values that matter most.
 * `usd` is always labelled as an oracle-dependent estimate at the row level,
 * never presented as a measured figure: Morpho's own USD marks come from the
 * market's oracle, and the 2026-08-14 probe found an UNLISTED market reporting
 * 2.75 billion USD supplied while carrying an `oracle_unusable` RED warning.
 *
 * PERCENT. {@link toPercent} is the single fraction-to-percent conversion point
 * for the whole namespace. Each lane then names the BASIS of every APY it emits
 * in the field's own key, because a rate excluding rewards, a rate including
 * them, and a reward APR in a third token look identical once printed.
 */

import type { MorphoAsset, MorphoRawAmount } from "@tools/morpho/types.js";

/** The sentence every USD figure in this namespace is qualified by. */
export const MORPHO_USD_DISCLAIMER =
  "USD values are Morpho's own oracle marks, not measured trade prices - treat them as estimates whose accuracy "
  + "depends on the market's oracle, and read `warnings` before trusting one.";

export interface ProjectedAmount {
  raw: string;
  decimals: number;
  symbol: string | null;
  human: string;
  usd: number | null;
}

/**
 * Exact base-units -> human decimal string. Pure BigInt and string slicing, so a
 * 27-digit collateral balance renders exactly and a value beyond a double's
 * range never touches floating point.
 */
export function formatRawAmount(raw: string, decimals: number): string {
  const negative = raw.startsWith("-");
  const digits = (negative ? raw.slice(1) : raw).replace(/^0+(?=\d)/, "");
  if (decimals === 0) return `${negative ? "-" : ""}${digits}`;
  const padded = digits.padStart(decimals + 1, "0");
  const whole = padded.slice(0, padded.length - decimals);
  const fraction = padded.slice(padded.length - decimals).replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${fraction.length > 0 ? `.${fraction}` : ""}`;
}

export function projectAmount(amount: MorphoRawAmount | null, symbol: string | null): ProjectedAmount | null {
  if (amount === null) return null;
  return {
    raw: amount.raw,
    decimals: amount.decimals,
    symbol,
    human: formatRawAmount(amount.raw, amount.decimals),
    usd: amount.usd,
  };
}

/** A raw amount whose decimals come from a named asset, not from a guess. */
export function projectStandalone(raw: string | null, asset: MorphoAsset): ProjectedAmount | null {
  if (raw === null) return null;
  return {
    raw,
    decimals: asset.decimals,
    symbol: asset.symbol,
    human: formatRawAmount(raw, asset.decimals),
    usd: null,
  };
}

/**
 * A SHARE quantity, which is NOT money.
 *
 * Morpho's read APIs serve share counts as bare integers and serve no scale for
 * them anywhere in this lane: no vault share-token `decimals`, no market share
 * offset. So the scale is reported as UNKNOWN rather than assumed. Defaulting to
 * 18 would render a number that looks readable and is not, which is exactly the
 * failure rules/90 names - a raw amount beside an assets amount that DOES carry
 * its decimals, three orders of magnitude apart, with nothing to tell them apart.
 */
export interface ProjectedShareQuantity {
  raw: string;
  /** Always null here: Morpho serves no scale for a share unit. Never assume 18. */
  decimals: null;
  /** Null exactly because `decimals` is - without a scale there is no readable value. */
  human: null;
  scale: "unknown";
}

/** The sentence every share quantity in this namespace is qualified by. */
export const MORPHO_SHARES_NOTE =
  "A `shares` quantity is an ACCOUNTING UNIT, not money. Morpho serves no scale for one, so each carries "
  + "`scale: \"unknown\"` with a null `decimals` and a null `human`, and Vex will not assume 18 decimals to make the "
  + "number look readable. Never show a share count as an asset amount and never compare one across markets or "
  + "vaults; read the matching assets figure, which does carry its decimals, for what the position is worth.";

export function projectShareQuantity(raw: string | null): ProjectedShareQuantity | null {
  if (raw === null) return null;
  return { raw, decimals: null, human: null, scale: "unknown" };
}

export interface ProjectedAsset {
  address: string;
  symbol: string | null;
  decimals: number;
  priceUsd: number | null;
}

export function projectAsset(asset: MorphoAsset | null): ProjectedAsset | null {
  if (asset === null) return null;
  return { address: asset.address, symbol: asset.symbol, decimals: asset.decimals, priceUsd: asset.priceUsd };
}

/** Fraction -> percent, or null. One conversion point for every APY in the namespace. */
export function toPercent(fraction: number | null): number | null {
  return fraction === null ? null : fraction * 100;
}
