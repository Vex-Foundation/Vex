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
 * The shell's frame, D2 (docs/design/H3-DESKTOP.md section 6; owner decisions
 * 2026-11-09 and 2026-11-10), solved beside R3's above. The agent shell and
 * Studio stand on it; the Lighter desk keeps computeDeskColumns. The names
 * keep H3's prefix: D2 keeps H3's cells, rows, tiers and words and moves only
 * Vex.
 *
 * D2 has two tracks, and Vex's PANEL docked over the chat's top right:
 *
 *   chats | chat ...................... |
 *         |                  [Vex panel] |
 *
 * - The CHATS column is a fixed H3_CHATS_WIDTH (248) from H3_CHATS_OPEN_MIN
 *   up, or the H3_RAIL_WIDTH (76) rail where the user folded it (the sidebar
 *   key). Under H3_CHATS_OPEN_MIN it is the rail whatever the stored choice
 *   says: there the sidebar key slides the chats PANEL out of the rail, over
 *   the chat, and no track changes (section 4.12).
 * - The CHAT takes the rest, to the window's right edge.
 * - VEX'S PANEL (owner decision 2026-11-10: "the chat takes that space") is
 *   no track. It is a box D2_VEX_WIDTH (280) wide at the chat's top right,
 *   under the header, as tall as what it holds, at every width from
 *   H3_COLUMNS_MIN up; the chat's own ground shows under it. `vex` is its
 *   width, and `room` the chat less that width: what the reading column, a
 *   page and Studio's centre stand in, so nothing readable lies under the
 *   panel. Folding the chats never changes it.
 *
 * At 1440 that is 248 | 1192, the panel 280 over the chat's right, and a
 * room of 912 (the owner's D2 plates' chat).
 *
 * Under H3_COLUMNS_MIN (1024) the frame is the BAND layout: the chats fold to
 * the rail whatever the stored choice says (derived; the choice is never
 * rewritten, so widening the window restores it), there is no panel, her
 * console rides in a 48 line under the header (H3_CONSOLE_LINE_HEIGHT) and
 * her section is a band laid over the chat's top under it, and the chat runs
 * from the rail to the right edge. The window minimum is 1000, so 1000 to
 * 1023 is a real band, not a fallback.
 *
 * HIDING VEX NEVER REACHES THIS SOLVE IN A CHAT. Hidden, the panel goes and
 * the chat's ground shows, but its room stays: the money rule by
 * construction (section 3.6), since nothing about her shown or hidden choice
 * can move the chat's reading column, or a waiting swap card in it. A page
 * may instead fold her to its one-line strip (vexStrip): the panel and its
 * room are 0, the strip is drawn inside the chat, and the page takes the
 * room.
 *
 * No centre floor. R3's CENTER_MIN (640) is not applied here: under
 * H3_CHATS_OPEN_MIN the chats are the rail, so the room never drops under
 * 668 (at 1024), and the band's chat never under 924 from the window minimum
 * up.
 *
 * Every track is an integer, and the grid hands the chat minmax(0, 1fr), so a
 * fractional frame lands in the chat and never in the chats column.
 */

/** From this frame width up: the columns and Vex's panel. Under it, the band. */
export const H3_COLUMNS_MIN = 1024;

/** The open chats column, fixed at every width (the plates' 248). */
export const H3_CHATS_WIDTH = 248;
/** The folded chats column: the rail, by the user's choice or under H3_CHATS_OPEN_MIN. */
export const H3_RAIL_WIDTH = 76;

/** D2's Vex panel at the chat's top right: a fixed 280 from H3_COLUMNS_MIN up (`--vex-d2-vex-w`). */
export const D2_VEX_WIDTH = 280;

/** The frame's two layouts: the columns and her panel from H3_COLUMNS_MIN up, the band under it. */
export type H3ShellLayout = "columns" | "band";

/**
 * From this frame width up the chats column follows the stored choice: VEX
 * Cloud's fold point (PD-14, "left column 248 from 1280, the 76 rail under
 * 1280"). Under it the chats are the rail, and their key opens the chats
 * panel over the chat instead.
 */
