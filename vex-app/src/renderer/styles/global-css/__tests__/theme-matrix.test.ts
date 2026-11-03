/**
 * Theme-matrix contract for the token sheet (R3 Minimal on the V10 colours),
 * both rooms.
 *
 * This is a CSS-TEXT contract test, not a render test: jsdom resolves no
 * cascade for Tailwind-emitted utilities, and the invariant we care about
 * lives in the stylesheet sources, not in any one component. It asserts:
 *
 *   1. the static tier holds exactly the primitives, at their values
 *      (paper, ink and the one blue; Night Ledger; the candle pair; the
 *      trading pair, two per room), and the trading aliases and the night
 *      edge on blue fills point at the right room's values;
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

/**
 * The H3 primitives taken from the design sheet (docs/design/H3-DESKTOP.md
 * section 2.1), as the sheet's oklch [lightness 0-1, chroma, hue]. tokens.css
 * carries each as its sRGB hex; the suite converts these itself and holds the
 * sheet to them, so a hand-typed hex cannot drift from the design. The ground
 * is the sheet's --panel (the captures read it, not --page).
 */
const H3_SHEET: Readonly<Record<string, readonly [number, number, number]>> = {
  "--color-h3-ground": [0.085, 0.008, 264],
  "--color-h3-cell": [0.11, 0.006, 264],
  "--color-h3-raised": [0.13, 0.004, 264],
  "--color-h3-ink": [0.97, 0.005, 264],
  "--color-h3-ink-2": [0.8, 0.012, 264],
  "--color-h3-muted": [0.62, 0.02, 264],
  "--color-h3-blue": [0.452, 0.313, 264.1],
  "--color-h3-blue-hover": [0.56, 0.28, 264],
  "--color-h3-gain": [0.78, 0.13, 150],
  "--color-h3-loss": [0.74, 0.17, 27],
};

/**
 * The H3 primitives the sheet has no token for, measured from the app
 * captures (section 2.1's "none" rows). Pinned as values: the contract's
 * measurement is their only source until the mockup source arrives.
 */
const H3_MEASURED: Readonly<Record<string, string>> = {
  "--color-h3-raised-2": "#101214",
  "--color-h3-bubble": "#212325",
  "--color-h3-row": "#181a1c",
  "--color-h3-status-green": "#1d7e3f",
  "--color-h3-status-red": "#c22226",
};

/** Björn Ottosson's OKLab -> linear sRGB, then the sRGB transfer function. */
function oklchToSrgb(lightness: number, chroma: number, hue: number): [number, number, number] {
  const radians = (hue * Math.PI) / 180;
  const a = chroma * Math.cos(radians);
  const b = chroma * Math.sin(radians);
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const linear = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
  const encoded = linear.map((c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055));
  return encoded as [number, number, number];
}

const inSrgb = (rgb: readonly number[]): boolean => rgb.every((c) => c >= -1e-6 && c <= 1 + 1e-6);

/**
 * The sheet's value as sRGB hex. A value outside sRGB is channel-clipped,
 * which is the sRGB the contract records for the two that fall outside (the
 * blue hover #1557FF and the loss red #FF7A6E).
 */
function oklchToHex(lightness: number, chroma: number, hue: number): string {
  const rgb = oklchToSrgb(lightness, chroma, hue);
  return `#${rgb
    .map((c) => Math.round(Math.min(1, Math.max(0, c)) * 255).toString(16).padStart(2, "0"))
    .join("")}`;
}

/**
 * The primitives, and nothing else: the V10 colours (docs/design/R3-MINIMAL.md
 * section 1) plus the trading pair, two per room, and the H3 set.
 */
const PRIMITIVES: Readonly<Record<string, string>> = {
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
  "--color-up": "#10763a",
  "--color-down": "#c2272e",
  "--color-up-night": "#4cd685",
  "--color-down-night": "#ff7b7b",
  "--color-h3-ground": "#010203",
  "--color-h3-cell": "#040406",
  "--color-h3-raised": "#070709",
  "--color-h3-raised-2": "#101214",
  "--color-h3-bubble": "#212325",
  "--color-h3-row": "#181a1c",
  "--color-h3-ink": "#f3f5f9",
  "--color-h3-ink-2": "#babec6",
  "--color-h3-muted": "#808693",
  "--color-h3-blue": "#0000ff",
  "--color-h3-blue-hover": "#1557ff",
  "--color-h3-gain": "#76cf8a",
  "--color-h3-loss": "#ff7a6e",
  "--color-h3-status-green": "#1d7e3f",
  "--color-h3-status-red": "#c22226",
};

