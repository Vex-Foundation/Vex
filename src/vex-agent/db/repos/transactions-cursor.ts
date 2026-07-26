/**
 * Transactions-view keyset cursor codec (Stage 9).
 *
 * The unified `transactions` feed paginates with an opaque base64 cursor that
 * encodes the keyset tuple of the last returned row: (created_at, sourceRank,
 * id). The cursor timestamp is the DB-side microsecond-precision rendering of
 * created_at (`to_char(... 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`), NOT a JS Date —
 * a JS Date round-trip would silently truncate microseconds and break the
 * keyset boundary at sub-millisecond ties.
 *
 * Wire format: the three fields are joined with a `|` delimiter and base64'd —
 * `base64("${cursorTs}|${sourceRank}|${id}")`. `|` is unambiguous: `cursorTs`
 * is the fixed `YYYY-MM-DDTHH:MM:SS.ffffffZ` shape (digits, `-`, `:`, `.`, `T`,
 * `Z` only), `sourceRank` is `0`|`1`|`2`, and `id` is a positive integer — none
 * can contain `|`. (We deliberately do NOT use JSON here: this codec lives under
 * `db/repos`, where the JSONB-boundary lint forbids `JSON.stringify` so that all
 * JSONB column writes go through `db/params`. A base64 cursor token is not a
 * JSONB write, but the lint is a blunt line scan, so the delimited encoding both
 * satisfies the lint and keeps the token compact.)
 *
 * A malformed / garbage / cross-shape cursor is REJECTED with a bounded
 * `CursorError` (no stack-leak, no raw-input echo) so the handler can return a
 * clean `fail("invalid cursor")` — decoding untrusted input must never crash
 * the tool or leak internals.
 */

import { z } from "zod";

/** Decoded keyset cursor — the tuple boundary the next page reads strictly past. */
export interface DecodedCursor {
  /** created_at rendered at microsecond precision: YYYY-MM-DDTHH:MM:SS.ffffffZ. */
  readonly cursorTs: string;
  /**
   * Source tie-break: 0 = agent_activity (new-format, Agent Scan), 1 = success
   * (proj_activity), 2 = failure (protocol_executions). Only a constant per
   * half — never a business-meaning ordering.
   */
  readonly sourceRank: 0 | 1 | 2;
  /** Row id within its source table — final, strict tie-break. */
  readonly id: number;
}

/** Bounded cursor-decode failure. Carries no raw input and no stack detail. */
export class CursorError extends Error {
  constructor() {
    super("invalid cursor");
    this.name = "CursorError";
  }
}

/**
 * Microsecond-precision UTC timestamp string as produced by the SQL
 * `to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`.
 * Exactly 6 fractional digits, trailing 'Z'. Validated structurally so a
 * forged cursor cannot smuggle arbitrary text into the `::timestamptz` bind.
 */
const CursorTsSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);

const DecodedCursorSchema = z.object({
  cursorTs: CursorTsSchema,
  sourceRank: z.union([z.literal(0), z.literal(1), z.literal(2)]),
  id: z.number().int().positive(),
});

/**
 * Semantic UTC-calendar validation for a regex-shaped cursor timestamp.
 *
 * `CursorTsSchema` only proves the SHAPE (`YYYY-MM-DDTHH:MM:SS.ffffffZ`) — it
 * happily accepts a calendar-impossible value like `2026-99-99T99:99:99.123456Z`
 * or `2026-13-01T00:00:00.000000Z`, which would then flow into the repo's
 * `::timestamptz` bind. Postgres would either reject it (error surface) or
 * coerce it, so we reject it HERE, in the codec, before it can reach the DB.
 *
 * Approach: parse year/month/day/hour/min/sec from the (already shape-validated)
 * string, build a UTC `Date` via `Date.UTC`, and confirm the round-trip is exact.
 * `Date.UTC` normalizes overflow (month 99 rolls into later years; day 99 rolls
 * into a later month), so a forged component diverges from the Date's own UTC
 * getters and is caught. The 6 fractional digits are NOT part of Date validation
 * — they are preserved verbatim in the returned `cursorTs`.
 */
function isValidUtcCursorTs(cursorTs: string): boolean {
  // Shape is guaranteed by CursorTsSchema upstream, so these slices are stable.
  const year = Number(cursorTs.slice(0, 4));
  const month = Number(cursorTs.slice(5, 7));
  const day = Number(cursorTs.slice(8, 10));
  const hour = Number(cursorTs.slice(11, 13));
  const minute = Number(cursorTs.slice(14, 16));
  const second = Number(cursorTs.slice(17, 19));

  const ms = Date.UTC(year, month - 1, day, hour, minute, second);
  if (!Number.isFinite(ms)) return false;
  const date = new Date(ms);

  // Exact round-trip: any overflow normalization (e.g. month 99 → a later year,
  // day 99 → a later month) makes the Date's own UTC getters diverge from the
  // parsed components, revealing the forgery.
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day &&
    date.getUTCHours() === hour &&
    date.getUTCMinutes() === minute &&
    date.getUTCSeconds() === second
  );
}

/** Field delimiter for the encoded cursor token. None of the three fields can contain it. */
const CURSOR_DELIMITER = "|";

/** Encode a keyset tuple to an opaque base64 cursor. */
export function encodeCursor(cursor: DecodedCursor): string {
  // Validate on the way out too so an internally-malformed tuple can never be
  // minted into a cursor that would later fail to decode.
  const safe = DecodedCursorSchema.parse(cursor);
  const token = `${safe.cursorTs}${CURSOR_DELIMITER}${safe.sourceRank}${CURSOR_DELIMITER}${safe.id}`;
  return Buffer.from(token, "utf8").toString("base64");
}

/**
 * Decode + validate an opaque cursor. Throws `CursorError` on any malformed
 * input (bad base64, wrong part count, out-of-range field, calendar-impossible
 * timestamp). Never throws a raw Zod error and never echoes the input.
 */
export function decodeCursor(raw: string): DecodedCursor {
  // base64 decode is total (it never throws — invalid chars are dropped), so we
  // validate the decoded shape explicitly rather than relying on a try/catch.
  const decoded = Buffer.from(raw, "base64").toString("utf8");
  const parts = decoded.split(CURSOR_DELIMITER);
  if (parts.length !== 3) {
    throw new CursorError();
  }
  // `Number("")` → 0 and `Number("x")` → NaN; both are rejected by the schema's
  // sourceRank ∈ {0,1} / id positive-int constraints below. cursorTs stays a raw
  // string so the regex + calendar guard own its validation.
  const candidate = {
    cursorTs: parts[0],
    sourceRank: Number(parts[1]),
    id: Number(parts[2]),
  };
  const result = DecodedCursorSchema.safeParse(candidate);
  if (!result.success) {
    throw new CursorError();
  }
  // Semantic guard: the regex above proves only the SHAPE. Reject a
  // calendar-impossible timestamp (e.g. month 99 / day 99) BEFORE it can reach
  // the repo's `::timestamptz` bind — the malformed value must never touch
  // Postgres. (Bounded CursorError → handler returns fail("Invalid cursor").)
  if (!isValidUtcCursorTs(result.data.cursorTs)) {
    throw new CursorError();
  }
  return result.data;
}
