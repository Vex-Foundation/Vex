/**
 * THE RESOLVED THEME, per theme attribute, against the REAL stylesheet.
 *
 * `terminal-palette-tokens.test.ts` pins the token contract as CSS text. This
 * suite is the other half, in the shape VS Code's `xtermTerminal.test.ts`
 * `suite('theme')` uses: mount the stylesheet, resolve the theme against a root
 * carrying each theme attribute, assert the whole resolved `ITheme`, flip, and
 * assert again. jsdom selects custom properties but does not resolve var()
 * chains. The fixture materializes those chains from the real stylesheet
 * before mounting it. Chromium surface captures cover the native cascade.
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
 * Both modes paint opaque text backgrounds and carry the RGB of that surface,
 * so the answer classifies by theme. The transparent-RGB protocol stays valid.
 *
 * The last suite computes the reply BYTES xterm sends for each resolved
 * background and classifies them, so the wire contract is proven on every
 * platform without a pty: the e2e probe in `terminal-glass-probes.ts` types
 * a POSIX shell line and records itself unmeasured where the Studio launches
 * `ComSpec`.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { readTerminalTheme } from "../terminal-palette.js";
import { TerminalRegistry } from "../terminal-registry.js";
import { installMatchMedia } from "./terminal-harness.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const tokensCss = readFileSync(
  path.join(here, "..", "..", "..", "..", "..", "styles", "global-css", "tokens.css"),
  "utf8",
);

/** Resolve the CSS var chains that jsdom leaves literal, using source tokens. */
function terminalThemeFixture(): string {
  const source = tokensCss.replace(/\/\*[\s\S]*?\*\//g, "");
  const declarations = (body: string): Map<string, string> => new Map(
    [...body.matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)].map((match) => [match[1] ?? "", match[2]?.trim() ?? ""]),
  );
  const rootAt = source.indexOf(":root {");
  const inherited = declarations(source.slice(0, rootAt));
  const rules: string[] = [];
  for (const match of source.matchAll(/(^:root|^\[data-vex-theme="celeris"\]) \{([\s\S]*?)^\}/gm)) {
    const selector = match[1] ?? "";
    const own = declarations(match[2] ?? "");
    const values = new Map([...inherited, ...own]);
    const resolve = (value: string, seen = new Set<string>()): string => value.replace(
      /var\((--[a-z0-9-]+)\)/g,
      (_reference, token: string) => {
        if (seen.has(token)) throw new Error(`Cyclic CSS token ${token}`);
        const next = values.get(token);
        if (next === undefined) throw new Error(`Missing CSS token ${token}`);
        return resolve(next, new Set([...seen, token]));
      },
    );
    rules.push(`${selector} {\n${[...own].filter(([name]) => name.startsWith("--vex-alias-term-"))
      .map(([name, value]) => `  ${name}: ${resolve(value)};`).join("\n")}\n}`);
    if (selector === ":root") for (const [name, value] of own) inherited.set(name, value);
  }
  return rules.join("\n");
}

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

/**
 * The OSC 11 reply xterm 6.0.0 sends for a theme background, byte for byte:
 * `CoreBrowserTerminal` answers a REPORT with `ESC ] 11 ; <rgb> ESC \`, the
 * colour going through `color.toColorRGB` (alpha dropped) and
 * `toRgbString(rgb, 16)`, which writes each 8-bit channel as the 16-bit form
 * `hh` + `hh` (`XParseColor.pad`, default branch). So `#ffffff00` is answered
 * `rgb:ffff/ffff/ffff`, never black.
 */
function osc11ReplyBytes(hex8: string): string {
  const { r, g, b } = channels(hex8);
  const channel16 = (value: number): string => {
    const hh = value.toString(16).padStart(2, "0");
    return hh + hh;
  };
  return `\x1b]11;rgb:${channel16(r)}/${channel16(g)}/${channel16(b)}\x1b\\`;
}

/**
 * Read a reply the way the asking program does: the `rgb:` triple, each
 * channel scaled by its own digit count back to 8 bits (xterm's `parseColor`
 * and the e2e probe read it the same way), then Claude Code's linear rule.
 */
function classifyOsc11Reply(reply: string): { rgb: [number, number, number]; theme: "light" | "dark" } {
  const match = /^\x1b\]11;rgb:([0-9a-f]+)\/([0-9a-f]+)\/([0-9a-f]+)\x1b\\$/.exec(reply);
  if (match === null) throw new Error(`not an OSC 11 reply: ${JSON.stringify(reply)}`);
  const channel = (hex: string | undefined): number => {
    const digits = hex ?? "";
    return Math.round((parseInt(digits, 16) / (16 ** digits.length - 1)) * 255);
  };
  const rgb: [number, number, number] = [channel(match[1]), channel(match[2]), channel(match[3])];
  const weighted = (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255;
  return { rgb, theme: weighted > 0.5 ? "light" : "dark" };
}

function setTheme(theme: "chronos" | "celeris"): void {
  if (theme === "chronos") {
    document.documentElement.removeAttribute("data-vex-theme");
  } else {
    document.documentElement.setAttribute("data-vex-theme", theme);
  }
}

beforeAll(() => {
  installMatchMedia();
  const sheet = document.createElement("style");
  sheet.dataset["terminalThemeSuite"] = "tokens";
  sheet.textContent = terminalThemeFixture();
  document.head.appendChild(sheet);
});

