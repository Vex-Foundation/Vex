/**
 * THE ONE BOARD HOST (A3), presented as the Board page.
 *
 * The experiment that matters here is the one a long-lived surface makes easy
 * to get wrong: a board that "closed" could keep a chart subscribed and a
 * tape polling behind a page nobody is looking at. The probe child below is
 * the instrument - it reports its own mount and unmount, and it registers a
 * feed the store must cut. The page and the Vex sidebar only lend the host
 * their elements (`board-page-slot.ts`, `vex-sidebar-slot.ts`); the stand-ins
 * below are those elements.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { useEffect, type JSX } from "react";
import { BoardModalHost } from "../BoardModalHost.js";
import {
  BOARD_FILTER_NONE,
  registerBoardSurfaceTeardown,
  useBoardSurfaceStore,
} from "../board-surface-store.js";
import { boardRefOf, type BoardRef } from "../board-surface-contracts.js";
import { setBoardPageSlot } from "../board-page-slot.js";
import { setVexSidebarSlot } from "../../../vex/vex-sidebar-slot.js";
import { useUiStore } from "../../../../stores/uiStore.js";
import { boardSpec } from "./boardFixture.js";

/** The page's element and, when asked, the open Vex sidebar's slot. */
function Places({ sidebar = true }: { readonly sidebar?: boolean }): JSX.Element {
  return (
    <>
      <div data-testid="page" ref={setBoardPageSlot} />
      {sidebar ? <aside data-testid="sidebar" ref={setVexSidebarSlot} /> : null}
    </>
  );
}

function ref(sessionId: string, messageId: number): BoardRef {
  return boardRefOf(
    sessionId,
    messageId,
    boardSpec({
      title: `board ${String(messageId)}`,
      pools: [
        { chain: "base", pairAddress: "0xaaa111", analysis: null },
        { chain: "base", pairAddress: "0xbbb222", analysis: null },
      ],
    }),
  );
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
  useUiStore.setState({ activeSessionId: sessionId, shellRoute: { kind: "none" } });
}

/** A slot that records its own lifetime and owns a feed the store must cut. */
function probeSlot(lifetime: {
  mounted: number;
  unmounted: number;
  cut: () => void;
}) {
  return function Probe(): JSX.Element {
    useEffect(() => {
      lifetime.mounted += 1;
      const unregister = registerBoardSurfaceTeardown(
        "modal",
        "probe-feed",
        lifetime.cut,
      );
      return () => {
        lifetime.unmounted += 1;
        unregister();
      };
    }, []);
    return <p data-testid="probe">probe body</p>;
  };
}

function newLifetime(): { mounted: number; unmounted: number; cut: () => void } {
  return { mounted: 0, unmounted: 0, cut: vi.fn() };
}

/** The title the head row PAINTS. */
function visibleTitle(text: string): HTMLElement {
  const header = document.querySelector('[data-vex-area="board-header"]');
  const found = screen
    .getAllByText(text)
    .find((node) => header?.contains(node) === true);
  if (found === undefined) throw new Error(`no painted title ${text}`);
  return found;
}

afterEach(() => {
  cleanup();
  resetStores(null);
});

