/**
 * Pure column solver for the shell frame (docs/design/R3-MINIMAL.md section
 * 2): three calm columns,
 *
 *   left sidebar | centre | Vex sidebar
 *
 * - The LEFT sidebar is 264 from SHELL_WIDE_MIN (1360) up and 224 from
 *   SHELL_MEDIUM_MIN (1180) up. Closed it is the 56px icon rail; Lighter always
 *   uses the rail, and Zen hands the chart the window (0).
 * - The CENTRE takes the rest (1fr); the transcript inside it is capped at
 *   760. It never drops under CENTER_MIN (640) at a supported window.
 * - The VEX sidebar is 256, 240 and 224 across the same three tiers. Closed
 *   it keeps what the caller asks for (0 by default), and the welcome stage
 *   has no right sidebar at all. Lighter's desk chat follows its own share,
 *   between LIGHTER_CHAT_MIN and LIGHTER_CHAT_MAX.
 *
 * Under SHELL_MEDIUM_MIN the left and Vex never stand open together: an open
 * Vex keeps the left at its rail, and a left the user re-opens there closes
 * Vex (derived; the stored choice is never rewritten, so widening the window
 * or opening Vex again restores it).
 *
 * The widths are fixed: there is no drag preference for either sidebar. The
 * only drag left in the frame is Lighter's chat share.
 *
 * The breakpoints live here because they are geometry. Whether a sidebar is
 * asked OPEN is still the shell's call (the stored preference, the narrow
 * override, the page class), handed in as booleans.
 *
 * The H3 frame has its own solver at the end of this file
 * (computeH3ShellColumns), which the agent shell and Studio stand on.
 * Everything above is R3's, and the Lighter desk's until its own restyle.
 */

/** Resolved widths for one frame. */
export interface ShellColumns {
  /** The left sidebar: open, its rail, or 0 in Lighter's Zen mode. */
  readonly left: number;
  /** The centre region; only the final fallback may go below CENTER_MIN. */
  readonly center: number;
  /** The Vex sidebar: open, what a closed one keeps, or 0. */
  readonly vex: number;
}

export type ShellMode = "agent" | "studio" | "lighter";

/** The three width tiers of section 2's table. */
export type ShellTier = "wide" | "medium" | "narrow";

export interface ShellLayoutInput {
  /** Available frame width in px. */
  readonly viewport: number;
  readonly mode: ShellMode;
  /**
   * Whether the left sidebar is asked open: the stored preference from
   * SHELL_MEDIUM_MIN up, the narrow override under it. Ignored in Lighter,
   * whose left is always the rail.
   */
  readonly left: boolean;
  /** Whether Vex is asked open for the current page. */
  readonly vex: boolean;
  /** The welcome stage: Vex sits in the centre, so the right column is 0. */
  readonly welcome?: boolean;
  /** What a closed Vex sidebar keeps; 0 unless the caller says otherwise. */
  readonly closedVex?: number;
  /** Lighter's desk chat width preference in px (its share of the window). */
  readonly lighterChat?: number;
  /** Lighter's Zen mode: the chart takes the window, no rail and no chat. */
  readonly zen?: boolean;
}

/** Centre floor; only the final fallback may go below it. */
export const CENTER_MIN = 640;

/** From this width up: left 264, Vex 256. */
export const SHELL_WIDE_MIN = 1360;
/** From this width up to SHELL_WIDE_MIN: left 224, Vex 240. Under it, the rail. */
export const SHELL_MEDIUM_MIN = 1180;

/** The open left sidebar at the wide tier. */
export const LEFT_WIDTH = 264;
/** The open left sidebar at the medium tier, and when re-opened under it. */
export const LEFT_WIDTH_MD = 224;
/** The closed left sidebar: the icon rail. */
export const RAIL_WIDTH = 56;

/** The open Vex sidebar at the wide tier. */
export const VEX_WIDTH = 256;
/** The open Vex sidebar at the medium tier. */
export const VEX_WIDTH_MD = 240;
/** The open Vex sidebar under the medium tier. */
export const VEX_WIDTH_SM = 224;

