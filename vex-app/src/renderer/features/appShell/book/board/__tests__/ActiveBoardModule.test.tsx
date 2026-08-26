/**
 * ACTIVE BOARD - the rail's standing answer, and what it must never do.
 *
 *  - PINNED WINS. A pinned board is what the reader asked to keep in the rail;
 *    a newer one does not replace it. That is the whole point of the dot.
 *  - THE MODULE NEVER OPENS THE MODAL BY ITSELF, on mount, on arrival or on a
 *    timer. Every path to an open board is a press.
 *  - IT CLEARS THE UNSEEN DOT (A13 path a), key-guarded: reaching this module
 *    with THAT board visible is the reader having seen it, and a dot for a
 *    different board is left alone.
 *  - THE EMPTY STATE IS DESIGNED. No board yet is a sentence, not a blank.
 *  - IT NEVER CALLS A SOCKET "LIVE" BEFORE A TICK LANDS. Holding a lease and
 *    receiving figures are two different facts; `live-connecting` and
 *    `live-degraded` get their own word, their own state attribute and their
 *    own spoken sentence, and only `live-connected` is the green pill.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { ACTIVE_BOARD_EMPTY, ActiveBoardModule } from "../ActiveBoardModule.js";
import { useBoardSurfaceStore } from "../../../Board/board-surface-store.js";
import { useBoardLiveOverlayStore } from "../../../Board/board-live-overlay.js";
import type { BoardDataMode } from "../../../../../lib/api/board-live.js";
import {
  boardKeyOf,
  boardRefOf,
  type BoardRef,
} from "../../../Board/board-surface-contracts.js";
import {
  FIXTURE_FETCHED_AT,
  boardSpec,
  hydratedRow,
} from "../../../Board/__tests__/boardFixture.js";

const SESSION = "00000000-0000-4000-8000-000000000001";

function fourPoolBoard(messageId = 12, title = "Token Radar"): BoardRef {
  const pools = ["0xaaa111", "0xbbb222", "0xccc333", "0xddd444"].map(
    (pairAddress) => ({ chain: "base", pairAddress, analysis: null }),
  );
  return boardRefOf(
    SESSION,
    messageId,
    boardSpec({
      title,
      pools,
      rows: ["ELONIUS", "PONSBOY", "TRENCH", "NSIDIA"].map((symbol) =>
        hydratedRow({ baseTokenSymbol: symbol, baseTokenName: symbol }),
      ),
      marketDataFetchedAt: FIXTURE_FETCHED_AT,
    }),
  );
}

function wrapper({ children }: { readonly children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

const readBoardIcon = vi.fn();

function resetStore(): void {
  useBoardSurfaceStore.setState({
    latestBoard: null,
    pinnedBoard: null,
    modalBoard: null,
    unseenBoardKey: null,
    surfaceKey: null,
    view: "grid",
    selectedPoolIndex: 0,
    askPanelOpen: false,
  });
  useBoardLiveOverlayStore.setState({ published: null });
}

/**
 * What the modal's lease holder would have published for THIS board.
 *
 * The module holds no lease of its own, so the overlay is the only way its
 * live state can be driven, and driving it through the real store is what
 * makes these cases evidence about production rather than about a prop.
 */
function publishMode(board: BoardRef, mode: BoardDataMode): void {
  useBoardLiveOverlayStore.getState().publishBoardLive({
    boardKey: boardKeyOf(board),
    mode,
    rowsByKey: null,
    fetchedAtMs: FIXTURE_FETCHED_AT,
    notice: null,
    canToggle: true,
  });
}

beforeEach(() => {
  readBoardIcon.mockReset();
  readBoardIcon.mockResolvedValue({
    ok: true,
    data: { iconId: "abcd1234", icon: { kind: "not_found" } },
  });
  Object.defineProperty(window, "vex", {
    configurable: true,
    writable: true,
    value: { boardIcons: { read: readBoardIcon } },
  });
  resetStore();
});

afterEach(() => {
  cleanup();
  resetStore();
  Object.defineProperty(window, "vex", {
    configurable: true,
    writable: true,
    value: undefined,
  });
});

