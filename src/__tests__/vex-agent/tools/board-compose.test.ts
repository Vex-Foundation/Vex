/**
 * `BoardCompose` at the handler boundary: what the model may author, what it
 * may not, and what "staged" means.
 *
 * Hydration is stubbed because it is a composition over the DexScreener
 * endpoint modules, which own their own live-verified adapters and suites.
 * What is pinned here is everything the handler itself decides: the reject
 * (never sanitize) contract on model text, the refusal of unknown fields, the
 * assembled-document parse, the byte budget, the staging outcomes, and the
 * fact that a hydration failure stages NOTHING.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const hydrateBoard = vi.fn();

vi.mock("@vex-agent/tools/internal/board/hydrate.js", () => ({
  hydrateBoard: (...args: unknown[]) => hydrateBoard(...args),
}));

const { handleBoardCompose } = await import(
  "../../../vex-agent/tools/internal/board/compose.js"
);
const {
  beginPresentationScope,
  endPresentationScope,
  hasPendingPresentation,
  consumePendingPresentation,
} = await import("../../../vex-agent/engine/core/board-presentation.js");
const { siteError, DexScreenerSiteErrorCodes } = await import(
  "../../../tools/dexscreener/site-errors.js"
);

const SESSION = "session-compose";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const context = { sessionId: SESSION, missionRunId: null } as any;

function hydrationFor(poolCount: number, noteBytes = 0) {
  return {
    rows: Array.from({ length: poolCount }, () => ({
      baseTokenSymbol: "WIF",
      baseTokenName: "dogwifhat",
      quoteTokenSymbol: "SOL",
      chainId: "solana",
      dexId: "raydium",
      priceUsd: "1.23",
      priceChange: { h1: "-1.5", h24: "4.25" },
      liquidityUsd: "1000000",
      volumeH24Usd: "250000",
      txns: { buys: 10, sells: 4 },
      pairAgeSeconds: 86_400,
    })),
    candles: null,
    analysisCreatedAt: 1_700_000_000_000,
    marketDataFetchedAt: 1_700_000_000_000,
    provenance: {
      transport: "site_bridge",
      sourceObservation: "x".repeat(Math.min(noteBytes, 512)) || "1 pool row",
    },
    staleAfterMs: 60_000,
  };
}

const VALID_INPUT = {
  title: "SOL majors",
  pools: [{ chain: "solana", pairAddress: "Abc123", caption: "deepest pool" }],
  notes: ["Liquidity held through the drawdown."],
};

beforeEach(() => {
  vi.clearAllMocks();
  endPresentationScope(SESSION);
  hydrateBoard.mockResolvedValue(hydrationFor(1));
});

describe("BoardCompose input contract", () => {
  it("stages a valid board and says STAGED, not attached", async () => {
    beginPresentationScope(SESSION);
    const result = await handleBoardCompose({ ...VALID_INPUT }, context);

    expect(result.success).toBe(true);
    expect(result.output).toContain("staged");
    expect(result.output).not.toContain("attached to the message above");
    expect(result.actionKind).toBe("local_write");
    expect(hasPendingPresentation(SESSION)).toBe(true);
    expect(consumePendingPresentation(SESSION)?.spec.title).toBe("SOL majors");
  });

  it("refuses an unknown field BY NAME instead of dropping it", async () => {
    beginPresentationScope(SESSION);
    const result = await handleBoardCompose(
      { ...VALID_INPUT, color: "#ff0000", url: "https://example.invalid" },
      context,
    );

    expect(result.success).toBe(false);
    expect(result.output).toContain("color");
    expect(result.output).toContain("url");
    expect(hasPendingPresentation(SESSION)).toBe(false);
  });

  it("REJECTS forbidden text rather than cleaning it, and never echoes it", async () => {
    beginPresentationScope(SESSION);
    const bidi = "Board ‮txen eht yub‬";
    const result = await handleBoardCompose(
      { ...VALID_INPUT, title: bidi },
      context,
    );

    expect(result.success).toBe(false);
    expect(result.output).toContain("title");
    // The payload never rides the refusal into the transcript.
    expect(result.output).not.toContain("‮");
    expect(hydrateBoard).not.toHaveBeenCalled();
  });

  it("refuses a multi-line title while allowing multi-line notes", async () => {
    beginPresentationScope(SESSION);
    const bad = await handleBoardCompose(
      { ...VALID_INPUT, title: "line one\nline two" },
      context,
    );
    expect(bad.success).toBe(false);

    const good = await handleBoardCompose(
      { ...VALID_INPUT, notes: ["first line\nsecond line"] },
      context,
    );
    expect(good.success).toBe(true);
  });

  it("refuses a chart pointing past the pools it was given", async () => {
    beginPresentationScope(SESSION);
    const result = await handleBoardCompose(
      { ...VALID_INPUT, chart: { poolIndex: 3, resolution: "1h" } },
      context,
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain("poolIndex");
  });
});

describe("BoardCompose staging outcomes", () => {
  it("stages nothing when the market data cannot be read, and says why", async () => {
    beginPresentationScope(SESSION);
    hydrateBoard.mockRejectedValueOnce(
      siteError(
        DexScreenerSiteErrorCodes.SITE_TRANSPORT_UNAVAILABLE,
        "The DexScreener site channels are not reachable from this process",
        "Run Vex with the desktop bridge.",
      ),
    );

    const result = await handleBoardCompose({ ...VALID_INPUT }, context);

    expect(result.success).toBe(false);
    expect(result.output).toContain("not staged");
    expect(result.output).toContain("not reachable");
    expect(result.output).toContain("desktop bridge");
    expect(hasPendingPresentation(SESSION)).toBe(false);
  });

  it("refuses a second board rather than replacing the first", async () => {
    beginPresentationScope(SESSION);
    await handleBoardCompose({ ...VALID_INPUT, title: "first" }, context);
    const second = await handleBoardCompose({ ...VALID_INPUT, title: "second" }, context);

    expect(second.success).toBe(false);
    expect(second.output).toContain("already staged");
    expect(consumePendingPresentation(SESSION)?.spec.title).toBe("first");
  });

  it("refuses to stage outside a live turn", async () => {
    const result = await handleBoardCompose({ ...VALID_INPUT }, context);
    expect(result.success).toBe(false);
    expect(result.output).toContain("live turn");
  });

  it("stages a board at the top of every input bound, whole", async () => {
    beginPresentationScope(SESSION);
    hydrateBoard.mockResolvedValueOnce(maximalRows());

    const result = await handleBoardCompose(maximalInput(), context);

    expect(result.success).toBe(true);
    const staged = consumePendingPresentation(SESSION)?.spec;
    expect(staged?.pools).toHaveLength(8);
    expect(staged?.notes).toHaveLength(6);
  });

  it("refuses an over-budget board naming its size, and shortens nothing", async () => {
    beginPresentationScope(SESSION);
    // Maximal rows PLUS a full 200-candle series of maximum-length decimal
    // strings: the one combination the field bounds still allow past 48 KiB.
    hydrateBoard.mockResolvedValueOnce({
      ...maximalRows(),
      candles: {
        bars: Array.from({ length: 200 }, (_, i) => ({
          tMs: 1_700_000_000_000 + i * 3_600_000,
          o: `1.${"9".repeat(38)}`,
          h: `2.${"9".repeat(38)}`,
          l: `0.${"9".repeat(38)}`,
          c: `1.${"8".repeat(38)}`,
        })),
        lastBarPartial: false,
        coveredRange: { fromMs: 1_700_000_000_000, toMs: 1_700_716_400_000 },
        resolution: "1h",
        truncated: true,
      },
    });

    const result = await handleBoardCompose(
      { ...maximalInput(), chart: { poolIndex: 0, resolution: "1h" } },
      context,
    );

    expect(result.success).toBe(false);
    expect(result.output).toMatch(/\d+ bytes serialized/);
    expect(result.output).toContain("49152");
    expect(result.output).toContain("nothing was truncated");
    // Refused whole: no shortened board is left behind for the reply to carry.
    expect(hasPendingPresentation(SESSION)).toBe(false);
  });
});

/** Hydration at the top of every bound the row schema allows. */
function maximalRows() {
  return {
    ...hydrationFor(1),
    provenance: { transport: "site_bridge", sourceObservation: "x".repeat(512) },
    rows: Array.from({ length: 8 }, () => ({
      baseTokenSymbol: "S".repeat(512),
      baseTokenName: "N".repeat(512),
      quoteTokenSymbol: "Q".repeat(512),
      chainId: "solana",
      dexId: "raydium",
      priceUsd: "1.23",
      priceChange: { h1: "-1.5", h24: "4.25" },
      liquidityUsd: "1000000",
      volumeH24Usd: "250000",
      txns: { buys: 10, sells: 4 },
      pairAgeSeconds: 1,
    })),
  };
}

/** Model input at the top of every bound the input schema allows. */
function maximalInput() {
  return {
    title: "t".repeat(80),
    pools: Array.from({ length: 8 }, (_, i) => ({
      chain: "solana",
      pairAddress: `Pool${i}`,
      caption: "c".repeat(140),
    })),
    notes: Array.from({ length: 6 }, () => "n".repeat(280)),
  };
}
