/**
 * THE TERMINAL'S SLIDER, pinned as CSS text.
 *
 * xterm 6 scrolls through VS Code's ScrollableElement: the bar is a real
 * `.slider` element that xterm sizes INLINE and would colour from a style
 * element it injects, which the renderer's CSP refuses. jsdom resolves no
 * cascade and xterm mounts no scrollbar there, so the three ways this can
 * break silently are pinned on the sheets themselves (the shape of
 * glass-tokens.test.ts):
 *
 *  1. an `!important` dropped from a width, so the inline 10px wins again
 *     and the bar is the square one the owner circled;
 *  2. the vestigial viewport's `overflow` override moving ABOVE xterm.css's
 *     import, where it loses at equal specificity and the native gutter
 *     returns;
 *  3. a colour spelled as a literal, or read from anything but the runtime
 *     pair every `.vex-scroll` thumb reads, so a theme flip or a quiet
 *     column rebind would miss the terminal.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (name: string): string => readFileSync(path.join(here, "..", name), "utf8");

const scrollbarsCss = read("scrollbars.css");
const terminalCss = read("terminal.css");

/** Strip block comments so a name in prose is not read as a rule. */
const stripComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, "");

/** The body of the first rule whose selector text is exactly `selector`. */
function ruleBody(css: string, selector: string): string {
  const source = stripComments(css);
  const at = source.indexOf(`${selector} {`);
  expect(at, `selector "${selector}" not found`).toBeGreaterThanOrEqual(0);
  const open = source.indexOf("{", at);
  const close = source.indexOf("\n}", open);
  return source.slice(open + 1, close);
}

function declarationValue(body: string, property: string): string | undefined {
  return new RegExp(`(?:^|[\\s;])${property}:\\s*([^;]+);`).exec(body)?.[1]?.trim();
}

const TRACK = ".vex-terminal-surface .xterm-scrollable-element > .scrollbar.vertical";
const SLIDER = `${TRACK} > .slider`;

describe("the terminal slider (scrollbars.css)", () => {
  it("out-ranks xterm's inline 10px with the .vex-scroll width on track and slider", () => {
    expect(declarationValue(ruleBody(scrollbarsCss, TRACK), "width")).toBe("6px !important");
    expect(declarationValue(ruleBody(scrollbarsCss, SLIDER), "width")).toBe("6px !important");
    // Same grammar as `.vex-scroll::-webkit-scrollbar`, so the two bars agree.
    expect(declarationValue(ruleBody(scrollbarsCss, ".vex-scroll::-webkit-scrollbar"), "width")).toBe(
      "6px",
    );
  });

  it("insets the thumb 2px by padding and clips the fill to the content box", () => {
    const slider = ruleBody(scrollbarsCss, SLIDER);
    expect(declarationValue(slider, "padding")).toBe("2px");
    expect(declarationValue(slider, "box-sizing")).toBe("border-box");
    expect(declarationValue(slider, "background-clip")).toBe("content-box");
    expect(declarationValue(slider, "border-radius")).toBe("9999px");
  });

  it("keeps the track transparent and reads the thumb's colour from the runtime pair only", () => {
    expect(declarationValue(ruleBody(scrollbarsCss, TRACK), "background")).toBe("transparent");
    expect(declarationValue(ruleBody(scrollbarsCss, SLIDER), "background-color")).toBe(
      "var(--vex-scrollbar-thumb)",
    );
    const hover = ruleBody(scrollbarsCss, `${SLIDER}:hover,\n${SLIDER}.active`);
    expect(declarationValue(hover, "background-color")).toBe("var(--vex-scrollbar-thumb-hover)");
    const section = stripComments(scrollbarsCss).slice(
      stripComments(scrollbarsCss).indexOf(TRACK),
    );
    expect(section).not.toMatch(/rgba?\(|#[0-9a-f]{3,8}\b/i);
  });

  it("removes the vestigial viewport's native gutter BELOW xterm.css's import", () => {
    const source = stripComments(terminalCss);
    const importAt = source.indexOf('@import "@xterm/xterm/css/xterm.css";');
    const ruleAt = source.indexOf(".vex-terminal-surface .xterm-viewport {");
    expect(importAt).toBeGreaterThanOrEqual(0);
    expect(ruleAt).toBeGreaterThan(importAt);
    expect(
      declarationValue(ruleBody(terminalCss, ".vex-terminal-surface .xterm-viewport"), "overflow"),
    ).toBe("hidden");
  });
});