describe("ActiveBoardModule", () => {
  it("says so in words when this session has composed no board", () => {
    render(<ActiveBoardModule />, { wrapper });
    expect(screen.getByText(ACTIVE_BOARD_EMPTY)).toBeTruthy();
  });

  it("shows the model's own title, the UTC clock and the snapshot state", () => {
    useBoardSurfaceStore.setState({ latestBoard: fourPoolBoard() });
    render(<ActiveBoardModule />, { wrapper });
    expect(
      document.querySelector('[data-vex-area="active-board-title"]')?.textContent,
    ).toBe("Token Radar");
    expect(
      document.querySelector('[data-vex-area="active-board-clock"]')?.textContent,
    ).toBe("Updated 13:45 UTC");
    const mode = document.querySelector('[data-vex-area="active-board-mode"]');
    expect(mode?.getAttribute("data-mode")).toBe("snapshot");
    // The live state is spoken as well as painted.
    const region = document.querySelector(
      '[data-vex-area="active-board-live-region"]',
    );
    expect(region?.getAttribute("aria-live")).toBe("polite");
    expect(region?.textContent).toContain("snapshot figures");
  });

  it("draws the top three tokens as keyboard-operable rows and counts the rest", () => {
    useBoardSurfaceStore.setState({ latestBoard: fourPoolBoard() });
    render(<ActiveBoardModule />, { wrapper });
    const rows = document.querySelectorAll('[data-vex-area="active-board-row"]');
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.tagName).toBe("BUTTON");
    }
    expect(rows[0]?.textContent).toContain("ELONIUS");
    expect(
      document.querySelector('[data-vex-area="active-board-overflow"]')
        ?.textContent,
    ).toBe("+1 more on the board");
  });

  it("PINNED WINS: a newer latest board does not replace what the reader pinned", () => {
    const pinned = fourPoolBoard(11, "Pinned radar");
    const latest = fourPoolBoard(12, "Newer radar");
    useBoardSurfaceStore.setState({ pinnedBoard: pinned, latestBoard: latest });
    render(<ActiveBoardModule />, { wrapper });
    expect(
      document.querySelector('[data-vex-area="active-board-title"]')?.textContent,
    ).toBe("Pinned radar");
  });

  it("never opens the modal by itself", () => {
    useBoardSurfaceStore.setState({ latestBoard: fourPoolBoard() });
    render(<ActiveBoardModule />, { wrapper });
    expect(useBoardSurfaceStore.getState().modalBoard).toBeNull();
  });

  it("opens the board on Open board, and the Ask panel with it on Ask VEX", () => {
    const ref = fourPoolBoard();
    useBoardSurfaceStore.setState({ latestBoard: ref });
    render(<ActiveBoardModule />, { wrapper });

    fireEvent.click(screen.getByRole("button", { name: "Open board" }));
    expect(useBoardSurfaceStore.getState().modalBoard?.messageId).toBe(12);
    expect(useBoardSurfaceStore.getState().askPanelOpen).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Ask VEX" }));
    expect(useBoardSurfaceStore.getState().askPanelOpen).toBe(true);
  });

  it("opens a row's token straight into the spotlight", () => {
    useBoardSurfaceStore.setState({ latestBoard: fourPoolBoard() });
    render(<ActiveBoardModule />, { wrapper });
    const rows = document.querySelectorAll('[data-vex-area="active-board-row"]');
    fireEvent.click(rows[1] as HTMLElement);
    const state = useBoardSurfaceStore.getState();
    expect(state.modalBoard).not.toBeNull();
    expect(state.view).toBe("spotlight");
    expect(state.selectedPoolIndex).toBe(1);
  });

  it("shows the active spotlight token, and only while that spotlight is up", () => {
    const ref = fourPoolBoard();
    useBoardSurfaceStore.setState({
      latestBoard: ref,
      modalBoard: ref,
      surfaceKey: boardKeyOf(ref),
      view: "grid",
      selectedPoolIndex: 2,
    });
    const view = render(<ActiveBoardModule />, { wrapper });
    expect(
      document.querySelector('[data-vex-area="active-board-spotlight"]'),
    ).toBeNull();

    view.rerender(<ActiveBoardModule />);
    useBoardSurfaceStore.setState({ view: "spotlight" });
    view.rerender(<ActiveBoardModule />);
    const spotlight = document.querySelector(
      '[data-vex-area="active-board-spotlight"]',
    );
    expect(spotlight?.textContent).toContain("TRENCH");
  });

  it("clears the unseen dot for THIS board (A13 path a), and leaves another board's alone", () => {
    const shown = fourPoolBoard(12);
    const other = fourPoolBoard(99);
    useBoardSurfaceStore.setState({
      latestBoard: shown,
      unseenBoardKey: boardKeyOf(other),
    });
    const view = render(<ActiveBoardModule />, { wrapper });
    // A dot for a board this module is NOT showing survives.
    expect(useBoardSurfaceStore.getState().unseenBoardKey).toBe(
      boardKeyOf(other),
    );

    useBoardSurfaceStore.setState({ unseenBoardKey: boardKeyOf(shown) });
    view.rerender(<ActiveBoardModule />);
    expect(useBoardSurfaceStore.getState().unseenBoardKey).toBeNull();
  });
});

