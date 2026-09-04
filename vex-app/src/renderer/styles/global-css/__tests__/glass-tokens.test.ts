/**
 * THE GLASS TIERS - a token and class contract, tested as CSS TEXT.
 *
 * jsdom resolves no cascade and no backdrop-filter, so nothing here can be
 * proven by rendering a component: the invariants live in three stylesheets
 * (shell.css declares the tokens, glass.css the classes, indicators.css the
 * disclosure body motion) and are exactly the kind that drift silently. The
 * shape follows terminal-palette-tokens.test.ts: read the sheets, slice the
 * rule bodies, assert the contract.
 *
 * What can break silently, and is pinned:
 *
 *  1. a tint or edge declared in one theme block and not the other, so a
 *     surface renders with no fill in one theme only;
 *  2. blur or saturation restated per theme, so the two themes drift apart in
 *     depth (geometry is theme-invariant by contract);
 *  3. the coverage order chip < rail < card < pane < overlay inverted by a
 *     retune, so a chip inside a rail reads denser than a terminal pane;
 *  4. a `border` slipping into a glass rule - the boxed look the owner
 *     rejected, one declaration away;
 *  5. a filtering tier nested in a filtering tier without the guard that
 *     strips the inner filter (a double GPU pass over the same pixels) - the
 *     one nesting that is the DESIGN, a card inside a rail, included;
 *  6. the @supports fallback losing a tint or losing the celeris selector
 *     (which would let shell.css's more specific celeris block out-rank it);
 *  7. glass.css imported before shell.css, or with layer(...), so the tokens
 *     it consumes are not in scope or Tailwind utilities beat it;
 *  8. a compatibility alias outliving its last consumer (dead-code decree:
 *     when this fails, delete the alias in shell.css), or an alias that no
 *     longer points at the tier it stands in for;
 *  9. a duration or curve spelled in glass.css instead of taken from tokens.css
 *     (motion-tokens.test.ts sweeps a fixed list of sheets, so the new sheet
 *     states its own membership of the family here).
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const stylesDir = path.join(here, "..", "..");
const rendererDir = path.join(stylesDir, "..");
const read = (name: string): string =>
  readFileSync(path.join(here, "..", name), "utf8");

const shellCss = read("shell.css");
const glassCss = read("glass.css");
const indicatorsCss = read("ui-primitives/indicators.css");
const globalsCss = readFileSync(path.join(stylesDir, "globals.css"), "utf8");

/** Strip block comments so a token NAMED in prose is not read as a rule. */
function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

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
  // Multi-line values (a box-shadow list) collapse to one space, as the
  // reference's declarations() helper does.
  return new RegExp(`(?:^|[\\s;])${property}:\\s*([^;]+);`)
    .exec(body)?.[1]
    ?.trim()
    .replace(/\s+/g, " ");
}

function declaredGlassTokens(body: string): string[] {
  return [
    ...new Set(
      // The tier vocabulary only; the --vex-glass-strong alias is a separate
      // contract, checked in the compatibility block below.
      [...body.matchAll(/(--vex-glass-(?:tint|edge|blur|saturate)[a-z-]*)\s*:/g)].map(
        (match) => match[1] as string,
      ),
    ),
  ].sort();
}

/** The alpha channel of an `rgba(r, g, b, a)` literal. */
function alphaOf(value: string | undefined, label: string): number {
  const match = /^rgba\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*(0?\.\d+|1|0)\s*\)$/.exec(value ?? "");
  expect(match, `${label} is not an rgba literal (got ${String(value)})`).not.toBeNull();
  return Number(match?.[1]);
}

const chronos = ruleBody(shellCss, '[data-vex-shell="true"]');
const celeris = ruleBody(shellCss, '[data-vex-shell="true"][data-vex-theme="celeris"]');

