/**
 * Theme-matrix contract for the token sheet: ONE room. H3 is dark only (the
 * H3 revamp plan, decision 6), so the matrix this file used to hold, every
 * alias in a dark and a light block, collapsed to a single column, and the
 * contract is that it stays single.
 *
 * This is a CSS-TEXT contract test, not a render test: jsdom resolves no
 * cascade for Tailwind-emitted utilities, and the invariant we care about
 * lives in the stylesheet sources, not in any one component. It asserts:
 *
 *   1. the static tier holds exactly the primitives, at their values (the
 *      website paper and the one blue; Night Ledger; the candle pair; the
 *      night trading pair; the H3 set, each held to the design sheet's
 *      oklch), and the trading aliases and the edge on blue fills point at
 *      their values;
 *   2. the alias tier is the :root block alone: no sheet re-points it under a
 *      theme attribute or the OS colour scheme, and an alias names a
 *      primitive or another alias, never a raw hex (the terminal's
 *      wire-contract slots excepted);
 *   3. the pre-shell plate paints an ALIAS, never a colour literal, and it
 *      equals the main-window `backgroundColor`, so first paint and the plate
 *      are one surface; on the night print every stage type is paper (the
 *      counter's contrast fix);
 *   4. the `[data-vex-gate]` scope re-pins its projections from aliases;
 *   5. the Studio file viewer's code tokens are all declared.
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
const stageCss = read("stage.css");
const wizardCss = read("wizard.css");
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
/** The one room: the alias tier on :root. */
const chronosBlock = ruleBody(tokensCss, ":root");
const gateScopeBlock = ruleBody(gateCss, '[data-vex-gate="true"]');

/** Every stylesheet under styles/global-css, by posix path, comments kept. */
function allSheets(): ReadonlyArray<readonly [string, string]> {
  const base = path.join(here, "..");
  const found: Array<readonly [string, string]> = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "__tests__") walk(full);
      } else if (entry.name.endsWith(".css")) {
        found.push([path.relative(base, full).split(path.sep).join("/"), readFileSync(full, "utf8")]);
      }
    }
  };
  walk(base);
  return found;
}

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
 * section 2.1), or from VEX Cloud's built tokens where those win (the hud and
 * the refusal ink), as oklch [lightness 0-1, chroma, hue]. tokens.css
 * carries each as its sRGB hex; the suite converts these itself and holds the
 * sheet to them, so a hand-typed hex cannot drift from the design. The ground
 * is the sheet's --panel (the captures read it, not --page).
 */
