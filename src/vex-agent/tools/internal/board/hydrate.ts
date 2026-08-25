/**
 * Runtime-authored hydration for a board: the market facts the MODEL may not
 * supply, read in-process from the DexScreener surface.
 *
 * THE RULE THIS MODULE EXISTS TO ENFORCE. A board carries the agent's own
 * analysis (title, captions, notes, price levels, zones, markers) and NOTHING
 * ELSE that a reader could mistake for a measurement. Every number a reader
 * will read as a fact - price, liquidity, volume, trade counts, candles - is
 * fetched HERE, from the same surface the agent's read tools use, and stamped
 * with the clock it was fetched at. Nothing on this path can be reached by the
 * model's input except the pool identities and the chart resolution it chose.
 *
 * MONEY IS TEXT. Provider decimal strings are forwarded verbatim; provider
 * doubles are RENDERED to a plain decimal string without exponent notation and
 * never arithmetically combined. No value on this path is added, scaled or
 * rounded, so nothing here can invent a figure.
 *
 * PROVIDER TEXT IS UNTRUSTED. Token names and symbols are issuer-authored, so
 * they pass through the surface's own `sanitizeIssuerField` and every touched
 * field path is named in `provenance.sourceObservation`. That is the OPPOSITE
 * policy from the model's own strings, which are rejected rather than cleaned
 * (`src/lib/board/board-text.ts` records why).
 *
 * FAIL CLOSED. Any refusal from the surface (unavailable transport, unknown
 * chain, unresolvable pool, an unusable candle page) propagates. A board is
 * never staged on partial hydration, because a card with a missing figure and
 * a card with an unfetched figure look identical to a reader.
 */

import {
  fetchPairsBatch,
  rowKey,
  type BatchIdentity,
} from "@tools/dexscreener/endpoints/pairs-batch.js";
import {
  barStepMs,
  fetchBarsPage,
  type ProjectedBar,
} from "@tools/dexscreener/endpoints/bars.js";
import { resolvePairSubject } from "@tools/dexscreener/endpoints/pair-subject.js";
import { projectPairRow } from "@tools/dexscreener/screen-core/project.js";
import { sanitizeIssuerField } from "@tools/dexscreener/sanitize.js";
import {
  DexScreenerSiteErrorCodes,
  siteError,
} from "@tools/dexscreener/site-errors.js";
import { getDexScreenerTransport } from "@tools/dexscreener/transport.js";
import {
  BOARD_MAX_CANDLES,
  BOARD_STALE_AFTER_MS,
  type BoardCandle,
  type BoardCandleSeries,
  type BoardComposeInput,
  type BoardHydratedRow,
  type BoardHydration,
} from "../../../../lib/board/index.js";

/** Deadline for one provider exchange on these channels. */
const CHANNEL_TIMEOUT_MS = 25_000;

/** The window the batch channel is asked to rank by. Rows are matched by identity. */
const BATCH_RANK_KEY = "RANK_BY_KEY_VOLUME";

/** Shape a decimal string must have to be storable. Mirrors the spec's own. */
const DECIMAL_PATTERN = /^[0-9]+(\.[0-9]+)?$/;
const SIGNED_DECIMAL_PATTERN = /^-?[0-9]+(\.[0-9]+)?$/;

/**
 * Render a provider double as a plain decimal string.
 *
 * `toLocaleString` with grouping off is used rather than `String(value)`
 * because the latter emits exponent form at both ends of the range
 * (`1e+21`, `1e-7`), and an exponent is not a decimal string. Twenty
 * fraction digits is the maximum the formatter accepts and is far past any
 * figure this surface reports.
 *
 * Returns null for a value the schema could not hold anyway (not finite, or
 * negative where the field is unsigned). A null here means "no figure", which
 * is exactly what the row's nullable money fields mean.
 */
function decimalFromNumber(value: number | null, signed: boolean): string | null {
  if (value === null || !Number.isFinite(value)) return null;
  if (!signed && value < 0) return null;
  const rendered = value.toLocaleString("en-US", {
    useGrouping: false,
    maximumFractionDigits: 20,
  });
  const pattern = signed ? SIGNED_DECIMAL_PATTERN : DECIMAL_PATTERN;
  return pattern.test(rendered) ? rendered : null;
}

