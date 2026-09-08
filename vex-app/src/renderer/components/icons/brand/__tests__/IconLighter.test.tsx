import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { IconLighter } from "../../index.js";

describe("IconLighter", () => {
  it("renders the bare Lighter geometry in inherited ink without a circular coin", () => {
    const { container } = render(<IconLighter size={20} className="probe" />);
    const svg = container.querySelector("svg");
    expect(svg).not.toBeNull();
    if (svg === null) throw new Error("Lighter SVG did not render");
    expect(svg.getAttribute("viewBox")).toBe("12 12 40 40");
    expect(svg.getAttribute("width")).toBe("20");
    expect(svg.getAttribute("height")).toBe("20");
    expect(svg.getAttribute("aria-hidden")).toBe("true");
    expect(svg.classList.contains("probe")).toBe(true);
    expect(svg.querySelectorAll("path")).toHaveLength(1);
    expect(svg.querySelector("circle, mask, linearGradient, [stroke], [style]")).toBeNull();
    expect(svg.outerHTML).not.toMatch(/#[0-9a-fA-F]{3,8}|rgb\(|fill="(?:white|black)"/);
    expect(svg.querySelector('path[fill="currentColor"]')?.getAttribute("d")).toBe(
      "m30.762 43.084-8.137 7.666V21.331l8.137-8.081v29.834Zm10.613.018-8.137 7.648V39.277l8.137-8.058v11.883Z",
    );
  });

  it("defaults to 24px and requires no document-global paint references", () => {
    const { container } = render(<><IconLighter /><IconLighter /></>);
    expect(container.querySelector("[id], [mask], [clip-path]")).toBeNull();
    for (const svg of container.querySelectorAll("svg")) {
      expect(svg.getAttribute("width")).toBe("24");
      expect(svg.getAttribute("height")).toBe("24");
    }
  });
});
