/**
 * The spotlight endpoint: `https://io.dexscreener.com/dex/search/spotlight/v10`.
 *
 * One 23 KB protobuf document carrying THREE independent feeds that the site
 * renders side by side, and that four separate public-API tools used to answer
 * badly:
 *
 *  - `boosts.top`, 30 rows: who has paid the most in total;
 *  - `boosts.recent`, 30 rows: who has JUST paid, carrying both the running
 *    total and the single purchase that was just made;
 *  - `latestProfiles`, 36 rows: the newest issuer-published token profiles.
 *
 * THE `recent` FEED IS WHY THIS IS ONE CALL AND NOT THREE. Its rows carry
 * `amount` (the purchase that just happened) SEPARATELY from `totalAmount`
 * (everything that token has ever bought). "Who just started paying" and "who
 * has paid the most" are different questions and the provider answers both in
 * the same 23 KB; a client that folded the two amounts together would destroy
 * the only distinction the feed exists to make.
 *
 * A BOOST IS BOUGHT VISIBILITY. Nothing in this document is a demand,
 * quality or safety signal, and this module does not derive one. It reports
 * counters and identity; what paid attention means is the model's call.
 *
 * TWO MEASURED INSTABILITIES THE CALLER MUST STATE, because neither is
 * visible in a single answer and both change what a repeated call means:
 *
 *  - TIED RANKS SHUFFLE. Two reads three minutes apart had IDENTICAL
 *    `topBoosts` membership in a DIFFERENT order: the long tail of rows tied
 *    on `totalAmount` reorders between reads. `feedRank` for a tied row is
 *    therefore not reproducible, and a rank change on a tied row is not
 *    movement.
 *  - THE RECENT FEED DIVERGES BETWEEN REPLICAS. A read at 07:44 carried two
 *    rows that neither the 07:42 nor the 07:45 read had, while those two were
 *    identical to each other. A recency feed does not un-add rows, so this is
 *    two cached copies rather than drift: a later call can return an OLDER
 *    document than the one before it, and two consecutive answers are not
 *    ordered in time.
 *
 * DECLARED OMISSIONS (measured, and named rather than left silent):
 *
 *  - `LatestProfile.Boosts.legacyActive`: present on 7 of 7 rows that carry
 *    boosts and EQUAL to `active` on all seven (the wire spells one as int32
 *    and the other as a uint64 string). A second spelling of a number already
 *    reported would invite a model to look for a difference that has never
 *    been observed.
 *  - `PartialToken.id`: present on 36 of 36 rows and exactly
 *    `"<chainId>:<lowercased address>"`, both of which the row already
 *    carries verbatim. It is derivable, and the lowercased half of it is a
 *    trap on Solana, where address case is load-bearing elsewhere on this
 *    surface.
 *
 * ISSUER TEXT LIVES HERE. `latestProfiles` rows carry the issuer's own
 * description and links. This module projects them verbatim and names them;
 * SANITIZATION IS THE CALLER'S, through `../sanitize.js`, for the same reason
 * `screen-core/project.ts` states: a projection that silently rewrote text
 * would make the `sanitizedFields` report unprovable.
 */

import { decodeDexScreenerMessageToJson } from "../codec/protobuf.js";
import {
  DexScreenerSiteErrorCodes,
  siteError,
} from "../site-errors.js";
import type { DexScreenerTransport } from "../transport.js";

/** The endpoint. The one URL this module is allowed to fetch. */
export const DEXSCREENER_SPOTLIGHT_URL =
  "https://io.dexscreener.com/dex/search/spotlight/v10";

/**
 * Byte ceiling for the document. Measured at 23,571 bytes with all three feeds
 * full. Two megabytes bounds it with room for the feeds to grow an order of
 * magnitude, and over-cap is a typed rejection naming the cap.
 */
export const SPOTLIGHT_MAX_BYTES = 2_000_000;

/** The feeds this endpoint carries, as the tool names them. */
export const SPOTLIGHT_FEEDS = [
  "topBoosts",
  "recentBoosts",
  "latestProfiles",
] as const;

export type SpotlightFeed = (typeof SPOTLIGHT_FEEDS)[number];

/* ------------------------------------------------------------------ */
/* Projected rows                                                      */
/* ------------------------------------------------------------------ */

/** One boosted token, on either boost feed. */
export interface SpotlightBoostRow {
  readonly chainId: string;
  readonly tokenAddress: string;
  /** Issuer-authored. Untrusted; the caller sanitizes and reports. */
  readonly tokenSymbol: string | null;
  /** Everything this token has ever bought, in boost units. */
  readonly totalBoostAmount: number | null;
  /**
   * The provider's CDN URL for the token's icon, as sent (`tokenImageURL`).
   *
   * Measured present on 30 of 30 top rows and 29 of 30 recent rows. Carried
   * because the two RETIRED public-API tools this one replaces both shipped an
   * icon, so dropping it was a silent depth regression against this tool's own
   * successor claim. It is a provider-hosted URL, not issuer-authored text.
   */
  readonly tokenImageUrl: string | null;
  /**
   * The purchase that just happened, on the `recentBoosts` feed only.
   * Null on the `topBoosts` feed because the provider does not send it there,
   * which is a different fact from a purchase of zero.
   */
  readonly justPurchasedAmount: number | null;
  /** 1-based position in the feed as the provider ordered it. */
  readonly feedRank: number;
}

