/**
 * STATE: VEX THINKING - the ask has just gone out and the turn is reasoning.
 *
 * The swap chat at its `thinking` stage (`fixtures/swap-chat.ts`): the
 * history, the ask "Swap 200 USDC to ETH on Base." three seconds ago, and a
 * run that holds its lease. What makes it a LIVE turn in the product is not a
 * read but two pushes, so `afterMount` delivers them through the stand-in
 * bridge's own subscriptions, exactly where main would: the control-state
 * push (the lease is held) and the turn's reasoning deltas on
 * `engine.onStreamDelta`. The product's own `useStreamPreviewSync` and
 * `streamStore` turn those into the live row.
 *
 * THE TIMER READS 0:03. The stream store stamps the turn's start with
 * `Date.now()` when the first delta is flushed, so the deltas are delivered
 * with the clock at three seconds before `H3_NOW` (`atInstant`), and the
 * row's own one-second tick then reads the frozen difference: 0:03 on every
 * load. The ready stamp waits until it does.
 */

import { CONTROL_STATE_EVENT_TYPE, type ControlStateEvent } from "@shared/schemas/runtime.js";
import { STREAM_DELTA_EVENT_TYPE, type StreamDeltaEvent } from "@shared/schemas/stream.js";
import { mergeAnswers, ok, type HarnessBridge } from "../bridge.js";
import { atInstant, H3_NOW, isoAt, MINUTE } from "../clock.js";
import { baseAnswers } from "../fixtures/base.js";
import { CHATS, chatById, SWAP_CHAT } from "../fixtures/sessions.js";
import { swapChatAnswers } from "../fixtures/swap-chat.js";
import { fixture, H3_HARNESS_MARK } from "../mark.js";
import type { HarnessState } from "./types.js";

const TURN_AGO_MS = 3_000;
const STREAM_ID = "h3-fixture-stream-1";

/** The reasoning the turn has streamed so far, in the deltas the provider sends. */
const REASONING: readonly string[] = fixture("thinking.reasoning", [
  "The user wants to swap 200 USDC for ETH on Base. ",
  "The main wallet holds 1,240.50 USDC there, so the amount is covered. ",
  "Next: quote the swap on KyberSwap and compare the output with the minimum it will accept.",
]);

function delta(sequence: number, text: string): StreamDeltaEvent {
  return {
    type: STREAM_DELTA_EVENT_TYPE,
    sessionId: SWAP_CHAT.id,
    streamId: STREAM_ID,
    sequence,
    deltaType: "reasoning",
    delta: { kind: "reasoning", text },
    createdAt: isoAt(-TURN_AGO_MS + sequence * 400),
    correlationId: H3_HARNESS_MARK,
  };
}

const LEASE_HELD: ControlStateEvent = {
  type: CONTROL_STATE_EVENT_TYPE,
  sessionId: SWAP_CHAT.id,
  missionRunId: null,
  runStatus: "running",
  stopReason: null,
  pendingControlKind: null,
  leaseActive: true,
  leaseExpiresAt: isoAt(MINUTE),
  correlationId: H3_HARNESS_MARK,
};

/** Resolve on the first frame `predicate` holds. */
function untilFrame(predicate: () => boolean): Promise<void> {
  return new Promise((resolve) => {
    const tick = (): void => {
      if (predicate()) resolve();
      else requestAnimationFrame(tick);
    };
    tick();
  });
}

async function streamTheTurn(bridge: HarnessBridge): Promise<void> {
  await bridge.whenSubscribed("engine.onStreamDelta");
  bridge.emit("engine.onControlState", LEASE_HELD);
  await atInstant(H3_NOW - TURN_AGO_MS, () => {
    REASONING.forEach((text, index) => {
      bridge.emit("engine.onStreamDelta", delta(index, text));
    });
  });
  await untilFrame(() => {
    const row = document.querySelector('[data-vex-island-state="thinking"]');
    return row !== null && (row.textContent ?? "").includes("0:03");
  });
}

export const thinking: HarnessState = {
  id: "thinking",
  title: "Vex thinking: a live turn, 3 s in",
  answers: () =>
    mergeAnswers(
      baseAnswers({ sessions: [...CHATS], pendingAll: [] }),
      { sessions: { get: ({ id }) => ok(chatById(id)) } },
      swapChatAnswers("thinking"),
    ),
  ui: { activeSessionId: SWAP_CHAT.id, shellRoute: { kind: "none" } },
  ready: '[data-vex-island-state="thinking"]',
  afterMount: streamTheTurn,
};
