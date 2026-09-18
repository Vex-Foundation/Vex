/**
 * The Lighter desk's remembered state: which network and market it opens on,
 * and where the user left its splitters. Persisted through the Lighter
 * analysis store, so every value is coerced from untrusted localStorage.
 */

import type {
  LighterTradingEnvironment,
  LighterTradingLiveResolution,
} from "@shared/schemas/lighter-trading.js";
export const LIGHTER_CHAT_DEFAULT_SHARE = 0.32;

export const LIGHTER_RESOLUTIONS: readonly LighterTradingLiveResolution[] = [
  "1m", "5m", "15m", "30m", "1h", "4h", "12h", "1d",
];

/* Splitter positions persist as shares of the desk, so the chart, the book
 * column, the ticket column and the dock scale together when the window, the
 * sidebar or the chat rail changes size. Pixel floors keep each panel usable. */

/** The chart keeps this much before the two columns start to yield to it. */
export const LIGHTER_CHART_MIN = 360;
/**
 * Below this desk width (the chat rail open, roughly) three columns leave the
 * chart a sliver, so the book column moves under the chart instead, with the
 * book and the trades as tabs.
 */
export const LIGHTER_STACK_BELOW = 1020;
/** A shallow, side-by-side book still needs room for several prices per side. */
export const LIGHTER_COMPACT_BOOK_MIN = 208;
export const LIGHTER_COMPACT_CHART_MIN = 280;
export const LIGHTER_COMPACT_BOOK_DEFAULT_SHARE = 1 / 3;
/** S1 - the book column (order book over trades), as a share of the desk width. */
export const LIGHTER_BOOK_COLUMN_MIN = 220;
export const LIGHTER_BOOK_COLUMN_DEFAULT_SHARE = 0.2;
/** S2 - the ticket column, as a share of the desk width. */
export const LIGHTER_TICKET_MIN = 280;
export const LIGHTER_TICKET_MAX = 380;
export const LIGHTER_TICKET_DEFAULT_SHARE = 0.25;
/** Either column stops at half the desk. */
export const LIGHTER_COLUMN_MAX_SHARE = 0.5;
/** Header, column labels, inside row and ratio bar plus a level a side. */
export const LIGHTER_BOOK_MIN = 140;
/** S3 - the trades panel, as a share of the book column height. */
export const LIGHTER_TRADES_MIN = 120;
export const LIGHTER_TRADES_MAX_SHARE = 0.7;
export const LIGHTER_TRADES_DEFAULT_SHARE = 0.32;
/** S4 - the bottom dock, as a share of the desk height. */
export const LIGHTER_BOTTOM_MIN = 120;
export const LIGHTER_BOTTOM_MAX_SHARE = 0.6;
export const LIGHTER_BOTTOM_DEFAULT_SHARE = 0.2;
export const LIGHTER_BOTTOM_COLLAPSED = 32;
/** The panels above the dock never give up more than this: the book and trades minimums plus their seam. */
export const LIGHTER_MAIN_MIN_HEIGHT = LIGHTER_BOOK_MIN + LIGHTER_TRADES_MIN + 1;

export interface LighterLayout {
  readonly bookShare: number;
  readonly ticketShare: number;
  readonly tradesShare: number;
  readonly compactBookShare: number;
  readonly bottomShare: number;
  readonly bottomCollapsed: boolean;
}

export interface LighterDeskFrame {
  /** The desk body's measured size; zero until the first layout pass. */
  readonly width: number;
  readonly height: number;
}

export interface LighterLayoutPixels {
  readonly bookWidth: number;
  readonly bookMax: number;
  readonly ticketWidth: number;
  readonly ticketMax: number;
  readonly tradesHeight: number;
  readonly tradesMax: number;
  readonly compactBookHeight: number;
  readonly compactBookMax: number;
  readonly bottomHeight: number;
  readonly bottomMax: number;
  /** Even at its floor the dock leaves no room for a minimum book and trades panel: it has to fold. */
  readonly dockSqueezed: boolean;
}

