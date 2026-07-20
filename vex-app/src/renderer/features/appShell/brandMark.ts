/**
 * The Vex brand mark, in one place.
 *
 * The app has always had a theme-swapped static mark — the script monogram
 * (`/logo_clean.png`) normally, the white Robinhood feather in the Robinhood
 * theme. It lived inline in `SidebarHomeSigil`, which was fine while the rail
 * was the only thing that carried the brand. The mission summary card now
 * signs the agent's half of the report with the same mark, so the sources and
 * the theme rule move here: two copies of a theme swap is how a build ends up
 * showing the Vex monogram in the Robinhood skin.
 *
 * Sizing deliberately stays with each caller — the rail wants a ~24px crown,
 * the summary card a ~13px inline glyph, and that is a layout decision, not a
 * brand one.
 */

import { useUiStore } from "../../stores/uiStore.js";

/** Vex script monogram (square PNG). */
export const VEX_LOGO_SRC = "/logo_clean.png";

/** Robinhood white feather mark (portrait SVG). */
export const ROBINHOOD_LOGO_SRC = "/logo/robinhood.svg";

/** The brand mark source for the active theme. */
export function useBrandMarkSrc(): string {
  const theme = useUiStore((s) => s.theme);
  return theme === "robinhood" ? ROBINHOOD_LOGO_SRC : VEX_LOGO_SRC;
}