/** Lighter's desk chat: drag floor, also its width under pressure. */
export const LIGHTER_CHAT_MIN = 300;
/** Lighter's desk chat: drag ceiling. */
export const LIGHTER_CHAT_MAX = 520;

/**
 * The tier for a window width. Each seam is exact and belongs to the WIDER
 * side (`<`, not `<=`): 1360 is wide, 1359 medium, 1180 medium, 1179 narrow.
 */
export function shellTier(viewport: number): ShellTier {
  if (viewport >= SHELL_WIDE_MIN) return "wide";
  if (viewport >= SHELL_MEDIUM_MIN) return "medium";
  return "narrow";
}

/** Whether this width is under the medium tier, where the left folds to its rail. */
export function isShellNarrow(viewport: number): boolean {
  return viewport < SHELL_MEDIUM_MIN;
}

/** Clamp a panel width into its contract range and round to whole pixels. */
export function clampWidth(px: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(px)));
}

const LEFT_BY_TIER: Readonly<Record<ShellTier, number>> = {
  wide: LEFT_WIDTH,
  medium: LEFT_WIDTH_MD,
  narrow: LEFT_WIDTH_MD,
};

const VEX_BY_TIER: Readonly<Record<ShellTier, number>> = {
  wide: VEX_WIDTH,
  medium: VEX_WIDTH_MD,
  narrow: VEX_WIDTH_SM,
};

/**
 * Solve the tracks for one frame. Pure: the output is a function of the input
 * only (no hysteresis), so recovery on re-widening is automatic.
 *
 * Concession chain, applied only while the centre is under its floor (with
 * fixed widths it never runs at a supported window; it guards Lighter's chat
 * share and anything under the window minimum): Lighter's chat shrinks toward
 * its floor, then Vex closes (derived), then the left folds to its rail, and
 * the centre absorbs any remaining deficit as the last resort.
 */
export function computeShellColumns(input: ShellLayoutInput): ShellColumns {
  const { viewport, mode } = input;
  const lighter = mode === "lighter";
  const zen = lighter && input.zen === true;
  const welcome = input.welcome === true;
  const tier = shellTier(viewport);
  const closedVex = welcome || zen ? 0 : (input.closedVex ?? 0);

  // Under the medium tier a re-opened left closes Vex (see the module note).
  const leftOpen = !lighter && input.left;
  const vexOpen = !zen && !welcome && input.vex && !(tier === "narrow" && leftOpen);

  let left = zen ? 0 : leftOpen ? LEFT_BY_TIER[tier] : RAIL_WIDTH;
  let vex = !vexOpen
    ? closedVex
    : lighter
      ? clampWidth(input.lighterChat ?? VEX_WIDTH, LIGHTER_CHAT_MIN, LIGHTER_CHAT_MAX)
      : VEX_BY_TIER[tier];
  const vexFloor = vexOpen && lighter ? LIGHTER_CHAT_MIN : vex;

  let center = viewport - left - vex;

  // Step 1: Lighter's chat gives back its extra share first.
  if (center < CENTER_MIN && vex > vexFloor) {
    const give = Math.min(vex - vexFloor, CENTER_MIN - center);
    vex -= give;
    center += give;
  }
  // Step 2: an open Vex closes (derived).
  if (center < CENTER_MIN && vexOpen) {
    center += vex - closedVex;
    vex = closedVex;
  }
  // Step 3: an open left folds to its rail; the centre absorbs the rest.
  if (center < CENTER_MIN && left > RAIL_WIDTH) {
    center += left - RAIL_WIDTH;
    left = RAIL_WIDTH;
  }

  return { left, center: Math.max(0, center), vex };
}

/**
 * The widest Lighter's chat may be dragged in this frame without pushing the
 * centre under its floor, and never under the chat's own floor.
 */
