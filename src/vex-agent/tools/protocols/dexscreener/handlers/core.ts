/**
 * The four market-data handlers — `search`, `pairs`, `tokens`, `tokenPairs`.
 *
 * All four are thin: they resolve required identity params, call the client, and
 * hand the provider window to the shared list pipeline in `../pair-list/`, which
 * owns param validation, filtering with drop accounting, sorting, windowing, the
 * `AgentDexPair` projection and the provenance envelope. Everything agent-facing
 * about a pair list is defined there, once, so a filter and a sort cannot
 * disagree about what "24 h volume" means and `limit` cannot mean two things in
 * two handlers.
 */

import { getDexScreenerClient } from "@tools/dexscreener/client.js";
import type { DexPair } from "@tools/dexscreener/types.js";
import { getKyberChains } from "@tools/kyberswap/chains.js";
import type { ProtocolHandler } from "../../types.js";
import { str, ok, fail } from "../../handler-helpers.js";
import { readStringOrArrayParam } from "../list-core/index.js";
import {
  SEARCH_PROVIDER_RELEVANCE_NOTE,
  assessCrossPoolPrices,
  buildPairList,
  buildPairListFromRows,
  parsePairListQuery,
  toPairRows,
} from "../pair-list/index.js";
import {
  reconcilePairBatchAddresses,
  reconcileTokenBatchAddresses,
  splitRequestedAddresses,
} from "../token-batch-addresses.js";
import { missingRequired } from "./missing-params.js";
import { resolveDexScreenerChain } from "../chain-param.js";
import {
  combinedSourceObservation,
  sourceObservation,
} from "./source-observation.js";

const DEXSCREENER_ADDRESS_BATCH_SIZE = 30;
const MAX_BATCH_ADDRESSES = 60;
const KNOWN_EVM_CHAIN_SLUGS: ReadonlySet<string> = new Set(
  getKyberChains().map((chain) => chain.slug),
);
const EVM_ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

function caseSensitiveAddresses(chain: string, addresses: readonly string[] = []): boolean {
  // Case-fold only chains positively identified by the local EVM registry.
  // A canonical 20-byte 0x address also positively identifies EVM semantics
  // when DexScreener knows an EVM chain that Vex's execution registry does not.
  // Unknown foreign formats (TON/base64url, Solana/base58, etc.) preserve case.
  return !KNOWN_EVM_CHAIN_SLUGS.has(chain.toLowerCase())
    && !(
      addresses.length > 0
      && addresses.every((address) => EVM_ADDRESS_PATTERN.test(address))
    );
}

function uniqueAddresses(addresses: readonly string[], caseSensitive: boolean): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const address of addresses) {
    const identity = caseSensitive ? address : address.toLowerCase();
    if (seen.has(identity)) continue;
    seen.add(identity);
    result.push(address);
  }
  return result;
}

function chunks<T>(values: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let offset = 0; offset < values.length; offset += size) {
    result.push(values.slice(offset, offset + size));
  }
  return result;
}

interface AddressBatchOutcome<T> {
  fulfilled: T[];
  /** Addresses whose batch FAILED: the provider never answered for them. */
  unreachedAddresses: string[];
  failedBatchCount: number;
  firstFailureMessage: string | null;
}

/**
 * Dispatch every batch and keep what succeeded. `Promise.all` here made a
 * partially successful multi-batch call a total failure: one 429 on batch 2
 * discarded batch 1's priced rows and reported nothing about which addresses
 * were never asked. Failed batches are accounted per address instead.
 */
async function runAddressBatches<T>(
  batches: readonly string[][],
  run: (batch: readonly string[]) => Promise<T>,
): Promise<AddressBatchOutcome<T>> {
  const settled = await Promise.allSettled(batches.map((batch) => run(batch)));
  const outcome: AddressBatchOutcome<T> = {
    fulfilled: [],
    unreachedAddresses: [],
    failedBatchCount: 0,
    firstFailureMessage: null,
  };
  settled.forEach((result, index) => {
    if (result.status === "fulfilled") {
      outcome.fulfilled.push(result.value);
      return;
    }
    outcome.failedBatchCount += 1;
    outcome.unreachedAddresses.push(...(batches[index] ?? []));
    if (outcome.firstFailureMessage === null) {
      outcome.firstFailureMessage = result.reason instanceof Error
        ? result.reason.message
        : String(result.reason);
    }
  });
  return outcome;
}

