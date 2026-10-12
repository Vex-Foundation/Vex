/**
 * STATUS IS SHOWN BY FILL, AND EVERY INK IS READABLE - a measured contrast
 * contract over the V10 alias tier, in both themes.
 *
 * V10 collapses status to fill: success and error are the ink (paper at
 * night), attention is the one blue (the periwinkle at night), and the state
 * itself is carried by a swatch's pattern, never by a hue. That collapse is
 * pinned here as an identity, so a green, amber or red cannot creep back in
 * under an old alias name.
 *
 * The rest of the file MEASURES rather than pins. It reads tokens.css,
 * resolves each alias through the static tier in EACH theme, and computes the
 * WCAG 2.x contrast ratio. The floors are V10's: 4.5:1 for anything that
 * carries a sentence or a label, 3:1 for large display (counters). Status inks
 * are measured on the page ground AND inside their own wash, because the wash
 * is the binding surface: it moves the backdrop toward the ink.
 *
 * The reversed chrome plate (tooltip, hover card, toast, connection banner)
 * is measured with its own ink in both themes. The last block leaves the alias
 * tier and measures the one derived colour this contract cannot see from
 * tokens.css alone: the hover plate of the approvals REVIEW key, a
 * `color-mix` in shell.css, whose mix DIRECTION is a per-theme decision no
 * token name enforces.
 *
 * Deliberately OUT of scope: the sixteen `--vex-alias-term-*` ANSI slots, a
 * wire contract owned by `terminal-palette-tokens.test.ts`.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const tokensCss = readFileSync(path.join(here, "..", "tokens.css"), "utf8");
const shellCss = readFileSync(path.join(here, "..", "shell.css"), "utf8");

function ruleBody(css: string, selector: string): string {
  const at = css.indexOf(`${selector} {`);
  expect(at, `selector "${selector}" not found`).toBeGreaterThanOrEqual(0);
  const open = css.indexOf("{", at);
  const close = css.indexOf("\n}", open);
  return css.slice(open + 1, close);
}

/** The static tier: `--color-ink: #0a0d18;` and friends. */
const staticTier = ruleBody(tokensCss, "@theme");
const chronos = ruleBody(tokensCss, ":root");
const celeris = ruleBody(tokensCss, '[data-vex-theme="celeris"]');

/** Themes in cascade order: celeris overrides :root, and inherits what it omits. */
const THEMES = [
  { name: "chronos", blocks: [chronos] },
  { name: "celeris", blocks: [chronos, celeris] },
] as const;

function declaredValue(body: string, token: string): string | undefined {
  const match = new RegExp(`(?:^|[\\s;])${token}:\\s*([^;]+);`).exec(body);
  return match?.[1]?.trim();
}

/**
 * Resolve an alias to a concrete hex the way the cascade would: later blocks
 * win, and a `var(--color-*)` hop lands in the theme-neutral static tier.
 * Throws rather than guessing - an unresolvable token is a defect in the sheet,
 * and a silent fallback here would measure the wrong colour and still pass.
 */
function resolveHex(blocks: readonly string[], token: string): string {
  let value: string | undefined;
  for (const block of blocks) value = declaredValue(block, token) ?? value;
  if (value === undefined) {
    const primitive = declaredValue(staticTier, token);
    if (primitive === undefined) throw new Error(`${token} is declared in no theme block`);
    value = primitive;
  }

  const hop = /^var\((--[a-z0-9-]+)\)$/.exec(value);
  if (hop) return resolveHex(blocks, hop[1] as string);
  if (!/^#[0-9a-f]{6}$/i.test(value)) {
    throw new Error(`${token} resolved to "${value}", which is not a plain hex`);
  }
  return value.toLowerCase();
}

function channels(hex: string): [number, number, number] {
  const [r, g, b] = [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16));
  return [r as number, g as number, b as number];
}

