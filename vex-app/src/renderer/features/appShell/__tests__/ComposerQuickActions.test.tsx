/**
 * ComposerQuickActions - the starter chips detached below the Signal Console.
 * Pins the round-2 contract: a chip is its LABEL AND NOTHING ELSE (owner QA
 * removed the leading intent glyphs), the 01-03 numbering is GONE (parallel
 * starters, not an ordered sequence), and picking a chip seeds the draft with
 * its full prompt.
 */

import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ComposerQuickActions } from "../ComposerQuickActions.js";

describe("ComposerQuickActions", () => {
  it("renders three text-only chips - no leading glyph, no 01-03 numbering", () => {
    const { container } = render(<ComposerQuickActions onPick={() => {}} />);

    // Three starter chips (memecoins / Pendle yields / Trench launchpad),
    // each a real focusable button.
    const chips = screen.getAllByRole("button");
    expect(chips).toHaveLength(3);

    // A chip renders its label and no glyph beside it.
    for (const chip of chips) {
      expect(chip.querySelector("svg")).toBeNull();
      expect(chip.childElementCount).toBe(1);
    }

    // The numbering was dropped - no 01/02/03 marks in the chip text.
    for (const n of ["01", "02", "03"]) {
      expect(screen.queryByText(n)).toBeNull();
    }
    expect(container.textContent).not.toMatch(/\b0[123]\b/);
  });

  it("renders bare capsule chips - no band, no glass behind the row (tokens v2)", () => {
    const { container } = render(<ComposerQuickActions onPick={() => {}} />);

    // The row root carries NO surface of its own: the chips are the surface
    // (capsule geometry, hairline border). No backdrop filter anywhere.
    const root = container.firstElementChild;
    expect(root).not.toBeNull();
    expect(root?.className).not.toMatch(/bg-|backdrop-blur/);
    const chip = root?.querySelector("button");
    expect(chip?.className).toContain("rounded-capsule");
    expect(chip?.className).toContain("border-line-2");
  });

  it("seeds the draft with the chip's full prompt", () => {
    const onPick = vi.fn();
    render(<ComposerQuickActions onPick={onPick} />);
    fireEvent.click(
      screen.getByRole("button", { name: /hunt trending memecoins/i }),
    );
    expect(onPick).toHaveBeenCalledWith(
      "Hunt the trendiest memecoins right now - combine DexScreener trending narratives with X sentiment if my X account is connected, and propose a plan before any trade.",
    );
  });
});
