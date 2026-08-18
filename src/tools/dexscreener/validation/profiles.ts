/**
 * Token profile validator — one schema, both profile feeds.
 *
 * Strict `parseProfile` plus the `validateProfilesResponse` array validator.
 * `parseProfile` is re-used by the WS handshake (`validateWsProfile`).
 *
 * IDENTITY STRICT, DISPLAY TOLERANT. `url` / `chainId` / `tokenAddress` are
 * required — without them the row cannot be acted on. `updatedAt` and `cto` are
 * nullable: they are present on 30/30 rows of BOTH feeds today (live-verified
 * 2026-07-27), but requiring a field because it currently arrives is exactly what
 * made `dexscreener.boosts.top` throw on every call for months.
 *
 * Both fields were previously PARSED OFF THE WIRE AND DISCARDED on
 * `/token-profiles/latest/v1`, because `z.object` strips what the schema does not
 * declare. `updatedAt` is the only field in either feed from which profile
 * freshness can be computed. `openGraph` arrives on 30/30 rows too and is still
 * dropped, deliberately: it is
 * `cdn.dexscreener.com/token-images/og/{chainId}/{tokenAddress}?timestamp=…`, a
 * pure function of two fields already on the row.
 */

import { z } from "zod";
import { VexError, ErrorCodes } from "../../../errors.js";
import { isRecord } from "../../../utils/validation-helpers.js";
import type { DexProfileUpdate, DexTokenProfile } from "../types.js";
import { asOptionalString, asString, linksSchema, parseOrThrow, strDefault } from "./_shared.js";

/** Tolerant boolean: anything that is not a boolean means "the feed did not say". */
const asOptionalBoolean: z.ZodType<boolean | null> = z
  .unknown()
  .optional()
  .transform((raw) => (typeof raw === "boolean" ? raw : null));

const profileObjectSchema: z.ZodType<DexTokenProfile> = z
  .object({
    url: asString("profile.url"),
    chainId: asString("profile.chainId"),
    tokenAddress: asString("profile.tokenAddress"),
    icon: strDefault(""),
    header: asOptionalString,
    description: asOptionalString,
    links: linksSchema,
    updatedAt: asOptionalString,
    cto: asOptionalBoolean,
  })
  .transform((p) => ({
    url: p.url,
    chainId: p.chainId,
    tokenAddress: p.tokenAddress,
    icon: p.icon,
    header: p.header,
    description: p.description,
    links: p.links,
    updatedAt: p.updatedAt,
    cto: p.cto,
  }));

export function parseProfile(raw: unknown): DexTokenProfile {
  if (!isRecord(raw)) {
    throw new VexError(ErrorCodes.DEXSCREENER_INVALID_RESPONSE, "Invalid DexScreener response: profile must be an object");
  }
  return parseOrThrow(profileObjectSchema, raw);
}

export function validateProfilesResponse(raw: unknown): DexTokenProfile[] {
  if (!Array.isArray(raw)) {
    throw new VexError(ErrorCodes.DEXSCREENER_INVALID_RESPONSE, "Invalid DexScreener response: expected profiles array");
  }
  return raw.map(parseProfile);
}

// ── Recent-updates feed (TOLERANT — live but undocumented) ──────────
//
// `/token-profiles/recent-updates/v1` sends the same ten fields as the `latest`
// feed. It is absent from the official reference, so this parser is tolerant even
// on identity: unknown fields pass through, missing / wrong-typed fields normalise
// to `null` or `""`, a non-record row is dropped, and a non-array root yields `[]`
// — schema drift degrades to "no data" rather than a throw. That is the ONLY
// difference from `parseProfile` above, and it is why this parser still exists
// rather than delegating: the documented feed should fail loudly on a broken
// identity, the undocumented one should not take the whole call down with it.

/** One recent-updates row. Non-record → `null` so callers can filter it out. */
function parseProfileUpdate(raw: unknown): DexProfileUpdate | null {
  if (!isRecord(raw)) return null;
  return {
    url: strDefault("").parse(raw.url),
    chainId: strDefault("").parse(raw.chainId),
    tokenAddress: strDefault("").parse(raw.tokenAddress),
    icon: strDefault("").parse(raw.icon),
    header: asOptionalString.parse(raw.header),
    description: asOptionalString.parse(raw.description),
    links: linksSchema.parse(raw.links),
    updatedAt: asOptionalString.parse(raw.updatedAt),
    cto: typeof raw.cto === "boolean" ? raw.cto : null,
  };
}

export function validateProfilesRecentResponse(raw: unknown): DexProfileUpdate[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(parseProfileUpdate).filter((p): p is DexProfileUpdate => p !== null);
}
