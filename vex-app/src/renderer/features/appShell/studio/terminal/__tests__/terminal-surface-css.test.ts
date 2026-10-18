/**
 * THE TERMINAL SURFACE SHEET, tested as CSS text.
 *
 * jsdom resolves no cascade, so what `terminal.css` promises the pane is
 * pinned the way `glass-tokens.test.ts` pins its sheets: read the file, find
 * the rule, assert the declaration. Six promises can break silently:
 *
 *  1. the shared opaque wrapper background and transparent viewport, so
 *     canvas gaps and the DOM fallback use the same reading surface;
 *  2. the strip's hover, which previews activation with the quiet hover wash
 *     and is scoped to the terminal strip, since the tabs primitive's list is
 *     shared;
 *  3. the active tab: a 1.5px blue underline on the tab's own bottom edge,
 *     over the quiet rule the strip's wrapper draws beneath the scroller;
 *  4. the pane head and the shell picker keep the R3 numbers;
 *  5. the focused pane's outline sits inside it, and the seam between split
 *     panes is the quiet rule;
 *  6. every edge is a token rule, and nothing is rounded, shadowed, blurred,
 *     graded or hard-coded (docs/design/R3-MINIMAL.md sections 1 and 9.5).
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

  it("draws the active tab as a blue underline on its own bottom edge", () => {
    const rest = ruleBody(".vex-tab-shell");
    expect(rest).toMatch(/border-bottom:\s*1\.5px solid transparent/);
    expect(rest).toMatch(/padding-left:\s*12px/);
    // A tab sits on its own bottom edge: a negative margin would push the
    // underline into the scroller's clipped border area.
    expect(rest).not.toMatch(/margin-bottom/);
    const active = ruleBody(".vex-tab-shell[data-active]");
    expect(active).toMatch(/border-bottom-color:\s*var\(--vex-alias-accent-primary\)/);
    // The active tab never takes a field box or a side rule.
    expect(active).not.toMatch(/background|border-color|border-left|border-right/);
  });

  it("draws the strip's quiet rule from beneath a 40 high scroller", () => {
    const strip = ruleBody(".vex-terminal-tab-strip");
    expect(strip).toMatch(/height:\s*40px/);
    expect(strip).toMatch(/padding:\s*0 14px/);
    expect(strip).toMatch(/gap:\s*2px/);
    expect(strip).toMatch(/border-bottom:\s*0/);
    // The scroller paints above the rule so the active underline covers it.
    expect(strip).toMatch(/z-index:\s*1/);
    const rule = ruleBody(".vex-ws-strip::after");
    expect(rule).toMatch(/bottom:\s*0/);
    expect(rule).toMatch(/height:\s*1px/);
    expect(rule).toMatch(/background:\s*var\(--vex-alias-rule-quiet\)/);
  });

  it("caps the overflow with a flat paper block and a quiet rule on its inner edge", () => {
    const cap = ruleBody(".vex-ws-cap");
    expect(cap).toMatch(/width:\s*12px/);
    expect(cap).toMatch(/background:\s*var\(--vex-alias-bg-base\)/);
    // Above the scroller (z 1), short of the strip's own rule.
    expect(cap).toMatch(/z-index:\s*2/);
    expect(cap).toMatch(/bottom:\s*1px/);
    expect(ruleBody('.vex-ws-cap[data-edge="start"]')).toMatch(
      /border-right:\s*1px solid var\(--vex-alias-rule-quiet\)/,
    );
    expect(ruleBody('.vex-ws-cap[data-edge="end"]')).toMatch(
      /border-left:\s*1px solid var\(--vex-alias-rule-quiet\)/,
    );
  });

  it("sizes the pane head 50 high with a quiet rule under it", () => {
    const head = ruleBody(".vex-ws-head");
    expect(head).toMatch(/height:\s*50px/);
    expect(head).toMatch(/padding:\s*0 14px 0 18px/);
    expect(head).toMatch(/gap:\s*12px/);
    expect(head).toMatch(/border-bottom:\s*1px solid var\(--vex-alias-rule-quiet\)/);
    // The head is on the paper: only the panes are the field.
    expect(head).not.toMatch(/background/);
    expect(ruleBody(".vex-ws-head__keys")).toMatch(/gap:\s*2px/);
  });

  it("draws the shell picker key 32 high, about 170 wide, framed on the field", () => {
    const picker = ruleBody(".vex-ws-picker");
    expect(picker).toMatch(/height:\s*32px/);
    expect(picker).toMatch(/width:\s*170px/);
    expect(picker).toMatch(/padding:\s*0 12px/);
    expect(picker).toMatch(/gap:\s*9px/);
    expect(picker).toMatch(/border:\s*1px solid var\(--vex-alias-rule\)/);
    expect(picker).toMatch(/background:\s*var\(--vex-alias-field\)/);
    expect(picker).toMatch(/font-size:\s*13px/);
  });

  it("outlines the focused pane 1.5px in the blue, inside its own box", () => {
    const body = ruleBody(".vex-ws-pane[data-active]");
    expect(body).toMatch(/outline:\s*1\.5px solid var\(--vex-alias-accent-primary\)/);
    expect(body).toMatch(/outline-offset:\s*-1\.5px/);
  });

  it("draws the seam between split panes as the quiet rule, keeping the hover and drag blue", () => {
    const seam = ruleBody('.vex-ws-panes [role="separator"]:not(:hover):not([data-dragging])');
    expect(seam).toMatch(/background:\s*var\(--vex-alias-rule-quiet\)/);
  });

  it("declares no radius, shadow, blur or gradient, and only token colours", () => {
    expect(rules).not.toMatch(/border-radius|box-shadow|backdrop-filter|gradient\(|blur\(/);
    expect(rules).not.toMatch(/glass/);
    for (const match of rules.matchAll(/border[a-z-]*:\s*([^;]+);/g)) {
      const value = match[1] ?? "";
      expect(value, `border "${value}" is not a token rule`).toMatch(
        /^(0|1(\.5)?px solid transparent|1px solid var\(--vex-alias-rule(-quiet)?\)|var\(--vex-alias-accent-primary\))$/,
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
    // A flat panel over the pane: a 1px ink border, never a shadow
    // (docs/design/R3-MINIMAL.md section 12).
    expect(hintSheet).toMatch(/border:\s*1px solid var\(--vex-alias-rule-ink\)/);
    expect(hintSheet).toContain("var(--vex-alias-label-primary)");
    expect(hintSheet).toMatch(/overflow-wrap:\s*anywhere/);
    expect(hintSheet).not.toMatch(/animation:|transition:|#[0-9a-f]{3,8}\b/i);
  });
});
