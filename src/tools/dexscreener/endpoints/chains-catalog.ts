/**
 * The chains catalog: `https://dd.dexscreener.com/ds-data/v2/chains/by-trending`.
 *
 * Plain JSON (this host tells the truth about its content type, unlike
 * `io.dexscreener.com`). 74 chains, about 63 KB, `cache-control: max-age=10`
 * at the edge.
 *
 * WHY THIS MODULE EXISTS AT ALL: the screener channel fails OPEN on an unknown
 * chain slug. `filters[chainIds][0]=solanaa` returns HTTP 200 and
 * `pairsCount: 0`, which an agent reads as "nothing is trading there" rather
 * than "you misspelled the chain". Validating against this catalog first, and
 * answering a miss with the nearest real slugs, is the self-correction seam
 * that turns a silent wrong answer into a fixable one.
 *
 * LIFECYCLE OWNER: this module owns one `DexScreenerThrottle` for the catalog
 * and nothing else. The catalog is versioned by DexScreener deploys, not by
 * market movement, so it caches for 24 hours; the in-flight dedupe in the same
 * throttle means a burst of tool calls at startup costs one request.
 *
 * THE ORDER CARRIES NO MEANING AND NOTHING HERE MAY CLAIM IT DOES. The path is
 * `by-trending` and the provider does rank it, but the ranking is LIVE and it
 * drifts: two reads nine minutes apart were measured with 20+ adjacent
 * transpositions in the tail (near/hedera, linea/optimism, cardano/flare/
 * stacks), and each chain's own `dexes[]` is a second ranked list that churned
 * inside two minutes (polygon dfyn/fraxswap swapped). Membership is stable at
 * 74; ORDER is not. Behind a 24 hour local TTL a cached copy therefore hands
 * out an order that is up to a day old, so this module preserves the provider's
 * sequence as received and no consumer may read rank into it. The sibling
 * `/ds-data/v2/chains/by-txns` is a public, differently ranked view of the same
 * 74 members; it is not consumed because no tool has an ordering contract.
 *
 * TOLERANT WHERE THE FIELD IS DISPLAY, STRICT WHERE IT DECIDES. `slug`, `name`,
 * `dexes`, `blockExplorer` and `features` are present on all 74 chains and are
 * required. `architecture` is absent on 14 of 74 (ton, hyperliquid, tron, xrpl,
 * multiversx, starknet and others) and `integrations` on 5; requiring them
 * would reject real chains the screener serves, so they are nullable and a
 * missing value means "the catalog does not say", never a default. Unknown
 * extra fields are ignored: the provider adds keys without warning and a
 * catalog read must not start failing because of one.
 */

import {
  DexScreenerSiteErrorCodes,
  siteError,
} from "../site-errors.js";
import { DexScreenerThrottle } from "../throttle.js";
import type { DexScreenerTransport } from "../transport.js";

/** The catalog endpoint. The one URL this module is allowed to fetch. */
export const DEXSCREENER_CHAINS_CATALOG_URL =
  "https://dd.dexscreener.com/ds-data/v2/chains/by-trending";

/**
 * How long a fetched catalog stays fresh.
 *
 * The provider's own edge caches it for 10 seconds, which is a CDN concern.
 * The catalog's CONTENT changes when DexScreener adds a chain, which is a
 * deploy-scale event, so a day is the right local horizon and a stale entry
 * costs a slug that is not yet resolvable rather than a wrong number.
 */
export const CHAINS_CATALOG_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Byte ceiling for the catalog body. Measured at about 63 KB across 74 chains;
 * two megabytes leaves room for the catalog to triple and still bounds it.
 */
export const CHAINS_CATALOG_MAX_BYTES = 2_000_000;

/** At most this many nearest matches are offered for an unknown slug. */
export const CHAIN_SLUG_MAX_CANDIDATES = 5;

/* ------------------------------------------------------------------ */
/* Catalog shape                                                       */
/* ------------------------------------------------------------------ */

