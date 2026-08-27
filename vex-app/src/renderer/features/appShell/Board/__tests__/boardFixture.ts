/**
 * BOARD TEST FIXTURE - a helper module, not a spec.
 *
 * The default board it builds is a REAL one: `boardFixture.test.ts` parses it
 * through `boardSpecV1Schema` so this file cannot drift away from the
 * contract while the component tests below keep passing. Overrides may
 * deliberately produce a shape the schema would reject (a pool with no
 * hydration row, for instance) in order to drive a defensive branch; those
 * cases say so at the call site.
 */

import type {
  BoardAnnotation,
  BoardCandle,
  BoardChartInput,
  BoardHydratedRow,
  BoardPoolInput,
  BoardSpecV1,
} from "@vex-lib/board/index.js";
import { BOARD_STALE_AFTER_MS } from "@vex-lib/board/index.js";

export const FIXTURE_FETCHED_AT = 1_783_172_700_000;

export function hydratedRow(
  overrides: Partial<BoardHydratedRow> = {},
): BoardHydratedRow {
  return {
    baseTokenSymbol: "PEPE",
    baseTokenName: "Pepe the Frog",
    quoteTokenSymbol: "WETH",
    chainId: "base",
    dexId: "uniswap",
    priceUsd: "0.00000123",
    priceChange: { h1: "-1.73", h24: "113" },
    liquidityUsd: "75189.01",
    volumeH24Usd: "464284.04",
    txns: { buys: 1235, sells: 856 },
    pairAgeSeconds: 259_200,
    // Null by default because that is the COMMON case on a real board: roughly
    // half of pools carry no DexScreener profile, so the monogram placeholder
    // is what most cards wear. A test that wants the image state overrides it.
    iconId: null,
    description: null,
    ...overrides,
  };
}

export function candle(tMs: number, close = "0.00000123"): BoardCandle {
  return { tMs, o: close, h: close, l: close, c: close };
}

export interface BoardSpecOverrides {
  readonly title?: string;
  readonly pools?: readonly BoardPoolInput[];
  readonly rows?: readonly BoardHydratedRow[];
  readonly notes?: readonly string[];
  readonly chart?: BoardChartInput;
  readonly bars?: readonly BoardCandle[];
  readonly annotations?: readonly BoardAnnotation[];
  readonly analysisCreatedAt?: number;
  readonly marketDataFetchedAt?: number;
  readonly lastBarPartial?: boolean;
  readonly truncated?: boolean;
}

export function boardSpec(overrides: BoardSpecOverrides = {}): BoardSpecV1 {
  const pools = overrides.pools ?? [
    // `analysis` is emitted explicitly, null included, for the same reason
    // `iconId` is above: current writers always emit the key.
    { chain: "base", pairAddress: "0xaaa111", analysis: null },
  ];
  const rows = overrides.rows ?? pools.map(() => hydratedRow());
  const chart =
    overrides.chart ??
    (overrides.bars !== undefined || overrides.annotations !== undefined
      ? {
          poolIndex: 0,
          resolution: "1h" as const,
          ...(overrides.annotations !== undefined
            ? { annotations: [...overrides.annotations] }
            : {}),
        }
      : undefined);
  const bars = overrides.bars ?? [
    candle(FIXTURE_FETCHED_AT - 7_200_000),
    candle(FIXTURE_FETCHED_AT - 3_600_000, "0.00000131"),
    candle(FIXTURE_FETCHED_AT, "0.00000128"),
  ];
  const marketDataFetchedAt =
    overrides.marketDataFetchedAt ?? FIXTURE_FETCHED_AT;

  return {
    version: 1,
    title: overrides.title ?? "Base memecoins",
    pools: [...pools],
    ...(chart !== undefined ? { chart } : {}),
    ...(overrides.notes !== undefined ? { notes: [...overrides.notes] } : {}),
    hydration: {
      rows: [...rows],
      candles:
        chart === undefined
          ? null
          : {
              bars: [...bars],
              lastBarPartial: overrides.lastBarPartial ?? true,
              coveredRange: {
                fromMs: bars[0]?.tMs ?? marketDataFetchedAt,
                toMs: bars.at(-1)?.tMs ?? marketDataFetchedAt,
              },
              resolution: chart.resolution,
              truncated: overrides.truncated ?? false,
            },
      // The runtime's marker-membership verdict: computed here the way
      // `hydrate.ts` computes it, against the SAME bars the fixture persists,
      // so the fixture cannot claim a marker is drawable when it is not.
      unmatchedMarkerAtMs:
        chart === undefined
          ? null
          : (chart.annotations ?? []).flatMap((annotation) =>
              annotation.kind === "marker" &&
              !bars.some((bar) => bar.tMs === annotation.atMs)
                ? [annotation.atMs]
                : [],
            ),
      analysisCreatedAt:
        overrides.analysisCreatedAt ?? marketDataFetchedAt - 30_000,
      marketDataFetchedAt,
      provenance: {
        transport: "http",
        sourceObservation: "dexscreener pairs batch",
      },
      staleAfterMs: BOARD_STALE_AFTER_MS,
    },
  };
}
