/**
 * THE BOARD SURFACE - a token contract, tested as CSS TEXT.
 *
 * jsdom resolves no cascade for Tailwind-emitted utilities, so the invariant
 * that matters lives in the stylesheet sources rather than in any rendered
 * component. Four things are pinned, and each is a defect that would ship
 * silently:
 *
 *  1. the plate paints ALIASES, never literals - the same defect the pre-shell
 *     plate shipped once already, where a fixed dark hex sat under
 *     theme-variable ink;
 *  2. every board alias exists in BOTH theme blocks, so a new one cannot ship
 *     one-room-only;
 *  3. every board alias has a `@theme inline` projection - an alias WITHOUT
 *     one compiles to nothing at the call site, silently, which is how
 *     `bg-board-card` would become a transparent card;
 *  4. V10 paints the plate FLAT: no vignette, no gradient ramp, no inner
 *     highlight; a card is told from the plate by its rule.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (name: string): string =>
  readFileSync(path.join(here, "..", name), "utf8");

const tokensCss = read("tokens.css");
const boardCss = read("board.css");
const globalsCss = readFileSync(
  path.join(here, "..", "..", "globals.css"),
  "utf8",
);

function ruleBody(css: string, selector: string): string {
  const at = css.indexOf(`${selector} {`);
  expect(at, `selector "${selector}" not found`).toBeGreaterThanOrEqual(0);
  const open = css.indexOf("{", at);
  const close = css.indexOf("\n}", open);
  return css.slice(open + 1, close);
}

const stripComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, "");

const chronos = ruleBody(tokensCss, ":root");
const celeris = ruleBody(tokensCss, '[data-vex-theme="celeris"]');
const themeInline = ruleBody(tokensCss, "@theme inline");

const boardAliases = [
  ...new Set(
    [...stripComments(tokensCss).matchAll(/(--vex-alias-board-[a-z-]+)\s*:/g)].map(
      (match) => match[1] as string,
    ),
  ),
].sort();

describe("board surface tokens", () => {
  it("declares the aliases the surfaces consume, and the vignette is gone", () => {
    expect(boardAliases).toEqual([
      "--vex-alias-board-card",
      "--vex-alias-board-card-hover",
      "--vex-alias-board-surface",
    ]);
  });

  it.each(boardAliases)("defines %s in BOTH theme blocks", (alias) => {
    expect(chronos).toContain(`${alias}:`);
    expect(celeris).toContain(`${alias}:`);
  });

  it.each(boardAliases)("resolves %s to a V10 paper step in both rooms", (alias) => {
    for (const body of [chronos, celeris]) {
      const value = new RegExp(`${alias}:\\s*([^;]+);`).exec(body)?.[1]?.trim();
      expect(value).toMatch(/^var\(--color-(paper|paper-2|night|night-0|night-1|night-2)\)$/);
    }
  });

  it.each([
    ["--color-board-surface", "--vex-alias-board-surface"],
    ["--color-board-card", "--vex-alias-board-card"],
    ["--color-board-card-hover", "--vex-alias-board-card-hover"],
  ])("projects %s from %s", (utility, alias) => {
    expect(themeInline).toContain(`${utility}: var(${alias})`);
  });

  it("paints the plate from the alias alone: no vignette, no gradient", () => {
    const plate = ruleBody(boardCss, ".vex-board-surface");
    expect(plate).toContain("background-color: var(--vex-alias-board-surface)");
    expect(plate).not.toContain("background-image");
    expect(stripComments(boardCss)).not.toMatch(/gradient\(/);
  });

  it("flashes the live tick from the accent alias, in build-time keyframes", () => {
    const keyframes = ruleBody(boardCss, "@keyframes vex-board-tick");
    expect(keyframes).toContain("var(--vex-alias-accent-wash)");
    expect(keyframes).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(ruleBody(boardCss, "[data-tick]")).toContain("vex-board-tick");
  });

  it("stills the tick outright under reduced motion", () => {
    const at = boardCss.indexOf("@media (prefers-reduced-motion: reduce)");
    expect(at).toBeGreaterThanOrEqual(0);
    expect(boardCss.slice(at)).toMatch(/\[data-tick\]\s*\{\s*animation:\s*none;/);
  });

  it("paints no colour literal and no shadow anywhere", () => {
    const source = stripComments(boardCss);
    expect(source).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(source).not.toMatch(/\brgba?\(/i);
    expect(source).not.toContain("box-shadow");
  });

  it("paints the page and the selected tile square, from aliases", () => {
    // The Board is a page in the centre column (docs/design/R3-MINIMAL.md
    // section 9.4): the page body sits on the board paper alias.
    expect(ruleBody(boardCss, ".vex-bd")).toContain(
      "background-color: var(--vex-alias-board-surface)",
    );
    // The selected tile: a 1.5px blue outline drawn inside the tile.
    const frame = ruleBody(boardCss, '.vex-board-card[data-selected="true"]');
    expect(frame).toContain("1.5px solid var(--vex-alias-accent-primary)");
    expect(frame).toContain("outline-offset: -1.5px");
    expect(stripComments(boardCss)).not.toMatch(/border-radius/);
  });

  it("asks the sheet for the whole centre and the page padding, 20 28", () => {
    const page = ruleBody(boardCss, ".vex-ov:has(.vex-bd)");
    expect(page).toContain("--vex-ov-max: none");
    expect(page).toContain("--vex-ov-pad: 28px");
    expect(page).toContain("--vex-ov-top: 20px");
  });

  it("draws the shared chip pressed in the one blue, never a hue of its own", () => {
    // The pressed list ends with the data seam: aria-pressed, aria-checked, data-on.
    const pressed = ruleBody(boardCss, '.vex-bd-chip[data-on="true"]');
    expect(boardCss).toContain('.vex-bd-chip[aria-pressed="true"],');
    expect(pressed).toContain("var(--vex-alias-accent-primary)");
    expect(ruleBody(boardCss, ".vex-bd-chip")).toContain("height: 26px");
  });

  it("keeps the candle colours out of the Board stylesheets", () => {
    const layout = stripComments(read("board-layout.css"));
    expect(layout).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(/i);
    expect(layout).not.toMatch(/border-radius|box-shadow/);
  });

  it("is imported by the manifest, unlayered like every other sheet", () => {
    expect(globalsCss).toContain('@import "./global-css/board.css";');
    expect(globalsCss).not.toContain("board.css\" layer");
  });
});
