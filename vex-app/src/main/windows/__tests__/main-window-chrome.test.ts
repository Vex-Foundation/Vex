/**
 * chromeOptionsFor: the per-OS title bar contract (docs/design/R3-MINIMAL.md section 2.2).
 */

import { describe, expect, it } from "vitest";
import {
  TITLE_BAR_HEIGHT,
  TITLE_BAR_OVERLAY_COLORS,
  TITLE_BAR_OVERLAY_HEIGHT,
  chromeOptionsFor,
  titleBarOverlayFor,
} from "../chrome-options.js";

describe("chromeOptionsFor", () => {
  it("macOS: hidden title bar, traffic lights at 20,16, no overlay", () => {
    for (const theme of ["chronos", "celeris"] as const) {
      expect(chromeOptionsFor("darwin", theme)).toEqual({
        titleBarStyle: "hidden",
        trafficLightPosition: { x: 20, y: 16 },
      });
    }
  });

  it.each(["win32", "linux"] as const)("%s: hidden title bar with a 43px overlay on the H3 ground, whatever the theme", (platform) => {
    // Dark only (docs/design/H3-DESKTOP.md section 4.5): the schema's second
    // theme paints the same dark caption.
    for (const theme of ["chronos", "celeris"] as const) {
      expect(chromeOptionsFor(platform, theme)).toEqual({
        titleBarStyle: "hidden",
        titleBarOverlay: { height: 43, color: "#010203", symbolColor: "#F3F5F9" },
      });
    }
  });

  it("linux native-frame fallback returns no chrome options", () => {
    expect(chromeOptionsFor("linux", "chronos", { nativeFrame: true })).toEqual({});
  });

  it("the native-frame flag does not affect macOS or Windows", () => {
    expect(chromeOptionsFor("darwin", "celeris", { nativeFrame: true })).toHaveProperty("trafficLightPosition");
    expect(chromeOptionsFor("win32", "celeris", { nativeFrame: true })).toHaveProperty("titleBarOverlay");
  });

  // The overlay is an opaque plate: at the head row's full 44px it covered the
  // row's 1px bottom rule, so every head's rule stopped at the buttons.
  it("overlay stops one pixel above the head row's rule and symbols differ from the plate", () => {
    expect(TITLE_BAR_HEIGHT).toBe(44);
    expect(TITLE_BAR_OVERLAY_HEIGHT).toBe(TITLE_BAR_HEIGHT - 1);
    for (const theme of ["chronos", "celeris"] as const) {
      expect(titleBarOverlayFor(theme).height).toBe(43);
      expect(TITLE_BAR_OVERLAY_COLORS[theme].color).not.toBe(TITLE_BAR_OVERLAY_COLORS[theme].symbolColor);
    }
  });
});
