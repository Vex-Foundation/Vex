/**
 * THE SCROLL MODEL — owner decree 2026-07-29: chat NEVER auto-scrolls during
 * streaming. Exactly two viewport moves are lawful, and both are here: the
 * top-anchor for a just-SENT user message, and the jump to newest when a
 * session first opens. Everything else raises the "↓ latest" pill instead of
 * taking the reader's position.
 *
 * Split out of `SessionTranscript.test.tsx` when it crossed the 550-line hard
 * limit; the render/paging/error suite keeps the main file's name. The shared
 * mocks live in `transcript-harness.ts`.
 */

import { afterEach, describe, expect, it } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";

import { SessionTranscript } from "../../SessionTranscript.js";
import { useStreamStore } from "../../../../stores/streamStore.js";
import {
  SESSION,
  anchorSpacer,
  failure,
  freshClient,
  getScroller,
  latestPill,
  listMock,
  livePreview,
  msg,
  page,
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

describe("SessionTranscript scroll model", () => {
  it("never auto-follows a new assistant row — it raises the ↓ latest pill instead", async () => {
    let withExtra = false;
    listMock.mockImplementation((input: { readonly cursor: unknown }) => {
      if (input.cursor !== null) return Promise.resolve(failure); // older fails
      // The live arrival is an ASSISTANT row. Chat NEVER auto-scrolls for it
      // (owner decree 2026-07-29) — not even from a bottom-pinned viewport.
      // Only a live USER append anchors; covered by its own test below.
      const items = withExtra
        ? [
            msg({ id: 3, role: "user", kind: "text", content: "newest" }),
            msg({ id: 4, role: "assistant", kind: "text", content: "newer" }),
          ]
        : [msg({ id: 3, role: "user", kind: "text", content: "newest" })];
      return Promise.resolve(page(items, 3)); // hasMore → load-older is offered
    });
    setVex();
    const client = freshClient();
    const { container } = render(
      createElement(SessionTranscript, { sessionId: SESSION }),
      { wrapper: makeWrapper(client) },
    );
    await waitFor(() => {
      expect(screen.getByText("newest")).not.toBeNull();
    });

    const scroller = getScroller(container);
    Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 200 });
    Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: 500 });

    // Scroll to the top → older fetch fails → banner; the anchor must clear so
    // it can never wedge a later load (the original regression this covers).
    scroller.scrollTop = 0;
    fireEvent.scroll(scroller);
    await waitFor(() => {
      expect(screen.getByText(/Couldn't load older messages/i)).not.toBeNull();
    });

    // User scrolls back to the bottom (500 - 300 - 200 = 0).
    scroller.scrollTop = 300;
    fireEvent.scroll(scroller);
    expect(latestPill(container)).toBeNull();

    // A new newest message arrives via a live refetch; the list grows taller,
    // pushing the new row out of view (700 - 300 - 200 = 200 > 48).
    withExtra = true;
    Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: 700 });
    await act(async () => {
      await client.invalidateQueries({ queryKey: ["messages", SESSION] });
    });
    await waitFor(() => {
      expect(screen.getByText("newer")).not.toBeNull();
    });

    // The reading position is UNTOUCHED — no bottom-follow, no jump.
    expect(scroller.scrollTop).toBe(300);
    // ...and the pill offers the jump instead.
    expect(latestPill(container)).not.toBeNull();
  });

  it("keeps the ↓ latest pill hidden when the newest row lands in view", async () => {
    let withExtra = false;
    listMock.mockImplementation(() => {
      const items = withExtra
        ? [
            msg({ id: 3, role: "user", kind: "text", content: "newest" }),
            msg({ id: 4, role: "assistant", kind: "text", content: "newer" }),
          ]
        : [msg({ id: 3, role: "user", kind: "text", content: "newest" })];
      return Promise.resolve(page(items, null));
    });
    setVex();
    const client = freshClient();
    const { container } = render(
      createElement(SessionTranscript, { sessionId: SESSION }),
      { wrapper: makeWrapper(client) },
    );
    await waitFor(() => {
      expect(screen.getByText("newest")).not.toBeNull();
    });

    const scroller = getScroller(container);
    Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 200 });
    Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: 500 });
    scroller.scrollTop = 300;
    fireEvent.scroll(scroller);

    // The row lands but the viewport still shows the bottom (distance 0) —
    // offering a jump to content already on screen would be noise.
    withExtra = true;
    await act(async () => {
      await client.invalidateQueries({ queryKey: ["messages", SESSION] });
    });
    await waitFor(() => {
      expect(screen.getByText("newer")).not.toBeNull();
    });
    expect(scroller.scrollTop).toBe(300);
    expect(latestPill(container)).toBeNull();
  });

  it("raises the ↓ latest pill while a reply streams out of view, and the pill jumps to the bottom", async () => {
    listMock.mockResolvedValue(
      page([msg({ id: 3, role: "user", kind: "text", content: "newest" })], null),
    );
    setVex();
    const { container } = render(
      createElement(SessionTranscript, { sessionId: SESSION }),
      { wrapper: makeWrapper(freshClient()) },
    );
    await waitFor(() => {
      expect(screen.getByText("newest")).not.toBeNull();
    });

    const scroller = getScroller(container);
    Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 200 });
    Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: 900 });
    // The reader has scrolled up, away from the bottom.
    scroller.scrollTop = 100;
    fireEvent.scroll(scroller);

    // A reply starts streaming below the fold. The transcript must NOT follow
    // it (owner decree: chat never auto-scrolls during streaming).
    act(() => {
      useStreamStore.setState({
        bySessionId: {
          [SESSION]: {
            streamId: "s1",
            text: "streaming…",
            phase: "streaming",
            toolName: null,
            reasoningText: "",
            reasoningSegments: [],
            reasoningTokens: null,
            startedAtMs: Date.now(),
            errorType: null,
            status: "writing",
          },
        },
      });
    });
    expect(scroller.scrollTop).toBe(100);

    const pill = latestPill(container);
    expect(pill).not.toBeNull();
    // Instant jump on click — no smooth behavior, so it is reduced-motion safe.
    fireEvent.click(pill as HTMLElement);
    expect(scroller.scrollTop).toBe(900);
    await waitFor(() => expect(latestPill(container)).toBeNull());
  });

  it("raises the ↓ latest pill when LIVE REASONING (not answer text) grows the island out of view", async () => {
    listMock.mockResolvedValue(
      page([msg({ id: 3, role: "user", kind: "text", content: "newest" })], null),
    );
    setVex();
    const { container } = render(
      createElement(SessionTranscript, { sessionId: SESSION }),
      { wrapper: makeWrapper(freshClient()) },
    );
    await waitFor(() => {
      expect(screen.getByText("newest")).not.toBeNull();
    });

    const scroller = getScroller(container);
    Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 200 });
    Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: 300 });
    scroller.scrollTop = 100; // bottom in view (300 − 100 − 200 = 0)
    fireEvent.scroll(scroller);
    expect(latestPill(container)).toBeNull();

    // A thinking turn starts: the ANSWER text stays empty the whole time —
    // only the reasoning grows, expanding the island into a panel. The pill
    // must still notice, which it could not while the signature ignored
    // reasoning length and status.
    act(() => {
      useStreamStore.setState({
        bySessionId: {
          [SESSION]: {
            streamId: "s1",
            text: "",
            phase: "streaming",
            toolName: null,
            reasoningText: "considering",
            reasoningSegments: [],
            reasoningTokens: null,
            startedAtMs: Date.now(),
            errorType: null,
            status: "thinking",
          },
        },
      });
    });
    // The island's panel pushed the bottom below the fold.
    Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: 900 });
    act(() => {
      useStreamStore.setState({
        bySessionId: {
          [SESSION]: {
            streamId: "s1",
            text: "",
            phase: "streaming",
            toolName: null,
            reasoningText: "considering the ledger at some length",
            reasoningSegments: [],
            reasoningTokens: null,
            startedAtMs: Date.now(),
            errorType: null,
            status: "thinking",
          },
        },
      });
    });
    expect(scroller.scrollTop).toBe(100); // still no auto-follow
    expect(latestPill(container)).not.toBeNull();
  });

  it("anchors a just-sent user message at the viewport top with a run-out spacer", async () => {
    let withExtra = false;
    listMock.mockImplementation(() => {
      const items = withExtra
        ? [
            msg({ id: 3, role: "user", kind: "text", content: "newest" }),
            msg({ id: 4, role: "user", kind: "text", content: "just sent" }),
          ]
        : [msg({ id: 3, role: "user", kind: "text", content: "newest" })];
      return Promise.resolve(page(items, null));
    });
    setVex();
    const client = freshClient();
    const { container } = render(
      createElement(SessionTranscript, { sessionId: SESSION }),
      { wrapper: makeWrapper(client) },
    );
    await waitFor(() => {
      expect(screen.getByText("newest")).not.toBeNull();
    });

    const scroller = getScroller(container);
    Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 200 });
    Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: 500 });
    scroller.scrollTop = 300; // pinned to the bottom (500 − 300 − 200 = 0)
    fireEvent.scroll(scroller);

    // The user sends a message — a LIVE user append lands via refetch.
    withExtra = true;
    await act(async () => {
      await client.invalidateQueries({ queryKey: ["messages", SESSION] });
    });
    await waitFor(() => {
      expect(screen.getByText("just sent")).not.toBeNull();
    });

    // NOT bottom-followed: anchored so the sent message reads at the top.
    // jsdom rects are all 0, so the math resolves to scrollTop − gap:
    // 0 − 0 + 300 − 12 = 288 (definitely not scrollHeight = 500).
    expect(scroller.scrollTop).toBe(288);
    // The run-out spacer opened beneath the turn (clientHeight − 96 = 104).
    const spacer = scroller.querySelector('div[aria-hidden][style*="height"]');
    expect(spacer).not.toBeNull();
    expect((spacer as HTMLElement).style.height).toBe("104px");
  });

  it("opens an UNCACHED session at the newest message, not the oldest visible row", async () => {
    // The regression this locks: opening a session with no cached page renders
    // the LOADING branch first, so the session-change effect finds no scroller
    // and the transcript opened parked at its oldest row. jsdom reports
    // scrollHeight 0, so the jump is only observable with a stubbed geometry.
    const proto = Object.getOwnPropertyDescriptor(
      window.HTMLElement.prototype,
      "scrollHeight",
    );
    Object.defineProperty(window.HTMLElement.prototype, "scrollHeight", {
      configurable: true,
      get: () => 1200,
    });
    try {
      listMock.mockResolvedValue(
        page(
          [
            msg({ id: 1, role: "user", kind: "text", content: "oldest row" }),
            msg({ id: 2, role: "assistant", kind: "text", content: "newest row" }),
          ],
          null,
        ),
      );
      setVex();
      const { container } = render(
        createElement(SessionTranscript, { sessionId: SESSION }),
        { wrapper: makeWrapper(freshClient()) },
      );
      await waitFor(() => {
        expect(screen.getByText("newest row")).not.toBeNull();
      });
      const scroller = getScroller(container);
      expect(scroller.scrollTop).toBe(1200);
      // Bottom in view → the pill has nothing to offer.
      expect(latestPill(container)).toBeNull();
    } finally {
      if (proto !== undefined) {
        Object.defineProperty(window.HTMLElement.prototype, "scrollHeight", proto);
      }
    }
  });

  it("does NOT anchor a historical trailing user message on session open", async () => {
    listMock.mockResolvedValue(
      page([msg({ id: 3, role: "user", kind: "text", content: "old send" })], null),
    );
    setVex();
    const { container } = render(
      createElement(SessionTranscript, { sessionId: SESSION }),
      { wrapper: makeWrapper(freshClient()) },
    );
    await waitFor(() => {
      expect(screen.getByText("old send")).not.toBeNull();
    });
    const scroller = getScroller(container);
    // Initial-load rows are settled history → the spacer stays collapsed
    // (no dead scroll region when browsing an old session).
    const spacer = scroller.querySelector("div[aria-hidden]:last-child");
    expect(spacer).not.toBeNull();
    expect((spacer as HTMLElement).style.height).not.toBe("104px");
  });

  /**
   * THE MID-TURN JUMP (owner report 2026-07-30: "model odpowiedział →
   * wywołał tool i przesunęło mnie w górę konwersacji").
   *
   * VERIFIED MECHANISM. A turn that calls a tool persists an ASSISTANT row
   * mid-turn. `useStreamPreviewSync` fired its clear-on-assistant-append for
   * that row, so `preview` went null WHILE THE TURN WAS STILL RUNNING. Null
   * preview drives the spacer-retirement effect, which zeroes the anchor
   * run-out; the run-out is what guarantees the scroll range under an
   * anchored user message, so scrollHeight collapses under the viewport and
   * the browser clamps scrollTop — the reader is thrown up the conversation.
   *
   * The spacer is the lever, so it is what these tests assert on: the anchor
   * run-out is TURN-scoped, not round-scoped, and survives every mid-turn row.
   */
  it("keeps the anchor run-out open when a mid-turn tool row lands (no scroll jump)", async () => {
    let round = 0;
    listMock.mockImplementation(() => {
      const items = [
        msg({ id: 3, role: "user", kind: "text", content: "newest" }),
        // Round 1: the user's send lands LIVE and anchors at the viewport top,
        // opening the run-out beneath it.
        ...(round > 0
          ? [msg({ id: 4, role: "user", kind: "text", content: "just sent" })]
          : []),
        // Round 2: the assistant's tool_call row is persisted MID-TURN.
        ...(round > 1
          ? [msg({ id: 5, role: "assistant", kind: "text", content: "calling out" })]
          : []),
      ];
      return Promise.resolve(page(items, null));
    });
    setVex();
    const client = freshClient();
    const { container } = render(
      createElement(SessionTranscript, { sessionId: SESSION }),
      { wrapper: makeWrapper(client) },
    );
    await waitFor(() => {
      expect(screen.getByText("newest")).not.toBeNull();
    });
    const scroller = getScroller(container);
    Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 200 });
    Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: 500 });

    // The send: the turn opens and the user row lands live.
    const settleTurn = startChatTurn(client);
    round = 1;
    await act(async () => {
      await client.invalidateQueries({ queryKey: ["messages", SESSION] });
    });
    await waitFor(() => {
      expect(screen.getByText("just sent")).not.toBeNull();
    });

    // The reply streams; the run-out is open beneath the anchored send.
    act(() => {
      useStreamStore.setState({
        bySessionId: { [SESSION]: livePreview({ text: "working on it" }) },
      });
    });
    expect(anchorSpacer(container).style.height).toBe("104px");

    // THE MOMENT OF THE BUG: the tool_call row persists and the live-sync
    // hook retires the preview — but the TURN is still in flight.
    round = 2;
    await act(async () => {
      useStreamStore.setState({ bySessionId: {} });
      await client.invalidateQueries({ queryKey: ["messages", SESSION] });
    });
    await waitFor(() => {
      expect(screen.getByText("calling out")).not.toBeNull();
    });

    // The run-out is still open — the geometry never collapsed, so nothing
    // clamped the reader's position.
    expect(anchorSpacer(container).style.height).toBe("104px");

    // ...and it retires only when the TURN itself settles.
    await act(async () => {
      settleTurn();
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(anchorSpacer(container).style.height).toBe("0px");
    });
  });

  /**
   * THE GHOST MOMENT (owner report 2026-07-30: "moment wysłania wiadomości
   * (jest ghost effect), nic nie ma na ekranie i user myśli że nic nie
   * działa"). The island used to mount on the FIRST provider delta, which is
   * a whole network round-trip after the send. It must mount on the SUBMIT.
   */
  it("shows the working island the INSTANT a turn is submitted, before any delta", async () => {
    listMock.mockResolvedValue(
      page([msg({ id: 3, role: "user", kind: "text", content: "newest" })], null),
    );
    setVex();
    const client = freshClient();
    const { container } = render(
      createElement(SessionTranscript, { sessionId: SESSION }),
      { wrapper: makeWrapper(client) },
    );
    await waitFor(() => {
      expect(screen.getByText("newest")).not.toBeNull();
    });
    // No turn, no island.
    expect(container.querySelector("[data-vex-island-state]")).toBeNull();

    const settleTurn = startChatTurn(client);
    await waitFor(() => {
      const island = container.querySelector("[data-vex-island-state]");
      expect(island).not.toBeNull();
      // Nothing is classified yet — the honest state is "working".
      expect(island?.getAttribute("data-vex-island-state")).toBe("working");
    });

    // The first real delta takes over the same surface, not a second one.
    act(() => {
      useStreamStore.setState({
        bySessionId: { [SESSION]: livePreview({ reasoningText: "hm", status: "thinking" }) },
      });
    });
    await waitFor(() => {
      expect(
        container.querySelectorAll("[data-vex-island-state]"),
      ).toHaveLength(1);
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
});
