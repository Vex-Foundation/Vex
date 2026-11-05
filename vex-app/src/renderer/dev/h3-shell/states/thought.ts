/**
 * STATE: THOUGHT - a live turn watched to its end, so its thinking row reads
 * "Thought for 2.8 s" (docs/design/H3-DESKTOP.md Appendix A.7).
 *
 * The swap chat at its `thinking` stage (`fixtures/swap-chat.ts`), then the
 * turn the `thinking` state shows streaming is played to its end, through the
 * same pushes main sends: the lease, the reasoning deltas, the answer's text
 * delta and its `done`, then the transcript append for the persisted answer.
 * The product's own `useStreamPreviewSync` refetches the transcript and
 * retires the preview; the live frame hands its clock's reading up as it
 * settles (`TurnIsland/turnClock.ts`), and the persisted answer's Reasoned row
 * reads it.
 *
 * THE TIME READS 2.8 s on every load: the reasoning is delivered with the
 * harness clock at 2.8 s before `H3_NOW` (`atInstant`), which is when the
 * stream store stamps the turn's start, and the answer's `done` lands at
 * `H3_NOW` itself, so the live clock reads exactly 2 800 ms when the turn
 * settles. The ask was written 3 s before `H3_NOW`, inside the window the
 * clock files a turn under its ask.
 *
 * The earlier turn in the same capture (the balances read, 18 minutes ago)
 * was not watched live, so its thinking row says only "Thought" and its
 * steps: the two rows side by side are the contract's two cases.
 */

import {
  CONTROL_STATE_EVENT_TYPE,
  type ControlStateEvent,
  type RuntimeStateDto,
} from "@shared/schemas/runtime.js";
import { STREAM_DELTA_EVENT_TYPE, type StreamDeltaEvent } from "@shared/schemas/stream.js";
import {
  TRANSCRIPT_APPEND_EVENT_TYPE,
  type MessagePage,
  type SessionMessageDto,
  type TranscriptAppendEvent,
} from "@shared/schemas/messages.js";
import { mergeAnswers, ok, type HarnessBridge } from "../bridge.js";
import { atInstant, H3_NOW, isoAt, MINUTE } from "../clock.js";
import { baseAnswers } from "../fixtures/base.js";
import { CHATS, chatById, SWAP_CHAT } from "../fixtures/sessions.js";
import { swapChatAnswers } from "../fixtures/swap-chat.js";
import { fixture, H3_HARNESS_MARK } from "../mark.js";
import type { HarnessState } from "./types.js";

const THOUGHT_MS = 2_800;
const STREAM_ID = "h3-fixture-stream-thought";
const ANSWER_ID = 106;

const REASONING: readonly string[] = fixture("thought.reasoning", [
  "The user wants to swap 200 USDC for ETH on Base. ",
  "The main wallet holds 1,240.50 USDC there, so the amount is covered. ",
  "They did not say how much the price may move; ask before quoting.",
]);

const ANSWER = fixture(
  "thought.answer",
  "Your main wallet on Base holds 1,240.50 USDC, so 200 is covered. "
    + "How far may the price move before the swap should stop: 0.5%, or tighter?",
);

function delta(sequence: number, at: number, body: StreamDeltaEvent["delta"]): StreamDeltaEvent {
  return {
    type: STREAM_DELTA_EVENT_TYPE,
    sessionId: SWAP_CHAT.id,
    streamId: STREAM_ID,
    sequence,
    deltaType: body.kind,
    delta: body,
    createdAt: isoAt(at),
    correlationId: H3_HARNESS_MARK,
  } as StreamDeltaEvent;
}

function control(leaseActive: boolean): ControlStateEvent {
  return {
    type: CONTROL_STATE_EVENT_TYPE,
    sessionId: SWAP_CHAT.id,
    missionRunId: null,
    runStatus: leaseActive ? "running" : null,
    stopReason: null,
    pendingControlKind: null,
    leaseActive,
    leaseExpiresAt: leaseActive ? isoAt(MINUTE) : null,
    correlationId: H3_HARNESS_MARK,
  } as ControlStateEvent;
}

