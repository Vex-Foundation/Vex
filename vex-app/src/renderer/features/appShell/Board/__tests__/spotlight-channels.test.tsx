/**
 * THE CHANNEL RUNNER - what a channel does when a refresh FAILS, and what it
 * shows in the commit where the subject changes.
 *
 * Two defects live here and both are properties of the runner rather than of
 * any one panel, which is why one file covers every channel that uses it.
 *
 * 1. A FAILED REFRESH USED TO ERASE GOOD DATA. `publish` replaced the whole
 *    read with `{status: "unavailable"}`, so one bad second took a chart, a
 *    traders panel and a safety chip off screen while perfectly good figures
 *    were in hand. A11's evidence model says the opposite in as many words:
 *    `lastGood` and `lastAttempt` are separate facts, `unavailable` is the
 *    absence of the FIRST, and a failure of the second with evidence still
 *    held is `stale` - rendered from last-good, with an honest clock.
 *
 * 2. THE SUBJECT RESET USED TO BE PASSIVE. Clearing the read inside an effect
 *    means React commits one frame in which the previous subject's answer is
 *    on screen under the new subject's heading. On the chart that is A8's
 *    "stare bary nigdy nie podpisane nowym pillem" - old bars never labelled
 *    with a new pill - and on a pool switch it is the previous token's figures
 *    under the new token's name. A frame is not nothing: it is what the reader
 *    sees.
 *
 * THE SECOND ONE IS ASSERTED BY RECORDING EVERY RENDER, not by inspecting the
 * settled state. The settled state was always correct; the defect was entirely
 * inside the settling, which is exactly why it survived the existing suites.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { useLayoutEffect } from "react";
import {
  useSpotlightDetails,
  useSpotlightTraders,
  verdictForRead,
  type SpotlightRead,
} from "../spotlight-channels.js";
import { BOARD_FILTER_NONE, useBoardSurfaceStore } from "../board-surface-store.js";
import type { PairSubject } from "../board-surface-contracts.js";
import { cleanBundle } from "@shared/board/__tests__/board-safety-fixtures.js";

const topTraders = vi.fn();
const detailsRead = vi.fn();

/** A whole subject, declared rather than cast: the type is small and real. */
function subject(pairAddress: string): PairSubject {
  return {
    chain: "base",
    pairAddress,
    ammId: null,
    baseTokenSymbol: "AAA",
    baseTokenName: "Aaa",
    quoteTokenSymbol: "WETH",
    orientation: "base",
  };
}

const SUBJECT_A = subject("0xaaa111");
const SUBJECT_B = subject("0xbbb222");

const FETCHED_AT = 1_700_000_000_000;

function tradersPanel(rowLabel: string, fetchedAtMs = FETCHED_AT): unknown {
  return {
    kind: "traders",
    rows: [],
    rowsAvailable: 0,
    lookbackDays: 30,
    windowLabel: rowLabel,
    semanticsNote: "One pool, thirty days of pair-local cash flow.",
    fetchedAtMs,
  };
}

/**
 * The shared clean document, re-clocked.
 *
 * The fixture module is the ONE definition of "clean" in this repository, and
 * hand-writing a second one here would let this suite and the classifier's own
 * suite disagree about the same token while both stayed green. Only the two
 * clocks are overridden, because the clocks are this file's subject.
 */
function detailsBundle(args: {
  readonly fetchedAtMs: number;
  readonly expiresAtMs: number;
}): unknown {
  return { ...cleanBundle(), fetchedAtMs: args.fetchedAtMs, expiresAtMs: args.expiresAtMs };
}

/** Every `cancel` the runner has fired, so a cut is observable. */
let cancels = 0;

function abortable<T>(promise: Promise<T>): {
  readonly promise: Promise<T>;
  readonly cancel: () => void;
} {
  return {
    promise,
    cancel: () => {
      cancels += 1;
    },
  };
}

