/**
 * The wide zoom (docs/design/H3-DESKTOP.md section 1.11; VEX Cloud's
 * `wide-zoom.ts`): clamp(1, width / 1760, 1.5) to three decimals, kept on
 * `<html>` as `--vex-zoom` while the window resizes.
 */

import { afterEach, describe, expect, it } from "vitest";
import { ZOOM_BASE_WIDTH, ZOOM_MAX, ZOOM_PROPERTY, startWideZoom, wideZoomFor } from "../wide-zoom.js";

afterEach(() => {
  document.documentElement.style.removeProperty(ZOOM_PROPERTY);
});

describe("wideZoomFor", () => {
  it("is Cloud's clamp(1, width / 1760, 1.5), to three decimals", () => {
    expect([ZOOM_BASE_WIDTH, ZOOM_MAX, ZOOM_PROPERTY]).toEqual([1760, 1.5, "--vex-zoom"]);
    expect(wideZoomFor(1000)).toBe(1);
    expect(wideZoomFor(1440)).toBe(1);
    expect(wideZoomFor(1760)).toBe(1);
    // renders/checks.json: 1.091 at 1920, 1.455 at 2560.
    expect(wideZoomFor(1920)).toBe(1.091);
    expect(wideZoomFor(2560)).toBe(1.455);
    expect(wideZoomFor(2640)).toBe(1.5);
    expect(wideZoomFor(3840)).toBe(1.5);
  });

  it("zooms nothing for a width that is not a positive number", () => {
    expect(wideZoomFor(0)).toBe(1);
    expect(wideZoomFor(-5)).toBe(1);
    expect(wideZoomFor(Number.NaN)).toBe(1);
  });
});

describe("startWideZoom", () => {
  it("writes the zoom on <html> and follows the window's resizes until stopped", () => {
    const root = document.documentElement;
    const was = window.innerWidth;
    const setWidth = (value: number): void => {
      Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value });
    };
    try {
      setWidth(2560);
      const stop = startWideZoom(window);
      expect(root.style.getPropertyValue(ZOOM_PROPERTY)).toBe("1.455");
      setWidth(1920);
      window.dispatchEvent(new Event("resize"));
      expect(root.style.getPropertyValue(ZOOM_PROPERTY)).toBe("1.091");
      stop();
      setWidth(1440);
      window.dispatchEvent(new Event("resize"));
      expect(root.style.getPropertyValue(ZOOM_PROPERTY)).toBe("1.091");
    } finally {
      setWidth(was);
    }
  });
});
