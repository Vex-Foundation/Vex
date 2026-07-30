/**
 * Shared harness for the `SessionTranscript` suites.
 *
 * Extracted when the single suite crossed the 550-line hard limit and split by
 * responsibility (paging/render vs the scroll model). Both suites drive the
 * REAL `useTranscriptInfinite` path through one mocked `window.vex.messages.list`,
 * so the mocks, the DTO builder and the DOM probes live here rather than being
 * copied — a divergent fixture between the two would be a silent hole.
 */

import { vi } from "vitest";
import { MutationObserver, QueryClient } from "@tanstack/react-query";
import { CHAT_SUBMIT_MUTATION_KEY } from "../../../../lib/api/chat.js";
import type {
  MessageKind,
  MessageRole,
  SessionMessageDto,
} from "@shared/schemas/messages.js";
import {
  useStreamStore,
  type StreamPreview,
} from "../../../../stores/streamStore.js";

export const SESSION = "00000000-0000-4000-8000-0000000000aa";
export const ISO = "2026-05-26T10:00:00.000Z";

export const listMock = vi.fn();
// S5: SessionTranscript observes pending approvals (act-ledger stamps + the
// working strip's circuit-break). Default: none pending.
export const listPendingMock = vi.fn();

export function ok<T>(data: T) {
  return { ok: true as const, data };
}

export function msg(p: {
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
    reasoning: null,
    durationMs: null,
    success: null,
  };
}

export function page(items: SessionMessageDto[], nextCursorId: number | null) {
  return ok({
    items,
    nextCursor: nextCursorId === null ? null : { createdAt: ISO, id: nextCursorId },
    hasMore: nextCursorId !== null,
  });
}

export const failure = {
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

export function setVex(): void {
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

export function freshClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

export function getScroller(container: HTMLElement): HTMLElement {
  const el = container.querySelector('[data-vex-area="chat-transcript"]');
  if (el === null) throw new Error("transcript scroller not found");
  return el as HTMLElement;
}

/** The "↓ latest" jump pill — absent from the DOM while the bottom is in view. */
export function latestPill(container: HTMLElement): HTMLElement | null {
  return container.querySelector("[data-vex-latest-pill]");
}

/**
 * Put a chat turn IN FLIGHT for `SESSION` — a pending mutation under the real
 * `CHAT_SUBMIT_MUTATION_KEY`, which is exactly what `useIsChatSubmitting`
 * reads. Driven through the shared mutation cache rather than a mocked hook so
 * the transcript's turn-scoping is exercised against the real signal.
 *
 * `chat.submit`'s promise spans the WHOLE turn (provider rounds AND tool
 * execution), so "pending" here means "the turn has not settled" — the same
 * meaning the product relies on. Returns the settle function.
 */
export function startChatTurn(client: QueryClient): () => void {
  let settle: () => void = () => undefined;
  const observer = new MutationObserver<unknown, Error, { sessionId: string }>(
    client,
    {
      mutationKey: CHAT_SUBMIT_MUTATION_KEY,
      mutationFn: () =>
        new Promise<unknown>((resolve) => {
          settle = () => resolve(undefined);
        }),
    },
  );
  void observer.mutate({ sessionId: SESSION }).catch(() => undefined);
  return () => settle();
}

/** The anchor run-out spacer — the last aria-hidden child of the row list. */
export function anchorSpacer(container: HTMLElement): HTMLElement {
  const el = getScroller(container).querySelector("div[aria-hidden]:last-child");
  if (el === null) throw new Error("anchor spacer not found");
  return el as HTMLElement;
}

/** A streaming `StreamPreview`, with the fields a test cares about overridden. */
export function livePreview(
  over: Partial<StreamPreview> = {},
): StreamPreview {
  return {
    streamId: "s1",
    text: "",
    phase: "streaming",
    toolName: null,
    reasoningSegments: [],
    reasoningText: "",
    reasoningTokens: null,
    startedAtMs: Date.now(),
    errorType: null,
    status: "working",
    ...over,
  };
}

/** Per-test teardown shared by both suites. */
export function resetTranscriptEnv(): void {
  vi.clearAllMocks();
  useStreamStore.setState({ bySessionId: {} });
  // @ts-expect-error — test cleanup
  delete window.vex;
}
