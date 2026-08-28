/**
 * THE BOOK'S PORTFOLIO | BOARD TABS + LIGHTER LAUNCHER (A13).
 *
 * Four laws, and they are the reason this suite is separate from the
 * router's:
 *
 *  - NEVER AUTO-SWITCH. A board arriving while the reader is looking at their
 *    portfolio must not yank the rail out from under them. The arrival lights
 *    a dot and waits. `setBookTab` has exactly one caller, and it is the tab
 *    control.
 *  - KEEP-MOUNTED. Switching to Board and back must not throw away the
 *    Portfolio stack's state (scroll offsets, running queries, card state).
 *    The panel stays in the DOM, hidden and inert.
 *  - THE DOT IS EARNED. It is lit by a LIVE board arrival through the store's
 *    one path, and it clears on both of A13's paths - the module seeing that
 *    board, and that board's modal opening from anywhere.
 *  - LIGHTER IS ONE WORKSPACE. The adjacent launcher publishes the same
 *    renderer-local intent as the `Light it up` command and never changes the
 *    persisted Portfolio/Board selection underneath the dialog.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("../book/PositionBlock.js", () => ({
  PositionBlock: () => <div data-testid="card-position" />,
}));
vi.mock("../book/SessionWalletsCard.js", () => ({
  SessionWalletsCard: () => <div data-testid="card-wallets" />,
}));
vi.mock("../book/portfolio/BalancesCard.js", () => ({
  BalancesCard: () => <div data-testid="card-balances" />,
}));
vi.mock("../book/SessionActivityCard.js", () => ({
  SessionActivityCard: () => <div data-testid="card-activity" />,
}));
vi.mock("../book/SessionBlock.js", () => ({
  SessionBlock: () => <div data-testid="card-session" />,
}));
vi.mock("../book/ImageLockerCard.js", () => ({
  ImageLockerCard: () => <div data-testid="card-images" />,
}));
vi.mock("../../../lib/api/sessions.js", () => ({
  useSession: () => ({ data: undefined }),
}));
vi.mock("../book/portfolio/WelcomePortfolioPanel.js", () => ({
  WelcomePortfolioPanel: () => <div data-testid="welcome-portfolio-panel" />,
}));
// The module has its own suite; here the tab only has to prove it mounts the
// Board instrument and nothing else.
vi.mock("../book/board/ActiveBoardModule.js", () => ({
  ActiveBoardModule: () => <div data-testid="active-board-module" />,
}));

const { BookPanel } = await import("../BookPanel.js");
const { useUiStore } = await import("../../../stores/uiStore.js");
const { useBoardSurfaceStore } = await import(
  "../Board/board-surface-store.js"
);
const { boardRefOf } = await import("../Board/board-surface-contracts.js");
const { boardSpec } = await import("../Board/__tests__/boardFixture.js");
const { subscribeLighterWorkspaceOpen } = await import(
  "../lighterTrading/workspace-command.js"
);

const SESSION = "00000000-0000-4000-8000-00000000dddd";

function board(messageId = 12) {
  return boardRefOf(SESSION, messageId, boardSpec({ title: "Token Radar" }));
}

function renderRail() {
  return render(
    <BookPanel activeSessionId={SESSION} bookOpen onToggle={() => {}} />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  useUiStore.setState({ bookSectionOrder: [], bookTab: "portfolio" });
  useBoardSurfaceStore.setState({
    latestBoard: null,
    pinnedBoard: null,
    modalBoard: null,
    unseenBoardKey: null,
  });
});

afterEach(cleanup);

describe("BOOK tabs", () => {
  it("opens on Portfolio and shows the card stack", () => {
    renderRail();
    const portfolio = screen.getByRole("tab", { name: /Portfolio/ });
    expect(portfolio.getAttribute("aria-selected")).toBe("true");
    expect(screen.queryByTestId("card-position")).not.toBeNull();
  });

  it("scopes its tab and panel ids so a nested tab set cannot claim them", () => {
    renderRail();
    expect(screen.getByRole("tab", { name: /Portfolio/ }).id).toBe(
      "tab-book-portfolio",
    );
    expect(
      screen.getByRole("tab", { name: /Board/ }).getAttribute("aria-controls"),
    ).toBe("tabpanel-book-board");
  });

  it("keeps the Portfolio panel MOUNTED across a switch, hidden and inert", () => {
    renderRail();
    fireEvent.click(screen.getByRole("tab", { name: /Board/ }));

    expect(screen.queryByTestId("active-board-module")).not.toBeNull();
    // The stack is still there - its state was not thrown away.
    const stack = screen.getByTestId("card-position");
    expect(stack).not.toBeNull();
    const panel = document.getElementById("tabpanel-book-portfolio");
    expect(panel?.hasAttribute("hidden")).toBe(true);
    expect(panel?.getAttribute("aria-hidden")).toBe("true");
    expect(panel?.hasAttribute("inert")).toBe(true);
  });

  it("persists the reader's choice through the ui store", () => {
    renderRail();
    fireEvent.click(screen.getByRole("tab", { name: /Board/ }));
    expect(useUiStore.getState().bookTab).toBe("board");
    fireEvent.click(screen.getByRole("tab", { name: /Portfolio/ }));
    expect(useUiStore.getState().bookTab).toBe("portfolio");
  });

  it("shows Lighter as the third option and opens the shared trading dialog", () => {
    const onOpen = vi.fn();
    const unsubscribe = subscribeLighterWorkspaceOpen(onOpen);
    renderRail();

    const instruments = screen.getByRole("group", { name: "Book instruments" });
    const lighter = screen.getByRole("button", { name: "Lighter" });
    expect(instruments.lastElementChild).toBe(lighter);
    expect(lighter.getAttribute("aria-haspopup")).toBe("dialog");

    fireEvent.click(screen.getByRole("tab", { name: /Board/ }));
    fireEvent.click(lighter);

    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(useUiStore.getState().bookTab).toBe("board");
    expect(
      screen.getByRole("tab", { name: /Board/ }).getAttribute("aria-selected"),
    ).toBe("true");
    unsubscribe();
  });

  it("NEVER auto-switches: a live board arrival lights the dot and nothing else", () => {
    renderRail();
    expect(document.querySelector('[data-vex-area="book-board-unseen"]')).toBeNull();

    fireEvent.click(screen.getByRole("tab", { name: /Portfolio/ }));
    act(() => {
      useBoardSurfaceStore.getState().noteBoardRow(board(), "live-append");
    });

    expect(useUiStore.getState().bookTab).toBe("portfolio");
    expect(
      screen.getByRole("tab", { name: /Portfolio/ }).getAttribute("aria-selected"),
    ).toBe("true");
    expect(
      document.querySelector('[data-vex-area="book-board-unseen"]'),
    ).not.toBeNull();
    // Spoken, not only painted.
    expect(screen.getByRole("tab", { name: /Board/ }).textContent).toContain(
      "new board",
    );
  });

  it("does not light the dot for a board that merely mounted from history", () => {
    renderRail();
    act(() => {
      useBoardSurfaceStore.getState().noteBoardRow(board(), "settled");
    });
    expect(document.querySelector('[data-vex-area="book-board-unseen"]')).toBeNull();
    expect(useBoardSurfaceStore.getState().latestBoard).not.toBeNull();
  });

  it("clears the dot when that board's modal opens from anywhere (A13 path b)", () => {
    renderRail();
    const ref = board();
    act(() => {
      useBoardSurfaceStore.getState().noteBoardRow(ref, "live-append");
    });
    expect(
      document.querySelector('[data-vex-area="book-board-unseen"]'),
    ).not.toBeNull();

    act(() => {
      useBoardSurfaceStore.getState().openBoardModal(ref);
    });
    expect(useBoardSurfaceStore.getState().unseenBoardKey).toBeNull();
    expect(document.querySelector('[data-vex-area="book-board-unseen"]')).toBeNull();
  });
});
