/**
 * THE TERMINAL PALETTE - a token contract, tested as CSS TEXT.
 *
 * xterm paints to a canvas, so it sits outside both the token system and
 * Tailwind: it cannot consume `var(--vex-alias-*)` and it cannot be restyled by
 * a stylesheet. The bridge is to RESOLVE these aliases with `getComputedStyle`
 * and hand xterm concrete strings, exactly as `boardChartTheme.ts` does for
 * lightweight-charts. That makes the STYLESHEET the contract, and these are the
 * three ways it can break silently:
 *
 *  1. a slot defined in one theme block and not the other, so the terminal
 *     renders a missing colour as the bridge's neutral fallback in one theme
 *     only - which looks like a rendering bug, not a missing token;
 *  2. an incomplete ANSI set, so a program emitting SGR 35 gets whatever the
 *     fallback is while SGR 31 is themed;
 *  3. a background that is not transparent, which would paint over the
 *     watermark the pane deliberately layers underneath - AND, measured in the
 *     UX audit of 2026-09-02, a background spelled in a syntax xterm's own
 *     parser rejects, which is the same defect wearing a correct-looking
 *     stylesheet. xterm 6.0.0 parses theme colours with `css.toColor`: hex and
 *     `rgb()/rgba()` take a fast path, anything else goes to a 1x1 canvas
 *     probe that THROWS when the alpha is not 255, and `ThemeService` swallows
 *     that throw and keeps `#000000`. The keyword `transparent` therefore
 *     painted an OPAQUE BLACK canvas in both themes. The test below pins the
 *     8-digit hex, which is the syntax the parser accepts with alpha 0;
 *     `allowTransparency: true` in `terminal-registry.ts` is its other half.
 *  4. a palette that parses and is still unreadable. The canvas is transparent,
 *     so the colour a glyph competes with is the SURFACE UNDER IT - the
 *     `--vex-alias-bg-layer-1` card `XtermHost` paints - and the contrast table
 *     below measures every slot against it in both themes.
 *
 * Unlike every other alias family here, the sixteen ANSI slots are RAW HEX on
 * purpose. They are a wire contract with programs that emit SGR 30-37 and
 * 90-97 - `git diff`, `ls`, a shell prompt - not brand decisions. Bending them
 * onto the brand ramp would misrender output whose meaning IS the colour.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const tokensCss = readFileSync(path.join(here, "..", "tokens.css"), "utf8");

function ruleBody(css: string, selector: string): string {
  const at = css.indexOf(`${selector} {`);
  expect(at, `selector "${selector}" not found`).toBeGreaterThanOrEqual(0);
  const open = css.indexOf("{", at);
  const close = css.indexOf("\n}", open);
  return css.slice(open + 1, close);
}

const chronos = ruleBody(tokensCss, ":root");
const celeris = ruleBody(tokensCss, '[data-vex-theme="celeris"]');

/** The 16 ANSI slots, in the order SGR numbers them. */
const ANSI_SLOTS = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "bright-black",
  "bright-red",
  "bright-green",
  "bright-yellow",
  "bright-blue",
  "bright-magenta",
  "bright-cyan",
  "bright-white",
] as const;

/** The chrome xterm needs on top of the ANSI set. */
const CHROME_SLOTS = ["background", "foreground", "cursor", "selection"] as const;

const REQUIRED = [
  ...CHROME_SLOTS.map((slot) => `--vex-alias-term-${slot}`),
  ...ANSI_SLOTS.map((slot) => `--vex-alias-term-${slot}`),
];

/** WCAG 2.1 AA for body-size text, which is what a terminal renders. */
const WCAG_AA_NORMAL_TEXT = 4.5;

/**
 * The slots allowed below the floor, per theme, with the floor they still owe.
 *
 * ONE entry, and it is a wire-contract decision rather than a concession.
 * SGR 30 means "the dark end of the ramp": a program paints it as a background
 * or against a light fill of its own, and every dark terminal on the platform
 * (VS Code's Dark+ puts `terminal.ansiBlack` at #000000 over a #1e1e1e panel,
 * 1.16:1) renders it at roughly this ratio. Lifting it to 4.5:1 would make a
 * black-on-yellow warning banner unreadable in the direction that matters.
 * The celeris block has no exception: on a white card, black IS the readable
 * end.
 */
const CONTRAST_EXCEPTIONS: Readonly<Record<string, Readonly<Record<string, number>>>> = {
  chronos: { black: 1 },
};

