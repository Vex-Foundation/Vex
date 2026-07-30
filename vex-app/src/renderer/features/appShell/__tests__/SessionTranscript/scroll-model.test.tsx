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
  failure,
  freshClient,
  getScroller,
  latestPill,
  listMock,
  msg,
  page,
  resetTranscriptEnv,
  setVex,
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
});
