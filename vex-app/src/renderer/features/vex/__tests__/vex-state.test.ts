/**
 * The Vex presence state: the words and fills are the proposal copy verbatim,
 * the precedence holds pair by pair, the scope words follow the surface, and
 * the Done edge is a real edge only.
 */

import { describe, expect, it } from "vitest";
import type { TurnIslandState } from "../../appShell/TurnIsland/islandTurnState.js";
import {
  DONE_HOLD_MS,
  QUIET_SITUATION,
  VEX_STATES,
  VEX_STATE_FILL,
  VEX_STATE_WORD,
  isDoneEdge,
  vexLiveOf,
  vexScopeOf,
  vexStateOf,
  vexTimerStartOf,
  vexWordOf,
  type VexSituation,
  type VexState,
} from "../vex-state.js";

describe("words and fills", () => {
  it("names every state with the proposal word", () => {
    expect(VEX_STATE_WORD).toEqual({
      ready: "Ready",
      listening: "Listening",
      thinking: "Thinking",
      working: "Working",
      awaiting: "Waiting for approval",
      done: "Done",
      concerned: "Concerned",
      error: "Error",
      sleeping: "Sleeping",
      waking: "Waking up",
    });
    expect(VEX_STATES).toHaveLength(10);
  });

  it("gives every state a swatch fill: awaiting is the target, the two warnings are ink", () => {
    expect(VEX_STATE_FILL).toEqual({
      ready: "idle",
      listening: "listening",
      thinking: "thinking",
      working: "done",
      awaiting: "awaiting",
      done: "done",
      concerned: "concerned",
      error: "error",
      sleeping: "sleeping",
      waking: "ongoing",
    });
    for (const state of VEX_STATES) expect(VEX_STATE_WORD[state].length).toBeGreaterThan(0);
  });

  it("words a locked vault as the lock plate does, and nothing else differently", () => {
    expect(vexWordOf("sleeping", { locked: true })).toBe("Sleeping · Locked");
    expect(vexWordOf("sleeping")).toBe("Sleeping");
    expect(vexWordOf("ready", { locked: true })).toBe("Ready");
  });
});

/** The signals in precedence order, each as the situation that raises it alone. */
const LADDER: ReadonlyArray<readonly [VexState, Partial<VexSituation>]> = [
  ["waking", { waking: true }],
  ["awaiting", { awaiting: { count: 2, sentence: null } }],
  ["thinking", { live: { kind: "thinking", word: "Thinking", userMessage: null } }],
  ["error", { error: { kind: "failure", scope: "turn" } }],
  ["concerned", { concern: { kind: "offline" } }],
  ["sleeping", { sleep: { kind: "user_paused" } }],
  ["working", { running: true }],
  ["done", { done: "finished" }],
  ["listening", { listening: true }],
];

describe("vexStateOf precedence", () => {
  it("is ready with nothing in flight", () => {
    expect(vexStateOf(QUIET_SITUATION)).toBe("ready");
  });

  it.each(LADDER)("%s is raised by its own signal alone", (expected, signal) => {
    expect(vexStateOf({ ...QUIET_SITUATION, ...signal })).toBe(expected);
  });

  const pairs: Array<[number, number]> = [];
  for (let stronger = 0; stronger < LADDER.length; stronger += 1) {
    for (let weaker = stronger + 1; weaker < LADDER.length; weaker += 1) {
      pairs.push([stronger, weaker]);
    }
  }

  it.each(pairs)("signal %i beats signal %i when both hold", (stronger, weaker) => {
    const winner = LADDER[stronger];
    const loser = LADDER[weaker];
    expect(winner).toBeDefined();
    expect(loser).toBeDefined();
    if (winner === undefined || loser === undefined) return;
    const both: VexSituation = { ...QUIET_SITUATION, ...loser[1], ...winner[1] };
    expect(vexStateOf(both)).toBe(winner[0]);
  });

  it("a live turn that calls a tool is Working, one that vexes is Thinking", () => {
    const live = (kind: "thinking" | "working"): VexSituation => ({
      ...QUIET_SITUATION,
      live: { kind, word: "x", userMessage: null },
    });
    expect(vexStateOf(live("working"))).toBe("working");
    expect(vexStateOf(live("thinking"))).toBe("thinking");
  });

  it("an approvals count of zero never holds the awaiting state", () => {
    expect(
      vexStateOf({ ...QUIET_SITUATION, awaiting: { count: 0, sentence: null } }),
    ).toBe("ready");
  });

  it("a mission waiting for a decision (contract, form) is Ready, not Sleeping", () => {
    expect(vexStateOf({ ...QUIET_SITUATION, missionStatus: "paused_plan_acceptance" })).toBe(
      "ready",
    );
    expect(vexStateOf({ ...QUIET_SITUATION, missionStatus: "paused_user_form" })).toBe("ready");
  });
});