/**
 * Shares to pixels for one frame. Each seam follows its share within the
 * floors. Across, the book column resolves first and the ticket column takes
 * what the chart minimum leaves; when the desk is narrower than the three
 * floors together, the columns keep theirs and the chart gives. Down the book
 * column, trades follow their share and the book takes the rest; the dock
 * folds only when even the floors do not fit.
 */
export function resolveLighterLayout(layout: LighterLayout, frame: LighterDeskFrame): LighterLayoutPixels {
  const { width, height } = frame;
  const compact = width > 0 && width < LIGHTER_STACK_BELOW;
  // Two seams sit between the three columns.
  const columnsRoom = width - 2 - LIGHTER_CHART_MIN;
  const shareMax = Math.round(width * LIGHTER_COLUMN_MAX_SHARE);
  const bookMax = Math.max(LIGHTER_BOOK_COLUMN_MIN, Math.min(shareMax, columnsRoom - LIGHTER_TICKET_MIN));
  const bookWidth = width > 0
    ? clampNumber(width * layout.bookShare, LIGHTER_BOOK_COLUMN_MIN, bookMax, LIGHTER_BOOK_COLUMN_MIN)
    : LIGHTER_BOOK_COLUMN_MIN;
  const ticketMax = Math.max(LIGHTER_TICKET_MIN, Math.min(LIGHTER_TICKET_MAX, shareMax,
    compact ? width - 1 - LIGHTER_CHART_MIN : columnsRoom - bookWidth));
  const ticketWidth = width > 0
    ? clampNumber(width * layout.ticketShare, LIGHTER_TICKET_MIN, ticketMax, LIGHTER_TICKET_MIN)
    : LIGHTER_TICKET_MIN;
  const mainMinHeight = compact
    ? LIGHTER_COMPACT_CHART_MIN + 1 + LIGHTER_COMPACT_BOOK_MIN
    : LIGHTER_MAIN_MIN_HEIGHT;
  const bottomMax = Math.max(
    LIGHTER_BOTTOM_MIN,
    Math.round(Math.min(height * LIGHTER_BOTTOM_MAX_SHARE, height - 1 - mainMinHeight)),
  );
  const bottomHeight = height > 0
    ? clampNumber(height * layout.bottomShare, LIGHTER_BOTTOM_MIN, bottomMax, LIGHTER_BOTTOM_MIN)
    : LIGHTER_BOTTOM_MIN;
  const dockSqueezed = height > 0 && height - 1 - LIGHTER_BOTTOM_MIN < mainMinHeight;
  // The book column above the dock (or its folded bar), less the book/trades seam.
  const column = height - 1 - (layout.bottomCollapsed ? LIGHTER_BOTTOM_COLLAPSED : bottomHeight);
  const compactBookMax = Math.max(LIGHTER_COMPACT_BOOK_MIN, column - 1 - LIGHTER_COMPACT_CHART_MIN);
  const compactBookHeight = clampNumber(column * layout.compactBookShare,
    LIGHTER_COMPACT_BOOK_MIN, compactBookMax, LIGHTER_COMPACT_BOOK_MIN);
  const tradesMax = Math.max(
    LIGHTER_TRADES_MIN,
    Math.round(Math.min(column * LIGHTER_TRADES_MAX_SHARE, column - 1 - LIGHTER_BOOK_MIN)),
  );
  const tradesHeight = height > 0
    ? clampNumber(column * layout.tradesShare, LIGHTER_TRADES_MIN, tradesMax, LIGHTER_TRADES_MIN)
    : LIGHTER_TRADES_MIN;
  return { bookWidth, bookMax, ticketWidth, ticketMax, tradesHeight, tradesMax, compactBookHeight, compactBookMax, bottomHeight, bottomMax, dockSqueezed };
}

