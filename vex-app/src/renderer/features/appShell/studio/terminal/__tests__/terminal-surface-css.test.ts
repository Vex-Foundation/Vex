/**
 * THE TERMINAL SURFACE SHEET, tested as CSS text.
 *
 * jsdom resolves no cascade, so what `terminal.css` promises the glass pane is
 * pinned the way `glass-tokens.test.ts` pins its sheets: read the file, find
 * the rule, assert the declaration. Three promises can break silently:
 *
 *  1. the viewport rule that keeps xterm's own background transparent - lose
 *     it and the DOM renderer paints an opaque viewport over the glass;
 *  2. the strip's hover, which is the one tab state glass.css does not own:
 *     it must read the PANE tint (an activation preview) and must be scoped
 *     to the terminal strip, since the tabs primitive's list is shared;
 *  3. no `border` anywhere in the sheet - the edge light is the edge.
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

describe("terminal.css on glass", () => {
  it("keeps xterm's viewport transparent so the pane shows through", () => {
    expect(ruleBody(".vex-terminal-surface .xterm-viewport")).toMatch(
      /background-color:\s*transparent\s*!important/,
    );
  });

  it("paints the hovered inactive tab with the pane tint, scoped to the terminal strip", () => {
    const body = ruleBody(".vex-terminal-tab-strip .vex-tab-shell:not([data-active]):hover");
    expect(body).toMatch(/background:\s*var\(--vex-glass-tint-pane\)/);
    // Never the active tab: its edge light is what tells it from a hover.
    expect(rules).not.toMatch(/\.vex-tab-shell\[data-active\][^{]*:hover/);
  });

  it("declares no border: the edge light is the only edge", () => {
    expect(rules).not.toMatch(/\bborder\b/);
  });
});
