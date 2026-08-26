/**
 * THE ONE BOARD MODAL (A3).
 *
 * The experiment that matters here is the one a native `<dialog>` makes easy
 * to get wrong: closing the dialog does NOT unmount its children, so a board
 * that "closed" could keep a chart subscribed and a tape polling behind an
 * invisible surface. The probe child below is the instrument - it reports its
 * own mount and unmount, and it registers a feed the store must cut.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useEffect, type JSX } from "react";
import { BoardModalHost } from "../BoardModalHost.js";
import {
  BOARD_FILTER_NONE,
  registerBoardSurfaceTeardown,
  useBoardSurfaceStore,
} from "../board-surface-store.js";
import { boardRefOf, type BoardRef } from "../board-surface-contracts.js";
import { useUiStore } from "../../../../stores/uiStore.js";
import { boardSpec } from "./boardFixture.js";

beforeAll(() => {
  // jsdom ships HTMLDialogElement without showModal/close; lib.dom already
  // types both, so the polyfill assigns real methods with no cast.
  const proto = HTMLDialogElement.prototype;
  if (typeof proto.showModal !== "function") {
    proto.showModal = function showModalPolyfill(this: HTMLDialogElement): void {
      this.setAttribute("open", "");
    };
  }
  if (typeof proto.close !== "function") {
    proto.close = function closePolyfill(this: HTMLDialogElement): void {
      this.removeAttribute("open");
    };
  }
});

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
  useUiStore.setState({ activeSessionId: sessionId });
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

/** The title the header PAINTS, told apart from the sr-only dialog title. */
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
    render(<BoardModalHost gridSlot={probeSlot(newLifetime())} />);
    expect(screen.queryByTestId("probe")).toBeNull();
  });

  it("mounts the grid slot when a board is bound, and UNMOUNTS it on close", () => {
    resetStores("s1");
    const lifetime = newLifetime();
    render(<BoardModalHost gridSlot={probeSlot(lifetime)} />);

    act(() => {
      useBoardSurfaceStore.getState().openBoardModal(ref("s1", 12));
    });
    expect(screen.getByTestId("probe")).toBeTruthy();
    expect(lifetime.mounted).toBe(1);

    act(() => {
      useBoardSurfaceStore.getState().closeBoardModal();
    });
    // The `<dialog>` element itself survives (it still owns focus restore);
    // its CHILDREN must not, or the feed would live on invisibly.
    expect(screen.queryByTestId("probe")).toBeNull();
    expect(lifetime.unmounted).toBe(1);
    expect(lifetime.cut).toHaveBeenCalledTimes(1);
  });

  it("mounts the subtitle slot under the model's title, and unmounts it on close", () => {
    resetStores("s1");
    const lifetime = newLifetime();
    render(
      <BoardModalHost
        subtitleSlot={probeSlot(lifetime)}
        gridSlot={probeSlot(newLifetime())}
      />,
    );

    act(() => {
      useBoardSurfaceStore.getState().openBoardModal(ref("s1", 12));
    });
    const probes = screen.getAllByTestId("probe");
    expect(probes).toHaveLength(2);
    // POSITION IS THE CONTRACT: the subtitle sits inside the header's own
    // left column, directly after the title. A slot that rendered anywhere
    // else would satisfy "it appears" and still be the wrong line.
    // The PAINTED title, not the sr-only `DialogTitle` that carries the
    // accessible name: both say the same words, and only one is the header.
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
    render(<BoardModalHost gridSlot={probeSlot(newLifetime())} />);
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
      <BoardModalHost
        gridSlot={probeSlot(grid)}
        spotlightSlot={({ poolIndex }) => (
          <p data-testid="spotlight">pool {String(poolIndex)}</p>
        )}
      />,
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
      <BoardModalHost
        spotlightSlot={({ poolIndex }) => (
          <p data-testid="spotlight">pool {String(poolIndex)}</p>
        )}
      />,
    );
    act(() => {
      useBoardSurfaceStore.getState().openBoardModal(ref("s1", 12));
      useBoardSurfaceStore.setState({ view: "spotlight", selectedPoolIndex: 7 });
    });
    // Two pools on this board: the last addressable one, never index 7.
    expect(screen.getByTestId("spotlight").textContent).toBe("pool 1");
  });

  it("mounts the Ask panel only while it is open", () => {
    resetStores("s1");
    render(<BoardModalHost askSlot={() => <p data-testid="ask">ask</p>} />);
    act(() => {
      useBoardSurfaceStore.getState().openBoardModal(ref("s1", 12));
    });
    expect(screen.queryByTestId("ask")).toBeNull();
    act(() => {
      useBoardSurfaceStore.getState().setBoardAskOpen(true);
    });
    expect(screen.getByTestId("ask")).toBeTruthy();
    // Closing the board closes the panel with it: an unsent question is not
    // state worth restoring beside figures that have since moved.
    act(() => {
      useBoardSurfaceStore.getState().closeBoardModal();
    });
    expect(useBoardSurfaceStore.getState().askPanelOpen).toBe(false);
  });
});

describe("every close path converges on the one close action", () => {
  it("the X control closes through the store", () => {
    resetStores("s1");
    const lifetime = newLifetime();
    render(<BoardModalHost gridSlot={probeSlot(lifetime)} />);
    act(() => {
      useBoardSurfaceStore.getState().openBoardModal(ref("s1", 12));
    });

    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Close the board" }));
    });

    expect(useBoardSurfaceStore.getState().modalBoard).toBeNull();
    expect(lifetime.cut).toHaveBeenCalledTimes(1);
    expect(lifetime.unmounted).toBe(1);
  });

  it("Escape (the dialog's native cancel) closes through the store", () => {
    resetStores("s1");
    const lifetime = newLifetime();
    const { container } = render(<BoardModalHost gridSlot={probeSlot(lifetime)} />);
    act(() => {
      useBoardSurfaceStore.getState().openBoardModal(ref("s1", 12));
    });
    const dialog = container.querySelector("dialog");
    if (dialog === null) throw new Error("dialog did not render");

    act(() => {
      fireEvent(dialog, new Event("cancel", { bubbles: false, cancelable: true }));
    });

    expect(useBoardSurfaceStore.getState().modalBoard).toBeNull();
    expect(lifetime.cut).toHaveBeenCalledTimes(1);
  });

  it("a session switch cuts the feeds and forgets the other session's boards", () => {
    resetStores("s1");
    const lifetime = newLifetime();
    render(<BoardModalHost gridSlot={probeSlot(lifetime)} />);
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

describe("the dialog's accessible name", () => {
  it("comes from a real title and description, not from the painted header", () => {
    resetStores("s1");
    const { container } = render(<BoardModalHost />);
    act(() => {
      useBoardSurfaceStore.getState().openBoardModal(ref("s1", 12));
    });
    const dialog = container.querySelector("dialog");
    const heading = screen.getByRole("heading", { name: "board 12" });
    expect(dialog?.getAttribute("aria-labelledby")).toBe(heading.id);
    expect(dialog?.getAttribute("aria-describedby")).not.toBeNull();
  });
});
