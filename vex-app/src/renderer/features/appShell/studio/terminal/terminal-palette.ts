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
 * The BACKGROUND stays transparent by contract: the pane paints its own surface
 * and layers the brand watermark UNDER the terminal, so an opaque background
 * here would hide it. The stylesheet declares `transparent` in both themes and
 * the fallback repeats it, because a fallback that painted a colour would break
 * the watermark exactly when the token lookup failed.
 */
export function readTerminalTheme(element: HTMLElement | null): ITheme {
  const styles =
    element !== null && typeof window !== "undefined"
      ? window.getComputedStyle(element)
      : null;

  const theme: Record<string, string> = {
    background: readVar(styles, "--vex-alias-term-background", "transparent"),
    foreground: readVar(styles, "--vex-alias-term-foreground", NEUTRAL),
    cursor: readVar(styles, "--vex-alias-term-cursor", NEUTRAL),
    cursorAccent: readVar(styles, "--vex-alias-term-background", "transparent"),
    selectionBackground: readVar(
      styles,
      "--vex-alias-term-selection",
      "rgba(128, 136, 152, 0.24)",
    ),
  };
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
