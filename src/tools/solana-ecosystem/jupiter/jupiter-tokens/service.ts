/**
 * High-level Jupiter Tokens API V2 service.
 * Preserves full wire responses and adds token-resolution helpers for Jupiter shelves.
 */

import { VexError, ErrorCodes } from "../../../../errors.js";
import { cacheSolanaTokens, getCachedSolanaToken } from "../../shared/solana-token-cache.js";
import { getWellKnownSolanaTokenByMint, getWellKnownSolanaTokenBySymbol } from "../../shared/solana-constants.js";
import { looksLikeMintQuery } from "./validation.js";
import {
  jupiterRecentTokens,
  jupiterTokenSearch,
  jupiterTokensByCategory,
  jupiterTokensByMint,
  jupiterTokensByTag,
} from "./client.js";
import {
  jupiterMintInformationToMetadata,
  jupiterMintInformationToSafety,
  type JupiterMintInformation,
  type JupiterResolvedToken,
  type JupiterTokenCategoryParams,
  type JupiterTokenSafety,
  type JupiterTokenTag,
} from "./types.js";
import type { TokenMetadata } from "../../shared/types.js";

function preferBestTokenMatch(query: string, tokens: JupiterMintInformation[]): JupiterMintInformation | undefined {
  const normalizedQuery = query.toLowerCase();

  const byExactMint = tokens.find((token) => token.id === query);
  if (byExactMint) return byExactMint;

  const byExactSymbol = tokens.find((token) => token.symbol.toLowerCase() === normalizedQuery);
  if (byExactSymbol) return byExactSymbol;

  const byExactName = tokens.find((token) => token.name.toLowerCase() === normalizedQuery);
  if (byExactName) return byExactName;

  return tokens[0];
}

function cacheMintInformation(tokens: JupiterMintInformation[]): void {
  cacheSolanaTokens(tokens.map(jupiterMintInformationToMetadata));
}

export async function searchJupiterTokens(query: string): Promise<JupiterMintInformation[]> {
  return jupiterTokenSearch({ query });
}

export async function getJupiterTokensByMint(
  mints: string[],
  /** The caller's cancellation, forwarded to the provider request. */
  signal?: AbortSignal,
): Promise<JupiterMintInformation[]> {
  return jupiterTokensByMint(mints, signal);
}

export async function getJupiterTokensByTag(tag: JupiterTokenTag): Promise<JupiterMintInformation[]> {
  return jupiterTokensByTag(tag);
}

export async function getJupiterTokensByCategory(
  params: JupiterTokenCategoryParams,
): Promise<JupiterMintInformation[]> {
  return jupiterTokensByCategory(params);
}

export async function getJupiterRecentTokens(): Promise<JupiterMintInformation[]> {
  return jupiterRecentTokens();
}

export async function resolveJupiterToken(
  query: string,
): Promise<TokenMetadata | undefined> {
  const resolved = await resolveJupiterTokenWithSafety(query);
  return resolved?.token;
}

/**
 * Resolve a token query to base metadata plus its per-token safety block when
 * the resolution path carries one. Well-known and cache hits return no safety
 * (they only have base metadata); the token API path lifts `audit` +
 * verification signals off the same `JupiterMintInformation` already fetched —
 * no extra network round-trip. The `safety` block is kept separate from the
 * base `TokenMetadata` so it never leaks onto token objects returned by build,
 * execute, price, or transfer paths.
 */
export async function resolveJupiterTokenWithSafety(
  query: string,
): Promise<{ token: TokenMetadata; safety?: JupiterTokenSafety } | undefined> {
  const wellKnown = looksLikeMintQuery(query)
    ? getWellKnownSolanaTokenByMint(query)
    : getWellKnownSolanaTokenBySymbol(query);
  if (wellKnown) return { token: wellKnown };

  const cached = getCachedSolanaToken(query);
  if (cached) return { token: cached };

  const results = looksLikeMintQuery(query)
    ? await jupiterTokensByMint([query])
    : await jupiterTokenSearch({ query });

  if (results.length === 0) return undefined;

  cacheMintInformation(results);
  const match = preferBestTokenMatch(query, results) ?? results[0];
  const safety = jupiterMintInformationToSafety(match);
  return safety
    ? { token: jupiterMintInformationToMetadata(match), safety }
    : { token: jupiterMintInformationToMetadata(match) };
}

export async function resolveJupiterTokens(queries: string[]): Promise<Map<string, TokenMetadata>> {
  const resolved = new Map<string, TokenMetadata>();
  const pendingMints: string[] = [];
  const pendingSymbols: string[] = [];

  for (const query of queries) {
    const wellKnown = looksLikeMintQuery(query)
      ? getWellKnownSolanaTokenByMint(query)
      : getWellKnownSolanaTokenBySymbol(query);
    if (wellKnown) {
      resolved.set(query, wellKnown);
      continue;
    }

    const cached = getCachedSolanaToken(query);
    if (cached) {
      resolved.set(query, cached);
      continue;
    }

    if (looksLikeMintQuery(query)) {
      pendingMints.push(query);
    } else {
      pendingSymbols.push(query);
    }
  }

  if (pendingMints.length > 0) {
    const mintResults = await jupiterTokensByMint(pendingMints);
    cacheMintInformation(mintResults);
    for (const mint of pendingMints) {
      const token = mintResults.find((item) => item.id === mint);
      if (token) {
        resolved.set(mint, jupiterMintInformationToMetadata(token));
      }
    }
  }

  for (const symbol of pendingSymbols) {
    const token = await resolveJupiterToken(symbol);
    if (token) {
      resolved.set(symbol, token);
    }
  }

  return resolved;
}

export async function requireJupiterResolvedToken(
  query: string,
): Promise<TokenMetadata> {
  const token = await resolveJupiterToken(query);
  if (!token) {
    throw tokenNotFound(query);
  }

  return token;
}

/**
 * Like `requireJupiterResolvedToken` but also returns the optional per-token
 * safety block (kept separate from the base metadata). Used by the swap quote
 * path so it can surface risk under `quote.safety` without leaking `safety`
 * onto the base token objects.
 */
export async function requireJupiterResolvedTokenWithSafety(
  query: string,
): Promise<{ token: TokenMetadata; safety?: JupiterTokenSafety }> {
  const resolved = await resolveJupiterTokenWithSafety(query);
  if (!resolved) {
    throw tokenNotFound(query);
  }

  return resolved;
}

function tokenNotFound(query: string): VexError {
  return new VexError(
    ErrorCodes.SOLANA_TOKEN_NOT_FOUND,
    `Token not found: ${query}`,
    "Use a mint address or check the token symbol spelling.",
  );
}

export function withResolvedToken(token: JupiterMintInformation): JupiterResolvedToken {
  return {
    token,
    metadata: jupiterMintInformationToMetadata(token),
  };
}
