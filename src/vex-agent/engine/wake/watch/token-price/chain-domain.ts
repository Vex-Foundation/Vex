/**
 * The chain domain of a `token_price` watch: which chains may be watched, and
 * what a token address is allowed to look like on each of them.
 *
 * ## Why a CLOSED set and not the permissive resolver
 *
 * `resolveDexScreenerChain` passes any non-numeric string straight through as a
 * slug, because DexScreener is the authority on its own slug table. That is
 * right for a read tool, where a wrong slug costs one 404 the agent sees. It is
 * wrong for a WATCH: an unrecognised slug would arm cleanly, poll forever
 * against a URL that never returns pools, and the session would sleep out its
 * full timer waiting for a price that could never arrive. So the set is closed,
 * and everything outside it is refused BY NAME while the defer still parks.
 *
 * ## Two families, because an address means different things on each
 *
 * An EVM address is 20 hex bytes and is case-INSENSITIVE (the mixed case is a
 * checksum, not identity), so it is normalised to lowercase. A Solana address is
 * base58 and is case-SENSITIVE: lowercasing it names a DIFFERENT mint, or no
 * mint at all. That single asymmetry is why normalisation lives here, per
 * family, instead of being a `.toLowerCase()` at the call sites.
 *
 * Cross-family mistakes are the ones a model actually makes (a 0x address with
 * `chain: "solana"` after reading a bridge quote), so each is refused with the
 * shape that chain expects rather than a generic "invalid address".
 */

import { SOLANA_SYNTHETIC_CHAIN_ID } from "../../../../../constants/solana-chain.js";
import { resolveChainSlug } from "@tools/kyberswap/chains.js";

export type TokenPriceChainFamily = "evm" | "solana";

/** DexScreener's slug for Solana, and the repo's canonical chain name for it. */
export const SOLANA_CHAIN_SLUG = "solana";

/**
 * Base58, mint length. Same rule as `tools/solana-ecosystem/shared/schemas.ts`
 * (`solanaPubkey`) and the Khalani and Virtuals validators; restated as a bare
 * regex because the wake banner needs it without pulling a Zod schema and a
 * Solana-ecosystem import into the executor.
 */
export const SOLANA_ADDRESS_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** 20 hex bytes. Case carries a checksum, never identity. */
export const EVM_ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

/**
 * How the agent may spell Solana. `sol`/`solana` mirror the Khalani chain
 * aliases, and the numeric form is the repo's ONE synthetic Solana chain id
 * (`SOLANA_SYNTHETIC_CHAIN_ID`), which is what `TokenFind` and the activity
 * vocabulary hand the model. Anything else numeric goes to the EVM registry.
 */
const SOLANA_CHAIN_INPUTS: ReadonlySet<string> = new Set([
  "sol",
  SOLANA_CHAIN_SLUG,
  String(SOLANA_SYNTHETIC_CHAIN_ID),
]);

export interface ResolvedWatchChain {
  /** The slug DexScreener is asked for. */
  readonly slug: string;
  readonly family: TokenPriceChainFamily;
}

/** `null` when the chain is outside the closed set. */
export function resolveWatchChain(raw: string): ResolvedWatchChain | null {
  const trimmed = raw.trim();
  if (SOLANA_CHAIN_INPUTS.has(trimmed.toLowerCase())) {
    return { slug: SOLANA_CHAIN_SLUG, family: "solana" };
  }
  try {
    return { slug: resolveChainSlug(trimmed), family: "evm" };
  } catch {
    return null;
  }
}

/** The family a persisted slug belongs to, for the read-back path. */
export function familyForSlug(slug: string): TokenPriceChainFamily {
  return slug === SOLANA_CHAIN_SLUG ? "solana" : "evm";
}

export function isValidAddressForFamily(
  family: TokenPriceChainFamily,
  address: string,
): boolean {
  return family === "solana"
    ? SOLANA_ADDRESS_PATTERN.test(address)
    : EVM_ADDRESS_PATTERN.test(address);
}

/**
 * The canonical spelling stored and compared for this family. EVM folds to
 * lowercase; Solana is returned untouched, because base58 case IS identity.
 */
export function normalizeAddressForFamily(
  family: TokenPriceChainFamily,
  address: string,
): string {
  return family === "solana" ? address : address.toLowerCase();
}

/** What to tell the model when the address does not fit the chain it named. */
export function addressShapeHint(family: TokenPriceChainFamily): string {
  return family === "solana"
    ? "on solana, tokenAddress must be a base58 mint address (32-44 characters, no 0x prefix)"
    : "on an EVM chain, tokenAddress must be a 0x-prefixed 20-byte hex address";
}
