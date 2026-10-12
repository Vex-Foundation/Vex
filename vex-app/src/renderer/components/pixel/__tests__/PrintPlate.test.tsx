/**
 * The print plate's wiring: the two prints, one decorative canvas, and the
 * engine started with the right state, layout and still flag. Reduced motion
 * and Save-Data each ask for the composed frame only; the engine's own suite
 * proves what "still" then paints.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import type { FlockEngineOptions } from "../flock-engine.js";

const engines = vi.hoisted(() => ({
  created: [] as FlockEngineOptions[],
  destroyed: 0,
}));

vi.mock("../flock-engine.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../flock-engine.js")>();
  class RecordingEngine {
    constructor(options: FlockEngineOptions) {
      engines.created.push(options);
    }
    start(): Promise<void> {
      return Promise.resolve();
    }
    resize(): void {}
    destroy(): void {
      engines.destroyed += 1;
    }
  }
  return { ...actual, FlockEngine: RecordingEngine };
});

const motion = { reduce: false };

beforeAll(() => {
  // The reduced-motion module keeps one MediaQueryList for the window, so the
  // stub reads a flag rather than being replaced per test.
  vi.stubGlobal("matchMedia", (query: string) => ({
    media: query,
    get matches() {
      return motion.reduce;
    },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
});

const { PrintPlate } = await import("../PrintPlate.js");
const { PLATE_ART } = await import("../flock-engine.js");

afterEach(() => {
  cleanup();
  engines.created = [];
  engines.destroyed = 0;
  motion.reduce = false;
  Reflect.deleteProperty(navigator, "connection");
});

describe("PrintPlate", () => {
  it("lays the day and night prints under one decorative canvas", () => {
    const { container } = render(<PrintPlate state="idle" />);
    const plate = container.querySelector("[data-vex-print-plate]");
    expect(plate?.getAttribute("data-vex-agent")).toBe("idle");
    expect(plate?.getAttribute("data-vex-plate-layout")).toBe("page");
    const prints = [...container.querySelectorAll("img")].map((i) => i.getAttribute("src"));
    expect(prints).toEqual([PLATE_ART.day, PLATE_ART.night]);
    for (const img of container.querySelectorAll("img")) {
      expect(img.getAttribute("alt")).toBe("");
      expect(img.getAttribute("aria-hidden")).toBe("true");
    }
    const canvases = container.querySelectorAll("canvas");
    expect(canvases).toHaveLength(1);
    expect(canvases[0]?.getAttribute("aria-hidden")).toBe("true");
  });

  it("lays the print's grain over the photograph, under the flock", () => {
    const { container } = render(<PrintPlate state="idle" />);
    const grain = container.querySelector("[data-vex-print-grain]");
    expect(grain?.getAttribute("aria-hidden")).toBe("true");
    // The class list must name the shipped grain file (Tailwind reads it there).
    expect(grain?.className).toContain(`url(${PLATE_ART.grain})`);
    const layers = [...(container.querySelector("[data-vex-print-plate]")?.children ?? [])];
    const grainAt = layers.findIndex((el) => el.hasAttribute("data-vex-print-grain"));
    const canvasAt = layers.findIndex((el) => el.tagName === "CANVAS");
    expect(grainAt).toBeGreaterThan(-1);
    expect(grainAt).toBeLessThan(canvasAt);
  });

  it("starts the engine for its state, in motion by default", () => {
    render(<PrintPlate state="live" />);
    expect(engines.created).toHaveLength(1);
    expect(engines.created[0]).toMatchObject({ state: "live", layout: "page", still: false });
  });

  it("asks for the still frame under reduced motion", () => {
    motion.reduce = true;
    render(<PrintPlate state="running" />);
    expect(engines.created[0]).toMatchObject({ state: "running", still: true });
  });

  it("asks for the still frame under Save-Data", () => {
    Object.defineProperty(navigator, "connection", {
      configurable: true,
      value: { saveData: true },
    });
    render(<PrintPlate state="live" />);
    expect(engines.created[0]).toMatchObject({ still: true });
  });

  it("a new state is a new engine; the old one stops", () => {
    const { rerender, unmount } = render(<PrintPlate state="idle" />);
    rerender(<PrintPlate state="awaiting" />);
    expect(engines.created.map((o) => o.state)).toEqual(["idle", "awaiting"]);
    expect(engines.destroyed).toBe(1);
    unmount();
    expect(engines.destroyed).toBe(2);
  });

  it("passes the stage pose to a stage plate", () => {
    render(<PrintPlate state="idle" layout="stage" stagePose={{ x: 0.15, y: 0.645, frac: 0.16, cell: 4 }} />);
    expect(engines.created[0]).toMatchObject({
      layout: "stage",
      stagePose: { x: 0.15, y: 0.645, frac: 0.16, cell: 4 },
    });
  });

  it("keeps the caller's furniture over the print", () => {
    const { getByText } = render(
      <PrintPlate state="paused">
        <span>Sessions</span>
      </PrintPlate>,
    );
    expect(getByText("Sessions")).toBeTruthy();
  });
});
