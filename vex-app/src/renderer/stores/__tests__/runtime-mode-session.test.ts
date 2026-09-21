/**
 * THE CONVERSATION FOLLOWS THE TRADER.
 *
 * The desk used to park the shell's session on the way in and swap its own one
 * back, which made the agent and the desk two separate correspondents: you
 * asked the agent about a market, opened the chart it was describing, and
 * found a stranger in the rail. They are one surface, and this file pins that.
 *
 * What the desk ADDS is elsewhere and unaffected: `LighterChatRail` hands the
 * carried session the environment, the market, the chart's own indicators and
 * the live values on every send.
 */

import { describe, expect, it } from "vitest";

import { transitionRuntimeMode } from "../uiStore/runtime-mode.js";

const AGENT_SESSION = "11111111-1111-4111-8111-111111111111";
const DESK_SESSION = "22222222-2222-4222-8222-222222222222";

function state(over: Partial<Parameters<typeof transitionRuntimeMode>[0]> = {}) {
  return {
    runtimeMode: "agent" as const,
    activeSessionId: null as string | null,
    lighterReturn: null,
    lighterSessionId: null as string | null,
    ...over,
  };
}

describe("entering the desk", () => {
  it("carries the conversation in", () => {
    const patch = transitionRuntimeMode(
      state({ activeSessionId: AGENT_SESSION }),
      "lighter",
    );
    expect(patch.activeSessionId).toBe(AGENT_SESSION);
  });

  it("prefers the live conversation over the desk's last one", () => {
    // Both exist: the one the trader is actually in wins.
    const patch = transitionRuntimeMode(
      state({ activeSessionId: AGENT_SESSION, lighterSessionId: DESK_SESSION }),
      "lighter",
    );
    expect(patch.activeSessionId).toBe(AGENT_SESSION);
  });

  it("falls back to the last session traded from on a cold entry", () => {
    // Nothing selected in the shell, so the desk resumes its own rather than
    // opening on the starters.
    const patch = transitionRuntimeMode(
      state({ activeSessionId: null, lighterSessionId: DESK_SESSION }),
      "lighter",
    );
    expect(patch.activeSessionId).toBe(DESK_SESSION);
  });

  it("remembers the mode to return to", () => {
    const patch = transitionRuntimeMode(
      state({ runtimeMode: "studio", activeSessionId: AGENT_SESSION }),
      "lighter",
    );
    expect(patch.lighterReturn).toMatchObject({ mode: "studio" });
  });
});

describe("leaving the desk", () => {
  it("keeps the session the trader was in", () => {
    const patch = transitionRuntimeMode(
      state({
        runtimeMode: "lighter",
        activeSessionId: AGENT_SESSION,
        lighterReturn: { mode: "agent", sessionId: AGENT_SESSION },
      }),
      "agent",
    );
    expect(patch.activeSessionId).toBe(AGENT_SESSION);
  });

  it("keeps a session first opened at the desk, too", () => {
    // The carry works in both directions: a conversation started on the desk
    // continues in the agent shell rather than being left behind.
    const patch = transitionRuntimeMode(
      state({
        runtimeMode: "lighter",
        activeSessionId: DESK_SESSION,
        lighterReturn: { mode: "agent", sessionId: null },
      }),
      "agent",
    );
    expect(patch.activeSessionId).toBe(DESK_SESSION);
    // And it is what a later cold entry resumes.
    expect(patch.lighterSessionId).toBe(DESK_SESSION);
  });

  it("returns to the mode the desk was entered from", () => {
    const patch = transitionRuntimeMode(
      state({
        runtimeMode: "lighter",
        activeSessionId: AGENT_SESSION,
        lighterReturn: { mode: "studio", sessionId: null },
      }),
      "studio",
    );
    expect(patch.runtimeMode).toBe("studio");
    expect(patch.lighterReturn).toBeNull();
  });
});

describe("a switch that is neither", () => {
  it("writes the slot and nothing else", () => {
    expect(transitionRuntimeMode(state({ activeSessionId: AGENT_SESSION }), "studio"))
      .toEqual({ runtimeMode: "studio" });
  });

  it("is a no-op for the mode already active", () => {
    expect(transitionRuntimeMode(state({ runtimeMode: "lighter" }), "lighter")).toEqual({});
  });
});
