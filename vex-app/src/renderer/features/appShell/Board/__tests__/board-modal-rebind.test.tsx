/**
 * REBINDING THE MODAL FROM BOARD A TO BOARD B, and the rows that must not
 * survive it.
 *
 * WHY THIS IS ITS OWN FILE. The defect it pins is not owned by any one
 * component: it is what three correct-looking decisions do TOGETHER. The host
 * keeps the header slot mounted across a change of board (React reuses a child
 * of the same type at the same position). The live hook released its lease on
 * unmount and on nothing else, so a mounted holder carried board A's lease and
 * board A's last rows into board B. The chrome then published those rows under
 * board B's key, and the overlay - which guards on the key it is GIVEN - had no
 * way to know it had been handed the wrong one. Board A's figures appeared
 * under board B's name, live, with a green dot.
 *
 * A test that owned only one of the three could not see it, which is exactly
 * why the review found it and the per-component suites did not. So this file
 * drives the REAL host with the REAL chrome inside it, through the REAL store
 * action a reader reaches (Open board while a modal is already open), and
 * asserts on what the overlay ends up holding.
 *
 * THE ORDER IS PART OF THE ASSERTION, TWICE OVER.
 *
 * A lease released after the next board subscribed would still have spent a
 * provider conversation on a board nobody was watching, so the
 * unsubscribe/subscribe sequence is recorded and asserted as a sequence.
 *
 * And the row leak is TRANSIENT, which is the reason a test that inspected
 * only the final state of the overlay store passed against the defect. The
 * store settles correctly a commit later; the wrong publication happens and is
 * then overwritten. But "published" is exactly what the word says - the grid
 * and the transcript's preview card are subscribers, and a value they were
 * handed for one commit was a value they rendered. So this file subscribes to
 * the overlay store and asserts over EVERY publication it ever made, not over
 * the one that happened to be last.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { JSX } from "react";
import { BoardModalHost } from "../BoardModalHost.js";
import { BoardModalChrome } from "../BoardModalChrome.js";
import { BOARD_FILTER_NONE, useBoardSurfaceStore } from "../board-surface-store.js";
import { useBoardLiveOverlayStore } from "../board-live-overlay.js";
import { boardKeyOf, boardRefOf, type BoardRef } from "../board-surface-contracts.js";
import { boardSpec, hydratedRow } from "./boardFixture.js";

const capability = vi.fn();
const subscribe = vi.fn();
const unsubscribe = vi.fn();
const onLeaseEvent = vi.fn();

/** Every bridge call in the order it was made. The order IS the contract. */
let calls: string[] = [];
/** Every value the overlay store was ever handed, in order. */
let publications: Array<{ boardKey: string; rowKeys: string[] } | null> = [];
let unwatch: (() => void) | null = null;
/** The lease event listener the mounted hook installed, so a tick can land. */
let emit: ((event: unknown) => void) | null = null;

const POOL_A = { chain: "base", pairAddress: "0xaaa111", analysis: null };
const POOL_B = { chain: "solana", pairAddress: "0xbbb222", analysis: null };

const ROW_A = hydratedRow();

function boardA(): BoardRef {
  return boardRefOf(
    "session-1",
    21,
    boardSpec({ title: "Board A", pools: [POOL_A] }),
  );
}
function boardB(): BoardRef {
  return boardRefOf(
    "session-1",
    22,
    boardSpec({ title: "Board B", pools: [POOL_B] }),
  );
}

function resetStores(): void {
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
  useBoardLiveOverlayStore.setState({ published: null });
}

beforeEach(() => {
  resetStores();
  calls = [];
  publications = [];
  emit = null;
  unwatch = useBoardLiveOverlayStore.subscribe((state) => {
    const published = state.published;
    publications.push(
      published === null
        ? null
        : {
            boardKey: published.boardKey,
            rowKeys: [...(published.rowsByKey?.keys() ?? [])],
          },
    );
  });
  capability.mockReset();
  subscribe.mockReset();
  unsubscribe.mockReset();
  onLeaseEvent.mockReset();

  capability.mockResolvedValue({ ok: true, data: { supported: true } });
  let leaseSeq = 0;
  subscribe.mockImplementation(async () => {
    leaseSeq += 1;
    const leaseId = `lease-${String(leaseSeq)}`;
    calls.push(`subscribe:${leaseId}`);
    return {
      ok: true,
      data: {
        kind: "subscribed",
        leaseId,
        generation: 1,
        snapshot: { fetchedAtMs: 1_700_000_000_000, rows: [] },
      },
    };
  });
  unsubscribe.mockImplementation(async (input: { leaseId?: string }) => {
    calls.push(`unsubscribe:${input.leaseId ?? "pending"}`);
    return { ok: true, data: { kind: "closed" } };
  });
  onLeaseEvent.mockImplementation((listener: (event: unknown) => void) => {
    emit = listener;
    return () => {
      emit = null;
    };
  });

  Object.defineProperty(window, "vex", {
    configurable: true,
    writable: true,
    value: { boardLive: { capability, subscribe, unsubscribe, onLeaseEvent } },
  });
});

