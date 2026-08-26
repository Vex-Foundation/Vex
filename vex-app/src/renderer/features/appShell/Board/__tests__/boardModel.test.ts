/**
 * BOARD VIEW MODEL - the spec-to-view mapping, by table.
 *
 * The two properties worth protecting here are pairing and honesty: a pool
 * with no hydration row still produces a card (dropping it would misrepresent
 * what the agent put on the board), and staleness is derived from the spec's
 * own freshness window rather than assumed.
 */

import { describe, expect, it } from "vitest";
import { boardAriaLabel, buildAnnotationRows, buildBoardViewModel } from "../boardModel.js";
import { boardSpec, hydratedRow } from "./boardFixture.js";

const FETCHED_AT = 1_783_172_700_000;

type BoardViewModel = ReturnType<typeof buildBoardViewModel>;
type AnnotationRow = ReturnType<typeof buildAnnotationRows>[number];

function cardAt(model: BoardViewModel, index: number): BoardViewModel["cards"][number] {
  const card = model.cards[index];
  if (card === undefined) throw new Error(`board card ${index} missing`);
  return card;
}

function annotationRowAt(rows: readonly AnnotationRow[], index: number): AnnotationRow {
  const row = rows[index];
  if (row === undefined) throw new Error(`board annotation row ${index} missing`);
  return row;
}

describe("buildBoardViewModel", () => {
  it("pairs hydration rows to pools positionally, preserving the agent's order", () => {
    const model = buildBoardViewModel(
      boardSpec({
        pools: [
          { chain: "base", pairAddress: "0xaaa", analysis: null },
          { chain: "solana", pairAddress: "SoLbbb", analysis: null },
        ],
        rows: [
          hydratedRow({ baseTokenSymbol: "FIRST" }),
          hydratedRow({ baseTokenSymbol: "SECOND" }),
        ],
      }),
      FETCHED_AT,
    );
    expect(model.cards.map((c) => c.row?.baseTokenSymbol)).toStrictEqual([
      "FIRST",
      "SECOND",
    ]);
    expect(model.cards.map((c) => c.chain)).toStrictEqual(["base", "solana"]);
  });

  it("keeps a card for a pool whose hydration row is missing", () => {
    const spec = boardSpec({
      pools: [
        { chain: "base", pairAddress: "0xaaa", analysis: null },
        { chain: "base", pairAddress: "0xbbb", analysis: null },
      ],
      rows: [hydratedRow()],
    });
    const model = buildBoardViewModel(spec, FETCHED_AT);
    expect(model.cards).toHaveLength(2);
    expect(cardAt(model, 1).row).toBeNull();
  });

  it("classifies the trend from the signed decimal string, not a float", () => {
    const model = buildBoardViewModel(
      boardSpec({
        rows: [
          hydratedRow({ priceChange: { h1: "-0.00001", h24: "113" } }),
        ],
      }),
      FETCHED_AT,
    );
    expect(cardAt(model, 0).trendH1).toBe("down");
    expect(cardAt(model, 0).trendH24).toBe("up");
  });

  it("is fresh inside the freshness window and stale beyond it", () => {
    const spec = boardSpec({ marketDataFetchedAt: FETCHED_AT });
    expect(buildBoardViewModel(spec, FETCHED_AT + 1_000).stale).toBe(false);
    expect(buildBoardViewModel(spec, FETCHED_AT + 120_000).stale).toBe(true);
  });

  it("keeps the two clocks distinct", () => {
    const model = buildBoardViewModel(
      boardSpec({
        analysisCreatedAt: FETCHED_AT - 500_000,
        marketDataFetchedAt: FETCHED_AT,
      }),
      FETCHED_AT,
    );
    expect(model.analysisCreatedAt).not.toBe(model.marketDataFetchedAt);
  });

  it("carries notes through unchanged, newlines included", () => {
    const model = buildBoardViewModel(
      boardSpec({ notes: ["line one\nline two"] }),
      FETCHED_AT,
    );
    expect(model.notes).toStrictEqual(["line one\nline two"]);
  });
});

describe("buildAnnotationRows", () => {
  it("renders each annotation kind as a label plus a text coordinate", () => {
    const rows = buildAnnotationRows(
      boardSpec({
        chart: {
          poolIndex: 0,
          resolution: "1h",
          annotations: [
            { kind: "level", price: "0.00042", label: "resistance" },
            {
              kind: "zone",
              priceFrom: "0.0003",
              priceTo: "0.0004",
              label: "accumulation",
            },
            { kind: "marker", atMs: 1_783_172_700_000, label: "listing" },
          ],
        },
      }),
    );
    expect(rows.map((r) => r.kind)).toStrictEqual(["level", "zone", "marker"]);
    expect(annotationRowAt(rows, 0).coordinate).toBe("0.00042");
    expect(annotationRowAt(rows, 1).coordinate).toBe("0.0003 to 0.0004");
    expect(annotationRowAt(rows, 2).label).toBe("listing");
  });

  it("preserves the full precision of a sub-cent level in the legend", () => {
    const price = "0.00000000000012345678";
    const rows = buildAnnotationRows(
      boardSpec({
        chart: {
          poolIndex: 0,
          resolution: "1h",
          annotations: [{ kind: "level", price, label: "floor" }],
        },
      }),
    );
    expect(annotationRowAt(rows, 0).coordinate).toBe(price);
  });

  it("is empty when the board has no chart", () => {
    expect(buildAnnotationRows(boardSpec())).toStrictEqual([]);
  });

  it("gives each row a distinct key so duplicate labels do not collide", () => {
    const rows = buildAnnotationRows(
      boardSpec({
        chart: {
          poolIndex: 0,
          resolution: "1h",
          annotations: [
            { kind: "level", price: "1", label: "same" },
            { kind: "level", price: "2", label: "same" },
          ],
        },
      }),
    );
    expect(new Set(rows.map((r) => r.key)).size).toBe(2);
  });
});

describe("boardAriaLabel", () => {
  it("states staleness in words", () => {
    const spec = boardSpec({ title: "Base memecoins" });
    expect(boardAriaLabel(buildBoardViewModel(spec, FETCHED_AT + 1_000))).toBe(
      "Board: Base memecoins, 1 pool",
    );
    expect(boardAriaLabel(buildBoardViewModel(spec, FETCHED_AT + 999_000))).toBe(
      "Board: Base memecoins, 1 pool, market data delayed",
    );
  });

  it("pluralizes the pool count", () => {
    const model = buildBoardViewModel(
      boardSpec({
        pools: [
          { chain: "base", pairAddress: "0xaaa", analysis: null },
          { chain: "base", pairAddress: "0xbbb", analysis: null },
        ],
        rows: [hydratedRow(), hydratedRow()],
      }),
      FETCHED_AT,
    );
    expect(boardAriaLabel(model)).toContain("2 pools");
  });
});