/**
 * Block explorer URL templates. Empty string in the catalog means "none".
 *
 * THE PLACEHOLDER NAME INSIDE A TEMPLATE DOES NOT IDENTIFY THE SLOT; THE FIELD
 * DOES. The provider spells its own placeholders inconsistently and the
 * mismatch runs in every direction, measured live 2026-08-25 across the 74
 * chains:
 *
 *  - `holdersURL` wants a TOKEN address on the 21 chains that spell it
 *    `{{txns}}` (bsc, base, ethereum, polygon and 17 more);
 *  - `taiko.holdersURL` and `oasissapphire.assetURL` spell the same token slot
 *    `{{token}}`;
 *  - `beam.assetURL` spells a token slot `{{address}}`;
 *  - `oasissapphire.txnsURL` spells a TRANSACTION HASH slot `{{address}}`;
 *  - and the LARGEST bucket of all, which is the one a reader would get wrong
 *    by trusting the name: `holdersURL` spells its TOKEN slot `{{address}}` on
 *    26 chains. `{{address}}` therefore means a token on those 26 plus beam, a
 *    transaction hash on oasissapphire, and a wallet nowhere on this surface.
 *
 * So substitute by the FIELD the template came from, never by the placeholder
 * text: `accountUrlTemplate` takes a wallet address, `assetUrlTemplate` and
 * `holdersUrlTemplate` take a token address, `txnsUrlTemplate` takes a
 * transaction hash. Reading the name instead builds a dead link.
 */
export interface ChainBlockExplorer {
  readonly accountUrlTemplate: string | null;
  readonly assetUrlTemplate: string | null;
  readonly txnsUrlTemplate: string | null;
  readonly holdersUrlTemplate: string | null;
}

/** One third-party integration as the catalog declares it. */
export interface ChainIntegration {
  readonly isEnabled: boolean;
  /**
   * The integration's own id for this chain, when it publishes one.
   *
   * NORMALISED TO A STRING, BECAUSE THE CATALOG SENDS BOTH SHAPES. Measured
   * live 2026-08-25 on the 74-chain document: `goPlus.networkId` arrives as a
   * JSON NUMBER on 22 chains (ethereum 1, bsc 56, base 8453, arbitrum 42161,
   * robinhood 4663, ...) and `tokenSniffer.networkId` as a number on 10, while
   * every other integration id is a string. Reading them as strings only
   * projected all 56 goPlus rows to null, which says "the catalog does not
   * publish an id here" about ids the catalog does publish.
   */
  readonly chainId: string | null;
  /**
   * The integration's OWN network id, kept even though nothing on this surface
   * reads it today.
   *
   * It is the value a caller would need to query GoPlus or TokenSniffer
   * directly, so it is the one field here with a use outside DexScreener, and
   * projecting it costs one string per integration. REMOVAL CONDITION: if no
   * consumer has appeared by the time this endpoint is next revised, drop it
   * rather than carrying an unread field indefinitely.
   */
  readonly networkId: string | null;
}

/*
 * DECLARED OMISSION on the catalog row: `isChainAndDEX`.
 *
 * Present on the wire and NOT projected. It is true on the handful of entries
 * that are their own venue (a chain whose only DEX is the chain), which is a
 * site-taxonomy label rather than a market fact: nothing on this surface routes
 * or filters on it, and `dexId` already carries the venue identity every tool
 * actually uses. It is named here so a reader comparing the wire to the
 * projection sees a declared omission rather than a dropped field.
 */

