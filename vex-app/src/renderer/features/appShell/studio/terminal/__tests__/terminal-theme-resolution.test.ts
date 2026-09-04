/**
 * THE RESOLVED THEME, per theme attribute, against the REAL stylesheet.
 *
 * `terminal-palette-tokens.test.ts` pins the token contract as CSS text. This
 * suite is the other half, in the shape VS Code's `xtermTerminal.test.ts`
 * `suite('theme')` uses: mount the stylesheet, resolve the theme against a root
 * carrying each theme attribute, assert the whole resolved `ITheme`, flip, and
 * assert again. The reader is the real `readTerminalTheme`, the cascade is
 * jsdom's own (it resolves a custom property by selector; it does NOT resolve a
 * `var()` chain, which is why the ANSI slots and the background, the literal
 * ones, are the slots asserted by value).
 *
 * WHY THE BACKGROUND GETS ITS OWN INVARIANT. `options.theme.background` is not
 * only a paint instruction: xterm 6.0.0 answers a program's OSC 11 query
 * ("what is your background colour?") from it and DROPS THE ALPHA
 * (`color.toColorRGB` keeps r, g, b). Claude Code in its `auto` theme mode
 * sends that query and applies `0.2126 r + 0.7152 g + 0.0722 b > 0.5` to pick
 * light or dark, and so do bat, delta, nvim and starship in their own words.
 * A background of `#00000000` therefore told every one of them the pane was
 * pure black, in light mode too (measured on the owner's machine 2026-09-04:
 * Claude Code's dark-theme grey `rgb(153,153,153)` on the light pane, 2.5:1).
 * The token keeps alpha 0 so the watermark survives and carries the RGB of the
 * surface the pane paints, so the answer classifies by theme.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { readTerminalTheme } from "../terminal-palette.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const tokensCss = readFileSync(
  path.join(here, "..", "..", "..", "..", "..", "styles", "global-css", "tokens.css"),
  "utf8",
);

/**
 * The stylesheet minus its Tailwind `@theme` at-rules, which jsdom's CSS
 * parser refuses (and reports on the virtual console) while parsing the rest.
 * Nothing the terminal reads lives in those blocks: the alias tier is plain
 * `:root` and `[data-vex-theme="celeris"]` rules, mounted intact. Anchored to
 * column 0 because the theme blocks MENTION `@theme` in their comments, and
 * an unanchored match would eat the block from that mention to its brace.
 */
const themeableCss = tokensCss.replace(/^@theme[^{]*\{[\s\S]*?\n\}/gm, "");

/** Every slot the bridge hands xterm, sorted, so an added or lost key shows. */
const THEME_SLOTS = [
  "background",
  "foreground",
  "cursor",
  "cursorAccent",
  "selectionBackground",
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "brightBlack",
  "brightRed",
  "brightGreen",
  "brightYellow",
  "brightBlue",
  "brightMagenta",
  "brightCyan",
  "brightWhite",
].sort();

const ANSI_KEYS = THEME_SLOTS.filter(
  (slot) => !["background", "foreground", "cursor", "cursorAccent", "selectionBackground"].includes(slot),
);

/** The reader's fallbacks: what an unthemed environment shows. */
const NEUTRAL = "rgba(128, 136, 152, 1)";
const NEUTRAL_SELECTION = "rgba(128, 136, 152, 0.24)";
const COLOURLESS = "#00000000";

/** `#rrggbbaa` to its channels, the way xterm's `css.toColor` case 9 reads it. */
function channels(hex8: string): { r: number; g: number; b: number; a: number } {
  const packed = parseInt(hex8.slice(1), 16) >>> 0;
  return {
    r: (packed >>> 24) & 0xff,
    g: (packed >>> 16) & 0xff,
    b: (packed >>> 8) & 0xff,
    a: packed & 0xff,
  };
}

/**
 * Claude Code 2.1.260's `auto` rule over an OSC 11 answer: xterm reports the
 * RGB with the alpha gone, and the detector weighs the channels linearly.
 */
function claudeCodeClassifies(hex8: string): "light" | "dark" {
  const { r, g, b } = channels(hex8);
  const weighted = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return weighted > 0.5 ? "light" : "dark";
}

function setTheme(theme: "chronos" | "celeris"): void {
  if (theme === "chronos") {
    document.documentElement.removeAttribute("data-vex-theme");
  } else {
    document.documentElement.setAttribute("data-vex-theme", theme);
  }
}

beforeAll(() => {
  const sheet = document.createElement("style");
  sheet.dataset["terminalThemeSuite"] = "tokens";
  sheet.textContent = themeableCss;
  document.head.appendChild(sheet);
});

afterEach(() => {
  document.documentElement.removeAttribute("data-vex-theme");
});

describe("readTerminalTheme against the real stylesheet", () => {
  it.each([
    ["chronos", "dark"],
    ["celeris", "light"],
  ] as const)("resolves the whole theme in %s and answers OSC 11 as %s", (theme, expected) => {
    setTheme(theme);
    const typed = readTerminalTheme(document.documentElement);
    const resolved: Record<string, unknown> = { ...typed };

    // The complete slot set, and none of it left to the fallbacks: a slot
    // that fell back would mean the stylesheet stopped declaring it.
    expect(Object.keys(resolved).sort()).toEqual(THEME_SLOTS);
    for (const slot of THEME_SLOTS) {
      expect(resolved[slot], `${theme}/${slot} fell back`).not.toBe(NEUTRAL);
      expect(resolved[slot], `${theme}/${slot} fell back`).not.toBe(NEUTRAL_SELECTION);
      expect(resolved[slot], `${theme}/${slot} is empty`).not.toBe("");
    }
    for (const key of ANSI_KEYS) {
      expect(resolved[key], `${theme}/${key} is not a wire-contract hex`).toMatch(/^#[0-9a-f]{6}$/);
    }

    // THE BACKGROUND: 8-digit hex (xterm's fast path), alpha 0 (the watermark
    // shows through), and the RGB of the pane's surface, so a program that asks
    // is told the truth about the theme it is running in.
    const background = typed.background ?? "";
    expect(background).toMatch(/^#[0-9a-f]{8}$/);
    expect(channels(background).a).toBe(0);
    expect(background, `${theme} background is colourless`).not.toBe(COLOURLESS);
    expect(claudeCodeClassifies(background)).toBe(expected);
    // The glyph colour under a block cursor reuses the background token.
    expect(resolved["cursorAccent"]).toBe(background);
  });

  it("re-resolves to the other theme's surface when the root attribute flips", () => {
    setTheme("chronos");
    const dark = readTerminalTheme(document.documentElement);
    setTheme("celeris");
    const light = readTerminalTheme(document.documentElement);

    expect(dark.background).not.toBe(light.background);
    expect(dark.foreground).not.toBe(light.foreground);
    expect(claudeCodeClassifies(dark.background ?? "")).toBe("dark");
    expect(claudeCodeClassifies(light.background ?? "")).toBe("light");
  });

  it("stays neutral and colourless with no element to resolve against", () => {
    // An unthemed environment should look unthemed: neutral chrome, and a
    // background that paints nothing rather than one theme's surface.
    const fallback: Record<string, unknown> = { ...readTerminalTheme(null) };
    expect(fallback["background"]).toBe(COLOURLESS);
    expect(fallback["cursorAccent"]).toBe(COLOURLESS);
    expect(fallback["foreground"]).toBe(NEUTRAL);
    expect(fallback["selectionBackground"]).toBe(NEUTRAL_SELECTION);
    for (const key of ANSI_KEYS) expect(fallback[key]).toBe(NEUTRAL);
  });
});
