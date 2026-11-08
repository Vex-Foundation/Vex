/**
 * PageBar - the H3 page frame's tabs row (docs/design/H3-DESKTOP.md section
 * 1.9): the page's tabs as cells, "Updated {time}" from the page's real
 * refresh time, the page's keys beside it.
 *
 * Pins:
 *   - the tabs are a labelled group of toggle buttons, the selected one
 *     pressed, a press handing the tab's key to the page; words stay in
 *     sentence case in the DOM (the sheet sets the caps);
 *   - the stamp is the local clock of the time it is handed, and is ABSENT
 *     for a read that has not answered (0, null): never a render-time clock;
 *   - a page with no tabs, no stamp and no keys draws no row at all;
 *   - `ShellScreen` mounts the row above the page's scroller, outside it, so
 *     it never scrolls away, and marks the sheet as the H3 frame.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { PageBar, PageTabs, UpdatedStamp, hasPageBar } from "../PageBar.js";
import { ShellScreen } from "../ShellScreen.js";

afterEach(() => {
  cleanup();
});

/** Local 14:30:05 on 3 November 2026: the stamp reads "14:30". */
const AT = new Date(2026, 10, 3, 14, 30, 5).getTime();

const TABS = [
  { key: "all", label: "All wallets" },
  { key: "wallet:1", label: "Main wallet", detail: "Primary", title: "0x1111" },
];

describe("PageTabs", () => {
  it("is a labelled group of toggle buttons with the selected one pressed", () => {
    render(<PageTabs label="Portfolio scope" tabs={TABS} selectedKey="all" onSelect={vi.fn()} />);
    const group = screen.getByRole("group", { name: "Portfolio scope" });
    const buttons = within(group).getAllByRole("button");
    expect(buttons.map((button) => button.getAttribute("aria-pressed"))).toEqual(["true", "false"]);
    // Sentence case in the DOM: the sheet uppercases, a reader reads words.
    expect(buttons.map((button) => button.textContent)).toEqual([
      "All wallets",
      "Main wallet · Primary",
    ]);
    expect(buttons[1]?.getAttribute("title")).toBe("0x1111");
  });

  it("hands the pressed tab's key to the page", () => {
    const onSelect = vi.fn();
    render(<PageTabs label="Portfolio scope" tabs={TABS} selectedKey="all" onSelect={onSelect} />);
    fireEvent.click(screen.getByRole("button", { name: /Main wallet/ }));
    expect(onSelect).toHaveBeenCalledWith("wallet:1");
  });
});

describe("UpdatedStamp", () => {
  it("reads the local clock of the time it is handed", () => {
    render(<UpdatedStamp at={AT} />);
    expect(document.querySelector('[data-vex-area="page-updated"]')?.textContent).toBe(
      "Updated 14:30",
    );
  });

  it.each([0, null, undefined, Number.NaN])("draws nothing for a read that has not answered (%s)", (at) => {
    render(<UpdatedStamp at={at} />);
    expect(document.querySelector('[data-vex-area="page-updated"]')).toBeNull();
  });
});

describe("PageBar", () => {
  it("draws the tabs, then the stamp and the keys at its end", () => {
    render(
      <PageBar
        tabs={<PageTabs label="Scope" tabs={TABS} selectedKey="all" onSelect={vi.fn()} />}
        updatedAt={AT}
        keys={<button type="button">Refresh</button>}
      />,
    );
    const row = document.querySelector('[data-vex-area="page-tabs-row"]');
    if (!(row instanceof HTMLElement)) throw new Error("missing the row");
    const end = row.querySelector(".vex-pg-bar__end");
    expect(within(row).getByRole("group", { name: "Scope" })).not.toBeNull();
    expect(end?.textContent).toBe("Updated 14:30Refresh");
  });

  it("draws no row with nothing to put in it", () => {
    render(<PageBar tabs={null} updatedAt={0} />);
    expect(document.querySelector('[data-vex-area="page-tabs-row"]')).toBeNull();
    expect(hasPageBar({})).toBe(false);
    expect(hasPageBar({ updatedAt: AT })).toBe(true);
    expect(hasPageBar({ keys: <span /> })).toBe(true);
  });
});

describe("ShellScreen - the H3 frame", () => {
  it("marks the sheet as the H3 frame and stands the row above the scroller", () => {
    render(
      <ShellScreen
        title="Portfolio"
        origin={null}
        onClose={vi.fn()}
        chapter={null}
        bar={<PageBar updatedAt={AT} />}
      >
        <p>body</p>
      </ShellScreen>,
    );
    const sheet = screen.getByRole("region", { name: "Portfolio" });
    expect(sheet.getAttribute("data-frame")).toBe("h3");
    const row = sheet.querySelector('[data-vex-area="page-tabs-row"]');
    const scroller = sheet.querySelector(".vex-ov__scroll");
    if (row === null || scroller === null) throw new Error("missing the row or the scroller");
    // A child of the sheet before the scroller, never inside it.
    expect(row.parentElement).toBe(sheet);
    expect(scroller.contains(row)).toBe(false);
    expect(row.compareDocumentPosition(scroller)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it("draws no row for a page that hands none", () => {
    render(
      <ShellScreen title="Memory" origin={null} onClose={vi.fn()}>
        <p>notes</p>
      </ShellScreen>,
    );
    expect(document.querySelector('[data-vex-area="page-tabs-row"]')).toBeNull();
  });
});