function resetStore(): void {
  useBoardSurfaceStore.setState({
    latestBoard: null,
    pinnedBoard: null,
    modalBoard: null,
    unseenBoardKey: null,
    surfaceKey: null,
    view: "spotlight",
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
  cancels = 0;
  topTraders.mockReset();
  detailsRead.mockReset();
  Object.defineProperty(window, "vex", {
    configurable: true,
    writable: true,
    value: {
      // Both bridges return an ABORTABLE invocation, and `cancel` is recorded
      // rather than stubbed: whether a cut actually reaches main is the
      // subject of the last case in this file.
      boardSpotlight: {
        topTraders: (input: unknown) => abortable(topTraders(input)),
      },
      boardDetails: {
        read: (input: unknown) => abortable(detailsRead(input)),
      },
    },
  });
});

afterEach(() => {
  cleanup();
  Object.defineProperty(window, "vex", {
    configurable: true,
    writable: true,
    value: undefined,
  });
});

describe("a failed refresh keeps the last good answer", () => {
  /**
   * THE RED-ON-REVERT CASE for the retention. Put the old
   * `setRead({status: "unavailable", reason})` back and `lastGood` is null
   * here, which is what took a panel off screen for one bad second.
   */
  it("carries the previous panel on the unavailable arm", async () => {
    topTraders.mockResolvedValueOnce({
      ok: true,
      data: { subject: SUBJECT_A, outcome: tradersPanel("30 days") },
    });
    const { result, rerender } = renderHook(
      (props: { live: boolean }) =>
        useSpotlightTraders({ subject: SUBJECT_A, active: true, live: props.live }),
      { initialProps: { live: false } },
    );
    await waitFor(() => {
      expect(result.current.status).toBe("ready");
    });

    // The refresh fails. A generation bump is what re-arms the channel, and a
    // live toggle is the reader-reachable way to cause one.
    topTraders.mockResolvedValue({
      ok: true,
      data: {
        subject: SUBJECT_A,
        outcome: { kind: "unavailable", reason: "transport" },
      },
    });
    act(() => {
      useBoardSurfaceStore.setState((s) => ({
        spotlightGeneration: s.spotlightGeneration + 1,
      }));
    });
    rerender({ live: true });

    await waitFor(() => {
      expect(result.current.status).toBe("unavailable");
    });
    const read = result.current;
    expect(read.status).toBe("unavailable");
    if (read.status !== "unavailable") return;
    expect(read.reason).toBe("transport");
    expect(read.lastGood).not.toBeNull();
    expect(read.lastGood?.value.windowLabel).toBe("30 days");
    expect(read.lastGood?.fetchedAtMs).toBe(FETCHED_AT);
  });

  /**
   * A SECOND failure must not lose what the first one kept. The retention is
   * written as a state updater for exactly this: reading the last-good out of
   * a value captured before the first failure would drop it on the second.
   */
  it("still holds the last SUCCESS after two consecutive failures", async () => {
    topTraders.mockResolvedValueOnce({
      ok: true,
      data: { subject: SUBJECT_A, outcome: tradersPanel("30 days") },
    });
    const { result, rerender } = renderHook(
      (props: { live: boolean }) =>
        useSpotlightTraders({ subject: SUBJECT_A, active: true, live: props.live }),
      { initialProps: { live: false } },
    );
    await waitFor(() => {
      expect(result.current.status).toBe("ready");
    });

    topTraders.mockResolvedValue({
      ok: true,
      data: {
        subject: SUBJECT_A,
        outcome: { kind: "unavailable", reason: "transport" },
      },
    });
    for (const _attempt of [1, 2]) {
      act(() => {
        useBoardSurfaceStore.setState((s) => ({
          spotlightGeneration: s.spotlightGeneration + 1,
        }));
      });
      rerender({ live: true });
      await waitFor(() => {
        expect(result.current.status).toBe("unavailable");
      });
    }
    const read = result.current;
    if (read.status !== "unavailable") throw new Error("expected unavailable");
    expect(read.lastGood?.value.windowLabel).toBe("30 days");
  });

  /**
   * AND A CHANGE OF SUBJECT DROPS IT. Last-good is evidence about ONE pool; a
   * different pool's failed read must never render the previous pool's panel
   * as though it were degraded evidence about the new one.
   */
  it("drops the last good answer when the subject changes", async () => {
    topTraders.mockResolvedValueOnce({
      ok: true,
      data: { subject: SUBJECT_A, outcome: tradersPanel("30 days") },
    });
    const { result, rerender } = renderHook(
      (props: { subject: PairSubject }) =>
        useSpotlightTraders({ subject: props.subject, active: true, live: false }),
      { initialProps: { subject: SUBJECT_A } },
    );
    await waitFor(() => {
      expect(result.current.status).toBe("ready");
    });

    topTraders.mockResolvedValue({
      ok: true,
      data: {
        subject: SUBJECT_B,
        outcome: { kind: "unavailable", reason: "transport" },
      },
    });
    rerender({ subject: SUBJECT_B });
    await waitFor(() => {
      expect(result.current.status).toBe("unavailable");
    });
    const read = result.current;
    if (read.status !== "unavailable") throw new Error("expected unavailable");
    expect(read.lastGood).toBeNull();
  });
});

describe("the subject reset is synchronous", () => {
  /**
   * THE RED-ON-REVERT CASE for the pill and the pool switch. Move the reset
   * back into the effect and one of the recorded renders below carries the
   * previous subject's panel, which is the frame the reader saw.
   */
  it("never renders the previous subject's answer after the subject changed", async () => {
    topTraders.mockResolvedValueOnce({
      ok: true,
      data: { subject: SUBJECT_A, outcome: tradersPanel("A's window") },
    });
    const renders: Array<SpotlightRead<{ readonly windowLabel: string }>> = [];
    const { result, rerender } = renderHook(
      (props: { subject: PairSubject }) => {
        const read = useSpotlightTraders({
          subject: props.subject,
          active: true,
          live: false,
        });
        // RECORDED AFTER COMMIT, NOT DURING RENDER, and the difference is the
        // whole validity of this test. Adjusting state during render makes
        // React THROW THAT RENDER AWAY and run another; pushing from the
        // render body would record the discarded pass, which no reader ever
        // saw, and the test would fail against the correct implementation.
        // A layout effect runs only for renders that were committed, which is
        // exactly the set of frames a reader could have seen.
        useLayoutEffect(() => {
          renders.push(read as SpotlightRead<{ readonly windowLabel: string }>);
        });
        return read;
      },
      { initialProps: { subject: SUBJECT_A } },
    );
    await waitFor(() => {
      expect(result.current.status).toBe("ready");
    });

    // A read for B that never settles, so the ONLY thing that can clear A's
    // panel is the reset, not an answer arriving to overwrite it.
    topTraders.mockReturnValue(new Promise(() => undefined));
    const before = renders.length;
    rerender({ subject: SUBJECT_B });
    await act(async () => {
      await Promise.resolve();
    });

    const afterSwitch = renders.slice(before);
    expect(afterSwitch.length).toBeGreaterThan(0);
    const leaked = afterSwitch.filter(
      (read) => read.status === "ready" && read.value.windowLabel === "A's window",
    );
    expect(leaked).toEqual([]);
    expect(result.current.status).toBe("pending");
  });
});

describe("the spotlight's safety verdict under a failed refresh", () => {
  /**
   * A11 ROW 10, which the spotlight could not reach before this change.
   *
   * `verdictForRead` derived its verdict from `lastGood: null` on every
   * non-ready arm, so a spotlight that had read a pool successfully and then
   * failed one refresh reported `unavailable` - "we know nothing about this
   * token" - while holding a complete, classified bundle whose only fault was
   * that the provider's own freshness window had passed.
   */
  it("is stale, not unavailable, when a bundle is still held", async () => {
    const now = Date.now();
    detailsRead.mockResolvedValueOnce({
      ok: true,
      data: {
        subject: SUBJECT_A,
        outcome: {
          kind: "details",
          // Freshness already consumed, so the failed refresh below cannot be
          // read as "still fresh, just could not re-ask".
          bundle: detailsBundle({ fetchedAtMs: now - 120_000, expiresAtMs: now - 60_000 }),
        },
      },
    });
    const { result, rerender } = renderHook(
      (props: { live: boolean }) =>
        useSpotlightDetails({ subject: SUBJECT_A, active: true, live: props.live }),
      { initialProps: { live: false } },
    );
    await waitFor(() => {
      expect(result.current.status).toBe("ready");
    });

    detailsRead.mockResolvedValue({
      ok: true,
      data: {
        subject: SUBJECT_A,
        outcome: { kind: "unavailable", reason: "transport" },
      },
    });
    act(() => {
      useBoardSurfaceStore.setState((s) => ({
        spotlightGeneration: s.spotlightGeneration + 1,
      }));
    });
    rerender({ live: true });
    await waitFor(() => {
      expect(result.current.status).toBe("unavailable");
    });

    expect(verdictForRead(result.current).state).toBe("stale");
  });

  /**
   * AND ROW 2 IS STILL HONEST. A failure with nothing ever read is not stale,
   * because there is no last-good for staleness to be a property OF.
   */
  it("is unavailable when nothing was ever read", async () => {
    detailsRead.mockResolvedValue({
      ok: true,
      data: {
        subject: SUBJECT_A,
        outcome: { kind: "unavailable", reason: "transport" },
      },
    });
    const { result } = renderHook(() =>
      useSpotlightDetails({ subject: SUBJECT_A, active: true, live: false }),
    );
    await waitFor(() => {
      expect(result.current.status).toBe("unavailable");
    });
    expect(verdictForRead(result.current).state).toBe("unavailable");
  });
});

describe("a cut reaches MAIN, not just this side", () => {
  /**
   * THE RED-ON-REVERT CASE for the renderer half of F2.
   *
   * The runner has always created an `AbortController` per tick and aborted it
   * on a cut. That abort was inert: `boardChart.poll` and every
   * `boardSpotlight.*` method went through `invokeWithSchema`, which has no
   * `cancel`, so leaving a spotlight only stopped the renderer LISTENING while
   * main went on talking to the provider to its own deadline, for a surface
   * nobody was watching. Now the preload methods are abortable and the runner
   * consumes the signal, so the cut travels: renderer -> preload -> IPC ->
   * service -> the provider read's own signal.
   *
   * Asserted on `cancel` actually firing, which is the observable end of that
   * chain on this side of the bridge. The main-process half of it - that
   * `ctx.signal` reaches the provider read - is asserted in the IPC suites,
   * against the real handlers.
   */
  it("fires the bridge cancel when the spotlight generation is cut", async () => {
    // A read that never settles, so the ONLY thing that can end it is the cut.
    topTraders.mockReturnValue(new Promise(() => undefined));
    renderHook(() =>
      useSpotlightTraders({ subject: SUBJECT_A, active: true, live: true }),
    );
    await waitFor(() => {
      expect(topTraders).toHaveBeenCalled();
    });
    expect(cancels).toBe(0);

    // The store's own cut, which is what every exit path converges on.
    act(() => {
      useBoardSurfaceStore.getState().setBoardView("grid");
    });

    await waitFor(() => {
      expect(cancels).toBeGreaterThan(0);
    });
  });

  /** And an UNMOUNT cuts it too: React is the other owner of this lifetime. */
  it("fires the bridge cancel on unmount", async () => {
    topTraders.mockReturnValue(new Promise(() => undefined));
    const { unmount } = renderHook(() =>
      useSpotlightTraders({ subject: SUBJECT_A, active: true, live: true }),
    );
    await waitFor(() => {
      expect(topTraders).toHaveBeenCalled();
    });
    act(() => {
      unmount();
    });
    expect(cancels).toBeGreaterThan(0);
  });
});
