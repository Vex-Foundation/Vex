/**
 * THE SCROLL MODEL — follow-stream with reader ownership (owner decision 3,
 * 2026-08-21). Replaces the top-anchor/never-follow suite wholesale.
 *
 * What each case here is actually a claim about:
 *
 *  - reader-release: a reader scroll away from the floor takes ownership, and
 *    nothing the stream does afterwards takes it back;
 *  - threshold-entry-must-not-snap: crossing INTO the at-bottom band re-renders
 *    the chrome, and that re-render must not finish the reader's scroll for
 *    them;
 *  - force-scroll-on-own-send: a live trailing user row and a steering mark
 *    scroll unconditionally, pinned or not — own words must be visible;
 *  - shrink-clamp delivery: a non-reader event that lands on the floor minimum
 *    preserves ownership rather than reading as a reader gesture;
 *  - prepend anchor: an older page restores the reader's LATEST intent, and
 *    returning to the floor cancels the anchor entirely;
 *  - pinned-vs-saved on remount: pinned saves nothing (keep following), an
 *    unpinned position restores against its anchor ROW, not its pixel.
 *
 * Geometry is scripted through `installScrollMetrics` (a floor-clamping
 * `scrollTop` setter, as a real engine behaves) and growth through a manual
 * `ResizeObserver` stub. No wall-clock sleeps anywhere.
 */

import { afterEach, describe, expect, it } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";

import { SessionTranscript } from "../../SessionTranscript.js";
import { useStreamStore } from "../../../../stores/streamStore.js";
import {
  SESSION,
  failure,
  freshClient,
  getScroller,
  installResizeObserver,
  installScrollMetrics,
  latestPill,
  listMock,
  livePreview,
  msg,
  page,
  readerScroll,
  resetTranscriptEnv,
  setVex,
  startChatTurn,
} from "./transcript-harness.js";

function makeWrapper(client: QueryClient) {
  return function Wrapper({ children }: { readonly children: ReactNode }) {
    return createElement(QueryClientProvider, { client }, children);
  };
}

afterEach(resetTranscriptEnv);

async function mount(client: QueryClient = freshClient()) {
  setVex();
  const view = render(createElement(SessionTranscript, { sessionId: SESSION }), {
    wrapper: makeWrapper(client),
  });
  return view;
}