describe("the static tier", () => {
  it("holds exactly the 38 primitives, at their values", () => {
    const colours = new Map(
      [...declarations(staticTier)].filter(([name, value]) =>
        name.startsWith("--color-") && /^#[0-9a-f]{6}$/i.test(value),
      ),
    );
    expect(Object.keys(PRIMITIVES)).toHaveLength(38);
    expect(Object.fromEntries(colours)).toEqual(PRIMITIVES);
  });

  it("lands its oklch converter on sRGB's fixed points: pure blue, white and black", () => {
    // Load-bearing: if the conversion drifted, every H3 check below would
    // compare a wrong hex with a wrong hex and pass. Pure blue at full
    // precision (the sheet rounds it to 45.2% 0.313 264.1).
    expect(oklchToHex(0.45201372, 0.31321437, 264.05202)).toBe("#0000ff");
    expect(oklchToHex(1, 0, 0)).toBe("#ffffff");
    expect(oklchToHex(0, 0, 0)).toBe("#000000");
  });

  it.each(Object.entries(H3_SHEET))("holds %s to the sheet's oklch value", (name, [l, c, h]) => {
    // Within one step per channel: the sheet rounds lightness and chroma to
    // three places, which moves a channel by up to one step (its blue lands
    // on #0100ff; the captures paint the key #0000ff, sRGB's own blue).
    const hex = PRIMITIVES[name];
    expect(hex, `${name} is not a primitive`).toBeDefined();
    const channels = (value: string): number[] =>
      [1, 3, 5].map((at) => parseInt(value.slice(at, at + 2), 16));
    const sheet = channels(oklchToHex(l, c, h));
    const token = channels(hex ?? "");
    sheet.forEach((value, index) => {
      expect(Math.abs(value - (token[index] ?? -9)), `${name} channel ${String(index)}`).toBeLessThanOrEqual(1);
    });
  });

  it("names the two values the clip moved, and only those", () => {
    // The blue hover and the loss red sit outside sRGB as the sheet states
    // them; every other sheet value is inside and converts unchanged.
    const moved = Object.entries(H3_SHEET)
      .filter(([, [l, c, h]]) => !inSrgb(oklchToSrgb(l, c, h)))
      .map(([name]) => name);
    expect(moved).toEqual(["--color-h3-blue-hover", "--color-h3-loss"]);
  });

  it("pins the measured H3 primitives, and gives every H3 primitive one source", () => {
    // Section 2.1: a primitive comes from the sheet or from the captures,
    // never from both and never from neither.
    for (const [name, hex] of Object.entries(H3_MEASURED)) {
      expect(PRIMITIVES[name], name).toBe(hex);
      expect(name in H3_SHEET, `${name} is in both tables`).toBe(false);
    }
    const h3 = Object.keys(PRIMITIVES).filter((name) => name.startsWith("--color-h3-")).sort();
    expect(h3).toEqual([...Object.keys(H3_SHEET), ...Object.keys(H3_MEASURED)].sort());
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

  it("reaches only the primitives through its var() hops", () => {
    const primitives = new Set(Object.keys(PRIMITIVES));
    for (const body of [chronosBlock, celerisBlock]) {
      for (const [, value] of declarations(body)) {
        for (const hop of value.matchAll(/var\((--color-[a-z0-9-]+)\)/g)) {
          expect(primitives.has(hop[1] as string), `${hop[1]} is not a primitive`).toBe(true);
        }
      }
    }
  });
});

describe("the trading pair and the night edge", () => {
  const chronos = declarations(chronosBlock);
  const celeris = declarations(celerisBlock);
  const themeInline = declarations(ruleBody(tokensCss, "@theme inline"));

  it("paints the paper pair by day and the night pair at night", () => {
    expect(celeris.get("--vex-alias-trade-up")).toBe("var(--color-up)");
    expect(celeris.get("--vex-alias-trade-down")).toBe("var(--color-down)");
    expect(chronos.get("--vex-alias-trade-up")).toBe("var(--color-up-night)");
    expect(chronos.get("--vex-alias-trade-down")).toBe("var(--color-down-night)");
    // Type on a solid Long or Short key: white on paper, the night paper at
    // night.
    expect(celeris.get("--vex-alias-trade-ink")).toBe("var(--color-white)");
    expect(chronos.get("--vex-alias-trade-ink")).toBe("var(--color-night)");
  });

  it("projects the pair into its utilities through the aliases", () => {
    expect(themeInline.get("--color-trade-up")).toBe("var(--vex-alias-trade-up)");
    expect(themeInline.get("--color-trade-down")).toBe("var(--vex-alias-trade-down)");
    expect(themeInline.get("--color-ink-on-trade")).toBe("var(--vex-alias-trade-ink)");
  });

  it("keeps the trading primitives off every alias but the trading ones", () => {
    // Status is a fill and a word, never a hue: no state, label, accent or
    // rule alias may reach the trading pair.
    for (const body of [chronos, celeris]) {
      const offenders = [...body]
        .filter(([name]) => name.startsWith("--vex-alias-") && !name.startsWith("--vex-alias-trade-"))
        .filter(([, value]) => /var\(--color-(?:up|down)(?:-night)?\)/.test(value))
        .map(([name]) => name);
      expect(offenders).toEqual([]);
    }
  });

  it("edges a blue fill in periwinkle at night and leaves it bare by day", () => {
    expect(chronos.get("--vex-alias-button-accent-fill")).toBe("var(--color-blue)");
    expect(chronos.get("--vex-alias-button-accent-edge")).toBe("var(--color-peri)");
    expect(celeris.get("--vex-alias-button-accent-edge")).toBe("transparent");
    expect(themeInline.get("--color-button-accent-edge")).toBe(
      "var(--vex-alias-button-accent-edge)",
    );
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
    // docs/design/R3-MINIMAL.md section 1.1: on the night print every type is
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
    // literal colour. The wake and unlock title is the room's one blue
    // (`accent-primary`: the blue by day, the periwinkle at night, spec
    // section 10.2); the leaf's release counter keeps the gate counter alias.
    // The wizard's step numerals left with its V10 leaf (R3 wave 5, W5-2).
    const stage = stripComments(gateCss);
    for (const selector of [".vex-stage-counter {", ".vex-stage-title {"]) {
      const at = stage.indexOf(selector);
      expect(at, `${selector} missing`).toBeGreaterThanOrEqual(0);
      const body = stage.slice(at, stage.indexOf("}", at));
      expect(body).toMatch(/color: var\(--vex-alias-(?:gate-counter|title|accent-primary)\)/);
      expect(body).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(/i);
    }
    expect(chronosBlock).toContain("--vex-alias-accent-primary: var(--color-peri)");
    expect(celerisBlock).toContain("--vex-alias-accent-primary: var(--color-blue)");
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
    const gateUtility = /\b(?:bg|text|border)-(gate-[a-z]+)\b/g;
    // The R3 first run and wizard (wave 5) dropped the last call sites, so the
    // walk may find none; the scanner must still read every utility form, or
    // a drifted regex would pass by finding nothing.
    const sample = 'className="bg-gate-code text-gate-warn border-gate-rail"';
    expect(
      [...sample.matchAll(gateUtility)].map((match) => match[1]),
      "the regex drifted",
    ).toEqual(["gate-code", "gate-warn", "gate-rail"]);
    const used = new Set<string>();
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== "node_modules" && entry.name !== "__tests__") {
            walk(full);
          }
        } else if (/\.tsx?$/.test(entry.name)) {
          for (const match of readFileSync(full, "utf8").matchAll(gateUtility)) {
            used.add(match[1] as string);
          }
        }
      }
    };
    walk(rendererDir);

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
    // `data-vex-button-size` = size). The bare-variant hook left with the old
    // wizard leaf's step actions (R3 wave 5); the size hook stays.
    const declarations = gateCss.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(declarations).toContain('button[data-vex-button-size="lg"]');
    expect(declarations).not.toMatch(/\.vex-step-actions/);
    expect(declarations).not.toMatch(/button\.[a-z]/i);
  });
});