/** sRGB transfer function, both directions - shared by luminance and the mix. */
function toLinear(byte: number): number {
  const c = byte / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function toByte(linear: number): number {
  const c = linear <= 0.0031308 ? 12.92 * linear : 1.055 * linear ** (1 / 2.4) - 0.055;
  return Math.round(Math.min(1, Math.max(0, c)) * 255);
}

/** WCAG 2.x relative luminance (sRGB). */
function luminance(hex: string): number {
  const [r, g, b] = channels(hex).map(toLinear) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((hi as number) + 0.05) / ((lo as number) + 0.05);
}

/**
 * `color-mix(in oklab, a P%, b)` as the browser computes it. Needed only for
 * the shell.css hover plate; both operands are opaque, so no premultiplied
 * alpha. Matrices per the Oklab reference implementation, which is what CSS
 * Color 4 specifies the conversion against.
 */
function toOklab(hex: string): [number, number, number] {
  const [r, g, b] = channels(hex).map(toLinear) as [number, number, number];
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function fromOklab(lab: [number, number, number]): string {
  const [L, a, bb] = lab;
  const l = (L + 0.3963377774 * a + 0.2158037573 * bb) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * bb) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * bb) ** 3;
  const rgb = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
  return `#${rgb.map((c) => toByte(c).toString(16).padStart(2, "0")).join("")}`;
}

function mixOklab(a: string, b: string, percentOfA: number): string {
  const [x, y] = [toOklab(a), toOklab(b)];
  const p = percentOfA / 100;
  return fromOklab([
    (x[0] as number) * p + (y[0] as number) * (1 - p),
    (x[1] as number) * p + (y[1] as number) * (1 - p),
    (x[2] as number) * p + (y[2] as number) * (1 - p),
  ]);
}

/** Normal-size text: every label and sentence. */
const AA_BODY = 4.5;
/** Large text: the serif counters and numerals (24px and up). */
const AA_LARGE = 3;

function ratio(blocks: readonly string[], ink: string, ground: string): number {
  return Number(contrast(resolveHex(blocks, ink), resolveHex(blocks, ground)).toFixed(2));
}

/**
 * Every state family and the aliases that carry TEXT in it. `-warn` and
 * `-warn-label` are both listed because both project to a `text-*` utility.
 */
const FAMILIES = [
  {
    name: "success",
    ink: ["--vex-alias-state-success"],
    wash: "--vex-alias-state-success-wash",
    collapsesTo: "--vex-alias-label-primary",
  },
  {
    name: "warn",
    ink: ["--vex-alias-state-warn", "--vex-alias-state-warn-label"],
    wash: "--vex-alias-state-warn-wash",
    collapsesTo: "--vex-alias-accent-primary",
  },
  {
    name: "error",
    ink: ["--vex-alias-state-error"],
    wash: "--vex-alias-state-error-wash",
    collapsesTo: "--vex-alias-label-primary",
  },
] as const;

describe("the resolver (load-bearing)", () => {
  it("resolves the V10 values it is measuring", () => {
    // If resolution silently degraded, every ratio below would be measured
    // against the wrong colour and still pass.
    expect(resolveHex([chronos], "--vex-alias-bg-base")).toBe("#1b1412");
    expect(resolveHex([chronos], "--vex-alias-state-warn")).toBe("#a3abff");
    expect(resolveHex([chronos], "--vex-alias-state-success")).toBe("#f3f4f7");
    expect(resolveHex([chronos], "--vex-alias-state-error")).toBe("#f3f4f7");
    expect(resolveHex([chronos, celeris], "--vex-alias-bg-base")).toBe("#f3f4f7");
    expect(resolveHex([chronos, celeris], "--vex-alias-state-warn")).toBe("#0000c0");
    expect(resolveHex([chronos, celeris], "--vex-alias-state-success")).toBe("#0a0d18");
    expect(resolveHex([chronos, celeris], "--vex-alias-state-error")).toBe("#0a0d18");
    expect(resolveHex([chronos, celeris], "--vex-alias-composer")).toBe("#ffffff");
  });
});