/** A provider decimal string, forwarded verbatim or refused. Never reshaped. */
function decimalFromProvider(value: string | null): string | null {
  if (value === null) return null;
  return DECIMAL_PATTERN.test(value) ? value : null;
}

/** A provider uint64 count as an exact integer, or null when it is not one. */
function countFromProvider(value: string | null): number | null {
  if (value === null) return null;
  if (!/^[0-9]+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/** Non-empty sanitized issuer text, bounded to what the row schema holds. */
function issuerText(
  value: string | null,
  fieldPath: string,
  sanitized: Set<string>,
): string | null {
  const clean = sanitizeIssuerField(value, fieldPath, sanitized);
  if (clean === null) return null;
  const trimmed = clean.trim();
  return trimmed === "" ? null : trimmed;
}

export interface HydrateArgs {
  readonly input: BoardComposeInput;
  readonly nowMs: number;
  readonly signal?: AbortSignal;
}

/**
 * Fetch every fact the board displays.
 *
 * The two clocks are set here and are deliberately equal at compose time:
 * `analysisCreatedAt` never moves again, while a later refresh advances
 * `marketDataFetchedAt` with the rows and candles it replaces.
 */
export async function hydrateBoard(args: HydrateArgs): Promise<BoardHydration> {
  const transport = getDexScreenerTransport();
  const sanitized = new Set<string>();

  const identities: readonly BatchIdentity[] = args.input.pools.map((pool) => ({
    chainId: pool.chain,
    id: pool.pairAddress,
    kind: "pair",
    raw: `${pool.chain}:${pool.pairAddress}`,
  }));

  const batch = await fetchPairsBatch(
    {
      identities,
      window: "h24",
      rankKey: BATCH_RANK_KEY,
      rankOrder: "desc",
    },
    {
      transport,
      timeoutMs: CHANNEL_TIMEOUT_MS,
      ...(args.signal === undefined ? {} : { signal: args.signal }),
    },
  );

  // The channel drops an identity it cannot resolve in SILENCE, so a board
  // built without this check would show a card with every figure null and no
  // statement that the pool was never found. Refuse instead, naming the pools.
  const byKey = new Map<string, unknown>();
  for (const row of batch.rows) {
    const key = rowKey(row);
    if (key !== null && !byKey.has(key)) byKey.set(key, row);
  }
  const unresolved = args.input.pools.filter(
    (pool) => !byKey.has(`${pool.chain}:${pool.pairAddress}`.toLowerCase()),
  );
  if (unresolved.length > 0) {
    throw siteError(
      DexScreenerSiteErrorCodes.PAIR_NOT_RESOLVED,
      `The DexScreener pairs channel returned no row for ${unresolved.length} of the ${args.input.pools.length} pool(s) on this board: `
        + unresolved.map((pool) => `${pool.chain}:${pool.pairAddress}`).join(", "),
      "Check the chain slug and the pool address as the provider spells them, then compose the board again with pools that resolve.",
    );
  }

  const rows: BoardHydratedRow[] = args.input.pools.map((pool, index) => {
    const source = byKey.get(`${pool.chain}:${pool.pairAddress}`.toLowerCase());
    const h24 = projectPairRow(source, { window: "h24", nowMs: args.nowMs });
    const h1 = projectPairRow(source, { window: "h1", nowMs: args.nowMs });
    const path = `pools[${index}]`;
    return {
      baseTokenSymbol: issuerText(
        h24.baseToken.symbol,
        `${path}.baseToken.symbol`,
        sanitized,
      ),
      baseTokenName: issuerText(h24.baseToken.name, `${path}.baseToken.name`, sanitized),
      quoteTokenSymbol: issuerText(
        h24.quoteToken.symbol,
        `${path}.quoteToken.symbol`,
        sanitized,
      ),
      chainId: h24.chainId,
      dexId: h24.dexId,
      priceUsd: decimalFromProvider(h24.priceUsd),
      priceChange: {
        h1: decimalFromNumber(h1.priceChangePct, true),
        h24: decimalFromNumber(h24.priceChangePct, true),
      },
      liquidityUsd: decimalFromNumber(h24.liquidityUsd, false),
      volumeH24Usd: decimalFromNumber(h24.volumeUsd, false),
      txns: {
        buys: countFromProvider(h24.buys),
        sells: countFromProvider(h24.sells),
      },
      pairAgeSeconds:
        h24.pairAgeSeconds === null ? null : Math.max(0, Math.floor(h24.pairAgeSeconds)),
    };
  });

  const candles =
    args.input.chart === undefined
      ? null
      : await hydrateCandles({
          pool: args.input.pools[args.input.chart.poolIndex],
          resolution: args.input.chart.resolution,
          transport,
          ...(args.signal === undefined ? {} : { signal: args.signal }),
        });

  // MARKER MEMBERSHIP, decided here and nowhere else.
  //
  // A marker is the agent's claim about ONE bar. The chart library does not
  // refuse a marker whose time is absent from the series - it snaps it to a
  // neighbouring bar - so a marker placed a few minutes off a 1-hour series
  // would silently become a claim about a bar the agent never looked at.
  // Compose time is the only moment at which the marker and the candle set
  // that will be persisted beside it are both authoritative, so the verdict is
  // taken here, against the EXACT millisecond timestamps of the bars that were
  // stored. The renderer omits these and names each one in the legend.
  const unmatchedMarkerAtMs = unmatchedMarkerInstants(
    args.input.chart,
    candles?.series.bars ?? [],
  );

  return {
    rows,
    candles: candles === null ? null : candles.series,
    unmatchedMarkerAtMs,
    analysisCreatedAt: args.nowMs,
    marketDataFetchedAt: args.nowMs,
    provenance: {
      transport: transport.name,
      sourceObservation: describeObservation({
        transport: transport.name,
        siteCapable: transport.capabilities.site,
        fetchedAtMs: batch.fetchedAtMs,
        poolCount: args.input.pools.length,
        sanitized,
        candleNote: candles === null ? null : candles.note,
      }),
    },
    staleAfterMs: BOARD_STALE_AFTER_MS,
  };
}

/**
 * The marker instants that match NO bar in the persisted series, in the order
 * the agent wrote them. Null when the board has no chart.
 *
 * Exact equality on the millisecond, deliberately: a marker is a claim about
 * ONE bar, and "close to a bar" is the thing the chart library would silently
 * turn into a claim about a different bar.
 */
export function unmatchedMarkerInstants(
  chart: BoardComposeInput["chart"],
  bars: readonly BoardCandle[],
): number[] | null {
  if (chart === undefined) return null;
  const candleTimes = new Set(bars.map((bar) => bar.tMs));
  return (chart.annotations ?? []).flatMap((annotation) =>
    annotation.kind === "marker" && !candleTimes.has(annotation.atMs)
      ? [annotation.atMs]
      : [],
  );
}

interface HydratedCandles {
  readonly series: BoardCandleSeries;
  /** What the candle window left out, or null when it left nothing out. */
  readonly note: string | null;
}

async function hydrateCandles(args: {
  readonly pool: BoardComposeInput["pools"][number] | undefined;
  readonly resolution: BoardCandleSeries["resolution"];
  readonly transport: ReturnType<typeof getDexScreenerTransport>;
  readonly signal?: AbortSignal;
}): Promise<HydratedCandles> {
  const pool = args.pool;
  if (pool === undefined) {
    // Unreachable through the schema, which bounds `poolIndex` against
    // `pools.length`. Kept because a hole here would silently chart the wrong
    // pool rather than fail.
    throw siteError(
      DexScreenerSiteErrorCodes.PAIR_IDENTITY_MISSING,
      "The chart names a pool index that is not on the board",
      "Point `chart.poolIndex` at one of the pools you listed.",
    );
  }

  // The AMM id and the pair's OWN quote token are resolved from the provider,
  // never assembled here: the bars route answers HTTP 200 with a SILENTLY
  // INVERTED series for a wrong or merely lower-cased quote token.
  const subject = await resolvePairSubject({
    transport: args.transport,
    chainId: pool.chain,
    pairAddress: pool.pairAddress,
    timeoutMs: CHANNEL_TIMEOUT_MS,
    ...(args.signal === undefined ? {} : { signal: args.signal }),
  });

  const page = await fetchBarsPage({
    transport: args.transport,
    chainId: subject.chainId,
    pairAddress: subject.pairAddress,
    ammId: subject.ammId,
    quoteTokenAddress: subject.quoteTokenAddress,
    resolution: args.resolution,
    series: "price",
    inverted: false,
    countBack: BOARD_MAX_CANDLES,
    timeoutMs: CHANNEL_TIMEOUT_MS,
    ...(args.signal === undefined ? {} : { signal: args.signal }),
  });

  // A bar without all four USD prices cannot be drawn, so it is dropped and
  // the drop is REPORTED (count and reason) rather than left as a gap the
  // reader would read as a flat candle.
  const drawable: BoardCandle[] = [];
  for (const bar of page.bars) {
    const candle = toCandle(bar);
    if (candle !== null) drawable.push(candle);
  }
  const undrawable = page.bars.length - drawable.length;

  // Newest `BOARD_MAX_CANDLES`, still oldest-first. Both this bound and the
  // dropped bars are named in the note the provenance carries.
  const bars = drawable.slice(Math.max(0, drawable.length - BOARD_MAX_CANDLES));
  const overWindow = drawable.length - bars.length;

  const first = bars[0];
  const last = bars[bars.length - 1];
  if (first === undefined || last === undefined) {
    throw siteError(
      DexScreenerSiteErrorCodes.BARS_NO_RESULT_FRAME,
      `The DexScreener chart endpoint returned no drawable ${args.resolution} bars for ${pool.chain}:${pool.pairAddress}`,
      "Ask for a coarser resolution, or compose the board without a chart.",
    );
  }

  const notes: string[] = [];
  if (overWindow > 0) {
    notes.push(
      `${overWindow} older bar(s) beyond the ${BOARD_MAX_CANDLES}-bar board window are not shown`,
    );
  }
  if (undrawable > 0) {
    notes.push(
      `${undrawable} bar(s) carried no USD price and are not shown`,
    );
  }

  return {
    series: {
      bars,
      lastBarPartial: last.tMs + barStepMs(args.resolution) > page.fetchedAtMs,
      coveredRange: { fromMs: first.tMs, toMs: last.tMs },
      resolution: args.resolution,
      truncated: overWindow > 0 || undrawable > 0,
    },
    note: notes.length === 0 ? null : notes.join("; "),
  };
}

/** One provider bar as a board candle, or null when it cannot be drawn. */
function toCandle(bar: ProjectedBar): BoardCandle | null {
  const o = decimalFromProvider(bar.openUsd);
  const h = decimalFromProvider(bar.highUsd);
  const l = decimalFromProvider(bar.lowUsd);
  const c = decimalFromProvider(bar.closeUsd);
  if (o === null || h === null || l === null || c === null) return null;
  if (!Number.isSafeInteger(bar.timestampMs)) return null;
  return { tMs: bar.timestampMs, o, h, l, c };
}

/**
 * One sentence stating where the numbers came from and what was left out.
 *
 * Bounded to what the spec's `sourceObservation` holds by naming COUNTS and
 * the first field paths rather than by cutting the sentence: a reader is told
 * how many fields were cleaned even when they are not all listed.
 */
function describeObservation(args: {
  readonly transport: string;
  readonly siteCapable: boolean;
  readonly fetchedAtMs: number;
  readonly poolCount: number;
  readonly sanitized: ReadonlySet<string>;
  readonly candleNote: string | null;
}): string {
  const parts = [
    `${args.poolCount} pool row(s) read from the DexScreener ${args.siteCapable ? "site" : "public API"} channels over the ${args.transport} transport at ${new Date(args.fetchedAtMs).toISOString()}`,
  ];
  if (args.sanitized.size > 0) {
    const listed = [...args.sanitized].sort();
    parts.push(
      `${listed.length} issuer-authored field(s) contained invisible or direction-changing characters and were cleaned: ${listed.join(", ")}`,
    );
  }
  if (args.candleNote !== null) parts.push(args.candleNote);
  const sentence = parts.join("; ");
  // The field holds 512 characters. Rather than cut the sentence, drop the
  // enumerated field list (whose COUNT is already stated) and keep the facts.
  if (sentence.length <= 512) return sentence;
  const withoutList = [
    parts[0],
    ...(args.sanitized.size > 0
      ? [`${args.sanitized.size} issuer-authored field(s) were cleaned of invisible or direction-changing characters (paths omitted here for length)`]
      : []),
    ...(args.candleNote === null ? [] : [args.candleNote]),
  ].join("; ");
  // Every remaining component is bounded by construction (a pool count, a
  // timestamp, a field count, and one of two fixed candle sentences), so this
  // is the honest end of the line: nothing is cut, and an oversized value is
  // refused by the schema rather than shortened here.
  return withoutList;
}