afterEach(() => {
  unwatch?.();
  unwatch = null;
  cleanup();
  Object.defineProperty(window, "vex", {
    configurable: true,
    writable: true,
    value: undefined,
  });
});

function mount(): JSX.Element {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return (
    <QueryClientProvider client={client}>
      <BoardModalHost headerSlot={BoardModalChrome} />
    </QueryClientProvider>
  );
}

/** Take board A live and land one tick carrying a row that is A's alone. */
async function takeBoardALive(): Promise<void> {
  act(() => {
    useBoardSurfaceStore.getState().setBoardLive(true);
  });
  await waitFor(() => {
    expect(calls).toContain("subscribe:lease-1");
  });
  act(() => {
    emit?.({
      leaseId: "lease-1",
      generation: 2,
      kind: "tick",
      snapshot: {
        fetchedAtMs: 1_700_000_111_000,
        rows: [{ key: "base:0xaaa111", row: ROW_A }],
      },
    });
  });
  await waitFor(() => {
    const published = useBoardLiveOverlayStore.getState().published;
    expect(published?.rowsByKey?.size).toBe(1);
  });
}

describe("rebinding the board modal from A to B", () => {
  /**
   * THE RED-ON-REVERT CASE for the whole fix.
   *
   * Undo any one of the three parts - the host's key on the header slot, the
   * live hook's cut on a change of subject, or its publication guard - and
   * board A's row is published under board B's key here.
   */
  it("publishes no row of board A under board B's key", async () => {
    render(mount());
    act(() => {
      useBoardSurfaceStore.getState().openBoardModal(boardA());
    });
    await takeBoardALive();

    const keyA = boardKeyOf(boardA());
    const keyB = boardKeyOf(boardB());
    expect(useBoardLiveOverlayStore.getState().published?.boardKey).toBe(keyA);

    // The rebind a reader reaches from the BOOK: Open board while one is up.
    act(() => {
      useBoardSurfaceStore.getState().openBoardModal(boardB());
    });

    // Let every effect of the rebind commit, and the commits it schedules,
    // settle. The leak lives INSIDE that settling, not after it.
    await waitFor(() => {
      expect(useBoardSurfaceStore.getState().modalBoard?.messageId).toBe(22);
    });
    await act(async () => {
      await Promise.resolve();
    });

    // EVERY publication, not the last one. A row of board A published under
    // board B's key for a single commit is a row the grid and the preview card
    // rendered under board B's name.
    const leaked = publications.filter(
      (entry) =>
        entry !== null &&
        entry.boardKey === keyB &&
        entry.rowKeys.includes("base:0xaaa111"),
    );
    expect(leaked).toEqual([]);

    // And board A's own publications are all correctly attributed, so the
    // assertion above is not passing because nothing was ever published.
    expect(
      publications.some(
        (entry) =>
          entry !== null &&
          entry.boardKey === keyA &&
          entry.rowKeys.includes("base:0xaaa111"),
      ),
    ).toBe(true);
  });

  /**
   * THE LEASE IS RELEASED BEFORE THE NEXT BOARD CAN CLAIM ONE, and this is an
   * ORDER assertion rather than a count: main supersedes a second lease, so a
   * release that arrived afterwards would look identical at the end and would
   * still have spent a provider conversation on a board nobody was watching.
   */
  it("releases board A's lease before board B can subscribe", async () => {
    render(mount());
    act(() => {
      useBoardSurfaceStore.getState().openBoardModal(boardA());
    });
    await takeBoardALive();
    expect(calls).toEqual(["subscribe:lease-1"]);

    act(() => {
      useBoardSurfaceStore.getState().openBoardModal(boardB());
    });
    await waitFor(() => {
      expect(calls).toContain("unsubscribe:lease-1");
    });

    // Board B holds no lease of its own yet - the reader has not asked - so
    // the whole record is A's subscribe and A's release, in that order.
    const released = calls.indexOf("unsubscribe:lease-1");
    const laterSubscribe = calls.findIndex(
      (entry, index) => index > 0 && entry.startsWith("subscribe:"),
    );
    expect(released).toBeGreaterThan(-1);
    if (laterSubscribe !== -1) {
      expect(released).toBeLessThan(laterSubscribe);
    }
  });

  /**
   * The reader's DECISION does not survive the rebind either. `liveRequested`
   * is board-independent state in the store, and a chrome that carried its
   * "intent already applied" bookkeeping across the change would leave board B
   * with a switch reading ON and no lease behind it - a control claiming
   * something untrue, which is the failure mode this surface's own header
   * comment says it exists to prevent.
   */
  it("gives board B a switch that matches what board B actually holds", async () => {
    render(mount());
    act(() => {
      useBoardSurfaceStore.getState().openBoardModal(boardA());
    });
    await takeBoardALive();

    act(() => {
      useBoardSurfaceStore.getState().openBoardModal(boardB());
    });

    await waitFor(() => {
      const dot = document.querySelector('[data-vex-area="board-live-dot"]');
      expect(dot).toBeNull();
    });
  });
});