/** One issuer-published profile from the `latestProfiles` feed. */
export interface SpotlightProfileRow {
  readonly chainId: string;
  readonly tokenAddress: string;
  /** Issuer-authored. Untrusted; the caller sanitizes and reports. */
  readonly tokenName: string | null;
  readonly tokenSymbol: string | null;
  /**
   * The issuer's blurb.
   *
   * `null` means the issuer PUBLISHED NONE; the empty string means they
   * published an EMPTY one, and the two are different facts about a profile.
   * They are distinguishable here only because the field is a wrapper message
   * with explicit presence in the descriptor, so an empty value survives the
   * JSON decode as `""` instead of vanishing the way a bare proto3 string
   * would. Measured on 2026-08-25: 35 of 36 profiles carried the field and 6 of
   * those carried it empty, all six of which used to be reported identically
   * to the one that published nothing.
   */
  readonly description: string | null;
  /**
   * The provider's CDN asset ids for the profile's icon and header image.
   *
   * Measured present on 36 of 36 and 34 of 36 rows. Ids, not URLs: the
   * provider renders them through its own CMS path. Carried for the same
   * reason as `tokenImageUrl`, and because `projectProfile` elsewhere on this
   * surface reports a header as UNAVAILABLE while the same document is
   * carrying its id.
   */
  readonly iconId: string | null;
  readonly headerId: string | null;
  readonly links: readonly SpotlightProfileLink[];
  readonly publishedAtMs: number | null;
  /** The provider's own not-safe-for-work flag on the profile. */
  readonly nsfw: boolean | null;
  /** Active boosts on the token at the time of the read, when the row says. */
  readonly boostsActive: number | null;
  readonly feedRank: number;
}

export interface SpotlightProfileLink {
  /** The provider's link type when it named one, for example `twitter`. */
  readonly type: string | null;
  /**
   * The issuer's own label for the link, when they wrote one. Untrusted text,
   * and on an unclassified link it is the only thing that says what the link
   * is for.
   */
  readonly label: string | null;
  /** Issuer-authored URL. Untrusted: it is a claim, not a verified identity. */
  readonly url: string;
}

export interface SpotlightDocument {
  readonly topBoosts: readonly SpotlightBoostRow[];
  readonly recentBoosts: readonly SpotlightBoostRow[];
  readonly latestProfiles: readonly SpotlightProfileRow[];
  /**
   * The response headers, when the document came from a request rather than
   * from bytes a test handed to `parseSpotlight`.
   *
   * Carried because the caller's `cacheState` has no other evidence: the
   * ORIGIN sends `cache-control: no-store`, and Cloudflare serves the hop from
   * its edge anyway (measured `cf-cache-status: HIT` with `age` 1 to 4
   * seconds), so a hardcoded "not cached" denies a staleness the headers
   * state.
   */
  readonly responseHeaders?: ReadonlyMap<string, string>;
  readonly fetchedAtMs: number;
}

export interface SpotlightOptions {
  readonly transport: DexScreenerTransport;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}

/** Fetch and project the spotlight document. */
export async function fetchSpotlight(
  options: SpotlightOptions
): Promise<SpotlightDocument> {
  const response = await options.transport.httpGet(DEXSCREENER_SPOTLIGHT_URL, {
    timeoutMs: options.timeoutMs,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    maxBytes: SPOTLIGHT_MAX_BYTES,
  });
  if (response.status !== 200) {
    throw siteError(
      DexScreenerSiteErrorCodes.SPOTLIGHT_INVALID,
      `The DexScreener spotlight endpoint answered HTTP ${response.status}`,
      "Retry once; if it persists the endpoint has moved and the paid-attention feeds are unavailable rather than empty."
    );
  }
  return { ...parseSpotlight(response.body), responseHeaders: response.headers };
}

/**
 * Decode and project the document.
 *
 * Exported so the projection has a testable owner that does not need a
 * transport. Every field is optional by measurement except the two that make a
 * row addressable at all (`chainId`, `tokenAddress`); a row missing either is
 * DROPPED rather than emitted with an empty identity, because a row nobody can
 * look up is worse than one row fewer, and the count the caller reports is the
 * count of rows it can actually act on.
 */
