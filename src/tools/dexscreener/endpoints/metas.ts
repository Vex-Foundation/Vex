/**
 * The narratives (metas) endpoints.
 *
 *  - `https://io.dexscreener.com/metas/v1/all` - the identity catalog: every
 *    narrative the site knows, with no market columns at all.
 *  - `https://io.dexscreener.com/metas/v1/trending[?chainId={slug}]` - the same
 *    narratives WITH their aggregate market columns, optionally scoped to one
 *    chain.
 *
 * Both speak DexScreener's Avro dialect, not protobuf and not JSON, and are
 * decoded through `../codec/dsavro.ts` against the `METAS_ALL` and
 * `METAS_TRENDING` schema tables that S1 captured and proved against real
 * bytes (`src/__tests__/dexscreener-site/fixtures/metas-{all,trending}`).
 *
 * THREE FACTS THAT DECIDE WHAT THE TOOL MAY CLAIM.
 *
 *  1. `id` IS THE FILTER VALUE, `slug` IS NOT. The screener's
 *     `filters[metaIds][]` accepts the `id` and matches zero pairs on the
 *     `slug` (measured: slug "ai" matched 0, its id matched 243). Both are
 *     projected and the row says which one the screening tools take, because
 *     handing the model the wrong one produces an empty board that looks like
 *     a real answer.
 *  2. THE ENDPOINT ITSELF IS THE AUTHORITY ON WHICH CHAINS HAVE NARRATIVES,
 *     AND THE CATALOG FLAG IS NOT. `features.metasEnabled` is true on solana,
 *     bsc, base and ethereum only, but that is the SITE'S VISIBILITY LABEL:
 *     measured live 2026-08-25, `?chainId=robinhood` returned 7 real
 *     aggregates (cat $253.8 M over 15 tokens) while its flag is false, and
 *     ton and polygon aggregate too. An empty response therefore means the
 *     chain is QUIET, not unsupported: it is a successful answer with none
 *     active, and the count of what EXISTS comes from `/metas/v1/all`, which
 *     is where "N of 18 active" gets its 18. Gating the request on the flag
 *     hid reachable provider data behind a refusal asserting it did not exist.
 *  3. THERE IS NO PAGINATION AND NO TOTAL. The endpoint returns the whole set
 *     in one small document (measured 3,212 bytes for the trending form, 1,484
 *     for the catalog). `hasMore` on this channel is always false and the
 *     window is the population, which is a different statement from a bounded
 *     window and is reported as such.
 *
 * There is no `window` parameter on the wire: the provider always sends all
 * four change windows per row. Window selection is the CALLER's projection
 * choice over data already in hand, never a request narrowing, so nothing here
 * pretends to have asked for one.
 */

import {
  METAS_ALL,
  METAS_TRENDING,
  type Meta,
  type MetaTrending,
} from "../codec/dsavro-schemas.js";
import { decodeDsAvro } from "../codec/dsavro.js";
import {
  DexScreenerSiteErrorCodes,
  isDexScreenerSiteError,
  siteError,
} from "../site-errors.js";
import type { DexScreenerTransport } from "../transport.js";

/** The identity catalog. Every narrative, no market columns. */
export const DEXSCREENER_METAS_ALL_URL =
  "https://io.dexscreener.com/metas/v1/all";

/** The same narratives with their aggregate market columns. */
export const DEXSCREENER_METAS_TRENDING_URL =
  "https://io.dexscreener.com/metas/v1/trending";

/**
 * Byte ceiling for one narratives document.
 *
 * Measured 3,212 bytes for the trending form across 18 narratives and 1,484
 * for the catalog. One megabyte leaves room for the set to grow two orders of
 * magnitude and still bounds the read; over-cap is a typed rejection naming
 * the cap, never a silent short read.
 */
export const METAS_MAX_BYTES = 1_000_000;

/** The four windows the provider sends on every row, in its own order. */
export const META_WINDOWS = ["m5", "h1", "h6", "h24"] as const;

export type MetaWindow = (typeof META_WINDOWS)[number];

/* ------------------------------------------------------------------ */
/* Projected rows                                                      */
/* ------------------------------------------------------------------ */

