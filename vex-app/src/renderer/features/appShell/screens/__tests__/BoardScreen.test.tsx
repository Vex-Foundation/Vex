/**
 * BoardScreen - the `board` page in the centre column (docs/design/
 * R3-MINIMAL.md section 9.4). The page only lends the shell-level board host
 * its element; these cases pin that the board lands inside the page, that the
 * page binds the pinned board else the latest one of the open session, and
 * that with neither it says so and names the next step.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { JSX } from "react";
import { useUiStore } from "../../../../stores/uiStore.js";
import { BoardModalHost } from "../../Board/BoardModalHost.js";
import {
  BOARD_FILTER_NONE,
  useBoardSurfaceStore,
} from "../../Board/board-surface-store.js";
import {
  boardRefOf,
  type BoardGridSlotProps,
  type BoardRef,
} from "../../Board/board-surface-contracts.js";
import { boardSpec } from "../../Board/__tests__/boardFixture.js";
import { BOARD_PAGE_EMPTY, BOARD_PAGE_EMPTY_ACTION, BoardScreen } from "../BoardScreen.js";

function ref(sessionId: string, messageId: number): BoardRef {
  return boardRefOf(
    sessionId,
    messageId,
    boardSpec({
      title: `board ${String(messageId)}`,
      pools: [{ chain: "base", pairAddress: "0xaaa111", analysis: null }],
    }),
  );
}

function GridStub({ board }: BoardGridSlotProps): JSX.Element {
  return <p data-testid="grid">{board.title}</p>;
}

function resetStores(sessionId: string | null): void {
  useBoardSurfaceStore.setState({
    latestBoard: null,
    pinnedBoard: null,
    modalBoard: null,
    unseenBoardKey: null,
    surfaceKey: null,
    view: "grid",
    selectedPoolIndex: 0,
    filter: BOARD_FILTER_NONE,
    scrollTop: 0,
    askPanelOpen: false,
    liveRequested: false,
    modalGeneration: 0,
    spotlightGeneration: 0,
  });
  useUiStore.setState({
    activeSessionId: sessionId,
    runtimeMode: "agent",
    shellRoute: { kind: "board", origin: null },
  });
}

function mount(): void {
  render(
    <>
      <BoardModalHost gridSlot={GridStub} />
      <BoardScreen origin={null} onClose={vi.fn()} />
    </>,
  );
}

afterEach(() => {
  cleanup();
  resetStores(null);
});

describe("BoardScreen", () => {
  it("is a page named Board, and the board the host binds lands inside it", () => {
    resetStores("s1");
    act(() => {
      useBoardSurfaceStore.getState().noteBoardRow(ref("s1", 12), "settled");
    });
    mount();
    const page = screen.getByRole("dialog", { name: "Board" });
    const grid = screen.getByTestId("grid");
    expect(page.contains(grid)).toBe(true);
    expect(grid.textContent).toBe("board 12");
    expect(
      document.querySelector('[data-vex-area="board-page"]')?.getAttribute("data-state"),
    ).toBe("board");
  });

  it("opens the pinned board before a newer one", () => {
    resetStores("s1");
    act(() => {
      const store = useBoardSurfaceStore.getState();
      store.noteBoardRow(ref("s1", 14), "settled");
      store.pinBoard(ref("s1", 12));
    });
    mount();
    expect(screen.getByTestId("grid").textContent).toBe("board 12");
  });

  it("says there is no board yet, and the next step goes to the chat", () => {
    resetStores("s1");
    mount();
    expect(screen.queryByTestId("grid")).toBeNull();
    const empty = document.querySelector('[data-vex-area="board-page-empty"]');
    expect(empty?.textContent).toContain(BOARD_PAGE_EMPTY);
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: BOARD_PAGE_EMPTY_ACTION }));
    });
    expect(useUiStore.getState().shellRoute.kind).toBe("none");
    expect(useUiStore.getState().runtimeMode).toBe("agent");
  });

  it("never shows another session's board", () => {
    resetStores("s1");
    act(() => {
      useBoardSurfaceStore.setState({ latestBoard: ref("s9", 3) });
    });
    mount();
    expect(screen.queryByTestId("grid")).toBeNull();
    expect(document.querySelector('[data-vex-area="board-page-empty"]')).not.toBeNull();
  });

  it("closes the board when the page is left", () => {
    resetStores("s1");
    act(() => {
      useBoardSurfaceStore.getState().noteBoardRow(ref("s1", 12), "settled");
    });
    mount();
    expect(useBoardSurfaceStore.getState().modalBoard).not.toBeNull();
    act(() => {
      useUiStore.setState({ shellRoute: { kind: "none" } });
    });
    expect(useBoardSurfaceStore.getState().modalBoard).toBeNull();
  });
});