export interface ChainFeatures {
  /**
   * Whether the SITE surfaces a narratives page for this chain. A LABEL, NOT A
   * DATA GATE.
   *
   * True on solana, bsc, base and ethereum only, and it does NOT mean the
   * other 70 chains have no narratives: measured live 2026-08-25,
   * `/metas/v1/trending?chainId=robinhood` returned 7 real aggregates
   * (cat $253.8 M over 15 tokens) with `metasEnabled` false, and ton and
   * polygon aggregate too. Whether a chain has narrative activity is answered
   * by the narratives endpoint itself, which replies to a quiet chain with an
   * empty success; refusing on this flag hides reachable provider data behind
   * an assertion that the data does not exist.
   */
  readonly metasEnabled: boolean;
  /** Measured identical to `metasEnabled` on all 74 chains; never diverged. */
  readonly metasVisible: boolean;
}

export interface CatalogChain {
  readonly slug: string;
  readonly name: string;
  readonly shortName: string | null;
  /** `evm`, `svm`, `sui`, `aptos`, `cosmos`, or null when the catalog omits it. */
  readonly architecture: string | null;
  readonly nativeChainId: number | null;
  readonly wrappedNativeToken: string | null;
  readonly rpcUrl: string | null;
  readonly dexes: readonly string[];
  readonly blockExplorer: ChainBlockExplorer;
  /**
   * Declared integrations, by provider name.
   *
   * PRESENCE IS NOT COVERAGE. 56 chains declare a `goPlus` key while only 21
   * were measured to actually answer through pair details. A tool must take
   * coverage from the response it got, never from this map.
   */
  readonly integrations: Readonly<Record<string, ChainIntegration>>;
  readonly features: ChainFeatures;
}

export interface ChainsCatalog {
  readonly chains: readonly CatalogChain[];
  /** Slug to chain, for O(1) validation. */
  readonly bySlug: ReadonlyMap<string, CatalogChain>;
  readonly fetchedAtMs: number;
  readonly cacheHit: boolean;
  readonly cacheAgeMs: number;
}

export interface ChainsCatalogOptions {
  readonly transport: DexScreenerTransport;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}

/* ------------------------------------------------------------------ */
/* Fetch                                                               */
/* ------------------------------------------------------------------ */

/**
 * The catalog's own throttle: one token bucket, one TTL cache entry, one
 * in-flight slot. Module-scoped because the catalog is a process-wide fact,
 * not a per-call one.
 */
const catalogThrottle = new DexScreenerThrottle({ maxCacheEntries: 4 });

/**
 * Fetch the chains catalog, through the 24 hour cache.
 *
 * A headless caller CAN reach this one. `dd.dexscreener.com` is a site host by
 * ownership and not by gating (measured with Node's own `fetch` and no browser
 * impersonation: HTTP 200, 63,237 bytes), so it is on the default transport's
 * origin list and `chains_list` answers outside the desktop app. That matters
 * because this catalog is the vocabulary every chain parameter on the surface
 * is validated against, and it is the remedy every "unknown chain" refusal
 * names.
 *
 * A transport that still refuses the host raises its own typed
 * `SITE_TRANSPORT_UNAVAILABLE`, which says the remedy. That is deliberately
 * not caught here: "the catalog is unreachable from this process" and "the
 * catalog is malformed" are different facts and must stay different codes.
 */
export async function fetchChainsCatalog(
  options: ChainsCatalogOptions
): Promise<ChainsCatalog> {
  const observed = await catalogThrottle.runObserved(
    DEXSCREENER_CHAINS_CATALOG_URL,
    "slow",
    CHAINS_CATALOG_TTL_MS,
    async () => {
      const response = await options.transport.httpGet(
        DEXSCREENER_CHAINS_CATALOG_URL,
        {
          timeoutMs: options.timeoutMs,
          signal: options.signal,
          accept: "application/json",
          maxBytes: CHAINS_CATALOG_MAX_BYTES,
        }
      );
      if (response.status !== 200) {
        throw siteError(
          DexScreenerSiteErrorCodes.CATALOG_INVALID,
          `The DexScreener chains catalog answered HTTP ${response.status}`,
          "Retry; if it persists the catalog endpoint has moved and the chain vocabulary cannot be validated."
        );
      }
      return parseChainsCatalog(response.body);
    }
  );
  const chains = observed.value;
  return {
    chains,
    bySlug: new Map(chains.map((chain) => [chain.slug, chain])),
    fetchedAtMs: observed.fetchedAtMs,
    cacheHit: observed.cacheHit,
    cacheAgeMs: observed.cacheAgeMs,
  };
}

