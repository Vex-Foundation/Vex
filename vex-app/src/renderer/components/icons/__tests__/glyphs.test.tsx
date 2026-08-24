/**
 * Smoke test for the rebrand glyph set: every exported glyph renders an SVG
 * honoring the shared contract (24 viewBox, size prop on width/height,
 * className passthrough, currentColor paint - no hardcoded fills, and
 * `aria-hidden` so a glyph never enters an accessible name).
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
  it("covers the whole shell vocabulary", () => {
    // The set is the renderer's ONLY icon source since the vendor gate was
    // retired; a drop below this floor means a call site lost its glyph.
    // Floor 81 -> 78 (R2-A, 2026-08-21): the starter-pill glyphs IconFlame,
    // IconPercent and IconRocket retired with their last consumer.
    // 78 -> 77 (2026-08-21): the stroke-drawn IconPanelRightOpen/Close pair
    // merged into one mirrored filled-outline IconPanelRight, so both rail
    // toggles speak the same drawing language.
    expect(entries.length).toBeGreaterThanOrEqual(77);
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
    expect(svg!.getAttribute("aria-hidden")).toBe("true");
    // Paint rides currentColor: no hex/rgb literals anywhere in the glyph.
    expect(svg!.outerHTML).not.toMatch(/#[0-9a-fA-F]{3,8}|rgb\(/);
  });

  it("defaults to 16px when no size is given", () => {
    const { container } = render(<glyphs.IconPlus />);
    const svg = container.querySelector("svg")!;
    expect(svg.getAttribute("width")).toBe("16");
  });
});
