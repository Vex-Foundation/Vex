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
 *     watermark the pane deliberately layers underneath.
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

  it("keeps the terminal background TRANSPARENT in both themes", () => {
    // The pane paints its own surface and the watermark sits UNDER the
    // terminal. An opaque background would hide it, in one theme or both.
    expect(chronos).toContain("--vex-alias-term-background: transparent;");
    expect(celeris).toContain("--vex-alias-term-background: transparent;");
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