/**
 * Parse and validate the catalog body.
 *
 * Exported for tests and for any caller holding catalog bytes from elsewhere.
 * Every rejection names the chain and the field, because a catalog that stops
 * parsing must be diagnosable from the error alone.
 */
export function parseChainsCatalog(body: Uint8Array): readonly CatalogChain[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(body)) as unknown;
  } catch {
    throw siteError(
      DexScreenerSiteErrorCodes.CATALOG_INVALID,
      `The DexScreener chains catalog returned ${body.byteLength} bytes that are not JSON`,
      "The endpoint's format may have changed; the chain vocabulary cannot be validated until it is re-read."
    );
  }
  if (!Array.isArray(parsed)) {
    throw siteError(
      DexScreenerSiteErrorCodes.CATALOG_INVALID,
      "The DexScreener chains catalog is not a JSON array",
      "The endpoint's format may have changed; the chain vocabulary cannot be validated until it is re-read."
    );
  }
  return parsed.map((entry, index) => parseChain(entry, index));
}

function parseChain(entry: unknown, index: number): CatalogChain {
  const source = asObject(entry);
  if (source === null) {
    throw catalogFieldError(`entry ${index}`, "is not an object");
  }
  const slug = requiredString(source["slug"]);
  if (slug === null) {
    throw catalogFieldError(`entry ${index}`, 'has no "slug"');
  }
  const name = requiredString(source["name"]);
  if (name === null) {
    throw catalogFieldError(slug, 'has no "name"');
  }
  const dexes = source["dexes"];
  if (!Array.isArray(dexes)) {
    throw catalogFieldError(slug, 'has no "dexes" array');
  }
  const explorer = asObject(source["blockExplorer"]);
  if (explorer === null) {
    throw catalogFieldError(slug, 'has no "blockExplorer" object');
  }
  const features = asObject(source["features"]);
  if (features === null) {
    throw catalogFieldError(slug, 'has no "features" object');
  }
  const metas = asObject(features["metas"]);

  return {
    slug,
    name,
    shortName: optionalNonEmptyString(source["shortName"]),
    architecture: optionalNonEmptyString(source["architecture"]),
    nativeChainId:
      typeof source["nativeChainId"] === "number" &&
      Number.isSafeInteger(source["nativeChainId"])
        ? source["nativeChainId"]
        : null,
    wrappedNativeToken: optionalNonEmptyString(source["wrappedNativeToken"]),
    rpcUrl: optionalNonEmptyString(source["rpcURL"]),
    dexes: dexes.filter((dex): dex is string => typeof dex === "string"),
    blockExplorer: {
      accountUrlTemplate: optionalNonEmptyString(explorer["accountURL"]),
      assetUrlTemplate: optionalNonEmptyString(explorer["assetURL"]),
      txnsUrlTemplate: optionalNonEmptyString(explorer["txnsURL"]),
      holdersUrlTemplate: optionalNonEmptyString(explorer["holdersURL"]),
    },
    integrations: parseIntegrations(source["integrations"]),
    features: {
      metasEnabled: metas?.["isEnabled"] === true,
      metasVisible: metas?.["isVisible"] === true,
    },
  };
}

function parseIntegrations(
  value: unknown
): Readonly<Record<string, ChainIntegration>> {
  const source = asObject(value);
  if (source === null) return {};
  const result: Record<string, ChainIntegration> = {};
  for (const [key, raw] of Object.entries(source)) {
    const entry = asObject(raw);
    if (entry === null) continue;
    result[key] = {
      isEnabled: entry["isEnabled"] === true,
      chainId: optionalIntegrationId(entry["chainId"]),
      networkId: optionalIntegrationId(entry["networkId"]),
    };
  }
  return result;
}

