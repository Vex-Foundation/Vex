/**
 * VexingScene — jsdom contract tests, modelled on `VexSigil.test.tsx`.
 *
 * jsdom has no canvas 2D, so the default environment exercises the graceful
 * fallback. The particle paths run against a minimal mocked 2D context and a
 * stubbed Image, which is enough to pin the contracts that actually matter for
 * a LOOPING scene: reduced motion runs no loop at all, a hidden window burns no
 * frames, and unmount cancels the frame it scheduled.
 */

import { StrictMode } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VexingScene } from "../VexingScene.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  Object.defineProperty(document, "hidden", {
    configurable: true,
    get: () => false,
  });
});

function makeFake2d() {
  const fillStyles: string[] = [];
  return {
    fillStyles,
    setTransform: vi.fn(),
    clearRect: vi.fn(),
    drawImage: vi.fn(),
    getImageData: vi.fn((_x: number, _y: number, w: number, h: number) => ({
      data: new Uint8ClampedArray(w * h * 4).fill(255),
      width: w,
      height: h,
    })),
    beginPath: vi.fn(),
    rect: vi.fn(),
    fill: vi.fn(),
    set fillStyle(value: string) {
      fillStyles.push(value);
    },
  };
}

function installFake2d(): ReturnType<typeof makeFake2d> {
  const ctx = makeFake2d();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
    (contextId: string) =>
      contextId === "2d" ? (ctx as unknown as CanvasRenderingContext2D) : null,
  );
  return ctx;
}

function installFakeImage(outcome: "load" | "error"): void {
  class FakeImage {
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    naturalWidth = 500;
    naturalHeight = 500;
    set src(_value: string) {
      queueMicrotask(() => {
        if (outcome === "load") this.onload?.();
        else this.onerror?.();
      });
    }
  }
  vi.stubGlobal("Image", FakeImage as unknown as typeof Image);
}

function mockReducedMotion(matches: boolean): void {
  vi.stubGlobal(
    "matchMedia",
    (query: string): MediaQueryList =>
      ({
        matches: query.includes("prefers-reduced-motion") ? matches : false,
        media: query,
        onchange: null,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        addListener: () => undefined,
        removeListener: () => undefined,
        dispatchEvent: () => false,
      }) as MediaQueryList,
  );
}

function setHidden(hidden: boolean): void {
  Object.defineProperty(document, "hidden", {
    configurable: true,
    get: () => hidden,
  });
}

async function flushImageLoad(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

describe("VexingScene — failure contract", () => {
  it("falls back to the plain monogram <img> when canvas 2D is unavailable (jsdom)", () => {
    const view = render(<VexingScene className="h-40" />);
    expect(view.container.querySelector("canvas")).toBeNull();
    const img = view.container.querySelector("[data-vex-vexing-fallback]");
    expect(img).not.toBeNull();
    expect(img?.getAttribute("src")).toBe("/logo_clean.png");
    expect(img?.getAttribute("alt")).toBe("");
    expect(img?.getAttribute("aria-hidden")).toBe("true");
  });

  it("falls back to the <img> when the monogram fails to load", async () => {
    installFake2d();
    installFakeImage("error");
    const view = render(<VexingScene />);
    expect(view.container.querySelector("canvas")).not.toBeNull();
    await flushImageLoad();
    expect(view.container.querySelector("canvas")).toBeNull();
    expect(
      view.container.querySelector("[data-vex-vexing-fallback]"),
    ).not.toBeNull();
  });

  it("is decorative: aria-hidden, pointer-events-none, caller-sized square box", () => {
    const view = render(<VexingScene className="h-40" />);
    const root = view.container.querySelector("[data-vex-vexing-scene]");
    expect(root?.getAttribute("aria-hidden")).toBe("true");
    expect(root?.className).toContain("pointer-events-none");
    expect(root?.className).toContain("aspect-square");
    expect(root?.className).toContain("h-40");
  });
});

describe("VexingScene — motion contract", () => {
  it("reduced motion: paints the assembled mark once — no loop, no animation timer", async () => {
    mockReducedMotion(true);
    const ctx = installFake2d();
    installFakeImage("load");
    const raf = vi.fn(() => 1);
    vi.stubGlobal("requestAnimationFrame", raf);
    const interval = vi.spyOn(window, "setInterval");

    const view = render(<VexingScene />);
    await flushImageLoad();

    expect(view.container.querySelector("canvas")).not.toBeNull();
    expect(ctx.fill).toHaveBeenCalled();
    const particleCount = ctx.rect.mock.calls.length;
    expect(particleCount).toBeGreaterThanOrEqual(1500);
    expect(particleCount).toBeLessThanOrEqual(3000);
    expect(raf).not.toHaveBeenCalled();
    expect(interval).not.toHaveBeenCalled();
  });

  it("motion allowed: kicks off exactly one rAF after sampling and cancels it on unmount", async () => {
    installFake2d();
    installFakeImage("load");
    const raf = vi.fn(() => 42);
    const caf = vi.fn();
    vi.stubGlobal("requestAnimationFrame", raf);
    vi.stubGlobal("cancelAnimationFrame", caf);

    const view = render(<VexingScene />);
    await flushImageLoad();

    expect(raf).toHaveBeenCalledTimes(1);
    view.unmount();
    expect(caf).toHaveBeenCalledWith(42);
  });

  it("a hidden window burns no frames, and returning re-arms the loop", async () => {
    installFake2d();
    installFakeImage("load");
    const raf = vi.fn(() => 9);
    const caf = vi.fn();
    vi.stubGlobal("requestAnimationFrame", raf);
    vi.stubGlobal("cancelAnimationFrame", caf);

    render(<VexingScene />);
    await flushImageLoad();
    expect(raf).toHaveBeenCalledTimes(1);

    setHidden(true);
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(caf).toHaveBeenCalledWith(9);

    setHidden(false);
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(raf).toHaveBeenCalledTimes(2);
  });

  it("mounts and unmounts cleanly, including StrictMode effect replay", async () => {
    installFake2d();
    installFakeImage("load");
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn(() => 7),
    );
    vi.stubGlobal("cancelAnimationFrame", vi.fn());

    const view = render(
      <StrictMode>
        <VexingScene className="h-40" />
      </StrictMode>,
    );
    await flushImageLoad();
    expect(() => {
      view.unmount();
    }).not.toThrow();
  });
});