/** One window's aggregate movement for a narrative. */
export interface NarrativeWindowChange {
  /** Percent change in the narrative's total market cap over the window. */
  readonly marketCapChangePct: number | null;
  /** The same change in US dollars. */
  readonly marketCapDeltaUsd: number | null;
}

/** A narrative's identity, shared by both endpoints. */
export interface NarrativeIdentity {
  /**
   * The value `filters[metaIds][]` accepts on the screening tools.
   *
   * NOT the slug. Measured: the slug matches zero pairs.
   */
  readonly id: string;
  readonly name: string;
  /** The site's own URL segment. Not accepted by the screener filter. */
  readonly slug: string;
  readonly alternativeSlugs: readonly string[];
  /** Issuer-neutral: written by DexScreener, not by a token issuer. */
  readonly description: string | null;
  readonly iconType: string | null;
  readonly iconValue: string | null;
}

/** A narrative with its aggregate market columns. */
export interface NarrativeRow extends NarrativeIdentity {
  readonly marketCapUsd: number | null;
  readonly liquidityUsd: number | null;
  readonly volumeUsd: number | null;
  /** How many tokens the provider counts in the narrative. */
  readonly tokenCount: number | null;
  /** Every window the provider sent, all four, always. */
  readonly windows: Readonly<Record<MetaWindow, NarrativeWindowChange>>;
  /**
   * Volume divided by market cap: how much of the narrative's own valuation
   * changed hands. Null when either input is missing or the market cap is
   * zero, never zero, because a missing ratio and a ratio of zero are
   * different facts.
   */
  readonly volumeToMarketCapRatio: number | null;
  /** 1-based position in the order the provider sent, before any local sort. */
  readonly providerRank: number;
}

export interface NarrativesDocument {
  readonly rows: readonly NarrativeRow[];
  /** The chain this was scoped to, or null for the cross-chain document. */
  readonly chainId: string | null;
  readonly url: string;
  readonly fetchedAtMs: number;
  readonly bytes: number;
  /**
   * The response headers, lowercased, exactly as the transport received them.
   *
   * Carried because `cf-cache-status` and `age` are the only evidence of how
   * stale this document is, and the caller's `sourceObservation` hardcoded
   * `"not_cached"` while the edge was measured serving it HIT/EXPIRED/
   * REVALIDATED under `public, max-age=30` with `age` up to 25 s. The caller
   * reads them through `readCacheObservation`; this module does not interpret
   * them, because the envelope vocabulary has one owner.
   */
  readonly headers: ReadonlyMap<string, string>;
}

export interface NarrativesOptions {
  readonly transport: DexScreenerTransport;
  readonly timeoutMs: number;
  /**
   * Scope to one chain. Omitted or null fetches the cross-chain document.
   *
   * The CALLER validates the slug against the chains catalog first; this
   * module sends what it is given, because a module that silently corrected a
   * slug would make the echo a lie.
   */
  readonly chainId?: string | null;
  readonly signal?: AbortSignal;
}

/* ------------------------------------------------------------------ */
/* Fetching                                                            */
/* ------------------------------------------------------------------ */

/** Fetch and project the narrative aggregates. */
export async function fetchNarratives(
  options: NarrativesOptions
): Promise<NarrativesDocument> {
  const chainId = options.chainId ?? null;
  const url =
    chainId === null
      ? DEXSCREENER_METAS_TRENDING_URL
      : `${DEXSCREENER_METAS_TRENDING_URL}?${new URLSearchParams({ chainId }).toString()}`;

  const response = await options.transport.httpGet(url, {
    timeoutMs: options.timeoutMs,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    maxBytes: METAS_MAX_BYTES,
  });
  if (response.status !== 200) {
    throw siteError(
      DexScreenerSiteErrorCodes.NARRATIVES_INVALID,
      `The DexScreener narratives endpoint answered HTTP ${response.status} for ${chainId === null ? "the cross-chain document" : `chain ${chainId}`}`,
      "Retry once; a non-200 here is a transport or endpoint problem, not proof that no narrative is moving."
    );
  }

  return {
    rows: parseNarratives(response.body),
    chainId,
    url,
    fetchedAtMs: Date.now(),
    bytes: response.body.byteLength,
    headers: response.headers,
  };
}