/* ------------------------------------------------------------------ */
/* Slug resolution                                                     */
/* ------------------------------------------------------------------ */

export interface UnknownChainSlug {
  /** The slug the caller asked for, verbatim. */
  readonly value: string;
  /**
   * The nearest real slugs, best first, at most
   * `CHAIN_SLUG_MAX_CANDIDATES`.
   */
  readonly candidates: readonly string[];
  /**
   * How many slugs in the catalog were near enough to offer. When it exceeds
   * `candidates.length`, the rest were ranked lower and are reachable by
   * reading the catalog; nothing is hidden.
   */
  readonly candidateCount: number;
}

export interface ChainSlugResolution {
  /** The input slugs that exist, in input order, deduplicated. */
  readonly valid: readonly string[];
  /** The input slugs that do not exist, each with its nearest matches. */
  readonly unknown: readonly UnknownChainSlug[];
}

/**
 * Resolve chain slugs against the catalog.
 *
 * Pure: the catalog is passed in, so this is testable without a transport and
 * cannot fetch behind a caller's back. Matching is case-insensitive on input
 * because the site's own routes are lowercase and an agent quoting "Solana"
 * means `solana`; the returned `valid` entries are the catalog's canonical
 * spelling, never the caller's.
 *
 * A NUMERIC CHAIN ID RESOLVES TOO, against the catalog's own `nativeChainId`.
 * `CANONICAL_CHAIN_SENTENCE` (`protocols/conventions.ts`) promises every
 * chain-valued param in the tree accepts "the numeric chain id `TokenFind`
 * returns (e.g. `base` or `8453`)", and `TokenFind` hands the agent numbers,
 * so a surface that took only slugs would make that promise false on exactly
 * the handoff it exists for. The public-API tools this surface replaced did
 * translate numbers (proved by `chain-param-rename-w6a.test.ts`), and the
 * reclaimed toolIds must not quietly lose the capability.
 *
 * The lookup is slug FIRST and number second, never the reverse: a slug that
 * is all digits would otherwise be shadowed by a chain id it does not name.
 */
export function resolveChainSlugs(
  catalog: Pick<ChainsCatalog, "bySlug" | "chains">,
  input: readonly string[]
): ChainSlugResolution {
  const valid: string[] = [];
  const unknown: UnknownChainSlug[] = [];
  const seen = new Set<string>();

  for (const raw of input) {
    const normalized = raw.trim().toLowerCase();
    const match =
      catalog.bySlug.get(normalized) ?? matchByNativeChainId(catalog, normalized);
    if (match !== undefined) {
      if (!seen.has(match.slug)) {
        seen.add(match.slug);
        valid.push(match.slug);
      }
      continue;
    }
    const ranked = rankCandidates(normalized, catalog.chains);
    unknown.push({
      value: raw,
      candidates: ranked.slice(0, CHAIN_SLUG_MAX_CANDIDATES),
      candidateCount: ranked.length,
    });
  }

  return { valid, unknown };
}

/**
 * The catalog chain whose `nativeChainId` equals `value`, when `value` is a
 * whole number.
 *
 * Deliberately strict about the spelling: only an all-digit string is tried as
 * a chain id, so "base" is never coerced to NaN and matched by accident, and a
 * chain the catalog gives no `nativeChainId` (Solana and every other non-EVM
 * chain) is simply unreachable this way rather than matched on null.
 */
function matchByNativeChainId(
  catalog: Pick<ChainsCatalog, "chains">,
  value: string
): CatalogChain | undefined {
  if (!/^[0-9]+$/.test(value)) return undefined;
  const wanted = Number(value);
  if (!Number.isSafeInteger(wanted)) return undefined;
  return catalog.chains.find((chain) => chain.nativeChainId === wanted);
}