export const H3_CHATS_OPEN_MIN = 1280;

/**
 * The frame's three tiers: "wide" from H3_CHATS_OPEN_MIN up (the chats as
 * the person left them), "medium" from H3_COLUMNS_MIN (the rail, its key
 * opening the chats panel), "band" under it (the rail, and Vex as a band).
 * Each seam belongs to the wider side, as shellTier's do.
 */
export type H3ShellTier = "wide" | "medium" | "band";

/**
 * Where the Vex console is drawn in one frame: her panel at the chat's top
 * right ("column", D2's name for her seat); the band under the header inside
 * the chat (the band layout); or a page's one-line strip inside the chat.
 * None of them is a track; only the panel keeps a room in the chat, which is
 * why `vex` is 0 for the other two.
 */
export type H3VexSeat = "column" | "band" | "strip";

export interface H3ShellInput {
  /** Available frame width in px; rounded to whole pixels before solving. */
  readonly viewport: number;
  /**
   * Whether the chats column is asked open: the stored sidebar choice. False
   * is the rail at any width. Under H3_CHATS_OPEN_MIN it is ignored (the
   * rail, and the chats panel over the chat).
   */
  readonly chats: boolean;
  /**
   * A page folds Vex to its one-line strip: her panel and its room are 0 and
   * the page takes the chat's whole width. Chats never set it; their panel's
   * room stays.
   */
  readonly vexStrip?: boolean;
}

