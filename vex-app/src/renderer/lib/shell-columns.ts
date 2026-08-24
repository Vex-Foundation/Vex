/**
 * Pure concession-chain column solver for the three-column shell frame
 * (sidebar | session column | BOOK). Chain order is fixed by contract: keep
 * center >= CENTER_MIN by shrinking BOOK, then auto-closing it to its spine
 * (derived width — stored preferences are never rewritten, so widening the
 * window restores them). The sidebar never concedes: its rendered width is
 * always the drag preference (or the collapsed rail), and center absorbs any
 * remaining deficit as the last resort. Inputs are plain width preferences
 * (0 = closed); a closed sidebar resolves to the fixed SIDEBAR_COLLAPSED
 * rail and a closed BOOK resolves to its BOOK_COLLAPSED spine. The
 * SIDEBAR_AUTO_COLLAPSE breakpoint is consumed by AppShell, which decides
 * the effective sidebar preference before solving; the solver itself stays
 * breakpoint-free and hysteresis-free.
 */

/** Resolved widths for one frame; center may drop below CENTER_MIN only at the final fallback. */
export interface ShellColumns {
  readonly sidebar: number;
  readonly center: number;
  readonly book: number;
}

/** Center column floor; only the final fallback may go below it. */
export const CENTER_MIN = 640;
/** Sidebar drag clamp floor. */
export const SIDEBAR_MIN = 264;
/** Sidebar drag clamp ceiling. */
export const SIDEBAR_MAX = 420;
/** Sidebar width before any user drag. */
export const SIDEBAR_DEFAULT = 280;
/** Closed-sidebar icon rail. */
export const SIDEBAR_COLLAPSED = 56;
/** Viewport width below which the sidebar auto-collapses to the rail; a
 * manual toggle below it re-expands over the squeezed center. */
export const SIDEBAR_AUTO_COLLAPSE = 1024;
/** BOOK drag clamp floor. */
export const BOOK_MIN = 300;
/** BOOK drag clamp ceiling. */
export const BOOK_MAX = 520;
/** BOOK width before any user drag. */
export const BOOK_DEFAULT = 360;
/** Closed-BOOK spine (the collapse header + toggle stays visible). */
export const BOOK_COLLAPSED = 48;
/**
 * Width the WELCOME stage's floating Portfolio tab reserves while open
 * (24px gutter + 340px card stack + 16px breathing).
 *
 * ONE constant for two consumers that must agree exactly: `WelcomePortfolioPanel`
 * sizes its aside from it and `AppShell` reserves the shell's third grid track
 * from it, so the child width and the reservation cannot drift. It lives here
 * rather than in the panel because the frame must not import a feature
 * component's internals to lay itself out.
 *
 * WHY THE TRACK MUST BE NUMERIC. The frame transitions `grid-template-columns`
 * for 300ms. `auto` <-> length is not interpolable, so on the welcome<->session
 * edge the retained `auto` track was re-solved against the newly mounted BOOK
 * rail's intrinsic content and swept the rail through the centre column before
 * the pixel track won (owner QA item 8). Every state now emits a length.
 */
export const WELCOME_PORTFOLIO_WIDTH = 380;

/**
 * Clamp a panel width into its contract range and round to whole pixels.
 */
export function clampWidth(px: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(px)));
}

/**
 * Solve the three column widths for one viewport frame. Pure: no hysteresis —
 * the output is a function of (viewport, preferences) only, so recovery on
 * re-widening is automatic. Preferences re-clamp here because they cross the
 * store boundary and callers may still supply stale ranges.
 *
 * @param viewport - available frame width in px.
 * @param sidebar - sidebar width preference in px (0 = collapsed rail).
 * @param book - BOOK width preference in px (0 = closed spine).
 */
export function computeShellColumns(
  viewport: number,
  sidebar: number,
  book: number,
): ShellColumns {
  // The sidebar is fixed at its preference (or the rail) — it never concedes.
  const s =
    sidebar === 0
      ? SIDEBAR_COLLAPSED
      : clampWidth(sidebar, SIDEBAR_MIN, SIDEBAR_MAX);
  const b0 = book === 0 ? BOOK_COLLAPSED : clampWidth(book, BOOK_MIN, BOOK_MAX);

  // Step 1: everything fits at preferred widths.
  if (s + b0 + CENTER_MIN <= viewport) {
    return { sidebar: s, center: viewport - s - b0, book: b0 };
  }

  // Step 2: shrink an open BOOK toward its minimum, center pinned at floor.
  if (book !== 0) {
    const b1 = Math.max(BOOK_MIN, viewport - s - CENTER_MIN);
    if (s + b1 + CENTER_MIN <= viewport) {
      return { sidebar: s, center: CENTER_MIN, book: b1 };
    }
  }

  // Step 3: auto-close BOOK to the spine (derived — preferences untouched);
  // center absorbs any remaining deficit (may drop below CENTER_MIN).
  return {
    sidebar: s,
    center: Math.max(0, viewport - s - BOOK_COLLAPSED),
    book: BOOK_COLLAPSED,
  };
}