describe("SessionTranscript follow-stream scroll model", () => {
  it("opens a session pinned to the floor and follows the streaming tip", async () => {
    listMock.mockResolvedValue(
      page([msg({ id: 3, role: "user", kind: "text", content: "newest" })], null),
    );
    const { container } = await mount();
    await waitFor(() => expect(screen.getByText("newest")).not.toBeNull());

    const scroller = getScroller(container);
    const geometry = installScrollMetrics(scroller, 500, 200);
    // Re-land the first page's jump against the now-scripted geometry.
    fireEvent.scroll(scroller);
    expect(scroller.scrollTop).toBe(300);
    expect(latestPill(container)).toBeNull();

    // A reply streams in and grows the flow. Pinned → the model follows it.
    geometry.setHeight(900);
    act(() => {
      useStreamStore.setState({
        bySessionId: { [SESSION]: livePreview({ text: "streaming…" }) },
      });
    });
    expect(scroller.scrollTop).toBe(700);
    expect(latestPill(container)).toBeNull();
  });

  it("reader-release: a reader scroll away stops the follow, and the stream never takes it back", async () => {
    listMock.mockResolvedValue(
      page([msg({ id: 3, role: "user", kind: "text", content: "newest" })], null),
    );
    const { container } = await mount();
    await waitFor(() => expect(screen.getByText("newest")).not.toBeNull());

    const scroller = getScroller(container);
    const geometry = installScrollMetrics(scroller, 900, 200);
    readerScroll(scroller, 100);
    expect(latestPill(container)).not.toBeNull();

    // Two streamed growth ticks: the reader owns the viewport, so neither
    // moves it. This is the whole point of the ownership ledger.
    act(() => {
      useStreamStore.setState({
        bySessionId: { [SESSION]: livePreview({ text: "one" }) },
      });
    });
    geometry.setHeight(1400);
    act(() => {
      useStreamStore.setState({
        bySessionId: { [SESSION]: livePreview({ text: "one two three" }) },
      });
    });
    expect(scroller.scrollTop).toBe(100);

    // The pill offers the jump the model refused to take. Instant, so it needs
    // no reduced-motion branch.
    fireEvent.click(latestPill(container) as HTMLElement);
    expect(scroller.scrollTop).toBe(1200);
    await waitFor(() => expect(latestPill(container)).toBeNull());
  });

  it("threshold-entry-must-not-snap: crossing into the at-bottom band leaves the remaining distance alone", async () => {
    listMock.mockResolvedValue(
      page([msg({ id: 3, role: "user", kind: "text", content: "newest" })], null),
    );
    const { container } = await mount();
    await waitFor(() => expect(screen.getByText("newest")).not.toBeNull());

    const scroller = getScroller(container);
    installScrollMetrics(scroller, 1000, 300);
    readerScroll(scroller, 100);
    expect(latestPill(container)).not.toBeNull();

    // Inside FOLLOW_THRESHOLD (24) but NOT flush with the floor (700). The
    // chrome re-render from hiding the pill must not finish the scroll: the
    // signature did not move, so nothing follows.
    readerScroll(scroller, 690);
    expect(latestPill(container)).toBeNull();
    expect(scroller.scrollTop).toBe(690);
  });

  it("force-scroll-on-own-send: a live trailing USER row scrolls even from an unpinned viewport", async () => {
    let sent = false;
    listMock.mockImplementation(() => {
      const items = sent
        ? [
            msg({ id: 3, role: "user", kind: "text", content: "newest" }),
            msg({ id: 4, role: "user", kind: "text", content: "just sent" }),
          ]
        : [msg({ id: 3, role: "user", kind: "text", content: "newest" })];
      return Promise.resolve(page(items, null));
    });
    const client = freshClient();
    const { container } = await mount(client);
    await waitFor(() => expect(screen.getByText("newest")).not.toBeNull());

    const scroller = getScroller(container);
    const geometry = installScrollMetrics(scroller, 900, 200);
    // The reader is reading history, far from the floor, and OWNS the
    // viewport. Own words override that ownership; nothing else does.
    readerScroll(scroller, 50);
    expect(latestPill(container)).not.toBeNull();

    sent = true;
    geometry.setHeight(1000);
    await act(async () => {
      await client.invalidateQueries({ queryKey: ["messages", SESSION] });
    });
    await waitFor(() => expect(screen.getByText("just sent")).not.toBeNull());
    expect(scroller.scrollTop).toBe(800);
    expect(latestPill(container)).toBeNull();
  });

  it("force-scroll-on-own-send: a NEW STEERING MARK scrolls the same way", async () => {
    let steered = false;
    listMock.mockImplementation(() => {
      const items = steered
        ? [
            msg({ id: 3, role: "user", kind: "text", content: "newest" }),
            msg({ id: 4, role: "assistant", kind: "text", content: "reply" }),
            msg({ id: 5, role: "user", kind: "steering", content: "steer me" }),
          ]
        : [
            msg({ id: 3, role: "user", kind: "text", content: "newest" }),
            msg({ id: 4, role: "assistant", kind: "text", content: "reply" }),
          ];
      return Promise.resolve(page(items, null));
    });
    const client = freshClient();
    const { container } = await mount(client);
    await waitFor(() => expect(screen.getByText("reply")).not.toBeNull());

    const scroller = getScroller(container);
    const geometry = installScrollMetrics(scroller, 900, 200);
    readerScroll(scroller, 40);
    expect(latestPill(container)).not.toBeNull();

    steered = true;
    geometry.setHeight(1100);
    await act(async () => {
      await client.invalidateQueries({ queryKey: ["messages", SESSION] });
    });
    await waitFor(() => expect(screen.getByText("steer me")).not.toBeNull());
    expect(scroller.scrollTop).toBe(900);
  });

  it("a HISTORICAL trailing user row on session open does not force anything beyond the open jump", async () => {
    listMock.mockResolvedValue(
      page([msg({ id: 3, role: "user", kind: "text", content: "old send" })], null),
    );
    const { container } = await mount();
    await waitFor(() => expect(screen.getByText("old send")).not.toBeNull());

    const scroller = getScroller(container);
    installScrollMetrics(scroller, 900, 200);
    // The reader browses upward; a settled row is history, never "own words",
    // so nothing pulls the viewport back.
    readerScroll(scroller, 100);
    expect(scroller.scrollTop).toBe(100);
    expect(latestPill(container)).not.toBeNull();
  });

  it("shrink-clamp delivery: a non-reader event landing on the floor preserves ownership", async () => {
    listMock.mockResolvedValue(
      page([msg({ id: 3, role: "user", kind: "text", content: "newest" })], null),
    );
    const { container } = await mount();
    await waitFor(() => expect(screen.getByText("newest")).not.toBeNull());

    const scroller = getScroller(container);
    const geometry = installScrollMetrics(scroller, 1000, 300);
    fireEvent.scroll(scroller);
    expect(scroller.scrollTop).toBe(700);

    // The flow shrinks (a turn settles and retires its preview). The engine
    // clamps scrollTop to the new floor and delivers a scroll event that the
    // model did NOT write. Reading that as a reader gesture would silently
    // disarm follow; instead it re-pins.
    geometry.setHeight(600);
    fireEvent.scroll(scroller);
    expect(scroller.scrollTop).toBe(300);
    expect(latestPill(container)).toBeNull();

    // Still following: the next tip move lands at the new floor.
    geometry.setHeight(1200);
    act(() => {
      useStreamStore.setState({
        bySessionId: { [SESSION]: livePreview({ text: "more" }) },
      });
    });
    expect(scroller.scrollTop).toBe(900);
  });

  it("one ResizeObserver owns pinned growth and ignores growth while the reader is away", async () => {
    const observer = installResizeObserver();
    listMock.mockResolvedValue(
      page([msg({ id: 3, role: "user", kind: "text", content: "newest" })], null),
    );
    const { container } = await mount();
    await waitFor(() => expect(screen.getByText("newest")).not.toBeNull());

    const scroller = getScroller(container);
    const geometry = installScrollMetrics(scroller, 1000, 300);
    fireEvent.scroll(scroller);
    expect(scroller.scrollTop).toBe(700);

    // A disclosure opens / the draft grows: the column resizes with no new
    // rows and no new deltas, so ONLY the observer can notice.
    geometry.setHeight(1200);
    act(() => {
      observer.notify();
    });
    expect(scroller.scrollTop).toBe(900);

    // The reader takes ownership; later growth must not move them.
    readerScroll(scroller, 200);
    geometry.setHeight(1400);
    act(() => {
      observer.notify();
    });
    expect(scroller.scrollTop).toBe(200);
  });

  it("prepend anchor: an older page restores the reader's LATEST in-flight position", async () => {
    // The older page is held OPEN on purpose: the claim under test is that the
    // reader's moves WHILE the request is in flight, not their position when
    // they armed it, are what the arriving page preserves. Resolving the mock
    // immediately would test the arm-time position instead.
    let releaseOlder: () => void = () => undefined;
    let older = false;
    listMock.mockImplementation((input: { readonly cursor: unknown }) => {
      if (input.cursor !== null) {
        older = true;
        return new Promise((resolve) => {
          releaseOlder = () =>
            resolve(
              page(
                [msg({ id: 1, role: "user", kind: "text", content: "older" })],
                null,
              ),
            );
        });
      }
      return Promise.resolve(
        page(
          [
            msg({ id: 3, role: "user", kind: "text", content: "first visible" }),
            msg({ id: 4, role: "assistant", kind: "text", content: "next visible" }),
          ],
          3,
        ),
      );
    });
    const { container } = await mount();
    await waitFor(() => expect(screen.getByText("first visible")).not.toBeNull());

    const scroller = getScroller(container);
    const geometry = installScrollMetrics(scroller, 800, 200);
    scroller.getBoundingClientRect = () => ({ top: 0, bottom: 200 }) as DOMRect;
    const anchored = container.querySelector(
      '[data-vex-anchor-key][data-vex-entry-id="3"]',
    ) as HTMLElement;
    let anchoredTop = 100;
    anchored.getBoundingClientRect = () =>
      ({ top: anchoredTop, bottom: anchoredTop + 40 }) as DOMRect;

    // Reaching the head arms the fetch AND the anchor at the reader's position.
    readerScroll(scroller, 50);
    await waitFor(() => expect(older).toBe(true));

    // The reader keeps moving WHILE the request is in flight. That, not the
    // position at arm time, is the intent the arriving page must preserve.
    anchoredTop = -200;
    readerScroll(scroller, 90);
    geometry.setHeight(1300);
    anchoredTop = 300;
    await act(async () => {
      releaseOlder();
      await Promise.resolve();
    });
    await waitFor(() => expect(screen.getByText("older")).not.toBeNull());
    // latest 90 + the anchored row's 500px prepend shift.
    expect(scroller.scrollTop).toBe(590);
  });

  it("prepend anchor: returning to the floor cancels an in-flight anchor", async () => {
    let olderRequested = false;
    listMock.mockImplementation((input: { readonly cursor: unknown }) => {
      if (input.cursor !== null) {
        olderRequested = true;
        return Promise.resolve(failure);
      }
      return Promise.resolve(
        page([msg({ id: 3, role: "user", kind: "text", content: "newest" })], 3),
      );
    });
    const { container } = await mount();
    await waitFor(() => expect(screen.getByText("newest")).not.toBeNull());

    const scroller = getScroller(container);
    installScrollMetrics(scroller, 800, 200);
    readerScroll(scroller, 10);
    await waitFor(() => expect(olderRequested).toBe(true));
    await waitFor(() =>
      expect(screen.getByText(/Couldn't load older messages/i)).not.toBeNull(),
    );

    // Back at the floor: the anchor is cleared, follow is re-armed, and the
    // failed page can never wedge a later one.
    readerScroll(scroller, 600);
    expect(latestPill(container)).toBeNull();
    expect(scroller.scrollTop).toBe(600);
  });

  it("pinned-vs-saved on remount: pinned keeps following, an unpinned position restores its anchor ROW", async () => {
    listMock.mockResolvedValue(
      page([msg({ id: 3, role: "user", kind: "text", content: "newest" })], null),
    );
    const client = freshClient();
    const first = await mount(client);
    await waitFor(() => expect(screen.getByText("newest")).not.toBeNull());

    const scroller = getScroller(first.container);
    installScrollMetrics(scroller, 2000, 500);
    scroller.getBoundingClientRect = () => ({ top: 0, bottom: 500 }) as DOMRect;
    const row = first.container.querySelector(
      "[data-vex-anchor-key]",
    ) as HTMLElement;
    row.getBoundingClientRect = () => ({ top: 80, bottom: 120 }) as DOMRect;

    // Pinned first: a remount from this state must keep following.
    fireEvent.scroll(scroller);
    first.unmount();
    const pinnedAgain = await mount(client);
    await waitFor(() => expect(screen.getByText("newest")).not.toBeNull());
    const pinnedScroller = getScroller(pinnedAgain.container);
    installScrollMetrics(pinnedScroller, 2000, 500);
    fireEvent.scroll(pinnedScroller);
    expect(pinnedScroller.scrollTop).toBe(1500);
    pinnedAgain.unmount();

    // Now an UNPINNED position, saved continuously by the scroll handler.
    const away = await mount(client);
    await waitFor(() => expect(screen.getByText("newest")).not.toBeNull());
    const awayScroller = getScroller(away.container);
    installScrollMetrics(awayScroller, 2000, 500);
    awayScroller.getBoundingClientRect = () =>
      ({ top: 0, bottom: 500 }) as DOMRect;
    const awayRow = away.container.querySelector(
      "[data-vex-anchor-key]",
    ) as HTMLElement;
    awayRow.getBoundingClientRect = () => ({ top: 80, bottom: 120 }) as DOMRect;
    readerScroll(awayScroller, 100);
    away.unmount();

    // The row reflows to a different offset (a width change between mounts).
    // The restore must land on the ROW, not on the old pixel.
    const restored = await mount(client);
    await waitFor(() => expect(screen.getByText("newest")).not.toBeNull());
    const restoredScroller = getScroller(restored.container);
    installScrollMetrics(restoredScroller, 2000, 500);
    restoredScroller.getBoundingClientRect = () =>
      ({ top: 0, bottom: 500 }) as DOMRect;
    const restoredRow = restored.container.querySelector(
      "[data-vex-anchor-key]",
    ) as HTMLElement;
    restoredRow.getBoundingClientRect = () =>
      ({ top: 560, bottom: 600 }) as DOMRect;
    fireEvent.scroll(restoredScroller);
    expect(restoredScroller.scrollTop).not.toBe(1500);
  });

  it("shows the working island the INSTANT a turn is submitted, before any delta", async () => {
    // THE GHOST MOMENT (owner report 2026-07-30). The island used to mount on
    // the first provider delta, a whole round-trip after the send. It must
    // mount on the SUBMIT, and the follow model must not depend on it.
    listMock.mockResolvedValue(
      page([msg({ id: 3, role: "user", kind: "text", content: "newest" })], null),
    );
    const client = freshClient();
    const { container } = await mount(client);
    await waitFor(() => expect(screen.getByText("newest")).not.toBeNull());
    expect(container.querySelector("[data-vex-island-state]")).toBeNull();

    const settleTurn = startChatTurn(client);
    await waitFor(() => {
      const island = container.querySelector("[data-vex-island-state]");
      expect(island).not.toBeNull();
      expect(island?.getAttribute("data-vex-island-state")).toBe("working");
    });

    // The first real delta takes over the SAME surface, not a second one.
    act(() => {
      useStreamStore.setState({
        bySessionId: {
          [SESSION]: livePreview({ reasoningText: "hm", status: "thinking" }),
        },
      });
    });
    await waitFor(() => {
      expect(container.querySelectorAll("[data-vex-island-state]")).toHaveLength(
        1,
      );
      expect(
        container
          .querySelector("[data-vex-island-state]")
          ?.getAttribute("data-vex-island-state"),
      ).toBe("thinking");
    });

    await act(async () => {
      settleTurn();
      await Promise.resolve();
    });
  });

  it("keeps the turn surface alive across a mid-turn tool row (no preview flicker, no jump)", async () => {
    // THE MID-TURN JUMP (owner report 2026-07-30). A tool call persists an
    // assistant row mid-turn and the round-scoped preview goes null. Under the
    // old model that retired the anchor run-out and clamped the reader up the
    // conversation. The run-out is gone, so what this now guards is the other
    // half of the same fix: the TURN-scoped preview survives the mid-turn row,
    // and an unpinned reader is not moved by it.
    let round = 0;
    listMock.mockImplementation(() => {
      const items = [
        msg({ id: 3, role: "user", kind: "text", content: "newest" }),
        ...(round > 0
          ? [msg({ id: 4, role: "user", kind: "text", content: "just sent" })]
          : []),
        ...(round > 1
          ? [msg({ id: 5, role: "assistant", kind: "text", content: "calling out" })]
          : []),
      ];
      return Promise.resolve(page(items, null));
    });
    const client = freshClient();
    const { container } = await mount(client);
    await waitFor(() => expect(screen.getByText("newest")).not.toBeNull());

    const scroller = getScroller(container);
    installScrollMetrics(scroller, 500, 200);
    const settleTurn = startChatTurn(client);
    round = 1;
    await act(async () => {
      await client.invalidateQueries({ queryKey: ["messages", SESSION] });
    });
    await waitFor(() => expect(screen.getByText("just sent")).not.toBeNull());
    // Own words: force-scrolled to the floor.
    expect(scroller.scrollTop).toBe(300);

    // The reader scrolls up to re-read while the turn runs.
    readerScroll(scroller, 40);

    // THE MOMENT OF THE BUG: the tool_call row persists and the live-sync hook
    // retires the ROUND preview — but the TURN is still in flight.
    round = 2;
    await act(async () => {
      useStreamStore.setState({ bySessionId: {} });
      await client.invalidateQueries({ queryKey: ["messages", SESSION] });
    });
    await waitFor(() => expect(screen.getByText("calling out")).not.toBeNull());

    // The turn surface is still up, and the reader was not moved.
    expect(container.querySelector("[data-vex-island-state]")).not.toBeNull();
    expect(scroller.scrollTop).toBe(40);

    await act(async () => {
      settleTurn();
      await Promise.resolve();
    });
  });
});
