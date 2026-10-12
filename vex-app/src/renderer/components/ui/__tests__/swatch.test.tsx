/**
 * Swatch tests: one element per state, stamped with its fill name, sized,
 * hidden from assistive technology unless a label is given.
 */

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { Swatch, type SwatchState } from "../swatch.js";

afterEach(() => {
  cleanup();
});

const STATES: readonly SwatchState[] = [
  "done",
  "ongoing",
  "warning",
  "draft",
  "idle",
  "error",
];

describe("Swatch", () => {
  it.each(STATES)("state %s renders a sized, hidden swatch with data-s", (state) => {
    const { container } = render(<Swatch state={state} size={12} />);
    const swatch = container.querySelector(".vex-swatch") as HTMLElement;
    expect(swatch.getAttribute("data-s")).toBe(state);
    expect(swatch.style.width).toBe("12px");
    expect(swatch.style.height).toBe("12px");
    expect(swatch.getAttribute("aria-hidden")).toBe("true");
  });

  it("defaults to the 10px cell", () => {
    const { container } = render(<Swatch state="done" />);
    expect((container.querySelector(".vex-swatch") as HTMLElement).style.width).toBe("10px");
  });

  it("a label wraps the swatch with screen-reader text and no second swatch", () => {
    const { container, getByText } = render(<Swatch state="warning" label="Drifted" />);
    expect(container.querySelectorAll(".vex-swatch").length).toBe(1);
    expect(getByText("Drifted").className).toContain("sr-only");
  });

  it("never carries a status hue class", () => {
    const { container } = render(<Swatch state="error" />);
    expect(container.innerHTML).not.toMatch(/success|danger|warn|green|red|amber/);
  });
});
