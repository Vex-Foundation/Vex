/**
 * CHAIN MARKS RENDER BARE - no disc, no ring, on every source.
 *
 * The defect this guards was not in our CSS: the `@thesvg/react` default
 * variants for ethereum, solana and polygon embed a filled `<circle>` (and a
 * drop shadow) behind the mark, and the monogram fallback drew a bordered
 * ring on purpose. Both put a chain icon on a disc, which the owner rejected
 * for every icon on the board (2026-08-26). The catalogue now routes the
 * three disc-bearing package marks to flat local assets, so the assertion
 * runs on both halves: the rendered component tree for package marks, and
 * the asset bytes on disk for the local ones.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { chainDisplayBySlug } from "@shared/chains/display.js";
import { ChainMark, ChainSlugIcon } from "../ChainIcon.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(here, "..", "..", "..", "public");

const CATALOGUED = [
  "ethereum",
  "solana",
  "base",
  "arbitrum",
  "polygon",
  "optimism",
  "bsc",
  "robinhood",
] as const;

describe("ChainMark", () => {
  it.each(CATALOGUED)("draws %s without a disc", (slug) => {
    const display = chainDisplayBySlug(slug);
    if (display.icon.kind === "asset") {
      // Base's brand mark IS a disc by design and stays; every other asset
      // is a flat mark.
      if (slug === "base") return;
      const svg = readFileSync(path.join(publicDir, display.icon.src), "utf8");
      expect(svg, display.icon.src).not.toMatch(/<circle/);
      expect(svg).not.toMatch(/<filter/);
      return;
    }
    const { container } = render(<ChainMark display={display} size={18} />);
    expect(container.querySelector("circle")).toBeNull();
    expect(container.querySelector("filter")).toBeNull();
  });

  it("draws an uncatalogued chain as a bare monogram in the tertiary ink", () => {
    const { container } = render(<ChainSlugIcon chainSlug="sui" size={18} />);
    const mark = container.querySelector('[data-chain-mark="fallback"]');
    expect(mark).not.toBeNull();
    expect(mark?.textContent).toBe("s");
    expect(mark?.className).toContain("uppercase");
    expect(mark?.className).not.toContain("rounded-full");
    expect(mark?.className).not.toContain("border");
    expect(mark?.className).not.toContain("--vex-");
    expect(mark?.className).toContain("text-ink-tertiary");
  });

  it("sizes every mark by the size prop", () => {
    const { container } = render(<ChainSlugIcon chainSlug="ethereum" size={20} />);
    const img = container.querySelector("img");
    expect(img?.getAttribute("width")).toBe("20");
    expect(img?.getAttribute("src")).toBe("/logo/ethereum.svg");
  });
});