export interface LighterDeskPreferences {
  readonly environment: LighterTradingEnvironment;
  readonly marketId: number | null;
  readonly resolution: LighterTradingLiveResolution;
  readonly layout: LighterLayout;
  /** Agent conversation share of the shell, independent of other modes. */
  readonly chatShare: number;
  /**
   * The positions table's Market close skips its approval card: the desk
   * approves the card itself the moment main enqueues it. Off by default;
   * the card's "Don't ask again" box turns it on.
   */
  readonly skipCloseConfirm: boolean;
}

export const DEFAULT_LIGHTER_LAYOUT: LighterLayout = {
  bookShare: LIGHTER_BOOK_COLUMN_DEFAULT_SHARE,
  ticketShare: LIGHTER_TICKET_DEFAULT_SHARE,
  tradesShare: LIGHTER_TRADES_DEFAULT_SHARE,
  compactBookShare: LIGHTER_COMPACT_BOOK_DEFAULT_SHARE,
  bottomShare: LIGHTER_BOTTOM_DEFAULT_SHARE,
  bottomCollapsed: false,
};

export const DEFAULT_LIGHTER_DESK: LighterDeskPreferences = {
  environment: "rhc",
  marketId: null,
  resolution: "5m",
  layout: DEFAULT_LIGHTER_LAYOUT,
  chatShare: LIGHTER_CHAT_DEFAULT_SHARE,
  skipCloseConfirm: false,
};

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function clampShare(value: unknown, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(0, value));
}

export function coerceLighterLayout(value: unknown): LighterLayout {
  if (typeof value !== "object" || value === null) return DEFAULT_LIGHTER_LAYOUT;
  const raw = value as Record<string, unknown>;
  // Pixel floors apply at render time, once the desk is measured.
  // Layouts saved by the two-column desk (`panelShare`, a ticket height share) fall back to the defaults.
  return {
    bookShare: clampShare(raw["bookShare"], LIGHTER_COLUMN_MAX_SHARE, LIGHTER_BOOK_COLUMN_DEFAULT_SHARE),
    ticketShare: "bookShare" in raw
      ? clampShare(raw["ticketShare"], LIGHTER_COLUMN_MAX_SHARE, LIGHTER_TICKET_DEFAULT_SHARE)
      : LIGHTER_TICKET_DEFAULT_SHARE,
    tradesShare: clampShare(raw["tradesShare"], LIGHTER_TRADES_MAX_SHARE, LIGHTER_TRADES_DEFAULT_SHARE),
    compactBookShare: clampShare(raw["compactBookShare"], LIGHTER_TRADES_MAX_SHARE, LIGHTER_COMPACT_BOOK_DEFAULT_SHARE),
    bottomShare: clampShare(raw["bottomShare"], LIGHTER_BOTTOM_MAX_SHARE, LIGHTER_BOTTOM_DEFAULT_SHARE),
    bottomCollapsed: raw["bottomCollapsed"] === true,
  };
}

export function coerceLighterDesk(value: unknown): LighterDeskPreferences {
  if (typeof value !== "object" || value === null) return DEFAULT_LIGHTER_DESK;
  const raw = value as Record<string, unknown>;
  const marketId = raw["marketId"];
  return {
    environment: raw["environment"] === "core" ? "core" : "rhc",
    marketId: typeof marketId === "number" && Number.isInteger(marketId) && marketId >= 0 && marketId < 100_000
      ? marketId
      : null,
    resolution: LIGHTER_RESOLUTIONS.find((item) => item === raw["resolution"]) ?? "5m",
    layout: coerceLighterLayout(raw["layout"]),
    chatShare: clampShare(raw["chatShare"], LIGHTER_COLUMN_MAX_SHARE, LIGHTER_CHAT_DEFAULT_SHARE),
    skipCloseConfirm: raw["skipCloseConfirm"] === true,
  };
}