/** Resolved widths for one frame, plus what it draws where. */
export interface H3ShellColumns {
  /** The columns and her panel from H3_COLUMNS_MIN up; the band under it. */
  readonly layout: H3ShellLayout;
  /** The chats track: H3_CHATS_WIDTH open, H3_RAIL_WIDTH folded or under H3_CHATS_OPEN_MIN. */
  readonly chats: number;
  /** The chat track: the rest of the frame, to its right edge. Never negative. */
  readonly chat: number;
  /**
   * Her panel's width over the chat's top right, and the room it keeps
   * there, shown or hidden: D2_VEX_WIDTH, or 0 for the band and a page's
   * strip. Not a track.
   */
  readonly vex: number;
  /**
   * The chat less her panel's room: where the reading column, a page and
   * Studio's centre stand, so nothing in them lies under her panel.
   */
  readonly room: number;
  /** Whether the chats column renders as its rail (the user's fold, or under H3_CHATS_OPEN_MIN). */
  readonly chatsRail: boolean;
  /** Where the Vex console is drawn: her panel, the band, or a page's strip. */
  readonly vexSeat: H3VexSeat;
  /** The x where the chat starts (the chats track): the swap card's column, a page's start. */
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
 * The layout for a frame width. The seam is exact and belongs to the WIDER
 * side, as shellTier's do: 1024 is columns, 1023 the band. A fractional width
 * is rounded first, as the solver does, so 1023.5 is columns.
 */
export function h3ShellLayout(viewport: number): H3ShellLayout {
  return h3FrameWidth(viewport) >= H3_COLUMNS_MIN ? "columns" : "band";
}

/** The tier for a frame width, rounded first as the solver rounds. */
export function h3ShellTier(viewport: number): H3ShellTier {
  const width = h3FrameWidth(viewport);
  if (width < H3_COLUMNS_MIN) return "band";
  return width >= H3_CHATS_OPEN_MIN ? "wide" : "medium";
}

/**
 * Solve the tracks for one frame. Pure, with no hysteresis, like
 * computeShellColumns: the output is a function of the width, the chats
 * choice and the page's strip only. There is no concession chain; at every
 * width from 0 up the two tracks fit by construction (under the rail's own
 * width the rail takes the whole frame and the chat is 0).
 */
export function computeH3ShellColumns(input: H3ShellInput): H3ShellColumns {
  const width = h3FrameWidth(input.viewport);
  const layout = h3ShellLayout(width);
  const band = layout === "band";
  // Under H3_CHATS_OPEN_MIN the rail is derived; the stored choice is left
  // as it is, so widening the window restores it.
  const chatsRail = width < H3_CHATS_OPEN_MIN || !input.chats;
  const chats = Math.min(width, chatsRail ? H3_RAIL_WIDTH : H3_CHATS_WIDTH);
  // The band wins over a page's strip: under 1024 a page has the console
  // line and her band as a chat does (VEX Cloud's 768 to 1023 layout).
  const vexSeat: H3VexSeat = band ? "band" : input.vexStrip === true ? "strip" : "column";
  const chat = Math.max(0, width - chats);
  // Her panel lies over the chat, so it never takes more than the chat has.
  const vex = vexSeat === "column" ? Math.min(chat, D2_VEX_WIDTH) : 0;
  return { layout, chats, chat, vex, room: chat - vex, chatsRail, vexSeat, chatLeft: chats };
}

/**
 * The grid's column template for the frame: chats | chat, the chat to the
 * window's right edge (her panel is a box over it, shell.css). No track is
 * `auto`, so nothing a cell holds can change a track. The chat is
 * minmax(0, 1fr), not `chat`px, so a fractional frame width lands in the
 * chat and never in the chats column.
 */
export function h3GridTemplateColumns(cols: H3ShellColumns): string {
  return `${String(cols.chats)}px minmax(0, 1fr)`;
}

/**
 * THE LIGHTER DESK IN H3 (docs/design/H3-DESKTOP.md section 4.9, the
 * owner-approved `lighter-desk` plate): the header row over three columns and
 * the bottom row under them, in the desk's own order,
 *
 *   chats | desk | Vex
 *
 * - The CHATS column is the 76 rail at every width. Its Expand key opens the
 *   248 for that visit only (an unsaved override the shell keeps), and there
 *   is no Expand under H3_COLUMNS_MIN.
 * - VEX'S COLUMN is the desk chat, at the right: H3's 30% of the window by
 *   default (the desk's stored share, `desk.chatShare`), never under
 *   LIGHTER_CHAT_MIN (300) and never over LIGHTER_CHAT_MAX (520), the drag's
 *   own range. Where the share would leave the desk under CENTER_MIN beside
 *   the rail, the column gives back toward its floor, as R3's first
 *   concession did.
 * - The DESK takes the rest.
 *
 * THE MONEY RULE ON THE DESK (section 3.6). The desk's own Review order card
 * stands at the desk's right edge, in the ticket's column, so it moves only
 * if her column's width moves. That width is a function of the window and
 * the stored share alone: the rail's Expand eats into the desk's left, never
 * into her column (the concession reads the 76 rail, whatever the chats
 * column is), and her section is a box over her column that never reaches
 * this solve. The share itself only changes under the drag, which the shell
 * makes inert while a card waits.
 *
 * Zen hands the chart the window: no rail and no column (0 and 0).
 */
export interface DeskShellInput {
  /** Available frame width in px; rounded to whole pixels before solving. */
  readonly viewport: number;
  /** The desk chat's stored share of the window (`desk.chatShare`). */
  readonly share: number;
  /** The rail's Expand is open for this visit (ignored under H3_COLUMNS_MIN). */
  readonly chatsExpanded: boolean;
  /** Lighter Zen: the chart in the whole window. */
  readonly zen?: boolean;
}

export interface DeskShellColumns {
  /** The chats track: the 76 rail, the 248 while Expand is open, 0 in Zen. */
  readonly chats: number;
  /** The desk's track: the rest of the frame. Never negative. */
  readonly desk: number;
  /** Her column, the desk chat: 300 to 520, 0 in Zen. */
  readonly vex: number;
  /** The chats column renders as its rail. */
  readonly chatsRail: boolean;
  /** The rail's Expand key is offered at this width. */
  readonly expandable: boolean;
}

/** Her column on the desk for a window and a stored share (see DeskShellInput). */
export function deskVexWidth(viewport: number, share: number): number {
  const width = h3FrameWidth(viewport);
  const asked = clampWidth(width * (Number.isFinite(share) ? share : 0), LIGHTER_CHAT_MIN, LIGHTER_CHAT_MAX);
  const room = width - H3_RAIL_WIDTH - CENTER_MIN;
  return asked > room ? Math.max(LIGHTER_CHAT_MIN, room) : asked;
}

/** The widest the desk chat may be dragged at this window: 300 to 520, the desk kept at 640. */
export function deskChatDragMax(viewport: number): number {
  const width = h3FrameWidth(viewport);
  return Math.max(LIGHTER_CHAT_MIN, Math.min(LIGHTER_CHAT_MAX, width - H3_RAIL_WIDTH - CENTER_MIN));
}

/** Solve the desk's tracks for one frame. Pure, with no hysteresis. */
export function computeDeskColumns(input: DeskShellInput): DeskShellColumns {
  const width = h3FrameWidth(input.viewport);
  const expandable = width >= H3_COLUMNS_MIN;
  if (input.zen === true) {
    return { chats: 0, desk: width, vex: 0, chatsRail: true, expandable: false };
  }
  const chatsRail = !(expandable && input.chatsExpanded);
  const chats = Math.min(width, chatsRail ? H3_RAIL_WIDTH : H3_CHATS_WIDTH);
  // Her column stands whatever she shows: her section is a box over it, and
  // her stored choice opens or folds that box alone (section 3.6).
  const vex = Math.min(Math.max(0, width - chats), deskVexWidth(width, input.share));
  return { chats, desk: Math.max(0, width - chats - vex), vex, chatsRail, expandable };
}

/** The desk frame's column template: chats | desk | Vex, the desk the flexible track. */
export function deskGridTemplateColumns(cols: DeskShellColumns): string {
  return `${String(cols.chats)}px minmax(0, 1fr) ${String(cols.vex)}px`;
}

/**
 * THE FRAME PER MODE. The agent shell and Studio stand in the shell's frame
 * ("h3": H3's cells and rows, D2's columns): the header row over the columns
 * and the parts in D2's order, chats | chat | Vex's panel. The Lighter desk stands
 * in the same rows with its own order ("desk"), rail | desk | Vex, where the
 * desk chat's drag handle grips the column's left edge.
 */
export type ShellFrameKind = "h3" | "desk";

/** One column of the frame, by what it holds. */
export type ShellColumnName = "chats" | "vex" | "chat";

/** The frame a mode stands in. */
export function shellFrameKind(mode: ShellMode): ShellFrameKind {
  return mode === "lighter" ? "desk" : "h3";
}

const RIGHT_ORDER: readonly ShellColumnName[] = ["chats", "chat", "vex"];
const BAND_ORDER: readonly ShellColumnName[] = ["chats", "vex", "chat"];

/**
 * The columns in a mode, in their DOM order, so focus follows the screen.
 * Vex comes last, at the right edge, in the shell (D2's panel over the chat's
 * top right) and on the Lighter desk (its column) alike. Under 1024 (`band`)
 * the shell has no panel: her
 * console is the line under the header, OVER the chat, so it comes before
 * the chat in the DOM, as it does on screen. The desk has no band.
 */
export function shellColumnOrder(mode: ShellMode, band = false): readonly ShellColumnName[] {
  return band && shellFrameKind(mode) === "h3" ? BAND_ORDER : RIGHT_ORDER;
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
   * The band layout's console line stands under the header, over the chat
   * (vexSeat "band", section 1.10): a fourth row between the header and the
   * body, H3_CONSOLE_LINE_HEIGHT high. Her band itself is a box laid over the
   * chat under it, never a row.
   */
  readonly band?: boolean;
  /**
   * The foot row is H3's zoomed foot line, 72 x `--vex-zoom` and its 1px
   * rule (`H3_ZOOMED_FOOT_ROW`, section 1.11): the agent shell and Studio.
   * Without it the row is the 72 token, as the Lighter desk keeps it.
   */
  readonly zoomFoot?: boolean;
}

/**
 * The console line under 1024 (docs/design/H3-DESKTOP.md section 1.10; VEX
 * Cloud's `--cline-h`, 48 from 768 up): her state, Needs you and its count,
 * the missions count and Open activity in one row of cells under the header,
 * across the chat. A row of the frame and a function of nothing, so the chat
 * under it never moves. Her band, when the person opens it, is a box laid
 * over the chat under this line (`--vex-band-h`), never a row.
 */
export const H3_CONSOLE_LINE_HEIGHT = 48;

/**
 * The bottom row's height, the H3 size token (tokens.css, 72: measured, its
 * top rule at y 827 to 828 of the 900-high plates; pinned by
 * shell-geometry-tokens.test.ts). Fixed: the composer in its chat cell grows
 * upward over the transcript and never changes the row. The composer seat
 * reads the same token, so the row and the seat keep one source.
 */
export const H3_FOOT_ROW = "var(--vex-h3-bottom-h)";

/**
 * The foot row in H3's own frame (docs/design/H3-DESKTOP.md sections 1.8 and
 * 1.11): VEX Cloud's foot line, 72 x the wide zoom and its 1px top rule (73
 * at 1440, 79.6 at 1920, 105.8 at 2560; `--vex-h3-foot` in tokens.css), so
 * the zoomed composer and the card's decision row fill it at every width.
 */
export const H3_ZOOMED_FOOT_ROW = "var(--vex-h3-foot)";

/** The grid's row template: head | body | foot, or head | console line | body | foot. */
export function shellGridTemplateRows(rows: ShellRows): string {
  const head = rows.head ? "var(--head-h)" : "0px";
  const foot = rows.foot ? (rows.zoomFoot === true ? H3_ZOOMED_FOOT_ROW : H3_FOOT_ROW) : "0px";
  const band = rows.band === true ? ` ${String(H3_CONSOLE_LINE_HEIGHT)}px` : "";
  return `${head}${band} minmax(0, 1fr) ${foot}`;
}

/**
 * THE HEADER'S CELLS (docs/design/H3-DESKTOP.md sections 1.3 and 6.2): one
 * row across the window with a grid of its own, so a cell keeps its width
 * where the body under it has no such column (her panel lies over the chat,
 * and a page's strip leaves it 0, while the VEX cell stays). Each cell is placed by its named lines, left to right:
 *
 *   chats    the logo cell and the sidebar key, over the chats column
 *   title    the chat's title and the title bar's cluster
 *   needs    NEEDS YOU and its count (the shell's; empty on the desk)
 *   funds    the static network statement (Mainnet, Real funds)
 *   vex      over Vex's panel at the right: the shell's VEX cell and its
 *            hide or show key, the desk's Vex key over her column
 *   reserve  the Windows and Linux caption buttons' reserve, `--overlay-w`
 *            wide (0 on macOS and on a native frame), a drag region with
 *            nothing in it
 *
 * `vex` null sizes the VEX cell to what it holds. The VEX cell and the
 * reserve share the right-hand column: the cell is the column less
 * `--overlay-w`, so on Windows and Linux the caption buttons stand over the
 * column's top right and the cell over the rest of it, and on macOS (an
 * `--overlay-w` of 0) the cell is the column's whole width.
 */
export interface ShellHeadInput {
  /** The chats track under the logo and sidebar key cells. */
  readonly chats: number;
  /** Her panel (the desk's column) under the VEX cell, with the reserve; null is as wide as the cell's contents. */
  readonly vex: number | null;
}

/** The header's own column template, with each cell's named lines. */
export function shellHeadTemplateColumns(input: ShellHeadInput): string {
  const chats = `[chats-start] ${String(input.chats)}px [chats-end title-start] minmax(0, 1fr) [title-end`;
  const cells = "needs-start] auto [needs-end funds-start] auto [funds-end";
  const vex = input.vex === null ? "auto" : `calc(${String(input.vex)}px - var(--overlay-w))`;
  return `${chats} ${cells} vex-start] ${vex} [vex-end reserve-start] var(--overlay-w) [reserve-end]`;
}
