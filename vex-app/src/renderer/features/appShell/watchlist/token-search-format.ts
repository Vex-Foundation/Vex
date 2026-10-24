/**
 * Pure helpers for the add form's token search: when to search at all, and
 * the words and figures a result row shows.
 */

import type { TokenSearchHitDto } from "@shared/schemas/alerts.js";
import { formatAlertPrice } from "@shared/alerts-copy.js";

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** A pasted contract or mint address needs no search: Follow takes it as it is. */
export function looksLikeAddress(text: string, family: "evm" | "solana"): boolean {
  const trimmed = text.trim();
  return family === "solana" ? SOLANA_ADDRESS.test(trimmed) : EVM_ADDRESS.test(trimmed);
}

/** "0x532f…42E4": enough of the address to tell two tokens with one ticker apart. */
export function shortAddress(address: string): string {
  return address.length <= 12 ? address : `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/** "$1.2M", "$842k", "$310": compact USD for liquidity and volume. */
export function compactUsd(value: number | null): string {
  if (value === null) return "n/a";
  if (value >= 1_000_000_000) return `$${(value / 1_000_000_000).toFixed(1)}B`;
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `$${Math.round(value / 1_000)}k`;
  return `$${Math.round(value)}`;
}

/** The row's figures: price, then how much it trades and in how many pools. */
export function hitDetail(hit: TokenSearchHitDto): string {
  const price = hit.priceUsd === null ? "no price" : `$${formatAlertPrice(hit.priceUsd)}`;
  const pools = hit.poolCount === 1 ? "1 pool" : `${hit.poolCount} pools`;
  return `${price} · ${compactUsd(hit.volume24hUsd)} 24h volume · ${pools}`;
}
