/**
 * VEX's filled glyphs (VEX Cloud's DG-1 set, `glyph/glyph-sprite-data.ts`;
 * docs/design/H3-DESKTOP.md section 4.6): every name has a drawing, every
 * drawing is paths and circles on the 24 grid in one ink, and `Glyph` draws
 * them inline with no sprite to mount.
 */

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Glyph, GLYPH_NAMES } from "../glyph/Glyph.js";
import { GLYPH_SPRITE_DATA } from "../glyph/glyph-sprite-data.js";

describe("the glyph data", () => {
  it("draws every one of the 92 names once, in the names' order", () => {
    expect(GLYPH_NAMES).toHaveLength(92);
    expect(GLYPH_SPRITE_DATA.map((symbol) => symbol.id)).toEqual([...GLYPH_NAMES]);
  });

  it("holds the nav's glyphs and the portrait", () => {
    for (const name of ["rail-ask", "rail-plus", "cube", "rail-chart", "vault", "list", "gear", "portrait", "rail-no"]) {
      expect(GLYPH_NAMES, name).toContain(name);
    }
  });
});

describe("Glyph", () => {
  it("draws its parts inline on the 24 grid in currentColor, decorative, 20 by default", () => {
    const { container } = render(<Glyph name="vault" />);
    const svg = container.querySelector("svg");
    expect(svg?.getAttribute("viewBox")).toBe("0 0 24 24");
    expect(svg?.getAttribute("fill")).toBe("currentColor");
    expect(svg?.getAttribute("width")).toBe("20");
    expect(svg?.getAttribute("aria-hidden")).toBe("true");
    expect(svg?.getAttribute("focusable")).toBe("false");
    expect(svg?.querySelector("use")).toBeNull();
    expect(svg?.querySelector("path")?.getAttribute("fill-rule")).toBe("evenodd");
  });

  it("draws every glyph with paths and circles only, in one ink", () => {
    for (const name of GLYPH_NAMES) {
      const { container, unmount } = render(<Glyph name={name} size={24} className="probe" />);
      const svg = container.querySelector("svg");
      expect(svg?.children.length, name).toBeGreaterThan(0);
      for (const part of svg?.children ?? []) {
        expect(["path", "circle"], name).toContain(part.localName);
        expect(part.getAttribute("fill"), name).toBeNull();
        expect(part.getAttribute("stroke"), name).toBeNull();
      }
      expect(svg?.classList.contains("probe"), name).toBe(true);
      unmount();
    }
  });
});
