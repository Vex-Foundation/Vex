/**
 * BOARD SURFACE STATE MACHINE (A1 + A13).
 *
 * The experiments here are on the transitions that cost something when they
 * are wrong: an unseen dot lit by history, a pinned board silently replaced,
 * a filter inherited across boards, a live lease outliving its modal, and a
 * feed still polling after the reader left.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { boardKeyOf, boardRefOf, type BoardRef } from "../board-surface-contracts.js";
import {
  BOARD_FILTER_NONE,
  boardArrivalOf,
  countBoardSurfaceTeardowns,
  registerBoardSurfaceTeardown,
  readBoardTeardownFailures,
  selectBoardLiveOwnerKey,
  selectSpotlightChannelsActive,
  useBoardSurfaceStore,
} from "../board-surface-store.js";
import { useUiStore } from "../../../../stores/uiStore.js";
import type { SettledIdsTracker } from "../../SessionTranscript/settledIds.js";
import { boardSpec } from "./boardFixture.js";

function ref(
  sessionId: string,
  messageId: number,
  overrides: { readonly title?: string; readonly createdAt?: number } = {},
): BoardRef {
  const spec = boardSpec({
    title: overrides.title ?? `board ${String(messageId)}`,
    pools: [
      { chain: "base", pairAddress: "0xaaa111", analysis: null },
      { chain: "base", pairAddress: "0xbbb222", analysis: null },
    ],
    ...(overrides.createdAt !== undefined
      ? { analysisCreatedAt: overrides.createdAt }
      : {}),
  });
  return boardRefOf(sessionId, messageId, spec);
}

function resetStore(): void {
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
}

beforeEach(() => {
  resetStore();
});

describe("unseen dot provenance (A1 / A13)", () => {
  it("a historical mount CANNOT light the unseen dot", () => {
    const board = ref("s1", 12);
    useBoardSurfaceStore.getState().noteBoardRow(board, "settled");
    expect(useBoardSurfaceStore.getState().unseenBoardKey).toBeNull();
    // The board is still recorded as the latest one - only the DOT is denied.
    expect(useBoardSurfaceStore.getState().latestBoard).toEqual(board);
  });

  it("only a live append lights it", () => {
    const board = ref("s1", 12);
    useBoardSurfaceStore.getState().noteBoardRow(board, "live-append");
    expect(useBoardSurfaceStore.getState().unseenBoardKey).toBe("s1:12");
  });

  it("boardArrivalOf reads the transcript's settled bookkeeping", () => {
    const tracker: SettledIdsTracker = {
      sessionId: "s1",
      ids: new Set([1, 2, 12]),
      pageCount: 1,
    };
    expect(boardArrivalOf(tracker, "s1", 12)).toBe("settled");
    expect(boardArrivalOf(tracker, "s1", 99)).toBe("live-append");
    // Unknown provenance fails closed: no tracker, or another session's.
    expect(boardArrivalOf(null, "s1", 99)).toBe("settled");
    expect(boardArrivalOf(tracker, "s2", 99)).toBe("settled");
  });

  it("clears on the two acknowledged paths and on no other key (A13)", () => {
    const board = ref("s1", 12);
    const other = ref("s1", 13);
    const store = useBoardSurfaceStore.getState();

    // Path (a): the BOOK's Board tab showing this exact board.
    store.noteBoardRow(board, "live-append");
    store.acknowledgeBoardSeen(boardKeyOf(other));
    expect(useBoardSurfaceStore.getState().unseenBoardKey).toBe("s1:12");
    store.acknowledgeBoardSeen(boardKeyOf(board));
    expect(useBoardSurfaceStore.getState().unseenBoardKey).toBeNull();

    // Path (b): this board's modal opening, from anywhere.
    store.noteBoardRow(board, "live-append");
    store.openBoardModal(other);
    expect(useBoardSurfaceStore.getState().unseenBoardKey).toBe("s1:12");
    store.openBoardModal(board);
    expect(useBoardSurfaceStore.getState().unseenBoardKey).toBeNull();
  });

  it("a live append never switches the BOOK tab (A13: no auto-switch)", () => {
    useUiStore.setState({ bookTab: "portfolio" });
    useBoardSurfaceStore.getState().noteBoardRow(ref("s1", 12), "live-append");
    expect(useUiStore.getState().bookTab).toBe("portfolio");
  });
});

describe("separate identities (A1)", () => {
  it("a newer latest board does NOT replace the pinned one", () => {
    const first = ref("s1", 10, { createdAt: 1_783_000_000_000 });
    const second = ref("s1", 11, { createdAt: 1_783_000_100_000 });
    const store = useBoardSurfaceStore.getState();
    store.noteBoardRow(first, "settled");
    store.pinBoard(first);
    store.noteBoardRow(second, "live-append");

    expect(useBoardSurfaceStore.getState().pinnedBoard).toEqual(first);
    expect(useBoardSurfaceStore.getState().latestBoard).toEqual(second);
    expect(useBoardSurfaceStore.getState().unseenBoardKey).toBe("s1:11");
  });

  it("an older row does not become the latest board", () => {
    const newer = ref("s1", 11, { createdAt: 1_783_000_100_000 });
    const older = ref("s1", 10, { createdAt: 1_783_000_000_000 });
    const store = useBoardSurfaceStore.getState();
    store.noteBoardRow(newer, "settled");
    store.noteBoardRow(older, "settled");
    expect(useBoardSurfaceStore.getState().latestBoard).toEqual(newer);
  });
});

describe("per-board ephemeral state", () => {
  it("filter, scroll and selected pool survive a close and reopen", () => {
    const board = ref("s1", 12);
    const store = useBoardSurfaceStore.getState();
    store.openBoardModal(board);
    store.setBoardFilter({ chain: "base", safety: "flagged" });
    store.setBoardScrollTop(240);
    store.selectBoardPool(1);
    store.closeBoardModal();
    store.openBoardModal(board);

    const state = useBoardSurfaceStore.getState();
    expect(state.filter).toEqual({ chain: "base", safety: "flagged" });
    expect(state.scrollTop).toBe(240);
    expect(state.selectedPoolIndex).toBe(1);
  });

  it("resets on an identity change", () => {
    const store = useBoardSurfaceStore.getState();
    store.openBoardModal(ref("s1", 12));
    store.setBoardFilter({ chain: "base", safety: "flagged" });
    store.setBoardScrollTop(240);
    store.selectBoardPool(1);
    store.setBoardLive(true);
    store.openBoardModal(ref("s1", 13));

    const state = useBoardSurfaceStore.getState();
    expect(state.filter).toEqual(BOARD_FILTER_NONE);
    expect(state.scrollTop).toBe(0);
    expect(state.selectedPoolIndex).toBe(0);
    expect(state.liveRequested).toBe(false);
  });

  it("the selected pool is independent of the view", () => {
    const store = useBoardSurfaceStore.getState();
    store.openBoardModal(ref("s1", 12));
    store.openBoardSpotlight(1);
    expect(useBoardSurfaceStore.getState().view).toBe("spotlight");
    store.setBoardView("grid");
    // Back on the grid, the studied token is still the studied token.
    expect(useBoardSurfaceStore.getState().selectedPoolIndex).toBe(1);
  });
});

describe("the live lease", () => {
  it("is derived: no open modal means no owner", () => {
    const board = ref("s1", 12);
    const store = useBoardSurfaceStore.getState();
    store.openBoardModal(board);
    store.setBoardLive(true);
    expect(selectBoardLiveOwnerKey(useBoardSurfaceStore.getState())).toBe("s1:12");

    store.closeBoardModal();
    expect(selectBoardLiveOwnerKey(useBoardSurfaceStore.getState())).toBeNull();
  });

  it("spotlight channels are active only inside the spotlight view", () => {
    const store = useBoardSurfaceStore.getState();
    expect(selectSpotlightChannelsActive(useBoardSurfaceStore.getState())).toBe(false);
    store.openBoardModal(ref("s1", 12));
    expect(selectSpotlightChannelsActive(useBoardSurfaceStore.getState())).toBe(false);
    store.setBoardView("spotlight");
    expect(selectSpotlightChannelsActive(useBoardSurfaceStore.getState())).toBe(true);
  });
});

describe("teardown registry and generations", () => {
  it("leaving the spotlight cuts ONLY spotlight feeds", () => {
    const cutSpotlight = vi.fn();
    const cutModal = vi.fn();
    const un1 = registerBoardSurfaceTeardown("spotlight", "candles", cutSpotlight);
    const un2 = registerBoardSurfaceTeardown("modal", "cards", cutModal);
    const store = useBoardSurfaceStore.getState();
    store.openBoardModal(ref("s1", 12));
    store.setBoardView("spotlight");
    const before = useBoardSurfaceStore.getState();

    store.setBoardView("grid");

    expect(cutSpotlight).toHaveBeenCalledTimes(1);
    expect(cutModal).not.toHaveBeenCalled();
    const after = useBoardSurfaceStore.getState();
    expect(after.spotlightGeneration).toBe(before.spotlightGeneration + 1);
    expect(after.modalGeneration).toBe(before.modalGeneration);
    un1();
    un2();
  });

  it("changing the studied token cuts the spotlight's channels", () => {
    const cut = vi.fn();
    const un = registerBoardSurfaceTeardown("spotlight", "tape", cut);
    const store = useBoardSurfaceStore.getState();
    store.openBoardModal(ref("s1", 12));
    store.setBoardView("spotlight");
    store.selectBoardPool(1);
    expect(cut).toHaveBeenCalledTimes(1);
    un();
  });

  it("close, live-off and every exit converge on the same cut", () => {
    for (const drive of [
      (): void => useBoardSurfaceStore.getState().closeBoardModal(),
      (): void => useBoardSurfaceStore.getState().setBoardLive(false),
      (): void =>
        useBoardSurfaceStore
          .getState()
          .exitBoardSurfaces({ reason: "session-switch", keepSessionId: "s2" }),
      (): void =>
        useBoardSurfaceStore
          .getState()
          .exitBoardSurfaces({ reason: "home", keepSessionId: null }),
      (): void =>
        useBoardSurfaceStore
          .getState()
          .exitBoardSurfaces({ reason: "app-shell-exit", keepSessionId: null }),
    ]) {
      resetStore();
      const cutSpotlight = vi.fn();
      const cutModal = vi.fn();
      const un1 = registerBoardSurfaceTeardown("spotlight", "candles", cutSpotlight);
      const un2 = registerBoardSurfaceTeardown("modal", "cards", cutModal);
      const store = useBoardSurfaceStore.getState();
      store.openBoardModal(ref("s1", 12));
      store.setBoardLive(true);

      drive();

      expect(cutSpotlight).toHaveBeenCalledTimes(1);
      expect(cutModal).toHaveBeenCalledTimes(1);
      const after = useBoardSurfaceStore.getState();
      expect(after.modalGeneration).toBeGreaterThan(0);
      expect(after.spotlightGeneration).toBeGreaterThan(0);
      un1();
      un2();
    }
  });

  it("binding the modal to a DIFFERENT board cuts the previous board's feeds", () => {
    const cutSpotlight = vi.fn();
    const cutModal = vi.fn();
    const un1 = registerBoardSurfaceTeardown("spotlight", "candles", cutSpotlight);
    const un2 = registerBoardSurfaceTeardown("modal", "cards", cutModal);
    const store = useBoardSurfaceStore.getState();
    store.openBoardModal(ref("s1", 12));
    store.setBoardView("spotlight");
    const before = useBoardSurfaceStore.getState();

    // The BOOK's Open board, pressed while another board is already up.
    store.openBoardModal(ref("s1", 13));

    expect(cutSpotlight).toHaveBeenCalledTimes(1);
    expect(cutModal).toHaveBeenCalledTimes(1);
    const after = useBoardSurfaceStore.getState();
    expect(after.modalGeneration).toBe(before.modalGeneration + 1);
    expect(after.spotlightGeneration).toBe(before.spotlightGeneration + 1);
    un1();
    un2();
  });

  it("re-opening the SAME board keeps its feeds and its generations", () => {
    const cut = vi.fn();
    const un = registerBoardSurfaceTeardown("modal", "cards", cut);
    const board = ref("s1", 12);
    const store = useBoardSurfaceStore.getState();
    store.openBoardModal(board);
    const before = useBoardSurfaceStore.getState();

    store.openBoardModal(board);

    expect(cut).not.toHaveBeenCalled();
    const after = useBoardSurfaceStore.getState();
    expect(after.modalGeneration).toBe(before.modalGeneration);
    expect(after.spotlightGeneration).toBe(before.spotlightGeneration);
    un();
  });

  it("one failing teardown does not stop the others, and is reported", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const boom = (): never => {
      throw new Error("channel would not close");
    };
    const cutSecond = vi.fn();
    const un1 = registerBoardSurfaceTeardown("spotlight", "first", boom);
    const un2 = registerBoardSurfaceTeardown("spotlight", "second", cutSecond);

    useBoardSurfaceStore.getState().closeBoardModal();

    expect(cutSecond).toHaveBeenCalledTimes(1);
    expect(readBoardTeardownFailures()).toHaveLength(1);
    expect(readBoardTeardownFailures()[0]?.id).toBe("first");
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
    un1();
    un2();
  });

  it("unregistering removes the callback", () => {
    const cut = vi.fn();
    const un = registerBoardSurfaceTeardown("modal", "cards", cut);
    expect(countBoardSurfaceTeardowns("modal")).toBe(1);
    un();
    expect(countBoardSurfaceTeardowns("modal")).toBe(0);
    useBoardSurfaceStore.getState().closeBoardModal();
    expect(cut).not.toHaveBeenCalled();
  });
});

describe("exit transitions", () => {
  it("a session switch keeps only the boards of the session switched TO", () => {
    const stay = ref("s2", 4);
    const leave = ref("s1", 12);
    const store = useBoardSurfaceStore.getState();
    store.noteBoardRow(leave, "live-append");
    store.pinBoard(leave);
    store.openBoardModal(leave);
    // The board of the session being switched to was seen earlier.
    useBoardSurfaceStore.setState({ latestBoard: stay });

    store.exitBoardSurfaces({ reason: "session-switch", keepSessionId: "s2" });

    const state = useBoardSurfaceStore.getState();
    expect(state.modalBoard).toBeNull();
    expect(state.pinnedBoard).toBeNull();
    expect(state.latestBoard).toEqual(stay);
    expect(state.unseenBoardKey).toBeNull();
  });

  it("going home forgets every board", () => {
    const board = ref("s1", 12);
    const store = useBoardSurfaceStore.getState();
    store.noteBoardRow(board, "live-append");
    store.pinBoard(board);
    store.openBoardModal(board);
    store.setBoardFilter({ chain: "base", safety: null });

    store.exitBoardSurfaces({ reason: "home", keepSessionId: null });

    const state = useBoardSurfaceStore.getState();
    expect(state.latestBoard).toBeNull();
    expect(state.pinnedBoard).toBeNull();
    expect(state.modalBoard).toBeNull();
    expect(state.unseenBoardKey).toBeNull();
    expect(state.surfaceKey).toBeNull();
    expect(state.filter).toEqual(BOARD_FILTER_NONE);
  });
});
