/**
 * The prediction domain's DISPLAY-ONLY close timestamp — its wire contract and
 * its one normalised form.
 *
 * WHY THIS MODULE EXISTS (live outage 2026-07-25): `closeTime` is serialized in
 * TWO different forms by two different upstream serializers, and both feed the
 * SAME `eventMetadataSchema` object:
 *
 *   - `GET /events*` → `event.metadata.closeTime` is an ISO-8601 STRING
 *     (`"2026-07-20T03:59:00Z"`) — four recorded fixtures.
 *   - `GET /positions`, `GET /history` → row `.eventMetadata.closeTime` is a
 *     unix-epoch NUMBER (`1785283200`) — confirmed live against a wallet
 *     holding a real open position.
 *
 * The schema modeled only the string form, so `solana.predict.positions` and
 * `solana.predict.history` failed HTTP_RESPONSE_INVALID the moment a real row
 * existed. Per the domain's tolerant-reader doctrine (display-only fields are
 * OPTIONAL/nullable, only financially-consumed fields are STRICT), the wire
 * contract accepts both observed forms rather than one — but as a CLOSED
 * two-member union, never `unknown`, so the polymorphism stays modeled instead
 * of hidden.
 *
 * UNIT (checked, not assumed): the numeric form is unix **SECONDS**.
 * `1785283200` → `2026-07-29T00:00:00Z` as seconds; read as milliseconds the
 * same value would be `1970-01-21`, which no open market can be. The ISO
 * strings recorded on the `/events` side land in the same window
 * (`"2026-07-20T03:59:00Z"` = 1784519940 s), so both forms denote the same
 * quantity at the same scale.
 *
 * NOT applied to the FLAT top-level Market object's `openTime`/`closeTime`
 * (`schemas/_shared.ts` → `marketSchema`). Those were separately verified
 * numeric across 50+ live markets by an earlier card and are pinned strict by
 * `jupiter-prediction-schemas.test.ts` ("keeps openTime/closeTime strictly
 * numeric"). That asymmetry is deliberate evidence-tracking, not drift.
 */

import { z } from "zod";

import type { JupiterPredictionCloseTime } from "./types/events-markets.js";

/**
 * Both observed wire forms of a display-only close timestamp. Deliberately a
 * closed union: a third form must fail loudly here rather than slip through a
 * `.passthrough()` and be mis-read downstream.
 */
export const jupiterPredictionCloseTimeSchema: z.ZodType<JupiterPredictionCloseTime> = z.union([
  z.number(),
  z.string(),
]);

/**
 * Plausibility window for the SECONDS interpretation of the numeric form.
 * Its only job is to stop a future unit change from being silently rescaled:
 * a millisecond-scaled `1785283200000` read as seconds would yield the year
 * 58543, so it falls outside this window and normalises to `null` ("unit
 * unknown") instead of a confidently wrong instant. The raw wire value is
 * always preserved alongside, so nothing is lost.
 */
const EARLIEST_PLAUSIBLE_UNIX_SECONDS = 946_684_800; // 2000-01-01T00:00:00Z
const LATEST_PLAUSIBLE_UNIX_SECONDS = 4_102_444_800; // 2100-01-01T00:00:00Z

/** A bare integer/decimal seconds string, e.g. the sibling `beginAt: "1748555553.385"`. */
const NUMERIC_STRING = /^-?\d+(?:\.\d+)?$/;

function secondsToIso(seconds: number): string | null {
  if (!Number.isFinite(seconds)) return null;
  if (seconds < EARLIEST_PLAUSIBLE_UNIX_SECONDS || seconds > LATEST_PLAUSIBLE_UNIX_SECONDS) {
    return null;
  }
  const date = new Date(seconds * 1000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * Normalise either wire form to one unambiguous ISO-8601 UTC instant, so an
 * agent reading the projected output never has to guess whether a bare
 * `1785283200` means seconds or milliseconds.
 *
 * Returns `null` — never a guess — for an absent, malformed, or
 * implausibly-scaled value. Callers keep the untouched raw `closeTime`
 * beside this, matching the domain's existing "converted value + raw sibling"
 * convention for money (`convertMicroUsdFields`).
 *
 * Accepts `unknown` because the metadata objects it reads reach the projector
 * through `.passthrough()`, where an unmodeled value can still arrive.
 */
export function jupiterPredictionCloseTimeToIso(raw: unknown): string | null {
  if (typeof raw === "number") return secondsToIso(raw);
  if (typeof raw !== "string" || raw === "") return null;
  // A digits-only string is the numeric form in string clothing, not a date:
  // `Date.parse("1785283200")` is NaN, so it must be routed to the seconds
  // path explicitly.
  if (NUMERIC_STRING.test(raw)) return secondsToIso(Number(raw));
  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}
