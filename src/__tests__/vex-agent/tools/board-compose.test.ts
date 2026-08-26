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

import { makeTestContext } from "./_test-context.js";
import { BOARD_SPEC_MAX_BYTES } from "../../../lib/board/index.js";

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

/**
 * The context a HOST builds - `runTool`, an approval cold resume, a sync job.
 * None of them carries the model-origin provenance, which is exactly the
 * conservative default BoardCompose's gate reads. Built through the shared
 * factory so a new required field on the live `InternalToolContext` contract
 * breaks the compiler here rather than passing silently.
 */
const hostContext = makeTestContext({ sessionId: SESSION });

/**
 * The context the turn loop builds for a call the MODEL emitted.
 * `buildToolContext` in `engine/core/turn-loop-tool-batch/execute.ts` is the
 * only producer of `modelOriginated`, and it is the provenance BoardCompose
 * requires before it will spend a provider byte.
 */
const modelContext = makeTestContext({
  sessionId: SESSION,
  modelOriginated: true,
});

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
    unmatchedMarkerAtMs: null,
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
    const result = await handleBoardCompose({ ...VALID_INPUT }, modelContext);

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
      modelContext,
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
      modelContext,
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
      modelContext,
    );
    expect(bad.success).toBe(false);

    const good = await handleBoardCompose(
      { ...VALID_INPUT, notes: ["first line\nsecond line"] },
      modelContext,
    );
    expect(good.success).toBe(true);
  });

  it("refuses a chart pointing past the pools it was given", async () => {
    beginPresentationScope(SESSION);
    const result = await handleBoardCompose(
      { ...VALID_INPUT, chart: { poolIndex: 3, resolution: "1h" } },
      modelContext,
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain("poolIndex");
  });
});

/**
 * MISSION SETUP CANNOT PRESENT (owner decision K5, 2026-08-26).
 *
 * `registry/board.ts` hides `BoardCompose` in mission setup, but a catalog
 * filter is visibility, not enforcement: a stale tools array or a model that
 * remembers the name from an earlier turn still emits the call. Setup is
 * Capability Orientation, and this handler reads live market data on every
 * call, so it refuses there itself. These cases are what go red if the handler
 * gate is removed and only the registry flag is left.
 */
