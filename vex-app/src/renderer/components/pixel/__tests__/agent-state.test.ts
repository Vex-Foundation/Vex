/**
 * The print's agent state precedence: the running head's, strongest first.
 * Awaiting beats everything (a pending approval freezes the run), then live,
 * then paused, then running, else idle.
 */

import { describe, expect, it } from "vitest";
import { deskAgentStateOf, type DeskAgentSignals } from "../agent-state.js";

describe("deskAgentStateOf", () => {
  it("no signal is the agent at rest", () => {
    expect(deskAgentStateOf({})).toBe("idle");
  });

  it("each signal alone picks its state", () => {
    expect(deskAgentStateOf({ awaiting: true })).toBe("awaiting");
    expect(deskAgentStateOf({ live: true })).toBe("live");
    expect(deskAgentStateOf({ paused: true })).toBe("paused");
    expect(deskAgentStateOf({ running: true })).toBe("running");
  });

  it("precedence: awaiting, live, paused, running", () => {
    const all: DeskAgentSignals = { awaiting: true, live: true, paused: true, running: true };
    expect(deskAgentStateOf(all)).toBe("awaiting");
    expect(deskAgentStateOf({ ...all, awaiting: false })).toBe("live");
    expect(deskAgentStateOf({ ...all, awaiting: false, live: false })).toBe("paused");
    expect(deskAgentStateOf({ running: true, paused: false })).toBe("running");
  });

  it("a pending approval wins even over a turn in flight", () => {
    expect(deskAgentStateOf({ awaiting: true, live: true })).toBe("awaiting");
  });

  it("false signals are no signals", () => {
    expect(
      deskAgentStateOf({ awaiting: false, live: false, paused: false, running: false }),
    ).toBe("idle");
  });
});
