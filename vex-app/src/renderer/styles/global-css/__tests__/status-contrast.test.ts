/**
 * STATUS INK IS READABLE IN BOTH THEMES - a measured contrast contract over
 * every `--vex-alias-state-*` family.
 *
 * This started as `warning-contrast.test.ts`, written for a defect the owner
 * reported: in celeris (light), `--vex-alias-state-warn` was simply never
 * declared in the theme block, so the light room inherited the chronos
 * amber-500 #febc2e and every `text-warning` in the app painted at 1.69:1 on
 * white. The audit that followed found the SAME class of defect in the two
 * other families, which is why the file is now family-agnostic:
 *
 *   success - the identical missing declaration. celeris repointed
 *             `-success-wash` and never `-success`, inheriting green-500
 *             #1fb954 at 2.58:1 on white across 36 `text-success` sites.
 *   error   - repointed, but to red-500 #ef4444: 3.76:1 on white, a colour
 *             you can see and cannot read, at 73 `text-danger` sites.
 *
 * Nothing caught either. `theme-matrix.test.ts` proves an alias EXISTS in both
 * blocks, `terminal-palette-tokens.test.ts` proves the ANSI slots differ
 * between themes, and neither can see a colour that is present, valid,
 * on-brand and unreadable. So this test measures instead of pinning. It reads
 * tokens.css, resolves each family through the static ramp in EACH theme, and
 * computes the WCAG 2.x contrast ratio. The floor is 4.5:1, the normal-body-
 * text level: these tokens carry sentences (`text-danger` on a 12px status
 * line), not decoration.
 *
 * TWO surfaces, because passing one proves little. Status ink lands on the
 * page ground (`--vex-alias-bg-base`) and inside its own wash (`bg-*-wash` +
 * `text-*`, which is what the `pill` primitive does), and the wash is the
 * BINDING one: it moves the backdrop toward the ink, so a colour that clears
 * white by a comfortable margin can still fail against its own wash. #9a6700
 * is the worked example - 4.87:1 on white, 4.41:1 on the celeris warn wash.
 *
 * The last block leaves the alias tier and measures the one derived colour
 * this contract cannot see from tokens.css alone: the hover plate of the
 * approvals REVIEW key, a `color-mix` in shell.css. It is here because the mix
 * DIRECTION is a per-theme decision that no token name enforces, and getting
 * it wrong stays invisible until someone hovers.
 *
 * Deliberately OUT of scope: the sixteen `--vex-alias-term-*` ANSI slots.
 * Those are a wire contract with programs emitting SGR 31-33/91-93, not brand
 * ink; a colour and its bright variant must stay distinguishable FROM EACH
 * OTHER, and forcing both to 4.5:1 would collapse them together.
 * `terminal-palette-tokens.test.ts` owns that family.
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

/** Normal-body-text floor. These tokens carry sentences, not decoration. */
const AA_BODY = 4.5;

/**
 * Every state family and the aliases that carry TEXT in it. `-warn` and
 * `-warn-label` are both listed because both project to a `text-*` utility;
 * success and error have one text alias each.
 */
const FAMILIES = [
  {
    name: "success",
    ink: ["--vex-alias-state-success"],
    wash: "--vex-alias-state-success-wash",
  },
  {
    name: "warn",
    ink: ["--vex-alias-state-warn", "--vex-alias-state-warn-label"],
    wash: "--vex-alias-state-warn-wash",
  },
  {
    name: "error",
    ink: ["--vex-alias-state-error"],
    wash: "--vex-alias-state-error-wash",
  },
] as const;

