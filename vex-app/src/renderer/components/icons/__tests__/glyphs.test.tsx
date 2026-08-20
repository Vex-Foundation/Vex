/**
 * Smoke test for the rebrand glyph set: every exported glyph renders an SVG
 * honoring the shared contract (24 viewBox, size prop on width/height,
 * className passthrough, currentColor paint - no hardcoded fills).
 */

import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import type { JSX } from "react";
import * as glyphs from "../glyphs.js";

type GlyphComponent = (props: {
  size?: number;
  className?: string;
}) => JSX.Element;

const entries = Object.entries(glyphs).filter(
  (pair): pair is [string, GlyphComponent] =>
    pair[0].startsWith("Icon") && typeof pair[1] === "function",
);

describe("icon glyphs", () => {
  it("exports a non-trivial set", () => {
    expect(entries.length).toBeGreaterThan(40);
  });

  it.each(entries.map(([name]) => name))("%s renders per contract", (name) => {
    const Glyph = entries.find(([n]) => n === name)![1];
    const { container } = render(<Glyph size={20} className="probe" />);
    const svg = container.querySelector("svg");
    expect(svg).not.toBeNull();
    expect(svg!.getAttribute("viewBox")).toBe("0 0 24 24");
    expect(svg!.getAttribute("width")).toBe("20");
    expect(svg!.getAttribute("height")).toBe("20");
    expect(svg!.classList.contains("probe")).toBe(true);
    // Paint rides currentColor: no hex/rgb literals anywhere in the glyph.
    expect(svg!.outerHTML).not.toMatch(/#[0-9a-fA-F]{3,8}|rgb\(/);
  });

  it("defaults to 16px when no size is given", () => {
    const { container } = render(<glyphs.IconPlus />);
    const svg = container.querySelector("svg")!;
    expect(svg.getAttribute("width")).toBe("16");
  });
});