/** The persisted answer, as `messages.list` returns it once the turn is written. */
const ANSWER_ROW: SessionMessageDto = fixture("thought.answer-row", {
  id: ANSWER_ID,
  sessionId: SWAP_CHAT.id,
  role: "assistant",
  kind: "text",
  content: ANSWER,
  createdAt: isoAt(0),
  toolCallId: null,
  toolName: null,
  toolCalls: null,
  explorerRefs: null,
  reasoning: REASONING.join(""),
  durationMs: null,
  success: null,
  displayStatus: null,
  board: null,
  interruptDisposition: null,
});

/** Whether the answer has been written: the transcript read answers with it after. */
let written = false;

function untilFrame(predicate: () => boolean): Promise<void> {
  return new Promise((resolve) => {
    const tick = (): void => {
      if (predicate()) resolve();
      else requestAnimationFrame(tick);
    };
    tick();
  });
}

async function playTheTurn(bridge: HarnessBridge): Promise<void> {
  await bridge.whenSubscribed("engine.onStreamDelta");
  bridge.emit("engine.onControlState", control(true));
  await atInstant(H3_NOW - THOUGHT_MS, () => {
    REASONING.forEach((text, index) => {
      bridge.emit("engine.onStreamDelta", delta(index, -THOUGHT_MS, { kind: "reasoning", text }));
    });
  });
  // Back at H3_NOW: the answer streams and the round ends.
  const next = REASONING.length;
  bridge.emit("engine.onStreamDelta", delta(next, 0, { kind: "text", text: ANSWER }));
  bridge.emit("engine.onStreamDelta", delta(next + 1, 0, { kind: "done" }));
  written = true;
  const append: TranscriptAppendEvent = {
    type: TRANSCRIPT_APPEND_EVENT_TYPE,
    sessionId: SWAP_CHAT.id,
    messageId: ANSWER_ID,
    role: "assistant",
    createdAt: ANSWER_ROW.createdAt,
    messageType: null,
    correlationId: H3_HARNESS_MARK,
  };
  bridge.emit("engine.onTranscriptAppend", append);
  bridge.emit("engine.onControlState", control(false));
  // Settled once the preview is retired and the live turn's thinking row (the
  // last one; the history turn's comes first) reads the clock.
  await untilFrame(() => {
    const heads = document.querySelectorAll("[data-vex-thinking-head] button");
    const last = heads.item(heads.length - 1);
    return (
      document.querySelector('[data-vex-area="stream-preview"]') === null
      && heads.length > 0
      && (last.textContent ?? "").startsWith("Thought for")
    );
  });
}

export const thought: HarnessState = {
  id: "thought",
  title: "Thought: a live turn watched to its answer",
  answers: () => {
    written = false;
    const swap = swapChatAnswers("thinking");
    const base = swap.messages?.list;
    const runtime = swap.runtime?.getState;
    return mergeAnswers(
      baseAnswers({ sessions: [...CHATS], pendingAll: [] }),
      { sessions: { get: ({ id }) => ok(chatById(id)) } },
      swap,
      {
        // Once the answer is written the run is over, as the filled stage's
        // runtime read says it.
        runtime: {
          getState: async (input) => {
            if (!written && runtime !== undefined) return runtime(input);
            return ok<RuntimeStateDto>({
              sessionId: SWAP_CHAT.id,
              hasActiveRun: false,
              missionRunId: null,
              status: null,
              stopReason: null,
              lastCheckpointAt: null,
              startedAt: null,
              iterationCount: null,
              leaseActive: false,
              leaseExpiresAt: null,
              pendingControlKind: null,
              stoppable: false,
              activity: { kind: "none" },
            });
          },
        },
        messages: {
          list: async (input) => {
            if (base === undefined) return ok<MessagePage>({ items: [], nextCursor: null, hasMore: false });
            const page = await base(input);
            if (!written || !page.ok) return page;
            return ok<MessagePage>({ ...page.data, items: [...page.data.items, ANSWER_ROW] });
          },
        },
      },
    );
  },
  ui: { activeSessionId: SWAP_CHAT.id, shellRoute: { kind: "none" } },
  ready: "[data-vex-thinking-head]",
  afterMount: playTheTurn,
};
