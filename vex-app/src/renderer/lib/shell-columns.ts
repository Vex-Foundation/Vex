/**
 * Pure column solver for the spread (docs/design/V10-SPREAD.md section 2): the
 * window is an open book, laid out as
 *
 *   left page | gutter | centre | BOOK
 *
 * with Studio's project rail carved out of the centre's left edge.
 *
 * - The left page is the print. In agent mode it opens at PAGE_MIN (300), or
 *   wider up to the drag preference; closed, and always in Lighter and Studio,
 *   it is the SPINE_WIDTH (56) print spine.
 * - The gutter is the binding that carries the spread caption: 36 beside an
 *   open page, 22 beside a spine. Under SPREAD_MIN (1276) it folds into the
 *   running head (0).
 * - The centre never drops under CENTER_MIN (640). In Studio the centre is the
 *   project rail plus the workspace, as the spec's table counts it.
 * - The BOOK takes its drag preference (300 to 520, default 340) from
 *   BOOK_FULL_MIN (1316) up and holds its 300 floor under it. Lighter's BOOK is
 *   the chat rail and follows its own share at every width.
 *
 * Concession chain, applied only while the centre is under its floor: a page
 * wider than its floor gives its extra back first, then the BOOK shrinks to its
 * floor, then it closes to its spine (DERIVED: stored preferences are never
 * rewritten, so widening the window restores them), and the centre absorbs any
 * remaining deficit as the last resort.
 *
 * The breakpoints live here because they are geometry. Whether the page is
 * OPEN is still the shell's call (the stored preference and the narrow
 * override), handed in as a width preference where 0 means closed.
 */

/** Resolved widths for one frame. `center` includes the Studio `rail`. */
export interface ShellColumns {
  /** The left page: open, its spine, or 0 in Lighter's Zen mode. */
  readonly page: number;
  /** The gutter: 36 beside an open page, 22 beside a spine, 0 when folded. */
  readonly gutter: number;
  /** Studio's project rail, inside the centre; 0 outside Studio. */
  readonly rail: number;
  /** The centre region; only the final fallback may go below CENTER_MIN. */
  readonly center: number;
  readonly book: number;
}

export type ShellMode = "agent" | "studio" | "lighter";

export interface ShellLayoutInput {
  /** Available frame width in px. */
  readonly viewport: number;
  readonly mode: ShellMode;
  /**
   * The first column's width preference, 0 = closed. Agent: the left page.
   * Studio: the project rail. Ignored in Lighter, whose markets and sessions
   * live in its top bar.
   */
  readonly sidebar: number;
  /** BOOK width preference in px, 0 = closed. */
  readonly book: number;
  /**
   * What a closed BOOK keeps: its BOOK_COLLAPSED spine in a session (the
   * default), 0 on the welcome stage and in Zen.
   */
  readonly closedBook?: number;
  /** Lighter's Zen mode: the chart takes the window, no page and no gutter. */
  readonly zen?: boolean;
}

/** Centre floor; only the final fallback may go below it. */
export const CENTER_MIN = 640;

/** Under this width the left page closes to its spine and the gutter folds. */
export const SPREAD_MIN = 1276;
/** From this width up the BOOK takes its preference; under it, its floor. */
export const BOOK_FULL_MIN = 1316;

/** The open left page at its spec width, which is also its drag floor. */
export const PAGE_MIN = 300;
/** The closed left page: the print spine. */
export const SPINE_WIDTH = 56;
/** The gutter beside an open left page (the 22px spread caption). */
export const GUTTER_WIDTH = 36;
/** The gutter beside a spine (the 11px spread caption). */
export const GUTTER_SM_WIDTH = 22;

/**
 * Drag clamp floor of the stored first-column preference: Studio's rail at its
 * spec width. The left page reads any value under PAGE_MIN as PAGE_MIN.
 */
export const SIDEBAR_MIN = 240;
/** Drag clamp ceiling of the stored first-column preference. */
export const SIDEBAR_MAX = 420;
/**
 * The first column before any drag: Studio's rail at 240, which the left page
 * reads as its 300 floor.
 */
export const SIDEBAR_DEFAULT = 240;
/** Studio's closed project rail: its icon spine. */
export const RAIL_COLLAPSED = 56;