/**
 * Fetch the identity catalog: every narrative, with no market columns.
 *
 * Separate from `fetchNarratives` because it answers a different question
 * ("what narratives exist at all") and the trending document on a quiet chain
 * is a strict subset of it. Exported for the caller that wants to state how
 * many of the known narratives its chain-scoped answer covered.
 */
export async function fetchNarrativeCatalog(
  options: Omit<NarrativesOptions, "chainId">
): Promise<readonly NarrativeIdentity[]> {
  const response = await options.transport.httpGet(DEXSCREENER_METAS_ALL_URL, {
    timeoutMs: options.timeoutMs,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    maxBytes: METAS_MAX_BYTES,
  });
  if (response.status !== 200) {
    throw siteError(
      DexScreenerSiteErrorCodes.NARRATIVES_INVALID,
      `The DexScreener narrative catalog answered HTTP ${response.status}`,
      "Retry once; a non-200 here is a transport or endpoint problem, not an empty catalog."
    );
  }
  const metas = decode(METAS_ALL, response.body, "metas/v1/all", () =>
    decodeDsAvro(METAS_ALL, response.body).value
  );
  return metas.map(projectIdentity);
}

/* ------------------------------------------------------------------ */
/* Decoding and projection                                             */
/* ------------------------------------------------------------------ */

/**
 * Decode and project one trending document.
 *
 * Exported so the projection has a testable owner that needs no transport,
 * matching every sibling endpoint module.
 */
export function parseNarratives(body: Uint8Array): readonly NarrativeRow[] {
  const rows = decode(METAS_TRENDING, body, "metas/v1/trending", () =>
    decodeDsAvro(METAS_TRENDING, body).value
  );
  return rows.map((row, index) => projectRow(row, index + 1));
}

/**
 * Run one Avro decode, converting a table mismatch into this channel's own
 * typed failure with its own remedy.
 *
 * Generic over the schema so both documents share one error contract without
 * either losing its decoded type.
 */
function decode<T>(
  schema: { readonly label: string; read: (reader: never) => T },
  body: Uint8Array,
  path: string,
  run: () => T
): T {
  try {
    return run();
  } catch (error) {
    // Our own cap rejection keeps its own code and remedy.
    if (
      isDexScreenerSiteError(error) &&
      error.code === DexScreenerSiteErrorCodes.RESPONSE_OVER_CAP
    ) {
      throw error;
    }
    throw siteError(
      DexScreenerSiteErrorCodes.NARRATIVES_INVALID,
      `${body.byteLength} bytes from ${path} did not decode as ${schema.label}`,
      "The Avro field order may have changed. Re-capture the fixture and update the schema table before trusting this endpoint."
    );
  }
}

function projectIdentity(meta: Meta): NarrativeIdentity {
  return {
    id: meta.id,
    name: meta.name,
    slug: meta.slug,
    alternativeSlugs: meta.alternativeSlugs ?? [],
    description: text(meta.description),
    iconType: text(meta.icon.type),
    iconValue: text(meta.icon.value),
  };
}

function projectRow(meta: MetaTrending, providerRank: number): NarrativeRow {
  const marketCapUsd = finite(meta.marketCap);
  const volumeUsd = finite(meta.volume);
  return {
    ...projectIdentity(meta),
    marketCapUsd,
    liquidityUsd: finite(meta.liquidity),
    volumeUsd,
    tokenCount: finite(meta.tokenCount),
    windows: {
      m5: window(meta, "m5"),
      h1: window(meta, "h1"),
      h6: window(meta, "h6"),
      h24: window(meta, "h24"),
    },
    volumeToMarketCapRatio:
      volumeUsd === null || marketCapUsd === null || marketCapUsd === 0
        ? null
        : volumeUsd / marketCapUsd,
    providerRank,
  };
}

function window(meta: MetaTrending, key: MetaWindow): NarrativeWindowChange {
  return {
    marketCapChangePct: finite(meta.marketCapChange[key]),
    marketCapDeltaUsd: finite(meta.marketCapDelta[key]),
  };
}

/** A non-finite provider number is an absent measurement, never a zero. */
function finite(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function text(value: string | null | undefined): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}