const H3_SHEET: Readonly<Record<string, readonly [number, number, number]>> = {
  "--color-h3-ground": [0.085, 0.008, 264],
  "--color-h3-cell": [0.11, 0.006, 264],
  "--color-h3-raised": [0.13, 0.004, 264],
  // VEX Cloud's card ground and tooltip plate (--vx-card, --vx-tooltip).
  "--color-h3-card": [0.105, 0.006, 264],
  "--color-h3-tooltip": [0.2, 0.004, 264],
  "--color-h3-ink": [0.97, 0.005, 264],
  "--color-h3-ink-2": [0.8, 0.012, 264],
  "--color-h3-muted": [0.62, 0.02, 264],
  "--color-h3-blue": [0.452, 0.313, 264.1],
  "--color-h3-blue-hover": [0.56, 0.28, 264],
  "--color-h3-gain": [0.78, 0.13, 150],
  "--color-h3-loss": [0.74, 0.17, 27],
  // VEX Cloud's built tokens (apps/web/src/styles.css), which win over the
  // mockup where they differ: the running square's hud and the refusal ink.
  "--color-h3-hud": [0.94, 0, 0],
  "--color-h3-err-text": [0.74, 0.17, 27],
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
 * The primitives, and nothing else: white and black (Tailwind's kill list
 * re-declares them), the candle pair and the H3 set. R3's colours retired
 * once no alias, sheet or component read them.
 */
const PRIMITIVES: Readonly<Record<string, string>> = {
  "--color-white": "#ffffff",
  "--color-black": "#000000",
  "--color-candle-up": "#22c55e",
  "--color-candle-down": "#ef4444",
  "--color-h3-ground": "#010203",
  "--color-h3-cell": "#040406",
  "--color-h3-raised": "#070709",
  "--color-h3-card": "#030405",
  "--color-h3-tooltip": "#151618",
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
  "--color-h3-hud": "#ebebeb",
  "--color-h3-err-text": "#ff7a6e",
};

describe("the static tier", () => {
  it("holds exactly the 23 primitives, at their values", () => {
    const colours = new Map(
      [...declarations(staticTier)].filter(([name, value]) =>
        name.startsWith("--color-") && /^#[0-9a-f]{6}$/i.test(value),
      ),
    );
    expect(Object.keys(PRIMITIVES)).toHaveLength(23);
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

  it("names the three values the clip moved, and only those", () => {
    // The blue hover, the loss red and Cloud's refusal ink (the loss red's
    // own oklch) sit outside sRGB as stated; every other value is inside and
    // converts unchanged.
    const moved = Object.entries(H3_SHEET)
      .filter(([, [l, c, h]]) => !inSrgb(oklchToSrgb(l, c, h)))
      .map(([name]) => name);
    expect(moved).toEqual(["--color-h3-blue-hover", "--color-h3-loss", "--color-h3-err-text"]);
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
  const room = declarations(chronosBlock);
  const aliasNames = [...room.keys()].filter((name) => name.startsWith("--vex-alias-"));

  it("declares the whole alias tier in the one room", () => {
    expect(aliasNames.length).toBeGreaterThan(100);
  });

  it("re-points no alias under a theme attribute or the OS scheme, in any sheet", () => {
    // Dark only: a `[data-vex-theme="celeris"]` block, a
    // `prefers-color-scheme: light` query or a light `color-scheme` would be
    // a second room the app no longer has, painted by nothing that can
    // reach it. Readers keyed on `data-vex-theme="chronos"` stay legal.
    const offenders = allSheets().flatMap(([file, css]) => {
      const text = stripComments(css);
      const hits: string[] = [];
      if (/\[data-(?:vex|lighter)-theme="?celeris"?\]/.test(text)) hits.push(`${file}: a celeris rule`);
      if (/:not\(\[data-vex-theme/.test(text)) hits.push(`${file}: a theme negation`);
      if (/prefers-color-scheme/.test(text)) hits.push(`${file}: a colour-scheme query`);
      if (/color-scheme:\s*light/.test(text)) hits.push(`${file}: a light colour scheme`);
      return hits;
    });
    expect(allSheets().map(([file]) => file)).toContain("tokens.css");
    expect(offenders).toEqual([]);
  });

  it("names a primitive or an alias, never a raw hex, outside the terminal", () => {
    // A hex in an alias is a colour no primitive owns: invisible to a palette
    // change and to every measurement keyed on the static tier. The terminal
    // slots are the one wire contract allowed raw values
    // (terminal-palette-tokens.test.ts).
    const offenders = [...room]
      .filter(([name]) => name.startsWith("--vex-alias-") && !name.startsWith("--vex-alias-term-"))
      .filter(([, value]) => /#[0-9a-f]{3,8}\b/i.test(value))
      .map(([name, value]) => `${name}: ${value}`);
    expect(offenders).toEqual([]);
  });

  it("reaches only the primitives through its var() hops", () => {
    const primitives = new Set(Object.keys(PRIMITIVES));
    for (const [, value] of room) {
      for (const hop of value.matchAll(/var\((--color-[a-z0-9-]+)\)/g)) {
        expect(primitives.has(hop[1] as string), `${hop[1]} is not a primitive`).toBe(true);
      }
    }
  });
});

describe("the trading pair and the night edge", () => {
  const chronos = declarations(chronosBlock);
  const themeInline = declarations(ruleBody(tokensCss, "@theme inline"));

  it("paints gains and losses in the sheet's type colours", () => {
    // docs/design/H3-DESKTOP.md section 2.2: the sheet's --live and --err,
    // replacing R3's night trading pair.
    expect(chronos.get("--vex-alias-trade-up")).toBe("var(--color-h3-gain)");
    expect(chronos.get("--vex-alias-trade-down")).toBe("var(--color-h3-loss)");
    // Type on a solid Long or Short key: the ground.
    expect(chronos.get("--vex-alias-trade-ink")).toBe("var(--color-h3-ground)");
  });

  it("projects the pair into its utilities through the aliases", () => {
    expect(themeInline.get("--color-trade-up")).toBe("var(--vex-alias-trade-up)");
    expect(themeInline.get("--color-trade-down")).toBe("var(--vex-alias-trade-down)");
    expect(themeInline.get("--color-ink-on-trade")).toBe("var(--vex-alias-trade-ink)");
  });

  it("keeps the trading primitives off every alias but the trading ones", () => {
    // A status is a square and an ink word, never a gain or a loss: no state,
    // label, accent or rule alias may reach the gain and loss pair, and only
    // the status-mark and stamp aliases reach the status green and red.
    const offenders = [...chronos]
      .filter(([name]) => name.startsWith("--vex-alias-") && !name.startsWith("--vex-alias-trade-"))
      .filter(([, value]) => /var\(--color-h3-(?:gain|loss)\)/.test(value))
      .map(([name]) => name);
    expect(offenders).toEqual([]);
    const statusColour = [...chronos]
      .filter(([, value]) => /var\(--color-h3-status-(?:green|red)\)/.test(value))
      .map(([name]) => name)
      .sort();
    expect(statusColour).toEqual([
      "--vex-alias-stamp-filled",
      "--vex-alias-state-error-mark",
      "--vex-alias-state-success-mark",
    ]);
    // The hud and the refusal ink are the status squares' own: the running
    // square and the refusal ink alone read them.
    const statusInks = [...chronos]
      .filter(([, value]) => /var\(--color-h3-(?:hud|err-text)\)/.test(value))
      .map(([name]) => name)
      .sort();
    expect(statusInks).toEqual(["--vex-alias-state-refusal", "--vex-alias-state-running-mark"]);
  });

  it("fills the primary key with the bare H3 blue, and its hover with the blue hover", () => {
    // docs/design/H3-DESKTOP.md section 2.4: the blue fills primary keys and
    // nothing else; the captures draw it with no edge.
    expect(chronos.get("--vex-alias-button-accent-fill")).toBe("var(--color-h3-blue)");
    expect(chronos.get("--vex-alias-button-accent-hover")).toBe("var(--color-h3-blue-hover)");
    expect(chronos.get("--vex-alias-button-accent-ink")).toBe("var(--color-white)");
    expect(chronos.get("--vex-alias-button-accent-edge")).toBe("transparent");
    // ...and nothing else: no type, line, ring or wash alias reaches it.
    const blueOutsideKeys = [...chronos]
      .filter(([name]) => !name.startsWith("--vex-alias-button-accent-"))
      .filter(([, value]) => /var\(--color-(?:h3-blue|h3-blue-hover|blue|blue-hi|peri|peri-hi)\)/.test(value))
      .map(([name]) => name);
    expect(blueOutsideKeys).toEqual([]);
    // The accent as type is the ink, and so is the focus ring.
    expect(chronos.get("--vex-alias-accent-primary")).toBe("var(--color-h3-ink)");
    expect(chronos.get("--vex-alias-focus")).toBe("var(--color-h3-ink)");
    expect(themeInline.get("--color-button-accent-edge")).toBe(
      "var(--vex-alias-button-accent-edge)",
    );
  });
});

describe("pre-shell stage", () => {
  it("paints the stage frame and her column on the ground alias, never a colour literal", () => {
    // docs/design/H3-DESKTOP.md section 4.9: every screen before the shell
    // stands on H3's stage frame (`.vex-pre`), and the wake's frame laid over
    // her column paints each of its own cells (`.vex-pre--over > *`), as her
    // column's cells do (`.vex-pre-vex > *`).
    for (const selector of [".vex-pre", ".vex-pre--over > *", ".vex-pre-vex > *"]) {
      const body = ruleBody(stageCss, selector);
      expect(body, selector).toContain("background: var(--vex-alias-bg-base);");
      expect(body, selector).not.toMatch(/#[0-9a-f]{3,8}\b/i);
      expect(body, selector).not.toMatch(/\brgba?\(/i);
    }
  });

  it("keeps the window, the plate and the ground one surface: the H3 ground", () => {
    // main/main-window.ts paints the window before the bundle loads; the
    // pre-shell plate and the shell's ground must be that same colour, so
    // first paint, the plate and the shell are one surface
    // (docs/design/H3-DESKTOP.md section 2.1). Electron takes a hex, so the
    // tie runs through the primitive's own value.
    expect(chronosBlock).toContain("--vex-alias-gate-plate: var(--color-h3-ground)");
    expect(chronosBlock).toContain("--vex-alias-bg-base: var(--color-h3-ground)");
    const ground = /--color-h3-ground:\s*(#[0-9a-f]{6});/.exec(tokensCss)?.[1];
    expect(ground).toBe("#010203");
    expect(mainWindowTs).toContain(`backgroundColor: "${ground ?? ""}"`);
    expect(mainWindowTs).not.toContain("nativeTheme");
  });

  it("sets the stage type in ink", () => {
    // docs/design/H3-DESKTOP.md section 2.1: every type on the stage is the
    // ink and the blue never sits on dark ground as type.
    expect(chronosBlock).toContain("--vex-alias-gate-counter: var(--color-h3-ink)");
    expect(chronosBlock).toContain("--vex-alias-title: var(--color-h3-ink)");
    expect(chronosBlock).toContain("--vex-alias-label-primary: var(--color-h3-ink)");
    // The pre-shell field alias is a cell, a control at rest: never a white
    // field on the stage.
    expect(chronosBlock).toContain("--vex-alias-gate-field: var(--color-h3-cell)");
    // Every pre-shell alias reaches the H3 tier or white at an alpha, never
    // an R3 primitive.
    const r3 = [...declarations(chronosBlock)]
      .filter(([name]) => name.startsWith("--vex-alias-gate-"))
      .filter(([, value]) => /var\(--color-(?:night|night-0|night-1|night-2|paper|peri|peri-hi|type-2|type-3|blue|blue-hi)\)|rgba\(243, 244, 247|rgba\(163, 171, 255/.test(value))
      .map(([name]) => name);
    expect(r3).toEqual([]);
    // Every rule that sets the stage's titles reads the ink alias, never a
    // literal colour: the frame's title cell, the wizard's step title and the
    // unlock's reset panel.
    for (const [sheet, selector] of [
      [stageCss, ".vex-pre"],
      [wizardCss, ".vex-wzp__title"],
      [stageCss, ".vex-unl__panel-title"],
    ] as const) {
      const body = ruleBody(sheet, selector);
      expect(body, selector).toContain("color: var(--vex-alias-label-primary);");
      expect(body, selector).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(/i);
    }
    // The R3 plate, its print and its giant counter are gone from the stage.
    expect(stripComments(gateCss)).not.toMatch(/\.vex-stage-(?:plate__|counter|title|leaf|side)/);
    expect(chronosBlock).toContain("--vex-alias-accent-primary: var(--color-h3-ink)");
  });

  it("keeps the native title bar overlay on the ground and its ink, for every theme the schema names", () => {
    // main/windows/chrome-options.ts cannot read tokens.css (main process), so
    // it carries the overlay colours as constants; they must stay the room's
    // own ground and ink, or the window controls sit on a strip of another
    // colour. The schema's second theme takes the same dark pair: the app is
    // dark only, so no value the IPC accepts can paint a light caption.
    const pair = /DARK_OVERLAY\s*=\s*\{\s*color:\s*"(#[0-9a-f]{6})",\s*symbolColor:\s*"(#[0-9a-f]{6})"/i.exec(
      chromeOptionsTs,
    );
    expect(pair, "the overlay colours are not found").not.toBeNull();
    expect((pair?.[1] ?? "").toLowerCase()).toBe("#010203");
    expect((pair?.[2] ?? "").toLowerCase()).toBe("#f3f5f9");
    expect(chromeOptionsTs).toMatch(/celeris:\s*DARK_OVERLAY,\s*chronos:\s*DARK_OVERLAY,/);
    expect(tokensCss).toContain("--color-h3-ground: #010203;");
    expect(tokensCss).toContain("--color-h3-ink: #f3f5f9;");
    expect(chronosBlock).toContain("--vex-alias-bg-base: var(--color-h3-ground)");
    expect(chronosBlock).toContain("--vex-alias-label-primary: var(--color-h3-ink)");
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
  it.each(CODE_THEME_SLOTS)("--vex-alias-code-%s is declared", (slot) => {
    expect(chronosBlock, ":root").toContain(`--vex-alias-code-${slot}:`);
  });

  it("resolves every code token through an alias, never a raw colour", () => {
    for (const match of chronosBlock.matchAll(/--vex-alias-code-[a-z-]+:\s*([^;]+);/g)) {
      const value = (match[1] ?? "").trim();
      expect(value === "transparent" || value.startsWith("var(--vex-alias-")).toBe(true);
    }
  });

  it("speaks one blue and the ink ramp: no status hue reaches the code", () => {
    // V10: no rainbow. A code slot pointed at a state alias would re-import a
    // status meaning (and, before the collapse, a status hue) into syntax.
    for (const match of chronosBlock.matchAll(/--vex-alias-code-[a-z-]+:\s*([^;]+);/g)) {
      expect(match[1]).not.toMatch(/state-/);
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

  it.each(gateAliases)("%s is defined in the room", (alias) => {
    expect(chronosBlock, ":root").toContain(`${alias}:`);
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
    // inks themselves, so no mix may lighten or darken them.
    const gateInk = chronosBlock
      .split("\n")
      .filter((line) => line.includes("--vex-alias-gate-"))
      .join("\n");
    expect(gateInk).not.toMatch(/,\s*(?:white|black)\s*\)/);
    expect(gateInk).not.toMatch(/#fff(?:fff)?\b/i);
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
