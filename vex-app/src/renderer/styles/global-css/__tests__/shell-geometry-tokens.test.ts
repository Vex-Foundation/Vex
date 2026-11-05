/**
 * THE H3 SHELL GEOMETRY as tokens (docs/design/H3-DESKTOP.md sections 1.1,
 * 1.2, 1.5 and 1.10), tested as CSS text.
 *
 * The shell grid moves onto these in its own slice; until then they are the
 * contract the grid, the header, the bottom row and Kimm's section will
 * read, so this suite holds each number to the measured or printed frame:
 *
 *   1. the chats column 248, the header row 76, the bottom row 72, Kimm's
 *      closed strip 56, the band's 76 rail and its edge at 1024;
 *   2. the Vex column is VEX Cloud's (PD-14): clamp(360px, 30vw, 768px)
 *      from 1280, unrounded, and a fixed 340 from 1024 to 1279, and with the
 *      chats column it reproduces the contract's tier table, the printed
 *      plates at 1440 and 2560 included, so the chat keeps the rest;
 *   3. the 1440 frame closes: header plus columns plus bottom row is 900, and
 *      Kimm's section ends one pixel above the bottom row.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const tokensCss = readFileSync(path.join(here, "..", "tokens.css"), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);

/** The sheet's rules inside `@media (max-width: 1279px)`, where the 340 lives. */
const under1280 = /@media \(max-width: 1279px\) \{([\s\S]*?\n)\}/.exec(tokensCss)?.[1] ?? "";

function token(name: string): string {
  const match = new RegExp(`${name}:\\s*([^;]+);`).exec(tokensCss);
  expect(match, `${name} is not declared`).not.toBeNull();
  return (match?.[1] ?? "").trim();
}

const px = (name: string): number => {
  const value = token(name);
  expect(value, name).toMatch(/^\d+px$/);
  return Number.parseInt(value, 10);
};

/**
 * The Vex column's rule, as the tokens state it: the clamp of the share from
 * 1280 up, the declared 340 under it.
 */
function vexWidth(window: number): number {
  if (window < 1280) {
    const narrow = /--vex-h3-vex-w:\s*(\d+)px;/.exec(under1280);
    expect(narrow, "the 340 under 1280 is not declared").not.toBeNull();
    return Number.parseInt(narrow?.[1] ?? "0", 10);
  }
  const clamp = /^clamp\((\d+)px, var\(--vex-h3-vex-share\), (\d+)px\)$/.exec(token("--vex-h3-vex-w"));
  expect(clamp, "--vex-h3-vex-w is not the clamp").not.toBeNull();
  const share = (Number.parseFloat(token("--vex-h3-vex-share")) * window) / 100;
  return Math.min(Number(clamp?.[2]), Math.max(Number(clamp?.[1]), share));
}

describe("the H3 shell geometry", () => {
  it("declares the fixed tracks and rows the contract measured", () => {
    expect(px("--vex-h3-chats-w")).toBe(248);
    expect(px("--vex-h3-header-h")).toBe(76);
    expect(px("--vex-h3-bottom-h")).toBe(72);
    expect(px("--vex-h3-strip-h")).toBe(56);
    expect(px("--vex-h3-rail-w")).toBe(76);
    expect(px("--vex-h3-band-under")).toBe(1024);
  });

  it("sets the Vex column as Cloud does: clamp(360px, 30vw, 768px), and 340 under 1280", () => {
    expect(token("--vex-h3-vex-share")).toBe("30vw");
    expect(token("--vex-h3-vex-w")).toBe("clamp(360px, var(--vex-h3-vex-share), 768px)");
    expect(under1280).toMatch(/:root \{\s*--vex-h3-vex-w: 340px;\s*\}/);
  });

  it.each([
    // [window, Vex column, chat column] with the chats open, from the
    // contract's tier table; 1440 and 2560 are printed on the plates, 1280,
    // 1366 and 1920 are Cloud's measured boxes, the rest the rule. Under 1280
    // the chats are the rail, so these chat widths are the rule's alone.
    [1024, 340, 436],
    [1180, 340, 592],
    [1224, 340, 636],
    [1280, 384, 648],
    [1366, 409.8, 708.2],
    [1440, 432, 760],
    [1536, 460.8, 827.2],
    [1920, 576, 1096],
    [2560, 768, 1544],
  ])("reproduces the %ipx tier: Vex %i, chat %i", (window, vex, chat) => {
    expect(vexWidth(window)).toBeCloseTo(vex, 9);
    expect(window - px("--vex-h3-chats-w") - vexWidth(window)).toBeCloseTo(chat, 9);
  });

  it("closes the 1440 x 900 frame and keeps Kimm's section clear of the bottom row", () => {
    // Section 1.1: header 76, columns 752, bottom 72; her section 264 + 563
    // ends at 827, one pixel above the bottom row's top rule at 827 to 828.
    const columns = 900 - px("--vex-h3-header-h") - px("--vex-h3-bottom-h");
    expect(columns).toBe(752);
    expect(264 + 563).toBe(900 - px("--vex-h3-bottom-h") - 1);
    // Closed, her section is its top strip: the printed inset is 563 - 56.
    expect(563 - px("--vex-h3-strip-h")).toBe(507);
  });
});
