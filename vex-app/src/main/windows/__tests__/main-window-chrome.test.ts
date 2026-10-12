/**
 * chromeOptionsFor: the per-OS title bar contract (SPEC section 8).
 */

import { describe, expect, it } from "vitest";
import {
  TITLE_BAR_HEIGHT,
  TITLE_BAR_OVERLAY_COLORS,
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

  it.each(["win32", "linux"] as const)("%s: hidden title bar with a 44px overlay per theme", (platform) => {
    expect(chromeOptionsFor(platform, "celeris")).toEqual({
      titleBarStyle: "hidden",
      titleBarOverlay: { height: 44, color: "#F3F4F7", symbolColor: "#0A0D18" },
    });
    expect(chromeOptionsFor(platform, "chronos")).toEqual({
      titleBarStyle: "hidden",
      titleBarOverlay: { height: 44, color: "#1B1412", symbolColor: "#F3F4F7" },
    });
  });

  it("linux native-frame fallback returns no chrome options", () => {
    expect(chromeOptionsFor("linux", "chronos", { nativeFrame: true })).toEqual({});
  });

  it("the native-frame flag does not affect macOS or Windows", () => {
    expect(chromeOptionsFor("darwin", "celeris", { nativeFrame: true })).toHaveProperty("trafficLightPosition");
    expect(chromeOptionsFor("win32", "celeris", { nativeFrame: true })).toHaveProperty("titleBarOverlay");
  });

  it("overlay height equals the head row height and symbols differ from the plate", () => {
    expect(TITLE_BAR_HEIGHT).toBe(44);
    for (const theme of ["chronos", "celeris"] as const) {
      expect(titleBarOverlayFor(theme).height).toBe(44);
      expect(TITLE_BAR_OVERLAY_COLORS[theme].color).not.toBe(TITLE_BAR_OVERLAY_COLORS[theme].symbolColor);
    }
  });
});
