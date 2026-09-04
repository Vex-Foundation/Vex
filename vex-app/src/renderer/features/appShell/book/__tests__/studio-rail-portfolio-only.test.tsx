/**
 * The Studio project rail shows PORTFOLIO ONLY (owner decision 2026-09-04:
 * "in Vex Studio's right sidebar we show only Portfolio; Board disappears").
 *
 * The VS Code `viewPaneContainer` shape: one container hosts the same panes
 * in two locations, and a pane a location cannot host is not registered
 * there rather than shown empty. Pinned here:
 *
 *  - a PROJECT rail mounts no tab strip and no board surface, only the stack;
 *  - a stored Board preference (the session rail's) does not put the project
 *    rail on a tab it does not have, and the project rail does not clear it -
 *    the session rail comes back on the tab the user left it on;
 *  - a SESSION rail keeps its toggle and its Board, unchanged.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("../PositionBlock.js", () => ({
  PositionBlock: () => <div data-testid="card-position" />,
}));
vi.mock("../WalletPairCard.js", () => ({
  WalletPairCard: () => <div data-testid="card-wallets" />,
}));
vi.mock("../portfolio/BalancesCard.js", () => ({
  BalancesCard: () => <div data-testid="card-balances" />,
}));
vi.mock("../SessionActivityCard.js", () => ({
  SessionActivityCard: () => <div data-testid="card-activity" />,
}));
vi.mock("../SessionBlock.js", () => ({
  SessionBlock: () => <div data-testid="card-session" />,
}));
vi.mock("../ProjectBlock.js", () => ({
  ProjectBlock: () => <div data-testid="card-project" />,
}));
vi.mock("../ImageLockerCard.js", () => ({
  ImageLockerCard: () => <div data-testid="card-images" />,
}));
vi.mock("../board/ActiveBoardModule.js", () => ({
  ActiveBoardModule: () => <div data-testid="board-module" />,
}));

const { BookRailStack } = await import("../BookRailStack.js");
const { useUiStore } = await import("../../../../stores/uiStore.js");

const SESSION = "00000000-0000-4000-8000-00000000dddd";
const PROJECT = "00000000-0000-4000-8000-00000000aaaa";

beforeEach(() => {
  window.localStorage.clear();
  useUiStore.setState({
    bookSectionOrder: [],
    studioBookSectionOrder: [],
    bookTab: "portfolio",
  });
});

describe("the Studio project rail shows Portfolio only", () => {
  it("mounts the stack with no tab strip and no board surface", () => {
    render(<BookRailStack scope={{ kind: "project", projectId: PROJECT }} />);
    expect(screen.queryAllByRole("tab")).toHaveLength(0);
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.queryByTestId("board-module")).toBeNull();
    expect(
      document.querySelector('[data-vex-area="active-board"]'),
    ).toBeNull();
    // The instrument it does have, seated directly in the instruments box.
    const instruments = document.querySelector(
      '[data-vex-area="book-instruments"][data-vex-rail-scope="project"]',
    );
    expect(instruments).not.toBeNull();
    expect(screen.getByRole("list")).toBeTruthy();
    for (const card of ["card-position", "card-wallets", "card-balances", "card-project"]) {
      expect(screen.getByTestId(card)).toBeTruthy();
    }
  });

  it("ignores a stored Board preference without clearing it", () => {
    useUiStore.setState({ bookTab: "board" });
    render(<BookRailStack scope={{ kind: "project", projectId: PROJECT }} />);
    expect(screen.queryByTestId("board-module")).toBeNull();
    expect(screen.getByTestId("card-position")).toBeTruthy();
    // Session-only in effect, untouched in storage: the session rail owns it.
    expect(useUiStore.getState().bookTab).toBe("board");
  });
});

describe("the Agent session rail keeps its toggle and its Board", () => {
  it("offers both tabs and honours the stored preference", () => {
    useUiStore.setState({ bookTab: "board" });
    render(<BookRailStack scope={{ kind: "session", sessionId: SESSION }} />);
    expect(screen.getByRole("tab", { name: "Portfolio" })).toBeTruthy();
    expect(
      screen.getByRole("tab", { name: "Board" }).getAttribute("aria-selected"),
    ).toBe("true");
    expect(screen.getByTestId("board-module")).toBeTruthy();
  });
});
