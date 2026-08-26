/**
 * BOARD VIEW MODEL - the one place the persisted spec is interpreted.
 *
 * Everything the board renders is derived here, as pure data, so the `.tsx`
 * files below stay presentation only and the interpretation is testable by
 * table. This is also the single import site for the canonical spec type:
 * the components consume THESE shapes, so a change in the persisted contract
 * lands in one module rather than in five components.
 *
 * A board is a SNAPSHOT. Its market data was fetched when the agent composed
 * it and it is never silently refreshed behind the reader's back, so the
 * model computes staleness explicitly and the surface states it in words.
 *
 * Pairing rule: `hydration.rows[i]` belongs to `pools[i]`. A row missing at
 * that index is a degraded card, not a dropped pool - the pool the agent
 * named is still shown, with its figures blank, because silently omitting a
 * card would misrepresent what the agent actually put on the board.
 */

import type { BoardHydratedRow, BoardSpecV1 } from "@vex-lib/board/index.js";
import type { BoardDataMode } from "../../../lib/api/board-live.js";
import {
  boardTrend,
  isBoardMarketDataStale,
  type BoardTrend,
} from "./boardFormat.js";

/** One token card's data, already paired and trend-classified. */
export interface BoardCardModel {
  readonly key: string;
  readonly chain: string;
  readonly pairAddress: string;
  readonly caption: string | null;
  /** Null when hydration carried no row for this pool. */
  readonly row: BoardSpecV1["hydration"]["rows"][number] | null;
  readonly trendH1: BoardTrend;
  readonly trendH24: BoardTrend;
}

/** One annotation as the READER sees it: a label and its coordinate, as text. */
export interface BoardAnnotationRow {
  readonly key: string;
  readonly kind: "level" | "zone" | "marker";
  readonly label: string;
  /** Coordinate as plain text: a price, a price range, or an instant. */
  readonly coordinate: string;
  /**
   * Why this annotation is not on the canvas, or null when it is drawn.
   *
   * A marker whose instant matched no hydrated candle is omitted from the
   * chart (the library would otherwise snap it onto a neighbouring bar and
   * make it read as analysis of that bar). Omitting it silently would delete
   * the agent's claim, so the legend keeps the label and says why.
   */
  readonly note: string | null;
}

/**
 * The live figures drawn OVER a board, and the mode they were drawn in.
 *
 * A separate argument rather than a field of the spec, because the spec is a
 * durable document and live figures are a lease the reader is holding right
 * now. Nothing here is ever written back: toggle the lease off and the model
 * rebuilds from the persisted rows alone.
 *
 * Rows are keyed `chain:pairAddress` rather than positioned, because the
 * provider's batch channel RANKS its answer and a positional pairing would put
 * one token's price on another token's card the moment that ranking moved.
 */
export interface BoardLiveOverlay {
  readonly mode: BoardDataMode;
  readonly rowsByKey: ReadonlyMap<string, BoardHydratedRow> | null;
  /** The clock the live rows were read at, or null when none have landed. */
  readonly fetchedAtMs: number | null;
}

export interface BoardViewModel {
  readonly title: string;
  readonly cards: readonly BoardCardModel[];
  readonly notes: readonly string[];
  /**
   * Whether the figures ON SCREEN have outlived their freshness window.
   *
   * Measured against the clock of whatever is actually being shown: the live
   * fetch when live rows are up, the persisted fetch otherwise. It stays a
   * SEPARATE axis from `mode` on purpose - a lease can be connected while its
   * first tick is still in flight, and the figures under it are still the
   * composed ones and still aging.
   */
  readonly stale: boolean;
  readonly analysisCreatedAt: number;
  /**
   * The clock of the figures on screen. Advances with a live tick; the
   * persisted `spec.hydration.marketDataFetchedAt` is never touched.
   */
  readonly marketDataFetchedAt: number;
  readonly mode: BoardDataMode;
}