export function parseSpotlight(body: Uint8Array): SpotlightDocument {
  let json: unknown;
  try {
    json = decodeDexScreenerMessageToJson(
      "dex_search.SpotlightResponse",
      body,
      { maxBytes: SPOTLIGHT_MAX_BYTES }
    );
  } catch (error) {
    // A cap rejection is the caller's own bound and keeps its own code.
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === DexScreenerSiteErrorCodes.RESPONSE_OVER_CAP
    ) {
      throw error;
    }
    throw siteError(
      DexScreenerSiteErrorCodes.SPOTLIGHT_INVALID,
      `${body.byteLength} bytes from the spotlight endpoint did not decode as dex_search.SpotlightResponse`,
      "The wire format may have changed. Re-run the descriptor drift test before trusting this endpoint."
    );
  }

  const root = asObject(json);
  if (root === null) {
    throw siteError(
      DexScreenerSiteErrorCodes.SPOTLIGHT_INVALID,
      "The spotlight document decoded to something that is not a message",
      "The wire format may have changed. Re-run the descriptor drift test before trusting this endpoint."
    );
  }

  const boosts = asObject(root["boosts"]);
  return {
    topBoosts: readBoostFeed(boosts?.["top"], false),
    recentBoosts: readBoostFeed(boosts?.["recent"], true),
    latestProfiles: readProfileFeed(root["latestProfiles"]),
    fetchedAtMs: Date.now(),
  };
}

function readBoostFeed(value: unknown, recent: boolean): SpotlightBoostRow[] {
  if (!Array.isArray(value)) return [];
  const rows: SpotlightBoostRow[] = [];
  for (const entry of value) {
    const source = asObject(entry);
    if (source === null) continue;
    const chainId = readString(source["chainId"]);
    const tokenAddress = readString(source["tokenAddress"]);
    if (chainId === null || tokenAddress === null) continue;
    rows.push({
      chainId,
      tokenAddress,
      tokenSymbol: readString(source["tokenSymbol"]),
      tokenImageUrl: readString(source["tokenImageURL"]),
      totalBoostAmount: readNumber(source["totalAmount"]),
      justPurchasedAmount: recent ? readNumber(source["amount"]) : null,
      feedRank: rows.length + 1,
    });
  }
  return rows;
}

function readProfileFeed(value: unknown): SpotlightProfileRow[] {
  if (!Array.isArray(value)) return [];
  const rows: SpotlightProfileRow[] = [];
  for (const entry of value) {
    const source = asObject(entry);
    if (source === null) continue;
    const token = asObject(source["token"]);
    if (token === null) continue;
    const chainId = readString(token["chainId"]);
    const tokenAddress = readString(token["address"]);
    if (chainId === null || tokenAddress === null) continue;
    const createdAt = token["createdAt"];
    const parsed = typeof createdAt === "string" ? Date.parse(createdAt) : NaN;
    const boosts = asObject(source["boosts"]);
    rows.push({
      chainId,
      tokenAddress,
      tokenName: readString(token["name"]),
      tokenSymbol: readString(token["symbol"]),
      // `readPresentString`, not `readString`: an issuer who published an
      // empty description said something different from one who published
      // none, and this is the one field on the row where the distinction is
      // both observable and worth reporting.
      description: readPresentString(token["description"]),
      iconId: readString(asObject(token["icon"])?.["id"]),
      headerId: readString(asObject(token["header"])?.["id"]),
      links: readLinks(token["links"]),
      publishedAtMs: Number.isNaN(parsed) ? null : parsed,
      nsfw: typeof token["nsfw"] === "boolean" ? token["nsfw"] : null,
      boostsActive: boosts === null ? null : readNumber(boosts["active"]),
      feedRank: rows.length + 1,
    });
  }
  return rows;
}

function readLinks(value: unknown): SpotlightProfileLink[] {
  if (!Array.isArray(value)) return [];
  const links: SpotlightProfileLink[] = [];
  for (const entry of value) {
    const source = asObject(entry);
    if (source === null) continue;
    const url = readString(source["url"]);
    // A link with no URL is not a link; dropping it is not a content cut,
    // because there is nothing there for a reader to have seen.
    if (url === null) continue;
    // `label` is the issuer's own name for the link and is the ONLY descriptor
    // on a link the provider did not classify: measured, 23 of 67 links in one
    // live document carried one, and a `type: null` link with the label
    // dropped reached the model as a bare URL. It is also issuer-authored
    // text, so dropping it silently killed a safety property `sanitize.ts`
    // claims in writing ("profile link labels"): a hostile label was neither
    // sanitized nor reported, because it never reached the projection.
    links.push({
      type: readString(source["type"]),
      label: readString(source["label"]),
      url,
    });
  }
  return links;
}

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as JsonObject;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * Read a string field PRESERVING the empty string.
 *
 * The counterpart to `readString`, for the one field where "" and absent are
 * different facts. Safe only because the field is a wrapper message with
 * explicit presence: on a bare proto3 string an empty value never reaches the
 * decoded JSON at all, so this reader would promise a distinction the wire
 * cannot carry.
 */
function readPresentString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/**
 * Boost amounts are int32/int64 on the wire. protobuf JSON renders int32 as a
 * number and int64 as a decimal STRING, so both spellings are parsed exactly
 * and anything else becomes null rather than a guessed zero.
 */
function readNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}
