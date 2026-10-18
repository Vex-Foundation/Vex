/**
 * NO GLASS, NO BLUR, NO SHADOW, RADIUS 0 - the surface law
 * (docs/design/R3-MINIMAL.md, rules), tested as CSS TEXT.
 *
 * jsdom resolves no cascade and no backdrop-filter, so nothing here can be
 * proven by rendering a component: the invariants live in the stylesheets
 * and are exactly the kind that drift silently. What is pinned:
 *
 *  1. the glass is GONE: the neutralised tier sheet (glass.css) is deleted
 *     and no longer imported, no sheet declares a `.vex-glass-*` class or a
 *     `--vex-glass-*` token, and no renderer source wears a glass class;
 *  2. no stylesheet in the renderer declares a backdrop-filter;
 *  3. the shape law: base.css squares every element with one `!important`
 *     rule, the radius tokens are 0, the shadow tokens are transparent, and
 *     Tailwind's default radius, shadow and blur scales are reset;
 *  4. the Vex sidebar's print window shows the print as it is;
 *  5. a compatibility alias outliving its last consumer (dead-code decree:
 *     when this fails, delete the alias in shell.css).
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const globalCssDir = path.join(here, "..");
const stylesDir = path.join(globalCssDir, "..");
const rendererDir = path.join(stylesDir, "..");
const read = (name: string): string => readFileSync(path.join(globalCssDir, name), "utf8");

const shellCss = read("shell.css");
const vexSidebarCss = read("vex-sidebar.css");
const baseCss = read("base.css");
const tokensCss = read("tokens.css");
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
  // Multi-line values collapse to one space.
  return new RegExp(`(?:^|[\\s;])${property}:\\s*([^;]+);`)
    .exec(body)?.[1]
    ?.trim()
    .replace(/\s+/g, " ");
}

/** Every stylesheet under global-css, recursively, as [relative name, text]. */
function allSheets(): (readonly [string, string])[] {
  const sheets: (readonly [string, string])[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) {
        if (entry !== "__tests__") walk(full);
        continue;
      }
      if (entry.endsWith(".css")) {
        sheets.push([path.relative(globalCssDir, full), readFileSync(full, "utf8")] as const);
      }
    }
  };
  walk(globalCssDir);
  return sheets;
}

const shell = ruleBody(shellCss, '[data-vex-shell="true"]');

/** Every non-test TypeScript source under the renderer, as [relative name, text]. */
function rendererSources(): (readonly [string, string])[] {
  const sources: (readonly [string, string])[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) {
        if (entry !== "__tests__" && entry !== "node_modules") walk(full);
        continue;
      }
      if (/\.tsx?$/.test(entry)) {
        sources.push([path.relative(rendererDir, full), readFileSync(full, "utf8")] as const);
      }
    }
  };
  walk(rendererDir);
  return sources;
}

describe("the glass, retired", () => {
  it("has deleted the tier sheet and dropped its import", () => {
    expect(existsSync(path.join(globalCssDir, "glass.css"))).toBe(false);
    const imports = globalsCss
      .split("\n")
      .filter((line) => line.startsWith("@import"))
      .map((line) => line.trim());
    expect(imports.filter((line) => line.includes("glass"))).toEqual([]);
    // shell.css, which held the tier tokens, stays a plain unlayered import.
    expect(imports).toContain('@import "./global-css/shell.css";');
  });

  it("declares no glass class and no glass token in any sheet", () => {
    const offenders = allSheets().flatMap(([name, css]) => {
      const source = stripComments(css);
      const hits: string[] = [];
      if (/\.vex-glass-[a-z]/.test(source)) hits.push(`${name}: .vex-glass-* class`);
      if (/--vex-glass\b/.test(source)) hits.push(`${name}: --vex-glass* token`);
      return hits;
    });
    expect(offenders).toEqual([]);
  });

  it("puts no glass class on any renderer source", () => {
    const offenders = rendererSources()
      .filter(([, source]) => /\bvex-glass-(?:rail|card|pane|chip|overlay)\b/.test(source))
      .map(([name]) => name);
    expect(offenders).toEqual([]);
  });
});

describe("no backdrop filter in any sheet", () => {
  it("declares no backdrop-filter outside a `none`", () => {
    const offenders = allSheets()
      .flatMap(([name, css]) =>
        [...stripComments(css).matchAll(/backdrop-filter:\s*([^;]+);/g)]
          .filter((match) => match[1]?.trim() !== "none")
          .map((match) => `${name}: ${match[0]}`),
      );
    expect(offenders).toEqual([]);
  });

  it("has retired the mask blur token", () => {
    expect(tokensCss).not.toContain("--vex-mask-blur");
    for (const [name, css] of allSheets()) {
      expect(css, name).not.toContain("var(--vex-mask-blur)");
    }
  });
});

