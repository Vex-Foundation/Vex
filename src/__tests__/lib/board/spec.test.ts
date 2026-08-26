/**
 * BoardSpec v1 - the contract every other board consumer imports.
 *
 * These tests pin the frozen contract table: every bound at its inclusive
 * boundary and one step past it, the reject-only text policy reaching every
 * string field, the structural invariants between input and hydration, and the
 * byte budget as a refusal rather than a trim.
 *
 * The resolution vocabulary is checked against the provider module rather than
 * against a second hand-written list, because a hand-spelled wire name is a
 * defect even when it happens to be correct.
 */

import { describe, expect, it } from "vitest";

import { BAR_RESOLUTIONS } from "../../../tools/dexscreener/endpoints/bars.js";
import {
  BOARD_CHART_RESOLUTIONS,
  BOARD_MARKER_MAX_MS,
  BOARD_MAX_CANDLES,
  BOARD_MAX_POOLS,
  BOARD_MARKER_MIN_MS,
  BOARD_SPEC_MAX_BYTES,
  BOARD_STALE_AFTER_MS,
  boardAnnotationSchema,
  boardComposeInputSchema,
  boardSpecV1Schema,
  checkBoardSpecByteBudget,
  compareDecimalStrings,
  describeBoardByteBudgetFailure,
  type BoardComposeInput,
} from "../../../lib/board/index.js";

const ZWSP = String.fromCodePoint(0x200b);
const RLO = String.fromCodePoint(0x202e);
const TAG_A = String.fromCodePoint(0xe0041);

function minimalInput(): BoardComposeInput {
  return {
    title: "SOL majors",
    pools: [{ chain: "solana", pairAddress: "58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2", analysis: null }],
  };
}

function hydrationFor(poolCount: number, withCandles: boolean): unknown {
  return {
    rows: Array.from({ length: poolCount }, () => ({
      baseTokenSymbol: "SOL",
      baseTokenName: "Wrapped SOL",
      quoteTokenSymbol: "USDC",
      chainId: "solana",
      dexId: "raydium",
      priceUsd: "142.37",
      priceChange: { h1: "-0.42", h24: "3.10" },
      liquidityUsd: "12904331.55",
      volumeH24Usd: "48120993.02",
      txns: { buys: 41233, sells: 39812 },
      pairAgeSeconds: 90123456,
      // Current writers always emit both profile fields, null included.
      iconId: null,
      description: null,
    })),
    candles: withCandles
      ? {
          bars: [{ tMs: 1_756_000_000_000, o: "1.0", h: "1.2", l: "0.9", c: "1.1" }],
          lastBarPartial: true,
          coveredRange: { fromMs: 1_756_000_000_000, toMs: 1_756_000_060_000 },
          resolution: "1h",
          truncated: false,
        }
      : null,
    analysisCreatedAt: 1_756_000_000_000,
    marketDataFetchedAt: 1_756_000_030_000,
    provenance: { transport: "http", sourceObservation: "dex/pairs/v1 batch, 1 subject" },
    // The runtime's marker-membership verdict. It is a LIST whenever the board
    // has a chart (empty when every marker matched a candle) and null when it
    // has none, which is what these fixtures pair with `withCandles`.
    unmatchedMarkerAtMs: withCandles ? [] : null,
    staleAfterMs: BOARD_STALE_AFTER_MS,
  };
}

describe("resolution vocabulary", () => {
  it("is exactly the provider's 18 resolutions, in the same order", () => {
    expect([...BOARD_CHART_RESOLUTIONS]).toEqual([...BAR_RESOLUTIONS]);
    expect(BOARD_CHART_RESOLUTIONS).toHaveLength(18);
  });

  it("refuses a resolution the provider does not serve", () => {
    const input = { ...minimalInput(), chart: { poolIndex: 0, resolution: "2m" } };
    expect(boardComposeInputSchema.safeParse(input).success).toBe(false);
  });
});

describe("boardComposeInputSchema - shape", () => {
  it("accepts the minimal board", () => {
    expect(boardComposeInputSchema.safeParse(minimalInput()).success).toBe(true);
  });

  it("refuses an unknown key rather than dropping it", () => {
    for (const extra of [
      { color: "#ff0000" },
      { html: "<b>hi</b>" },
      { url: "https://example.invalid" },
      { feeBps: 30 },
      { recipient: "0xdead" },
      { chartOptions: {} },
    ]) {
      const result = boardComposeInputSchema.safeParse({ ...minimalInput(), ...extra });
      expect(result.success).toBe(false);
    }
  });

  it("refuses an unknown key on a pool", () => {
    const input = {
      ...minimalInput(),
      pools: [{ chain: "solana", pairAddress: "abc", priceUsd: "1.00" }],
    };
    expect(boardComposeInputSchema.safeParse(input).success).toBe(false);
  });
});