/**
 * Refuse a resolution that contains unknown slugs, naming each one and its
 * nearest matches.
 *
 * This is the fail-closed counterpart to `resolveChainSlugs`: the screener
 * would answer an unknown slug with zero rows and HTTP 200, and zero rows is
 * indistinguishable from a real empty result. A tool that cannot correct the
 * slug itself calls this so the agent hears the actual problem.
 */
export function assertChainSlugsResolved(
  resolution: ChainSlugResolution
): void {
  if (resolution.unknown.length === 0) return;
  const described = resolution.unknown
    .map((entry) => {
      const candidates =
        entry.candidates.length === 0
          ? "no similar slug in the catalog"
          : `did you mean ${entry.candidates.join(", ")}${
              entry.candidateCount > entry.candidates.length
                ? ` (${entry.candidateCount} slugs were near enough to offer; the ${entry.candidates.length} closest are listed)`
                : ""
            }`;
      return `"${entry.value}": ${candidates}`;
    })
    .join("; ");
  throw siteError(
    DexScreenerSiteErrorCodes.CHAIN_SLUG_UNKNOWN,
    `DexScreener does not have these chains: ${described}.`,
    "The screener answers an unknown chain with zero rows and no error, so the slug is refused here instead. Use dexscreener__chains_list for the full vocabulary."
  );
}

/**
 * Whether `address` is shaped like an address of `architecture`.
 *
 * DECIDABLE LOCALLY, AND ONLY THIS FAR. The catalog carries `architecture` for
 * 60 of 74 chains, and the two large families have disjoint, cheap address
 * grammars: an EVM address is `0x` plus exactly 40 hex digits, an SVM address
 * is base58 and never starts `0x`. Pasting an EVM address under a Solana slug
 * (or the reverse) is therefore a caller error this surface can name before
 * spending a provider round trip, and it is the most likely watchlist typo.
 *
 * What it deliberately does NOT decide: whether an EVM address belongs to the
 * EVM chain it was written under. Every EVM chain shares one address grammar,
 * so a Base address under an Arbitrum slug is indistinguishable here and stays
 * the provider's answer to give. `unknown` is returned for both that case and
 * for architectures the catalog omits or that this function does not model, so
 * a caller can never read a missing decision as a passing one.
 */
export function addressShapeForArchitecture(
  architecture: string | null,
  address: string
): "match" | "mismatch" | "unknown" {
  const trimmed = address.trim();
  if (trimmed === "") return "unknown";
  const looksEvm = /^0x[0-9a-fA-F]{40}$/.test(trimmed);
  const looksBase58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(trimmed);
  if (architecture === "evm") return looksEvm ? "match" : "mismatch";
  if (architecture === "svm") {
    if (trimmed.startsWith("0x")) return "mismatch";
    return looksBase58 ? "match" : "mismatch";
  }
  return "unknown";
}

/**
 * Whether `id` is shaped like a PAIR identity of `architecture`.
 *
 * A PAIR IS NOT A TOKEN, AND ON EVM IT STOPPED BEING AN ADDRESS. A Uniswap v4
 * pool has no contract of its own: the singleton PoolManager holds every pool
 * and identifies each one by a 32-byte `PoolId`, so DexScreener serves those
 * pairs under `0x` plus 64 hex digits. Reading a pair identity with the TOKEN
 * grammar (`addressShapeForArchitecture`, 40 hex) calls every v4 pool a
 * chain/shape mismatch and refuses to ask the provider about a pair the
 * provider itself published.
 *
 * The evidence is committed, not inferred: `token-pairs-v1-ethereum-weth.json`
 * carries three `chainId: "ethereum"` rows whose `pairAddress` is 64 hex and
 * whose `labels` contain `v4`, and the captured live v8 subscribe command
 * (`v8-batch-known-three.command.provenance.json`) sends a 64-hex id under the
 * EVM slug `robinhood` to a socket that answered `101`.
 *
 * SCOPE. This widens PAIR identities on EVM only. The token grammar is
 * untouched in both of its homes (this module's `addressShapeForArchitecture`
 * and `assertTokenAddressShaped` in the resolve handler), so a 64-hex value
 * written as a TOKEN is still refused - which is the check that catches a
 * caller pasting a pool id into the token lane. SVM is unchanged: a Solana pair
 * is a base58 account exactly as before, and `unknown` still means undecided.
 */
