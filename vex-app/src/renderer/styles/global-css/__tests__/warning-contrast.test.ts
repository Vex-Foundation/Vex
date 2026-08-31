/**
 * WARNING INK IS READABLE IN BOTH THEMES - a measured contrast contract.
 *
 * The defect this exists for shipped and was reported by the owner: in
 * celeris (light), `--vex-alias-state-warn` was simply never declared in the
 * theme block, so the light room inherited the chronos amber-500 #febc2e and
 * every `text-warning` in the app - 57 call sites, Studio included - painted
 * at 1.69:1 on white. Nothing caught it. `theme-matrix.test.ts` proves an
 * alias EXISTS in both blocks, `terminal-palette-tokens.test.ts` proves the
 * ANSI slots differ between themes, and neither can see a colour that is
 * present, valid, on-brand and invisible.
 *
 * So this test measures instead of pinning. It reads tokens.css, resolves the
 * warning ink and its two real backdrops through the static ramp in EACH
 * theme, and computes the WCAG 2.x contrast ratio. The floor is 4.5:1, the
 * normal-body-text level: these tokens carry sentences (`text-warning` on a
 * 12px status line), not decoration.
 *
 * TWO surfaces, because passing one proves little. Warning ink lands on the
 * page ground (`--color-surface-base`) and inside the warning wash
 * (`bg-warning-wash` + `text-warning`), and the wash is the BINDING one: it
 * moves the backdrop toward the ink, so an amber that clears white by a
 * comfortable margin can still fail against its own wash. #9a6700 is the
 * worked example - 4.87:1 on white, 4.41:1 on the celeris wash.
 *
 * Deliberately OUT of scope: the sixteen `--vex-alias-term-*` ANSI slots.
 * Those are a wire contract with programs emitting SGR 33/93, not brand ink;
 * yellow and bright-yellow must stay distinguishable FROM EACH OTHER, and
 * forcing the bright variant to 4.5:1 would collapse it onto the base one.
 * `terminal-palette-tokens.test.ts` owns that family.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const tokensCss = readFileSync(path.join(here, "..", "tokens.css"), "utf8");

function ruleBody(css: string, selector: string): string {
  const at = css.indexOf(`${selector} {`);
  expect(at, `selector "${selector}" not found`).toBeGreaterThanOrEqual(0);
  const open = css.indexOf("{", at);
  const close = css.indexOf("\n}", open);
  return css.slice(open + 1, close);
}

/** The static tier: `--color-amber-800: #8f6108;` and friends. */
const staticTier = ruleBody(tokensCss, "@theme");
const chronos = ruleBody(tokensCss, ":root");
const celeris = ruleBody(tokensCss, '[data-vex-theme="celeris"]');

/** Themes in cascade order: celeris overrides :root, and inherits what it omits. */
const THEMES = [
  { name: "chronos", blocks: [chronos] },
  { name: "celeris", blocks: [chronos, celeris] },
] as const;

function declaredValue(body: string, token: string): string | undefined {
  const match = new RegExp(`${token}:\\s*([^;]+);`).exec(body);
  return match?.[1]?.trim();
}

/**
 * Resolve an alias to a concrete hex the way the cascade would: later blocks
 * win, and a `var(--color-*)` hop lands in the theme-neutral static tier.
 * Throws rather than guessing - an unresolvable token is a defect in the sheet,
 * and a silent fallback here would be the same class of blindness this file
 * exists to end.
 */
function resolveHex(blocks: readonly string[], token: string): string {
  let value: string | undefined;
  for (const block of blocks) value = declaredValue(block, token) ?? value;
  if (value === undefined) throw new Error(`${token} is declared in no theme block`);

  const hop = /^var\((--[a-z0-9-]+)\)$/.exec(value);
  if (hop) {
    const name = hop[1] as string;
    const primitive = declaredValue(staticTier, name);
    if (primitive === undefined) {
      // Not a static primitive: another alias, so keep walking the theme blocks.
      return resolveHex(blocks, name);
    }
    value = primitive.trim();
  }
  if (!/^#[0-9a-f]{6}$/i.test(value)) {
    throw new Error(`${token} resolved to "${value}", which is not a plain hex`);
  }
  return value.toLowerCase();
}

/** WCAG 2.x relative luminance (sRGB). */
function luminance(hex: string): number {
  const channel = (byte: number): number => {
    const c = byte / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const [r, g, b] = [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16));
  return (
    0.2126 * channel(r as number) +
    0.7152 * channel(g as number) +
    0.0722 * channel(b as number)
  );
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((hi as number) + 0.05) / ((lo as number) + 0.05);
}

/** Normal-body-text floor. These tokens carry sentences, not decoration. */
const AA_BODY = 4.5;

/** Both warning ink tokens: `text-warning` and `text-warning-label` alike. */
const WARNING_INK = [
  "--vex-alias-state-warn",
  "--vex-alias-state-warn-label",
] as const;

describe("warning ink contrast", () => {
  it("resolves the ramp it is measuring (the resolver is load-bearing)", () => {
    // If resolution silently degraded, every ratio below would be measured
    // against the wrong colour and still pass.
    expect(resolveHex([chronos], "--vex-alias-state-warn")).toBe("#febc2e");
    expect(resolveHex([chronos, celeris], "--vex-alias-state-warn")).toBe("#8f6108");
    expect(resolveHex([chronos, celeris], "--vex-alias-bg-base")).toBe("#ffffff");
  });

  for (const theme of THEMES) {
    for (const ink of WARNING_INK) {
      it(`${theme.name}: ${ink} clears ${AA_BODY}:1 on the page ground`, () => {
        const ratio = contrast(
          resolveHex(theme.blocks, ink),
          resolveHex(theme.blocks, "--vex-alias-bg-base"),
        );
        expect(
          Number(ratio.toFixed(2)),
          `${ink} on --vex-alias-bg-base in ${theme.name}`,
        ).toBeGreaterThanOrEqual(AA_BODY);
      });

      it(`${theme.name}: ${ink} clears ${AA_BODY}:1 inside its own wash`, () => {
        // `bg-warning-wash` + `text-warning` is a real pairing (the Studio
        // file-viewer and workspace notice strips), and the wash is the
        // surface that binds: it moves the backdrop toward the ink.
        const ratio = contrast(
          resolveHex(theme.blocks, ink),
          resolveHex(theme.blocks, "--vex-alias-state-warn-wash"),
        );
        expect(
          Number(ratio.toFixed(2)),
          `${ink} on --vex-alias-state-warn-wash in ${theme.name}`,
        ).toBeGreaterThanOrEqual(AA_BODY);
      });
    }
  }

  it("keeps celeris warning ink DARKER than its wash, never lighter", () => {
    // Direction, not just magnitude: a wash darker than its own ink would
    // satisfy the ratio while inverting the light theme's whole logic.
    const ink = luminance(resolveHex([chronos, celeris], "--vex-alias-state-warn-label"));
    const wash = luminance(resolveHex([chronos, celeris], "--vex-alias-state-warn-wash"));
    const ground = luminance(resolveHex([chronos, celeris], "--vex-alias-bg-base"));
    expect(ink).toBeLessThan(wash);
    expect(wash).toBeLessThan(ground);
  });
});
