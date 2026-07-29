/**
 * ComposerQuickActions — the starter chips detached below the Signal Console.
 * Pins the redesign contract: each chip carries a small INTENT ICON, the 01–03
 * numbering is GONE (parallel starters, not an ordered sequence), and picking a
 * chip seeds the draft with its full prompt.
 *
 * VexIcon is stubbed to a span that surfaces the icon reference as a
 * `data-icon` attribute so the per-chip glyph is assertable in jsdom.
 */

import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

vi.mock("../../../components/icons/VexIcon.js", () => ({
  VexIcon: ({ icon }: { icon: unknown }) => (
    <span data-icon={String(icon)} />
  ),
}));

vi.mock("../../../components/icons/icon-glyphs.js", () => ({
  FireIcon: "FireIcon",
  PercentSquareIcon: "PercentSquareIcon",
}));

const { ComposerQuickActions } = await import("../ComposerQuickActions.js");

describe("ComposerQuickActions", () => {
  it("renders the intent chips with icons, no 01–03 numbering", () => {
    const { container } = render(<ComposerQuickActions onPick={() => {}} />);

    // Two starter chips (Hyperliquid deletion retired the perp-market
    // prompt), each a real focusable button.
    const chips = screen.getAllByRole("button");
    expect(chips).toHaveLength(2);

    // Each intent icon is present (flame / percent square).
    expect(container.querySelector('[data-icon="FireIcon"]')).not.toBeNull();
    expect(
      container.querySelector('[data-icon="PercentSquareIcon"]'),
    ).not.toBeNull();

    // The numbering was dropped — no 01/02/03 marks in the chip text.
    for (const n of ["01", "02", "03"]) {
      expect(screen.queryByText(n)).toBeNull();
    }
    // Sanity: the icon refs are attributes, never rendered text.
    expect(container.textContent).not.toMatch(/\b0[123]\b/);
  });

  it("wears the Chronos glass legibility assist on its root", () => {
    const { container } = render(<ComposerQuickActions onPick={() => {}} />);

    // The row's own root (not a new wrapper) carries the glass surface so
    // the chips stay readable over the bright regions of the Eclipse photo
    // backdrop: ink tint + backdrop-blur + hairline border.
    const root = container.firstElementChild;
    expect(root).not.toBeNull();
    expect(root?.className).toContain("bg-[var(--vex-rail)]");
    expect(root?.className).toMatch(/backdrop-blur/);
    expect(root?.className).toContain("border-[var(--vex-line)]");
  });

  it("seeds the draft with the chip's full prompt", () => {
    const onPick = vi.fn();
    render(<ComposerQuickActions onPick={onPick} />);
    fireEvent.click(
      screen.getByRole("button", { name: /hunt trending memecoins/i }),
    );
    expect(onPick).toHaveBeenCalledWith(
      "Hunt the trendiest memecoins right now — combine DexScreener trending narratives with X sentiment if my X account is connected, and propose a plan before any trade.",
    );
  });
});
