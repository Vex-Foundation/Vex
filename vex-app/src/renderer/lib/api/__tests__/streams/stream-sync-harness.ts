/**
 * Shared harness for the `useStreamPreviewSync` suites.
 *
 * Extracted when the file crossed the 550-line hard limit and split by
 * responsibility (the delta/abort/orphan sync contract vs turn continuity).
 * Both suites drive the REAL hook through one stubbed engine bridge, so the
 * event fixtures and the subscription capture live here rather than being
 * copied — a divergent fixture between the two would be a silent hole.
 *
 * Every delta fixture mirrors a shape the engine actually emits; the aborted
 * one is additionally parsed through the shipped `.strict()` schema in the
 * core suite, because a previous attempt pinned a control event production
 * never sent.
 */

import { vi } from "vitest";
import {
  MutationObserver,
  type QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
import type { StreamDeltaEvent } from "@shared/schemas/stream.js";
import type { TranscriptAppendEvent } from "@shared/schemas/messages.js";
import { useStreamStore } from "../../../../stores/streamStore.js";
import { makeEngineBridgeStub } from "../../../../test/engine-bridge-stub.js";
import { CHAT_SUBMIT_MUTATION_KEY } from "../../chat.js";

export const SESSION_A = "00000000-0000-4000-8000-00000000000a";
export const SESSION_B = "00000000-0000-4000-8000-00000000000b";

export type DeltaCb = (e: StreamDeltaEvent) => void;
export type AppendCb = (e: TranscriptAppendEvent) => void;

let deltaCb: DeltaCb | null = null;
let appendCb: AppendCb | null = null;
export const offDelta = vi.fn();
export const offAppend = vi.fn();

/** Per-test setup: fresh subscription capture + a stubbed engine bridge. */
export function setupStreamEnv(): void {
  deltaCb = null;
  appendCb = null;
  offDelta.mockReset();
  offAppend.mockReset();
  useStreamStore.setState({ bySessionId: {} });
  Object.defineProperty(window, "vex", {
    configurable: true,
    writable: true,
    value: {
      engine: makeEngineBridgeStub({
        onStreamDelta: (cb) => {
          deltaCb = cb;
          return offDelta;
        },
        onTranscriptAppend: (cb) => {
          appendCb = cb;
          return offAppend;
        },
      }),
    },
  });
}

/** Per-test teardown. */
export function resetStreamEnv(): void {
  vi.useRealTimers();
  // @ts-expect-error — test cleanup
  delete window.vex;
}

export function makeWrapper(client: QueryClient) {
  return function Wrapper({ children }: { readonly children: ReactNode }) {
    return createElement(QueryClientProvider, { client }, children);
  };
}

export function textDelta(sessionId: string, streamId = "s1", text = "hi"): StreamDeltaEvent {
  return {
    type: "engine.stream.delta",
    sessionId,
    streamId,
    sequence: 0,
    deltaType: "text",
    delta: { kind: "text", text },
    createdAt: "2026-05-26T10:00:00.000Z",
    correlationId: null,
  };
}

export function append(
  sessionId: string,
  role: TranscriptAppendEvent["role"] = "assistant",
): TranscriptAppendEvent {
  return {
    type: "engine.transcript.append",
    sessionId,
    messageId: 1,
    role,
    createdAt: "2026-05-26T10:00:00.000Z",
    messageType: null,
    correlationId: null,
  };
}

/**
 * The REAL emitted shape, mirroring `toStreamAbortedEvent`
 * (`engine/events/stream-bus.ts`): same `streamId` as the stream it ends, at
 * `lastSequence + 1`, `deltaType: "aborted"`, and a delta that is the bare
 * discriminant — no reason string, no provider text.
 */
export function abortedDelta(
  sessionId: string,
  streamId = "s1",
  sequence = 1,
): StreamDeltaEvent {
  return {
    type: "engine.stream.delta",
    sessionId,
    streamId,
    sequence,
    deltaType: "aborted",
    delta: { kind: "aborted" },
    createdAt: "2026-05-26T10:00:00.000Z",
    correlationId: null,
  };
}

export function toolCallDelta(
  sessionId: string,
  streamId = "s1",
  toolCallName = "swap_quote",
  sequence = 1,
): StreamDeltaEvent {
  return {
    type: "engine.stream.delta",
    sessionId,
    streamId,
    sequence,
    deltaType: "tool_call",
    delta: { kind: "tool_call", toolCallIndex: 0, toolCallId: "call-1", toolCallName },
    createdAt: "2026-05-26T10:00:00.000Z",
    correlationId: null,
  };
}

/** Put a chat turn in flight for `sessionId`; returns the settle function. */
export function startChatTurn(client: QueryClient, sessionId: string): () => void {
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
  void observer.mutate({ sessionId }).catch(() => undefined);
  return () => settle();
}

export function reasoningDelta(
  sessionId: string,
  streamId = "s1",
  text = "thinking",
  sequence = 0,
): StreamDeltaEvent {
  return {
    type: "engine.stream.delta",
    sessionId,
    streamId,
    sequence,
    deltaType: "reasoning",
    delta: { kind: "reasoning", text },
    createdAt: "2026-05-26T10:00:00.000Z",
    correlationId: null,
  };
}

export const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** The engine's delta callback for the mounted hook (throws if unmounted). */
export function emitDelta(event: StreamDeltaEvent): void {
  if (deltaCb === null) throw new Error("no delta subscription");
  deltaCb(event);
}

/** The engine's transcript-append callback for the mounted hook. */
export function emitAppend(event: TranscriptAppendEvent): void {
  if (appendCb === null) throw new Error("no append subscription");
  appendCb(event);
}

/** Whether the hook subscribed at all (the null-sessionId no-op case). */
export function hasDeltaSubscription(): boolean {
  return deltaCb !== null;
}
