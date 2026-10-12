/**
 * The pixel sprite is the only icon source: every legacy `Icon*` export must
 * resolve to a symbol that exists in `px/sprite.svg`, the generated name list
 * must match the sprite, and the glyph contract (aria-hidden, currentColor,
 * crisp edges, size and className passthrough) must hold.
 */

import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import type { JSX } from "react";
import * as icons from "../index.js";
import { PX_NAMES } from "../px/px-names.js";
import { PxIcon } from "../px/PxIcon.js";
import SPRITE from "../px/sprite.svg?raw";

const SPRITE_IDS = [...SPRITE.matchAll(/<symbol id="px-([a-z0-9-]+)"/g)].map((m) => m[1]);

type Glyph = (props: { size?: number; className?: string }) => JSX.Element;
const BRAND = new Set(["IconLighter", "IconSuperboard"]);
const glyphs = Object.entries(icons).filter(
  (pair): pair is [string, Glyph] =>
    pair[0].startsWith("Icon") && !BRAND.has(pair[0]) && typeof pair[1] === "function",
);

const hrefOf = (G: Glyph): string | null =>
  render(<G />).container.querySelector("use")?.getAttribute("href") ?? null;

describe("px sprite", () => {
  it("holds 109 symbols and px-names.ts lists exactly them", () => {
    expect(SPRITE_IDS).toHaveLength(109);
    expect([...PX_NAMES].sort()).toEqual([...SPRITE_IDS].sort());
  });

  it("mounts without a style attribute (CSP style-src 'self')", () => {
    const { container } = render(<icons.PxSprite />);
    expect(container.querySelector("[style]")).toBeNull();
    expect(container.querySelectorAll("symbol")).toHaveLength(109);
  });

  it("renders PxIcon at 16 and 24 as currentColor crisp pixels", () => {
    for (const size of [16, 24] as const) {
      const { container } = render(<PxIcon name="lock" size={size} className="x" />);
      const svg = container.querySelector("svg");
      expect(svg?.getAttribute("width")).toBe(String(size));
      expect(svg?.getAttribute("fill")).toBe("currentColor");
      expect(svg?.getAttribute("shape-rendering")).toBe("crispEdges");
      expect(svg?.getAttribute("aria-hidden")).toBe("true");
      expect(svg?.getAttribute("class")).toBe("x");
    }
  });

  // The legacy Icon* wrappers are retired as their last call sites move to
  // PxIcon, so their count only shrinks; every survivor must still resolve.
  it("still has legacy exports to check", () => {
    expect(glyphs.length).toBeGreaterThan(0);
  });

  it.each(glyphs)("%s resolves to a symbol in the sprite", (name, Glyph) => {
    const { container } = render(<Glyph size={16} className="c" />);
    const href = container.querySelector("use")?.getAttribute("href") ?? "";
    expect(href.startsWith("#px-"), name).toBe(true);
    expect(SPRITE_IDS, name).toContain(href.slice(4));
    expect(container.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
  });

  it("maps the changed meanings", () => {
    expect(hrefOf(icons.pxGlyph("shield-alert"))).toBe("#px-shield-alert");
    expect(hrefOf(icons.IconShieldCheck)).toBe("#px-approvals");
    expect(hrefOf(icons.IconInspect)).toBe("#px-history");
  });
});