export function lighterChatDragMax(cols: ShellColumns, viewport: number): number {
  return Math.max(
    LIGHTER_CHAT_MIN,
    Math.min(LIGHTER_CHAT_MAX, viewport - cols.left - CENTER_MIN),
  );
}

/**
 * The H3 frame (docs/design/H3-DESKTOP.md, the layout numbers and tiers),
 * solved beside R3's above. The agent shell and Studio stand on it; the
 * Lighter desk keeps computeShellColumns.
 *
 * H3 moves Vex between the chats and the chat:
 *
 *   chats | Vex | chat
 *
 * - The CHATS column is a fixed H3_CHATS_WIDTH (248). Folded by the user (the
 *   sidebar key) it is the H3_RAIL_WIDTH (76) rail, at any width.
 * - The VEX column is H3_VEX_PERCENT (30%) of the frame, in whole pixels.
 *   Folding the chats never changes it: the chat gains the difference (172).
 * - The CHAT takes the rest.
 *
 * Both proof plates fit this rule exactly: 248 | 432 | 760 at 1440, and the
 * chat starting at x 1016 (248 + 768) at 2560. Every other width is derived
 * from it, until Cloud's own breakpoints exist to reconcile with.
 *
 * Under H3_COLUMNS_MIN (1024) the frame is the BAND layout: the chats fold to
 * the rail whatever the stored choice says (derived; the choice is never
 * rewritten, so widening the window restores it), the Vex column is 0 and
 * Vex is drawn as a band under the header inside the chat, and the chat runs
 * from the rail to the right edge. The window minimum is 1000, so 1000 to 1023
 * is a real band, not a fallback.
 *
 * Vex never closes in an H3 chat: closing her only folds Kimm's section
 * inside the Vex column, so there is no "Vex closed" input. That is the money
 * rule by construction: nothing about Kimm reaches this function, so opening
 * or closing her cannot move the chat, or a waiting swap card in it. A page
 * may instead fold the Vex column to its one-line strip (vexStrip): the column
 * is 0, the strip is drawn inside the chat, and the chat takes the room.
 *
 * No centre floor. R3's CENTER_MIN (640) is not an H3 rule and is not applied
 * here: with the chats open the chat is under 640 from 1024 to 1267 (469 at
 * 1024, 648 at 1280 just above it), and across the 1024 seam it narrows from
 * 947 to 469 in one pixel. H3's proof has the card working at 1280 with rows
 * below the fold; the plate rule is kept as measured rather than bent to a
 * floor. With the chats folded the columns layout never takes the chat under
 * 641, and the band never under 924 from the window minimum up.
 *
 * The desktop's own rule sits on top, in what the shell ASKS (section 4.12):
 * from H3_COLUMNS_MIN to H3_CHATS_OPEN_MIN (1024 to 1267, h3ShellTier's
 * "medium") the chats column starts folded to the rail, so the chat keeps
 * at least H3_CHAT_MIN (640); the person may open it there, an unsaved
 * override the shell clears when the window leaves the tier. The solver only
 * takes the answer as `chats`.
 *
 * Every width is an integer and the three add back up to the frame, so the
 * grid can hand the chat minmax(0, 1fr) and land exactly on `chat`.
 */

/** From this frame width up: three columns. Under it, the band. */
export const H3_COLUMNS_MIN = 1024;

/** The open chats column, fixed at every width (the plates' 248). */
export const H3_CHATS_WIDTH = 248;
/** The folded chats column: the rail, by the user's choice or under the band seam. */
export const H3_RAIL_WIDTH = 76;

/**
 * The Vex column's share of the frame, as a whole percent: 432 at 1440 and
 * 768 at 2560 on the plates. A percent rather than 0.3 so the solve is one
 * division of two integers (see h3VexWidth).
 */
export const H3_VEX_PERCENT = 30;

/** The H3 frame's two layouts: three columns from H3_COLUMNS_MIN up, the band under it. */
export type H3ShellLayout = "columns" | "band";

