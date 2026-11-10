/**
 * The next-step bar's sheet contract (docs/design/H3-DESKTOP.md section 5.10;
 * `MissionControls/MissionNextStepBar.tsx`, the rules in chat-transcript.css).
 *
 * jsdom resolves no cascade, so the look is pinned as text: the bar is a 1px
 * rule on the card ground, square, with no shadow, glow, blur or filter; every
 * colour it spells is an alias token; and the blue reaches it only through the
 * primary key, whose first-appearance rise is the one rule here that names the
 * blue fill. The rise is a transform on the push step, and states its own
 * collapse under reduced motion and Save-Data (MOTION-POLICY.md).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SHEET = readFileSync(
  join(process.cwd(), "src/renderer/styles/global-css/chat-transcript.css"),
  "utf8",
).replace(/\/\*[\s\S]*?\*\//g, "");

interface Rule {
  readonly selector: string;
  readonly body: string;
}

/** Every innermost `selector { declarations }` that names the bar. */
function barRules(): Rule[] {
  const rules: Rule[] = [];
  for (const match of SHEET.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = (match[1] ?? "").trim();
    if (selector.includes("vex-next-step")) rules.push({ selector, body: match[2] ?? "" });
  }
  return rules;
}

function rule(selector: string): string {
  const found = barRules().filter((candidate) => candidate.selector === selector);
  expect(found.length, `${selector} is declared`).toBeGreaterThan(0);
  return found.map((candidate) => candidate.body).join("\n");
}

describe("the next-step bar's sheet", () => {
  it("is a 1px rule on the card ground", () => {
    const bar = rule(".vex-next-step");
    expect(bar).toMatch(/background:\s*var\(--vex-alias-card\);/);
    expect(bar).toMatch(/border:\s*1px solid var\(--vex-alias-rule\);/);
  });

  it("draws no shadow, glow, blur, filter or radius anywhere in the bar", () => {
    const rules = barRules();
    expect(rules.length).toBeGreaterThan(5);
    for (const { selector, body } of rules) {
      expect(body, selector).not.toMatch(/box-shadow|text-shadow|filter\s*:|backdrop-filter|border-radius/);
    }
  });

  it("spells colour only through alias tokens", () => {
    for (const { selector, body } of barRules()) {
      expect(body, selector).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|oklch\(|hsla?\(/i);
      for (const [, property, value] of body.matchAll(/(color|background(?:-color)?|border(?:-color)?)\s*:\s*([^;]+);/g)) {
        expect(value, `${selector} ${property ?? ""}`).toMatch(/var\(--vex-alias-[a-z0-9-]+\)/);
      }
    }
  });

  it("takes the blue only through the primary key: the rise layer is the one rule that names it", () => {
    const blue = barRules().filter(({ body }) => /--vex-alias-button-accent/.test(body));
    expect(blue.map(({ selector }) => selector)).toEqual([".vex-next-step__rise"]);
  });

  it("rises as a transform on the push step, once (no repeat), and collapses under reduced motion and Save-Data", () => {
    const rise = rule(".vex-next-step__rise");
    expect(rise).toMatch(
      /animation:\s*vex-next-step-rise var\(--vex-duration-vex-open\) var\(--vex-ease-push\) both;/,
    );
    expect(rise).not.toMatch(/infinite/);
    expect(rise).toMatch(/transform-origin:\s*bottom;/);
    const keyframes = /@keyframes vex-next-step-rise\s*\{([\s\S]*?)\n\}/.exec(SHEET)?.[1] ?? "";
    expect(keyframes).toMatch(/scaleY\(0\)/);
    expect(keyframes).toMatch(/scaleY\(1\)/);
    // Only the transform moves: never a size, never a place.
    for (const [, property] of keyframes.matchAll(/([a-z-]+)\s*:/g)) {
      expect(property).toBe("transform");
    }
    expect(SHEET).toMatch(
      /@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.vex-next-step__rise\s*\{\s*animation:\s*none;/,
    );
    expect(SHEET).toMatch(/html\[data-still\] \.vex-next-step__rise\s*\{\s*animation:\s*none;/);
  });

  it("keeps the key at least 44 high and 200 wide, its focus ring inside the cell", () => {
    const key = rule(".vex-next-step__key");
    expect(key).toMatch(/min-height:\s*44px;/);
    expect(key).toMatch(/min-width:\s*200px;/);
    expect(rule(".vex-next-step__key:focus-visible")).toMatch(/outline-offset:\s*-2px;/);
  });
});
