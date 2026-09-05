/**
 * StateDot tests: data-state stamping for the solid states, size, and the
 * ongoing pixel chase (8 outer cells, negative phase delays so the chase is
 * mid-flight at first paint).
 */

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { StateDot } from "../state-dot.js";

afterEach(() => {
  cleanup();
});

describe("StateDot", () => {
  it.each(["done", "warning", "error"] as const)(
    "solid state %s renders a sized dot with data-state",
    (state) => {
      const { container } = render(<StateDot state={state} size={12} />);
      const dot = container.querySelector(".vex-state-dot")!;
      expect(dot.getAttribute("data-state")).toBe(state);
      expect((dot as HTMLElement).style.width).toBe("12px");
      expect(dot.getAttribute("aria-hidden")).toBe("true");
    },
  );

  it("ongoing renders the 3x3 outer-cell chase with phased negative delays", () => {
    const { container } = render(<StateDot state="ongoing" />);
    const matrix = container.querySelector(".vex-state-matrix")!;
    expect(matrix.getAttribute("data-state")).toBe("ongoing");
    const cells = matrix.querySelectorAll("rect.vex-state-cell");
    expect(cells.length).toBe(8);
    cells.forEach((cell, index) => {
      expect((cell as SVGElement).style.animationDelay).toBe(
        `${(index - 8) * 125}ms`,
      );
    });
  });
});

describe("StateDot's optional label", () => {
  it("keeps the exact element it renders today when no label is given", () => {
    const { container } = render(<StateDot state="done" />);
    // Every existing call site pairs the dot with visible text, so the
    // unlabelled form must not grow a wrapper under them.
    expect(container.firstElementChild?.classList.contains("vex-state-dot")).toBe(
      true,
    );
    expect(container.querySelector(".sr-only")).toBeNull();
  });

  it("carries the state in words for a site with no visible verdict", () => {
    const { container } = render(<StateDot state="warning" label="Drifted" />);
    // The dot is colour-only and aria-hidden. A surface whose ONLY state
    // signal is the dot - a terminal tab, say - owes assistive technology the
    // word, and this is where it goes.
    const dot = container.querySelector(".vex-state-dot");
    expect(dot?.getAttribute("data-state")).toBe("warning");
    expect(dot?.getAttribute("aria-hidden")).toBe("true");
    expect(container.querySelector(".sr-only")?.textContent).toBe("Drifted");
  });

  it("labels the ongoing chase the same way", () => {
    const { container } = render(<StateDot state="ongoing" label="Running" />);
    expect(container.querySelector(".vex-state-matrix")).not.toBeNull();
    expect(container.querySelector(".sr-only")?.textContent).toBe("Running");
  });

  it("treats an empty label as no label, never as an empty announcement", () => {
    const { container } = render(<StateDot state="error" label="" />);
    expect(container.querySelector(".sr-only")).toBeNull();
  });
});
