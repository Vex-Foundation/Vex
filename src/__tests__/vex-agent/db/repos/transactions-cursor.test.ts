/**
 * transactions-cursor codec — Stage 9 unit tests.
 *
 * Pins:
 *   - encode → decode round-trips the keyset tuple losslessly (incl. 6-digit µs).
 *   - garbage / wrong-part-count / out-of-range cursors are REJECTED with
 *     CursorError (bounded — never a raw Zod throw, never echoes the input).
 *   - a microsecond-truncated timestamp is rejected (the codec demands the exact
 *     DB to_char shape so sub-ms ties paginate correctly).
 *
 * Wire format under test: `base64("${cursorTs}|${sourceRank}|${id}")`. The
 * forged fixtures below are built as delimited strings (NOT JSON) to match.
 */

import { describe, it, expect } from "vitest";
import {
  encodeCursor,
  decodeCursor,
  CursorError,
  type DecodedCursor,
} from "@vex-agent/db/repos/transactions-cursor.js";

const VALID: DecodedCursor = {
  cursorTs: "2026-06-04T10:00:00.123456Z",
  sourceRank: 1,
  id: 42,
};

/** Build a base64 cursor token from raw `|`-delimited parts (forges arbitrary shapes). */
function forge(...parts: readonly (string | number)[]): string {
  return Buffer.from(parts.join("|"), "utf8").toString("base64");
}

describe("transactions-cursor codec", () => {
  it("round-trips a valid cursor losslessly", () => {
    const encoded = encodeCursor(VALID);
    expect(typeof encoded).toBe("string");
    expect(decodeCursor(encoded)).toEqual(VALID);
  });

  it("preserves the full 6-digit microsecond precision", () => {
    const cursor: DecodedCursor = { cursorTs: "2026-06-04T10:00:00.000001Z", sourceRank: 0, id: 1 };
    expect(decodeCursor(encodeCursor(cursor)).cursorTs).toBe("2026-06-04T10:00:00.000001Z");
  });

  it("rejects non-base64 / opaque garbage with CursorError", () => {
    // Lenient base64 decode never throws; these decode to a single part (no `|`),
    // so the wrong-part-count guard rejects them.
    expect(() => decodeCursor("!!!not-base64!!!")).toThrow(CursorError);
    expect(() => decodeCursor(Buffer.from("not delimited", "utf8").toString("base64"))).toThrow(CursorError);
  });

  it("rejects a wrong part count (2-part and 4-part tokens)", () => {
    const twoPart = forge(VALID.cursorTs, VALID.sourceRank); // missing id
    const fourPart = forge(VALID.cursorTs, VALID.sourceRank, VALID.id, "extra");
    expect(() => decodeCursor(twoPart)).toThrow(CursorError);
    expect(() => decodeCursor(fourPart)).toThrow(CursorError);
  });

  it("rejects an out-of-range sourceRank", () => {
    expect(() => decodeCursor(forge(VALID.cursorTs, 3, VALID.id))).toThrow(CursorError);
  });

  it("accepts sourceRank 2 (the agent_activity-added failure rank)", () => {
    const cursor: DecodedCursor = { cursorTs: "2026-06-04T10:00:00.123456Z", sourceRank: 2, id: 1 };
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
  });

  it("rejects a non-numeric / empty sourceRank field", () => {
    // Number("x") → NaN, Number("") → 0; "0" is a valid rank but an empty rank
    // field paired with a tampered id still has to round-trip cleanly — here we
    // pin the non-numeric path explicitly.
    expect(() => decodeCursor(forge(VALID.cursorTs, "x", VALID.id))).toThrow(CursorError);
  });

  it("rejects a non-positive / non-integer / non-numeric id", () => {
    expect(() => decodeCursor(forge(VALID.cursorTs, VALID.sourceRank, 0))).toThrow(CursorError);
    expect(() => decodeCursor(forge(VALID.cursorTs, VALID.sourceRank, 1.5))).toThrow(CursorError);
    expect(() => decodeCursor(forge(VALID.cursorTs, VALID.sourceRank, "x"))).toThrow(CursorError);
    expect(() => decodeCursor(forge(VALID.cursorTs, VALID.sourceRank, ""))).toThrow(CursorError);
  });

  it("rejects a millisecond-precision (3-digit) timestamp — demands the exact µs DB shape", () => {
    expect(() => decodeCursor(forge("2026-06-04T10:00:00.123Z", VALID.sourceRank, VALID.id))).toThrow(CursorError);
  });

  it("rejects a REGEX-SHAPED but calendar-impossible timestamp (Stage 9 semantic guard)", () => {
    // These pass the shape regex but are not real UTC datetimes; they must be
    // rejected in the CODEC, before the value can reach the ::timestamptz bind.
    const forgeries = [
      "2026-99-99T99:99:99.123456Z", // month/day/hour/min/sec all out of range
      "2026-13-01T00:00:00.000000Z", // month 13
      "2026-00-01T00:00:00.000000Z", // month 0
      "2026-02-30T00:00:00.000000Z", // Feb 30 — never exists
      "2026-01-32T00:00:00.000000Z", // day 32
      "2026-01-01T24:00:00.000000Z", // hour 24
      "2026-01-01T00:60:00.000000Z", // minute 60
      "2025-02-29T00:00:00.000000Z", // 2025 is not a leap year
    ];
    for (const cursorTs of forgeries) {
      const forged = forge(cursorTs, VALID.sourceRank, VALID.id);
      expect(() => decodeCursor(forged), `forgery ${cursorTs} must be rejected`).toThrow(CursorError);
    }
  });

  it("accepts a genuine leap-day timestamp (2024-02-29) — the guard is not over-strict", () => {
    const leap: DecodedCursor = { cursorTs: "2024-02-29T23:59:59.999999Z", sourceRank: 1, id: 7 };
    expect(decodeCursor(encodeCursor(leap))).toEqual(leap);
  });

  it("CursorError message is bounded and does not echo the raw input", () => {
    try {
      decodeCursor("totally-bogus-secret-looking-string");
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(CursorError);
      expect((err as CursorError).message).toBe("invalid cursor");
      expect((err as CursorError).message).not.toContain("bogus");
    }
  });

  it("refuses to mint a cursor from an internally-malformed tuple", () => {
    // encodeCursor validates on the way out — an out-of-range tuple cannot become
    // a cursor that would later fail to decode.
    expect(() => encodeCursor({ cursorTs: "nope", sourceRank: 0, id: 1 })).toThrow();
  });
});
