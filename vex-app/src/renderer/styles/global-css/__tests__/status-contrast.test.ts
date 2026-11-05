/**
 * A STATUS IS A SQUARE BESIDE A WORD, AND EVERY INK IS READABLE - a
 * measured contrast contract over the alias tier, in the one room (the app is
 * dark only). docs/design/H3-DESKTOP.md section 2.2 replaces R3's "status by
 * fill, never by colour":
 *
 *   - the WORD is ink: success, attention and error collapse onto the
 *     primary label, pinned as an identity, so no hue can creep back into a
 *     status word under an old alias name; a failure's word alone takes the
 *     refusal ink (VEX Cloud's --vx-err-text), measured as a text tier;
 *   - the SQUARE beside it has a drawing of its own per status (PD-03), and
 *     its colours are green (filled), red (the turn error row) and the hud
 *     (running, which blinks); each owes the 3:1 for graphics on every cell
 *     it can sit on, and the FILLED stamp carries its white word at the body
 *     floor;
 *   - gains and losses in trading values take their own green and red as
 *     TYPE, lighter than the squares, and neither pair is ever the other.
 *
 * The rest of the file MEASURES rather than pins. It reads tokens.css,
 * resolves each alias through the static tier, and computes the
 * WCAG 2.x contrast ratio. The floors are V10's: 4.5:1 for anything that
 * carries a sentence or a label, 3:1 for large display (counters). Status inks
 * are measured on the page ground AND inside their own wash, because the wash
 * is the binding surface: it moves the backdrop toward the ink.
 *
 * The reversed chrome plate (tooltip, hover card, toast, connection banner)
 * is measured with its own ink. The REAL FUNDS block measures
 * the approval card's keys, its ink frame and its reversed stamp: the one
 * card that moves money must read in every state a hand can put it in. The
 * last block measures the gain and loss pair, a value colour on trading
 * figures only and never a status.
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

/**
 * The one room. Kept as a list of blocks in cascade order so the measuring
 * helpers below read the same way they did for two rooms.
 */
const THEMES = [{ name: "the room", blocks: [chronos] }] as const;

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

/** The sRGB transfer function, to linear light. */
function toLinear(byte: number): number {
  const c = byte / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
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

/** Normal-size text: every label and sentence. */
const AA_BODY = 4.5;
/** Large text: the serif counters and numerals (24px and up). */
const AA_LARGE = 3;
/** A graphic beside a word (WCAG 1.4.11): the status squares. */
const AA_GRAPHIC = 3;

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
    collapsesTo: "--vex-alias-label-primary",
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
    expect(resolveHex([chronos], "--vex-alias-bg-base")).toBe("#010203");
    expect(resolveHex([chronos], "--vex-alias-state-warn")).toBe("#f3f5f9");
    expect(resolveHex([chronos], "--vex-alias-state-success")).toBe("#f3f5f9");
    expect(resolveHex([chronos], "--vex-alias-state-error")).toBe("#f3f5f9");
    expect(resolveHex([chronos], "--vex-alias-state-success-mark")).toBe("#1d7e3f");
    expect(resolveHex([chronos], "--vex-alias-state-error-mark")).toBe("#c22226");
    expect(resolveHex([chronos], "--vex-alias-composer")).toBe("#010203");
    expect(resolveHex([chronos], "--vex-alias-label-tertiary")).toBe("#808693");
    expect(resolveHex([chronos], "--vex-alias-trade-up")).toBe("#76cf8a");
    expect(resolveHex([chronos], "--vex-alias-trade-down")).toBe("#ff7a6e");
  });
});

describe("status words are ink", () => {
  for (const theme of THEMES) {
    for (const family of FAMILIES) {
      it(`${theme.name}: the ${family.name} inks collapse onto ${family.collapsesTo}`, () => {
        // The identity, not a likeness: every status word IS the ink. A
        // status hue in a word would have to break this equality.
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
        // would satisfy the ratio while inverting the room's whole logic. On
        // the dark ground ink is lighter than wash which is lighter than
        // ground.
        const ink = luminance(resolveHex(theme.blocks, family.ink[0]));
        const wash = luminance(resolveHex(theme.blocks, family.wash));
        const ground = luminance(resolveHex(theme.blocks, "--vex-alias-bg-base"));
        expect(ink).toBeGreaterThan(wash);
        expect(wash).toBeGreaterThan(ground);
      });
    }
  }
});

/**
 * The status squares (section 2.2) and the cells a status row can stand on:
 * the ground, a control at rest, a key cell and raised 2.
 */
const STATUS_MARKS = [
  ["filled", "--vex-alias-state-success-mark", "--color-h3-status-green"],
  ["did not execute", "--vex-alias-state-error-mark", "--color-h3-status-red"],
  ["running", "--vex-alias-state-running-mark", "--color-h3-hud"],
] as const;
const MARK_GROUNDS = [
  "--vex-alias-bg-base",
  "--vex-alias-bg-layer-3",
  "--vex-alias-interactive-solid",
  "--vex-alias-interactive-active",
] as const;

