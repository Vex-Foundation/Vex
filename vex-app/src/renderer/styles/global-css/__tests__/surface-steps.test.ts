/**
 * THE H3 SURFACE STEPS (docs/design/H3-DESKTOP.md sections 2.1 and 2.4),
 * tested as CSS text. Replaces R3's paper 2 contract: R3 stepped its wells
 * and fields onto paper 2 (#221A17 at night); H3 sets everything on one
 * near-black ground and lifts only a few cells off it, each by a step the
 * contract names. Pinned here:
 *
 *   1. the chat column, its fields and the boards sit on the ground
 *      (#010203) - the composer's field and the card's amount field are on
 *      the ground behind their rule in the captures; the side columns stand
 *      on VEX Cloud's rail (#010101) and the page under the frame on its page
 *      (#020205);
 *   2. the wells take the cell step, popovers and menus the card, a selected
 *      tab and the washes the open ground, a pressed segment raised, the two
 *      bubbles Cloud's white at 13% and 6%;
 *   3. every rule is white at an alpha (the sheet's 7% rule and its 24%
 *      chosen rule), so it composes over any of those steps;
 *   4. the steps rise in order, so a cell never reads darker than the ground
 *      it sits on.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const tokensCss = readFileSync(path.join(here, "..", "tokens.css"), "utf8");

function block(selector: string): string {
  const at = tokensCss.indexOf(`${selector} {`);
  expect(at, `selector "${selector}" not found`).toBeGreaterThanOrEqual(0);
  return tokensCss.slice(at, tokensCss.indexOf("\n}", at));
}

const room = block(":root");

function value(body: string, name: string): string | undefined {
  return new RegExp(`${name}:\\s*([^;]+);`).exec(body)?.[1]?.trim().replace(/\s+/g, " ");
}

/** The primitive's hex, from the static tier. */
function hex(primitive: string): string {
  const found = value(tokensCss, primitive);
  expect(found, `${primitive} is not declared`).toMatch(/^#[0-9a-f]{6}$/);
  return found ?? "";
}

function lightness(colour: string): number {
  const [r, g, b] = [1, 3, 5].map((at) => parseInt(colour.slice(at, at + 2), 16) / 255);
  const linear = [r, g, b].map((c) =>
    (c as number) <= 0.04045 ? (c as number) / 12.92 : (((c as number) + 0.055) / 1.055) ** 2.4,
  );
  return 0.2126 * (linear[0] as number) + 0.7152 * (linear[1] as number) + 0.0722 * (linear[2] as number);
}

describe("the H3 surface steps", () => {
  it("sets the columns, cards, rails and fields on the one ground", () => {
    expect(hex("--color-h3-ground")).toBe("#010203");
    for (const alias of [
      "--vex-alias-bg-base",
      "--vex-alias-bg-deep",
      "--vex-alias-bg-layer-1",
      "--vex-alias-bg-layer-2",
      "--vex-alias-field",
      "--vex-alias-board-surface",
      "--vex-alias-board-card",
    ]) {
      expect(value(room, alias), alias).toBe("var(--color-h3-ground)");
    }
    expect(value(room, "--vex-alias-composer")).toBe("var(--vex-alias-field)");
    expect(value(room, "--vex-alias-sidebar-fill")).toBe("var(--color-h3-rail)");
    expect(value(room, "--vex-alias-bg-page")).toBe("var(--color-h3-page)");
    expect(hex("--color-h3-rail")).toBe("#010101");
    expect(hex("--color-h3-page")).toBe("#020205");
  });

  it("lifts each cell by the step the contract names for it", () => {
    expect(value(room, "--vex-alias-bg-layer-3")).toBe("var(--color-h3-cell)");
    expect(value(room, "--vex-alias-bg-overlay")).toBe("var(--color-h3-card)");
    expect(value(room, "--vex-alias-interactive-active")).toBe("var(--color-h3-cell-open)");
    expect(value(room, "--vex-alias-accent-wash")).toBe("var(--color-h3-cell-open)");
    expect(value(room, "--vex-alias-interactive-solid")).toBe("var(--color-h3-raised)");
    expect(value(room, "--vex-alias-board-card-hover")).toBe("var(--color-h3-raised)");
    expect(value(room, "--vex-alias-bubble")).toBe("rgba(255, 255, 255, 0.13)");
    expect(value(room, "--vex-alias-bubble-vex")).toBe("rgba(255, 255, 255, 0.06)");
  });

  it("fades the chosen row from Cloud's #1A1B1C to transparent", () => {
    expect(value(room, "--vex-alias-row-selected")).toBe(
      "linear-gradient( 90deg, var(--color-h3-row), transparent )",
    );
    expect(hex("--color-h3-row")).toBe("#1a1b1c");
  });

  it("draws every rule in white at an alpha: the sheet's 7% rule and its 24% chosen rule", () => {
    expect(value(room, "--vex-alias-rule")).toBe("rgba(255, 255, 255, 0.07)");
    expect(value(room, "--vex-alias-rule-quiet")).toBe("rgba(255, 255, 255, 0.07)");
    expect(value(room, "--vex-alias-rule-chosen")).toBe("rgba(255, 255, 255, 0.24)");
    expect(value(room, "--vex-alias-border-l3")).toBe("var(--vex-alias-rule-chosen)");
    expect(value(room, "--vex-alias-border-l4")).toBe("var(--vex-alias-rule-chosen)");
    expect(block("@theme inline")).toContain("--color-rule-chosen: var(--vex-alias-rule-chosen);");
  });

  it("rises in order: rail, ground, page, card, cell, raised, open, plate, the row", () => {
    const steps = [
      "--color-h3-rail",
      "--color-h3-ground",
      "--color-h3-page",
      "--color-h3-card",
      "--color-h3-cell",
      "--color-h3-raised",
      "--color-h3-cell-open",
      "--color-h3-tooltip",
      "--color-h3-row",
    ].map((name) => lightness(hex(name)));
    for (let at = 1; at < steps.length; at += 1) {
      expect(steps[at], `step ${String(at)}`).toBeGreaterThan(steps[at - 1] as number);
    }
  });
});
