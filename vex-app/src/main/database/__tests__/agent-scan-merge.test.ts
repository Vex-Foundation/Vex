/**
 * `agent-scan-merge` - the two arms into ONE ordered page.
 *
 * A pure function, so these are table tests over its boundaries, in the spirit
 * of VS Code's `listView.test.ts`: one ordered sequence over heterogeneous
 * items keyed by a discriminator, with the seams (a tie, an exhausted arm, the
 * page edge) proven rather than assumed.
 */

import { describe, expect, it } from "vitest";

import { mergeAgentScanArms } from "../agent-scan-merge.js";

const TS_A = "2026-09-08T12:00:03.000000Z";
const TS_B = "2026-09-08T12:00:02.000000Z";
const TS_C = "2026-09-08T12:00:01.000000Z";
/** The same MICROSECOND on both arms - the tie the `sourceRank` exists for. */
const TIE = "2026-09-08T12:00:00.500000Z";

interface Row {
  readonly cursor_ts: string;
  readonly source_rank: number | string;
  readonly source_id: string;
  readonly tag: string;
}

function activity(cursor_ts: string, source_id: string): Row {
  return { cursor_ts, source_rank: 0, source_id, tag: `a${source_id}` };
}
function fill(cursor_ts: string, source_id: string): Row {
  return { cursor_ts, source_rank: 1, source_id, tag: `f${source_id}` };
}
function tags(rows: readonly Row[]): readonly string[] {
  return rows.map((row) => row.tag);
}

describe("interleaving", () => {
  it("produces one time-ordered sequence across the two arms", () => {
    const { kept } = mergeAgentScanArms(
      [activity(TS_A, "10"), activity(TS_C, "8")],
      [fill(TS_B, "4")],
      50,
    );
    expect(tags(kept)).toEqual(["a10", "f4", "a8"]);
  });

  it("keeps each arm's own order untouched", () => {
    const { kept } = mergeAgentScanArms(
      [activity(TS_A, "3"), activity(TS_B, "2"), activity(TS_C, "1")],
      [],
      50,
    );
    expect(tags(kept)).toEqual(["a3", "a2", "a1"]);
  });

  it("drains the arm that still has rows once the other is exhausted", () => {
    const { kept } = mergeAgentScanArms(
      [activity(TS_A, "9")],
      [fill(TS_B, "5"), fill(TS_C, "4")],
      50,
    );
    expect(tags(kept)).toEqual(["a9", "f5", "f4"]);
  });

  /**
   * The case this whole feature exists for: an EMPTY Lighter arm must reproduce
   * today's single-arm behaviour exactly, byte for byte, so a user with no
   * Lighter history sees the feed they already had.
   */
  it("reproduces the single-arm page exactly when the Lighter arm is empty", () => {
    const rows = [activity(TS_A, "3"), activity(TS_B, "2"), activity(TS_C, "1")];
    const { kept, hasMore } = mergeAgentScanArms(rows, [], 50);
    expect(kept).toEqual(rows);
    expect(hasMore).toBe(false);
  });

  it("returns the empty page when both arms are empty", () => {
    const { kept, hasMore } = mergeAgentScanArms([], [], 50);
    expect(kept).toEqual([]);
    expect(hasMore).toBe(false);
  });
});

describe("ties", () => {
  /**
   * At an identical microsecond the ARM decides, `lighter_fills` (rank 1)
   * first under DESC. Without it the two rows would have no defined order and
   * the cursor could not say which of them the page ended on - the next page
   * would then either repeat one or skip one.
   */
  it("breaks a cross-arm tie by source_rank, fills before activity", () => {
    const { kept } = mergeAgentScanArms(
      [activity(TIE, "100")],
      [fill(TIE, "1")],
      50,
    );
    expect(tags(kept)).toEqual(["f1", "a100"]);
  });

  it("breaks a within-arm tie by id, descending", () => {
    const { kept } = mergeAgentScanArms(
      [activity(TIE, "9"), activity(TIE, "8"), activity(TIE, "7")],
      [fill(TIE, "2"), fill(TIE, "1")],
      50,
    );
    expect(tags(kept)).toEqual(["f2", "f1", "a9", "a8", "a7"]);
  });

  /**
   * THE COMPARATOR IS TOTAL, and its tail is the id compared as a BIGSERIAL.
   * `Number("9007199254740993")` is 9007199254740992, so a `Number` compare
   * would call two distinct ids equal and the order between them would rest on
   * nothing.
   *
   * In the production call the two inputs carry DIFFERENT ranks, so the rank
   * settles every cross-arm tie and this tail is not reached there. It is
   * asserted through the public entry point with two same-rank inputs because
   * this comparator states the SAME order the SQL keyset boundary applies, and
   * there the id compare IS decisive: the boundary's `id < $n::bigint` and this
   * tail have to agree, or a page would end where the next one does not begin.
   */
  it("compares ids above 2^53 as BIGINTS, not as numbers", () => {
    const low = "9007199254740992";
    const high = "9007199254740993";
    expect(Number(low)).toBe(Number(high));
    const { kept } = mergeAgentScanArms(
      [activity(TIE, low)],
      [activity(TIE, high)],
      50,
    );
    expect(tags(kept)).toEqual([`a${high}`, `a${low}`]);
  });

  /** A lexicographic id compare would order "9" after "10" and lose rows. */
  it("does not compare ids lexicographically", () => {
    const { kept } = mergeAgentScanArms(
      [activity(TIE, "10"), activity(TIE, "9")],
      [],
      50,
    );
    expect(tags(kept)).toEqual(["a10", "a9"]);
    const merged = mergeAgentScanArms([activity(TIE, "10")], [fill(TIE, "9")], 50);
    // Ranks differ, so the rank decides before the id is ever consulted.
    expect(tags(merged.kept)).toEqual(["f9", "a10"]);
  });
});

