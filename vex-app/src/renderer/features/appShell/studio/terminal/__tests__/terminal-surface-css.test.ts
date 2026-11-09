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
 *  3. the tabs row in H3 cells (our approved Studio plate, docs/design/
 *     H3-DESKTOP.md section 4.9): 56 high, a cell per tab behind its rule,
 *     the active one on the raised fill, never a blue underline;
 *  4. the panel header, the + key cell and the shell picker keep the plate's
 *     numbers;
 *  5. the active pane of a split is its head on the raised fill, never an
 *     outline, and the seam between split panes is the quiet rule;
 *  6. every edge is a token rule, and nothing is rounded, shadowed, blurred,
 *     graded or hard-coded.
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

  it("draws a tab as a cell behind its rule, the active one on the open ground", () => {
    const rest = ruleBody(".vex-tab-shell");
    expect(rest).toMatch(/padding:\s*0 20px 0 24px/);
    expect(rest).toMatch(/border-right:\s*1px solid var\(--vex-alias-rule-quiet\)/);
    expect(rest).not.toMatch(/border-bottom/);
    const active = ruleBody(".vex-tab-shell[data-active]");
    expect(active).toMatch(/background:\s*var\(--vex-alias-interactive-active\)/);
    // No underline, and no blue anywhere in the chrome.
    expect(active).not.toMatch(/border/);
    expect(rules).not.toMatch(/accent-primary|button-accent|button-primary/);
  });

  it("draws the tabs row 56 high with its rule, the scroller inside it", () => {
    const row = ruleBody(".vex-ws-strip");
    expect(row).toMatch(/height:\s*56px/);
    expect(row).toMatch(/border-bottom:\s*1px solid var\(--vex-alias-rule-quiet\)/);
    const strip = ruleBody(".vex-terminal-tab-strip");
    expect(strip).toMatch(/height:\s*100%/);
    expect(strip).toMatch(/padding:\s*0/);
    expect(strip).toMatch(/gap:\s*0/);
    expect(strip).toMatch(/border-bottom:\s*0/);
    expect(strip).toMatch(/z-index:\s*1/);
    // The terminal's name in caps, a file's in mono.
    expect(ruleBody(".vex-tab-trigger--terminal .vex-tab-title")).toMatch(/text-transform:\s*uppercase/);
    expect(ruleBody(".vex-tab-trigger--file .vex-tab-title")).toMatch(/font-family:\s*var\(--font-mono\)/);
  });

  it("caps the overflow with a flat ground block and a quiet rule on its inner edge", () => {
    const cap = ruleBody(".vex-ws-cap");
    expect(cap).toMatch(/width:\s*12px/);
    expect(cap).toMatch(/background:\s*var\(--vex-alias-bg-base\)/);
    // Above the scroller (z 1).
    expect(cap).toMatch(/z-index:\s*2/);
    expect(ruleBody('.vex-ws-cap[data-edge="start"]')).toMatch(
      /border-right:\s*1px solid var\(--vex-alias-rule-quiet\)/,
    );
    expect(ruleBody('.vex-ws-cap[data-edge="end"]')).toMatch(
      /border-left:\s*1px solid var\(--vex-alias-rule-quiet\)/,
    );
  });

  it("sizes the panel header 56 high with its rule, its keys 56 square cells", () => {
    const head = ruleBody(".vex-ws-head");
    expect(head).toMatch(/height:\s*56px/);
    expect(head).toMatch(/border-bottom:\s*1px solid var\(--vex-alias-rule-quiet\)/);
    // The head is on the ground: it paints no field of its own.
    expect(head).not.toMatch(/background/);
    expect(ruleBody(".vex-ws-head__id")).toMatch(/padding:\s*0 16px 0 24px/);
    expect(ruleBody(".vex-ws-head__where")).toMatch(/font-family:\s*var\(--font-mono\)/);
    const key = ruleBody(".vex-ws-head__key");
    expect(key).toMatch(/width:\s*56px/);
    expect(key).toMatch(/border-left:\s*1px solid var\(--vex-alias-rule-quiet\)/);
    expect(ruleBody(".vex-ws-head__state")).toMatch(/text-transform:\s*uppercase/);
  });

  it("draws the + key cell 56 wide and the shell picker as the row's last cell", () => {
    const plus = ruleBody(".vex-ws-plus");
    expect(plus).toMatch(/width:\s*56px/);
    expect(plus).toMatch(/border-right:\s*1px solid var\(--vex-alias-rule-quiet\)/);
    const picker = ruleBody(".vex-ws-picker");
    expect(picker).toMatch(/height:\s*100%/);
    expect(picker).toMatch(/padding:\s*0 24px/);
    expect(picker).toMatch(/border-left:\s*1px solid var\(--vex-alias-rule-quiet\)/);
    expect(picker).toMatch(/font-size:\s*13px/);
    expect(ruleBody(".vex-ws-picker__word")).toMatch(/text-transform:\s*uppercase/);
    expect(ruleBody(".vex-ws-picker__value")).toMatch(/font-family:\s*var\(--font-mono\)/);
  });

  it("marks the active pane of a split by its 36 head on the open ground, never an outline", () => {
    const head = ruleBody(".vex-ws-pane__head");
    expect(head).toMatch(/height:\s*36px/);
    expect(head).toMatch(/border-bottom:\s*1px solid var\(--vex-alias-rule-quiet\)/);
    expect(ruleBody(".vex-ws-pane[data-active] > .vex-ws-pane__head")).toMatch(
      /background:\s*var\(--vex-alias-interactive-active\)/,
    );
    expect(ruleBody(".vex-ws-pane")).toMatch(/background:\s*var\(--vex-alias-bg-base\)/);
    expect(rules).not.toMatch(/outline:\s*1\.5px/);
  });

  it("draws the seam between split panes as the quiet rule, the chosen rule while it moves", () => {
    const seam = ruleBody('.vex-ws-panes [role="separator"]:not(:hover):not([data-dragging])');
    expect(seam).toMatch(/background:\s*var\(--vex-alias-rule-quiet\)/);
    expect(ruleBody('.vex-ws-panes [role="separator"]:is(:hover, [data-dragging])')).toMatch(
      /background:\s*var\(--vex-alias-rule-chosen\)/,
    );
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