describe("boardComposeInputSchema - bounds", () => {
  it("accepts 1 and 8 pools and refuses 0 and 9", () => {
    const pool = { chain: "solana", pairAddress: "abc" };
    for (const count of [1, 8]) {
      const input = { ...minimalInput(), pools: Array.from({ length: count }, () => pool) };
      expect(boardComposeInputSchema.safeParse(input).success).toBe(true);
    }
    for (const count of [0, 9]) {
      const input = { ...minimalInput(), pools: Array.from({ length: count }, () => pool) };
      expect(boardComposeInputSchema.safeParse(input).success).toBe(false);
    }
  });

  it("accepts 0 and 12 notes and refuses 13", () => {
    // 7 is in the table on purpose: a production board of 7 real notes was
    // refused whole under the old cap of 6, which is the defect that moved it.
    for (const count of [0, 6, 7, 12]) {
      const input = { ...minimalInput(), notes: Array.from({ length: count }, () => "n") };
      expect(boardComposeInputSchema.safeParse(input).success).toBe(true);
    }
    const tooMany = { ...minimalInput(), notes: Array.from({ length: 13 }, () => "n") };
    expect(boardComposeInputSchema.safeParse(tooMany).success).toBe(false);
  });

  it("accepts 0 and 12 annotations and refuses 13", () => {
    const annotation = { kind: "level", price: "1.0", label: "range high" };
    for (const count of [0, 12]) {
      const input = {
        ...minimalInput(),
        chart: {
          poolIndex: 0,
          resolution: "1h",
          annotations: Array.from({ length: count }, () => annotation),
        },
      };
      expect(boardComposeInputSchema.safeParse(input).success).toBe(true);
    }
    const tooMany = {
      ...minimalInput(),
      chart: {
        poolIndex: 0,
        resolution: "1h",
        annotations: Array.from({ length: 13 }, () => annotation),
      },
    };
    expect(boardComposeInputSchema.safeParse(tooMany).success).toBe(false);
  });

  it("bounds the title at 1 and 80 characters", () => {
    for (const [title, ok] of [["a", true], ["a".repeat(80), true], ["", false], ["a".repeat(81), false]] as const) {
      expect(boardComposeInputSchema.safeParse({ ...minimalInput(), title }).success).toBe(ok);
    }
  });

  it("bounds a caption at 1 and 140 characters", () => {
    for (const [caption, ok] of [["c", true], ["c".repeat(140), true], ["", false], ["c".repeat(141), false]] as const) {
      const input = { ...minimalInput(), pools: [{ chain: "solana", pairAddress: "abc", caption }] };
      expect(boardComposeInputSchema.safeParse(input).success).toBe(ok);
    }
  });

  it("bounds a note at 1 and 600 characters", () => {
    for (const [note, ok] of [["n", true], ["n".repeat(600), true], ["", false], ["n".repeat(601), false]] as const) {
      expect(boardComposeInputSchema.safeParse({ ...minimalInput(), notes: [note] }).success).toBe(ok);
    }
  });

  it("bounds an annotation label at 1 and 60 characters", () => {
    for (const [label, ok] of [["l", true], ["l".repeat(60), true], ["", false], ["l".repeat(61), false]] as const) {
      const annotation = { kind: "level", price: "1.0", label };
      expect(boardAnnotationSchema.safeParse(annotation).success).toBe(ok);
    }
  });

  it("bounds a chain slug at 1 and 32 characters and to its character class", () => {
    for (const [chain, ok] of [
      ["s", true],
      ["a".repeat(32), true],
      ["arbitrum-one", true],
      ["", false],
      ["a".repeat(33), false],
      ["Solana", false],
      ["sol ana", false],
      ["sol_ana", false],
      ["sol/ana", false],
    ] as const) {
      const input = { ...minimalInput(), pools: [{ chain, pairAddress: "abc" }] };
      expect(boardComposeInputSchema.safeParse(input).success).toBe(ok);
    }
  });

  it("bounds a pair address at 1 and 128 characters and to its character class", () => {
    for (const [pairAddress, ok] of [
      ["a", true],
      ["A".repeat(128), true],
      ["", false],
      ["a".repeat(129), false],
      ["0xdead-beef", false],
      ["../../etc/passwd", false],
      ["addr with space", false],
    ] as const) {
      const input = { ...minimalInput(), pools: [{ chain: "solana", pairAddress }] };
      expect(boardComposeInputSchema.safeParse(input).success).toBe(ok);
    }
  });

  it("bounds poolIndex against the actual pool count", () => {
    const pool = { chain: "solana", pairAddress: "abc" };
    const two = { ...minimalInput(), pools: [pool, pool] };
    expect(boardComposeInputSchema.safeParse({ ...two, chart: { poolIndex: 1, resolution: "1h" } }).success).toBe(true);
    const overshoot = boardComposeInputSchema.safeParse({
      ...two,
      chart: { poolIndex: 2, resolution: "1h" },
    });
    expect(overshoot.success).toBe(false);
    expect(overshoot.error?.issues[0]?.path).toEqual(["chart", "poolIndex"]);
    expect(boardComposeInputSchema.safeParse({ ...two, chart: { poolIndex: -1, resolution: "1h" } }).success).toBe(false);
  });

  it("bounds a marker to epoch milliseconds", () => {
    for (const [atMs, ok] of [
      [BOARD_MARKER_MIN_MS, true],
      [BOARD_MARKER_MAX_MS, true],
      [BOARD_MARKER_MIN_MS - 1, false],
      [BOARD_MARKER_MAX_MS + 1, false],
      [1_756_000_000, false], // seconds, the realistic mistake
      [1_756_000_000_000.5, false],
    ] as const) {
      const annotation = { kind: "marker", atMs, label: "entry" };
      expect(boardAnnotationSchema.safeParse(annotation).success).toBe(ok);
    }
  });
});

