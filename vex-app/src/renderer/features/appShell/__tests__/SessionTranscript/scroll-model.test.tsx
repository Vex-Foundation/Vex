/**
 * THE SCROLL MODEL - the newest user turn anchored at the top, with reader
 * ownership (owner, 2026-10-25, for v0.4.3). This REVERSES owner decision 3
 * (2026-08-21): a send no longer force-scrolls to the floor. The pure policy
 * has its own suite (`scroll-follow.test.ts`); this one drives it through the
 * real `SessionTranscript`.
 *
 * What each case here is actually a claim about:
 *
 *  - landing: a session opens at the floor and follows the streaming tip;
 *  - reader-release: a reader scroll away frees the view, and nothing the
 *    stream does afterwards takes it back;
 *  - threshold-entry-must-not-snap: a chrome re-render inside the follow band
 *    must not finish the reader's scroll for them;
 *  - anchor-on-own-send (was force-scroll-on-own-send): a live trailing user
 *    row, or a steering mark, goes to the TOP of the view, pinned or not, and
 *    the reply then grows beneath it with no `scrollTop` write;
 *  - shrink-clamp delivery: a non-reader event that lands on the floor
 *    minimum preserves ownership rather than reading as a reader gesture;
 *  - reader intent: a wheel holds growth writes until its sample settles;
 *  - prepend anchor: an older page restores the reader's LATEST intent, and
 *    returning to the floor cancels the anchor entirely;
 *  - following-vs-saved on remount: following saves nothing (land at the
 *    floor), a free position restores against its anchor ROW.
 *
 * Contract changes from the follow-stream suite, case by case:
 *  - the force-scroll-on-own-send pair now expects the row at the top
 *    (`ANCHOR_AIR_PX` below the view's top), not `scrollTop` at the floor;
 *  - the mid-turn tool row case expects the send to anchor, not to jump to
 *    the floor; the rest of it (the reader is not moved) is unchanged;
 *  - geometry comes from `installLayout`, in place from the first commit,
 *    where the old cases scripted it after mount and fired a bare `scroll` to
 *    re-land: the controller only follows on reported growth, so an
 *    unreported geometry change plus a no-movement scroll event does nothing;
 *  - `readerScroll` ends its gesture with `scrollend`, which settles the
 *    controller's 500ms reader sample (the old model decided on the scroll
 *    event itself).
 *
 * No wall-clock sleeps anywhere.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";

import { SessionTranscript } from "../../SessionTranscript.js";
import { ANCHOR_AIR_PX } from "../../SessionTranscript/scrollFollow.js";
import { useStreamStore } from "../../../../stores/streamStore.js";
import {
  SESSION,
  failure,
  freshClient,
  getScroller,
  installLayout,
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
  type ScriptedLayout,
} from "./transcript-harness.js";

function makeWrapper(client: QueryClient) {
  return function Wrapper({ children }: { readonly children: ReactNode }) {
    return createElement(QueryClientProvider, { client }, children);
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  resetTranscriptEnv();
});

async function mount(client: QueryClient = freshClient()) {
  setVex();
  const view = render(createElement(SessionTranscript, { sessionId: SESSION }), {
    wrapper: makeWrapper(client),
  });
  return view;
}

function layout(
  scrollHeight: number,
  clientHeight: number,
  rows: Record<string, number> = {},
): ScriptedLayout {
  const scripted: ScriptedLayout = {
    scrollHeight,
    clientHeight,
    rows: new Map(Object.entries(rows)),
    writes: 0,
  };
  installLayout(scripted);
  return scripted;
}

function followMode(container: HTMLElement): string | null {
  return getScroller(container).getAttribute("data-vex-follow-mode");
}

function stream(text: string): void {
  act(() => {
    useStreamStore.setState({
      bySessionId: { [SESSION]: livePreview({ text }) },
    });
  });
}

function requirePill(container: HTMLElement): HTMLElement {
  const pill = latestPill(container);
  if (pill === null) throw new Error("jump pill not shown");
  return pill;
}

describe("SessionTranscript anchored scroll model", () => {
  it("opens a session at the floor and follows the streaming tip", async () => {
    const geometry = layout(500, 200);
    listMock.mockResolvedValue(
      page([msg({ id: 3, role: "user", kind: "text", content: "newest" })], null),
    );
    const { container } = await mount();
    await waitFor(() => expect(screen.getByText("newest")).not.toBeNull());

    const scroller = getScroller(container);
    expect(scroller.scrollTop).toBe(300);
    expect(followMode(container)).toBe("tail");
    expect(latestPill(container)).toBeNull();

    // A reply streams in and grows the flow. Following → the model follows it.
    geometry.scrollHeight = 900;
    stream("streaming…");
    expect(scroller.scrollTop).toBe(700);
    expect(latestPill(container)).toBeNull();
  });

  it("reader-release: a reader scroll away frees the view, and the stream never takes it back", async () => {
    const geometry = layout(900, 200);
    listMock.mockResolvedValue(
      page([msg({ id: 3, role: "user", kind: "text", content: "newest" })], null),
    );
    const { container } = await mount();
    await waitFor(() => expect(screen.getByText("newest")).not.toBeNull());

    const scroller = getScroller(container);
    readerScroll(scroller, 100);
    expect(followMode(container)).toBe("free");
    expect(latestPill(container)).not.toBeNull();

    // Two streamed growth ticks: the reader owns the viewport, so neither
    // moves it. This is the whole point of the ownership ledger.
    stream("one");
    geometry.scrollHeight = 1400;
    stream("one two three");
    expect(scroller.scrollTop).toBe(100);

    // The pill offers the jump the model refused to take. Instant, so it needs
    // no reduced-motion branch.
    fireEvent.click(requirePill(container));
    expect(scroller.scrollTop).toBe(1200);
    await waitFor(() => expect(latestPill(container)).toBeNull());
    expect(followMode(container)).toBe("tail");
  });

  it("threshold-entry-must-not-snap: stopping inside the follow band leaves the remaining distance alone", async () => {
    layout(1000, 300);
    listMock.mockResolvedValue(
      page([msg({ id: 3, role: "user", kind: "text", content: "newest" })], null),
    );
    const { container } = await mount();
    await waitFor(() => expect(screen.getByText("newest")).not.toBeNull());

    const scroller = getScroller(container);
    readerScroll(scroller, 100);
    expect(latestPill(container)).not.toBeNull();

    // Inside the 25px band but NOT flush with the floor (700): following
    // resumes, and the chrome re-render from hiding the pill must not finish
    // the scroll - the signature did not move, so nothing is written.
    readerScroll(scroller, 690);
    expect(latestPill(container)).toBeNull();
    expect(followMode(container)).toBe("tail");
    expect(scroller.scrollTop).toBe(690);
  });

  it("anchor-on-own-send: a live trailing USER row goes to the top, even from a free view, and the reply grows beneath it", async () => {
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
    const geometry = layout(900, 200, { "3": 100 });
    const client = freshClient();
    const { container } = await mount(client);
    await waitFor(() => expect(screen.getByText("newest")).not.toBeNull());

    const scroller = getScroller(container);
    // The reader is reading history, far from the floor, and OWNS the
    // viewport. Own words override that ownership; nothing else does.
    readerScroll(scroller, 50);
    expect(latestPill(container)).not.toBeNull();

    sent = true;
    geometry.scrollHeight = 1600;
    geometry.rows.set("4", 700);
    await act(async () => {
      await client.invalidateQueries({ queryKey: ["messages", SESSION] });
    });
    await waitFor(() => expect(screen.getByText("just sent")).not.toBeNull());
    // One write puts the sent row ANCHOR_AIR_PX below the top of the view.
    expect(scroller.scrollTop).toBe(700 - ANCHOR_AIR_PX);
    expect(followMode(container)).toBe("anchor");

    // The reply streams: the flow grows below, and nothing writes scrollTop.
    const writes = geometry.writes;
    geometry.scrollHeight = 1800;
    stream("a long answer");
    geometry.scrollHeight = 2400;
    stream("a long answer that keeps growing well past the fold");
    expect(scroller.scrollTop).toBe(700 - ANCHOR_AIR_PX);
    expect(geometry.writes).toBe(writes);
    expect(followMode(container)).toBe("anchor");
    // Content waits below the view: the pill offers it.
    expect(latestPill(container)).not.toBeNull();
  });

  it("anchor-on-own-send: a NEW STEERING MARK goes to the top the same way", async () => {
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
    const geometry = layout(900, 200, { "3": 100, "4": 200 });
    const client = freshClient();
    const { container } = await mount(client);
    await waitFor(() => expect(screen.getByText("reply")).not.toBeNull());

    const scroller = getScroller(container);
    readerScroll(scroller, 40);
    expect(latestPill(container)).not.toBeNull();

    steered = true;
    geometry.scrollHeight = 1100;
    geometry.rows.set("5", 800);
    await act(async () => {
      await client.invalidateQueries({ queryKey: ["messages", SESSION] });
    });
    await waitFor(() => expect(screen.getByText("steer me")).not.toBeNull());
    expect(scroller.scrollTop).toBe(800 - ANCHOR_AIR_PX);
    expect(followMode(container)).toBe("anchor");
  });

  it("the FIRST turn of a session anchors at the top of the transcript, and the reply never moves it", async () => {
    let sent = false;
    listMock.mockImplementation(() =>
      Promise.resolve(
        page(
          sent
            ? [msg({ id: 1, role: "user", kind: "text", content: "first words" })]
            : [],
          null,
        ),
      ),
    );
    const geometry = layout(400, 300, { "1": 40 });
    const client = freshClient();
    const settleTurn = startChatTurn(client);
    const { container } = await mount(client);
    // The send edge mounts the transcript with only the live turn in it.
    await waitFor(() =>
      expect(container.querySelector("[data-vex-island-state]")).not.toBeNull(),
    );

    sent = true;
    await act(async () => {
      await client.invalidateQueries({ queryKey: ["messages", SESSION] });
    });
    await waitFor(() => expect(screen.getByText("first words")).not.toBeNull());
    // The one user row of a session whose head is loaded opens it: 0, so the
    // day label above it stays in view.
    expect(getScroller(container).scrollTop).toBe(0);
    expect(followMode(container)).toBe("anchor");

    const writes = geometry.writes;
    geometry.scrollHeight = 2000;
    stream("an answer longer than the view");
    expect(getScroller(container).scrollTop).toBe(0);
    expect(geometry.writes).toBe(writes);

    await act(async () => {
      settleTurn();
      await Promise.resolve();
    });
  });

  it("a HISTORICAL trailing user row on session open does not force anything beyond the landing", async () => {
    layout(900, 200);
    listMock.mockResolvedValue(
      page([msg({ id: 3, role: "user", kind: "text", content: "old send" })], null),
    );
    const { container } = await mount();
    await waitFor(() => expect(screen.getByText("old send")).not.toBeNull());

    const scroller = getScroller(container);
    expect(scroller.scrollTop).toBe(700);
    expect(followMode(container)).toBe("tail");
    // The reader browses upward; a settled row is history, never "own words",
    // so nothing pulls the viewport back.
    readerScroll(scroller, 100);
    expect(scroller.scrollTop).toBe(100);
    expect(latestPill(container)).not.toBeNull();
  });

  it("shrink-clamp delivery: a non-reader event landing on the floor preserves ownership", async () => {
    const geometry = layout(1000, 300);
    listMock.mockResolvedValue(
      page([msg({ id: 3, role: "user", kind: "text", content: "newest" })], null),
    );
    const { container } = await mount();
    await waitFor(() => expect(screen.getByText("newest")).not.toBeNull());

    const scroller = getScroller(container);
    expect(scroller.scrollTop).toBe(700);

    // The flow shrinks (a turn settles and retires its preview). The engine
    // clamps scrollTop to the new floor and delivers a scroll event that the
    // model did NOT write. Reading that as a reader gesture would silently
    // disarm follow; it lands on min(ledger, floor), so it is not one.
    geometry.scrollHeight = 600;
    fireEvent.scroll(scroller);
    expect(scroller.scrollTop).toBe(300);
    expect(latestPill(container)).toBeNull();
    expect(followMode(container)).toBe("tail");

    // Still following: the next tip move lands at the new floor.
    geometry.scrollHeight = 1200;
    stream("more");
    expect(scroller.scrollTop).toBe(900);
  });

  it("one ResizeObserver reports growth: following follows it, a free reader is left alone", async () => {
    const observer = installResizeObserver();
    const geometry = layout(1000, 300);
    listMock.mockResolvedValue(
      page([msg({ id: 3, role: "user", kind: "text", content: "newest" })], null),
    );
    const { container } = await mount();
    await waitFor(() => expect(screen.getByText("newest")).not.toBeNull());

    const scroller = getScroller(container);
    expect(scroller.scrollTop).toBe(700);

    // A disclosure opens / the draft grows: the column resizes with no new
    // rows and no new deltas, so ONLY the observer can notice.
    geometry.scrollHeight = 1200;
    act(() => {
      observer.notify();
    });
    expect(scroller.scrollTop).toBe(900);

    // The reader takes ownership; later growth must not move them.
    readerScroll(scroller, 200);
    geometry.scrollHeight = 1400;
    act(() => {
      observer.notify();
    });
    expect(scroller.scrollTop).toBe(200);
  });

  it("an approval card or launch form growing below an anchored turn never moves the view", async () => {
    const observer = installResizeObserver();
    let sent = false;
    listMock.mockImplementation(() =>
      Promise.resolve(
        page(
          sent
            ? [
                msg({ id: 3, role: "user", kind: "text", content: "newest" }),
                msg({ id: 4, role: "user", kind: "text", content: "buy it" }),
              ]
            : [msg({ id: 3, role: "user", kind: "text", content: "newest" })],
          null,
        ),
      ),
    );
    const geometry = layout(900, 200, { "3": 100 });
    const client = freshClient();
    const { container } = await mount(client);
    await waitFor(() => expect(screen.getByText("newest")).not.toBeNull());

    sent = true;
    geometry.scrollHeight = 1200;
    geometry.rows.set("4", 800);
    await act(async () => {
      await client.invalidateQueries({ queryKey: ["messages", SESSION] });
    });
    await waitFor(() => expect(screen.getByText("buy it")).not.toBeNull());
    const scroller = getScroller(container);
    expect(scroller.scrollTop).toBe(800 - ANCHOR_AIR_PX);

    // The card mounts below the reply: only the observer reports it.
    const writes = geometry.writes;
    geometry.scrollHeight = 1700;
    act(() => {
      observer.notify();
    });
    expect(scroller.scrollTop).toBe(800 - ANCHOR_AIR_PX);
    expect(geometry.writes).toBe(writes);
    expect(followMode(container)).toBe("anchor");
  });

  it("reader intent: a wheel holds growth writes until its sample settles, then catches up once", async () => {
    const geometry = layout(1000, 300);
    listMock.mockResolvedValue(
      page([msg({ id: 3, role: "user", kind: "text", content: "newest" })], null),
    );
    const { container } = await mount();
    await waitFor(() => expect(screen.getByText("newest")).not.toBeNull());

    const scroller = getScroller(container);
    expect(scroller.scrollTop).toBe(700);
    fireEvent.wheel(scroller);
    geometry.scrollHeight = 1200;
    stream("growth inside the sample");
    expect(scroller.scrollTop).toBe(700);

    // The wheel moved nothing: the sample keeps following and catches up.
    fireEvent(scroller, new Event("scrollend"));
    expect(scroller.scrollTop).toBe(900);
    expect(followMode(container)).toBe("tail");
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
    // The shift moved the ledger with it: the reader is still free there.
    expect(followMode(container)).toBe("free");
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

    // Back at the floor: the anchor is cleared, follow resumes, and the failed
    // page can never wedge a later one.
    readerScroll(scroller, 600);
    expect(latestPill(container)).toBeNull();
    expect(scroller.scrollTop).toBe(600);
    expect(followMode(container)).toBe("tail");
  });

  it("following-vs-saved on remount: following lands at the floor, a free position restores its anchor ROW", async () => {
    listMock.mockResolvedValue(
      page([msg({ id: 3, role: "user", kind: "text", content: "newest" })], null),
    );
    const geometry = layout(2000, 500, { "3": 80 });
    const client = freshClient();
    const first = await mount(client);
    await waitFor(() => expect(screen.getByText("newest")).not.toBeNull());
    // Following saves nothing: a remount lands at the floor again.
    expect(getScroller(first.container).scrollTop).toBe(1500);
    first.unmount();

    const again = await mount(client);
    await waitFor(() => expect(screen.getByText("newest")).not.toBeNull());
    const againScroller = getScroller(again.container);
    expect(againScroller.scrollTop).toBe(1500);

    // Now a FREE position, saved continuously: the row sits 20px above the
    // view's top.
    readerScroll(againScroller, 100);
    expect(followMode(again.container)).toBe("free");
    again.unmount();

    // The row reflows to a different offset (a width change between mounts).
    // The restore must land on the ROW, not on the old pixel: 20px above the
    // top again, at 640 - 20.
    geometry.rows.set("3", 640);
    const restored = await mount(client);
    await waitFor(() => expect(screen.getByText("newest")).not.toBeNull());
    expect(getScroller(restored.container).scrollTop).toBe(660);
    expect(followMode(restored.container)).toBe("free");
    expect(latestPill(restored.container)).not.toBeNull();
  });

  it("shows the working island the INSTANT a turn is submitted, before any delta", async () => {
    // THE GHOST MOMENT (owner report 2026-07-30). The island used to mount on
    // the first provider delta, a whole round-trip after the send. It must
    // mount on the SUBMIT, and the scroll model must not depend on it.
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
    // assistant row mid-turn and the round-scoped preview goes null. What this
    // guards: the TURN-scoped preview survives the mid-turn row, and a reader
    // who scrolled away from the anchored turn is not moved by it.
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
    const geometry = layout(500, 200, { "3": 100 });
    const client = freshClient();
    const { container } = await mount(client);
    await waitFor(() => expect(screen.getByText("newest")).not.toBeNull());

    const scroller = getScroller(container);
    const settleTurn = startChatTurn(client);
    round = 1;
    geometry.scrollHeight = 900;
    geometry.rows.set("4", 460);
    await act(async () => {
      await client.invalidateQueries({ queryKey: ["messages", SESSION] });
    });
    await waitFor(() => expect(screen.getByText("just sent")).not.toBeNull());
    // Own words: anchored at the top, not forced to the floor.
    expect(scroller.scrollTop).toBe(460 - ANCHOR_AIR_PX);

    // The reader scrolls up to re-read while the turn runs.
    readerScroll(scroller, 40);

    // THE MOMENT OF THE BUG: the tool_call row persists and the live-sync hook
    // retires the ROUND preview - but the TURN is still in flight.
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