/**
 * Split "requested and not returned" into its two different truths: addresses
 * the provider answered without (unresolved - likely unindexed) and addresses
 * whose batch failed (unreached - a transport fact, retryable). Reporting the
 * second group as the first would read "not indexed" where the truth is
 * "never asked".
 */
function partitionUnreached(
  unresolved: readonly string[],
  unreached: readonly string[],
  caseSensitive: boolean,
): { unresolved: string[]; unreached: string[] } {
  const identity = (address: string): string => (caseSensitive ? address : address.toLowerCase());
  const unreachedIdentities = new Set(unreached.map(identity));
  return {
    unresolved: unresolved.filter((address) => !unreachedIdentities.has(identity(address))),
    unreached: unresolved.filter((address) => unreachedIdentities.has(identity(address))),
  };
}

function batchProviderNote(
  kind: "token" | "pair",
  requestedCount: number,
  batchCount: number,
  failedBatchCount: number,
  firstFailureMessage: string | null,
): string | undefined {
  if (batchCount <= 1 && failedBatchCount === 0) return undefined;
  const unreachedField = kind === "token" ? "unreachedAddresses" : "unreachedPairAddresses";
  const unresolvedField = kind === "token" ? "unresolvedAddresses" : "unresolvedPairAddresses";
  const split = `Vex split ${requestedCount} requested ${kind} addresses into ${batchCount} `
    + `DexScreener calls of at most ${DEXSCREENER_ADDRESS_BATCH_SIZE} addresses and merged the `
    + "completed responses.";
  return failedBatchCount === 0
    ? `${split} ${unresolvedField} were absent after every batch completed.`
    : `${split} ${failedBatchCount} of ${batchCount} batches FAILED `
      + `(${firstFailureMessage ?? "unknown cause"}); their addresses are listed in `
      + `${unreachedField} - the provider never answered for them, so retry those - while `
      + `${unresolvedField} were asked and not returned.`;
}

function dedupeProviderPairs(
  pairs: readonly DexPair[],
  caseSensitive: boolean,
): DexPair[] {
  const seen = new Set<string>();
  const result: DexPair[] = [];
  for (const pair of pairs) {
    const address = pair.pairAddress ?? "";
    const base = pair.baseToken?.address ?? "";
    const keyRaw = address !== "" ? `${pair.chainId ?? ""}:pair:${address}` : `${pair.chainId ?? ""}:base:${base}`;
    const key = caseSensitive ? keyRaw : keyRaw.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(pair);
  }
  return result;
}

interface SearchQueryMatch {
  side: "base" | "quote" | "pair" | "unknown";
  kind: "address" | "symbol" | "name" | "pair" | "unknown";
  tokenAddress: string | null;
}

function queryMatch(
  query: string,
  pair: DexPair,
): SearchQueryMatch {
  const caseSensitive = caseSensitiveAddresses(pair.chainId, [query]);
  const expected = caseSensitive ? query : query.toLowerCase();
  const matches = (candidate: string | null): boolean =>
    candidate !== null && (caseSensitive ? candidate : candidate.toLowerCase()) === expected;
  if (matches(pair.baseToken.address)) {
    return { side: "base", kind: "address", tokenAddress: pair.baseToken.address };
  }
  if (matches(pair.quoteToken.address)) {
    return { side: "quote", kind: "address", tokenAddress: pair.quoteToken.address };
  }
  if (matches(pair.pairAddress)) return { side: "pair", kind: "pair", tokenAddress: null };

  const expectedText = query.trim().toLowerCase();
  const textualMatches: Array<{ side: "base" | "quote"; kind: "symbol" | "name"; tokenAddress: string }> = [];
  for (const [side, token] of [["base", pair.baseToken], ["quote", pair.quoteToken]] as const) {
    if (typeof token.address !== "string") continue;
    if (typeof token.symbol === "string" && token.symbol.trim().toLowerCase() === expectedText) {
      textualMatches.push({ side, kind: "symbol", tokenAddress: token.address });
    } else if (typeof token.name === "string" && token.name.trim().toLowerCase() === expectedText) {
      textualMatches.push({ side, kind: "name", tokenAddress: token.address });
    }
  }
  const [onlyMatch] = textualMatches;
  return textualMatches.length === 1 && onlyMatch !== undefined
    ? onlyMatch
    : { side: "unknown", kind: "unknown", tokenAddress: null };
}

