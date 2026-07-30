/**
 * TURN CONTINUITY in `useStreamPreviewSync` — the half of the sync contract
 * that distinguishes a provider ROUND from the operator's TURN.
 *
 * Split out of `streams.test.ts` when it crossed the 550-line hard limit; the
 * core delta/abort/orphan suite keeps the main file's name. The shared bridge
 * stub and event fixtures live in `stream-sync-harness.ts`.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderHook } from "@testing-library/react";
import { QueryClient } from "@tanstack/react-query";

import { useStreamPreviewSync } from "../../streams.js";
import { useStreamStore } from "../../../../stores/streamStore.js";
import {
  SESSION_A,
  append,
  emitAppend,
  emitDelta,
  flush,
  makeWrapper,
  reasoningDelta,
  resetStreamEnv,
  setupStreamEnv,
  startChatTurn,
  textDelta,
  toolCallDelta,
} from "./stream-sync-harness.js";

beforeEach(setupStreamEnv);
afterEach(resetStreamEnv);

describe("useStreamPreviewSync turn continuity", () => {

  /**
   * TURN CONTINUITY (owner report 2026-07-30: the mid-turn scroll jump, and
   * the disappearing first half of a turn's reasoning).
   *
   * A turn that calls a tool persists an ASSISTANT row in the MIDDLE of the
   * turn. Clearing the preview there destroyed turn-scoped state — the
   * reasoning segments, the turn clock, and (through the transcript's
   * spacer-retirement effect) the anchor run-out that holds the scroll range.
   * The round must be SETTLED instead: the round's prose stops being
   * previewed, because it is a canonical row now, and everything else lives on.
   */
  it("SETTLES the round instead of clearing when a mid-turn tool_call row persists", async () => {
    renderHook(() => useStreamPreviewSync(SESSION_A), {
      wrapper: makeWrapper(new QueryClient()),
    });
    emitDelta(reasoningDelta(SESSION_A, "s1", "weighing the route"));
    emitDelta(textDelta(SESSION_A, "s1", "let me check"));
    emitDelta(toolCallDelta(SESSION_A, "s1"));

    emitAppend(append(SESSION_A, "assistant"));
    await flush();

    const live = useStreamStore.getState().bySessionId[SESSION_A];
    // The turn is still standing.
    expect(live).toBeDefined();
    // The round's prose is persisted now, so the preview stops duplicating it.
    expect(live?.text).toBe("");
    expect(live?.toolName).toBeNull();
    // ...but the thinking that produced the call is kept as a settled segment.
    expect(live?.reasoningSegments).toEqual(["weighing the route"]);
  });

  it("still clears on the FINAL answer append (a round with no tool call)", async () => {
    renderHook(() => useStreamPreviewSync(SESSION_A), {
      wrapper: makeWrapper(new QueryClient()),
    });
    emitDelta(reasoningDelta(SESSION_A, "s2", "one last look"));
    emitDelta(textDelta(SESSION_A, "s2", "here is the answer"));

    emitAppend(append(SESSION_A, "assistant"));
    await flush();

    expect(useStreamStore.getState().bySessionId[SESSION_A]).toBeUndefined();
  });

  /**
   * The backstop the mid-turn settle makes necessary: a turn that ends right
   * after a tool call (approval rejected, iteration cap, engine stop) emits no
   * final append, so nothing else would retire the preview before the 60 s
   * idle net. `chat.submit`'s mutation settling IS the end of the turn.
   */
  it("clears the preview when the TURN settles after a mid-turn tool row", async () => {
    const client = new QueryClient();
    const settleTurn = startChatTurn(client, SESSION_A);
    renderHook(() => useStreamPreviewSync(SESSION_A), {
      wrapper: makeWrapper(client),
    });
    emitDelta(toolCallDelta(SESSION_A, "s1"));
    emitAppend(append(SESSION_A, "assistant"));
    await flush();
    expect(useStreamStore.getState().bySessionId[SESSION_A]).toBeDefined();

    settleTurn();
    await flush();
    await flush();
    expect(useStreamStore.getState().bySessionId[SESSION_A]).toBeUndefined();
  });

  /**
   * Non-interactive turns (mission, wake) never open a chat mutation, so
   * `submitting` sits at false for their whole life. The backstop must fire on
   * the true→false TRANSITION only — a steady false must never touch a live
   * preview, or a mission turn would be blanked on its first delta.
   */
  it("never clears a preview from a steady non-submitting state (mission turns)", async () => {
    renderHook(() => useStreamPreviewSync(SESSION_A), {
      wrapper: makeWrapper(new QueryClient()),
    });
    emitDelta(textDelta(SESSION_A, "s1", "mission progress"));
    await flush();
    expect(useStreamStore.getState().bySessionId[SESSION_A]?.text).toBe(
      "mission progress",
    );
  });
});