describe("prices are decimal strings, never numbers", () => {
  it("refuses a numeric price", () => {
    expect(boardAnnotationSchema.safeParse({ kind: "level", price: 1.5, label: "x" }).success).toBe(false);
  });

  it("accepts a sub-cent price to 1e-13 without loss", () => {
    const price = "0.0000000000001";
    const parsed = boardAnnotationSchema.parse({ kind: "level", price, label: "floor" });
    expect(parsed).toMatchObject({ price });
  });

  it("refuses exponent form, signs, and non-numeric text", () => {
    for (const price of ["1e-13", "-1.0", "+1.0", "1.", ".5", "1.2.3", "NaN", "Infinity", "0x1f", ""]) {
      expect(boardAnnotationSchema.safeParse({ kind: "level", price, label: "x" }).success).toBe(false);
    }
  });
});

describe("compareDecimalStrings", () => {
  it("orders values a double would collapse", () => {
    expect(compareDecimalStrings("0.00000000000012", "0.00000000000013")).toBe(-1);
    expect(compareDecimalStrings("0.00000000000013", "0.00000000000012")).toBe(1);
    expect(
      compareDecimalStrings("123456789012345678901234567890", "123456789012345678901234567891")
    ).toBe(-1);
  });

  it("ignores leading zeros and trailing fraction zeros", () => {
    expect(compareDecimalStrings("007", "7")).toBe(0);
    expect(compareDecimalStrings("1.50", "1.5")).toBe(0);
    expect(compareDecimalStrings("0", "0.0")).toBe(0);
  });

  it("orders by magnitude, not lexicographically", () => {
    expect(compareDecimalStrings("9", "10")).toBe(-1);
    expect(compareDecimalStrings("2", "10")).toBe(-1);
  });
});

describe("zone annotations", () => {
  it("requires priceFrom strictly below priceTo", () => {
    const base = { kind: "zone", label: "demand" };
    expect(boardAnnotationSchema.safeParse({ ...base, priceFrom: "1.0", priceTo: "2.0" }).success).toBe(true);
    expect(boardAnnotationSchema.safeParse({ ...base, priceFrom: "2.0", priceTo: "1.0" }).success).toBe(false);
    expect(boardAnnotationSchema.safeParse({ ...base, priceFrom: "1.0", priceTo: "1.00" }).success).toBe(false);
  });

  it("does not collapse a sub-cent band to equality", () => {
    const zone = {
      kind: "zone",
      priceFrom: "0.00000000000012",
      priceTo: "0.00000000000013",
      label: "demand",
    };
    expect(boardAnnotationSchema.safeParse(zone).success).toBe(true);
  });
});

describe("the reject-only text policy reaches every model-authored string", () => {
  const badTitle = (value: string) => ({ ...minimalInput(), title: value });
  const badCaption = (value: string) => ({
    ...minimalInput(),
    pools: [{ chain: "solana", pairAddress: "abc", caption: value }],
  });
  const badNote = (value: string) => ({ ...minimalInput(), notes: [value] });
  const badLabel = (value: string) => ({
    ...minimalInput(),
    chart: { poolIndex: 0, resolution: "1h", annotations: [{ kind: "level", price: "1.0", label: value }] },
  });

  it.each([
    ["title", badTitle],
    ["caption", badCaption],
    ["note", badNote],
    ["annotation label", badLabel],
  ])("rejects zero-width, bidi and tag characters in the %s", (_name, build) => {
    for (const injected of [ZWSP, RLO, TAG_A]) {
      const result = boardComposeInputSchema.safeParse(build(`USD${injected}C`));
      expect(result.success).toBe(false);
    }
  });

  it.each([
    ["title", badTitle],
    ["caption", badCaption],
    ["note", badNote],
    ["annotation label", badLabel],
  ])("accepts ordinary prose in the %s", (_name, build) => {
    // The negative cases above are only meaningful beside this one: the
    // predicate must refuse invisibles WITHOUT refusing the spaces,
    // punctuation and non-Latin scripts real analysis is written in.
    for (const value of ["USD C", "range high, then fade", "wsparcie 0,42", "阻力位"]) {
      expect(boardComposeInputSchema.safeParse(build(value)).success).toBe(true);
    }
  });

  it("rejects rather than strips, so nothing arrives modified", () => {
    const result = boardComposeInputSchema.safeParse(badTitle(`USD${ZWSP}C`));
    expect(result.success).toBe(false);
    expect(result.data).toBeUndefined();
  });

  it("names the field path and the class without echoing the bytes", () => {
    const result = boardComposeInputSchema.safeParse(badCaption(`hi${RLO}`));
    expect(result.success).toBe(false);
    const issue = result.error?.issues[0];
    expect(issue?.path).toEqual(["pools", 0, "caption"]);
    expect(issue?.message).toContain("bidi-control");
    expect(issue?.message).not.toContain(RLO);
  });

  it("rejects a newline in a single-line field and accepts one in a note", () => {
    expect(boardComposeInputSchema.safeParse(badTitle("one\ntwo")).success).toBe(false);
    expect(boardComposeInputSchema.safeParse(badCaption("one\ntwo")).success).toBe(false);
    expect(boardComposeInputSchema.safeParse(badLabel("one\ntwo")).success).toBe(false);
    expect(boardComposeInputSchema.safeParse(badNote("one\ntwo")).success).toBe(true);
  });

  it("rejects tab and carriage return everywhere, notes included", () => {
    expect(boardComposeInputSchema.safeParse(badNote("one\ttwo")).success).toBe(false);
    expect(boardComposeInputSchema.safeParse(badNote("one\rtwo")).success).toBe(false);
  });

  it("accepts an emoji built with a zero width joiner", () => {
    const family = "\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}";
    expect(boardComposeInputSchema.safeParse(badTitle(`family ${family}`)).success).toBe(true);
  });
});