/**
 * The chat's floor with the chats column open, the one R3 kept: the width a
 * waiting card's rows were laid out for. H3's own rule has no floor; the
 * desktop keeps it by folding the chats where it would not hold.
 */
export const H3_CHAT_MIN = 640;

/**
 * From this frame width up the chats column follows the stored choice: the
 * first width at which 248 + 30% + H3_CHAT_MIN fits (1268: 248 + 380 + 640;
 * at 1267 the chat would be 639). Under it, down to H3_COLUMNS_MIN, it
 * starts folded.
 */
export const H3_CHATS_OPEN_MIN = 1268;

/**
 * The H3 frame's three tiers: "wide" from H3_CHATS_OPEN_MIN up (the chats as
 * the person left them), "medium" from H3_COLUMNS_MIN (the chats folded
 * unless opened here), "band" under it (the rail, and Vex as a band). Each
 * seam belongs to the wider side, as shellTier's do.
 */
export type H3ShellTier = "wide" | "medium" | "band";

/**
 * Where the Vex console is drawn in one frame: its own column; the band under
 * the header inside the chat (the band layout); or a page's one-line strip
 * inside the chat. Only "column" has a track; the other two live in the
 * chat's box, which is why the Vex track is 0 for them.
 */
export type H3VexSeat = "column" | "band" | "strip";

export interface H3ShellInput {
  /** Available frame width in px; rounded to whole pixels before solving. */
  readonly viewport: number;
  /**
   * Whether the chats column is asked open: the stored sidebar choice. False
   * is the rail at any width. Under H3_COLUMNS_MIN it is ignored (the rail).
   */
  readonly chats: boolean;
  /**
   * A page folds the Vex column to its one-line strip: the Vex track is 0 and
   * the chat takes the room. Chats never set it; in H3 their Vex column stays.
   */
  readonly vexStrip?: boolean;
}

/** Resolved H3 widths for one frame, in the grid's order, plus what it draws where. */
export interface H3ShellColumns {
  /** Three columns from H3_COLUMNS_MIN up; the band under it. */
  readonly layout: H3ShellLayout;
  /** The chats track: H3_CHATS_WIDTH open, H3_RAIL_WIDTH folded or in the band. */
  readonly chats: number;
  /** The Vex track: H3_VEX_PERCENT of the frame, or 0 for the band and a page's strip. */
  readonly vex: number;
  /** The chat track: the rest of the frame. Never negative. */
  readonly chat: number;
  /** Whether the chats column renders as its rail (the user's fold, or the band). */
  readonly chatsRail: boolean;
  /** Where the Vex console is drawn: its column, the band, or a page's strip. */
  readonly vexSeat: H3VexSeat;
  /** The x where the chat starts (chats + Vex): the swap card's left edge, a page's start. */
  readonly chatLeft: number;
}

/**
 * A frame width as whole, non-negative pixels. The shell measures its frame
 * with getBoundingClientRect, which reports fractions on scaled displays; the
 * solver rounds once, here, so every track is an integer and the three add
 * back up to this width. Anything that is not a finite width solves as 0.
 */
function h3FrameWidth(viewport: number): number {
  return Number.isFinite(viewport) ? Math.max(0, Math.round(viewport)) : 0;
}

/**
 * The Vex column at a whole frame width: H3_VEX_PERCENT of it, to the nearest
 * pixel, halves up. 1366 gives 409.8, so 410 (nearest, not floor); 1025 gives
 * 307.5, so 308; 1024 gives 307.2, so 307. Computed as width * 30 / 100, one
 * rounding step in floating point, where width * 0.3 would take two.
 */
function h3VexWidth(width: number): number {
  return Math.round((width * H3_VEX_PERCENT) / 100);
}

/**
 * The H3 layout for a frame width. The seam is exact and belongs to the WIDER
 * side, as shellTier's do: 1024 is columns, 1023 the band. A fractional width
 * is rounded first, as the solver does, so 1023.5 is columns.
 */
