/**
 * Smoke pins for the VEX LOADER, the R3 quiet loading line:
 *  - announces its label once via role="status" (a11y contract);
 *  - tone maps to the paper/ink CSS class pair;
 *  - it draws one line: a length, an optional thickness and one segment,
 *    with no square box and nothing else inside.
 */

import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { VexLoader } from "../vex-loader.js";

describe("VexLoader", () => {
  it("announces the label via role=status and defaults to the ink tone", () => {
    render(<VexLoader label="Waking the desk" />);
    const status = screen.getByRole("status");
    expect(status.textContent).toContain("Waking the desk");
    expect(status.className).toContain("vex-loader--ink");
    expect(status.getAttribute("data-vex-loader")).toBe("ink");
  });

  it("paper tone maps to the paper class", () => {
    render(<VexLoader label="Loading" tone="paper" />);
    expect(screen.getByRole("status").className).toContain(
      "vex-loader--paper",
    );
  });

  it("is a 120px line by default with one segment and no box", () => {
    render(<VexLoader label="Loading conversation" />);
    const status = screen.getByRole("status");
    expect(status.style.width).toBe("120px");
    expect(status.style.height).toBe("");
    expect(status.querySelectorAll(".vex-loader__segment")).toHaveLength(1);
    expect(status.querySelector("[aria-hidden]")).toBeNull();
  });

  it("takes its length from size and its thickness from stroke", () => {
    render(<VexLoader label="Loading" size={40} stroke={3} />);
    const status = screen.getByRole("status");
    expect(status.style.width).toBe("40px");
    expect(status.style.getPropertyValue("--vex-loader-stroke")).toBe("3px");
  });
});