describe("boardSpecV1Schema - the persisted document", () => {
  const spec = (overrides: Record<string, unknown> = {}) => ({
    version: 1,
    ...minimalInput(),
    hydration: hydrationFor(1, false),
    ...overrides,
  });

  it("accepts a hydrated board", () => {
    expect(boardSpecV1Schema.safeParse(spec()).success).toBe(true);
  });

  it("refuses a document without hydration", () => {
    const { hydration: _dropped, ...withoutHydration } = spec();
    expect(boardSpecV1Schema.safeParse(withoutHydration).success).toBe(false);
  });

  it("refuses a version other than 1, so a future writer fails closed", () => {
    expect(boardSpecV1Schema.safeParse(spec({ version: 2 })).success).toBe(false);
    expect(boardSpecV1Schema.safeParse(spec({ version: "1" })).success).toBe(false);
  });

  it("requires one hydrated row per pool", () => {
    const pool = { chain: "solana", pairAddress: "abc" };
    const mismatched = spec({ pools: [pool, pool], hydration: hydrationFor(1, false) });
    const result = boardSpecV1Schema.safeParse(mismatched);
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["hydration", "rows"]);
  });

  it("requires candles to be null when there is no chart, and to echo the resolution when there is", () => {
    expect(boardSpecV1Schema.safeParse(spec({ hydration: hydrationFor(1, true) })).success).toBe(false);
    expect(
      boardSpecV1Schema.safeParse(
        spec({ chart: { poolIndex: 0, resolution: "1h" }, hydration: hydrationFor(1, true) })
      ).success
    ).toBe(true);
    expect(
      boardSpecV1Schema.safeParse(
        spec({ chart: { poolIndex: 0, resolution: "5m" }, hydration: hydrationFor(1, true) })
      ).success
    ).toBe(false);
  });

  it("treats a hydration field as required-and-nullable, never optional", () => {
    const hydration = hydrationFor(1, false) as { rows: Record<string, unknown>[] };
    const nulled = structuredClone(hydration);
    nulled.rows[0] = { ...nulled.rows[0], priceUsd: null, liquidityUsd: null, pairAgeSeconds: null };
    expect(boardSpecV1Schema.safeParse(spec({ hydration: nulled })).success).toBe(true);

    const missing = structuredClone(hydration) as { rows: Record<string, unknown>[] };
    delete missing.rows[0]?.priceUsd;
    expect(boardSpecV1Schema.safeParse(spec({ hydration: missing })).success).toBe(false);
  });

  it("binds the unmatched-marker verdict to the chart's OWN markers", () => {
    const chart = {
      poolIndex: 0,
      resolution: "1h",
      annotations: [
        { kind: "marker", atMs: 1_756_000_000_000, label: "entry" },
        { kind: "marker", atMs: 1_756_000_003_000, label: "off-grid" },
      ],
    };
    const withVerdict = (unmatchedMarkerAtMs: unknown) =>
      spec({
        chart,
        hydration: { ...(hydrationFor(1, true) as object), unmatchedMarkerAtMs },
      });

    // The honest verdicts: none unmatched, or the marker that really missed.
    expect(boardSpecV1Schema.safeParse(withVerdict([])).success).toBe(true);
    expect(
      boardSpecV1Schema.safeParse(withVerdict([1_756_000_003_000])).success,
    ).toBe(true);

    // An instant no marker on this chart claims would omit the WRONG
    // annotation from the canvas.
    const foreign = boardSpecV1Schema.safeParse(withVerdict([1_700_000_000_000]));
    expect(foreign.success).toBe(false);
    expect(foreign.error?.issues[0]?.path).toEqual([
      "hydration",
      "unmatchedMarkerAtMs",
    ]);

    // A chart with no verdict at all never went through the membership check.
    const unchecked = boardSpecV1Schema.safeParse(withVerdict(null));
    expect(unchecked.success).toBe(false);
    expect(unchecked.error?.issues[0]?.message).toContain("matched no candle");

    // And a board with no chart cannot carry a verdict about markers it has
    // no place to draw.
    const noChart = boardSpecV1Schema.safeParse(
      spec({
        hydration: {
          ...(hydrationFor(1, false) as object),
          unmatchedMarkerAtMs: [],
        },
      }),
    );
    expect(noChart.success).toBe(false);
  });

  it("pins the v1 staleness horizon", () => {
    const hydration = { ...(hydrationFor(1, false) as object), staleAfterMs: 30_000 };
    expect(boardSpecV1Schema.safeParse(spec({ hydration })).success).toBe(false);
    expect(BOARD_STALE_AFTER_MS).toBe(60_000);
  });

  it("refuses model-authored text that would arrive through a durable row", () => {
    expect(boardSpecV1Schema.safeParse(spec({ title: `USD${ZWSP}C` })).success).toBe(false);
  });

  it("bounds the candle series at 200 bars", () => {
    const bar = { tMs: 1_756_000_000_000, o: "1.0", h: "1.2", l: "0.9", c: "1.1" };
    const build = (count: number) => ({
      ...(hydrationFor(1, true) as object),
      candles: {
        bars: Array.from({ length: count }, () => bar),
        lastBarPartial: false,
        coveredRange: { fromMs: 1_756_000_000_000, toMs: 1_756_000_060_000 },
        resolution: "1h",
        truncated: count === 200,
      },
    });
    const chart = { poolIndex: 0, resolution: "1h" };
    expect(boardSpecV1Schema.safeParse(spec({ chart, hydration: build(200) })).success).toBe(true);
    expect(boardSpecV1Schema.safeParse(spec({ chart, hydration: build(201) })).success).toBe(false);
  });
});

