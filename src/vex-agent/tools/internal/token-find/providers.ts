import { DEXSCREENER_RESOLVE_HANDLERS } from "../../protocols/dexscreener/handlers/resolve.js";
import type { ToolResult } from "../../types.js";
import type { InternalToolContext } from "../types.js";
import { tokenFindProtocolContext } from "./context.js";
import { isRecord } from "./projection.js";
import type { ProviderCandidate } from "./types.js";

const LOCAL_SEARCH_LIMIT = 30;

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function nullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function parseKhalaniTokenFindCandidates(
  result: ToolResult,
  requestedChainIds: ReadonlySet<number> | null,
): {
  readonly candidates: readonly ProviderCandidate[];
  readonly rowsOutsideRequestedChains: number;
  readonly malformedRows: number;
  readonly duplicateRows: number;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.output);
  } catch {
    return {
      candidates: [],
      rowsOutsideRequestedChains: 0,
      malformedRows: 1,
      duplicateRows: 0,
    };
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.tokens)) {
    return {
      candidates: [],
      rowsOutsideRequestedChains: 0,
      malformedRows: 1,
      duplicateRows: 0,
    };
  }
  const candidates = new Map<string, ProviderCandidate>();
  let rowsOutsideRequestedChains = 0;
  let malformedRows = 0;
  let duplicateRows = 0;
  for (const token of parsed.tokens) {
    if (!isRecord(token)) {
      malformedRows += 1;
      continue;
    }
    const address = nullableString(token.address);
    const chainId = nullableNumber(token.chainId);
    if (address === null || chainId === null || !Number.isInteger(chainId)) {
      malformedRows += 1;
      continue;
    }
    if (requestedChainIds !== null && !requestedChainIds.has(chainId)) {
      rowsOutsideRequestedChains += 1;
      continue;
    }
    const key = `${chainId}:${address.toLocaleLowerCase()}`;
    if (candidates.has(key)) {
      duplicateRows += 1;
      continue;
    }
    candidates.set(key, {
      address,
      chainId,
      provider: "khalani",
      providerName: nullableString(token.name),
      providerSymbol: nullableString(token.symbol),
      providerDecimals: nullableNumber(token.decimals),
      pairEvidence: [],
    });
  }
  return {
    candidates: [...candidates.values()],
    rowsOutsideRequestedChains,
    malformedRows,
    duplicateRows,
  };
}

function providerQueryMatches(
  query: string,
  address: string,
  symbol: string | null,
  name: string | null,
): boolean {
  const normalized = query.trim().toLocaleLowerCase();
  if (address.toLocaleLowerCase() === normalized) return true;
  const terms = normalized.split(/\s+/u).filter(Boolean);
  const fields = [symbol, name]
    .filter((value): value is string => value !== null)
    .map((value) => value.toLocaleLowerCase());
  return terms.some((term) => fields.some((field) => field.includes(term)));
}

export function parseDexScreenerTokenFindCandidates(
  result: ToolResult,
  chainId: number,
  query: string,
): {
  readonly candidates: readonly ProviderCandidate[];
  readonly providerReturned: number;
  readonly rowsWithoutAttributableToken: number;
  readonly malformedRows: number;
  readonly providerCapped: boolean;
} {
  const rows = Array.isArray(result.data?.rows) ? result.data.rows : [];
  const byAddress = new Map<string, ProviderCandidate>();
  let rowsWithoutAttributableToken = 0;
  let malformedRows = 0;

  for (const row of rows) {
    if (!isRecord(row)) {
      malformedRows += 1;
      continue;
    }
    const pairAddress = nullableString(row.pairAddress);
    const dexId = nullableString(row.dexId);
    const baseAddress = nullableString(row.baseTokenAddress);
    const quoteAddress = nullableString(row.quoteTokenAddress);
    if (pairAddress === null || dexId === null || baseAddress === null) {
      malformedRows += 1;
      continue;
    }
    const sides = [
      {
        side: "base",
        address: baseAddress,
        symbol: nullableString(row.baseTokenSymbol),
        name: nullableString(row.baseTokenName),
        decimals: nullableNumber(row.baseTokenDecimals),
      },
      ...(quoteAddress === null
        ? []
        : [{
            side: "quote",
            address: quoteAddress,
            symbol: nullableString(row.quoteTokenSymbol),
            name: null,
            decimals: nullableNumber(row.quoteTokenDecimals),
          }]),
    ] as const;
    const matching = sides.filter((side) =>
      providerQueryMatches(query, side.address, side.symbol, side.name)
    );
    if (matching.length === 0) {
      rowsWithoutAttributableToken += 1;
      continue;
    }
    for (const side of matching) {
      const key = side.address.toLocaleLowerCase();
      const evidence = { pairAddress, dexId, side: side.side };
      const existing = byAddress.get(key);
      if (existing) {
        byAddress.set(key, {
          ...existing,
          pairEvidence: [...existing.pairEvidence, evidence],
        });
        continue;
      }
      byAddress.set(key, {
        address: side.address,
        chainId,
        provider: "dexscreener",
        providerName: side.name,
        providerSymbol: side.symbol,
        providerDecimals: side.decimals,
        pairEvidence: [evidence],
      });
    }
  }

  return {
    candidates: [...byAddress.values()],
    providerReturned: rows.length,
    rowsWithoutAttributableToken,
    malformedRows,
    providerCapped: result.data?.providerCapped === true,
  };
}

export async function executeDexScreenerTokenFindSearch(
  query: string,
  chainSlug: string,
  context: InternalToolContext,
): Promise<ToolResult> {
  const handler = DEXSCREENER_RESOLVE_HANDLERS["dexscreener.search"];
  if (!handler) throw new Error("Missing dexscreener.search handler.");
  return await handler(
    { query, chain: chainSlug, limit: LOCAL_SEARCH_LIMIT, fields: "identity" },
    tokenFindProtocolContext(context),
  );
}
