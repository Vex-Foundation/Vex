/**
 * The title bar's mission swatch rules name the title bar's own badge.
 *
 * `title-bar.css` paints the badge's first span (the mark) by the badge's
 * `data-vex-state`. The contract sheet renders inside the title bar's mission
 * cluster, so a rule written as `.vex-tb-mission [data-vex-state="ready"] >
 * span:first-child` also matched any state-carrying element in the sheet and
 * painted the sheet's whole status marker as a solid blue block. Every state
 * rule is therefore scoped to `[data-vex-action="open-mission-detail"]`, the
 * badge button itself.
 *
 * Read as TEXT: jsdom has no cascade for imported stylesheets (see
 * `micro-label-register.test.ts`).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const sheet = readFileSync(
  join(process.cwd(), "src/renderer/styles/global-css/title-bar.css"),
  "utf8",
).replace(/\/\*[\s\S]*?\*\//g, "");

describe("title-bar.css mission state rules", () => {
  it("scopes every data-vex-state rule in the mission cluster to the badge button", () => {
    const selectors = sheet
      .split("{")
      .map((chunk) => chunk.split("}").pop() ?? "")
      .flatMap((sel) => sel.split(","))
      .map((sel) => sel.trim())
      .filter((sel) => sel.includes(".vex-tb-mission") && sel.includes("data-vex-state"));
    expect(selectors.length).toBeGreaterThanOrEqual(6);
    for (const sel of selectors) {
      expect(sel).toContain('[data-vex-action="open-mission-detail"][data-vex-state=');
    }
  });

  it("paints each badge state on the mark", () => {
    for (const state of ["ready", "preparing", "accepted", "ended", "stale", "error"]) {
      expect(sheet).toContain(
        `.vex-tb-mission [data-vex-action="open-mission-detail"][data-vex-state="${state}"] > span:first-child`,
      );
    }
  });
});
