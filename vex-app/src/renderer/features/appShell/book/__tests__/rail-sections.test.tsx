/**
 * THE BOOK AS A PAGE OF SECTIONS (docs/design/V10-SPREAD.md sections 1 and 2).
 *
 * jsdom paints nothing, so what is pinned here is the CLASS CONTRACT the book
 * sheet is written against (styles/global-css/book.css is plain CSS over these
 * names; e2e measures the painted result in the built app):
 *
 *  - the BOOK rail is `.vex-bk`: paper with one rule, no glass tier, no blur;
 *  - every reading surface in the rail (the PortfolioCard every section
 *    composes, the inspect panel, the Board module) is a `.vex-bs` section or
 *    the page's own body, never a boxed card: no glass class, no radius
 *    utility, no shadow utility, no surface or stroke token of its own.
 */

import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { BookRailFrame } from "../BookRailFrame.js";
import { PortfolioCard } from "../portfolio/PortfolioCard.js";
import { BookInspectPanel } from "../inspect/BookInspectPanel.js";
import { ActiveBoardModule } from "../board/ActiveBoardModule.js";

/** A section is drawn on the paper: no glass, no box, no radius, no shadow. */
function expectSection(node: Element | null, cls: string): void {
  expect(node).not.toBeNull();
  const classes = node?.className ?? "";
  expect(classes).toContain(cls);
  expect(classes).not.toMatch(/vex-glass/);
  expect(classes).not.toMatch(/\bbg-surface-\d\b/);
  expect(classes).not.toMatch(/\bborder-line-\d\b/);
  expect(classes).not.toMatch(/\brounded(-|\b)/);
  expect(classes).not.toMatch(/\bshadow(-|\b)/);
}

describe("the BOOK rail and its sections are drawn on the paper", () => {
  it("the rail frame is the page", () => {
    render(
      <BookRailFrame label="Session instrument" bookOpen onToggle={() => {}}>
        <div />
      </BookRailFrame>,
    );
    const rail = screen.getByLabelText("Session instrument");
    expect(rail.className).toContain("vex-bk");
    expect(rail.className).not.toMatch(/vex-glass|backdrop-blur/);
  });

  it("PortfolioCard is a section", () => {
    render(
      <PortfolioCard eyebrow="Position">
        <span>body</span>
      </PortfolioCard>,
    );
    expectSection(screen.getByRole("region", { name: "Position" }), "vex-bs");
  });

  it("the inspect panel is the page body", () => {
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
    expectSection(document.querySelector('[data-vex-area="book-inspect"]'), "vex-bk__body");
  });

  it("the Board module's empty state is a section", () => {
    render(<ActiveBoardModule />);
    expectSection(document.querySelector('[data-vex-area="active-board"]'), "vex-bs");
  });
});