describe("status by fill, never by colour", () => {
  for (const theme of THEMES) {
    for (const family of FAMILIES) {
      it(`${theme.name}: the ${family.name} inks collapse onto ${family.collapsesTo}`, () => {
        // The identity, not a likeness: done and errors ARE the ink, attention
        // IS the one blue. A status hue would have to break this equality.
        for (const ink of family.ink) {
          expect(resolveHex(theme.blocks, ink), `${ink} in ${theme.name}`).toBe(
            resolveHex(theme.blocks, family.collapsesTo),
          );
        }
      });

      for (const ink of family.ink) {
        it(`${theme.name}: ${ink} clears ${AA_BODY}:1 on the page ground`, () => {
          expect(
            ratio(theme.blocks, ink, "--vex-alias-bg-base"),
            `${ink} on --vex-alias-bg-base in ${theme.name}`,
          ).toBeGreaterThanOrEqual(AA_BODY);
        });

        it(`${theme.name}: ${ink} clears ${AA_BODY}:1 inside the ${family.name} wash`, () => {
          // `bg-*-wash` + `text-*` is a real pairing (the `pill` primitive, the
          // Studio file-viewer and the workspace notice strips).
          expect(
            ratio(theme.blocks, ink, family.wash),
            `${ink} on ${family.wash} in ${theme.name}`,
          ).toBeGreaterThanOrEqual(AA_BODY);
        });
      }

      it(`${theme.name}: the ${family.name} wash sits between its ink and the ground`, () => {
        // Direction, not just magnitude: a wash on the far side of the ground
        // would satisfy the ratio while inverting the theme's whole logic. At
        // night ink is lighter than wash which is lighter than ground; on
        // paper every comparison flips.
        const ink = luminance(resolveHex(theme.blocks, family.ink[0]));
        const wash = luminance(resolveHex(theme.blocks, family.wash));
        const ground = luminance(resolveHex(theme.blocks, "--vex-alias-bg-base"));
        if (theme.name === "celeris") {
          expect(ink).toBeLessThan(wash);
          expect(wash).toBeLessThan(ground);
        } else {
          expect(ink).toBeGreaterThan(wash);
          expect(wash).toBeGreaterThan(ground);
        }
      });
    }
  }
});

/** Every text tier, and the surfaces text actually sits on. */
const TEXT_TIERS = [
  "--vex-alias-label-primary",
  "--vex-alias-label-secondary",
  "--vex-alias-label-tertiary",
  "--vex-alias-label-caption",
  "--vex-alias-accent-primary",
] as const;

const TEXT_GROUNDS = [
  "--vex-alias-bg-base",
  "--vex-alias-bg-deep",
  "--vex-alias-bg-layer-1",
  "--vex-alias-bg-layer-2",
  "--vex-alias-bg-layer-3",
  "--vex-alias-interactive-solid",
  "--vex-alias-accent-wash",
  "--vex-alias-field",
] as const;

describe("every text tier reads on every surface it sits on", () => {
  for (const theme of THEMES) {
    for (const ink of TEXT_TIERS) {
      it(`${theme.name}: ${ink} clears ${AA_BODY}:1 on every surface`, () => {
        // V10 has no unreadable fourth tier: caption is the tertiary step, and
        // even the receding ink must carry an 11px label.
        const failures = TEXT_GROUNDS.map((ground) => [ground, ratio(theme.blocks, ink, ground)] as const)
          .filter(([, value]) => value < AA_BODY)
          .map(([ground, value]) => `${ground} ${value}:1`);
        expect(failures, `${ink} in ${theme.name}`).toEqual([]);
      });
    }

    it(`${theme.name}: the counter and the serif title read as large text on the ground`, () => {
      expect(ratio(theme.blocks, "--vex-alias-counter", "--vex-alias-bg-base")).toBeGreaterThanOrEqual(
        AA_LARGE,
      );
      expect(ratio(theme.blocks, "--vex-alias-title", "--vex-alias-bg-base")).toBeGreaterThanOrEqual(
        AA_BODY,
      );
    });

    it(`${theme.name}: every filled control carries its label at ${AA_BODY}:1`, () => {
      for (const [ink, fill] of [
        ["--vex-alias-label-on-primary", "--vex-alias-button-primary-fill"],
        ["--vex-alias-label-on-primary", "--vex-alias-button-primary-hover"],
        ["--vex-alias-button-accent-ink", "--vex-alias-button-accent-fill"],
        ["--vex-alias-button-accent-ink", "--vex-alias-button-accent-hover"],
        ["--vex-alias-label-on-accent", "--vex-alias-accent-primary"],
        ["--vex-alias-label-on-accent", "--vex-alias-accent-hover"],
        ["--vex-alias-label-on-accent", "--vex-alias-state-error"],
      ] as const) {
        expect(ratio(theme.blocks, ink, fill), `${ink} on ${fill} in ${theme.name}`).toBeGreaterThanOrEqual(
          AA_BODY,
        );
      }
    });

    it(`${theme.name}: the reversed chrome plate carries its own ink at ${AA_BODY}:1`, () => {
      // Tooltip, hover card and toast, and the connection banner, which paints
      // the same ink on the solid error plate. All four read in BOTH rooms now:
      // the banner's old chronos gap (white on a light red, 2.92:1) closed
      // when error became the ink.
      for (const plate of [
        "--vex-alias-tooltip-bg",
        "--vex-alias-toast-bg",
        "--vex-alias-state-error",
      ] as const) {
        expect(
          ratio(theme.blocks, "--vex-alias-label-on-chrome", plate),
          `on-chrome on ${plate} in ${theme.name}`,
        ).toBeGreaterThanOrEqual(AA_BODY);
      }
    });
  }
});

