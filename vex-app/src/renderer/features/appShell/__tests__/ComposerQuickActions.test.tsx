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
  RocketIcon: "RocketIcon",
}));

const { ComposerQuickActions } = await import("../ComposerQuickActions.js");

describe("ComposerQuickActions", () => {
  it("renders the intent chips with icons, no 01–03 numbering", () => {
    const { container } = render(<ComposerQuickActions onPick={() => {}} />);

    // Three starter chips (memecoins / Pendle yields / Trench launchpad),
    // each a real focusable button.
    const chips = screen.getAllByRole("button");
    expect(chips).toHaveLength(3);

    // Each intent icon is present (flame / percent square / rocket).
    expect(container.querySelector('[data-icon="FireIcon"]')).not.toBeNull();
    expect(
      container.querySelector('[data-icon="PercentSquareIcon"]'),
    ).not.toBeNull();
    expect(container.querySelector('[data-icon="RocketIcon"]')).not.toBeNull();

    // The numbering was dropped — no 01/02/03 marks in the chip text.
    for (const n of ["01", "02", "03"]) {
      expect(screen.queryByText(n)).toBeNull();
    }
    // Sanity: the icon refs are attributes, never rendered text.
    expect(container.textContent).not.toMatch(/\b0[123]\b/);
  });

  it("wears a SOLID ink band on its root — no glass (composer rebuild)", () => {
    const { container } = render(<ComposerQuickActions onPick={() => {}} />);

    // The row's own root (not a new wrapper) carries the surface. It is now
    // OPAQUE ink + a hairline border, matching the rebuilt console above it.
    // The translucent-glass legibility assist is retired, and this file's
    // shell-design-guard exemption was deleted with it — so the ABSENCE of a
    // backdrop filter here is a contract, not an omission.
    const root = container.firstElementChild;
    expect(root).not.toBeNull();
    expect(root?.className).toContain("bg-[var(--vex-surface-1)]");
    expect(root?.className).not.toMatch(/backdrop-blur/);
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