describe("the rail's live state is the socket's, one word per fact", () => {
  const cases: readonly (readonly [string, BoardDataMode | null, string, string, string])[] = [
    ["snapshot", null, "snapshot", "Snapshot", "snapshot figures"],
    ["live-connecting", "live-connecting", "connecting", "Connecting", "connecting to live figures"],
    ["live-connected", "live-connected", "live", "LIVE", "live figures"],
    ["live-degraded", "live-degraded", "reconnecting", "Reconnecting", "reconnecting, figures may be behind"],
  ];

  it.each(cases)(
    "%s renders its own copy, state attribute and spoken sentence",
    (_name, mode, state, label, spoken) => {
      const board = fourPoolBoard();
      useBoardSurfaceStore.setState({ latestBoard: board });
      if (mode !== null) publishMode(board, mode);
      render(<ActiveBoardModule />, { wrapper });
      const chip = document.querySelector('[data-vex-area="active-board-mode"]');
      expect(chip?.getAttribute("data-mode")).toBe(state);
      expect(chip?.textContent).toBe(label);
      expect(
        document.querySelector('[data-vex-area="active-board"]')
          ?.getAttribute("data-live-state"),
      ).toBe(state);
      expect(
        document.querySelector('[data-vex-area="active-board-live-region"]')?.textContent,
      ).toContain(spoken);
    },
  );

  it("RED ON REVERT of the one-boolean live pill: connecting and degraded are never the word LIVE", () => {
    // The defect. `isBoardLiveHeld` is true for all three live modes, so a
    // rail that painted the pill from it told the reader that figures were
    // arriving while the socket was still opening or had just dropped. On a
    // surface whose whole job is "what is on the board right now", that is the
    // one sentence that must not be guessed.
    for (const mode of ["live-connecting", "live-degraded"] as const) {
      const board = fourPoolBoard();
      useBoardSurfaceStore.setState({ latestBoard: board });
      publishMode(board, mode);
      render(<ActiveBoardModule />, { wrapper });
      const chip = document.querySelector('[data-vex-area="active-board-mode"]');
      expect(chip?.textContent).not.toBe("LIVE");
      expect(chip?.getAttribute("data-mode")).not.toBe("live");
      expect(chip?.getAttribute("data-live-mode")).toBe(mode);
      expect(
        document.querySelector('[data-vex-area="active-board-live-region"]')?.textContent,
      ).not.toContain(": live figures");
      cleanup();
      resetStore();
    }
  });

  it("keeps the live PATH distinct from the landed tick: data-live stays true while connecting", () => {
    // `data-live` has always meant "this board is on the live path, not the
    // composed snapshot", and the fix must not quietly redefine it.
    const board = fourPoolBoard();
    useBoardSurfaceStore.setState({ latestBoard: board });
    publishMode(board, "live-connecting");
    render(<ActiveBoardModule />, { wrapper });
    const section = document.querySelector('[data-vex-area="active-board"]');
    expect(section?.getAttribute("data-live")).toBe("true");
    expect(section?.getAttribute("data-live-state")).toBe("connecting");
  });
});
