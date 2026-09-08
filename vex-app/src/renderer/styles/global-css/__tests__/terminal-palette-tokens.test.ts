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
 *  3. a background that misreports the surface through OSC 11. Dark mode
 *     and light modes own opaque reading surfaces. Both use xterm's supported
 *     eight-digit hex syntax.
 *  4. a palette that parses and is still unreadable. Light mode measures
 *     every text slot against its actual opaque background, including SGR 90.
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

  it.each([
    ["chronos", chronos, "ff"],
    ["celeris", celeris, "ff"],
  ])("pins surface opacity and OSC 11 RGB (%s)", (name, body, alpha) => {
    // Both themes have a stable reading ground. OSC 11 reports its RGB.
    const value = declarationValue(body, "--vex-alias-term-background");
    expect(value, `${name} must not use the keyword xterm rejects`).not.toBe("transparent");
    const match = /^#([0-9a-f]{6})([0-9a-f]{2})$/.exec(value ?? "");
    expect(match, `${name} background "${String(value)}" is not an 8-digit hex`).not.toBeNull();
    if (match === null) return;
    expect(match[2], `${name} background alpha`).toBe(alpha);
    expect(`#${match[1] ?? ""}`, `${name} background RGB`).toBe(
      resolveHex(body, "--vex-alias-bg-base"),
    );
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
  ])("clears the normal-text contrast floor on the actual opaque reading surface (%s)", (theme, body) => {
    // This exact opaque background is painted by both the wrapper and xterm.
    const background = declarationValue(body, "--vex-alias-term-background");
    if (background === undefined) throw new Error("Terminal background token is missing");
    const surface = background.slice(0, 7);
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

  it.each([
    ["chronos", chronos],
    ["celeris", celeris],
  ])("keeps default SGR 2 dim text above its separate 3:1 target (%s)", (_theme, body) => {
    // xterm's opaque atlas composites SGR 2 at 50% before rasterization.
    // This tests a fully covered glyph pixel, not an antialiased edge. Dim
    // deliberately has a 3:1 target: even black at 50% cannot reach 4.5 on white.
    const background = declarationValue(body, "--vex-alias-term-background");
    if (background === undefined) throw new Error("Terminal background token is missing");
    const foreground = resolveHex(body, "--vex-alias-term-foreground");
    const surface = background.slice(0, 7);
    const dim = "#" + [1, 3, 5].map((at) => Math.round(
      (parseInt(foreground.slice(at, at + 2), 16) + parseInt(surface.slice(at, at + 2), 16)) / 2,
    ).toString(16).padStart(2, "0")).join("");
    expect(contrastRatio(dim, surface)).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(resolveHex(body, "--vex-alias-term-bright-black"), surface)).toBeGreaterThanOrEqual(4.5);
  });

  it("uses light primary ink for the default foreground without changing ANSI black", () => {
    expect(declarationValue(celeris, "--vex-alias-term-foreground")).toBe("var(--vex-alias-label-primary)");
    expect(resolveHex(celeris, "--vex-alias-term-foreground")).toBe("#12141c");
    expect(resolveHex(celeris, "--vex-alias-term-black")).toBe("#2b3040");
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
