/**
 * The desk's outcome copy names the tabs as the desk draws them (sentence
 * case, docs/design/R3-MINIMAL.md section 9.3): "Open orders" and "Trade
 * history". The source is read as text so a stale title-case name cannot
 * creep back in.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SOURCE = readFileSync(join(__dirname, "..", "useDeskLane.ts"), "utf8");

describe("useDeskLane outcome copy", () => {
  it("no longer names the tabs in title case", () => {
    expect(SOURCE).not.toContain("Trade History");
    expect(SOURCE).not.toContain("Open Orders");
  });

  it("names the tabs as the desk draws them", () => {
    expect(SOURCE).toContain("Check Positions and Trade history before");
    expect(SOURCE).toContain("Check Open orders below and refresh before retrying.");
    expect(SOURCE).toContain("Check Open orders below before adding protection or retrying.");
  });
});