describe("BoardModalHost mounting", () => {
  it("renders nothing about a board until one is bound", () => {
    resetStores("s1");
    render(
      <>
        <BoardModalHost gridSlot={probeSlot(newLifetime())} />
        <Places />
      </>,
    );
    expect(screen.queryByTestId("probe")).toBeNull();
  });

  it("mounts the grid slot when a board is bound, and UNMOUNTS it on close", () => {
    resetStores("s1");
    const lifetime = newLifetime();
    render(
      <>
        <BoardModalHost gridSlot={probeSlot(lifetime)} />
        <Places />
      </>,
    );

    act(() => {
      useBoardSurfaceStore.getState().openBoardModal(ref("s1", 12));
    });
    expect(screen.getByTestId("probe")).toBeTruthy();
    expect(lifetime.mounted).toBe(1);

    act(() => {
      useBoardSurfaceStore.getState().closeBoardModal();
    });
    // The page's element survives; what the host rendered into it must not,
    // or the feed would live on invisibly.
    expect(screen.queryByTestId("probe")).toBeNull();
    expect(lifetime.unmounted).toBe(1);
    expect(lifetime.cut).toHaveBeenCalledTimes(1);
  });

  it("mounts the subtitle slot under the model's title, and unmounts it on close", () => {
    resetStores("s1");
    const lifetime = newLifetime();
    render(
      <>
        <BoardModalHost
          subtitleSlot={probeSlot(lifetime)}
          gridSlot={probeSlot(newLifetime())}
        />
        <Places />
      </>,
    );

    act(() => {
      useBoardSurfaceStore.getState().openBoardModal(ref("s1", 12));
    });
    const probes = screen.getAllByTestId("probe");
    expect(probes).toHaveLength(2);
    // POSITION IS THE CONTRACT: the subtitle sits inside the head row's own
    // title cell, directly after the title. A slot that rendered anywhere
    // else would satisfy "it appears" and still be the wrong line.
    const title = visibleTitle("board 12");
    const subtitle = probes[0];
    expect(title.parentElement?.contains(subtitle ?? null)).toBe(true);
    expect(title.compareDocumentPosition(subtitle as Node)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );

    act(() => {
      useBoardSurfaceStore.getState().closeBoardModal();
    });
    // Guarantee 1 holds for the new slot exactly as for the old ones.
    expect(screen.queryAllByTestId("probe")).toHaveLength(0);
    expect(lifetime.unmounted).toBe(1);
  });

  it("renders the header without a subtitle when no slot is given", () => {
    resetStores("s1");
    render(
      <>
        <BoardModalHost gridSlot={probeSlot(newLifetime())} />
        <Places />
      </>,
    );
    act(() => {
      useBoardSurfaceStore.getState().openBoardModal(ref("s1", 12));
    });
    expect(visibleTitle("board 12")).toBeTruthy();
    expect(screen.getAllByTestId("probe")).toHaveLength(1);
  });

  it("swaps grid for spotlight, and hands the spotlight its pool index", () => {
    resetStores("s1");
    const grid = newLifetime();
    render(
      <>
        <BoardModalHost
          gridSlot={probeSlot(grid)}
          spotlightSlot={({ poolIndex }) => (
            <p data-testid="spotlight">pool {String(poolIndex)}</p>
          )}
        />
        <Places />
      </>,
    );
    act(() => {
      useBoardSurfaceStore.getState().openBoardModal(ref("s1", 12));
    });
    expect(grid.mounted).toBe(1);
    act(() => {
      useBoardSurfaceStore.getState().openBoardSpotlight(1);
    });
    expect(screen.getByTestId("spotlight").textContent).toBe("pool 1");
    expect(screen.queryByTestId("probe")).toBeNull();
    expect(grid.unmounted).toBe(1);
  });

  it("clamps a stored selection the bound board cannot address", () => {
    resetStores("s1");
    render(
      <>
        <BoardModalHost
          spotlightSlot={({ poolIndex }) => (
            <p data-testid="spotlight">pool {String(poolIndex)}</p>
          )}
        />
        <Places />
      </>,
    );
    act(() => {
      useBoardSurfaceStore.getState().openBoardModal(ref("s1", 12));
      useBoardSurfaceStore.setState({ view: "spotlight", selectedPoolIndex: 7 });
    });
    // Two pools on this board: the last addressable one, never index 7.
    expect(screen.getByTestId("spotlight").textContent).toBe("pool 1");
  });

  it("mounts the Ask block in the Vex sidebar only while it is open", () => {
    resetStores("s1");
    render(
      <>
        <BoardModalHost askSlot={() => <p data-testid="ask">ask</p>} />
        <Places />
      </>,
    );
    act(() => {
      useBoardSurfaceStore.getState().openBoardModal(ref("s1", 12));
    });
    expect(screen.queryByTestId("ask")).toBeNull();
    act(() => {
      useBoardSurfaceStore.getState().setBoardAskOpen(true);
    });
    // In Vex's column, never in the page.
    expect(screen.getByTestId("sidebar").contains(screen.getByTestId("ask"))).toBe(true);
    expect(screen.getByTestId("page").contains(screen.queryByTestId("ask"))).toBe(false);
    // Closing the board closes the block with it: an unsent question is not
    // state worth restoring beside figures that have since moved.
    act(() => {
      useBoardSurfaceStore.getState().closeBoardModal();
    });
    expect(useBoardSurfaceStore.getState().askPanelOpen).toBe(false);
    expect(screen.queryByTestId("ask")).toBeNull();
  });

  it("draws no Ask block while the Vex sidebar is hidden", () => {
    resetStores("s1");
    render(
      <>
        <BoardModalHost askSlot={() => <p data-testid="ask">ask</p>} />
        <Places sidebar={false} />
      </>,
    );
    act(() => {
      useBoardSurfaceStore.getState().openBoardModal(ref("s1", 12));
      useBoardSurfaceStore.getState().setBoardAskOpen(true);
    });
    expect(screen.queryByTestId("ask")).toBeNull();
  });

  it("renders nothing while the page is not mounted, so no slot holds a feed", () => {
    resetStores("s1");
    const lifetime = newLifetime();
    render(<BoardModalHost gridSlot={probeSlot(lifetime)} />);
    act(() => {
      useBoardSurfaceStore.getState().openBoardModal(ref("s1", 12));
    });
    expect(screen.queryByTestId("probe")).toBeNull();
    expect(lifetime.mounted).toBe(0);
  });
});