describe("status squares carry green, red and grey", () => {
  for (const theme of THEMES) {
    for (const [status, mark, primitive] of STATUS_MARKS) {
      it(`${theme.name}: the ${status} square is ${primitive}`, () => {
        expect(resolveHex(theme.blocks, mark)).toBe(resolveHex(theme.blocks, primitive));
      });

      it(`${theme.name}: the ${status} square clears ${AA_GRAPHIC}:1 on every cell it sits on`, () => {
        const failures = MARK_GROUNDS.map((ground) => [ground, ratio(theme.blocks, mark, ground)] as const)
          .filter(([, value]) => value < AA_GRAPHIC)
          .map(([ground, value]) => `${ground} ${value}:1`);
        expect(failures, mark).toEqual([]);
      });
    }

    it(`${theme.name}: the three square colours are three colours, and none is a word's ink`, () => {
      const marks = STATUS_MARKS.map(([, mark]) => resolveHex(theme.blocks, mark));
      expect(new Set(marks).size).toBe(marks.length);
      expect(marks).not.toContain(resolveHex(theme.blocks, "--vex-alias-label-primary"));
    });

    it(`${theme.name}: the FILLED stamp carries its white word at ${AA_BODY}:1`, () => {
      expect(resolveHex(theme.blocks, "--vex-alias-stamp-filled")).toBe(
        resolveHex(theme.blocks, "--vex-alias-state-success-mark"),
      );
      expect(
        ratio(theme.blocks, "--vex-alias-stamp-filled-ink", "--vex-alias-stamp-filled"),
      ).toBeGreaterThanOrEqual(AA_BODY);
    });
  }
});

/** Every text tier, and the surfaces text actually sits on. */
const TEXT_TIERS = [
  "--vex-alias-label-primary",
  "--vex-alias-label-secondary",
  "--vex-alias-label-tertiary",
  "--vex-alias-label-caption",
  "--vex-alias-accent-primary",
  "--vex-alias-state-refusal",
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
      // the same ink on the solid error plate. The banner's old gap (white on
      // a light red, 2.92:1) closed when error became the ink.
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
 * The REAL FUNDS card's keys (ApprovalCard/ApprovalDecisionActions.tsx,
 * docs/design/R3-MINIMAL.md section 8.2). Approve is the one blue fill with its
 * own ink; Reject is the ink key, an ink outline on the card's paper that
 * fills with ink on hover. Every state a hand can put either key in must carry
 * its label at AA body contrast.
 */
describe("REAL FUNDS key contrast", () => {
  for (const theme of THEMES) {
    it(`${theme.name}: the resting Approve key carries its label at ${AA_BODY}:1`, () => {
      expect(
        ratio(theme.blocks, "--vex-alias-button-accent-ink", "--vex-alias-button-accent-fill"),
      ).toBeGreaterThanOrEqual(AA_BODY);
    });

    it(`${theme.name}: the hovered Approve key still carries its label at ${AA_BODY}:1`, () => {
      expect(
        ratio(theme.blocks, "--vex-alias-button-accent-ink", "--vex-alias-button-accent-hover"),
      ).toBeGreaterThanOrEqual(AA_BODY);
    });

    it(`${theme.name}: the resting Reject key reads in ink on the card's paper at ${AA_BODY}:1`, () => {
      expect(ratio(theme.blocks, "--vex-alias-label-primary", "--vex-alias-bg-base")).toBeGreaterThanOrEqual(
        AA_BODY,
      );
      // The frame is the same ink: the REAL FUNDS edge must be as legible as
      // the words it encloses, never a faint rule.
      expect(ratio(theme.blocks, "--vex-alias-rule-ink", "--vex-alias-bg-base")).toBeGreaterThanOrEqual(
        AA_BODY,
      );
    });

    it(`${theme.name}: the hovered Reject key and the reversed stamp read at ${AA_BODY}:1`, () => {
      // Both are the ink plate with the primary-label ink on it.
      expect(
        ratio(theme.blocks, "--vex-alias-label-on-primary", "--vex-alias-rule-ink"),
      ).toBeGreaterThanOrEqual(AA_BODY);
    });
  }
});

/**
 * GAINS AND LOSSES (docs/design/H3-DESKTOP.md section 2.2): the sheet's
 * --live and --err as type, on trading values only (a signed P&L, Long and
 * Short, bids and asks). The pair reads as text on every ground text sits
 * on, carries the ink of a solid Long or Short key, and is never a status:
 * no state word and no status square resolves to it.
 */
const TRADE_INKS = ["--vex-alias-trade-up", "--vex-alias-trade-down"] as const;

describe("the trading pair", () => {
  for (const theme of THEMES) {
    for (const ink of TRADE_INKS) {
      it(`${theme.name}: ${ink} clears ${AA_BODY}:1 on every surface`, () => {
        const failures = TEXT_GROUNDS.map((ground) => [ground, ratio(theme.blocks, ink, ground)] as const)
          .filter(([, value]) => value < AA_BODY)
          .map(([ground, value]) => `${ground} ${value}:1`);
        expect(failures, `${ink} in ${theme.name}`).toEqual([]);
      });

      it(`${theme.name}: a solid ${ink} key carries its label at ${AA_BODY}:1`, () => {
        expect(
          ratio(theme.blocks, "--vex-alias-trade-ink", ink),
          `--vex-alias-trade-ink on ${ink} in ${theme.name}`,
        ).toBeGreaterThanOrEqual(AA_BODY);
      });
    }

    it(`${theme.name}: no status word or square is a trading colour`, () => {
      const trade = new Set(TRADE_INKS.map((ink) => resolveHex(theme.blocks, ink)));
      for (const family of FAMILIES) {
        for (const ink of family.ink) {
          expect(trade.has(resolveHex(theme.blocks, ink)), `${ink} in ${theme.name}`).toBe(false);
        }
      }
      for (const [, mark] of STATUS_MARKS) {
        expect(trade.has(resolveHex(theme.blocks, mark)), `${mark} in ${theme.name}`).toBe(false);
      }
    });
  }
});
