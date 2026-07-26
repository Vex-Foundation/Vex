/**
 * KyberSwap shared helpers — pure domain logic.
 * Extracted from commands/kyberswap/helpers.ts for retained core.
 */

import { isAddress, getAddress, type Address } from "viem";
import { VexError, ErrorCodes } from "../../errors.js";
import { resolveChainSlug, slugToChainId, chainIdToSlug, getChainFeatures } from "./chains.js";
import { NATIVE_TOKEN_ADDRESS } from "./constants.js";
import { getKyberTokenApiClient } from "./token-api/client.js";
import { readErc20Metadata } from "./evm-utils.js";
import { getEvmNativeCurrency, NATIVE_SENTINEL_SYMBOL } from "../evm-chains/native-currency.js";
import type { KyberChainSlug } from "./types.js";
import type { KyberToken } from "./token-api/types.js";

export interface ResolvedKyberTokenMetadata {
  address: Address;
  symbol: string;
  name: string;
  decimals: number;
  isNative: boolean;
}

/**
 * Native EVM token metadata — sentinel address, isNative, and the canonical
 * chain-agnostic `NATIVE` symbol.
 *
 * The SYMBOL stays the sentinel deliberately. It is the value persisted to
 * `agent_activity.token_*_symbol`, and the Stage-7 prequote gate canonicalizes
 * a native execute param to the same sentinel ADDRESS, so keeping both stable
 * is what preserves quote↔execute matching. The chain's real ticker is added
 * alongside, at the agent-facing boundary, via `annotateNativeSymbol`.
 *
 * `name` and `decimals` ARE sourced per chain rather than hardcoded. Decimals
 * feed `parseUnits`/`formatUnits` on a real money leg, so the value must come
 * from the chain registry rather than a standing assumption; it is 18 on every
 * chain Vex trades on today, and `native-currency.test.ts` fails loudly if a
 * chain is ever added where it is not. An unresolvable chain keeps the previous
 * generic values — never a guessed ticker.
 */
function nativeTokenMetadata(chainId: number): ResolvedKyberTokenMetadata {
  const native = getEvmNativeCurrency(chainId);
  return {
    address: NATIVE_TOKEN_ADDRESS,
    symbol: NATIVE_SENTINEL_SYMBOL,
    name: native?.name ?? "Native token",
    decimals: native?.decimals ?? 18,
    isNative: true,
  };
}

/**
 * True when the input denotes the native EVM token: the keywords
 * "native"/"eth" OR the native sentinel ADDRESS (case-insensitive). The
 * sentinel must short-circuit BEFORE generic `isAddress` handling so it is
 * never mistaken for an ERC-20 contract.
 *
 * Exported so the Stage-7 prequote execute-gate reuses the EXACT native-input
 * semantics the quote recorder relied on (the quote's `resolveTokenMetadata`
 * maps a native leg to `NATIVE_TOKEN_ADDRESS`, so the gate must canonicalize a
 * native input to the same sentinel for the match-hash to collide). Do NOT
 * duplicate this predicate at the gate.
 */
export function isNativeTokenInput(input: string): boolean {
  const lower = input.toLowerCase();
  return lower === "native" || lower === "eth" || lower === NATIVE_TOKEN_ADDRESS.toLowerCase();
}

/** Resolve --chain option to validated KyberChainSlug. */
export function resolveChain(chainInput: string): KyberChainSlug {
  return resolveChainSlug(chainInput);
}

/** Resolve --chain and get chain ID. */
export function resolveChainWithId(chainInput: string): { slug: KyberChainSlug; chainId: number } {
  const slug = resolveChainSlug(chainInput);
  return { slug, chainId: slugToChainId(slug) };
}

/** Ensure chain supports a feature, or throw. */
export function requireFeature(slug: KyberChainSlug, feature: "aggregator"): void {
  const features = getChainFeatures(slug);
  if (!features[feature]) {
    throw new VexError(
      ErrorCodes.KYBER_UNSUPPORTED_CHAIN,
      `Chain "${slug}" does not support KyberSwap ${feature}`,
    );
  }
}

/**
 * Resolve a token identifier to an Address.
 * Accepts: hex address, "native"/"ETH", or searches by symbol via Token API.
 */