describe("the serialized byte budget", () => {
  it("measures UTF-8 bytes of the stored JSON", () => {
    const result = checkBoardSpecByteBudget({ a: "é" });
    expect(result.byteLength).toBe(JSON.stringify({ a: "é" }).length + 1);
    expect(result.maxBytes).toBe(BOARD_SPEC_MAX_BYTES);
  });

  it("is inclusive at the limit and refuses one byte past it", () => {
    const pad = (bytes: number) => ({ n: "a".repeat(bytes) });
    const overhead = checkBoardSpecByteBudget(pad(0)).byteLength;
    expect(checkBoardSpecByteBudget(pad(BOARD_SPEC_MAX_BYTES - overhead)).withinBudget).toBe(true);
    const over = checkBoardSpecByteBudget(pad(BOARD_SPEC_MAX_BYTES - overhead + 1));
    expect(over.withinBudget).toBe(false);
    expect(over.byteLength).toBe(BOARD_SPEC_MAX_BYTES + 1);
  });

  it("counts a non-Latin script by its real byte cost, not its character count", () => {
    const cyrillic = checkBoardSpecByteBudget({ n: "д".repeat(1000) });
    const latin = checkBoardSpecByteBudget({ n: "d".repeat(1000) });
    expect(cyrillic.byteLength).toBeGreaterThan(latin.byteLength);
  });

  it("refuses by naming the measured size, and says nothing was truncated", () => {
    const message = describeBoardByteBudgetFailure({
      withinBudget: false,
      byteLength: 270_000,
      maxBytes: BOARD_SPEC_MAX_BYTES,
      largestPool: null,
    });
    expect(message).toContain("270000");
    expect(message).toContain(String(BOARD_SPEC_MAX_BYTES));
    expect(message).toContain("nothing was truncated");
  });

  it("names the heaviest pool so the model knows which assessment to shorten", () => {
    const message = describeBoardByteBudgetFailure({
      withinBudget: false,
      byteLength: 270_000,
      maxBytes: BOARD_SPEC_MAX_BYTES,
      largestPool: { index: 3, byteLength: 44_000 },
    });
    expect(message).toContain("pool 3");
    expect(message).toContain("44000");
    expect(message).toContain("nothing was truncated");
  });

  describe("the heaviest pool", () => {
    function boardOf(pools: readonly unknown[], rows: readonly unknown[]): unknown {
      return { version: 1, title: "t", pools, hydration: { rows } };
    }

    it("charges a pool its authored entry PLUS its own hydration row", () => {
      // The row is what makes a pool expensive in practice (token names), so a
      // weight that counted only the authored entry would point at the wrong
      // pool whenever one row carries a long name.
      const result = checkBoardSpecByteBudget(
        boardOf(
          [{ analysis: "a".repeat(10) }, { analysis: "b".repeat(10) }],
          [{ n: "x".repeat(10) }, { n: "y".repeat(400) }],
        ),
      );
      expect(result.largestPool?.index).toBe(1);
    });

    it.each([
      ["the only pool", [{ a: "a".repeat(50) }], [], 0],
      ["the last pool", [{ a: "a" }, { a: "a" }, { a: "a".repeat(80) }], [], 2],
      ["the first pool", [{ a: "a".repeat(80) }, { a: "a" }], [], 0],
    ])("picks %s", (_label, pools, rows, expected) => {
      expect(checkBoardSpecByteBudget(boardOf(pools, rows)).largestPool?.index).toBe(
        expected,
      );
    });

    it("resolves a tie to the lowest index, so the figure is deterministic", () => {
      const pools = [{ a: "a".repeat(50) }, { a: "b".repeat(50) }];
      expect(checkBoardSpecByteBudget(boardOf(pools, [])).largestPool?.index).toBe(0);
    });

    it.each([
      ["a value that is not an object", 42],
      ["an object with no pools key", { version: 1 }],
      ["a pools value that is not an array", { pools: "eight" }],
      ["an empty pools array", { pools: [] }],
    ])("reports no pool for %s, rather than throwing", (_label, candidate) => {
      // This helper runs on values that have not necessarily parsed: the DB
      // mapper measures a durable row, and a measurement must never be the
      // thing that fails on a malformed document.
      expect(checkBoardSpecByteBudget(candidate).largestPool).toBeNull();
    });

    it("survives a hydration block shorter than the pools array", () => {
      const result = checkBoardSpecByteBudget(
        boardOf([{ a: "a" }, { a: "a".repeat(90) }], [{ n: "x" }]),
      );
      expect(result.largestPool?.index).toBe(1);
    });
  });
});


