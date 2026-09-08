import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { IconLighter } from "../IconLighter.js";

describe("IconLighter", () => {
  it("renders the shipped Lighter mark with brand paint and glyph props", () => {
    const { container } = render(<IconLighter size={32} className="probe" />);
    const svg = container.querySelector("svg");
    expect(svg).not.toBeNull();
    if (svg === null) throw new Error("Lighter SVG did not render");
    expect(svg.getAttribute("viewBox")).toBe("0 0 64 64");
    expect(svg.getAttribute("width")).toBe("32");
    expect(svg.getAttribute("height")).toBe("32");
    expect(svg.getAttribute("aria-hidden")).toBe("true");
    expect(svg.classList.contains("probe")).toBe(true);
    expect(svg.querySelectorAll("linearGradient")).toHaveLength(2);
    expect(svg.querySelectorAll("stop")).toHaveLength(8);
    expect(svg.outerHTML).toContain("#121218");
    expect(svg.outerHTML).toContain("#B3B3BD");
    expect(svg.querySelector('g path[fill="white"]')?.getAttribute("d")).toBe(
      "m30.762 43.084-8.137 7.666V21.331l8.137-8.081v29.834Zm10.613.018-8.137 7.648V39.277l8.137-8.058v11.883Z",
    );
  });

  it("defaults to 24px and keeps paint references local to each instance", () => {
    const { container } = render(<><IconLighter /><IconLighter /></>);
    const ids = Array.from(container.querySelectorAll("[id]"), (node) => node.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const svg of container.querySelectorAll("svg")) {
      expect(svg.getAttribute("width")).toBe("24");
      expect(svg.getAttribute("height")).toBe("24");
      const localIds = Array.from(svg.querySelectorAll("[id]"), (node) => node.id);
      for (const element of svg.querySelectorAll("[mask], [fill], [stroke]")) {
        for (const name of ["mask", "fill", "stroke"]) {
          const value = element.getAttribute(name);
          if (value?.startsWith("url(#")) {
            expect(localIds).toContain(value.slice(5, -1));
          }
        }
      }
    }
  });
});
