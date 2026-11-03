/**
 * Label register contract (H3, docs/design/H3-DESKTOP.md section 2.3).
 *
 * `.vex-micro-label` in `styles/global-css/type.css` is the single
 * owner of the app-wide label stamp, with `.vex-micro` (the caption) and
 * `.vex-eyebrow` (the section head and field label) beside it. H3 sets all
 * three in Be Vietnam Pro CAPS, tracked 0.08em, at 12 or 13px: the source
 * stays sentence case and the class paints the caps, so a screen reader
 * reads words. The money card's field labels are the one mono caps register
 * (`.vex-field-label`). Figures are Roboto Mono with `.vex-num`. This
 * replaces R3's sentence-case, untracked register.
 *
 * This suite pins the register's declarations against the stylesheet TEXT so a
 * future drift is a red build rather than a review comment, and pins the
 * tokens it stands on (the sans and mono stacks, the one caps tracking) and
 * the one base rule that keeps a weight the faces lack from being faked. The companion enforcement lives in `shell-design-guard.test.ts`:
 * that suite bans the dead class names and the sub-floor ink tiers at the
 * CALL SITES; this one guards the classes the call sites depend on.
 *
 * WHY TEXT, NOT COMPUTED STYLE: jsdom has no CSS cascade for imported
 * stylesheets, so `getComputedStyle` would report the initial value and every
 * assertion would pass vacuously. The file read is anchored on the vitest
 * project cwd (the `welcome-crown-anchor` idiom) because the Tailwind
 * transform rewrites what a `?raw` import would see.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const read = (name: string): string =>
  readFileSync(join(process.cwd(), "src/renderer/styles/global-css", name), "utf8");

const SHEET = read("type.css");
const TOKENS = read("tokens.css");
const BASE = read("base.css");
const FONTS = read("fonts.css");
const INDEX_HTML = readFileSync(join(process.cwd(), "src/renderer/index.html"), "utf8");

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

const REGISTER = [".vex-micro-label", ".vex-micro", ".vex-eyebrow"] as const;
/** The weights the sans and the mono ship (fonts.css): a register sets one. */
const SHIPPED_WEIGHTS = new Set([400, 600]);

