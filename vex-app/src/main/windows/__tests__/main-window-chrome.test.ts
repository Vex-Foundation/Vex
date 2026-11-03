/**
 * chromeOptionsFor: the per-OS title bar contract (docs/design/R3-MINIMAL.md
 * section 2.2), on H3's 76px header (docs/design/H3-DESKTOP.md section 4.7).
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  STANDIN_CAPTION_OVERLAY,
  STANDIN_TRAFFIC_LIGHTS,
} from "../../../renderer/dev/h3-shell/chrome-standin.js";
import {
  TITLE_BAR_HEIGHT,
  TITLE_BAR_OVERLAY_COLORS,
  TITLE_BAR_OVERLAY_HEIGHT,
  TRAFFIC_LIGHT_POSITION,
  chromeOptionsFor,
  titleBarOverlayFor,
} from "../chrome-options.js";

const here = path.dirname(fileURLToPath(import.meta.url));

describe("chromeOptionsFor", () => {
  it("macOS: hidden title bar, traffic lights at 20,32, no overlay", () => {
    for (const theme of ["chronos", "celeris"] as const) {
      expect(chromeOptionsFor("darwin", theme)).toEqual({
        titleBarStyle: "hidden",
        trafficLightPosition: { x: 20, y: 32 },
      });
    }
  });

  it.each(["win32", "linux"] as const)("%s: hidden title bar with a 75px overlay per theme", (platform) => {
    expect(chromeOptionsFor(platform, "celeris")).toEqual({
      titleBarStyle: "hidden",
      titleBarOverlay: { height: 75, color: "#F3F4F7", symbolColor: "#0A0D18" },
    });
    expect(chromeOptionsFor(platform, "chronos")).toEqual({
      titleBarStyle: "hidden",
      titleBarOverlay: { height: 75, color: "#1B1412", symbolColor: "#F3F4F7" },
    });
  });

  it("linux native-frame fallback returns no chrome options", () => {
    expect(chromeOptionsFor("linux", "chronos", { nativeFrame: true })).toEqual({});
  });

  it("the native-frame flag does not affect macOS or Windows", () => {
    expect(chromeOptionsFor("darwin", "celeris", { nativeFrame: true })).toHaveProperty("trafficLightPosition");
    expect(chromeOptionsFor("win32", "celeris", { nativeFrame: true })).toHaveProperty("titleBarOverlay");
  });

  // The overlay is an opaque plate: at the head row's full height it covered
  // the row's 1px bottom rule, so every head's rule stopped at the buttons.
  it("overlay stops one pixel above the head row's rule and symbols differ from the plate", () => {
    expect(TITLE_BAR_HEIGHT).toBe(76);
    expect(TITLE_BAR_OVERLAY_HEIGHT).toBe(TITLE_BAR_HEIGHT - 1);
    for (const theme of ["chronos", "celeris"] as const) {
      expect(titleBarOverlayFor(theme).height).toBe(75);
      expect(TITLE_BAR_OVERLAY_COLORS[theme].color).not.toBe(TITLE_BAR_OVERLAY_COLORS[theme].symbolColor);
    }
  });

  it("centres the traffic lights on the head row", () => {
    // 12px lights: (76 - 12) / 2 from the top.
    expect(TRAFFIC_LIGHT_POSITION.y).toBe((TITLE_BAR_HEIGHT - 12) / 2);
  });

  // The renderer cannot import this module, so the head row's height is
  // written twice: here, for the lights and the overlay, and as `--head-h` in
  // window-chrome.css, for every head row. They must not drift.
  it("is the same head row the renderer draws (--head-h)", () => {
    const sheet = readFileSync(
      path.resolve(here, "../../../renderer/styles/global-css/window-chrome.css"),
      "utf8",
    );
    const value = /--head-h:\s*(\d+)px;/.exec(sheet)?.[1];
    expect(Number(value)).toBe(TITLE_BAR_HEIGHT);
  });

  // The H3 harness paints a stand-in of the lights and the overlay where this
  // file puts the real ones (src/renderer/dev/h3-shell/chrome-standin.ts).
  it("is where the H3 harness stands the window's chrome in", () => {
    expect(STANDIN_TRAFFIC_LIGHTS).toEqual(TRAFFIC_LIGHT_POSITION);
    expect(STANDIN_CAPTION_OVERLAY.height).toBe(TITLE_BAR_OVERLAY_HEIGHT);
  });
});
