/**
 * The still frame's Save-Data half (lib/motion/use-still-frame.ts).
 *
 * docs/design/H3-DESKTOP.md section 3.7: Save-Data lands motion at once, in
 * JS (the still frame) and in CSS. CSS has no media query for it, so it
 * reads `data-still` on <html>, which `stampSaveData` sets from the
 * connection's preference (and `public/theme-boot.js` mirrors before first
 * paint, pinned in `stores/__tests__/theme-boot.test.ts`). Pinned here:
 *
 *   1. the attribute is present exactly while `saveData` is true, and an
 *      absent connection, false or an unknown value leave motion on;
 *   2. it agrees with `prefersSaveData`, the JS reading of the same
 *      preference, for every state;
 *   3. base.css lands motion under the attribute with the reduced-motion
 *      catch-all's own declarations and its one opt-out.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prefersSaveData, stampSaveData, STILL_ATTRIBUTE } from "../use-still-frame.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const baseCss = readFileSync(
  path.join(here, "..", "..", "..", "styles", "global-css", "base.css"),
  "utf8",
);

afterEach(() => {
  vi.unstubAllGlobals();
  document.documentElement.removeAttribute(STILL_ATTRIBUTE);
});

describe("stampSaveData", () => {
  it("names the attribute the sheets read", () => {
    expect(STILL_ATTRIBUTE).toBe("data-still");
  });

  it("stamps data-still while the connection asks to save data", () => {
    stampSaveData(document.documentElement, { saveData: true });
    expect(document.documentElement.getAttribute("data-still")).toBe("");
  });

  it.each([
    ["no connection", undefined],
    ["Save-Data off", { saveData: false }],
    ["Save-Data unknown", {}],
  ])("clears it with %s", (_case, connection) => {
    document.documentElement.setAttribute("data-still", "");
    stampSaveData(document.documentElement, connection);
    expect(document.documentElement.hasAttribute("data-still")).toBe(false);
  });

  it.each([true, false, undefined])("agrees with prefersSaveData when saveData is %s", (saveData) => {
    vi.stubGlobal("navigator", { connection: { saveData } });
    stampSaveData(document.documentElement, { saveData });
    expect(document.documentElement.hasAttribute("data-still")).toBe(prefersSaveData());
  });
});

describe("base.css under data-still", () => {
  /** The declarations of the block that follows a selector list. */
  function blockAfter(selector: string): string {
    const at = baseCss.indexOf(selector);
    expect(at, `${selector} is not in base.css`).toBeGreaterThanOrEqual(0);
    const open = baseCss.indexOf("{", at);
    return baseCss.slice(open + 1, baseCss.indexOf("}", open)).replace(/\s+/g, " ").trim();
  }

  it("lands every animation and transition at once, as the reduced-motion catch-all does", () => {
    const reduced = blockAfter("  *:not([data-vex-motion-opacity]),");
    const still = blockAfter("html[data-still] *:not([data-vex-motion-opacity]),");
    expect(still).toBe(reduced);
    expect(still).toContain("animation-duration: 0.01ms !important;");
    expect(still).toContain("transition-duration: 0.01ms !important;");
  });

  it("keeps the one documented opt-out and reaches the pseudo-elements", () => {
    for (const selector of [
      "html[data-still] *:not([data-vex-motion-opacity]),",
      "html[data-still] *:not([data-vex-motion-opacity])::before,",
      "html[data-still] *:not([data-vex-motion-opacity])::after {",
    ]) {
      expect(baseCss).toContain(selector);
    }
  });
});