describe("the shape law", () => {
  it("squares every element, pseudo-element and scrollbar part in base.css", () => {
    const source = stripComments(baseCss);
    const rule = /([^{}]+)\{\s*border-radius:\s*0 !important;\s*\}/.exec(source);
    expect(rule, "base.css radius law").not.toBeNull();
    const selectors = (rule?.[1] ?? "").split(",").map((s) => s.trim());
    for (const selector of [
      "*",
      "*::before",
      "*::after",
      "::backdrop",
      "::-webkit-scrollbar-thumb",
      "::-webkit-scrollbar-track",
      "::-webkit-scrollbar-corner",
    ]) {
      expect(selectors).toContain(selector);
    }
  });

  it("resets Tailwind's radius, shadow and blur scales, and zeroes the app's own names", () => {
    const theme = stripComments(tokensCss.slice(tokensCss.indexOf("@theme {")));
    for (const reset of ["--radius-*: initial;", "--shadow-*: initial;", "--blur-*: initial;"]) {
      expect(theme).toContain(reset);
    }
    for (const token of ["--radius-sm", "--radius-md", "--radius-lg", "--radius-capsule"]) {
      expect(declarationValue(theme, token)).toBe("0px");
    }
    for (const token of ["--shadow-lv1", "--shadow-lv2", "--shadow-lv3"]) {
      // A transparent zero shadow stays valid inside Tailwind's composed
      // box-shadow list, where `none` would void the whole declaration.
      expect(declarationValue(theme, token)).toBe("0 0 #0000");
    }
  });
});

describe("the Vex sidebar's print window (vex-sidebar.css)", () => {
  it("shows the print as it is: no veil, no filter, no motion over it", () => {
    const shell = stripComments(shellCss);
    // The full-window wall and its veil are gone, and so is the left page's
    // print: the print lives in the Vex sidebar's plate only, and nothing
    // dims it.
    expect(shell).not.toMatch(/vex-backdrop-(veil|drift|chronos|celeris)/);
    expect(shell).not.toContain("data-vex-backdrop-dimmed");
    expect(shell).not.toContain(".vex-print");
    for (const selector of [".vex-vs-plate", ".vex-vs-plate__img", ".vex-vs-plate__grain"]) {
      const body = ruleBody(vexSidebarCss, selector);
      expect(body, selector).not.toMatch(/(?:^|[\s;])(filter|backdrop-filter|animation|transition):/);
    }
  });

  it("cuts the print into the plate at the sidebar's focal point", () => {
    const body = ruleBody(vexSidebarCss, ".vex-vs-plate__img");
    expect(declarationValue(body, "width")).toBe("100%");
    expect(declarationValue(body, "height")).toBe("100%");
    expect(declarationValue(body, "object-fit")).toBe("cover");
    expect(declarationValue(body, "object-position")).toBe("50% 82%");
    // The user's own image is shown as it is, centred.
    expect(
      declarationValue(ruleBody(vexSidebarCss, ".vex-vs-plate__img--custom"), "object-position"),
    ).toBe("50% 50%");
  });

  it("keeps the plate 280 high, 220 at the least in a low window", () => {
    expect(declarationValue(ruleBody(vexSidebarCss, ".vex-vs-plate"), "height")).toBe(
      "clamp(220px, calc(24.4vh + 60px), 280px)",
    );
  });

  it("swaps the day and night prints on the theme attribute", () => {
    expect(declarationValue(ruleBody(vexSidebarCss, ".vex-vs-plate__img--day"), "display")).toBe(
      "none",
    );
    expect(
      declarationValue(
        ruleBody(vexSidebarCss, '[data-vex-theme="celeris"] .vex-vs-plate__img--day'),
        "display",
      ),
    ).toBe("block");
    expect(
      declarationValue(
        ruleBody(vexSidebarCss, '[data-vex-theme="celeris"] .vex-vs-plate__img--night'),
        "display",
      ),
    ).toBe("none");
  });
});

describe("compatibility aliases", () => {
  /**
   * Every `var(--x)` read in the renderer's PRODUCTION tree, outside
   * shell.css. Test files are not consumers.
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

  it.each(["--vex-glass-strong", "--vex-glass-tint-overlay"])(
    "has deleted %s: the overlay sheet paints its own paper",
    (alias) => {
      expect(declarationValue(shell, alias)).toBeUndefined();
      expect(consumersOf(alias)).toEqual([]);
    },
  );

  it.each([
    "--vex-glass",
    "--vex-rail",
    "--vex-rail-strong",
    "--vex-glass-tint-chip",
    "--vex-glass-tint-rail",
    "--vex-glass-tint-card",
    "--vex-glass-tint-pane",
    "--vex-glass-rule",
  ])(
    "has deleted %s, which had no consumer left",
    (alias) => {
      expect(declarationValue(shell, alias)).toBeUndefined();
      expect(consumersOf(alias)).toEqual([]);
    },
  );

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
    expect(frames).not.toMatch(/\b(width|height|margin|padding|transform):/);
    const reducedBlocks = [...source.matchAll(/@media \(prefers-reduced-motion: reduce\)\s*\{([^}]*\}[^}]*)\}/g)]
      .map((match) => match[1] ?? "");
    const covering = reducedBlocks.find((block) => block.includes(".vex-disclosure-body"));
    expect(covering, "reduced-motion block naming .vex-disclosure-body").toBeDefined();
    expect(covering).toContain("animation: none;");
  });
});
