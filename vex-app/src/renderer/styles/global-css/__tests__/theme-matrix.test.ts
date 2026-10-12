/**
 * Theme-matrix contract for the V10 token sheet, both rooms.
 *
 * This is a CSS-TEXT contract test, not a render test: jsdom resolves no
 * cascade for Tailwind-emitted utilities, and the invariant we care about
 * lives in the stylesheet sources, not in any one component. It asserts:
 *
 *   1. the static tier holds exactly the V10 primitives, at their values
 *      (paper, ink and the one blue; Night Ledger; the candle pair);
 *   2. every `--vex-alias-*` is declared in BOTH theme blocks, so no alias
 *      can ship one-room-only, and an alias names a primitive or another
 *      alias, never a raw hex (the terminal's wire-contract slots excepted);
 *   3. the pre-shell plate paints an ALIAS, never a colour literal, and the
 *      chronos plate equals the main-window `backgroundColor`, so first paint
 *      and the plate are one surface; on the night print every stage type is
 *      paper (the counter's contrast fix);
 *   4. the `[data-vex-gate]` scope re-pins its projections from aliases;
 *   5. the Studio file viewer's code tokens are declared in both themes.
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
const mainWindowTs = readFileSync(
  path.join(here, "..", "..", "..", "..", "main", "windows", "main-window.ts"),
  "utf8",
);
const chromeOptionsTs = readFileSync(
  path.join(here, "..", "..", "..", "..", "main", "windows", "chrome-options.ts"),
  "utf8",
);

/** Body of one top-level CSS rule, selected by its exact selector text. */
function ruleBody(css: string, selector: string): string {
  const at = css.indexOf(`${selector} {`);
  expect(at, `selector "${selector}" not found`).toBeGreaterThanOrEqual(0);
  const open = css.indexOf("{", at);
  const close = css.indexOf("\n}", open);
  return css.slice(open + 1, close);
}

/** Strip block comments so a token NAMED in prose is not read as a rule. */
const stripComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, "");

const staticTier = stripComments(ruleBody(tokensCss, "@theme"));
const chronosBlock = ruleBody(tokensCss, ":root");
const celerisBlock = ruleBody(tokensCss, '[data-vex-theme="celeris"]');
const gateScopeBlock = ruleBody(gateCss, '[data-vex-gate="true"]');

/** `name -> value` for every custom property a block declares. */
function declarations(body: string): Map<string, string> {
  return new Map(
    [...stripComments(body).matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)].map((match) => [
      match[1] as string,
      (match[2] as string).trim().replace(/\s+/g, " "),
    ]),
  );
}

/** Every pre-shell alias declared anywhere in the token sheet. */
const gateAliases = [
  ...new Set(
    [...tokensCss.matchAll(/(--vex-alias-gate-[a-z-]+)\s*:/g)].map(
      (match) => match[1] as string,
    ),
  ),
].sort();

/** The V10 primitives (docs/design/V10-SPREAD.md section 1), and nothing else. */
const V10_PRIMITIVES: Readonly<Record<string, string>> = {
  "--color-white": "#ffffff",
  "--color-black": "#000000",
  "--color-paper": "#f3f4f7",
  "--color-paper-2": "#e8eaf2",
  "--color-ink": "#0a0d18",
  "--color-ink-2": "#3a3e52",
  "--color-ink-3": "#565c78",
  "--color-blue": "#0000c0",
  "--color-blue-hi": "#0000ff",
  "--color-night-0": "#150f0d",
  "--color-night": "#1b1412",
  "--color-night-1": "#221a17",
  "--color-night-2": "#2a201c",
  "--color-type-2": "#bbbabb",
  "--color-type-3": "#989697",
  "--color-peri": "#a3abff",
  "--color-peri-hi": "#6470ff",
  "--color-candle-up": "#22c55e",
  "--color-candle-down": "#ef4444",
};

describe("the static tier", () => {
  it("holds exactly the V10 primitives, at their values", () => {
    const colours = new Map(
      [...declarations(staticTier)].filter(([name, value]) =>
        name.startsWith("--color-") && /^#[0-9a-f]{6}$/i.test(value),
      ),
    );
    expect(Object.fromEntries(colours)).toEqual(V10_PRIMITIVES);
  });

  it("kills Tailwind's default palette, so no stray hue can compile", () => {
    expect(staticTier).toContain("--color-*: initial;");
  });
});

