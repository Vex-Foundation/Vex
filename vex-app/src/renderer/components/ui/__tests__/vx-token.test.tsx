/**
 * VxToken: the flat vx in a blue disc. Pins:
 *   - one SVG at the requested diameter, the disc a circle (boxes stay square);
 *   - the vx path inside it, so the mark is the logo and never a redraw;
 *   - colours come from the sheet (no fill or hue literal in the markup);
 *   - decorative by default, named when a label is given.
 */

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { VxToken } from "../vx-token.js";

afterEach(cleanup);

function svgOf(container: HTMLElement): SVGSVGElement {
  const svg = container.querySelector<SVGSVGElement>(".vex-vx-token > svg");
  if (svg === null) throw new Error("missing token svg");
  return svg;
}

describe("VxToken", () => {
  it("draws one disc at the requested diameter with the vx inside", () => {
    const { container } = render(<VxToken size={32} />);
    const svg = svgOf(container);
    expect(svg.getAttribute("width")).toBe("32");
    expect(svg.getAttribute("height")).toBe("32");
    expect(svg.getAttribute("viewBox")).toBe("0 0 100 100");
    expect(svg.querySelectorAll("circle.vex-vx-token__disc")).toHaveLength(1);
    expect(svg.querySelector(".vex-vx-token__mark path")).not.toBeNull();
  });

  it("defaults to the 24px message mark", () => {
    const { container } = render(<VxToken />);
    expect(svgOf(container).getAttribute("width")).toBe("24");
  });

  it("leaves colour to the sheet", () => {
    const { container } = render(<VxToken />);
    const disc = svgOf(container).querySelector("circle");
    expect(disc?.hasAttribute("fill")).toBe(false);
    expect(disc?.hasAttribute("stroke")).toBe(false);
    expect(container.innerHTML).not.toMatch(/#[0-9a-f]{3,8}\b/i);
  });

  it("is hidden from assistive technology without a label", () => {
    const { container } = render(<VxToken />);
    expect(svgOf(container).getAttribute("aria-hidden")).toBe("true");
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("is a named image with a label", () => {
    render(<VxToken label="Show Vex" />);
    expect(screen.getByRole("img", { name: "Show Vex" })).toBeTruthy();
  });
});