describe("BoardCompose mode gate", () => {
  const setupContext = makeTestContext({
    sessionId: SESSION,
    sessionKind: "mission",
    missionRunId: null,
    modelOriginated: true,
  });
  const runContext = makeTestContext({
    sessionId: SESSION,
    sessionKind: "mission",
    missionRunId: "run-1",
    modelOriginated: true,
  });

  it("refuses in mission setup, before reading any market data", async () => {
    beginPresentationScope(SESSION);
    const result = await handleBoardCompose({ ...VALID_INPUT }, setupContext);

    expect(result.success).toBe(false);
    expect(result.output).toContain("mission setup");
    // The refusal names the real cause and the way forward rather than being an
    // unexpected error, and it costs the provider nothing.
    expect(result.output).toContain("Nothing was staged and no market data was read");
    expect(hydrateBoard).not.toHaveBeenCalled();
    expect(hasPendingPresentation(SESSION)).toBe(false);
  });

  it("allows an ACTIVE mission run, which is not setup", async () => {
    beginPresentationScope(SESSION);
    const result = await handleBoardCompose({ ...VALID_INPUT }, runContext);

    expect(result.success).toBe(true);
    expect(hasPendingPresentation(SESSION)).toBe(true);
    consumePendingPresentation(SESSION);
  });

  it("the registry hides it in mission setup too, so the two gates agree", async () => {
    const { getToolDef } = await import("@vex-agent/tools/registry.js");
    expect(getToolDef("BoardCompose")?.visibility?.hiddenInMissionSetup).toBe(true);
  }, 30_000);
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

    const result = await handleBoardCompose({ ...VALID_INPUT }, modelContext);

    expect(result.success).toBe(false);
    expect(result.output).toContain("not staged");
    expect(result.output).toContain("not reachable");
    expect(result.output).toContain("desktop bridge");
    expect(hasPendingPresentation(SESSION)).toBe(false);
  });

  it("refuses a second board rather than replacing the first", async () => {
    beginPresentationScope(SESSION);
    await handleBoardCompose({ ...VALID_INPUT, title: "first" }, modelContext);
    const second = await handleBoardCompose({ ...VALID_INPUT, title: "second" }, modelContext);

    expect(second.success).toBe(false);
    expect(second.output).toContain("already staged");
    expect(consumePendingPresentation(SESSION)?.spec.title).toBe("first");
  });

  it("refuses a host-built direct dispatch even while a live turn's scope is open", async () => {
    // The bypass this closes: `runTool` dispatches any tool with a host-built
    // context and never crosses the engine's pre-dispatch presentation gate.
    // With a normal turn's scope open, a direct BoardCompose would otherwise
    // stage into that turn and be consumed by unrelated model prose.
    beginPresentationScope(SESSION);

    const result = await handleBoardCompose({ ...VALID_INPUT }, hostContext);

    expect(result.success).toBe(false);
    expect(result.output).toContain("nothing was staged");
    expect(hasPendingPresentation(SESSION)).toBe(false);
    // Refused BEFORE hydration: no provider byte was spent on it.
    expect(hydrateBoard).not.toHaveBeenCalled();
  });

  it("refuses to stage outside a live turn", async () => {
    const result = await handleBoardCompose({ ...VALID_INPUT }, modelContext);
    expect(result.success).toBe(false);
    expect(result.output).toContain("live turn");
  });

  it("ALWAYS emits the per-pool analysis key, null included", async () => {
    // The write half of the expand-and-contract: durable boards written from
    // now on are explicit about having no assessment, so no reader has to know
    // the field was once absent. A staged board that omitted the key would
    // leave the legacy default doing work forever.
    beginPresentationScope(SESSION);
    await handleBoardCompose({ ...VALID_INPUT }, modelContext);

    const staged = consumePendingPresentation(SESSION);
    const pool = staged?.spec.pools[0];
    expect(pool).toBeDefined();
    expect(pool !== undefined && "analysis" in pool).toBe(true);
    expect(pool?.analysis).toBeNull();
  });

  it("stages the model's assessment verbatim, line breaks included", async () => {
    beginPresentationScope(SESSION);
    const analysis =
      "Safety checks are clean.\nVolume is accelerating into the 24h high, and the "
      + "LP is burned rather than time-locked.";
    await handleBoardCompose(
      {
        ...VALID_INPUT,
        pools: [{ ...VALID_INPUT.pools[0], analysis }],
      },
      modelContext,
    );

    expect(consumePendingPresentation(SESSION)?.spec.pools[0]?.analysis).toBe(analysis);
  });

  it("stages a board at the top of every input bound, whole", async () => {
    beginPresentationScope(SESSION);
    hydrateBoard.mockResolvedValueOnce(maximalRows());

    const result = await handleBoardCompose(maximalInput(), modelContext);

    expect(result.success).toBe(true);
    const staged = consumePendingPresentation(SESSION)?.spec;
    expect(staged?.pools).toHaveLength(8);
    expect(staged?.notes).toHaveLength(12);
  });

  it("refuses an over-budget board naming its size, and shortens nothing", async () => {
    beginPresentationScope(SESSION);
    // MEASURED: maximal rows plus eight 10,000-character two-byte assessments
    // plus a full 200-candle series of maximum-width decimals fits, and the
    // budget ADMITS it - that board is exactly what the budget was sized for
    // (the schema-valid ALL-FIELDS-MAX document is 272,697 bytes against a
    // 327,680 ceiling; see `src/__tests__/lib/board/maximal-board-spec.ts`).
    // What still exceeds it is the case the budget doc names: the same board
    // with FOUR-byte emoji-dense prose, 8 x 10,000 code points at 4 bytes each
    // = 320,000 bytes of analysis alone.
    hydrateBoard.mockResolvedValueOnce({
      ...maximalRows(),
      unmatchedMarkerAtMs: [],
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
      {
        ...maximalInput(),
        pools: maximalInput().pools.map((pool) => ({
          ...pool,
          analysis: "\u{1F680}".repeat(10_000),
        })),
        chart: { poolIndex: 0, resolution: "1h" },
      },
      modelContext,
    );

    expect(result.success).toBe(false);
    expect(result.output).toMatch(/\d+ bytes serialized/);
    // The refusal quotes the CONSTANT, so raising the budget cannot leave this
    // test asserting a number the tool no longer prints.
    expect(result.output).toContain(String(BOARD_SPEC_MAX_BYTES));
    // The refusal points at the pool worth shortening, not just at the total.
    expect(result.output).toMatch(/pool \d+ at \d+ bytes/);
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

/**
 * Model input at the top of every bound the input schema allows.
 *
 * The assessments are written in a TWO-BYTE script on purpose: the document
 * budget is sized against that cost (see `BOARD_SPEC_MAX_BYTES`), so a
 * worst-case input that used Latin filler would understate the real weight of
 * eight fully written assessments by half. Eight of these plus a full chart is
 * the case the budget is sized to ADMIT.
 */
function maximalInput() {
  return {
    title: "t".repeat(80),
    pools: Array.from({ length: 8 }, (_, i) => ({
      chain: "solana",
      pairAddress: `Pool${i}`,
      caption: "c".repeat(140),
      analysis: "\u0434".repeat(10_000),
    })),
    notes: Array.from({ length: 12 }, () => "\u0434".repeat(600)),
  };
}