describe("the page and the binding move together", () => {
  it("binding a board opens the Board page", () => {
    resetStores("s1");
    render(
      <>
        <BoardModalHost gridSlot={probeSlot(newLifetime())} />
        <Places />
      </>,
    );
    act(() => {
      useBoardSurfaceStore.getState().openBoardModal(ref("s1", 12));
    });
    expect(useUiStore.getState().shellRoute.kind).toBe("board");
    expect(useBoardSurfaceStore.getState().modalBoard).not.toBeNull();
  });

  it("the page binds the pinned board before a newer one", () => {
    resetStores("s1");
    render(
      <>
        <BoardModalHost />
        <Places />
      </>,
    );
    act(() => {
      const store = useBoardSurfaceStore.getState();
      store.noteBoardRow(ref("s1", 14), "settled");
      store.pinBoard(ref("s1", 12));
      useUiStore.setState({ shellRoute: { kind: "board", origin: null } });
    });
    expect(useBoardSurfaceStore.getState().modalBoard?.messageId).toBe(12);
    expect(visibleTitle("board 12")).toBeTruthy();
  });

  it("the page binds the latest board when none is pinned", () => {
    resetStores("s1");
    render(
      <>
        <BoardModalHost />
        <Places />
      </>,
    );
    act(() => {
      const store = useBoardSurfaceStore.getState();
      store.noteBoardRow(ref("s1", 12), "settled");
      store.noteBoardRow(ref("s1", 14), "settled");
      useUiStore.setState({ shellRoute: { kind: "board", origin: null } });
    });
    expect(useBoardSurfaceStore.getState().modalBoard?.messageId).toBe(14);
  });

  it("the page binds nothing from another session, and nothing at all with no board", () => {
    resetStores("s1");
    render(
      <>
        <BoardModalHost />
        <Places />
      </>,
    );
    act(() => {
      useUiStore.setState({ shellRoute: { kind: "board", origin: null } });
    });
    expect(useBoardSurfaceStore.getState().modalBoard).toBeNull();
    act(() => {
      useBoardSurfaceStore.setState({ latestBoard: ref("s9", 3) });
    });
    expect(useBoardSurfaceStore.getState().modalBoard).toBeNull();
  });
});

describe("every close path converges on the one close action", () => {
  it("leaving the page closes through the store", () => {
    resetStores("s1");
    const lifetime = newLifetime();
    render(
      <>
        <BoardModalHost gridSlot={probeSlot(lifetime)} />
        <Places />
      </>,
    );
    act(() => {
      useBoardSurfaceStore.getState().openBoardModal(ref("s1", 12));
    });
    expect(useUiStore.getState().shellRoute.kind).toBe("board");

    act(() => {
      useUiStore.setState({ shellRoute: { kind: "portfolio", origin: null } });
    });

    expect(useBoardSurfaceStore.getState().modalBoard).toBeNull();
    expect(lifetime.cut).toHaveBeenCalledTimes(1);
    expect(lifetime.unmounted).toBe(1);
  });

  it("a session switch cuts the feeds and forgets the other session's boards", () => {
    resetStores("s1");
    const lifetime = newLifetime();
    render(
      <>
        <BoardModalHost gridSlot={probeSlot(lifetime)} />
        <Places />
      </>,
    );
    act(() => {
      const store = useBoardSurfaceStore.getState();
      store.openBoardModal(ref("s1", 12));
      store.pinBoard(ref("s1", 12));
    });

    act(() => {
      useUiStore.setState({ activeSessionId: "s2" });
    });

    const state = useBoardSurfaceStore.getState();
    expect(state.modalBoard).toBeNull();
    expect(state.pinnedBoard).toBeNull();
    expect(lifetime.cut).toHaveBeenCalledTimes(1);
    expect(lifetime.unmounted).toBe(1);
  });

  it("unmounting the shell cuts every registered feed", () => {
    resetStores("s1");
    const cut = vi.fn();
    const { unmount } = render(<BoardModalHost />);
    act(() => {
      useBoardSurfaceStore.getState().openBoardModal(ref("s1", 12));
    });
    const unregister = registerBoardSurfaceTeardown("spotlight", "chart", cut);

    act(() => {
      unmount();
    });

    expect(cut).toHaveBeenCalledTimes(1);
    expect(useBoardSurfaceStore.getState().modalBoard).toBeNull();
    unregister();
  });
});

describe("the page's heading", () => {
  it("is the model's own title, as the head row's heading", () => {
    resetStores("s1");
    render(
      <>
        <BoardModalHost />
        <Places />
      </>,
    );
    act(() => {
      useBoardSurfaceStore.getState().openBoardModal(ref("s1", 12));
    });
    const heading = screen.getByRole("heading", { name: "board 12" });
    expect(heading.getAttribute("data-vex-area")).toBe("board-title");
    expect(heading.closest('[data-vex-area="board-header"]')).not.toBeNull();
  });
});
