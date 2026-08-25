/**
 * The `profile` field group: issuer-authored text, sanitized and labelled.
 *
 * This is the one block on a screening row whose CONTENT is written by the
 * token issuer rather than measured by DexScreener. `Pair.cmsProfile` carries a
 * free-form description and a list of labelled links; `Pair.profile` carries
 * the provider's own booleans about what the issuer filled in. The first is
 * untrusted prose that will be read by a model, the second is metadata.
 *
 * Its own module, not an addition to `project.ts`, for two reasons. It is the
 * only part of the row that runs a security transform (see `../sanitize.js`),
 * so its inputs, its output and its tests are reviewable on their own. And it
 * is off by default: `project.ts` owns what every screening answer needs, this
 * owns what the agent has to ask for, and the two have different reasons to
 * change.
 *
 * SANITIZATION CONTRACT. Every issuer-authored string is passed through
 * `sanitizeIssuerField` before it leaves this module, and every field path that
 * lost characters is recorded in the caller's accumulator so the envelope can
 * name it in `sanitizedFields`. Nothing readable is shortened; only characters
 * that render as nothing are removed. A link URL is sanitized too, because an
 * invisible character inside a hostname is a homograph channel, not decoration.
 *
 * WHAT THIS MODULE DOES NOT DO. It does not decide whether a link is safe, it
 * does not fetch anything, and it does not rank or score the issuer's claims.
 * The links are handed on as data so the agent can pass them to `TwitterAccount`
 * or `WebResearch`, which are the tools that actually verify them.
 */

import { sanitizeIssuerField } from "../sanitize.js";

/** One issuer-supplied link, as the provider rendered it. */
export interface ProjectedProfileLink {
  /** The issuer's own label. Untrusted text. Null when the provider sent none. */
  readonly label: string | null;
  /** The issuer's URL. Untrusted, unvisited, and unverified by this tool. */
  readonly url: string | null;
  /** The provider's link classification, for example a social network name. */
  readonly type: string | null;
}

export interface ProjectedProfile {
  /** The issuer's free-form description. Untrusted prose, sanitized, never shortened. */
  readonly description: string | null;
  readonly links: readonly ProjectedProfileLink[];
  /** The provider's own not-safe-for-work flag on the profile. */
  readonly nsfw: boolean | null;
  /**
   * The provider's booleans about WHICH profile pieces the issuer filled in.
   * Presence of a website is not evidence that the website is real; these say
   * only that a field was populated.
   */
  readonly has: {
    readonly enhancedTokenInfo: boolean | null;
    readonly header: boolean | null;
    readonly website: boolean | null;
    readonly twitter: boolean | null;
    readonly discord: boolean | null;
  };
  /**
   * Where `has` and `linkCount` came from.
   *
   * `Pair.profile`, the provider's own flags block, is NOT sent on the
   * screener, batch or single-pair channels: it was absent on 1,851 of 1,851
   * captured rows, so every flag read null while the row's own `links` array
   * plainly carried a website and a twitter. A null that means "unknown" for
   * something the response already answers is a wrong answer, so the flags are
   * derived from `cmsProfile.links` when the provider sends no flags block,
   * and this field says which happened.
   */
  readonly hasBasis: "provider_flags" | "derived_from_links";
  /**
   * Flags this profile cannot answer on this channel, named rather than left
   * as a bare null. Empty when the provider's own flags block was present.
   */
  readonly hasUnavailable: readonly string[];
  /** Count of links on the profile: the provider's own, or the links in hand. */
  readonly linkCount: number | null;
  /**
   * Field paths inside THIS profile whose text is issuer-authored. The row's
   * own `externalContentFields` names the token name and symbol; this names the
   * rest, so the envelope can label the whole set.
   */
  readonly externalContentFields: readonly string[];
}

/** Row field paths this module always labels as issuer-authored when present. */
export const PROFILE_EXTERNAL_CONTENT_FIELDS: readonly string[] = [
  "profile.description",
  "profile.links[].label",
  "profile.links[].url",
];

/**
 * Project the profile block of one provider row.
 *
 * Returns null when the row carries neither `cmsProfile` nor `profile`, which
 * is the common case: measured 2026-08-24, bonding-curve rows carry no
 * `cmsProfile` at all, and only 28,080 of 53,094 solana pairs had a profile.
 * Null means "this token has no DexScreener profile", which is a fact about the
 * token; it is never an empty profile object pretending one exists.
 *
 * `sanitized` is the caller's accumulator across every row and field, so the
 * envelope reports the field PATHS that were touched rather than a blanket
 * claim that text was cleaned. `rowPrefix` distinguishes rows when the caller
 * wants per-row paths; pass an empty string for the shared, path-only form the
 * screening envelope uses.
 */
