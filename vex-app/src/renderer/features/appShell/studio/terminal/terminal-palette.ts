/**
 * THE TERMINAL PALETTE BRIDGE.
 *
 * xterm paints to a canvas (or to DOM nodes it owns), so it can consume neither
 * `var(--vex-alias-*)` nor a Tailwind utility: it takes concrete colour strings
 * on `options.theme`. The bridge is the same one `Board/boardChartTheme.ts`
 * built for lightweight-charts - RESOLVE the semantic aliases against a live
 * element with `getComputedStyle`, hand the library the resulting strings, and
 * re-resolve when `data-vex-theme` flips - so the terminal repoints through the
 * same aliases as every other surface with no second palette to keep in sync.
 *
 * The token contract itself is tested as CSS text in
 * `styles/global-css/__tests__/terminal-palette-tokens.test.ts`; this module is
 * only the reader. The sixteen ANSI slots are deliberately raw hex IN THE
 * STYLESHEET because they are a wire contract with programs emitting SGR 30-37
 * and 90-97, not brand decisions.
 *
 * The fallbacks below are neutral `rgba()` values, never brand colours, for the
 * same reason the board's are: an environment without computed styles (jsdom, a
 * paint before the stylesheet resolves) should look obviously unthemed rather
 * than plausibly correct, so a broken token lookup is visible instead of hidden.
 */

import type { ITheme } from "@xterm/xterm";

/** The 16 ANSI slots, in the order SGR numbers them, paired with their token. */
const ANSI_SLOTS = [
  ["black", "black"],
  ["red", "red"],
  ["green", "green"],
  ["yellow", "yellow"],
  ["blue", "blue"],
  ["magenta", "magenta"],
  ["cyan", "cyan"],
  ["white", "white"],
  ["brightBlack", "bright-black"],
  ["brightRed", "bright-red"],
  ["brightGreen", "bright-green"],
  ["brightYellow", "bright-yellow"],
  ["brightBlue", "bright-blue"],
  ["brightMagenta", "bright-magenta"],
  ["brightCyan", "bright-cyan"],
  ["brightWhite", "bright-white"],
] as const satisfies readonly (readonly [keyof ITheme, string])[];

const NEUTRAL = "rgba(128, 136, 152, 1)";

/**
 * Transparent, IN THE ONE SYNTAX XTERM ACCEPTS.
 *
 * xterm 6.0.0 resolves a theme colour with `css.toColor`, which takes hex
 * (3-8 digits) and `rgb()/rgba()` directly and sends everything else to a 1x1
 * canvas probe that THROWS when the result is not fully opaque
 * (`css.toColor: Unsupported css format`). `ThemeService` swallows that throw
 * and keeps its own default, `#000000`. So the CSS keyword `transparent` -
 * which this bridge and the stylesheet both used to hand over - produced an
 * OPAQUE BLACK canvas in both themes: the dark theme looked deliberate and the
 * light theme shipped near-black ink on black. The 8-digit hex takes the fast
 * path with alpha 0. Terminals are created with `allowTransparency: true` so
 * that alpha reaches the renderer instead of being composited away.
 *
 * THIS IS THE FALLBACK ONLY, and it is colourless on purpose. The stylesheet's
 * own background tokens keep the alpha at 0 but carry the RGB of the surface
 * the pane paints in each theme (`--vex-alias-bg-base`: `#0a0d1800` in
 * chronos, `#ffffff00` in celeris), because `options.theme.background` is also
 * the terminal's ANSWER to a program's OSC 11 query: xterm reports it with the
 * alpha dropped (`color.toColorRGB` keeps r, g, b), and Claude Code in `auto`
 * mode, bat, delta and nvim pick light or dark from that answer. A colourless
 * token answered "black" in light mode and got Claude Code's dark chrome
 * painted over the light pane (measured 2026-09-04). The fallback stays
 * colourless because an environment without computed styles should look
 * unthemed, not plausibly light or dark.
 */
const TRANSPARENT = "#00000000";

/**
 * Read one custom property off `element`'s computed style. An unknown property
 * returns the empty string, which is treated exactly like an absent one.
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
 * Resolve the whole xterm theme against `element`.
 *
 * The BACKGROUND keeps alpha 0 by contract: the pane paints its own surface and
 * layers the brand watermark UNDER the terminal, so an opaque background here
 * would hide it. Its RGB is NOT free, though: it is what xterm reports to a
 * program asking with OSC 11, so the stylesheet carries the pane's surface RGB
 * per theme and this reader hands it over untouched. The fallback is colourless
 * (`#00000000`) because a fallback that painted a colour would break the
 * watermark exactly when the token lookup failed, and because the keyword
 * `transparent` is not transparent to xterm at all (see {@link TRANSPARENT}).
 * `cursorAccent` (the glyph colour under a block cursor) reuses the same token.
 */
export function readTerminalTheme(element: HTMLElement | null): ITheme {
  const styles =
    element !== null && typeof window !== "undefined"
      ? window.getComputedStyle(element)
      : null;

  const theme: Record<string, string> = {
    background: readVar(styles, "--vex-alias-term-background", TRANSPARENT),
    foreground: readVar(styles, "--vex-alias-term-foreground", NEUTRAL),
    cursor: readVar(styles, "--vex-alias-term-cursor", NEUTRAL),
    cursorAccent: readVar(styles, "--vex-alias-term-background", TRANSPARENT),
    selectionBackground: readVar(
      styles,
      "--vex-alias-term-selection",
      "rgba(128, 136, 152, 0.24)",
    ),
  };
  // NOT HERE: the scrollbar slider (`scrollbarSliderBackground` and its
  // hover/active pair). xterm 6 paints its slider through a `<style>` element
  // it injects into the terminal, and the renderer's CSP (`style-src 'self'`,
  // index.html) refuses inline sheets, so those keys never reach a pixel
  // (measured on the built app 2026-09-04: with all three set, the slider's
  // computed background stayed rgba(0, 0, 0, 0)). The slider is a real
  // element, so scrollbars.css colours it from the app's own scrollbar pair.
  for (const [key, slot] of ANSI_SLOTS) {
    theme[key] = readVar(styles, `--vex-alias-term-${slot}`, NEUTRAL);
  }
  return theme as ITheme;
}

/**
 * Observe theme flips on the document root and re-resolve.
 *
 * Same mechanism `Board/BoardChart.tsx` uses: `data-vex-theme` is the only
 * attribute that repoints the aliases, so a filtered `MutationObserver` on the
 * root is both sufficient and cheap. Returns an idempotent disposer; the caller
 * owns it.
 */
export function observeTerminalTheme(onChange: () => void): () => void {
  if (typeof MutationObserver !== "function" || typeof document === "undefined") {
    return () => undefined;
  }
  const observer = new MutationObserver(() => {
    onChange();
  });
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-vex-theme"],
  });
  let disconnected = false;
  return () => {
    if (disconnected) return;
    disconnected = true;
    observer.disconnect();
  };
}

/** Whether the OS asks for reduced motion. Smooth scroll is the only inertia. */
export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