export function h3ShellLayout(viewport: number): H3ShellLayout {
  return h3FrameWidth(viewport) >= H3_COLUMNS_MIN ? "columns" : "band";
}

/** The H3 tier for a frame width, rounded first as the solver rounds. */
export function h3ShellTier(viewport: number): H3ShellTier {
  const width = h3FrameWidth(viewport);
  if (width < H3_COLUMNS_MIN) return "band";
  return width >= H3_CHATS_OPEN_MIN ? "wide" : "medium";
}

/**
 * Solve the H3 tracks for one frame. Pure, with no hysteresis, like
 * computeShellColumns: the output is a function of the width, the chats
 * choice and the page's strip only. There is no concession chain; at every
 * width from 0 up the three tracks fit by construction (under the rail's own
 * width the rail takes the whole frame and the chat is 0).
 */
export function computeH3ShellColumns(input: H3ShellInput): H3ShellColumns {
  const width = h3FrameWidth(input.viewport);
  const layout = h3ShellLayout(width);
  const band = layout === "band";
  // Under the seam the rail is derived; the stored choice is left as it is.
  const chatsRail = band || !input.chats;
  const chats = Math.min(width, chatsRail ? H3_RAIL_WIDTH : H3_CHATS_WIDTH);
  // A page's strip wins over the band: a page under 1024 shows the strip.
  const vexSeat: H3VexSeat = input.vexStrip === true ? "strip" : band ? "band" : "column";
  const vex = vexSeat === "column" ? h3VexWidth(width) : 0;
  const chat = width - chats - vex;
  return { layout, chats, vex, chat, chatsRail, vexSeat, chatLeft: chats + vex };
}

/**
 * The grid's column template for an H3 frame, in H3's order (chats | Vex |
 * chat). No track is `auto`, as in R3's frame, so a track transition only
 * interpolates between lengths. The chat is minmax(0, 1fr), not `chat`px, so a
 * fractional frame width lands in the chat and never in a fixed column.
 */
export function h3GridTemplateColumns(cols: H3ShellColumns): string {
  return `${String(cols.chats)}px ${String(cols.vex)}px minmax(0, 1fr)`;
}

/**
 * THE FRAME PER MODE. The agent shell and Studio stand in H3's frame: the
 * header row over the columns and the columns in H3's order, chats | Vex |
 * chat. The Lighter desk keeps R3's frame until its own restyle
 * (docs/design/H3-DESKTOP.md section 4.9): one row, its title row its own,
 * and its chat on the right, rail | desk | chat, where its chat share drag
 * handle grips the chat's left edge.
 */
export type ShellFrameKind = "h3" | "r3";

/** One column of the frame, by what it holds. */
export type ShellColumnName = "chats" | "vex" | "chat";

/** The frame a mode stands in. */
export function shellFrameKind(mode: ShellMode): ShellFrameKind {
  return mode === "lighter" ? "r3" : "h3";
}

const H3_ORDER: readonly ShellColumnName[] = ["chats", "vex", "chat"];
const R3_ORDER: readonly ShellColumnName[] = ["chats", "chat", "vex"];

/**
 * The columns left to right in a mode, which is also their DOM order, so
 * focus follows the screen. In H3's the Vex column is the second track; on
 * the Lighter desk it is the last, the desk's chat on the right.
 */
export function shellColumnOrder(mode: ShellMode): readonly ShellColumnName[] {
  return shellFrameKind(mode) === "h3" ? H3_ORDER : R3_ORDER;
}

/**
 * THE FRAME'S ROWS (docs/design/H3-DESKTOP.md section 1.1): one header row
 * across the window, the columns' body, and one bottom row across the window.
 *
 *   head  the header's cells; its height is the window's head row,
 *         `--head-h` in window-chrome.css, which the main process mirrors for
 *         the traffic lights and the caption overlay (chrome-options.ts), so
 *         the CSS keeps the one source and the template names it
 *   body  the three columns, the rest of the window
 *   foot  the bottom row's cells
 *
 * A row the frame does not draw yet is 0: every column then spans all three
 * rows (shell.css) and the body is the whole window, exactly R3's one-row
 * frame. Like the columns, no row is `auto`, so nothing a cell holds can
 * change a row's height.
 */