/**
 * THE ICON HANDLE, and the compatibility it exists to preserve.
 *
 * `iconId` is the one field on the hydrated row that is optional rather than
 * required-and-nullable. That asymmetry is a durable-data decision: boards
 * composed before the field existed are ALREADY PERSISTED in transcript rows,
 * and this schema is what re-parses them on every read. The first test below is
 * the regression that goes red the moment someone "tidies" the field into a
 * required one - and red there means every board already in a user's history
 * renders as nothing.
 */
describe("hydrated row - the token icon handle", () => {
  function rowWith(iconId: unknown): unknown {
    const hydration = hydrationFor(1, false) as {
      rows: Array<Record<string, unknown>>;
    };
    const row = hydration.rows[0] as Record<string, unknown>;
    row["iconId"] = iconId;
    return hydration;
  }

  function specWith(hydration: unknown): unknown {
    return { version: 1, ...minimalInput(), hydration };
  }

  it("parses a legacy row that carries no iconId key at all, and reads it as null", () => {
    // `hydrationFor` deliberately builds the PRE-FIELD row shape, which is
    // exactly what a durable v1 board holds.
    const parsed = boardSpecV1Schema.safeParse(specWith(hydrationFor(1, false)));
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const row = parsed.data.hydration.rows[0];
    expect(row).toBeDefined();
    // The reader gets a definite "no icon", never `undefined`, so no consumer
    // has to know the field was once absent.
    expect(row?.iconId).toBeNull();
    expect(row !== undefined && "iconId" in row).toBe(true);
  });

  it("accepts an explicit null, which is what every writer emits when there is no icon", () => {
    const parsed = boardSpecV1Schema.safeParse(specWith(rowWith(null)));
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.hydration.rows[0]?.iconId).toBeNull();
  });

  it("accepts a provider-shaped handle verbatim", () => {
    const parsed = boardSpecV1Schema.safeParse(specWith(rowWith("Ab3-_zZ09")));
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.hydration.rows[0]?.iconId).toBe("Ab3-_zZ09");
  });

  it("accepts the handle at both length bounds", () => {
    expect(boardSpecV1Schema.safeParse(specWith(rowWith("abcd"))).success).toBe(true);
    expect(
      boardSpecV1Schema.safeParse(specWith(rowWith("a".repeat(128)))).success,
    ).toBe(true);
  });

  it.each([
    ["one character under the minimum", "abc"],
    ["one character over the maximum", "a".repeat(129)],
    ["a path separator", "abc/def"],
    ["a parent-directory hop", "../secrets"],
    ["a dot, which would let a handle end in a file extension", "icon.png"],
    ["an absolute URL", "https://evil.example/x"],
    ["a protocol-relative URL", "//evil.example/x"],
    ["a query string that would re-point the CDN parameters", "abcd?width=99999"],
    ["whitespace", "ab cd"],
    ["a percent escape", "abcd%2Fef"],
    ["an embedded NUL", "abc\u0000d"],
    ["a newline", "abcd\nefgh"],
    ["the empty string", ""],
    ["a number rather than a string", 1234],
  ])("refuses %s", (_label, iconId) => {
    expect(boardSpecV1Schema.safeParse(specWith(rowWith(iconId))).success).toBe(false);
  });

  it("keeps a full board of icon-bearing rows far inside the byte budget", () => {
    // The field's COST is the thing to prove: 8 pools, each with a maximum
    // length handle, must not push a realistic board anywhere near a refusal.
    const pools = Array.from({ length: BOARD_MAX_POOLS }, (_unused, index) => ({
      chain: "solana",
      pairAddress: `pool${index}${"a".repeat(40)}`,
      caption: "Holding the range it broke out of.",
    }));
    const hydration = hydrationFor(BOARD_MAX_POOLS, false) as {
      rows: Array<Record<string, unknown>>;
    };
    for (const row of hydration.rows) row["iconId"] = "i".repeat(128);
    const spec = { version: 1, title: "SOL majors", pools, hydration };

    expect(boardSpecV1Schema.safeParse(spec).success).toBe(true);
    const budget = checkBoardSpecByteBudget(spec);
    expect(budget.withinBudget).toBe(true);
    // Stated as a real ratio rather than "it fits": the handles must be a
    // rounding error against the 256 KiB ceiling, not a squeeze past it.
    expect(budget.byteLength).toBeLessThan(BOARD_SPEC_MAX_BYTES / 2);
  });
});

