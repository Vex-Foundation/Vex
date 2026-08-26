/**
 * BOARD CHART THEME BRIDGE.
 *
 * lightweight-charts paints to a canvas, so it sits outside both the token
 * system and Tailwind: it cannot consume `var(--vex-alias-*)` and it cannot
 * be restyled by a stylesheet. The bridge is to RESOLVE the semantic aliases
 * against a live element with `getComputedStyle` and hand the resulting
 * concrete colors to the library. Switching `data-vex-theme` therefore
 * repoints the chart through the same aliases as every other surface, with no
 * second palette to keep in sync and no raw hex in a shell source.
 *
 * The fallbacks below are neutral `rgba()` values, not brand colors. They
 * exist for the case where computed styles are unavailable (jsdom in unit
 * tests, a canvas painted before the stylesheet resolves) and they are
 * deliberately unremarkable: a fallback that looked like the brand would hide
 * a broken token lookup instead of revealing it.
 */

const FALLBACK = {
  up: "rgba(31, 185, 84, 1)",
  down: "rgba(242, 109, 109, 1)",
  grid: "rgba(128, 128, 128, 0.12)",
  ink: "rgba(128, 136, 152, 1)",
  accent: "rgba(122, 140, 255, 1)",
  zone: "rgba(122, 140, 255, 0.14)",
} as const;

/** The concrete colors one chart instance paints with. */
export interface BoardChartPalette {
  readonly up: string;
  readonly down: string;
  readonly grid: string;
  readonly ink: string;
  readonly accent: string;
  readonly zone: string;
}

/**
 * Read one custom property off `element`'s computed style, falling back when
 * the environment has no computed styles or the property is unset. An empty
 * string is what `getPropertyValue` returns for an unknown property, so it is
 * treated exactly like an absent one.
 */
function readVar(
  styles: CSSStyleDeclaration | null,
  name: string,
  fallback: string,
): string {
  if (styles === null) return fallback;
  const raw = styles.getPropertyValue(name).trim();
  return raw === "" ? fallback : raw;
}

/**
 * Resolve the board chart palette against `element`. Call this from inside
 * the chart effect (the element is in the document by then) and again when
 * the theme changes, applying the result through `applyOptions` rather than
 * rebuilding the chart.
 */
export function readBoardChartPalette(
  element: HTMLElement | null,
): BoardChartPalette {
  const styles =
    element !== null && typeof window !== "undefined"
      ? window.getComputedStyle(element)
      : null;
  return {
    up: readVar(styles, "--vex-alias-state-success", FALLBACK.up),
    down: readVar(styles, "--vex-alias-state-error", FALLBACK.down),
    grid: readVar(styles, "--vex-alias-border-l1", FALLBACK.grid),
    ink: readVar(styles, "--vex-alias-label-tertiary", FALLBACK.ink),
    accent: readVar(styles, "--vex-alias-accent-primary", FALLBACK.accent),
    zone: readVar(styles, "--vex-alias-accent-wash", FALLBACK.zone),
  };
}

/**
 * Whether the OS asks for reduced motion. The library's only genuinely
 * inertial behavior is kinetic scroll, which the chart effect disables when
 * this is true; everything else it draws is a direct response to a gesture.
 */
export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
