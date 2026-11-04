/**
 * THE LIGHTER DESK'S ROLES follow the H3 tokens (docs/design/H3-DESKTOP.md
 * section 2), tested as CSS text.
 *
 * The desk paints through its own `--lit-*` roles, declared once on
 * `.lit-desk, .lit-chat-frame` in lighter-tokens.css, so it takes a new look
 * only through them. The defects this guards are the ones that would keep
 * the desk in R3 while the rest of the app moved on, silently:
 *
 *   1. a role that spells a colour instead of an alias, which no token change
 *      reaches;
 *   2. a role that reaches a primitive directly (only the candle pair may,
 *      on the chart canvas host);
 *   3. the blue as type or a line: the H3 blue is a fill (Long, the setup
 *      action), and the desk's accent, direction and attention read in ink;
 *   4. caps tracked at anything but the one label tracking.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const css = readFileSync(path.join(here, "..", "lighter-tokens.css"), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);

function block(selector: string): string {
  const at = css.indexOf(`${selector} {`);
  expect(at, `selector "${selector}" not found`).toBeGreaterThanOrEqual(0);
  return css.slice(css.indexOf("{", at) + 1, css.indexOf("}", at));
}

const roles = new Map(
  [...block(".lit-desk,\n.lit-chat-frame").matchAll(/(--lit-[a-z0-9-]+):\s*([^;]+);/g)].map((m) => [
    m[1] as string,
    (m[2] as string).trim().replace(/\s+/g, " "),
  ]),
);

describe("the Lighter desk's roles", () => {
  it("declares its roles in one block (the regex is load-bearing)", () => {
    expect(roles.size).toBeGreaterThan(30);
    expect(roles.get("--lit-bg")).toBe("var(--vex-alias-bg-base)");
  });

  it("spells no colour: every colour role is an alias or a mix of one", () => {
    const literal = [...roles]
      .filter(([, value]) => /#[0-9a-f]{3,8}\b|\brgba?\(/i.test(value))
      .map(([name, value]) => `${name}: ${value}`);
    expect(literal).toEqual([]);
  });

  it("reaches no primitive directly; the candles take the gain and loss pair on the chart host alone", () => {
    const primitive = [...roles]
      .filter(([, value]) => /var\(--color-/.test(value))
      .map(([name]) => name);
    expect(primitive).toEqual([]);
    const chart = block(".lit-desk .lit-chart-canvas");
    expect(chart).toContain("--lit-candle-up: var(--vex-alias-trade-up);");
    expect(chart).toContain("--lit-candle-down: var(--vex-alias-trade-down);");
  });

  it("fills Long and the setup action with the H3 blue, and nothing else with it", () => {
    expect(roles.get("--lit-action")).toBe("var(--vex-alias-button-accent-fill)");
    expect(roles.get("--lit-action-hover")).toBe("var(--vex-alias-button-accent-hover)");
    expect(roles.get("--lit-action-ink")).toBe("var(--vex-alias-button-accent-ink)");
    const blue = [...roles]
      .filter(([name]) => !name.startsWith("--lit-action"))
      .filter(([, value]) => /button-accent/.test(value))
      .map(([name]) => name);
    expect(blue).toEqual([]);
  });

  it("reads its accent, direction and attention in ink tones, never a hue", () => {
    expect(roles.get("--lit-accent")).toBe("var(--vex-alias-accent-primary)");
    expect(roles.get("--lit-positive")).toBe("var(--vex-alias-label-primary)");
    expect(roles.get("--lit-negative")).toBe("var(--vex-alias-label-secondary)");
    expect(roles.get("--lit-warning")).toBe("var(--vex-alias-state-warn)");
  });

  it("takes gains and losses from the app's trading aliases", () => {
    expect(roles.get("--lit-trade-up")).toBe("var(--vex-alias-trade-up)");
    expect(roles.get("--lit-trade-down")).toBe("var(--vex-alias-trade-down)");
    expect(roles.get("--lit-trade-ink")).toBe("var(--vex-alias-trade-ink)");
  });

  it("tracks every caps role at the one label tracking", () => {
    for (const role of ["--lit-tr-label", "--lit-tr-status", "--lit-tr-eyebrow", "--lit-tr-caps-data"]) {
      expect(roles.get(role), role).toBe("var(--tracking-label)");
    }
    expect(roles.get("--lit-tr-data")).toBe("-0.01em");
  });
});
