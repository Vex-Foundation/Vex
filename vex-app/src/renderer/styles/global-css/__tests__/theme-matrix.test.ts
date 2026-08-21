/**
 * Theme-matrix contract for the PRE-SHELL (post-gate setup stack).
 *
 * Ratified 2026-08-21: every screen after the Chronos Gate follows the
 * active theme, so nothing the setup stack paints may be a theme-invariant
 * literal. The defect this guards is exactly the one QA reported - a fixed
 * `#0a0d18` plate under theme-variable ink, which rendered "Welcome back."
 * and the typed password near-black on near-black.
 *
 * This is a CSS-TEXT contract test, not a render test: jsdom resolves no
 * cascade for Tailwind-emitted utilities, and the invariant we care about
 * lives in the stylesheet sources, not in any one component. It asserts:
 *
 *   1. `.vex-gate-plate` paints an ALIAS, never a colour literal - the
 *      single line whose regression re-breaks the light setup stack;
 *   2. every `--vex-alias-gate-*` token is defined in BOTH theme blocks
 *      (`:root` = chronos, `[data-vex-theme="celeris"]` = celeris), so a
 *      new pre-shell alias cannot ship dark-only;
 *   3. the `[data-vex-gate]` scope re-pins its projections from those
 *      aliases rather than from white/black-alpha literals;
 *   4. celeris never lightens status ink toward white (the light plate is
 *      already white - that mix is invisible on it).
 *
 * The Chronos Gate itself is deliberately OUT of scope: it stays the
 * theme-invariant dark brand moment and consumes none of these aliases.
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (name: string): string =>
  readFileSync(path.join(here, "..", name), "utf8");

const tokensCss = read("tokens.css");
const gateCss = read("chronos-gate.css");

/** Body of one top-level CSS rule, selected by its exact selector text. */
function ruleBody(css: string, selector: string): string {
  const at = css.indexOf(`${selector} {`);
  expect(at, `selector "${selector}" not found`).toBeGreaterThanOrEqual(0);
  const open = css.indexOf("{", at);
  const close = css.indexOf("\n}", open);
  return css.slice(open + 1, close);
}

const chronosBlock = ruleBody(tokensCss, ":root");
const celerisBlock = ruleBody(tokensCss, '[data-vex-theme="celeris"]');
const gateScopeBlock = ruleBody(gateCss, '[data-vex-gate="true"]');

/** Every pre-shell alias declared anywhere in the token sheet. */
const gateAliases = [
  ...new Set(
    [...tokensCss.matchAll(/(--vex-alias-gate-[a-z-]+)\s*:/g)].map(
      (match) => match[1] as string,
    ),
  ),
].sort();

describe("pre-shell plate", () => {
  it("paints a theme alias, never a colour literal", () => {
    const plate = ruleBody(gateCss, ".vex-gate-plate");
    expect(plate).toContain("var(--vex-alias-gate-plate)");
    // The guard that matters: re-hardcoding #0a0d18 (or any literal) here
    // is what re-breaks the celeris setup stack.
    expect(plate).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(plate).not.toMatch(/\brgba?\(/i);
  });

  it("keeps the chronos plate equal to the main-window backgroundColor", () => {
    // main/main-window.ts paints #0a0d18 = gray-1000, so first paint and the
    // plate stay one surface in the dark theme.
    expect(chronosBlock).toContain(
      "--vex-alias-gate-plate: var(--color-gray-1000)",
    );
    expect(tokensCss).toContain("--color-gray-1000: #0a0d18");
    expect(celerisBlock).toContain("--vex-alias-gate-plate: var(--color-gray-0)");
  });
});

describe("pre-shell alias group", () => {
  it("has aliases at all (the regex above is load-bearing)", () => {
    expect(gateAliases.length).toBeGreaterThanOrEqual(9);
    expect(gateAliases).toContain("--vex-alias-gate-plate");
  });

  it.each(gateAliases)("%s is defined in BOTH themes", (alias) => {
    expect(chronosBlock, "chronos (:root)").toContain(`${alias}:`);
    expect(celerisBlock, "celeris").toContain(`${alias}:`);
  });

  it("every gate utility used in the renderer has a @theme projection", () => {
    // A `--vex-alias-gate-*` token with no `--color-gate-*` projection makes
    // its Tailwind utility compile to NOTHING - no build error, no styling,
    // found only by eye. `bg-gate-input` shipped exactly that way for one
    // commit. This walks the real call sites instead of trusting the list.
    const rendererDir = path.join(here, "..", "..", "..");
    const used = new Set<string>();
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== "node_modules" && entry.name !== "__tests__") {
            walk(full);
          }
        } else if (/\.tsx?$/.test(entry.name)) {
          for (const match of readFileSync(full, "utf8").matchAll(
            /\b(?:bg|text|border)-(gate-[a-z]+)\b/g,
          )) {
            used.add(match[1] as string);
          }
        }
      }
    };
    walk(rendererDir);

    expect(used.size, "no gate utilities found - the regex drifted").
      toBeGreaterThan(0);
    for (const utility of used) {
      expect(tokensCss, `--color-${utility} projection missing`).toContain(
        `--color-${utility}: var(--vex-alias-`,
      );
    }
  });

  it("celeris never lightens pre-shell ink toward white", () => {
    const celerisGateInk = celerisBlock
      .split("\n")
      .filter((line) => line.includes("--vex-alias-gate-"))
      .join("\n");
    expect(celerisGateInk).not.toMatch(/,\s*white\s*\)/);
    expect(celerisGateInk).not.toMatch(/#fff(?:fff)?\b/i);
  });
});

describe("[data-vex-gate] scope", () => {
  it("re-projects from theme aliases, not white/black-alpha literals", () => {
    for (const projection of [
      "--color-border: var(--vex-alias-gate-border)",
      "--color-input: var(--vex-alias-gate-input)",
      "--color-muted: var(--vex-alias-gate-muted)",
    ]) {
      expect(gateScopeBlock).toContain(projection);
    }
    // The type scale and the micro-label weight are theme-invariant and stay; no
    // COLOUR declaration in the scope may be a literal.
    const colourLiterals = gateScopeBlock
      .split("\n")
      .filter(
        (line) => /rgba?\(|#[0-9a-f]{3,8}\b/i.test(line) && !line.includes("*"),
      );
    expect(colourLiterals).toEqual([]);
  });

  it("keys the pre-shell CTA on Button's data attributes, not utility classes", () => {
    // The class-keyed selector (`button.rounded-full.font-mono`) died
    // silently when the rebrand renamed the radius utility; the data hook is
    // owned by components/ui/button.tsx. Comments are stripped first - the
    // block above names the dead selector on purpose.
    const declarations = gateCss.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(declarations).toContain("button[data-vex-button]");
    expect(declarations).toContain('button[data-vex-button-size="lg"]');
    expect(declarations).not.toMatch(/button\.[a-z]/i);
  });
});
