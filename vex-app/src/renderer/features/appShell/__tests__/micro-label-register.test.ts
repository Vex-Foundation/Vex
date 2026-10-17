/**
 * Micro-label register contract (R3, docs/design/R3-MINIMAL.md section 1).
 *
 * `.vex-micro-label` in `styles/global-css/landing-motifs.css` is the single
 * owner of the app-wide label stamp, with `.vex-micro` (the caption) and
 * `.vex-eyebrow` (the section and field label) beside it. R3 sets all three
 * in Instrument Sans, in sentence case, at 12 or 13px with no caps tracking:
 * caps belong to tags alone. Figures are JetBrains Mono with `.vex-num`.
 *
 * This suite pins the register's declarations against the stylesheet TEXT so a
 * future drift is a red build rather than a review comment, and pins the
 * tokens it stands on (the sans and mono stacks, the caps tracking kept for
 * tags) and the one base rule that keeps a bold from being faked on the
 * serif. The companion enforcement lives in `shell-design-guard.test.ts`:
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

const SHEET = read("landing-motifs.css");
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

  it("sets sentence case at the class, so a call site's caps utility converts here", () => {
    expect(ruleBody(SHEET, ".vex-micro-label")).toMatch(/text-transform:\s*none\s*;/);
  });

  it("pins tabular figures - a label that carries numbers must not jitter", () => {
    expect(ruleBody(SHEET, ".vex-micro-label")).toContain(
      "font-variant-numeric: tabular-nums",
    );
  });

  it("drops the caps tracking: a label is tracked normally", () => {
    expect(ruleBody(SHEET, ".vex-micro-label")).toMatch(/letter-spacing:\s*normal\s*;/);
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
  it.each(REGISTER)("sets %s in Instrument Sans, sentence case, untracked", (selector) => {
    const body = ruleBody(SHEET, selector);
    expect(body).toContain("font-family: var(--font-sans)");
    expect(body).toMatch(/text-transform:\s*none\s*;/);
    expect(body).toMatch(/letter-spacing:\s*normal\s*;/);
    expect(body).not.toContain("var(--font-mono)");
    expect(body).not.toContain("uppercase");
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

  it("gives the eyebrow the field label's 500 on the second ink", () => {
    const body = ruleBody(SHEET, ".vex-eyebrow");
    expect(body).toMatch(/font-weight:\s*500\s*;/);
    expect(body).toMatch(/color:\s*var\(--color-ink-secondary\)\s*;/);
  });

  it("never sets a register below 400 or above 500", () => {
    for (const selector of [...REGISTER, ".vex-micro-label--wide"]) {
      const weight = /font-weight:\s*(\d+)/.exec(ruleBody(SHEET, selector))?.[1];
      if (weight !== undefined) {
        expect(Number(weight), selector).toBeGreaterThanOrEqual(400);
        expect(Number(weight), selector).toBeLessThanOrEqual(500);
      }
    }
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
  it("leads the sans stack with Instrument Sans, then its coverage and its metric twin", () => {
    expect(token("--font-sans")).toMatch(
      /^"Instrument Sans", "Inter Tight", "Instrument Sans Fallback",/,
    );
  });

  it("leads the mono stack with JetBrains Mono and no pixel face", () => {
    expect(token("--font-mono")).toMatch(/^"JetBrains Mono",/);
    expect(TOKENS).not.toContain("Departure Mono");
  });

  it("keeps code on its own JetBrains Mono stack", () => {
    expect(token("--font-code")).toMatch(/^"JetBrains Mono",/);
  });

  it("keeps the caps tracking scale for the tags and the call sites still converting", () => {
    expect(token("--tracking-eyebrow")).toBe("0.18em");
    expect(token("--tracking-status")).toBe("0.14em");
    expect(token("--tracking-chip")).toBe("0.12em");
  });

  it("ships no Departure Mono face, fallback or file", () => {
    expect(FONTS).not.toContain("Departure Mono");
    expect(FONTS).not.toContain("departure-mono");
    expect(
      existsSync(join(process.cwd(), "src/renderer/public/fonts/departure-mono-regular.woff2")),
    ).toBe(false);
  });

  it("ships JetBrains Mono as a variable face for the figures", () => {
    const face = /@font-face\s*\{[^}]*font-family:\s*"JetBrains Mono";[^}]*\}/.exec(FONTS)?.[0] ?? "";
    expect(face).toContain('url("/fonts/jetbrains-mono-latin-wght.woff2")');
    expect(face).toMatch(/font-weight:\s*100 800;/);
  });

  it("preloads the Instrument Sans file, the above-the-fold face", () => {
    expect(INDEX_HTML).toMatch(
      /<link\s+rel="preload"\s+href="\/fonts\/instrument-sans-latin-var\.woff2"\s+as="font"\s+type="font\/woff2"\s+crossorigin\s*\/>/,
    );
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
