/**
 * The loader gate (docs/design/H3-DESKTOP.md section 5.9), VEX Cloud's
 * `LoaderGate` and its count. The count's regressions, as Cloud pins them: a
 * bar that runs ahead of what has arrived, one that walks backwards, a
 * stalled window that jumps the bar, a pace that is not the whole bar in
 * 2.4 s, a cell row that is not max(18, round(width / 22)), a head cell that
 * is not the last lit one, a wipe not clipped from the right. The component:
 * the anatomy, the failure and the exit under the still frame.
 */

import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LoaderGate } from "../LoaderGate.js";
import {
  advanceGate,
  cellState,
  fillClip,
  GATE_PACE_S,
  GATE_READY,
  GATE_START,
  gateCellCount,
  litCells,
  raiseGoal,
} from "../loader-gate-model.js";

function walk(goal: number, until: number, limit = 30): number {
  let shown = GATE_START;
  let seconds = 0;
  while (shown < until && seconds < limit) {
    shown = advanceGate(shown, goal, 1 / 60);
    seconds += 1 / 60;
  }
  return seconds;
}

describe("the gate's count", () => {
  it("walks the whole bar in 2.4 s at one steady speed", () => {
    expect(GATE_PACE_S).toBe(2.4);
    expect(walk(1, GATE_READY)).toBeCloseTo((GATE_READY - GATE_START) * GATE_PACE_S, 1);
    expect(walk(1, 0.54)).toBeCloseTo((0.54 - GATE_START) * GATE_PACE_S, 1);
  });

  it("never passes what has arrived, and waits there", () => {
    let shown = GATE_START;
    for (let frame = 0; frame < 600; frame += 1) shown = advanceGate(shown, 0.47, 1 / 60);
    expect(shown).toBe(0.47);
    expect(advanceGate(shown, 0.6, 1 / 60)).toBeGreaterThan(0.47);
    expect(advanceGate(shown, 0.6, 1 / 60)).toBeLessThan(0.48);
  });

  it("counts a stalled frame for 50ms at most, and lands at once under the still frame", () => {
    expect(advanceGate(GATE_START, 1, 9)).toBeCloseTo(GATE_START + 0.05 / GATE_PACE_S, 6);
    expect(advanceGate(0.3, 1, -4)).toBe(0.3);
    expect(advanceGate(GATE_START, 0.47, 0.016, true)).toBe(0.47);
  });

  it("never runs backwards", () => {
    expect(raiseGoal(0.5, 0.3)).toBe(0.5);
    expect(raiseGoal(0.5, undefined)).toBe(0.5);
    expect(raiseGoal(0.5, Number.NaN)).toBe(0.5);
    expect(raiseGoal(0.5, 2)).toBe(1);
  });

  it("draws max(18, round(width / 22)) cells, the last lit one the head, the fill clipped from the right", () => {
    expect(gateCellCount(1440)).toBe(65);
    expect(gateCellCount(200)).toBe(18);
    expect(litCells(0.5, 64)).toBe(32);
    expect(cellState(30, 32)).toBe("on");
    expect(cellState(31, 32)).toBe("head");
    expect(cellState(32, 32)).toBeUndefined();
    expect(fillClip(0.25)).toBe("inset(0 75.00% 0 0)");
    expect(fillClip(1)).toBe("inset(0 0.00% 0 0)");
  });
});

describe("LoaderGate", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("is a status named by its word: the mark twice, the word, the cells", () => {
    render(<LoaderGate label="Loading" />);
    const gate = screen.getByRole("status", { name: "Loading" });
    expect(gate.classList.contains("vex-gate")).toBe(true);
    expect(gate.getAttribute("data-vex-gate-phase")).toBe("loading");
    expect(gate.querySelectorAll(".vex-gate__mark svg")).toHaveLength(2);
    expect(gate.querySelector<HTMLElement>(".vex-gate__fill")?.style.clipPath).toBe(fillClip(GATE_START));
    expect(gate.querySelector(".vex-gate__word")?.textContent).toBe("Loading");
    const cells = gate.querySelector(".vex-gate__cells");
    expect(cells?.getAttribute("aria-hidden")).toBe("true");
    expect(cells?.querySelectorAll(".vex-gate__cell").length).toBe(gateCellCount(window.innerWidth));
  });

  it("a failed start drops the word and the status, stands where it was told, and shows the failure", () => {
    render(
      <LoaderGate label="Loading" failed progress={0.4}>
        <p role="alert">Vex could not start.</p>
      </LoaderGate>,
    );
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByRole("alert").textContent).toBe("Vex could not start.");
    const gate = document.querySelector<HTMLElement>(".vex-gate");
    expect(gate?.hasAttribute("data-failed")).toBe(true);
    expect(gate?.querySelector(".vex-gate__word")).toBeNull();
    expect(gate?.querySelector<HTMLElement>(".vex-gate__fill")?.style.clipPath).toBe(fillClip(0.4));
  });

  it("under the still frame lands on what arrived and leaves at once when it is all there", () => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query.includes("prefers-reduced-motion"),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      onchange: null,
      dispatchEvent: () => false,
    }));
    vi.useFakeTimers({ toFake: ["requestAnimationFrame", "setTimeout", "performance"] });
    const onDone = vi.fn();
    const view = render(<LoaderGate label="Loading" progress={0.5} onDone={onDone} />);
    act(() => {
      vi.advanceTimersByTime(50);
    });
    expect(view.container.querySelector<HTMLElement>(".vex-gate__fill")?.style.clipPath).toBe(fillClip(0.5));
    expect(onDone).not.toHaveBeenCalled();
    view.rerender(<LoaderGate label="Loading" progress={1} onDone={onDone} />);
    act(() => {
      vi.advanceTimersByTime(50);
    });
    act(() => {
      vi.advanceTimersByTime(50);
    });
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(view.container.querySelector(".vex-gate")).toBeNull();
  });
});
