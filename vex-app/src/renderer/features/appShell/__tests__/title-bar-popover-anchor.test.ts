/**
 * The header's popovers open from their cells (docs/design/H3-DESKTOP.md
 * sections 1.3 and 4.8): Needs you and Notices hang from the header's rule
 * under their own control, never from inside the 76px row, where R3's
 * anchors (2 under a 32 high key; 50 under a 44 row's top) would open them.
 * The Lighter desk's title row keeps R3's anchors.
 *
 * Read as TEXT: jsdom has no cascade for imported stylesheets (see
 * `micro-label-register.test.ts`). The harness capture at 1440 x 900 with
 * Needs you open is the layout proof: the panel's top at 76, its right edge
 * on the control's.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const sheet = readFileSync(
  join(process.cwd(), "src/renderer/styles/global-css/title-bar.css"),
  "utf8",
).replace(/\/\*[\s\S]*?\*\//g, "");

function rule(selector: string): string {
  const at = sheet.indexOf(`${selector} {`);
  expect(at, `${selector} is missing`).toBeGreaterThanOrEqual(0);
  return sheet.slice(sheet.indexOf("{", at) + 1, sheet.indexOf("}", at));
}

describe("the header's popovers", () => {
  it("hang from the header's rule, under their control's right edge", () => {
    const body = rule(".vex-shell-head .vex-tb-pop--notices");
    expect(body).toContain("top: calc(100% + 1px);");
    expect(body).toContain("right: 0;");
  });

  it("anchor on a control box that stands the cell's full height", () => {
    const body = rule(".vex-shell-head .vex-tb-notices");
    expect(body).toContain("position: relative;");
    expect(body).toContain("align-self: stretch;");
    expect(rule(".vex-shell-head .vex-running-head__flank")).toContain("align-self: stretch;");
  });

  it("leave R3's anchors in place for the desk's title row", () => {
    expect(rule(".vex-tb-pop--notices")).toContain("top: 50px;");
  });
});
