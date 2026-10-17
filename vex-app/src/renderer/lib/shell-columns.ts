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