describe("micro-label register", () => {
  it("sets the label in the sans family so call sites never re-declare it", () => {
    expect(ruleBody(SHEET, ".vex-micro-label")).toContain("font-family: var(--font-sans)");
  });

  it("pins the 12px label tier and the 13px meta step for --wide", () => {
    expect(ruleBody(SHEET, ".vex-micro-label")).toMatch(/font-size:\s*12px\s*;/);
    expect(ruleBody(SHEET, ".vex-micro-label--wide")).toMatch(/font-size:\s*13px\s*;/);
  });

  it("pins the regular weight", () => {
    expect(ruleBody(SHEET, ".vex-micro-label")).toMatch(/font-weight:\s*400\s*;/);
  });

  it("paints the caps at the class, so the source stays sentence case", () => {
    expect(ruleBody(SHEET, ".vex-micro-label")).toMatch(/text-transform:\s*uppercase\s*;/);
  });

  it("pins tabular figures - a label that carries numbers must not jitter", () => {
    expect(ruleBody(SHEET, ".vex-micro-label")).toContain(
      "font-variant-numeric: tabular-nums",
    );
  });

  it("tracks the caps at the one label tracking, and --wide inherits it", () => {
    expect(ruleBody(SHEET, ".vex-micro-label")).toMatch(
      /letter-spacing:\s*var\(--tracking-label\)\s*;/,
    );
    expect(ruleBody(SHEET, ".vex-micro-label--wide")).not.toContain("letter-spacing");
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
  it.each(REGISTER)("sets %s in the sans, in caps, tracked 0.08em", (selector) => {
    const body = ruleBody(SHEET, selector);
    expect(body).toContain("font-family: var(--font-sans)");
    expect(body).toMatch(/text-transform:\s*uppercase\s*;/);
    expect(body).toMatch(/letter-spacing:\s*var\(--tracking-label\)\s*;/);
    expect(body).not.toContain("var(--font-mono)");
  });

  it.each(REGISTER)("sets %s at 12 or 13px, never through a size hook", (selector) => {
    const body = ruleBody(SHEET, selector);
    expect(body).toMatch(/font-size:\s*1[23]px\s*;/);
    expect(body).not.toContain("--vex-micro-size");
    expect(body).not.toContain("--vex-micro-tracking");
  });

  it("sets the caption at 12px and the eyebrow at 13px, the kit's small and field-label steps", () => {
    expect(ruleBody(SHEET, ".vex-micro")).toMatch(/font-size:\s*12px\s*;/);
    expect(ruleBody(SHEET, ".vex-eyebrow")).toMatch(/font-size:\s*13px\s*;/);
  });

  it("gives the eyebrow the section head's 600, in ink", () => {
    // H3 draws NEEDS YOU, CHATS and RECENT ACTIVITY at 600 in ink.
    const body = ruleBody(SHEET, ".vex-eyebrow");
    expect(body).toMatch(/font-weight:\s*600\s*;/);
    expect(body).toMatch(/color:\s*var\(--color-ink-primary\)\s*;/);
  });

  it("sets every register at a weight the faces ship, never one the browser would fake", () => {
    for (const selector of [...REGISTER, ".vex-micro-label--wide", ".vex-field-label"]) {
      const weight = /font-weight:\s*(\d+)/.exec(ruleBody(SHEET, selector))?.[1];
      if (weight !== undefined) {
        expect(SHIPPED_WEIGHTS.has(Number(weight)), `${selector} at ${weight}`).toBe(true);
      }
    }
  });
});

describe("the money card's field labels", () => {
  it("are the one mono caps register: mono 13, 400, caps, tracked, tabular", () => {
    const body = ruleBody(SHEET, ".vex-field-label");
    expect(body).toContain("font-family: var(--font-mono)");
    expect(body).toMatch(/font-size:\s*13px\s*;/);
    expect(body).toMatch(/font-weight:\s*400\s*;/);
    expect(body).toMatch(/text-transform:\s*uppercase\s*;/);
    expect(body).toMatch(/letter-spacing:\s*var\(--tracking-label\)\s*;/);
    expect(body).toContain("font-variant-numeric: tabular-nums");
    // The call site owns the ink tier, as for every label.
    expect(body).not.toMatch(/(?<!-)\bcolor:/);
  });
});

describe("figures", () => {
  it("sets .vex-num in the mono stack with tabular figures and the -.01em tracking", () => {
    const body = ruleBody(SHEET, ".vex-num");
    expect(body).toContain("font-family: var(--font-mono)");
    expect(body).toContain("font-variant-numeric: tabular-nums");
    expect(body).toMatch(/letter-spacing:\s*-0\.01em\s*;/);
  });
});

describe("the tokens the register stands on", () => {
  it("leads the sans stack with Be Vietnam Pro, then its metric twin", () => {
    // docs/design/H3-DESKTOP.md section 2.3. Be Vietnam Pro carries latin-ext
    // itself, so no coverage face sits between it and its twin.
    expect(token("--font-sans")).toMatch(/^"Be Vietnam Pro", "Be Vietnam Pro Fallback",/);
    expect(token("--font-sans")).not.toMatch(/Instrument|Inter Tight/);
  });

  it("leads the mono stack with Roboto Mono and no pixel face", () => {
    expect(token("--font-mono")).toMatch(/^"Roboto Mono",/);
    expect(TOKENS).not.toContain("Departure Mono");
  });

  it("keeps code on its own JetBrains Mono stack", () => {
    expect(token("--font-code")).toMatch(/^"JetBrains Mono",/);
  });

  it("tracks every caps label at the sheet's one 0.08em, R3's steps included", () => {
    expect(token("--tracking-label")).toBe("0.08em");
    for (const step of ["eyebrow", "status", "chip", "caption", "tape"]) {
      expect(token(`--tracking-${step}`), step).toBe("var(--tracking-label)");
    }
    // The tags and the stamp take it too, each in its own rule after the
    // shared `.vex-stamp, .vex-tag` block.
    const marks = read("ui-primitives/marks.css");
    expect(marks).toMatch(/\n\.vex-stamp \{\s*letter-spacing:\s*var\(--tracking-label\);/);
    expect(marks).toMatch(/\n\.vex-tag \{\s*letter-spacing:\s*var\(--tracking-label\);/);
  });

  it("ships no Departure Mono face, fallback or file", () => {
    expect(FONTS).not.toContain("Departure Mono");
    expect(FONTS).not.toContain("departure-mono");
    expect(
      existsSync(join(process.cwd(), "src/renderer/public/fonts/departure-mono-regular.woff2")),
    ).toBe(false);
  });

  it("ships Roboto Mono at 400 for the figures, and JetBrains Mono, variable, for code", () => {
    const figures = /@font-face\s*\{[^}]*font-family:\s*"Roboto Mono";[^}]*\}/.exec(FONTS)?.[0] ?? "";
    expect(figures).toContain('url("/fonts/roboto-mono-latin-400-normal.woff2")');
    expect(figures).toMatch(/font-weight:\s*400;/);
    const code = /@font-face\s*\{[^}]*font-family:\s*"JetBrains Mono";[^}]*\}/.exec(FONTS)?.[0] ?? "";
    expect(code).toContain('url("/fonts/jetbrains-mono-latin-wght.woff2")');
    expect(code).toMatch(/font-weight:\s*100 800;/);
  });

  it("preloads the Be Vietnam Pro 400 file, the above-the-fold face, and nothing R3 set", () => {
    expect(INDEX_HTML).toMatch(
      /<link\s+rel="preload"\s+href="\/fonts\/be-vietnam-pro-latin-400-normal\.woff2"\s+as="font"\s+type="font\/woff2"\s+crossorigin\s*\/>/,
    );
    expect(INDEX_HTML).not.toContain("instrument-sans-latin-var.woff2");
    expect(INDEX_HTML).not.toContain("inter-tight-latin-wght.woff2");
  });

  it("turns weight synthesis off for the page, so a bold is never faked", () => {
    expect(ruleBody(BASE, "html")).toMatch(/font-synthesis-weight:\s*none\s*;/);
  });

  it("gives placeholders the muted ink", () => {
    expect(ruleBody(BASE, "::placeholder")).toMatch(/color:\s*var\(--color-ink-tertiary\)\s*;/);
  });

  it("sets the default body text at 14 / 1.45 on body, never on html", () => {
    const body = ruleBody(BASE, "body");
    expect(body).toMatch(/font-size:\s*14px\s*;/);
    expect(body).toMatch(/line-height:\s*1\.45\s*;/);
    expect(ruleBody(BASE, "html")).not.toContain("font-size");
  });
});