describe("status ink contrast", () => {
  it("resolves the ramps it is measuring (the resolver is load-bearing)", () => {
    // If resolution silently degraded, every ratio below would be measured
    // against the wrong colour and still pass.
    expect(resolveHex([chronos], "--vex-alias-state-warn")).toBe("#febc2e");
    expect(resolveHex([chronos], "--vex-alias-state-success")).toBe("#1fb954");
    expect(resolveHex([chronos], "--vex-alias-state-error")).toBe("#f26d6d");
    expect(resolveHex([chronos, celeris], "--vex-alias-state-warn")).toBe("#8f6108");
    expect(resolveHex([chronos, celeris], "--vex-alias-state-success")).toBe("#137033");
    expect(resolveHex([chronos, celeris], "--vex-alias-state-error")).toBe("#b33333");
    expect(resolveHex([chronos, celeris], "--vex-alias-bg-base")).toBe("#ffffff");
  });

  for (const theme of THEMES) {
    for (const family of FAMILIES) {
      for (const ink of family.ink) {
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

        it(`${theme.name}: ${ink} clears ${AA_BODY}:1 inside the ${family.name} wash`, () => {
          // `bg-*-wash` + `text-*` is a real pairing (the `pill` primitive, the
          // Studio file-viewer and the workspace notice strips), and the wash
          // is the surface that binds: it moves the backdrop toward the ink.
          const ratio = contrast(
            resolveHex(theme.blocks, ink),
            resolveHex(theme.blocks, family.wash),
          );
          expect(
            Number(ratio.toFixed(2)),
            `${ink} on ${family.wash} in ${theme.name}`,
          ).toBeGreaterThanOrEqual(AA_BODY);
        });
      }

      it(`${theme.name}: the ${family.name} wash sits between its ink and the ground`, () => {
        // Direction, not just magnitude: a wash on the far side of the ground
        // would satisfy the ratio while inverting the theme's whole logic. In
        // chronos the room is dark, so ink is lighter than wash which is
        // lighter than ground; in celeris every comparison flips.
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

  it("celeris: the white label on a SOLID error plate clears the floor", () => {
    // Unlike success and warn, the error family has consumers that put text on
    // a filled plate: `bg-danger text-ink-on-accent` (components/ui/button.tsx)
    // and `.vex-connection-banner` (ui-primitives/overlays.css), whose ink is
    // --vex-alias-label-on-chrome. Both were white on red-500 at 3.76:1.
    //
    // CHRONOS IS NOT ASSERTED HERE, and that is a recorded gap rather than an
    // oversight: the same banner in chronos paints white on red-400 #f26d6d at
    // 2.92:1. Closing it means changing a chronos value, outside the task that
    // wrote this file, so it is reported instead of quietly pinned green. The
    // danger BUTTON is fine in chronos - its ink is --vex-alias-label-on-accent,
    // near-black, at 6.63:1. Only the banner, which hardcodes the white
    // on-chrome ink for both themes, is short.
    const ratio = contrast(
      resolveHex([chronos, celeris], "--vex-alias-state-error"),
      resolveHex([chronos, celeris], "--vex-alias-label-on-chrome"),
    );
    expect(Number(ratio.toFixed(2))).toBeGreaterThanOrEqual(AA_BODY);
  });
});

/**
 * The approvals REVIEW key (ApprovalCard/ApprovalDecisionActions.tsx) is a
 * solid `--vex-pin` plate whose label is `--vex-surface-0`. Its hover plate is
 * a `color-mix` declared in shell.css, so no alias name can enforce it: the
 * mix has to move the plate AWAY from the label, which is the opposite
 * direction in each theme. It shipped mixing toward a literal `white` -
 * correct for the dark room, and 4.00:1 in the light one the moment celeris
 * got a readable dark amber.
 */
describe("pin hover plate contrast", () => {
  const shell = ruleBody(shellCss, '[data-vex-shell="true"]');

  /** `85%, var(--vex-text)` - parsed, so a silent edit to shell.css is caught. */
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
      const ratio = contrast(hovered, label);
      expect(
        Number(ratio.toFixed(2)),
        `hovered pin ${hovered} against its ${label} label in ${theme.name}`,
      ).toBeGreaterThanOrEqual(AA_BODY);
    });

    it(`${theme.name}: hovering never moves the plate toward its own label`, () => {
      // The property a ratio alone cannot state: hover must widen the gap, not
      // narrow it. Mixing toward a literal white satisfied this in chronos and
      // violated it in celeris, which is exactly the defect.
      const { percent, partner } = pinHoverMix();
      const resting = resolveHex(theme.blocks, "--vex-alias-state-warn");
      const hovered = mixOklab(resting, resolveHex(theme.blocks, partner), percent);
      const label = resolveHex(theme.blocks, "--vex-alias-bg-base");
      expect(contrast(hovered, label)).toBeGreaterThan(contrast(resting, label));
    });
  }

  it("computes color-mix the way the browser does (the mixer is load-bearing)", () => {
    // Anchored on the shipped defect: the celeris pin mixed 85% toward white
    // produced #a0783c. If this drifts, every ratio above is fiction.
    expect(mixOklab("#8f6108", "#ffffff", 85)).toBe("#a0783c");
    expect(mixOklab("#febc2e", "#ffffff", 85)).toBe("#ffc75e");
  });
});
