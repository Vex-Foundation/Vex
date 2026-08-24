/**
 * Micro-label register contract (R3-F3, 2026-08-21).
 *
 * `.vex-micro-label` in `styles/global-css/landing-motifs.css` is the single
 * owner of the app-wide small-caps stamp. It succeeds `.vex-doto-label`: Doto
 * was a dot-matrix face that laid down roughly half a solid face's ink, so the
 * tiers calibrated for Inter Tight overstated its perceived contrast and the
 * owner's QA read the whole register as invisible in both themes. The ratified
 * fix (decision 2) was not a bigger dot grid but a solid face - Inter Tight
 * small-caps - and Doto left the bundle entirely.
 *
 * This suite pins the register's declarations against the stylesheet TEXT so a
 * future drift is a red build rather than a review comment. The companion
 * enforcement lives in `shell-design-guard.test.ts`: that suite bans the dead
 * class name and the sub-floor ink tiers at the CALL SITES; this one guards the
 * class the call sites depend on.
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

describe("micro-label register", () => {
  it("owns the sans family so call sites never re-declare it", () => {
    // The whole point of the ratified change: one solid face for the register.
    // `var(--font-sans)` is Inter Tight; the retired `--font-doto` no longer
    // exists as a token at all.
    expect(ruleBody(".vex-micro-label")).toContain(
      "font-family: var(--font-sans)",
    );
  });

  it("pins the 11px label tier", () => {
    // 0.6875rem === 11px at the app's 16px root. Either spelling is the tier:
    // one step above the 10px `.vex-micro` caption, which is what makes this a
    // LABEL register rather than a second caption.
    expect(ruleBody(".vex-micro-label")).toMatch(
      /font-size:\s*(?:0\.6875rem|11px)\s*;/,
    );
  });

  it("pins the weight-600 floor - the 'up a weight' half of the ladder", () => {
    // Deepseek's discipline (design-platform.css label tiers,
    // ModelsSection.module.css field labels): must-read small text goes up a
    // tier AND up a weight. Weight is what buys legibility at 11px; anything
    // lighter re-creates the defect this register was built to remove.
    expect(ruleBody(".vex-micro-label")).toMatch(/font-weight:\s*600\s*;/);
  });

  it("pins tabular figures - every micro label carries numbers", () => {
    expect(ruleBody(".vex-micro-label")).toContain(
      "font-variant-numeric: tabular-nums",
    );
  });

  it("caps tracking at 0.08em - a solid face needs far less air than dots", () => {
    // The Doto era ran 0.14/0.16em because sparse dot glyphs needed optical
    // separation. A solid proportional face does not, and wide tracking on one
    // costs word cohesion. Both the base rule and the one sanctioned `--wide`
    // step must respect the cap.
    for (const selector of [".vex-micro-label", ".vex-micro-label--wide"]) {
      const match = /letter-spacing:\s*([0-9.]+)em\s*;/.exec(ruleBody(selector));
      expect(match, `${selector} declares no letter-spacing`).not.toBeNull();
      expect(Number(match?.[1])).toBeLessThanOrEqual(0.08);
    }
  });

  it("sets NO color, so the call site's ink tier keeps winning", () => {
    // This sheet is imported unlayered on purpose (globals.css), so it beats
    // Tailwind's @layer utilities. A `color` here would override every call
    // site's `text-*` utility and the genuine tone deviations (warning,
    // success, accent, active-state ink) could not be expressed at all. The
    // floor TIER is enforced in shell-design-guard.test.ts instead.
    expect(ruleBody(".vex-micro-label")).not.toMatch(/(?<!-)\bcolor:/);
  });

  it("sets NO background - the rail-glass backing chip is retired", () => {
    // Owner decision 2 (ratified 2026-08-21): the `.vex-doto-chip` plate under
    // the welcome date line, the $VEX card label and the BOOK version stamp
    // read as chrome. A solid 600-weight face stands on its own over the photo
    // backdrop, so the backing is gone and must not come back on the class.
    expect(ruleBody(".vex-micro-label")).not.toMatch(
      /background|border(?!-)|padding/,
    );
    // Prose may still NAME the retired class (the comment above the register
    // explains why it went); what must not exist is a rule that declares it.
    expect(SHEET).not.toMatch(/\.vex-doto-chip\s*\{/);
  });

  it("declares no rule for the retired Doto register or its token", () => {
    expect(SHEET).not.toMatch(/\.vex-doto-label(?:--wide)?\s*\{/);
    expect(SHEET).not.toContain("var(--font-doto)");
  });
});
