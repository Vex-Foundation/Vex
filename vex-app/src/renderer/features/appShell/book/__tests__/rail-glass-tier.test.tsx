/**
 * THE GLAZE ON THE RAIL'S CARDS (owner decision 2026-09-04: the Settings
 * glaze on every plain card in chronos, the same class in celeris).
 *
 * jsdom paints nothing, so what is pinned here is the CLASS CONTRACT the
 * glass sheet is written against (styles/global-css/__tests__/glass-tokens
 * .test.ts pins the sheet itself, and e2e/studio-states.rail-parity.ts
 * measures the painted result in the built app):
 *
 *  - the BOOK rail is a `.vex-glass-rail`: the ONE backdrop filter over the
 *    wall, which is what lets every card inside it be a plate;
 *  - every reading surface in the rail - the PortfolioCard every section
 *    composes, the inspect panel, the Board module - is a `.vex-glass-card`
 *    and paints no opaque surface token and no stroke of its own.
 */

import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { BookRailFrame } from "../BookRailFrame.js";
import { PortfolioCard } from "../portfolio/PortfolioCard.js";
import { BookInspectPanel } from "../inspect/BookInspectPanel.js";
import { ActiveBoardModule } from "../board/ActiveBoardModule.js";

/** A card is glass, and not the solid plate it replaced. */
function expectGlassCard(node: Element | null): void {
  expect(node).not.toBeNull();
  const classes = node?.className ?? "";
  expect(classes).toContain("vex-glass-card");
  expect(classes).not.toMatch(/\bbg-surface-\d\b/);
  expect(classes).not.toMatch(/\bborder-line-\d\b/);
}

describe("the BOOK rail and its cards wear the glass tiers", () => {
  it("the rail frame is the filtering tier", () => {
    render(
      <BookRailFrame label="Session instrument" bookOpen onToggle={() => {}}>
        <div />
      </BookRailFrame>,
    );
    const rail = screen.getByLabelText("Session instrument");
    expect(rail.className).toContain("vex-glass-rail");
    expect(rail.className).not.toContain("backdrop-blur");
  });

  it("PortfolioCard is a glass card", () => {
    render(
      <PortfolioCard eyebrow="Position">
        <span>body</span>
      </PortfolioCard>,
    );
    expectGlassCard(screen.getByRole("region", { name: "Position" }));
  });

  it("the inspect panel is a glass card", () => {
    render(
      <BookInspectPanel
        inspect={{
          sessionId: "00000000-0000-4000-8000-00000000dddd",
          callKey: "msg-1:0",
          toolName: "portfolio_read",
          status: "done",
          args: { scope: "global" },
        }}
      />,
    );
    expectGlassCard(document.querySelector('[data-vex-area="book-inspect"]'));
  });

  it("the Board module's empty state is a glass card", () => {
    render(<ActiveBoardModule />);
    expectGlassCard(document.querySelector('[data-vex-area="active-board"]'));
  });
});