export async function resolveTokenAddress(input: string, chainId: number): Promise<Address> {
  if (isNativeTokenInput(input)) {
    return NATIVE_TOKEN_ADDRESS;
  }

  if (isAddress(input)) {
    return getAddress(input);
  }

  // Search by symbol via Token API — whitelisted first, then broader fallback
  const client = getKyberTokenApiClient();
  let tokens = await client.searchTokens(String(chainId), {
    name: input,
    isWhitelisted: true,
    pageSize: 1,
  });

  if (tokens.length === 0) {
    tokens = await client.searchTokens(String(chainId), {
      name: input,
      pageSize: 5,
    });
  }

  if (tokens.length === 0) {
    throw new VexError(
      ErrorCodes.KYBER_TOKEN_NOT_FOUND,
      `Token "${input}" not found on chain ${chainId}`,
      "Provide a token address or try a different symbol.",
    );
  }

  return getAddress(tokens[0].address);
}

function pickBestTokenMatch(tokens: KyberToken[], input: string, exactAddress?: Address): KyberToken | null {
  if (tokens.length === 0) return null;

  if (exactAddress) {
    return tokens.find((token) => token.address.toLowerCase() === exactAddress.toLowerCase()) ?? null;
  }

  const lower = input.toLowerCase();
  return tokens.find((token) => token.symbol.toLowerCase() === lower)
    ?? tokens.find((token) => token.name.toLowerCase() === lower)
    ?? tokens[0];
}

/**
 * Resolve a token into metadata required for amount parsing.
 *
 * For native tokens we use the aggregator sentinel address and the standard
 * 18-decimal EVM denomination expected by the API.
 */
export async function resolveTokenMetadata(input: string, chainId: number): Promise<ResolvedKyberTokenMetadata> {
  // Native token — keyword OR sentinel address. Must precede the generic
  // `isAddress` branch so the sentinel is not read as an ERC-20 contract.
  if (isNativeTokenInput(input)) {
    return nativeTokenMetadata(chainId);
  }

  // Address input → read metadata directly from chain (authoritative for decimals/symbol/name)
  if (isAddress(input)) {
    const slug = chainIdToSlug(chainId);
    if (!slug) {
      throw new VexError(
        ErrorCodes.KYBER_TOKEN_NOT_FOUND,
        `Cannot resolve chain slug for chainId ${chainId}`,
      );
    }
    return readErc20Metadata(slug, getAddress(input));
  }

  // Symbol input → Token API search, whitelisted first, then broader fallback
  const client = getKyberTokenApiClient();
  let tokens = await client.searchTokens(String(chainId), {
    name: input,
    isWhitelisted: true,
    pageSize: 10,
  });
  let match = pickBestTokenMatch(tokens, input);

  if (!match) {
    tokens = await client.searchTokens(String(chainId), {
      name: input,
      pageSize: 10,
    });
    match = pickBestTokenMatch(tokens, input);
  }

  if (!match) {
    throw new VexError(
      ErrorCodes.KYBER_TOKEN_NOT_FOUND,
      `Token "${input}" not found on chain ${chainId}`,
      "Provide a token address or try a different symbol.",
    );
  }

  return {
    address: getAddress(match.address),
    symbol: match.symbol,
    name: match.name,
    decimals: match.decimals,
    isNative: false,
  };
}

/**
 * Strict token metadata resolver — address-only for mutating operations.
 *
 * Rejects symbol/name inputs to prevent ambiguous resolution (e.g. "USDC"
 * resolving to axlUSDC instead of native USDC). Symbols must be resolved
 * via khalani.tokens.search BEFORE calling mutating swap/order tools.
 */
export async function resolveTokenMetadataStrict(input: string, chainId: number): Promise<ResolvedKyberTokenMetadata> {
  // Native token — keyword OR sentinel address. The sentinel is a valid address
  // but is NOT an ERC-20, so it must resolve to native here rather than fall
  // through to an on-chain ERC-20 metadata read.
  if (isNativeTokenInput(input)) {
    return nativeTokenMetadata(chainId);
  }

  if (!isAddress(input)) {
    throw new VexError(
      ErrorCodes.KYBER_TOKEN_NOT_FOUND,
      `Token "${input}" is not a valid address. Resolve token addresses via khalani.tokens.search before calling mutating tools.`,
      "Pass the exact contract address, not a symbol or name.",
    );
  }

  const slug = chainIdToSlug(chainId);
  if (!slug) {
    throw new VexError(
      ErrorCodes.KYBER_TOKEN_NOT_FOUND,
      `Cannot resolve chain slug for chainId ${chainId}`,
    );
  }
  return readErc20Metadata(slug, getAddress(input));
}