/** The tiers, in coverage order; the classes and tint tokens share the names. */
const TIERS = ["chip", "rail", "card", "pane", "overlay"] as const;
/**
 * The tiers that carry a backdrop-filter; the chip is a plate by contract.
 * In the order the nesting guard lists them, which the guard test replays.
 */
const FILTERING_TIERS = ["rail", "card", "pane", "overlay"] as const;

const PER_THEME_TOKENS = [
  ...TIERS.map((tier) => `--vex-glass-tint-${tier}`),
  "--vex-glass-edge",
  "--vex-glass-edge-ring",
].sort();

const INVARIANT_TOKENS = [
  ...FILTERING_TIERS.map((tier) => `--vex-glass-blur-${tier}`),
  "--vex-glass-saturate",
].sort();

describe("glass tokens (shell.css)", () => {
  it("declares every per-theme token in BOTH theme blocks", () => {
    for (const token of PER_THEME_TOKENS) {
      expect(chronos, `${token} missing from chronos`).toContain(`${token}:`);
      expect(celeris, `${token} missing from celeris`).toContain(`${token}:`);
    }
  });

  it("declares geometry (blur, saturation) once, in the chronos block only", () => {
    // A per-theme blur would let the two themes drift apart in depth; the
    // celeris block may restate veils and edge light, never geometry.
    for (const token of INVARIANT_TOKENS) {
      expect(chronos, `${token} missing`).toContain(`${token}:`);
      expect(celeris, `${token} must not be overridden per theme`).not.toContain(`${token}:`);
    }
    expect(declaredGlassTokens(chronos)).toEqual([...PER_THEME_TOKENS, ...INVARIANT_TOKENS].sort());
    expect(declaredGlassTokens(celeris)).toEqual(PER_THEME_TOKENS);
  });

  it("has no chip blur: a chip is nested by definition and never filters", () => {
    expect(shellCss).not.toContain("--vex-glass-blur-chip");
    expect(glassCss).not.toContain("--vex-glass-blur-chip");
  });

  it.each([
    ["chronos", chronos],
    ["celeris", celeris],
  ])("keeps the coverage order chip < rail < card < pane < overlay (%s)", (theme, body) => {
    const alphas = TIERS.map((tier) =>
      alphaOf(declarationValue(body, `--vex-glass-tint-${tier}`), `${theme} ${tier}`),
    );
    for (let index = 1; index < alphas.length; index += 1) {
      expect(
        alphas[index],
        `${theme}: ${TIERS[index]} must cover more than ${TIERS[index - 1]}`,
      ).toBeGreaterThan(alphas[index - 1] as number);
    }
  });

  it("keeps the rail veil at the owner-approved 0.55 / 0.6 so the shipped rails do not move", () => {
    expect(alphaOf(declarationValue(chronos, "--vex-glass-tint-rail"), "chronos rail")).toBe(0.55);
    expect(alphaOf(declarationValue(celeris, "--vex-glass-tint-rail"), "celeris rail")).toBe(0.6);
    // Parity with the `backdrop-blur-xl` the rails wore before the classes.
    expect(declarationValue(chronos, "--vex-glass-blur-rail")).toBe("24px");
  });

  it("spells the edge light as INSET box-shadow layers, never a border", () => {
    for (const [theme, body] of [["chronos", chronos], ["celeris", celeris]] as const) {
      for (const token of ["--vex-glass-edge", "--vex-glass-edge-ring"]) {
        const value = declarationValue(body, token);
        expect(value, `${theme} ${token}`).toMatch(/^inset 0 (1px 0 0|0 0 1px) rgba\(/);
      }
    }
  });
});

describe("the wall's veil (shell.css)", () => {
  // The veil under every tier is part of what the glass shows of the
  // artwork: 0.8 white under a 0.72 pane left 5.6% of the day artwork, a flat
  // card (owner review 2026-09-04). The densities are tokens so a theme and a
  // mode can repoint them; these pins keep the stage semantics.
  const idle = Number(declarationValue(chronos, "--vex-backdrop-veil-idle"));
  const dim = Number(declarationValue(chronos, "--vex-backdrop-veil-dim"));
  const celerisStudio = ruleBody(
    shellCss,
    '[data-vex-shell="true"][data-vex-theme="celeris"][data-vex-runtime-mode="studio"]',
  );
  const celerisStudioDim = Number(declarationValue(celerisStudio, "--vex-backdrop-veil-dim"));

  it("declares both densities once on the shell root, idle lighter than dimmed", () => {
    expect(idle).toBeGreaterThan(0);
    expect(dim).toBeLessThanOrEqual(1);
    expect(idle).toBeLessThan(dim);
    // The Agent transcript reads straight off the wall in both themes, so
    // the celeris THEME block does not lighten the dim; only Studio does.
    expect(declarationValue(celeris, "--vex-backdrop-veil-dim")).toBeUndefined();
    expect(declarationValue(celeris, "--vex-backdrop-veil-idle")).toBeUndefined();
  });

  it("dims celeris Studio less than the transcript, and still more than the welcome stage", () => {
    expect(celerisStudioDim).toBeLessThan(dim);
    expect(celerisStudioDim).toBeGreaterThan(idle);
    expect(declarationValue(celerisStudio, "--vex-backdrop-veil-idle")).toBeUndefined();
  });

  it("applies the densities off the stage stamp, through the tokens", () => {
    expect(declarationValue(ruleBody(shellCss, ".vex-backdrop-veil"), "opacity")).toBe(
      "var(--vex-backdrop-veil-idle)",
    );
    expect(
      declarationValue(
        ruleBody(shellCss, '[data-vex-backdrop-dimmed="true"] > .vex-backdrop-veil'),
        "opacity",
      ),
    ).toBe("var(--vex-backdrop-veil-dim)");
  });
});

describe("glass classes (glass.css)", () => {
  const filterOf = (tier: string): string =>
    `blur(var(--vex-glass-blur-${tier})) saturate(var(--vex-glass-saturate))`;

  it.each(FILTERING_TIERS)("gives .vex-glass-%s its tint, both filter spellings and edge light", (tier) => {
    const body = ruleBody(glassCss, `.vex-glass-${tier}`);
    expect(declarationValue(body, "background")).toBe(`var(--vex-glass-tint-${tier})`);
    expect(declarationValue(body, "backdrop-filter")).toBe(filterOf(tier));
    expect(declarationValue(body, "-webkit-backdrop-filter")).toBe(filterOf(tier));
    expect(declarationValue(body, "box-shadow")).toContain("var(--vex-glass-edge");
  });

  it("makes the chip a plate: tint and ring, no filter of its own", () => {
    const body = ruleBody(glassCss, ".vex-glass-chip");
    expect(declarationValue(body, "background")).toBe("var(--vex-glass-tint-chip)");
    expect(declarationValue(body, "box-shadow")).toBe("var(--vex-glass-edge-ring)");
    expect(body).not.toContain("backdrop-filter");
  });

  it("carries the card, pane and overlay elevation on the shadow tokens, not literals", () => {
    // The card keeps the lv1 it had as a solid card; the pane its lv2.
    expect(declarationValue(ruleBody(glassCss, ".vex-glass-card"), "box-shadow")).toBe(
      "var(--vex-glass-edge), var(--vex-glass-edge-ring), var(--shadow-lv1)",
    );
    expect(declarationValue(ruleBody(glassCss, ".vex-glass-pane"), "box-shadow")).toBe(
      "var(--vex-glass-edge), var(--vex-glass-edge-ring), var(--shadow-lv2)",
    );
    expect(declarationValue(ruleBody(glassCss, ".vex-glass-overlay"), "box-shadow")).toBe(
      "var(--vex-glass-edge), var(--shadow-lv3)",
    );
  });

  it("declares no border anywhere in the sheet: edge light replaces strokes", () => {
    // `border-radius` is geometry, not a stroke; every other border-* is a
    // separating line and is what the owner rejected.
    const declarations = stripComments(glassCss).match(/(?:^|[\s;{])border(?!-radius)[a-z-]*\s*:/gm);
    expect(declarations).toBeNull();
  });

  it("strips the inner filter of every filtering tier nested in a filtering tier", () => {
    const guard = stripComments(glassCss);
    const pairs = FILTERING_TIERS.flatMap((outer) =>
      FILTERING_TIERS.map((inner) => `.vex-glass-${outer} .vex-glass-${inner}`),
    );
    // One rule lists all sixteen ordered pairs and declares both spellings
    // none. `.vex-glass-rail .vex-glass-card` is among them, and it is the
    // BOOK rail's design: the rail blurs once, its cards are plates.
    const rule = new RegExp(
      `${pairs.map((pair) => pair.replace(/\./g, "\\.")).join(",\\s*")}\\s*\\{([^}]*)\\}`,
    ).exec(guard);
    expect(rule, "nesting guard rule with all sixteen ordered pairs").not.toBeNull();
    const body = rule?.[1] ?? "";
    expect(declarationValue(body, "backdrop-filter")).toBe("none");
    expect(declarationValue(body, "-webkit-backdrop-filter")).toBe("none");
  });

  it("raises every tint to an opaque surface where backdrop-filter is unsupported, in both themes", () => {
    const source = stripComments(glassCss);
    const at = source.indexOf(
      "@supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px)))",
    );
    expect(at, "@supports fallback block").toBeGreaterThanOrEqual(0);
    const block = source.slice(at);
    // Both selectors, so shell.css's (0,2,0) celeris block cannot win.
    expect(block).toMatch(
      /\[data-vex-shell="true"\],\s*\[data-vex-shell="true"\]\[data-vex-theme="celeris"\]\s*\{/,
    );
    for (const tier of TIERS) {
      const value = declarationValue(block, `--vex-glass-tint-${tier}`);
      expect(value, `${tier} fallback`).toMatch(/^var\(--vex-surface-[12]\)$/);
    }
    // A chip or a card on a rail of the same fill would vanish; both take
    // the raised step.
    expect(declarationValue(block, "--vex-glass-tint-rail")).toBe("var(--vex-surface-1)");
    expect(declarationValue(block, "--vex-glass-tint-chip")).toBe("var(--vex-surface-2)");
    expect(declarationValue(block, "--vex-glass-tint-card")).toBe("var(--vex-surface-2)");
  });

  it("gives the tab shell its chip/pane fills, top radius and a token transition", () => {
    const rest = ruleBody(glassCss, ".vex-tab-shell");
    expect(declarationValue(rest, "background")).toBe("var(--vex-glass-tint-chip)");
    expect(declarationValue(rest, "border-radius")).toBe("8px 8px 0 0");
    expect(declarationValue(rest, "transition")).toBe(
      "background-color var(--vex-duration-fast) var(--vex-ease-standard)",
    );
    const active = ruleBody(glassCss, ".vex-tab-shell[data-active]");
    expect(declarationValue(active, "background")).toBe("var(--vex-glass-tint-pane)");
    expect(declarationValue(active, "box-shadow")).toBe("var(--vex-glass-edge)");
    const reduced = glassCss.slice(glassCss.indexOf("@media (prefers-reduced-motion: reduce)"));
    expect(reduced).toContain(".vex-tab-shell");
  });

  it("takes every duration and curve from tokens.css", () => {
    const source = stripComments(glassCss);
    expect(source).not.toContain("cubic-bezier(");
    expect(source).not.toMatch(/^\s*--vex-(duration|ease)-/m);
    expect(source).not.toMatch(/\b\d+m?s\b/);
  });

  it("is imported right after shell.css, as a plain unlayered @import", () => {
    const imports = globalsCss
      .split("\n")
      .filter((line) => line.startsWith("@import"))
      .map((line) => line.trim());
    const shellAt = imports.indexOf('@import "./global-css/shell.css";');
    expect(shellAt).toBeGreaterThanOrEqual(0);
    expect(imports[shellAt + 1]).toBe('@import "./global-css/glass.css";');
  });
});

describe("compatibility aliases", () => {
  /**
   * Every `var(--x)` read in the renderer's PRODUCTION tree, outside
   * shell.css. Test files are not consumers: a spec that asserts a class
   * is GONE spells the alias as text (StudioSidebar.test.tsx pins
   * `bg-[var(--vex-rail)]` absent), and counting that would keep a dead
   * alias alive.
   */
  function consumersOf(alias: string): string[] {
    const hits: string[] = [];
    const needle = `var(${alias})`;
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const full = path.join(dir, entry);
        if (statSync(full).isDirectory()) {
          if (entry !== "__tests__") walk(full);
          continue;
        }
        if (!/\.(tsx?|css)$/.test(entry)) continue;
        if (full.endsWith(`global-css${path.sep}shell.css`)) continue;
        if (readFileSync(full, "utf8").includes(needle)) hits.push(path.relative(rendererDir, full));
      }
    };
    walk(rendererDir);
    return hits.sort();
  }

  it.each(["--vex-glass", "--vex-rail"])(
    "has deleted %s, which had no consumer left",
    (alias) => {
      expect(declarationValue(chronos, alias)).toBeUndefined();
      expect(declarationValue(celeris, alias)).toBeUndefined();
      expect(consumersOf(alias)).toEqual([]);
    },
  );

  it.each(["--vex-rail-strong", "--vex-glass-strong"])(
    "keeps %s only while a consumer still reads it (delete the alias when this fails)",
    (alias) => {
      expect(declarationValue(chronos, alias), `${alias} alias in chronos`).toBeDefined();
      expect(
        consumersOf(alias),
        `${alias} has no var() consumer left: delete it from shell.css (dead-code decree)`,
      ).not.toEqual([]);
    },
  );

  it("points the surviving aliases at the tier they stand in for", () => {
    expect(declarationValue(chronos, "--vex-glass-strong")).toBe("var(--vex-glass-tint-overlay)");
    // No tier equals 0.7, so this one keeps its literal in both themes until
    // its two consumers move (SidebarProfile foot, WelcomePortfolioPanel button).
    expect(alphaOf(declarationValue(chronos, "--vex-rail-strong"), "chronos rail-strong")).toBe(0.7);
    expect(alphaOf(declarationValue(celeris, "--vex-rail-strong"), "celeris rail-strong")).toBe(0.78);
    expect(declarationValue(celeris, "--vex-glass-strong")).toBeUndefined();
  });
});

describe("disclosure body motion (indicators.css)", () => {
  it("mounts the revealed body on the base duration, opacity only, with a reduced-motion collapse", () => {
    const body = ruleBody(indicatorsCss, ".vex-disclosure-body");
    expect(declarationValue(body, "animation")).toBe(
      "vex-disclosure-row-in var(--vex-duration-base) var(--vex-ease-standard)",
    );
    const source = stripComments(indicatorsCss);
    const keyframes = /@keyframes vex-disclosure-row-in\s*\{([\s\S]*?)\n\}/.exec(source);
    expect(keyframes).not.toBeNull();
    const frames = keyframes?.[1] ?? "";
    expect(frames).toContain("opacity: 0;");
    // The reference animates no heights and no offsets on a row reveal.
    expect(frames).not.toMatch(/\b(width|height|margin|padding|transform):/);
    const reducedBlocks = [...source.matchAll(/@media \(prefers-reduced-motion: reduce\)\s*\{([^}]*\}[^}]*)\}/g)]
      .map((match) => match[1] ?? "");
    const covering = reducedBlocks.find((block) => block.includes(".vex-disclosure-body"));
    expect(covering, "reduced-motion block naming .vex-disclosure-body").toBeDefined();
    expect(covering).toContain("animation: none;");
  });
});
