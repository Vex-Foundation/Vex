/**
 * Stamp, Chip and CellMeter: the reversed REAL FUNDS label, the bracketed
 * status chip and the cell meter.
 */

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { Stamp } from "../stamp.js";
import { Chip } from "../chip.js";
import { CellMeter } from "../cell-meter.js";

function mustQuery(container: HTMLElement, selector: string): Element {
  const node = container.querySelector(selector);
  if (node === null) throw new Error(`missing ${selector}`);
  return node;
}

afterEach(() => {
  cleanup();
});

describe("Stamp", () => {
  it("reads REAL FUNDS by default and carries no status hue", () => {
    const { container } = render(<Stamp />);
    const stamp = mustQuery(container, ".vex-stamp");
    expect(stamp.textContent).toBe("Real funds");
    expect(stamp.className).not.toMatch(/red|danger|blue|accent/);
  });

  it("forwards attributes and takes another word", () => {
    render(<Stamp data-vex-stamp="x">Paper</Stamp>);
    expect(screen.getByText("Paper").getAttribute("data-vex-stamp")).toBe("x");
  });
});

describe("Chip", () => {
  it("pairs a swatch of the same state with the word", () => {
    const { container } = render(<Chip state="ongoing">Running</Chip>);
    const chip = mustQuery(container, ".vex-chip");
    expect(chip.getAttribute("data-s")).toBe("ongoing");
    expect(chip.querySelector(".vex-swatch")?.getAttribute("data-s")).toBe("ongoing");
    expect(chip.querySelector("b")?.textContent).toBe("Running");
  });

  it("marks compact and on-photo forms", () => {
    const { container } = render(
      <Chip state="done" compact onPhoto>Live</Chip>,
    );
    const chip = mustQuery(container, ".vex-chip");
    expect(chip.hasAttribute("data-compact")).toBe(true);
    expect(chip.hasAttribute("data-on-photo")).toBe(true);
  });
});

describe("CellMeter", () => {
  it("fills value of max cells and exposes the reading", () => {
    render(<CellMeter value={3} max={8} label="Context" />);
    const meter = screen.getByRole("meter", { name: "Context" });
    expect(meter.querySelectorAll("i").length).toBe(8);
    expect(meter.querySelectorAll("i[data-on]").length).toBe(3);
    expect(meter.getAttribute("aria-valuenow")).toBe("3");
  });

  it("clamps and flags over", () => {
    render(<CellMeter value={99} max={5} over label="Budget" />);
    const meter = screen.getByRole("meter", { name: "Budget" });
    expect(meter.querySelectorAll("i[data-on]").length).toBe(5);
    expect(meter.hasAttribute("data-over")).toBe(true);
  });
});
