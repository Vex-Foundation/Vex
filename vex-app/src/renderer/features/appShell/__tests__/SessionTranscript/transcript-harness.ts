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
import { fireEvent } from "@testing-library/react";
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
import { clearSavedScrollPositions } from "../../SessionTranscript/useTranscriptScroll.js";

export const SESSION = "00000000-0000-4000-8000-0000000000aa";
export const ISO = "2026-05-26T10:00:00.000Z";

export const listMock = vi.fn();
export const submitMock = vi.fn();
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
  readonly toolCallId?: string | null;
  readonly toolCalls?: SessionMessageDto["toolCalls"];
}): SessionMessageDto {
  return {
    id: p.id,
    sessionId: SESSION,
    role: p.role,
    kind: p.kind,
    content: p.content,
    createdAt: ISO,
    toolCallId: p.toolCallId ?? null,
    toolName: p.toolName ?? null,
    toolCalls: p.toolCalls ?? null,
    explorerRefs: null,
    reasoning: null,
    durationMs: null,
    success: null,
    displayStatus: null,
    board: null,
    interruptDisposition: null,
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
      chat: {
        submit: submitMock,
      },
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

/**
 * Install scripted scroll geometry on an element (the deepseek `chat-view`
 * idiom). jsdom reports 0 for every layout property, so a scroll test that
 * does not script them proves nothing.
 *
 * The `scrollTop` SETTER clamps to `[0, scrollHeight - clientHeight]`, which
 * is what a real engine does and what the follow model's shrink-clamp
 * attribution depends on: without the clamp, a programmatic write past the
 * floor would be delivered verbatim and the ledger comparison would never see
 * the case the browser actually produces.
 */
export function installScrollMetrics(
  element: HTMLElement,
  scrollHeight: number,
  clientHeight: number,
): {
  setHeight: (value: number) => void;
  setClientHeight: (value: number) => void;
} {
  let height = scrollHeight;
  let client = clientHeight;
  let top = 0;
  Object.defineProperty(element, "scrollHeight", {
    configurable: true,
    get: () => height,
  });
  Object.defineProperty(element, "clientHeight", {
    configurable: true,
    get: () => client,
  });
  // Clamped on BOTH sides: a write past the floor is clamped as a real engine
  // clamps it, and a read after the flow SHRINKS reports the clamped value
  // rather than a stale one - which is precisely the shrink-clamp delivery the
  // follow model must attribute to the engine and not to the reader.
  const clamp = (value: number): number =>
    Math.max(0, Math.min(value, height - client));
  Object.defineProperty(element, "scrollTop", {
    configurable: true,
    get: () => clamp(top),
    set: (value: number) => {
      top = clamp(value);
    },
  });
  return {
    setHeight: (value: number) => {
      height = value;
    },
    setClientHeight: (value: number) => {
      client = value;
    },
  };
}

/**
 * Scripted LAYOUT for the transcript scroller and its rows, in place from the
 * FIRST commit. `installScrollMetrics` scripts one element after it mounts,
 * which is too late for what the scroll model does in its mount commit (the
 * landing, a saved-position restore, a send's anchor). This scripts the
 * `Element.prototype` accessors instead, for every
 * `[data-vex-area="chat-transcript"]` scroller and every row listed in
 * `rows`; everything else measures 0, as jsdom does. Mutate the object to
 * change the geometry. Restore with `vi.restoreAllMocks()`.
 *
 * The scroller's `scrollTop` clamps to its floor on write and on read, as an
 * engine does, and a row's box is its content offset minus that `scrollTop`,
 * with the scroller's box at the viewport top.
 */
export interface ScriptedLayout {
  scrollHeight: number;
  clientHeight: number;
  /** Row content offsets by `data-vex-entry-id`; unlisted rows measure 0. */
  readonly rows: Map<string, number>;
  /** `scrollTop` assignments the scroller received, reader ones included. */
  writes: number;
}

const TRANSCRIPT_SCROLLER = '[data-vex-area="chat-transcript"]';

function box(top: number, height: number): DOMRect {
  return {
    x: 0,
    y: top,
    top,
    bottom: top + height,
    left: 0,
    right: 0,
    width: 0,
    height,
    toJSON: () => ({}),
  };
}

export function installLayout(layout: ScriptedLayout): void {
  const tops = new WeakMap<Element, number>();
  const isScroller = (element: Element): boolean =>
    element.matches(TRANSCRIPT_SCROLLER);
  const clamp = (value: number): number =>
    Math.max(0, Math.min(value, layout.scrollHeight - layout.clientHeight));
  const topOf = (element: Element): number => clamp(tops.get(element) ?? 0);
  vi.spyOn(Element.prototype, "scrollHeight", "get").mockImplementation(
    function (this: Element) {
      return isScroller(this) ? layout.scrollHeight : 0;
    },
  );
  vi.spyOn(Element.prototype, "clientHeight", "get").mockImplementation(
    function (this: Element) {
      return isScroller(this) ? layout.clientHeight : 0;
    },
  );
  vi.spyOn(Element.prototype, "scrollTop", "get").mockImplementation(
    function (this: Element) {
      return isScroller(this) ? topOf(this) : 0;
    },
  );
  vi.spyOn(Element.prototype, "scrollTop", "set").mockImplementation(
    function (this: Element, value: number) {
      if (!isScroller(this)) return;
      layout.writes += 1;
      tops.set(this, clamp(value));
    },
  );
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
    function (this: Element) {
      if (isScroller(this)) return box(0, layout.clientHeight);
      const id = this.getAttribute("data-vex-entry-id");
      const offset = id === null ? undefined : layout.rows.get(id);
      const scroller = this.closest(TRANSCRIPT_SCROLLER);
      if (offset === undefined || scroller === null) return box(0, 0);
      return box(offset - topOf(scroller), 40);
    },
  );
}

/**
 * READER INPUT, of any device: a delivered position that deviates from the
 * model's observed-top ledger, then the gesture's `scrollend`, which settles
 * the controller's 500ms reader sample at once (no wall clock). Every scroll
 * case must go through this rather than assigning `scrollTop` directly,
 * because the difference between a reader scroll and a programmatic write is
 * the whole subject.
 */
export function readerScroll(element: HTMLElement, top: number): void {
  element.scrollTop = top;
  fireEvent.scroll(element);
  fireEvent(element, new Event("scrollend"));
}

/**
 * A manually-driven ResizeObserver. The follow model learns of column, seat,
 * session content and scrollport growth through ONE observer; `notify()` is
 * how a test says "the column just grew" without a wall clock.
 */
export function installResizeObserver(): { notify: () => void; observed: number } {
  const state = { notify: () => {}, observed: 0 };
  class ResizeObserverStub {
    constructor(callback: ResizeObserverCallback) {
      state.notify = () => {
        callback([], this as unknown as ResizeObserver);
      };
    }

    observe(): void {
      state.observed += 1;
    }

    unobserve(): void {}

    disconnect(): void {}
  }
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  return state;
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
    errorDetail: null,
    status: "working",
    ...over,
  };
}

/** Per-test teardown shared by both suites. */
export function resetTranscriptEnv(): void {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  clearSavedScrollPositions();
  useStreamStore.setState({ bySessionId: {} });
  // @ts-expect-error — test cleanup
  delete window.vex;
}