export function buildBoardViewModel(
  spec: BoardSpecV1,
  now: number,
  live?: BoardLiveOverlay,
): BoardViewModel {
  const rows = spec.hydration.rows;
  const liveRows = live?.rowsByKey ?? null;
  const cards: BoardCardModel[] = spec.pools.map((pool, index) => {
    const persisted = rows[index] ?? null;
    // The live row REPLACES the persisted one whole, never field by field: a
    // card assembled from two epochs would show a price from one moment beside
    // a liquidity figure from another, and nothing on screen would say so.
    const row =
      liveRows?.get(`${pool.chain}:${pool.pairAddress}`.toLowerCase()) ??
      persisted;
    return {
      key: `${pool.chain}/${pool.pairAddress}/${index}`,
      chain: pool.chain,
      pairAddress: pool.pairAddress,
      caption: pool.caption ?? null,
      row,
      trendH1: boardTrend(row?.priceChange.h1 ?? null),
      trendH24: boardTrend(row?.priceChange.h24 ?? null),
    };
  });
  const fetchedAt =
    liveRows === null || live?.fetchedAtMs == null
      ? spec.hydration.marketDataFetchedAt
      : live.fetchedAtMs;
  return {
    title: spec.title,
    cards,
    notes: spec.notes ?? [],
    stale: isBoardMarketDataStale(fetchedAt, spec.hydration.staleAfterMs, now),
    analysisCreatedAt: spec.hydration.analysisCreatedAt,
    marketDataFetchedAt: fetchedAt,
    mode: live?.mode ?? "snapshot",
  };
}

/**
 * The annotation legend.
 *
 * Annotation labels are the agent's own words, and they are rendered as plain
 * React text HERE, never handed to the charting library as a `title` or an
 * axis label. Two reasons, and both matter: canvas text is invisible to a
 * screen reader and unselectable by a mouse, and passing model-authored
 * strings into a third-party renderer's option bag widens the sink for no
 * gain. The chart draws the GEOMETRY; this list carries the WORDS.
 */
export function buildAnnotationRows(
  spec: BoardSpecV1,
): readonly BoardAnnotationRow[] {
  const annotations = spec.chart?.annotations ?? [];
  const unmatched = new Set(spec.hydration.unmatchedMarkerAtMs ?? []);
  return annotations.map((annotation, index) => {
    const key = `${annotation.kind}/${index}`;
    switch (annotation.kind) {
      case "level":
        return {
          key,
          kind: "level",
          label: annotation.label,
          coordinate: annotation.price,
          note: null,
        };
      case "zone":
        return {
          key,
          kind: "zone",
          label: annotation.label,
          coordinate: `${annotation.priceFrom} to ${annotation.priceTo}`,
          note: null,
        };
      case "marker": {
        const instant = new Date(annotation.atMs).toISOString();
        return {
          key,
          kind: "marker",
          label: annotation.label,
          coordinate: instant,
          note: unmatched.has(annotation.atMs)
            ? `marker at ${instant} matches no candle`
            : null,
        };
      }
      default: {
        // Closed union: a new annotation kind must be handled here, and the
        // compiler says so at the point the contract changes.
        const unreachable: never = annotation;
        throw new Error(
          `board annotation kind not handled: ${JSON.stringify(unreachable)}`,
        );
      }
    }
  });
}

/**
 * The accessible name for the board section. Staleness is stated in WORDS,
 * not implied by a dimmed pixel, because a reader on assistive tech has no
 * access to the pixel and a board's figures are a financial snapshot whose
 * age changes what they mean.
 */
export function boardAriaLabel(model: BoardViewModel): string {
  const count = model.cards.length;
  const pools = `${count} ${count === 1 ? "pool" : "pools"}`;
  return `Board: ${model.title}, ${pools}${liveClause(model.mode)}${
    model.stale ? ", market data delayed" : ""
  }`;
}

/**
 * The live state as WORDS for the accessible name.
 *
 * A reader on assistive tech has no access to the pulsing dot, and whether the
 * figures in front of them are updating is exactly the kind of fact this
 * surface refuses to leave to a pixel.
 */
function liveClause(mode: BoardDataMode): string {
  switch (mode) {
    case "live-connecting":
      return ", connecting to live figures";
    case "live-connected":
      return ", live figures";
    case "live-degraded":
      return ", live figures interrupted, reconnecting";
    case "live-unsupported":
      return ", live figures unavailable in this build";
    case "snapshot":
    case "live-off":
      return "";
    default: {
      const unreachable: never = mode;
      throw new Error(`board data mode not handled: ${String(unreachable)}`);
    }
  }
}