afterAll(() => {
  document.querySelector('[data-terminal-theme-suite="tokens"]')?.remove();
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

    // xterm-supported syntax, intentional opacity, and the actual surface RGB.
    const background = typed.background ?? "";
    expect(background).toMatch(/^#[0-9a-f]{8}$/);
    expect(channels(background).a).toBe(255);
    expect(background, `${theme} background is colourless`).not.toBe(COLOURLESS);
    expect(claudeCodeClassifies(background)).toBe(expected);
    // The glyph colour under a block cursor reuses the background token.
    expect(resolved["cursorAccent"]).toBe(background);
    expect(typed.foreground).toBe(theme === "celeris" ? "#12141c" : "#e3e7ef");
    expect(typed.cursor).toBe(theme === "celeris" ? "#0000c0" : "#7a8cff");
    expect(typed.selectionBackground?.replace(/\s/g, "")).toBe(theme === "celeris" ? "rgba(10,13,24,0.14)" : "rgba(255,255,255,0.18)");
    expect(typed.selectionForeground).toBeUndefined();
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

  it.each([
    ["chronos", "dark"],
    ["celeris", "light"],
  ] as const)("the OSC 11 reply bytes for %s classify as %s without a pty", (theme, expected) => {
    setTheme(theme);
    const background = readTerminalTheme(document.documentElement).background ?? "";
    const reply = osc11ReplyBytes(background);
    const { r, g, b } = channels(background);
    const hh = (value: number): string => value.toString(16).padStart(2, "0");

    // The bytes carry the token's RGB in the 16-bit form and no alpha at all,
    // so a program that asks reads the surface colour, not the transparency.
    expect(reply).toBe(`\x1b]11;rgb:${hh(r)}${hh(r)}/${hh(g)}${hh(g)}/${hh(b)}${hh(b)}\x1b\\`);
    expect(reply).not.toContain("rgb:0000/0000/0000");
    const read = classifyOsc11Reply(reply);
    expect(read.rgb).toEqual([r, g, b]);
    expect(read.theme).toBe(expected);
  });

  it("the colourless fallback would be answered as black, which is why the tokens carry an RGB", () => {
    // The pre-fix defect, pinned as arithmetic: an alpha-0 black token answers
    // `rgb:0000/0000/0000` and every asking program picks dark, in light mode too.
    const reply = osc11ReplyBytes(COLOURLESS);
    expect(reply).toBe("\x1b]11;rgb:0000/0000/0000\x1b\\");
    expect(classifyOsc11Reply(reply).theme).toBe("dark");
  });

  it.each(["chronos", "celeris"] as const)("creates in %s and updates a running xterm's OSC 10/11 replies while retaining its buffer", async (initialTheme) => {
    setTheme(initialTheme);
    const registry = new TerminalRegistry({
      webglLoader: () => Promise.reject(new Error("no WebGL in jsdom")),
    });
    const replies: string[] = [];
    const entry = registry.acquire("theme-switch");
    const subscription = entry.terminal.onData((data) => replies.push(data));
    try {
      expect(entry.terminal.options.minimumContrastRatio).toBe(4.5);
      expect(entry.terminal.options.allowTransparency).toBe(false);
      await new Promise<void>((resolve) => entry.terminal.write("client remains running", resolve));
      for (const [theme, background, foreground] of [
        ["celeris", "#ffffffff", "#12141cff"],
        ["chronos", "#0a0d18ff", "#e3e7efff"],
        ["celeris", "#ffffffff", "#12141cff"],
      ] as const) {
        setTheme(theme);
        // MutationObserver publication happens at the microtask checkpoint.
        await Promise.resolve();
        expect(entry.terminal.options.minimumContrastRatio).toBe(4.5);
        expect(entry.terminal.options.allowTransparency).toBe(false);
        expect(entry.terminal.options.theme?.background).toBe(background);
        await new Promise<void>((resolve) => entry.terminal.write("\x1b]10;?\x07\x1b]11;?\x07", resolve));
        expect(replies.slice(-2)).toEqual([
          osc11ReplyBytes(foreground).replace("]11;", "]10;"),
          osc11ReplyBytes(background),
        ]);
        expect(entry.terminal.buffer.active.getLine(0)?.translateToString(true)).toBe("client remains running");
      }
      expect(registry.acquire("theme-switch").terminal).toBe(entry.terminal);
    } finally {
      subscription.dispose();
      registry.disposeAll();
    }
  });

  it.each(["chronos", "celeris"] as const)("retains SGR 90, dim and reverse-video cell semantics in %s", async (theme) => {
    setTheme(theme);
    const registry = new TerminalRegistry({
      webglLoader: () => Promise.reject(new Error("no WebGL in jsdom")),
    });
    const { terminal } = registry.acquire("sgr-fixture");
    try {
      // Parsing is real xterm. Pixel contrast and selected/cursor painting need
      // the Electron capture; the token suite tests the dim compositing target.
      await new Promise<void>((resolve) => terminal.write(
        "\x1b[90mB\x1b[0m\x1b[2mD\x1b[0m\x1b[7mR\x1b[0m", resolve,
      ));
      const row = terminal.buffer.active.getLine(0);
      expect(row?.translateToString(true)).toBe("BDR");
      expect(row?.getCell(0)?.getFgColor()).toBe(8);
      expect(row?.getCell(0)?.isFgPalette()).toBeTruthy();
      expect(row?.getCell(1)?.isDim()).toBeTruthy();
      expect(row?.getCell(1)?.isFgDefault()).toBeTruthy();
      expect(row?.getCell(2)?.isInverse()).toBeTruthy();
      expect(row?.getCell(2)?.isFgDefault()).toBeTruthy();
      expect(row?.getCell(2)?.isBgDefault()).toBeTruthy();
    } finally {
      registry.disposeAll();
    }
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
