/**
 * SessionTranscript render + paging tests (stage 8-1 + 8-2b).
 *
 * Drives the real `useTranscriptInfinite` path through a mocked
 * `window.vex.messages.list` (cursor-based) + a live QueryClient. Verifies:
 * newest-page render with role selectors; content stays literal (never HTML);
 * empty + initial-error states; load-older on scroll-to-top; and an
 * older-page failure that keeps loaded messages and shows a top banner.
 *
 * This suite crossed the 550-line hard limit and was split by responsibility;
 * the file KEEPS its name while the scroll model moved to the sibling
 * `SessionTranscript/` folder:
 *   - `scroll-model.test.tsx` — the pill, the top-anchor, the open-at-newest jump.
 *   - `transcript-harness.ts` — the shared mocks, DTO builder and DOM probes.
 */

import { afterEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";

import { SessionTranscript } from "../SessionTranscript.js";
import { findWorkingAgentEntryKey } from "../agentActivity.js";
import type { TranscriptEntry } from "../transcriptRowModel.js";
import { useStreamStore } from "../../../stores/streamStore.js";
import {
  ISO,
  SESSION,
  failure,
  freshClient,
  getScroller,
  listMock,
  msg,
  page,
  resetTranscriptEnv,
  setVex,
} from "./SessionTranscript/transcript-harness.js";

function makeWrapper(client: QueryClient) {
  return function Wrapper({ children }: { readonly children: ReactNode }) {
    return createElement(QueryClientProvider, { client }, children);
  };
}

afterEach(resetTranscriptEnv);

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
    // Assistant turns are signed by the inline VexMark on the tape spine, not
    // by a raster portrait: no <img> reaches the transcript at all, and the
    // mark is aria-hidden because the row's sr-only label names the speaker.
    const avatar = container.querySelector("[data-vex-agent-avatar] svg");
    expect(avatar).not.toBeNull();
    expect(avatar?.getAttribute("aria-hidden")).toBe("true");
    expect(container.querySelector("img")).toBeNull();
    expect(listMock).toHaveBeenCalledWith({
      sessionId: SESSION,
      cursor: null,
      limit: 50,
    });
  });

  it("selects only the current turn's newest agent avatar as working", () => {
    const rows: TranscriptEntry[] = [
      {
        id: 1,
        variant: "assistant" as const,
        label: null,
        content: "Earlier reply",
        createdAt: ISO,
      },
      {
        id: 2,
        variant: "user" as const,
        label: null,
        content: "Send SOL",
        createdAt: ISO,
      },
      {
        id: 3,
        variant: "assistant" as const,
        label: null,
        content: "Preparing transfer",
        createdAt: ISO,
      },
      {
        id: 4,
        variant: "tool" as const,
        label: "wallet_send_prepare_output",
        toolKind: "result" as const,
        content: "prepared",
        createdAt: ISO,
      },
    ];

    expect(findWorkingAgentEntryKey(rows, true)).toBe("3");
    expect(findWorkingAgentEntryKey(rows, false)).toBeNull();
    expect(findWorkingAgentEntryKey(rows.slice(0, 2), true)).toBeNull();
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
          errorType: null,
          errorDetail: null,
          reasoningText: "",
          reasoningSegments: [],
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

});
