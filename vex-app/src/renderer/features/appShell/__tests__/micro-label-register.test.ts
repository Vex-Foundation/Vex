/**
 * Micro-label register contract (V10).
 *
 * `.vex-micro-label` in `styles/global-css/landing-motifs.css` is the single
 * owner of the app-wide label stamp, with `.vex-micro` (the 10px caption) and
 * `.vex-eyebrow` (the section label) beside it. V10 sets all three in
 * Departure Mono, the pixel mono the website captions in: one 400 weight,
 * caps, chip or eyebrow tracking, tabular figures.
 *
 * This suite pins the register's declarations against the stylesheet TEXT so a
 * future drift is a red build rather than a review comment, and pins the two
 * tokens it stands on (the mono stack and the tracking scale) and the one
 * base rule that keeps a bold from being faked on a single-weight face. The
 * companion enforcement lives in `shell-design-guard.test.ts`: that suite bans
 * the dead class names and the sub-floor ink tiers at the CALL SITES; this one
 * guards the classes the call sites depend on.
 *
 * WHY TEXT, NOT COMPUTED STYLE: jsdom has no CSS cascade for imported
 * stylesheets, so `getComputedStyle` would report the initial value and every
 * assertion would pass vacuously. The file read is anchored on the vitest
 * project cwd (the `welcome-crown-anchor` idiom) because the Tailwind
 * transform rewrites what a `?raw` import would see.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const read = (name: string): string =>
  readFileSync(join(process.cwd(), "src/renderer/styles/global-css", name), "utf8");

const SHEET = read("landing-motifs.css");
const TOKENS = read("tokens.css");
const BASE = read("base.css");
const FONTS = read("fonts.css");

/** Extract one rule's declaration block by exact selector. */
function ruleBody(sheet: string, selector: string): string {
  const start = sheet.indexOf(`\n${selector} {`);
  expect(start, `selector not found: ${selector}`).toBeGreaterThan(-1);
  const open = sheet.indexOf("{", start);
  const close = sheet.indexOf("}", open);
  expect(close, `unterminated rule: ${selector}`).toBeGreaterThan(open);
  return sheet.slice(open + 1, close);
}

/** One custom property's declared value in tokens.css (multi-line collapsed). */
function token(name: string): string {
  const match = new RegExp(`${name}:\\s*([^;]+);`).exec(TOKENS);
  expect(match, `${name} is not declared`).not.toBeNull();
  return (match?.[1] ?? "").trim().replace(/\s+/g, " ");
}

describe("micro-label register", () => {
  it("sets the label in the mono family so call sites never re-declare it", () => {
    expect(ruleBody(SHEET, ".vex-micro-label")).toContain("font-family: var(--font-mono)");
  });

  it("pins the 11px label tier", () => {
    // 0.6875rem === 11px at the app's 16px root: Departure Mono is crispest
    // at 11, 22 and 33px.
    expect(ruleBody(SHEET, ".vex-micro-label")).toMatch(
      /font-size:\s*(?:0\.6875rem|11px)\s*;/,
    );
  });

  it("pins the face's one 400 weight", () => {
    expect(ruleBody(SHEET, ".vex-micro-label")).toMatch(/font-weight:\s*400\s*;/);
  });

  it("leaves case to the call site: an eyebrow is caps, a value keeps its own", () => {
    expect(ruleBody(SHEET, ".vex-micro-label")).not.toContain("text-transform");
  });

  it("pins tabular figures - every micro label carries numbers", () => {
    expect(ruleBody(SHEET, ".vex-micro-label")).toContain(
      "font-variant-numeric: tabular-nums",
    );
  });

  it("tracks the label at the chip step and the wide step at the eyebrow step", () => {
    expect(ruleBody(SHEET, ".vex-micro-label")).toMatch(
      /letter-spacing:\s*var\(--tracking-chip\)\s*;/,
    );
    expect(ruleBody(SHEET, ".vex-micro-label--wide")).toMatch(
      /letter-spacing:\s*var\(--tracking-eyebrow\)\s*;/,
    );
  });

  it("sets NO color, so the call site's ink tier keeps winning", () => {
    // This sheet is imported unlayered on purpose (globals.css), so it beats
    // Tailwind's @layer utilities. A `color` here would override every call
    // site's `text-*` utility. The floor TIER is enforced in
    // shell-design-guard.test.ts instead.
    expect(ruleBody(SHEET, ".vex-micro-label")).not.toMatch(/(?<!-)\bcolor:/);
  });

  it("sets NO background, border or padding: a label never carries a plate", () => {
    expect(ruleBody(SHEET, ".vex-micro-label")).not.toMatch(
      /background|border(?!-)|padding/,
    );
    expect(SHEET).not.toMatch(/\.vex-doto-chip\s*\{/);
  });

  it("declares no rule for the retired Doto register or its token", () => {
    expect(SHEET).not.toMatch(/\.vex-doto-label(?:--wide)?\s*\{/);
    expect(SHEET).not.toContain("var(--font-doto)");
  });
});

describe("the caption and the eyebrow speak the same register", () => {
  it.each([".vex-micro", ".vex-eyebrow"])("sets %s in Departure Mono caps at 400", (selector) => {
    const body = ruleBody(SHEET, selector);
    expect(body).toContain("font-family: var(--font-mono)");
    expect(body).toMatch(/font-weight:\s*400\s*;/);
    expect(body).toMatch(/text-transform:\s*uppercase\s*;/);
  });

  it("never sets any register above the mono's one weight", () => {
    for (const selector of [".vex-micro-label", ".vex-micro-label--wide", ".vex-micro", ".vex-eyebrow"]) {
      const weight = /font-weight:\s*(\d+)/.exec(ruleBody(SHEET, selector))?.[1];
      if (weight !== undefined) expect(Number(weight), selector).toBe(400);
    }
  });
});

describe("the tokens the register stands on", () => {
  it("leads the mono stack with Departure Mono, then its coverage and its metric twin", () => {
    expect(token("--font-mono")).toMatch(
      /^"Departure Mono", "JetBrains Mono", "Departure Mono Fallback",/,
    );
  });

  it("keeps code on its own JetBrains Mono stack", () => {
    expect(token("--font-code")).toMatch(/^"JetBrains Mono",/);
    expect(token("--font-code")).not.toContain("Departure Mono");
  });

  it("pins the V10 tracking scale", () => {
    expect(token("--tracking-eyebrow")).toBe("0.18em");
    expect(token("--tracking-status")).toBe("0.14em");
    expect(token("--tracking-chip")).toBe("0.12em");
  });

  it("ships Departure Mono as one 400 face with a metric-matched fallback", () => {
    const face = /@font-face\s*\{[^}]*font-family:\s*"Departure Mono";[^}]*\}/.exec(FONTS)?.[0] ?? "";
    expect(face).toContain('url("/fonts/departure-mono-regular.woff2")');
    expect(face).toMatch(/font-weight:\s*400;/);
    const twin = /@font-face\s*\{[^}]*font-family:\s*"Departure Mono Fallback";[^}]*\}/.exec(FONTS)?.[0] ?? "";
    expect(twin).toContain('local("Courier New")');
    expect(twin).toMatch(/size-adjust:\s*106\.04%;/);
  });

  it("turns weight synthesis off for the page, so a bold is never faked", () => {
    expect(ruleBody(BASE, "html")).toMatch(/font-synthesis-weight:\s*none\s*;/);
  });
});