describe("vexLiveOf", () => {
  const CASES: ReadonlyArray<readonly [TurnIslandState | null, "thinking" | "working"]> = [
    [null, "thinking"],
    ["working", "thinking"],
    ["thinking", "thinking"],
    ["calling", "working"],
    ["running", "working"],
    ["writing", "working"],
    ["awaiting", "thinking"],
    ["error", "thinking"],
    ["settled", "thinking"],
  ];
  it.each(CASES)("island %s reads %s", (turn, expected) => {
    expect(vexLiveOf(turn)).toBe(expected);
  });
});

describe("vexScopeOf", () => {
  it("is the project in Studio, whatever session id lingers", () => {
    expect(vexScopeOf({ runtimeMode: "studio", sessionMode: "agent" })).toBe("This project:");
    expect(vexScopeOf({ runtimeMode: "studio", sessionMode: null })).toBe("This project:");
  });

  it("follows the open session's mode in the agent shell and on the desk", () => {
    expect(vexScopeOf({ runtimeMode: "agent", sessionMode: "agent" })).toBe("This chat:");
    expect(vexScopeOf({ runtimeMode: "agent", sessionMode: "mission" })).toBe("This mission:");
    expect(vexScopeOf({ runtimeMode: "lighter", sessionMode: "agent" })).toBe("This chat:");
  });

  it("has no scope on the welcome", () => {
    expect(vexScopeOf({ runtimeMode: "agent", sessionMode: null })).toBeNull();
  });
});

describe("the Done edge", () => {
  it("fires only when a live turn ends clean", () => {
    expect(isDoneEdge({ wasLive: true, live: false, blocked: false })).toBe(true);
    expect(isDoneEdge({ wasLive: true, live: false, blocked: true })).toBe(false);
    expect(isDoneEdge({ wasLive: false, live: false, blocked: false })).toBe(false);
    expect(isDoneEdge({ wasLive: true, live: true, blocked: false })).toBe(false);
    expect(isDoneEdge({ wasLive: false, live: true, blocked: false })).toBe(false);
  });

  it("is held for a few seconds, not a minute", () => {
    expect(DONE_HOLD_MS).toBeGreaterThanOrEqual(2_000);
    expect(DONE_HOLD_MS).toBeLessThanOrEqual(8_000);
  });
});

describe("vexTimerStartOf", () => {
  it("counts only a live thinking or working turn with a known start", () => {
    expect(vexTimerStartOf("working", true, 1_000)).toBe(1_000);
    expect(vexTimerStartOf("thinking", true, 2_000)).toBe(2_000);
    expect(vexTimerStartOf("working", true, null)).toBeNull();
  });

  it("never counts a mission between turns or a decision that waits", () => {
    expect(vexTimerStartOf("working", false, 1_000)).toBeNull();
    expect(vexTimerStartOf("awaiting", true, 1_000)).toBeNull();
    expect(vexTimerStartOf("ready", false, null)).toBeNull();
  });
});