describe("the page edge", () => {
  it("keeps at most pageSize rows", () => {
    const activityRows = Array.from({ length: 4 }, (_, i) =>
      activity(`2026-09-08T12:00:0${String(9 - i)}.000000Z`, String(20 - i)),
    );
    const lighterRows = Array.from({ length: 4 }, (_, i) =>
      fill(`2026-09-08T12:00:0${String(8 - i)}.500000Z`, String(10 - i)),
    );
    const { kept, hasMore } = mergeAgentScanArms(activityRows, lighterRows, 3);
    expect(kept).toHaveLength(3);
    expect(hasMore).toBe(true);
  });

  /**
   * `hasMore` counts what the two `limit + 1` probes returned TOGETHER. An arm
   * that returned fewer than its probe is exhausted, so a total at or below the
   * page size is proof there is nothing further.
   */
  it("reports hasMore only when the arms together returned more than pageSize", () => {
    const three = [activity(TS_A, "3"), activity(TS_B, "2"), activity(TS_C, "1")];
    expect(mergeAgentScanArms(three, [], 3).hasMore).toBe(false);
    expect(mergeAgentScanArms(three, [fill(TIE, "1")], 3).hasMore).toBe(true);
    // Split across the arms, the same count is the same answer.
    expect(mergeAgentScanArms(three.slice(0, 2), [fill(TIE, "1")], 3).hasMore).toBe(false);
  });

  /**
   * The page boundary is GLOBAL, not per arm: a page may be filled entirely
   * from one arm while the other's rows are all older, and those older rows are
   * still reachable on the next page because both arms re-apply the same
   * boundary.
   */
  it("may fill a whole page from one arm when the other's rows are all older", () => {
    const { kept, hasMore } = mergeAgentScanArms(
      [activity(TS_A, "3"), activity(TS_B, "2")],
      [fill(TS_C, "1")],
      2,
    );
    expect(tags(kept)).toEqual(["a3", "a2"]);
    expect(hasMore).toBe(true);
  });

  it("handles a pageSize of zero without consuming a row", () => {
    const { kept, hasMore } = mergeAgentScanArms([activity(TS_A, "1")], [], 0);
    expect(kept).toEqual([]);
    expect(hasMore).toBe(true);
  });
});

describe("walking the whole sequence", () => {
  /**
   * The property the pagination rests on: repeatedly taking a page and
   * continuing from the last kept row visits every row exactly once, in one
   * order, whichever arm each row came from.
   */
  it("neither skips nor repeats a row while paging a mixed timeline", () => {
    const all: Row[] = [];
    for (let i = 0; i < 12; i += 1) {
      const ts = `2026-09-08T12:00:${String(59 - i).padStart(2, "0")}.000000Z`;
      all.push(activity(ts, String(200 - i)));
      // Every other second also carries a fill at the SAME microsecond.
      if (i % 2 === 0) all.push(fill(ts, String(100 - i)));
    }
    const activityRows = all.filter((row) => row.source_rank === 0);
    const lighterRows = all.filter((row) => row.source_rank === 1);

    const seen: string[] = [];
    let activityIndex = 0;
    let lighterIndex = 0;
    for (let page = 0; page < 20; page += 1) {
      const { kept, hasMore } = mergeAgentScanArms(
        activityRows.slice(activityIndex, activityIndex + 4),
        lighterRows.slice(lighterIndex, lighterIndex + 4),
        3,
      );
      seen.push(...tags(kept));
      activityIndex += kept.filter((row) => row.source_rank === 0).length;
      lighterIndex += kept.filter((row) => row.source_rank === 1).length;
      if (!hasMore) break;
    }

    const expected = tags(mergeAgentScanArms(activityRows, lighterRows, all.length).kept);
    expect(seen).toEqual(expected);
    expect(new Set(seen).size).toBe(all.length);
  });
});