export const DEXSCREENER_CORE_HANDLERS: Record<string, ProtocolHandler> = {
  "dexscreener.search": async (p) => {
    const query = str(p, "query");
    const missing = missingRequired("dexscreener.search", { query });
    if (missing) return fail(missing);
    // DexScreener answers a 1-character query with HTTP 400 and an HTML body, so
    // the transport-level message would be an opaque "HTTP 400". Refuse first,
    // with the actual reason.
    if (query.trim().length < 2) {
      return fail(
        'dexscreener.search: "query" must be at least 2 characters — DexScreener rejects shorter '
        + "queries with an HTTP 400 it does not explain.",
      );
    }
    const parsed = parsePairListQuery(p, {
      sortBy: "relevance",
      allowChainFilter: true,
      limit: 5,
    });
    if (!parsed.ok) return fail(`dexscreener.search: ${parsed.reason}`);

    const client = getDexScreenerClient();
    const result = await client.search(query);
    const asOfMs = Date.now();
    const list = buildPairList({
      endpoint: "/latest/dex/search",
      providerOrder: "relevance",
      providerPairs: Array.isArray(result.pairs) ? result.pairs : [],
      query: parsed.query,
      asOfMs,
    });
    const providerByIdentity = new Map(
      (Array.isArray(result.pairs) ? result.pairs : []).map((pair) => [
        `${pair.chainId}:${pair.pairAddress}`,
        pair,
      ] as const),
    );
    for (const pair of list.pairs) {
      const providerPair = providerByIdentity.get(`${pair.chainId}:${pair.pairAddress ?? ""}`);
      const match = providerPair === undefined
        ? { side: "unknown", kind: "unknown", tokenAddress: null } as const
        : queryMatch(query.trim(), providerPair);
      pair.queryMatchSide = match.side;
      pair.queryMatchKind = match.kind;
      pair.queryMatchedTokenAddress = match.tokenAddress;
    }

    return ok({
      query,
      // Normalised lowercase: the previous handler echoed the caller's `"BASE"`
      // while every row it returned said `"base"`, so the echo disagreed with
      // the data it described.
      chainIds: parsed.query.filters.chainIds,
      providerRelevanceNote: SEARCH_PROVIDER_RELEVANCE_NOTE,
      sourceObservation: sourceObservation(client, result, asOfMs),
      ...list,
    });
  },

  // `chain` (W6a: was `chainId`, a key that said Id over a slug value) is echoed
  // lowercase on the three single-chain tools so the echo agrees with the rows
  // (every provider row carries a lowercase slug). The value sent UPSTREAM is a
  // slug exactly as the caller wrote it — only the numeric spelling is
  // translated, by `../chain-param.ts`; normalising a slug would change what we
  // ask DexScreener, which is not this card's call to make.
  // Token and pair addresses are never case-folded: Solana base58 is
  // case-sensitive and folding one would corrupt an identifier.
  "dexscreener.pairs": async (p) => {
    const chainRaw = str(p, "chain");
    // A comma string OR an array of addresses — one canonical comma-string
    // downstream, so the upstream request and the `requestedPairAddresses` echo
    // cannot disagree about what was asked for.
    const pairAddressRead = readStringOrArrayParam(p, "pairAddress");
    if (!pairAddressRead.ok) return fail(`dexscreener.pairs: ${pairAddressRead.reason}`);
    const pairAddress = pairAddressRead.value ?? "";
    const missing = missingRequired("dexscreener.pairs", { chain: chainRaw, pairAddress });
    if (missing) return fail(missing);
    const chain = resolveDexScreenerChain(chainRaw);
    if (!chain.ok) return fail(`dexscreener.pairs: ${chain.reason}`);
    const parsed = parsePairListQuery(p, { sortBy: "relevance", limit: null });
    if (!parsed.ok) return fail(`dexscreener.pairs: ${parsed.reason}`);
    const requestedPairs = splitRequestedAddresses(pairAddress);
    if (requestedPairs.length === 0) {
      return fail("dexscreener.pairs: pairAddress must contain at least one address.");
    }
    if (requestedPairs.length > MAX_BATCH_ADDRESSES) {
      return fail(
        `dexscreener.pairs: at most ${MAX_BATCH_ADDRESSES} pair addresses are accepted per tool `
        + `call; received ${requestedPairs.length}. Split larger lists into separate calls.`,
      );
    }

    const client = getDexScreenerClient();
    const addressCaseSensitive = caseSensitiveAddresses(chain.slug, requestedPairs);
    const pairBatches = chunks(
      uniqueAddresses(requestedPairs, addressCaseSensitive),
      DEXSCREENER_ADDRESS_BATCH_SIZE,
    );
    const batchOutcome = await runAddressBatches(
      pairBatches,
      (batch) => client.getPairs(chain.slug, batch.join(",")),
    );
    if (batchOutcome.fulfilled.length === 0) {
      return fail(
        `dexscreener.pairs: every DexScreener batch failed - `
        + `${batchOutcome.firstFailureMessage ?? "unknown cause"}`,
      );
    }
    const asOfMs = Date.now();
    const providerPairs = dedupeProviderPairs(
      batchOutcome.fulfilled.flatMap((response) => Array.isArray(response.pairs) ? response.pairs : []),
      addressCaseSensitive,
    );
    const addresses = reconcilePairBatchAddresses(
      pairAddress,
      providerPairs,
      addressCaseSensitive,
    );
    const partitioned = partitionUnreached(
      addresses.unresolvedPairAddresses,
      batchOutcome.unreachedAddresses,
      addressCaseSensitive,
    );
    const list = buildPairList({
      endpoint: "/latest/dex/pairs",
      providerOrder: "unspecified",
      providerPairs,
      query: parsed.query,
      asOfMs,
      providerCap: pairBatches.length > 1 ? null : undefined,
      providerNote: batchProviderNote(
        "pair",
        requestedPairs.length,
        pairBatches.length,
        batchOutcome.failedBatchCount,
        batchOutcome.firstFailureMessage,
      ),
    });

    return ok({
      chain: chain.slug.toLowerCase(),
      ...addresses,
      unresolvedPairAddresses: partitioned.unresolved,
      unreachedPairAddresses: partitioned.unreached,
      batchRequestCount: pairBatches.length,
      failedBatchCount: batchOutcome.failedBatchCount,
      maxAddressesPerRequest: DEXSCREENER_ADDRESS_BATCH_SIZE,
      sourceObservation: combinedSourceObservation(client, batchOutcome.fulfilled, asOfMs),
      ...list,
    });
  },

  "dexscreener.tokens": async (p) => {
    const chainRaw = str(p, "chain");
    // ONE canonical address list feeds BOTH the upstream call and the
    // requested/resolved/unresolved reconciliation, so the echo can never
    // describe a different list from the one we sent. Casing is preserved:
    // Solana base58 is case-sensitive and folding one would corrupt it.
    const tokenAddressesRead = readStringOrArrayParam(p, "tokenAddresses");
    if (!tokenAddressesRead.ok) return fail(`dexscreener.tokens: ${tokenAddressesRead.reason}`);
    const tokenAddresses = tokenAddressesRead.value ?? "";
    const missing = missingRequired("dexscreener.tokens", { chain: chainRaw, tokenAddresses });
    if (missing) return fail(missing);
    const chain = resolveDexScreenerChain(chainRaw);
    if (!chain.ok) return fail(`dexscreener.tokens: ${chain.reason}`);
    const parsed = parsePairListQuery(p, { sortBy: "relevance", limit: 15 });
    if (!parsed.ok) return fail(`dexscreener.tokens: ${parsed.reason}`);

    const requested = splitRequestedAddresses(tokenAddresses);
    if (requested.length === 0) {
      return fail("dexscreener.tokens: tokenAddresses must contain at least one address.");
    }
    if (requested.length > MAX_BATCH_ADDRESSES) {
      return fail(
        `dexscreener.tokens: at most ${MAX_BATCH_ADDRESSES} token addresses are accepted `
        + `per tool call; received ${requested.length}. Split the portfolio into smaller calls.`,
      );
    }

    const client = getDexScreenerClient();
    const addressCaseSensitive = caseSensitiveAddresses(chain.slug, requested);
    const batches = chunks(
      uniqueAddresses(requested, addressCaseSensitive),
      DEXSCREENER_ADDRESS_BATCH_SIZE,
    );
    const batchOutcome = await runAddressBatches(
      batches,
      (batch) => client.getTokens(chain.slug, batch.join(",")),
    );
    if (batchOutcome.fulfilled.length === 0) {
      return fail(
        `dexscreener.tokens: every DexScreener batch failed - `
        + `${batchOutcome.firstFailureMessage ?? "unknown cause"}`,
      );
    }
    const asOfMs = Date.now();
    const result = dedupeProviderPairs(batchOutcome.fulfilled.flat(), addressCaseSensitive);
    // Reconciled against the PROVIDER's rows, before any Vex filter — otherwise
    // our own filtering would be indistinguishable from the provider dropping
    // addresses (40 requested → 30 returned, measured).
    const addresses = reconcileTokenBatchAddresses(
      tokenAddresses,
      result,
      addressCaseSensitive,
      batches.length,
    );
    const partitioned = partitionUnreached(
      addresses.unresolvedAddresses,
      batchOutcome.unreachedAddresses,
      addressCaseSensitive,
    );
    const list = buildPairList({
      endpoint: "/tokens/v1",
      providerOrder: "unspecified",
      providerPairs: result,
      query: parsed.query,
      asOfMs,
      providerCap: batches.length > 1 ? null : undefined,
      providerNote: batchProviderNote(
        "token",
        requested.length,
        batches.length,
        batchOutcome.failedBatchCount,
        batchOutcome.firstFailureMessage,
      ),
    });

    return ok({
      chain: chain.slug.toLowerCase(),
      ...addresses,
      unresolvedAddresses: partitioned.unresolved,
      unreachedAddresses: partitioned.unreached,
      failedBatchCount: batchOutcome.failedBatchCount,
      sourceObservation: combinedSourceObservation(client, batchOutcome.fulfilled, asOfMs),
      ...list,
    });
  },

  "dexscreener.tokenPairs": async (p) => {
    const chainRaw = str(p, "chain"), tokenAddress = str(p, "tokenAddress");
    const missing = missingRequired("dexscreener.tokenPairs", { chain: chainRaw, tokenAddress });
    if (missing) return fail(missing);
    const chain = resolveDexScreenerChain(chainRaw);
    if (!chain.ok) return fail(`dexscreener.tokenPairs: ${chain.reason}`);
    const parsed = parsePairListQuery(p, { sortBy: "liquidityUsd", limit: 15 });
    if (!parsed.ok) return fail(`dexscreener.tokenPairs: ${parsed.reason}`);

    const client = getDexScreenerClient();
    const result = await client.getTokenPairs(chain.slug, tokenAddress);
    const asOfMs = Date.now();
    const observation = sourceObservation(client, result, asOfMs);

    // Cross-pool sanity over the FULL provider window: this is the one tool
    // whose rows are all pools of the same token, so a median price is
    // meaningful — and a single pool's `priceUsd` can be thousands of times
    // wrong while its liquidity/marketCap inherit the error.
    const rows = toPairRows(result, asOfMs);
    const priceSanity = assessCrossPoolPrices(rows, {
      tokenAddress,
      caseSensitiveAddress: caseSensitiveAddresses(chain.slug, [tokenAddress]),
    });
    const list = buildPairListFromRows(rows, {
      endpoint: "/token-pairs/v1",
      providerOrder: "unspecified",
      providerPairs: result,
      query: parsed.query,
      asOfMs,
      priceSanity,
    });

    return ok({
      chain: chain.slug.toLowerCase(),
      tokenAddress,
      sourceObservation: observation,
      // ONE name for the median. The pre-batching field `priceUsdMedianAcrossPools`
      // measured the BASE-token median; this value is the REQUESTED-token median,
      // so keeping the old key pointed at the new meaning would invite comparing
      // row.priceUsd (base) against a requested-token median - a false outlier
      // verdict on every quote-side pool.
      requestedTokenPriceUsdMedianAcrossPools: priceSanity.priceUsdMedianAcrossPools,
      pricePoolOutliers: priceSanity.pricePoolOutliers,
      ...list,
    });
  },
};
