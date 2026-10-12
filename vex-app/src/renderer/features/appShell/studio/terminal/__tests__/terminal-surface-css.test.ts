/**
 * THE TERMINAL SURFACE SHEET, tested as CSS text.
 *
 * jsdom resolves no cascade, so what `terminal.css` promises the pane is
 * pinned the way `glass-tokens.test.ts` pins its sheets: read the file, find
 * the rule, assert the declaration. Four promises can break silently:
 *
 *  1. the shared opaque wrapper background and transparent viewport, so
 *     canvas gaps and the DOM fallback use the same reading surface;
 *  2. the strip's hover, which previews activation with the quiet hover wash
 *     and is scoped to the terminal strip, since the tabs primitive's list is
 *     shared;
 *  3. the active tab: the field, a rule, sitting 1px low over the strip's rule;
 *  4. every edge is a 1px rule from a token, and nothing is rounded, shadowed,
 *     blurred or hard-coded (docs/design/V10-SPREAD.md section 1).
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const sheet = readFileSync(
  path.join(here, "..", "..", "..", "..", "..", "styles", "global-css", "terminal.css"),
  "utf8",
);

/** Strip block comments so a name in prose is not read as a rule. */
const rules = sheet.replace(/\/\*[\s\S]*?\*\//g, "");

/** The body of the first rule whose selector text is exactly `selector`. */
function ruleBody(selector: string): string {
  const at = rules.indexOf(`${selector} {`);
  expect(at, `selector "${selector}" not found`).toBeGreaterThanOrEqual(0);
  const open = rules.indexOf("{", at);
  const close = rules.indexOf("}", open);
  return rules.slice(open + 1, close);
}

describe("terminal.css surfaces", () => {
  it("uses the palette background across the whole wrapper in both themes", () => {
    expect(ruleBody(".vex-terminal-surface")).toMatch(
      /background-color:\s*var\(--vex-alias-term-background\)/,
    );
    // One semantic alias repoints between the two opaque reading surfaces.
    expect(rules).not.toMatch(/#[0-9a-f]{3,8}\b/i);
  });

  it("keeps the viewport transparent to the opaque wrapper in both themes", () => {
    expect(ruleBody(".vex-terminal-surface .xterm-viewport")).toMatch(
      /background-color:\s*transparent\s*!important/,
    );
  });

  it("paints the hovered inactive tab with the hover wash, scoped to the terminal strip", () => {
    const body = ruleBody(".vex-terminal-tab-strip .vex-tab-shell:not([data-active]):hover");
    expect(body).toMatch(/background:\s*var\(--vex-alias-interactive-hover\)/);
    // Never the active tab: its field box is what tells it from a hover.
    expect(rules).not.toMatch(/\.vex-tab-shell\[data-active\][^{]*:hover/);
  });

  it("draws the active tab as the field with a rule, one pixel low over the strip's rule", () => {
    const rest = ruleBody(".vex-tab-shell");
    expect(rest).toMatch(/margin-bottom:\s*-1px/);
    expect(rest).toMatch(/border-bottom:\s*0/);
    const active = ruleBody(".vex-tab-shell[data-active]");
    expect(active).toMatch(/background:\s*var\(--vex-alias-field\)/);
    expect(active).toMatch(/border-color:\s*var\(--vex-alias-rule\)/);
    expect(ruleBody(".vex-terminal-tab-strip")).toMatch(
      /border-bottom:\s*1px solid var\(--vex-alias-rule\)/,
    );
  });

  it("declares no radius, shadow, blur or gradient, and only token colours", () => {
    expect(rules).not.toMatch(/border-radius|box-shadow|backdrop-filter|gradient\(|blur\(/);
    expect(rules).not.toMatch(/glass/);
    for (const match of rules.matchAll(/border[a-z-]*:\s*([^;]+);/g)) {
      const value = match[1] ?? "";
      expect(value, `border "${value}" is not a token rule`).toMatch(
        /^(0|1px solid (var\(--vex-alias-rule\)|transparent)|var\(--vex-alias-rule\))$/,
      );
    }
  });
});


describe("terminal link hint chrome", () => {
  it("loads semantic, non-interactive hint styling without motion", () => {
    expect(sheet).toContain('@import "./terminal-link-hint.css"');
    const hintSheet = readFileSync(path.join(here, "..", "..", "..", "..", "..", "styles", "global-css", "terminal-link-hint.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(hintSheet).toContain(".vex-terminal-link-hint");
    expect(hintSheet).toMatch(/pointer-events:\s*none/);
    expect(hintSheet).toContain("var(--vex-alias-field)");
    expect(hintSheet).toContain("var(--vex-alias-rule)");
    expect(hintSheet).toContain("var(--vex-alias-label-primary)");
    expect(hintSheet).toMatch(/overflow-wrap:\s*anywhere/);
    expect(hintSheet).not.toMatch(/animation:|transition:|#[0-9a-f]{3,8}\b/i);
  });
});
