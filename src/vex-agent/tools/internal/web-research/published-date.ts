/**
 * Publisher timestamps, read honestly.
 *
 * THE MEASUREMENT. Tavily populates `publishedDate` on 10/10 rows with
 * `topic: "news"` and 0/9 without it, in RFC 1123 form
 * (`"Fri, 24 Jul 2026 00:00:00 GMT"`) - and with MIXED PRECISION: on one live
 * news window 9 rows carried a real second-level time and one carried
 * `00:00:00`, which means "that day", not midnight.
 *
 * THE CONTRACT. Three fields, because one number cannot carry all three facts:
 *
 *   `publishedAt`           the provider's own string, verbatim, or null
 *   `publishedAtMs`         a FINITE epoch ms, or null - never NaN
 *   `publishedAtPrecision`  "day" | "second", present ONLY when Ms is non-null
 *
 * A midnight-UTC instant is reported as `"day"` precision. A genuine midnight
 * publication is indistinguishable from a date-only value in this data, so the
 * conservative reading wins: the agent is told the day is trustworthy and the
 * time of day is not. The alternative - dropping the value, or reporting
 * second precision - would either lose the date or fabricate a time.
 *
 * A value the provider sent but we cannot parse is NOT discarded: the string
 * survives on `publishedAt` while `publishedAtMs` is null, so the agent can see
 * what the publisher claimed and that Vex could not read it.
 */

export type PublishedAtPrecision = "day" | "second";

export interface PublishedAtFields {
  publishedAt: string | null;
  publishedAtMs: number | null;
  publishedAtPrecision?: PublishedAtPrecision;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function readPublishedAt(raw: unknown): PublishedAtFields {
  if (typeof raw !== "string") return { publishedAt: null, publishedAtMs: null };
  const value = raw.trim();
  if (value.length === 0) return { publishedAt: null, publishedAtMs: null };

  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return { publishedAt: value, publishedAtMs: null };

  return {
    publishedAt: value,
    publishedAtMs: parsed,
    publishedAtPrecision: parsed % MS_PER_DAY === 0 ? "day" : "second",
  };
}