/** BOOK drag clamp floor, and its width under BOOK_FULL_MIN. */
export const BOOK_MIN = 300;
/** BOOK drag clamp ceiling. */
export const BOOK_MAX = 520;
/** BOOK width before any drag. */
export const BOOK_DEFAULT = 340;
/** Closed-BOOK spine (the collapse header and its toggle stay visible). */
export const BOOK_COLLAPSED = 48;

/**
 * Whether this width is under the spread: the left page and Studio's rail
 * close to their spines unless the user re-expands them, and the gutter folds
 * into the running head. Exactly SPREAD_MIN is WIDE (`<`, not `<=`); tested at
 * the seam and one pixel on each side.
 */
export function isSpreadNarrow(viewport: number): boolean {
  return viewport < SPREAD_MIN;
}

/**
 * Whether the BOOK takes its drag preference at this width. Lighter's chat
 * rail always does; elsewhere the BOOK holds its floor under BOOK_FULL_MIN.
 */
export function isBookResizable(viewport: number, mode: ShellMode): boolean {
  return mode === "lighter" || viewport >= BOOK_FULL_MIN;
}

/** Clamp a panel width into its contract range and round to whole pixels. */
export function clampWidth(px: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(px)));
}

/**
 * Solve the tracks for one frame. Pure: the output is a function of the input
 * only (no hysteresis), so recovery on re-widening is automatic. Preferences
 * re-clamp here because they cross the store boundary and callers may still
 * supply stale ranges.
 */
export function computeShellColumns(input: ShellLayoutInput): ShellColumns {
  const { viewport, mode } = input;
  const zen = input.zen === true;
  const closedBook = input.closedBook ?? BOOK_COLLAPSED;

  let page = zen
    ? 0
    : mode === "agent" && input.sidebar !== 0
      ? clampWidth(input.sidebar, PAGE_MIN, SIDEBAR_MAX)
      : SPINE_WIDTH;
  const pageOpen = page > SPINE_WIDTH;
  const gutter = zen || isSpreadNarrow(viewport)
    ? 0
    : pageOpen
      ? GUTTER_WIDTH
      : GUTTER_SM_WIDTH;
  const rail = mode !== "studio"
    ? 0
    : input.sidebar === 0
      ? RAIL_COLLAPSED
      : clampWidth(input.sidebar, SIDEBAR_MIN, SIDEBAR_MAX);

  const bookOpen = input.book !== 0;
  let book = !bookOpen
    ? closedBook
    : isBookResizable(viewport, mode)
      ? clampWidth(input.book, BOOK_MIN, BOOK_MAX)
      : BOOK_MIN;

  let center = viewport - page - gutter - book;

  // Step 1: a page wider than its floor gives its extra back first.
  if (center < CENTER_MIN && pageOpen) {
    const give = Math.min(page - PAGE_MIN, CENTER_MIN - center);
    page -= give;
    center += give;
  }
  // Step 2: an open BOOK shrinks toward its floor.
  if (center < CENTER_MIN && bookOpen) {
    const give = Math.min(book - BOOK_MIN, CENTER_MIN - center);
    book -= give;
    center += give;
  }
  // Step 3: the BOOK closes (derived); the centre absorbs whatever is left.
  if (center < CENTER_MIN && bookOpen) {
    center += book - closedBook;
    book = closedBook;
  }

  return { page, gutter, rail, center: Math.max(0, center), book };
}

/**
 * The widest the left page may be dragged in this frame without pushing the
 * centre under its floor: the owner's condition for keeping the drag handle.
 * At or under PAGE_MIN there is no room, and the shell mounts no handle.
 */
export function pageDragMax(cols: ShellColumns, viewport: number): number {
  return Math.min(SIDEBAR_MAX, viewport - cols.gutter - cols.book - CENTER_MIN);
}

/**
 * The widest the BOOK may be dragged in this frame without pushing the centre
 * under its floor. An open page concedes before the BOOK, so it counts at its
 * floor here.
 */
export function bookDragMax(cols: ShellColumns, viewport: number): number {
  const page = cols.page > SPINE_WIDTH ? PAGE_MIN : cols.page;
  return Math.min(BOOK_MAX, viewport - page - cols.gutter - CENTER_MIN);
}