/**
 * The approvals REVIEW key (ApprovalCard/ApprovalDecisionActions.tsx) is a
 * solid `--vex-pin` plate whose label is `--vex-surface-0`. Its hover plate is
 * a `color-mix` declared in shell.css, so no alias name can enforce it: the
 * mix has to move the plate AWAY from the label, which is the opposite
 * direction in each theme.
 */
describe("pin hover plate contrast", () => {
  const shell = ruleBody(shellCss, '[data-vex-shell="true"]');

  /** `85%, var(--vex-alias-label-primary)` - parsed, so a silent edit is caught. */
  function pinHoverMix(): { percent: number; partner: string } {
    const declared = declaredValue(shell, "--vex-pin-hover");
    expect(declared, "--vex-pin-hover must be declared in the shell scope").toBeDefined();
    const parsed =
      /^color-mix\(in oklab,\s*var\(--vex-alias-state-warn\)\s*(\d+)%,\s*var\((--[a-z0-9-]+)\)\)$/.exec(
        declared as string,
      );
    expect(parsed, `--vex-pin-hover has an unexpected shape: ${declared}`).not.toBeNull();
    const [, percent, partner] = parsed as RegExpExecArray;
    return { percent: Number(percent), partner: partner as string };
  }

  for (const theme of THEMES) {
    it(`${theme.name}: the resting REVIEW key carries its label at ${AA_BODY}:1`, () => {
      expect(ratio(theme.blocks, "--vex-alias-state-warn", "--vex-alias-bg-base")).toBeGreaterThanOrEqual(
        AA_BODY,
      );
    });

    it(`${theme.name}: the hovered REVIEW key still carries its label at ${AA_BODY}:1`, () => {
      const { percent, partner } = pinHoverMix();
      const hovered = mixOklab(
        resolveHex(theme.blocks, "--vex-alias-state-warn"),
        resolveHex(theme.blocks, partner),
        percent,
      );
      // --vex-surface-0, the key's label, is --vex-alias-bg-base under the
      // shell scope.
      const label = resolveHex(theme.blocks, "--vex-alias-bg-base");
      expect(
        Number(contrast(hovered, label).toFixed(2)),
        `hovered pin ${hovered} against its ${label} label in ${theme.name}`,
      ).toBeGreaterThanOrEqual(AA_BODY);
    });

    it(`${theme.name}: hovering never moves the plate toward its own label`, () => {
      // The property a ratio alone cannot state: hover must widen the gap.
      const { percent, partner } = pinHoverMix();
      const resting = resolveHex(theme.blocks, "--vex-alias-state-warn");
      const hovered = mixOklab(resting, resolveHex(theme.blocks, partner), percent);
      const label = resolveHex(theme.blocks, "--vex-alias-bg-base");
      expect(contrast(hovered, label)).toBeGreaterThan(contrast(resting, label));
    });
  }

  it("computes color-mix the way the browser does (the mixer is load-bearing)", () => {
    // Anchored on measured browser output: an amber mixed 85% toward white
    // produced #a0783c. If this drifts, every ratio above is fiction.
    expect(mixOklab("#8f6108", "#ffffff", 85)).toBe("#a0783c");
    expect(mixOklab("#febc2e", "#ffffff", 85)).toBe("#ffc75e");
  });
});
