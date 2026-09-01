/**
 * Low-level Jupiter Tokens API V2 client.
 * Source-of-truth for token metadata and discovery endpoints.
 */

import { fetchJson } from "../../../../utils/http.js";
import { JUPITER_TOKENS_V2_BASE_URL, type JupiterMintInformation, type JupiterTokenCategoryParams, type JupiterTokenSearchParams, type JupiterTokenTag } from "./types.js";
import { jupiterMintInformationListSchema } from "./schemas.js";
import { getJupiterTokensHeaders, normalizeMintList, requireJupiterTokensApiKey, validateJupiterMintList, validateJupiterTokenCategoryParams, validateJupiterTokenSearchParams, validateJupiterTokenTag } from "./validation.js";

function toQueryString(query: Record<string, string>): string {
  return new URLSearchParams(query).toString();
}

export async function jupiterTokenSearch(params: JupiterTokenSearchParams): Promise<JupiterMintInformation[]> {
  requireJupiterTokensApiKey();
  validateJupiterTokenSearchParams(params);

  return fetchJson<JupiterMintInformation[]>(
    `${JUPITER_TOKENS_V2_BASE_URL}/search?${toQueryString({ query: params.query })}`,
    { headers: getJupiterTokensHeaders() },
    jupiterMintInformationListSchema,
  );
}

export async function jupiterTokensByMint(
  mints: string[],
  /**
   * The caller's cancellation, forwarded to the HTTP request. Absent means "no
   * cancellation", never "cancelled".
   */
  signal?: AbortSignal,
): Promise<JupiterMintInformation[]> {
  requireJupiterTokensApiKey();

  const normalizedMints = validateJupiterMintList(mints, 100, "mints");

  return fetchJson<JupiterMintInformation[]>(
    `${JUPITER_TOKENS_V2_BASE_URL}/search?${toQueryString({ query: normalizeMintList(normalizedMints) })}`,
    { headers: getJupiterTokensHeaders(), ...(signal ? { signal } : {}) },
    jupiterMintInformationListSchema,
  );
}

export async function jupiterTokensByTag(tag: JupiterTokenTag): Promise<JupiterMintInformation[]> {
  requireJupiterTokensApiKey();

  return fetchJson<JupiterMintInformation[]>(
    `${JUPITER_TOKENS_V2_BASE_URL}/tag?${toQueryString({ query: validateJupiterTokenTag(tag) })}`,
    { headers: getJupiterTokensHeaders() },
    jupiterMintInformationListSchema,
  );
}

export async function jupiterTokensByCategory(
  params: JupiterTokenCategoryParams,
): Promise<JupiterMintInformation[]> {
  requireJupiterTokensApiKey();
  const validated = validateJupiterTokenCategoryParams(params);
  const query = validated.limit != null ? `?${toQueryString({ limit: String(validated.limit) })}` : "";

  return fetchJson<JupiterMintInformation[]>(
    `${JUPITER_TOKENS_V2_BASE_URL}/${validated.category}/${validated.interval}${query}`,
    { headers: getJupiterTokensHeaders() },
    jupiterMintInformationListSchema,
  );
}

export async function jupiterRecentTokens(): Promise<JupiterMintInformation[]> {
  requireJupiterTokensApiKey();

  return fetchJson<JupiterMintInformation[]>(
    `${JUPITER_TOKENS_V2_BASE_URL}/recent`,
    { headers: getJupiterTokensHeaders() },
    jupiterMintInformationListSchema,
  );
}