export function projectProfile(
  row: unknown,
  sanitized: Set<string>,
  rowPrefix = ""
): ProjectedProfile | null {
  const source = asObject(row);
  if (source === null) return null;

  const cms = asObject(source["cmsProfile"]);
  const flags = asObject(source["profile"]);
  if (cms === null && flags === null) return null;

  const path = (suffix: string): string => `${rowPrefix}${suffix}`;

  const links = readLinks(cms, sanitized, rowPrefix);

  return {
    description: sanitizeIssuerField(
      readString(cms, "description"),
      path("profile.description"),
      sanitized
    ),
    links,
    nsfw: readBoolean(cms, "nsfw") ?? readBoolean(flags, "nsfw"),
    ...describePresence(flags, links),
    externalContentFields: PROFILE_EXTERNAL_CONTENT_FIELDS,
  };
}

/** The provider's `LinkType` members this surface reads, from the descriptor. */
const LINK_TYPE_WEBSITE = "LINK_TYPE_WEBSITE";
const LINK_TYPE_TWITTER = "LINK_TYPE_TWITTER";
const LINK_TYPE_DISCORD = "LINK_TYPE_DISCORD";
/**
 * The classification the provider uses for a link it did not classify.
 * Measured live: a labelled "Website" link came back as
 * `LINK_TYPE_UNSPECIFIED`, so an unclassified link is where a website hides.
 */
const LINK_TYPE_UNSPECIFIED = "LINK_TYPE_UNSPECIFIED";

/**
 * Answer `has` and `linkCount` from whichever source the channel actually sent.
 *
 * Two flags have no derivation and stay null when the flags block is absent:
 * `enhancedTokenInfo` is a provider-side status, and `header` is about an image
 * asset that never appears in `links`. They are named in `hasUnavailable`
 * rather than published as an unexplained null.
 */
function describePresence(
  flags: JsonObject | null,
  links: readonly ProjectedProfileLink[]
): Pick<
  ProjectedProfile,
  "has" | "hasBasis" | "hasUnavailable" | "linkCount"
> {
  if (flags !== null) {
    return {
      has: {
        enhancedTokenInfo: readBoolean(flags, "eti"),
        header: readBoolean(flags, "header"),
        website: readBoolean(flags, "website"),
        twitter: readBoolean(flags, "twitter"),
        discord: readBoolean(flags, "discord"),
      },
      hasBasis: "provider_flags",
      hasUnavailable: [],
      linkCount: readInteger(flags, "linkCount"),
    };
  }
  const hasType = (type: string): boolean =>
    links.some((link) => link.type === type);
  return {
    has: {
      enhancedTokenInfo: null,
      header: null,
      // An unclassified link with a URL is how the provider ships a website.
      website:
        hasType(LINK_TYPE_WEBSITE)
        || links.some(
          (link) => link.type === LINK_TYPE_UNSPECIFIED && link.url !== null
        ),
      twitter: hasType(LINK_TYPE_TWITTER),
      discord: hasType(LINK_TYPE_DISCORD),
    },
    hasBasis: "derived_from_links",
    hasUnavailable: ["enhancedTokenInfo", "header"],
    linkCount: links.length,
  };
}

function readLinks(
  cms: JsonObject | null,
  sanitized: Set<string>,
  rowPrefix: string
): readonly ProjectedProfileLink[] {
  if (cms === null) return [];
  const raw = cms["links"];
  if (!Array.isArray(raw)) return [];

  const links: ProjectedProfileLink[] = [];
  raw.forEach((entry, index) => {
    const link = asObject(entry);
    if (link === null) return;
    links.push({
      label: sanitizeIssuerField(
        readString(link, "label"),
        `${rowPrefix}profile.links[${index}].label`,
        sanitized
      ),
      url: sanitizeIssuerField(
        readString(link, "url"),
        `${rowPrefix}profile.links[${index}].url`,
        sanitized
      ),
      // The provider's own classification, not issuer text: it is a closed
      // enum on the wire, so it is passed through without sanitization.
      type: readString(link, "type"),
    });
  });
  return links;
}

/* ------------------------------------------------------------------ */
/* Narrow readers over the protobuf JSON view                          */
/* ------------------------------------------------------------------ */

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as JsonObject;
}

function readString(source: JsonObject | null, key: string): string | null {
  if (source === null) return null;
  const value = source[key];
  return typeof value === "string" ? value : null;
}

function readBoolean(source: JsonObject | null, key: string): boolean | null {
  if (source === null) return null;
  const value = source[key];
  return typeof value === "boolean" ? value : null;
}

function readInteger(source: JsonObject | null, key: string): number | null {
  if (source === null) return null;
  const value = source[key];
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}