describe("the alias tier", () => {
  const chronos = declarations(chronosBlock);
  const celeris = declarations(celerisBlock);
  const aliasNames = (map: Map<string, string>): string[] =>
    [...map.keys()].filter((name) => name.startsWith("--vex-alias-")).sort();

  it("declares every alias in BOTH rooms", () => {
    expect(aliasNames(chronos).length).toBeGreaterThan(100);
    expect(aliasNames(celeris)).toEqual(aliasNames(chronos));
  });

  it.each([
    ["chronos", chronosBlock],
    ["celeris", celerisBlock],
  ])("names a primitive or an alias, never a raw hex, outside the terminal (%s)", (_theme, body) => {
    // A hex in an alias is a colour no primitive owns: invisible to a palette
    // change and to every measurement keyed on the static tier. The terminal
    // slots are the one wire contract allowed raw values
    // (terminal-palette-tokens.test.ts).
    const offenders = [...declarations(body)]
      .filter(([name]) => name.startsWith("--vex-alias-") && !name.startsWith("--vex-alias-term-"))
      .filter(([, value]) => /#[0-9a-f]{3,8}\b/i.test(value))
      .map(([name, value]) => `${name}: ${value}`);
    expect(offenders).toEqual([]);
  });

  it("reaches only V10 primitives through its var() hops", () => {
    const primitives = new Set(Object.keys(V10_PRIMITIVES));
    for (const body of [chronosBlock, celerisBlock]) {
      for (const [, value] of declarations(body)) {
        for (const hop of value.matchAll(/var\((--color-[a-z0-9-]+)\)/g)) {
          expect(primitives.has(hop[1] as string), `${hop[1]} is not a V10 primitive`).toBe(true);
        }
      }
    }
  });
});

describe("pre-shell plate", () => {
  it("paints a theme alias, never a colour literal", () => {
    const plate = ruleBody(gateCss, ".vex-gate-plate");
    expect(plate).toContain("var(--vex-alias-gate-plate)");
    // Re-hardcoding a literal here is what re-breaks the light setup stack.
    expect(plate).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(plate).not.toMatch(/\brgba?\(/i);
  });

  it("keeps the chronos plate equal to the main-window backgroundColor", () => {
    // main/main-window.ts paints the window before the bundle loads; the
    // chronos plate and the chronos page ground must be that same night
    // paper, so first paint and the plate are one surface.
    expect(chronosBlock).toContain("--vex-alias-gate-plate: var(--color-night)");
    expect(chronosBlock).toContain("--vex-alias-bg-base: var(--color-night)");
    expect(tokensCss).toContain("--color-night: #1b1412");
    expect(mainWindowTs).toContain('backgroundColor: "#1b1412"');
    expect(celerisBlock).toContain("--vex-alias-gate-plate: var(--color-paper)");
  });

  it("sets the stage type on the print per room: paper at night, the blues by day", () => {
    // docs/design/V10-SPREAD.md section 1: on the night print every type is
    // paper and blue never sits on dark ground. The giant counter was the
    // one exception the design measured at 1.34:1 (peri-hi on the night
    // sky); it is paper there now. By day the counter is the numeral blue
    // and the title the logo blue, on the pale sky.
    expect(chronosBlock).toContain("--vex-alias-gate-counter: var(--color-paper)");
    expect(chronosBlock).toContain("--vex-alias-title: var(--color-paper)");
    expect(chronosBlock).toContain("--vex-alias-label-primary: var(--color-paper)");
    expect(celerisBlock).toContain("--vex-alias-gate-counter: var(--color-blue-hi)");
    expect(celerisBlock).toContain("--vex-alias-title: var(--color-blue)");
    // The unlock field and its box are night fields at night and the paper
    // label box by day: never the white field on the print.
    expect(chronosBlock).toContain("--vex-alias-gate-field: var(--color-night-1)");
    expect(celerisBlock).toContain("--vex-alias-gate-field: var(--color-paper)");
    // Every rule that sets type on the stage reads these aliases, never a
    // literal colour.
    const stage = stripComments(gateCss);
    for (const selector of [".vex-stage-counter {", ".vex-unl__h1 {", ".vex-stage-step__n {"]) {
      const at = stage.indexOf(selector);
      expect(at, `${selector} missing`).toBeGreaterThanOrEqual(0);
      const body = stage.slice(at, stage.indexOf("}", at));
      expect(body).toMatch(/color: var\(--vex-alias-(?:gate-counter|title)\)/);
      expect(body).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(/i);
    }
  });

  it("keeps the native title bar overlay on the page paper and its ink", () => {
    // main/windows/chrome-options.ts cannot read tokens.css (main process), so
    // it carries the overlay colours as constants; they must stay the room's
    // own paper and ink, or the window controls sit on a strip of another
    // colour.
    const overlay = (theme: string): { color: string; symbolColor: string } => {
      const match = new RegExp(
        `${theme}:\\s*\\{\\s*color:\\s*"(#[0-9a-f]{6})",\\s*symbolColor:\\s*"(#[0-9a-f]{6})"`,
        "i",
      ).exec(chromeOptionsTs);
      expect(match, `${theme} overlay colours not found`).not.toBeNull();
      return { color: (match?.[1] ?? "").toLowerCase(), symbolColor: (match?.[2] ?? "").toLowerCase() };
    };
    expect(overlay("chronos")).toEqual({ color: "#1b1412", symbolColor: "#f3f4f7" });
    expect(overlay("celeris")).toEqual({ color: "#f3f4f7", symbolColor: "#0a0d18" });
    expect(chronosBlock).toContain("--vex-alias-label-primary: var(--color-paper)");
    expect(celerisBlock).toContain("--vex-alias-bg-base: var(--color-paper)");
    expect(celerisBlock).toContain("--vex-alias-label-primary: var(--color-ink)");
  });
});

/**
 * The Studio file viewer's code tokens. Shiki writes
 * `var(--vex-alias-code-token-keyword)` directly into a token's inline colour,
 * so a slot this sheet stops declaring does not throw and does not warn - the
 * token simply renders with no colour, and only in the theme that lost it.
 */
const CODE_THEME_SLOTS = [
  "foreground",
  "background",
  "token-constant",
  "token-string",
  "token-comment",
  "token-keyword",
  "token-parameter",
  "token-function",
  "token-string-expression",
  "token-punctuation",
  "token-link",
  "token-inserted",
  "token-deleted",
  "token-changed",
] as const;

describe("file-viewer code tokens", () => {
  it.each(CODE_THEME_SLOTS)(
    "--vex-alias-code-%s is declared in BOTH themes",
    (slot) => {
      const alias = `--vex-alias-code-${slot}:`;
      expect(chronosBlock, "chronos (:root)").toContain(alias);
      expect(celerisBlock, "celeris").toContain(alias);
    },
  );

  it("resolves every code token through an alias, never a raw colour", () => {
    for (const block of [chronosBlock, celerisBlock]) {
      for (const match of block.matchAll(/--vex-alias-code-[a-z-]+:\s*([^;]+);/g)) {
        const value = (match[1] ?? "").trim();
        expect(value === "transparent" || value.startsWith("var(--vex-alias-")).toBe(
          true,
        );
      }
    }
  });

  it("speaks one blue and the ink ramp: no status hue reaches the code", () => {
    // V10: no rainbow. A code slot pointed at a state alias would re-import a
    // status meaning (and, before the collapse, a status hue) into syntax.
    for (const block of [chronosBlock, celerisBlock]) {
      for (const match of block.matchAll(/--vex-alias-code-[a-z-]+:\s*([^;]+);/g)) {
        expect(match[1]).not.toMatch(/state-/);
      }
    }
  });

  it("declares every slot the tokenizer's own table names, and no more", () => {
    const declared = [
      ...new Set(
        [...chronosBlock.matchAll(/--vex-alias-code-([a-z-]+)\s*:/g)].map(
          (match) => match[1] as string,
        ),
      ),
    ].sort();
    expect(declared).toEqual([...CODE_THEME_SLOTS].sort());
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
    // found only by eye. This walks the real call sites.
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

  it("never mixes pre-shell ink toward white or black", () => {
    // Status ink is a fill pattern now; the gate's alert inks are the status
    // inks themselves, so no mix may lighten or darken them per room.
    for (const block of [chronosBlock, celerisBlock]) {
      const gateInk = block
        .split("\n")
        .filter((line) => line.includes("--vex-alias-gate-"))
        .join("\n");
      expect(gateInk).not.toMatch(/,\s*(?:white|black)\s*\)/);
      expect(gateInk).not.toMatch(/#fff(?:fff)?\b/i);
    }
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
    // The type scale is theme-invariant and stays; no COLOUR declaration in
    // the scope may be a literal.
    const colourLiterals = gateScopeBlock
      .split("\n")
      .filter(
        (line) => /rgba?\(|#[0-9a-f]{3,8}\b/i.test(line) && !line.includes("*"),
      );
    expect(colourLiterals).toEqual([]);
  });

  it("keys the pre-shell CTA on Button's data attributes, not utility classes", () => {
    // A class-keyed selector died silently once already when the radius
    // utility was renamed; the data hooks are owned by
    // components/ui/button.tsx (`data-vex-button` = variant,
    // `data-vex-button-size` = size).
    const declarations = gateCss.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(declarations).toContain('button[data-vex-button="bare"]');
    expect(declarations).toContain('button[data-vex-button-size="lg"]');
    expect(declarations).not.toMatch(/button\.[a-z]/i);
  });
});
