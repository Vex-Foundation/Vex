/**
 * THE BOARD SURFACE - a token contract, tested as CSS TEXT.
 *
 * jsdom resolves no cascade for Tailwind-emitted utilities, so the invariant
 * that matters lives in the stylesheet sources rather than in any rendered
 * component. Three things are pinned, and each is a defect that would ship
 * silently:
 *
 *  1. the plate paints ALIASES, never literals - the same defect the pre-shell
 *     plate shipped once already, where a fixed dark hex sat under
 *     theme-variable ink and rendered near-black on near-black;
 *  2. every board alias exists in BOTH theme blocks, so a new one cannot ship
 *     dark-only;
 *  3. every board alias has a `@theme inline` projection - an alias WITHOUT
 *     one compiles to nothing at the call site, silently and with no build
 *     error, which is how `bg-board-card` would become a transparent card.
 *
 * The gradient itself lives in build-time CSS rather than a React `style`
 * attribute because the renderer's CSP has no `unsafe-inline`: an inline
 * radial is not a style choice, it is a rule the browser refuses.
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

const chronos = ruleBody(tokensCss, ":root");
const celeris = ruleBody(tokensCss, '[data-vex-theme="celeris"]');
const themeInline = ruleBody(tokensCss, "@theme inline");

const boardAliases = [
  ...new Set(
    [...tokensCss.matchAll(/(--vex-alias-board-[a-z-]+)\s*:/g)].map(
      (match) => match[1] as string,
    ),
  ),
].sort();

describe("board surface tokens", () => {
  it("declares the aliases the surfaces consume", () => {
    expect(boardAliases).toEqual([
      "--vex-alias-board-card",
      "--vex-alias-board-card-hover",
      "--vex-alias-board-surface",
      "--vex-alias-board-vignette",
    ]);
  });

  it.each(boardAliases)("defines %s in BOTH theme blocks", (alias) => {
    expect(chronos).toContain(`${alias}:`);
    expect(celeris).toContain(`${alias}:`);
  });

  it.each([
    ["--color-board-surface", "--vex-alias-board-surface"],
    ["--color-board-card", "--vex-alias-board-card"],
    ["--color-board-card-hover", "--vex-alias-board-card-hover"],
  ])("projects %s from %s", (utility, alias) => {
    expect(themeInline).toContain(`${utility}: var(${alias})`);
  });

  it("paints the plate from aliases, never from a colour literal", () => {
    const plate = ruleBody(boardCss, ".vex-board-surface");
    expect(plate).toContain("var(--vex-alias-board-surface)");
    expect(plate).toContain("var(--vex-alias-board-vignette)");
    expect(plate).not.toMatch(/#[0-9a-f]{3,8}\b/i);
  });

  it("keeps the vignette a build-time radial, not an inline style", () => {
    expect(boardCss).toContain("radial-gradient");
  });

  it("guards its one animated surface behind reduced motion", () => {
    expect(boardCss).toContain("@media (prefers-reduced-motion: reduce)");
  });

  it("is imported by the manifest, unlayered like every other sheet", () => {
    expect(globalsCss).toContain('@import "./global-css/board.css";');
    expect(globalsCss).not.toContain("board.css\" layer");
  });
});