describe("per-pool analysis - the model's own assessment", () => {
  function poolWith(analysis: unknown): unknown {
    return {
      ...minimalInput(),
      pools: [
        {
          chain: "solana",
          pairAddress: "58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2",
          ...(analysis === undefined ? {} : { analysis }),
        },
      ],
    };
  }

  it("reads a legacy pool that carries no analysis key at all as null", () => {
    // A durable board written before the field existed. It must still parse:
    // a parse failure here is a board that silently vanishes from a
    // transcript the user can still see.
    const parsed = boardComposeInputSchema.safeParse(minimalInput());
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const pool = parsed.data.pools[0];
    expect(pool?.analysis).toBeNull();
    expect(pool !== undefined && "analysis" in pool).toBe(true);
  });

  it("carries the legacy normalization through the ASSEMBLED persisted document", () => {
    const spec = boardSpecV1Schema.safeParse({
      version: 1,
      ...minimalInput(),
      hydration: hydrationFor(1, false),
    });
    expect(spec.success).toBe(true);
    if (!spec.success) return;
    expect(spec.data.pools[0]?.analysis).toBeNull();
  });

  it("accepts an explicit null, which is what a writer emits for a pool it said nothing about", () => {
    const parsed = boardComposeInputSchema.safeParse(poolWith(null));
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.pools[0]?.analysis).toBeNull();
  });

  it("keeps a full assessment verbatim, line breaks included", () => {
    const text = "Safety checks are clean.\nVolume is accelerating into the 24h high.";
    const parsed = boardComposeInputSchema.safeParse(poolWith(text));
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.pools[0]?.analysis).toBe(text);
  });

  it("accepts 10000 characters and refuses 10001", () => {
    // The bound exists only to keep a legal board a STORABLE one; it is a
    // refusal threshold, not a length the model should be writing towards.
    expect(
      boardComposeInputSchema.safeParse(poolWith("a".repeat(10_000))).success,
    ).toBe(true);
    expect(
      boardComposeInputSchema.safeParse(poolWith("a".repeat(10_001))).success,
    ).toBe(false);
  });

  it("refuses the empty string rather than storing an assessment that says nothing", () => {
    expect(boardComposeInputSchema.safeParse(poolWith("")).success).toBe(false);
  });

  it.each([
    ["a zero-width character", `clean${ZWSP}checks`],
    ["a bidi override", `clean${RLO}checks`],
    ["a unicode tag character", `clean${TAG_A}checks`],
    ["a carriage return", "clean\rchecks"],
    ["a tab", "clean\tchecks"],
  ])("refuses %s, and refuses rather than cleaning it", (_label, value) => {
    const parsed = boardComposeInputSchema.safeParse(poolWith(value));
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    // The message names the class and never echoes the payload back into a
    // model-visible and reader-visible string.
    const message = parsed.error.issues.map((issue) => issue.message).join(" ");
    expect(message).not.toContain(value);
  });

  it("refuses a non-string", () => {
    expect(boardComposeInputSchema.safeParse(poolWith(42)).success).toBe(false);
  });

  it("counts code points, so an emoji costs one character of the budget", () => {
    // 10000 astral code points is 20000 UTF-16 units: a length check written
    // against `String.prototype.length` would refuse this.
    const emoji = "\u{1F680}".repeat(10_000);
    expect(boardComposeInputSchema.safeParse(poolWith(emoji)).success).toBe(true);
  });

  it.each([
    ["latin prose, one byte per character", "a"],
    ["a two-byte script, which is what the budget is sized against", "\u0434"],
  ])(
    "stays inside the 256 KiB document budget at the worst case the bounds admit (%s)",
    (_label, filler) => {
    // Eight pools, each with the longest assessment and the longest caption
    // the contract allows, plus a full hydration. The budget is a REFUSAL
    // threshold, so the point of this case is that a board of eight FULLY
    // written assessments, WITH a chart, cannot be made unpresentable by its
    // own length.
    const pools = Array.from({ length: BOARD_MAX_POOLS }, () => ({
      chain: "solana",
      pairAddress: "58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2",
      caption: "c".repeat(140),
      analysis: filler.repeat(10_000),
    }));
    const spec = boardSpecV1Schema.safeParse({
      version: 1,
      title: "SOL majors",
      pools,
      hydration: hydrationFor(BOARD_MAX_POOLS, false),
    });
    expect(spec.success).toBe(true);
    if (!spec.success) return;
    const budget = checkBoardSpecByteBudget(spec.data);
    expect(budget.withinBudget).toBe(true);
    expect(budget.byteLength).toBeLessThan(BOARD_SPEC_MAX_BYTES);
  },
  );

  it("stays inside the budget with eight full assessments AND a full chart", () => {
    // The exact combination the budget doc claims fits: 8 x 10000 two-byte
    // assessments (160,000 bytes) plus the authored rest plus a 200-bar series
    // of maximum-width decimal strings. The previous budget refused this, and
    // the whole point of raising it was that a fully written board with a
    // chart is a board a user should be able to keep.
    const pools = Array.from({ length: BOARD_MAX_POOLS }, () => ({
      chain: "solana",
      pairAddress: "58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2",
      caption: "c".repeat(140),
      analysis: "\u0434".repeat(10_000),
    }));
    const hydration = hydrationFor(BOARD_MAX_POOLS, true) as Record<string, unknown>;
    const spec = boardSpecV1Schema.safeParse({
      version: 1,
      title: "SOL majors",
      pools,
      chart: { poolIndex: 0, resolution: "1h" },
      hydration: {
        ...hydration,
        unmatchedMarkerAtMs: [],
        candles: {
          bars: Array.from({ length: BOARD_MAX_CANDLES }, (_unused, i) => ({
            tMs: 1_756_000_000_000 + i * 3_600_000,
            o: `1.${"9".repeat(38)}`,
            h: `2.${"9".repeat(38)}`,
            l: `0.${"9".repeat(38)}`,
            c: `1.${"8".repeat(38)}`,
          })),
          lastBarPartial: false,
          coveredRange: { fromMs: 1_756_000_000_000, toMs: 1_756_716_400_000 },
          resolution: "1h",
          truncated: true,
        },
      },
    });
    expect(spec.success).toBe(true);
    if (!spec.success) return;
    const budget = checkBoardSpecByteBudget(spec.data);
    expect(budget.withinBudget).toBe(true);
  });
});