export interface ShellRows {
  /** The header row stands. */
  readonly head: boolean;
  /** The bottom row stands. */
  readonly foot: boolean;
  /**
   * Vex's band stands under the header, over the chat (the band layout's
   * vexSeat "band", section 1.10): a fourth row between the header and the
   * body, H3_BAND_HEIGHT high.
   */
  readonly band?: boolean;
}

/**
 * Vex's band under 1024 (docs/design/H3-DESKTOP.md section 1.10), chosen for
 * S2-08 where H3 prints no desktop height: the column's own head row (44)
 * and one 88 row of her state, Needs you and her portrait. A function of
 * nothing: the band rests whatever she says or shows, so a card under it
 * never moves when a turn starts, ends or waits.
 */
export const H3_BAND_HEIGHT = 132;

/**
 * The bottom row's height, the H3 size token (tokens.css, 72: measured, its
 * top rule at y 827 to 828 of the 900-high plates; pinned by
 * shell-geometry-tokens.test.ts). Fixed: the composer in its chat cell grows
 * upward over the transcript and never changes the row. The composer seat
 * reads the same token, so the row and the seat keep one source.
 */
export const H3_FOOT_ROW = "var(--vex-h3-bottom-h)";

/** The grid's row template: head | body | foot, or head | band | body | foot. */
export function shellGridTemplateRows(rows: ShellRows): string {
  const head = rows.head ? "var(--head-h)" : "0px";
  const foot = rows.foot ? H3_FOOT_ROW : "0px";
  const band = rows.band === true ? ` ${String(H3_BAND_HEIGHT)}px` : "";
  return `${head}${band} minmax(0, 1fr) ${foot}`;
}

/**
 * THE HEADER'S CELLS (docs/design/H3-DESKTOP.md section 1.3): one row across
 * the window with a grid of its own, so a cell keeps its width where the body
 * under it folds (a page's strip leaves the Vex track 0 while the Vex key
 * stays in its cell). Each cell is placed by its named lines:
 *
 *   chats    the logo cell and the sidebar key, over the chats column
 *   vex      the Vex key, over the Vex column
 *   title    the chat's title and the title bar's cluster
 *   funds    the static network statement (Mainnet, Real funds)
 *   reserve  the Windows and Linux caption buttons' reserve, `--overlay-w`
 *            wide (0 on macOS and on a native frame), a drag region with
 *            nothing in it
 *
 * `vexBetween` puts the Vex key over a Vex column between the chats and the
 * chat (H3's order); without it the key sits at the right end beside the
 * reserve, over R3's right-hand Vex column. `vex` null sizes the key's cell
 * to the key.
 */
export interface ShellHeadInput {
  /** The chats track under the logo and sidebar key cells. */
  readonly chats: number;
  /** The Vex key cell's width; null is as wide as the key. */
  readonly vex: number | null;
  /** The Vex key cell stands between the chats and the chat. */
  readonly vexBetween: boolean;
}

/** The header's own column template, with each cell's named lines. */
export function shellHeadTemplateColumns(input: ShellHeadInput): string {
  const chats = `[chats-start] ${String(input.chats)}px [chats-end`;
  const vex = input.vex === null ? "auto" : `${String(input.vex)}px`;
  const rest = "minmax(0, 1fr) [title-end funds-start] auto [funds-end";
  const reserve = "reserve-start] var(--overlay-w) [reserve-end]";
  return input.vexBetween
    ? `${chats} vex-start] ${vex} [vex-end title-start] ${rest} ${reserve}`
    : `${chats} title-start] ${rest} vex-start] ${vex} [vex-end ${reserve}`;
}