/** Resolve a `var(--x)` chain in one theme body down to a literal hex. */
function resolveHex(body: string, token: string): string {
  let value: string | undefined = declarationValue(body, token);
  // The static ramp lives in its own block above both themes, so a hop that
  // leaves the theme body falls back to the whole stylesheet - theme-first,
  // which is what makes the same alias resolve differently per theme. Six hops
  // is far more than any chain here and stops a cycle from hanging the suite.
  for (let hop = 0; hop < 6 && value !== undefined; hop += 1) {
    if (/^#[0-9a-f]{6}$/i.test(value)) return value;
    const ref = /^var\((--[a-z0-9-]+)\)$/i.exec(value)?.[1];
    if (ref === undefined) break;
    value = declarationValue(body, ref) ?? declarationValue(tokensCss, ref);
  }
  throw new Error(`${token} does not resolve to a 6-digit hex (got ${String(value)})`);
}

function declarationValue(body: string, token: string): string | undefined {
  return new RegExp(`${token}:\\s*([^;]+);`).exec(body)?.[1]?.trim();
}

/** WCAG relative luminance of an `#rrggbb` colour. */
function luminance(hex: string): number {
  const packed = parseInt(hex.slice(1), 16);
  const channels = [(packed >> 16) & 0xff, (packed >> 8) & 0xff, packed & 0xff].map(
    (byte) => {
      const unit = byte / 255;
      return unit <= 0.03928 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
    },
  ) as [number, number, number];
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrastRatio(a: string, b: string): number {
  const first = luminance(a);
  const second = luminance(b);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

function declaredIn(body: string): string[] {
  return [
    ...new Set(
      [...body.matchAll(/(--vex-alias-term-[a-z-]+)\s*:/g)].map(
        (match) => match[1] as string,
      ),
    ),
  ].sort();
}

describe("terminal palette tokens", () => {
  it("declares the complete ANSI set plus the chrome slots", () => {
    // An incomplete set is not a cosmetic gap: a program emitting SGR 35 would
    // fall back while SGR 31 stayed themed, so output would be half-coloured.
    for (const token of REQUIRED) {
      expect(chronos, `${token} missing from chronos`).toContain(`${token}:`);
    }
    expect(declaredIn(chronos)).toHaveLength(REQUIRED.length);
  });

  it("defines EVERY terminal alias in BOTH theme blocks", () => {
    // A dark-only token renders as the bridge's neutral fallback in celeris,
    // which reads as a rendering bug rather than a missing token.
    expect(declaredIn(celeris)).toEqual(declaredIn(chronos));
  });

  it("keeps the terminal background transparent IN A SYNTAX XTERM PARSES", () => {
    // The pane paints its own surface and the watermark sits UNDER the
    // terminal. An opaque background would hide it, in one theme or both.
    //
    // The keyword `transparent` looks like it says this and does the opposite:
    // xterm's parser rejects it, ThemeService keeps its `#000000` default, and
    // the canvas paints opaque black. Only the 8-digit hex form survives.
    for (const [name, body] of [["chronos", chronos], ["celeris", celeris]] as const) {
      expect(body, `${name} background`).toContain("--vex-alias-term-background: #00000000;");
      expect(body, `${name} must not use the keyword xterm rejects`).not.toContain(
        "--vex-alias-term-background: transparent;",
      );
    }
  });

  it("gives every ANSI slot a concrete colour rather than a brand alias", () => {
    // The wire contract, stated as a test: these sixteen are the colours
    // programs MEAN, so they may not be re-pointed at the accent ramp.
    for (const body of [chronos, celeris]) {
      for (const slot of ANSI_SLOTS) {
        const match = new RegExp(
          `--vex-alias-term-${slot}:\\s*(#[0-9a-f]{6})\\s*;`,
        ).exec(body);
        expect(match, `--vex-alias-term-${slot} is not a plain hex`).not.toBeNull();
      }
    }
  });

  it.each([
    ["chronos", chronos],
    ["celeris", celeris],
  ])("clears the rule-08 contrast floor on the card it paints over (%s)", (theme, body) => {
    // WHAT THE FLOOR IS MEASURED AGAINST. The canvas is transparent, so a
    // glyph is read against the surface the pane paints under it, which is
    // `bg-surface-1` -> `--vex-alias-bg-layer-1` in `XtermHost`. Resolving the
    // var chain rather than pasting the hex keeps ONE source of truth: moving
    // the card's surface re-measures the palette instead of silently
    // invalidating the numbers in this file.
    const surface = resolveHex(body, "--vex-alias-bg-layer-1");
    const failures: string[] = [];
    for (const slot of ["foreground", ...ANSI_SLOTS] as const) {
      const ratio = contrastRatio(resolveHex(body, `--vex-alias-term-${slot}`), surface);
      const floor = CONTRAST_EXCEPTIONS[theme]?.[slot];
      if (floor !== undefined) {
        // A named exception still has a floor, so it cannot silently drift
        // further; what it may not do is disappear from this table.
        expect(ratio, `${theme}/${slot} exception`).toBeGreaterThanOrEqual(floor);
        continue;
      }
      if (ratio < WCAG_AA_NORMAL_TEXT) {
        failures.push(`${slot} ${ratio.toFixed(2)}:1 on ${surface}`);
      }
    }
    expect(failures, `${theme}: slots below WCAG AA`).toEqual([]);
  });

  it("gives the two themes DIFFERENT ANSI values, so the flip is real", () => {
    // Identical palettes would mean one theme was copied and never tuned:
    // chronos hues are lifted for a dark ground, celeris darkened for a white
    // one, and a terminal that ignored that would be unreadable in light mode.
    const hexOf = (body: string, slot: string): string | undefined =>
      new RegExp(`--vex-alias-term-${slot}:\\s*(#[0-9a-f]{6})\\s*;`).exec(body)?.[1];

    const differing = ANSI_SLOTS.filter(
      (slot) => hexOf(chronos, slot) !== hexOf(celeris, slot),
    );
    expect(differing).toHaveLength(ANSI_SLOTS.length);
  });
});
