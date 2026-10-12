import { describe, expect, it } from "vitest";
import { applyWindowChrome, detectChrome, detectOs } from "../use-window-chrome.js";

describe("window chrome detection", () => {
  it("maps user agents to an OS", () => {
    expect(detectOs({ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X)" })).toBe("mac");
    expect(detectOs({ userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64)" })).toBe("win");
    expect(detectOs({ userAgent: "Mozilla/5.0 (X11; Linux x86_64)" })).toBe("linux");
  });

  it("falls back to the native frame when the overlay is not visible off macOS", () => {
    expect(detectChrome("mac", undefined)).toBe("mac");
    expect(detectChrome("win", { visible: true })).toBe("overlay");
    expect(detectChrome("linux", { visible: false })).toBe("native");
    expect(detectChrome("linux", undefined)).toBe("native");
  });

  it("stamps data-os and data-chrome on the root", () => {
    const root = document.createElement("html");
    applyWindowChrome(root, "linux", "overlay");
    expect(root.dataset["os"]).toBe("linux");
    expect(root.dataset["chrome"]).toBe("overlay");
  });
});
