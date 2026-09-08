import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { IconSuperboard } from "../IconSuperboard.js";

describe("IconSuperboard", () => {
  it("renders the Superboard wordmark with brand fills", () => {
    const { container } = render(<IconSuperboard size={36} className="probe" />);
    const svg = container.querySelector("svg");
    expect(svg).not.toBeNull();
    if (svg === null) throw new Error("Superboard glyph did not render");
    expect(svg.getAttribute("viewBox")).toBe("0 0 48 31");
    expect(svg.getAttribute("width")).toBe("36");
    expect(svg.getAttribute("aria-hidden")).toBe("true");
    expect(svg.classList.contains("probe")).toBe(true);
    expect(svg.outerHTML).toContain("#9af6c1");
    expect(svg.outerHTML).toContain("#27104a");
  });
});
