/**
 * THE PORTFOLIO PAGE AND ITS SECTIONS ARE DRAWN ON THE PAPER
 * (docs/design/R3-MINIMAL.md section 9.1).
 *
 * jsdom paints nothing, so what is pinned here is the CLASS CONTRACT the book
 * sheet is written against (styles/global-css/book.css is plain CSS over these
 * names; e2e measures the painted result in the built app):
 *
 *  - every section of the Portfolio page is the `PortfolioCard` chrome: a
 *    region named by its title, `.vex-pf-sec`, with a head (the name, an
 *    optional muted note, an optional mark before the name, an optional link
 *    at the right) and the body under it;
 *  - the reading surfaces that stay (the Board module, and the inspect panel
 *    in the Vex sidebar) are drawn on the same paper;
 *  - none is a boxed card: no glass class, no radius utility, no shadow
 *    utility, no surface or stroke token of its own.
 */

import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { CardStateNote, PortfolioCard, SectionLink } from "../portfolio/PortfolioCard.js";
import { BookInspectPanel } from "../inspect/BookInspectPanel.js";

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

describe("the Portfolio page and its sections are drawn on the paper", () => {
  it("PortfolioCard is a region named by its title, on the paper", () => {
    render(
      <PortfolioCard title="Wallets">
        <span>body</span>
      </PortfolioCard>,
    );
    expectSection(screen.getByRole("region", { name: "Wallets" }), "vex-pf-sec");
  });

  it("the card's note, mark and link do not change its name or its chrome", () => {
    render(
      <PortfolioCard
        title="Lighter account"
        note=" · not in the total above · as of 12:29"
        leading={<span data-testid="mark" />}
        action={<button type="button">Open Lighter</button>}
      >
        <span>body</span>
      </PortfolioCard>,
    );
    // Named by the title alone: the note is a muted aside, not part of the name.
    const region = screen.getByRole("region", { name: "Lighter account" });
    expectSection(region, "vex-pf-sec");
    expect(within(region).getByText("body")).toBeTruthy();
  });

  it("the head is a plain row on the paper: the name, the muted note, the mark and the link", () => {
    render(
      <PortfolioCard
        title="Activity"
        note=" · all wallets"
        leading={<span data-testid="mark" />}
        action={<button type="button">Agent Scan</button>}
      >
        <span>body</span>
      </PortfolioCard>,
    );
    const region = screen.getByRole("region", { name: "Activity" });
    const head = region.querySelector("header");
    expectSection(head, "vex-pf-sec__h");

    const heading = within(region).getByRole("heading", { level: 2 });
    expectSection(heading, "vex-pf-sec__t");
    // The mark leads the name, and the note follows it, inside the heading.
    const mark = within(heading).getByTestId("mark");
    expect(heading.firstElementChild).toBe(mark);
    expect(heading.textContent).toBe("Activity · all wallets");
    expectSection(heading.querySelector(".vex-pf-sec__note"), "vex-pf-sec__note");
    expect(heading.querySelector(".vex-pf-sec__note")?.textContent).toBe(" · all wallets");

    // The link sits at the right of the head, outside the heading.
    const action = head?.querySelector<HTMLElement>(".vex-pf-sec__a") ?? null;
    expectSection(action, "vex-pf-sec__a");
    expect(within(heading).queryByRole("button")).toBeNull();
    expect(within(action ?? region).getByRole("button", { name: "Agent Scan" })).toBeTruthy();
  });

  it("the head renders no note, mark or link wrapper when none is handed in", () => {
    render(
      <PortfolioCard title="Balances">
        <span>body</span>
      </PortfolioCard>,
    );
    const region = screen.getByRole("region", { name: "Balances" });
    expect(region.querySelector(".vex-pf-sec__note")).toBeNull();
    expect(region.querySelector(".vex-pf-sec__a")).toBeNull();
    expect(within(region).getByRole("heading", { level: 2 }).textContent).toBe("Balances");
  });

  it("a null note or link is the same as none", () => {
    render(
      <PortfolioCard title="Balances" note={null} action={null}>
        <span>body</span>
      </PortfolioCard>,
    );
    const region = screen.getByRole("region", { name: "Balances" });
    expect(region.querySelector(".vex-pf-sec__note")).toBeNull();
    expect(region.querySelector(".vex-pf-sec__a")).toBeNull();
  });

  it("the state line and the section link are on the paper too", () => {
    render(
      <PortfolioCard
        title="Activity"
        action={<SectionLink onClick={() => undefined}>Agent Scan</SectionLink>}
      >
        <CardStateNote tone="warn">Couldn&apos;t load activity.</CardStateNote>
      </PortfolioCard>,
    );
    const note = screen.getByText("Couldn't load activity.");
    expectSection(note, "vex-pf-note");
    expect(note.getAttribute("data-tone")).toBe("warn");
    expectSection(screen.getByRole("button", { name: "Agent Scan" }), "vex-pf-link");
  });

  it("a state line is muted unless it says otherwise", () => {
    render(<CardStateNote>Nothing here yet.</CardStateNote>);
    expect(screen.getByText("Nothing here yet.").getAttribute("data-tone")).toBe("muted");
  });

  it("the section link is a button that hands its click to the page", () => {
    const onClick = vi.fn();
    render(<SectionLink onClick={onClick}>Open Lighter</SectionLink>);
    const link = screen.getByRole("button", { name: "Open Lighter" });
    expect(link.getAttribute("type")).toBe("button");
    fireEvent.click(link);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("the section link keeps its visible word unless a longer accessible name is given", () => {
    render(
      <SectionLink onClick={() => undefined} label="Open all assets">
        See all
      </SectionLink>,
    );
    expect(screen.getByRole("button", { name: "Open all assets" }).textContent).toBe("See all");
  });

  // The inspect view moved to the Vex sidebar (docs/design/R3-MINIMAL.md
  // section 5.1); it is still drawn on the paper, never a boxed card.
  it("the inspect panel is drawn on the paper", () => {
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
    expectSection(document.querySelector('[data-vex-area="book-inspect"]'), "vex-vs-inspect");
  });
});