export function pairIdShapeForArchitecture(
  architecture: string | null,
  id: string
): "match" | "mismatch" | "unknown" {
  const trimmed = id.trim();
  if (trimmed === "") return "unknown";
  if (architecture === "evm" && /^0x[0-9a-fA-F]{64}$/.test(trimmed)) return "match";
  return addressShapeForArchitecture(architecture, trimmed);
}

/**
 * Rank catalog slugs by nearness to `input`, best first.
 *
 * Three signals, in order: one slug containing the other (a truncated or
 * padded guess), a shared prefix of at least three characters, and a small
 * edit distance. Anything further away is not offered, because a wrong
 * suggestion is worse than none.
 */
function rankCandidates(
  input: string,
  chains: readonly CatalogChain[]
): readonly string[] {
  if (input === "") return [];
  const scored: { slug: string; score: number }[] = [];
  for (const chain of chains) {
    const slug = chain.slug;
    const distance = editDistance(input, slug);
    const contains = slug.includes(input) || input.includes(slug);
    const prefix = commonPrefixLength(input, slug);
    if (contains) {
      scored.push({ slug, score: 0 + distance / 100 });
      continue;
    }
    if (distance <= 2) {
      scored.push({ slug, score: 1 + distance / 100 });
      continue;
    }
    if (prefix >= 3 && distance <= 4) {
      scored.push({ slug, score: 2 + distance / 100 });
    }
  }
  scored.sort((a, b) => a.score - b.score || a.slug.localeCompare(b.slug));
  return scored.map((entry) => entry.slug);
}

function commonPrefixLength(a: string, b: string): number {
  const limit = Math.min(a.length, b.length);
  let index = 0;
  while (index < limit && a[index] === b[index]) index += 1;
  return index;
}

/** Levenshtein distance, single-row. Inputs are slugs: short and bounded. */
function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  const previous = new Array<number>(b.length + 1);
  for (let column = 0; column <= b.length; column += 1) previous[column] = column;
  for (let row = 1; row <= a.length; row += 1) {
    let diagonal = previous[0] as number;
    previous[0] = row;
    for (let column = 1; column <= b.length; column += 1) {
      const above = previous[column] as number;
      previous[column] = Math.min(
        above + 1,
        (previous[column - 1] as number) + 1,
        diagonal + (a[row - 1] === b[column - 1] ? 0 : 1)
      );
      diagonal = above;
    }
  }
  return previous[b.length] as number;
}

/* ------------------------------------------------------------------ */
/* Readers                                                             */
/* ------------------------------------------------------------------ */

function asObject(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function optionalNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * An integration's own id for a chain, from either wire shape.
 *
 * Deliberately narrow about what it accepts: a non-empty string verbatim, or a
 * safe INTEGER number rendered in base 10. A float, a NaN, an Infinity or an
 * out-of-safe-range number is not an id and becomes null rather than a lossy
 * string, because these values are handed to third-party audit providers as
 * exact identifiers and a rounded one would address the wrong network.
 */
function optionalIntegrationId(value: unknown): string | null {
  if (typeof value === "string") return value === "" ? null : value;
  if (typeof value === "number" && Number.isSafeInteger(value)) {
    return String(value);
  }
  return null;
}

function catalogFieldError(subject: string, problem: string): Error {
  return siteError(
    DexScreenerSiteErrorCodes.CATALOG_INVALID,
    `The DexScreener chains catalog entry for ${subject} ${problem}`,
    "The catalog's shape has changed; the chain vocabulary cannot be validated until the parser is updated."
  );
}