describe("the hydrated row's provider description", () => {
  function rowWith(description: unknown): Record<string, unknown> {
    const hydration = hydrationFor(1, false) as { rows: Array<Record<string, unknown>> };
    const row = hydration.rows[0];
    if (row === undefined) throw new Error("hydration fixture row 0 missing");
    if (description === undefined) delete row["description"];
    else row["description"] = description;
    return { version: 1, ...minimalInput(), hydration };
  }

  it("reads a legacy row that carries no description key at all as null", () => {
    // The expand half of an expand-and-contract, exactly as `iconId` is. A
    // board persisted before this field existed must still PARSE; a required
    // key would render each of those rows as a board that silently vanished.
    const parsed = boardSpecV1Schema.safeParse(rowWith(undefined));
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const row = parsed.data.hydration.rows[0];
    expect(row?.description).toBeNull();
    expect(row !== undefined && "description" in row).toBe(true);
  });

  it("carries the provider's real blurb through the persisted document, whole", () => {
    const blurb =
      "VEX is a self custodial AI agent runtime for onchain finance. "
      + "Accessible. Verifiable. Tradable.";
    const parsed = boardSpecV1Schema.safeParse(rowWith(blurb));
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.hydration.rows[0]?.description).toBe(blurb);
  });

  it("accepts an explicit null, which is what a writer emits for a token with no blurb", () => {
    const parsed = boardSpecV1Schema.safeParse(rowWith(null));
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.hydration.rows[0]?.description).toBeNull();
  });

  it("allows the paragraph breaks a CMS blurb really carries", () => {
    const twoParagraphs = "VEX is an agent runtime.\n\nIt signs locally.";
    expect(boardSpecV1Schema.safeParse(rowWith(twoParagraphs)).success).toBe(true);
  });

  it("accepts 1000 code points and refuses 1001, rather than cutting one", () => {
    expect(boardSpecV1Schema.safeParse(rowWith("a".repeat(1000))).success).toBe(true);
    expect(boardSpecV1Schema.safeParse(rowWith("a".repeat(1001))).success).toBe(false);
  });

  it.each([
    ["a zero-width character", `VEX${ZWSP}runtime`],
    ["a bidi override", `VEX${RLO}runtime`],
    ["a unicode tag character", `VEX${TAG_A}runtime`],
    ["a carriage return", "VEX\rruntime"],
    ["a tab", "VEX\truntime"],
    ["the empty string", ""],
    ["a non-string", 42],
  ])("refuses provider prose carrying %s", (_label, value) => {
    // UNTRUSTED PROVIDER TEXT held to the same forbidden-code-point table as
    // the model's own prose, and refused rather than cleaned.
    expect(boardSpecV1Schema.safeParse(rowWith(value)).success).toBe(false);
  });
});
