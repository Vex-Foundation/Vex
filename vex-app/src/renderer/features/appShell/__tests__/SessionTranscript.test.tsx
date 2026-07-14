/**
 * SessionTranscript render tests (stage 8-1 + 8-2b).
 *
 * Drives the real `useTranscriptInfinite` path through a mocked
 * `window.vex.messages.list` (cursor-based) + a live QueryClient. Verifies:
 * newest-page render with role selectors; content stays literal (never HTML);
 * empty + initial-error states; load-older on scroll-to-top; and an
 * older-page failure that keeps loaded messages and shows a top banner.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
import type {
  MessageKind,
  MessageRole,
  SessionMessageDto,
} from "@shared/schemas/messages.js";
import { SessionTranscript } from "../SessionTranscript.js";
import { useStreamStore } from "../../../stores/streamStore.js";

const SESSION = "00000000-0000-4000-8000-0000000000aa";
const ISO = "2026-05-26T10:00:00.000Z";
const listMock = vi.fn();
// S5: SessionTranscript now observes pending approvals (act-ledger stamps +
// the working strip's circuit-break). Default: none pending.
const listPendingMock = vi.fn();

function ok<T>(data: T) {
  return { ok: true as const, data };
}

function msg(p: {
  readonly id: number;
  readonly role: MessageRole;
  readonly kind: MessageKind;
  readonly content: string;
  readonly toolName?: string | null;
}): SessionMessageDto {
  return {
    id: p.id,
    sessionId: SESSION,
    role: p.role,
    kind: p.kind,
    content: p.content,
    createdAt: ISO,
    toolCallId: null,
    toolName: p.toolName ?? null,
    toolCalls: null,
    explorerRefs: null,
  };
}

function page(items: SessionMessageDto[], nextCursorId: number | null) {
  return ok({
    items,
    nextCursor: nextCursorId === null ? null : { createdAt: ISO, id: nextCursorId },
    hasMore: nextCursorId !== null,
  });
}

const failure = {
  ok: false as const,
  error: {
    code: "internal.unexpected",
    domain: "data",
    message: "DB is down",
    retryable: true,
    userActionable: true,
    redacted: true,
    correlationId: "c",
  },
};

function setVex(): void {
  listPendingMock.mockResolvedValue(ok([]));
  Object.defineProperty(window, "vex", {
    configurable: true,
    writable: true,
    value: {
      messages: { list: listMock },
      approvals: { listPending: listPendingMock },
    },
  });
}

function makeWrapper(client: QueryClient) {
  return function Wrapper({ children }: { readonly children: ReactNode }) {
    return createElement(QueryClientProvider, { client }, children);
  };
}

function freshClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function getScroller(container: HTMLElement): HTMLElement {
  const el = container.querySelector('[data-vex-area="chat-transcript"]');
  if (el === null) throw new Error("transcript scroller not found");
  return el as HTMLElement;
}

afterEach(() => {
  vi.clearAllMocks();
  useStreamStore.setState({ bySessionId: {} });
  // @ts-expect-error — test cleanup
  delete window.vex;
});

describe("SessionTranscript", () => {
  it("renders the newest page rows and never parses content as HTML", async () => {
    const injected = '<img src=x onerror="alert(1)"> **not bold**';
    listMock.mockResolvedValue(
      page(
        [
          msg({ id: 1, role: "user", kind: "text", content: "hello vex" }),
          msg({ id: 2, role: "assistant", kind: "text", content: injected }),
          msg({
            id: 3,
            role: "tool",
            kind: "tool_result",
            content: "ok",
            toolName: "swap",
          }),
          msg({
            id: 4,
            role: "system",
            kind: "runtime_notice",
            content: "context compacted",
          }),
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
      expect(screen.getByText("hello vex")).not.toBeNull();
    });
    expect(container.querySelector('[data-vex-message-role="user"]')).not.toBeNull();
    expect(
      container.querySelector('[data-vex-message-role="assistant"]'),
    ).not.toBeNull();
    expect(container.querySelector('[data-vex-message-role="tool"]')).not.toBeNull();
    expect(
      container.querySelector('[data-vex-message-role="system"]'),
    ).not.toBeNull();
    // tool_result rows now render a collapsed disclosure labeled `<tool>_output`.
    expect(screen.getByText("swap_output")).not.toBeNull();
    expect(screen.getByText("context compacted")).not.toBeNull();
    expect(screen.getByText(/onerror="alert\(1\)"/)).not.toBeNull();
    expect(container.querySelector("img[onerror]")).toBeNull();
    // Assistant turns now carry the decorative Vex avatar on the tape spine —
    // it is the only image and is aria-hidden (the "Vex" caption names the turn).
    const avatar = container.querySelector('img[src="/vex.jpg"]');
    expect(avatar).not.toBeNull();
    expect(avatar?.getAttribute("aria-hidden")).toBe("true");
    expect(listMock).toHaveBeenCalledWith({
      sessionId: SESSION,
      cursor: null,
      limit: 50,
    });
  });

  it("shows the empty state when there are no messages", async () => {
    listMock.mockResolvedValue(page([], null));
    setVex();
    render(createElement(SessionTranscript, { sessionId: SESSION }), {
      wrapper: makeWrapper(freshClient()),
    });
    await waitFor(() => {
      expect(screen.getByText(/Start the conversation/i)).not.toBeNull();
    });
  });

  it("renders the streaming preview when the transcript is empty (new session)", async () => {
    listMock.mockResolvedValue(page([], null));
    setVex();
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
          status: "writing",
        },
      },
    });
    const { container } = render(
      createElement(SessionTranscript, { sessionId: SESSION }),
      { wrapper: makeWrapper(freshClient()) },
    );

    await waitFor(() => {
      expect(container.querySelector('[data-vex-area="stream-preview"]')).not.toBeNull();
    });
    // The empty-state copy must NOT show while a preview is live.
    expect(screen.queryByText(/Start the conversation/i)).toBeNull();
  });

  it("surfaces an initial-page failure as an alert", async () => {
    listMock.mockResolvedValue(failure);
    setVex();
    render(createElement(SessionTranscript, { sessionId: SESSION }), {
      wrapper: makeWrapper(freshClient()),
    });
    await waitFor(() => {
      expect(screen.getByText("DB is down")).not.toBeNull();
    });
    expect(screen.getByRole("alert")).not.toBeNull();
  });

  it("loads an older page when scrolled to the top", async () => {
    listMock.mockImplementation((input: { readonly cursor: unknown }) =>
      Promise.resolve(
        input.cursor === null
          ? page([msg({ id: 3, role: "user", kind: "text", content: "newest" })], 3)
          : page([msg({ id: 1, role: "user", kind: "text", content: "oldest" })], null),
      ),
    );
    setVex();
    const { container } = render(
      createElement(SessionTranscript, { sessionId: SESSION }),
      { wrapper: makeWrapper(freshClient()) },
    );

    await waitFor(() => {
      expect(screen.getByText("newest")).not.toBeNull();
    });
    fireEvent.scroll(getScroller(container));
    await waitFor(() => {
      expect(screen.getByText("oldest")).not.toBeNull();
    });
    expect(screen.getByText("newest")).not.toBeNull();
  });

  it("keeps loaded messages and shows a banner when an older page fails", async () => {
    listMock.mockImplementation((input: { readonly cursor: unknown }) =>
      Promise.resolve(
        input.cursor === null
          ? page([msg({ id: 3, role: "user", kind: "text", content: "newest" })], 3)
          : failure,
      ),
    );
    setVex();
    const { container } = render(
      createElement(SessionTranscript, { sessionId: SESSION }),
      { wrapper: makeWrapper(freshClient()) },
    );

    await waitFor(() => {
      expect(screen.getByText("newest")).not.toBeNull();
    });
    fireEvent.scroll(getScroller(container));
    await waitFor(() => {
      expect(screen.getByText(/Couldn't load older messages/i)).not.toBeNull();
    });
    expect(screen.getByText("newest")).not.toBeNull();
  });

  it("does not wedge after an older-page failure: a later new message still bottom-follows", async () => {
    let withExtra = false;
    listMock.mockImplementation((input: { readonly cursor: unknown }) => {
      if (input.cursor !== null) return Promise.resolve(failure); // older fails
      // The live arrival is an ASSISTANT row — bottom-follow semantics. (A
      // live USER row now top-anchors instead; covered by its own test.)
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

    // Scroll to the top → older fetch fails → banner; the anchor must clear.
    scroller.scrollTop = 0;
    fireEvent.scroll(scroller);
    await waitFor(() => {
      expect(screen.getByText(/Couldn't load older messages/i)).not.toBeNull();
    });

    // User scrolls back to the bottom → re-pinned (500 - 300 - 200 = 0 < 48).
    scroller.scrollTop = 300;
    fireEvent.scroll(scroller);

    // A new newest message arrives via a live refetch; the list grows taller.
    withExtra = true;
    Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: 700 });
    await act(async () => {
      await client.invalidateQueries({ queryKey: ["messages", SESSION] });
    });
    await waitFor(() => {
      expect(screen.getByText("newer")).not.toBeNull();
    });

    // Bottom-follow ran (a stale anchor would have blocked it) → scrolled to 700.
    expect(scroller.scrollTop).toBe(700);
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
