/**
 * Doto register contract (R2-C, 2026-08-21).
 *
 * `.vex-doto-label` in `styles/global-css/landing-motifs.css` is the single
 * owner of the app-wide Doto floor. It exists because Doto is a dot-matrix
 * face: at a given size and weight it lays down roughly half the ink a solid
 * face does, so the tiers calibrated for Inter Tight OVERSTATE its perceived
 * contrast. The pre-shell measured that first and pinned 12px/600
 * (`chronos-gate.css`, "Doto's dot glyphs thin out below it at 12px"); the
 * shell never adopted it and drifted to ~70 ad-hoc call sites at 8-11px weight
 * 400, which the owner's QA read as invisible in BOTH themes.
 *
 * This suite pins the floor declarations against the stylesheet TEXT so a
 * future "just make it 9px again" edit is a red build rather than a review
 * comment. The companion enforcement lives in `shell-design-guard.test.ts`:
 * that suite bans the raw `font-doto` utility and the sub-floor ink tiers at
 * the CALL SITES; this one guards the class the call sites now depend on.
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

const SHEET = readFileSync(
  join(process.cwd(), "src/renderer/styles/global-css/landing-motifs.css"),
  "utf8",
);

/** Extract one rule's declaration block by exact selector. */
function ruleBody(selector: string): string {
  const start = SHEET.indexOf(`\n${selector} {`);
  expect(start, `selector not found: ${selector}`).toBeGreaterThan(-1);
  const open = SHEET.indexOf("{", start);
  const close = SHEET.indexOf("}", open);
  expect(close, `unterminated rule: ${selector}`).toBeGreaterThan(open);
  return SHEET.slice(open + 1, close);
}

describe("Doto micro-label register", () => {
  it("owns the Doto family so call sites never re-declare it", () => {
    expect(ruleBody(".vex-doto-label")).toContain(
      "font-family: var(--font-doto)",
    );
  });

  it("pins the 12px size floor", () => {
    // 0.75rem === 12px at the app's 16px root. Either spelling is the floor;
    // anything smaller is the defect this class was created to remove.
    expect(ruleBody(".vex-doto-label")).toMatch(
      /font-size:\s*(?:0\.75rem|12px)\s*;/,
    );
  });

  it("pins the weight-600 floor (the pre-shell's measured threshold)", () => {
    expect(ruleBody(".vex-doto-label")).toMatch(/font-weight:\s*600\s*;/);
  });

  it("pins tabular figures - every Doto label carries numbers", () => {
    expect(ruleBody(".vex-doto-label")).toContain(
      "font-variant-numeric: tabular-nums",
    );
  });

  it("caps tracking at 0.16em - letter-spacing is not a legibility tool", () => {
    // Wider tracking isolates already-sparse dot glyphs and makes them worse;
    // the fix for thin micro-text is up a size tier and up a weight. Both the
    // base rule and the one sanctioned `--wide` step must respect the cap.
    for (const selector of [".vex-doto-label", ".vex-doto-label--wide"]) {
      const match = /letter-spacing:\s*([0-9.]+)em\s*;/.exec(ruleBody(selector));
      expect(match, `${selector} declares no letter-spacing`).not.toBeNull();
      expect(Number(match?.[1])).toBeLessThanOrEqual(0.16);
    }
  });

  it("sets NO color, so the call site's ink tier keeps winning", () => {
    // This sheet is imported unlayered on purpose (globals.css), so it beats
    // Tailwind's @layer utilities. A `color` here would override every call
    // site's `text-*` utility and the genuine tone deviations (warning,
    // success, accent, active-state ink) could not be expressed at all. The
    // floor TIER is enforced in shell-design-guard.test.ts instead.
    expect(ruleBody(".vex-doto-label")).not.toMatch(/(?<!-)\bcolor:/);
  });

  it("backs the rail-glass chip with THEME TOKENS, never a fixed color", () => {
    // Owner decision 5 (ratified 2026-08-21): the three labels that sit on the
    // translucent rails over an ARBITRARY photo backdrop get an opaque backing,
    // and both the chip and its ink resolve from the active theme. A literal
    // hex or rgb() here would be theme-blind in exactly the way the decision
    // rejected.
    const chip = ruleBody(".vex-doto-chip");
    expect(chip).toMatch(/background:\s*var\(--vex-surface-1/);
    expect(chip).toMatch(/border:\s*1px solid var\(--vex-line/);
    expect(chip).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(/i);
  });
});
