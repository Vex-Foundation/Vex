/**
 * Narration: one line from real parts. Each state's line is the proposal copy
 * with the live parts filled in, and a state with nothing true to add says
 * nothing.
 */

import { describe, expect, it } from "vitest";
import type { SessionMessageDto } from "@shared/schemas/messages.js";
import {
  NARRATION_MESSAGE_MAX,
  decisionsWaitLine,
  lastUserMessageOf,
  quotableMessage,
  vexNarration,
} from "../narration.js";
import {
  QUIET_SITUATION,
  vexStateOf,
  type VexSituation,
  type VexState,
} from "../vex-state.js";

/** The narration of a situation, with its state chosen by the real precedence. */
function narrate(overrides: Partial<VexSituation>): { state: VexState; line: string | null } {
  const situation: VexSituation = { ...QUIET_SITUATION, ...overrides };
  const state = vexStateOf(situation);
  return { state, line: vexNarration(state, situation) };
}

const MESSAGE = "What is my ETH balance?";

describe("live turns", () => {
  it("names the tool and quotes the question", () => {
    const { state, line } = narrate({
      live: { kind: "working", word: "Calling Wallet balances", userMessage: MESSAGE },
    });
    expect(state).toBe("working");
    expect(line).toBe(`Calling Wallet balances to answer “${MESSAGE}”`);
  });

  it("uses the island's own live word for a running tool and for writing", () => {
    expect(
      narrate({ live: { kind: "working", word: "Running Chain read", userMessage: MESSAGE } }).line,
    ).toBe(`Running Chain read to answer “${MESSAGE}”`);
    expect(
      narrate({ live: { kind: "working", word: "Writing", userMessage: MESSAGE } }).line,
    ).toBe(`Writing to answer “${MESSAGE}”`);
  });

  it("says the live word alone when there is no message to quote", () => {
    expect(
      narrate({ live: { kind: "working", word: "Calling Wallet balances", userMessage: null } })
        .line,
    ).toBe("Calling Wallet balances");
  });

  it("a thinking turn says nothing without a message, and quotes it with one", () => {
    expect(
      narrate({ live: { kind: "thinking", word: "Thinking", userMessage: null } }).line,
    ).toBeNull();
    expect(
      narrate({ live: { kind: "thinking", word: "Thinking", userMessage: MESSAGE } }).line,
    ).toBe(`Thinking to answer “${MESSAGE}”`);
  });

  it("a mission that runs between turns has no live words to say", () => {
    expect(narrate({ running: true })).toEqual({ state: "working", line: null });
  });
});

describe("awaiting", () => {
  it("counts the decisions in words and promises nothing signs", () => {
    expect(narrate({ awaiting: { count: 3, sentence: null } }).line).toBe(
      "Three decisions wait for you. Nothing signs until you confirm.",
    );
    expect(narrate({ awaiting: { count: 1, sentence: null } }).line).toBe(
      "One decision waits for you. Nothing signs until you confirm.",
    );
  });

  it("leads with the plain sentence when one approval can be named", () => {
    expect(
      narrate({ awaiting: { count: 1, sentence: "Send 0.5 ETH to a saved address." } }).line,
    ).toBe("Send 0.5 ETH to a saved address. Nothing signs until you confirm.");
    expect(narrate({ awaiting: { count: 1, sentence: "Send 0.5 ETH" } }).line).toBe(
      "Send 0.5 ETH. Nothing signs until you confirm.",
    );
  });

  it("falls back to the count when several wait, even with a sentence", () => {
    expect(narrate({ awaiting: { count: 2, sentence: "Anything." } }).line).toBe(
      "Two decisions wait for you. Nothing signs until you confirm.",
    );
  });

  it("writes large counts in digits", () => {
    expect(decisionsWaitLine(12)).toBe("12 decisions wait for you.");
    expect(decisionsWaitLine(10)).toBe("Ten decisions wait for you.");
  });
});

describe("concerned and error", () => {
  it("offline", () => {
    expect(narrate({ concern: { kind: "offline" } })).toEqual({
      state: "concerned",
      line: "Offline: waiting for the network to come back.",
    });
  });

  it("a rate-limited provider, with the retry hint", () => {
    expect(narrate({ concern: { kind: "capacity", retryAfterSeconds: 41 } }).line).toBe(
      "Provider rate-limited or unavailable. Retry in 41s.",
    );
    expect(narrate({ concern: { kind: "capacity", retryAfterSeconds: null } }).line).toBe(
      "Provider rate-limited or unavailable. Retry when ready.",
    );
  });

  it("stale balances use the portfolio's own sentence", () => {
    expect(narrate({ concern: { kind: "stale_balances" } }).line).toBe(
      "Some balances are stale. Totals include last known values.",
    );
  });

  it("a failed turn reads as the session banner does", () => {
    expect(narrate({ error: { kind: "failure", scope: "turn" } })).toEqual({
      state: "error",
      line: "This turn failed",
    });
    expect(narrate({ error: { kind: "failure", scope: "approval" } }).line).toBe(
      "Resuming after your decision failed",
    );
  });

  it("a mission paused on an error says it is not monitoring", () => {
    expect(narrate({ error: { kind: "mission_paused" } }).line).toBe(
      "The mission is not monitoring the market or your positions until you recover it.",
    );
    expect(narrate({ error: { kind: "mission_failed" } }).line).toBe("The mission run failed");
  });
});

describe("sleeping, done, ready, listening, waking", () => {
  it("sleeping on a wake says when it wakes", () => {
    expect(narrate({ sleep: { kind: "wake", wakeAt: "01:37 PM" } })).toEqual({
      state: "sleeping",
      line: "Vex went to sleep. Wakes at 01:37 PM.",
    });
    expect(narrate({ sleep: { kind: "wake", wakeAt: null } }).line).toBe("Vex went to sleep");
  });

  it("a user pause and a locked vault make no claim", () => {
    expect(narrate({ sleep: { kind: "user_paused" } }).line).toBeNull();
    expect(narrate({ sleep: { kind: "locked" } }).line).toBeNull();
  });

  it("done claims only what the caller can prove", () => {
    expect(narrate({ done: "finished" })).toEqual({ state: "done", line: null });
    expect(narrate({ done: "confirmed" }).line).toBe("Confirmed");
    expect(narrate({ done: "goal_reached" }).line).toBe(
      "Mission ended · Goal reached. Renew it, or tell Vex what to do differently.",
    );
  });

  it("listening watches the composer", () => {
    expect(narrate({ listening: true }).line).toBe("Eyes on the composer while you type.");
  });

  it("ready is silent, except while a mission waits to be accepted", () => {
    expect(narrate({})).toEqual({ state: "ready", line: null });
    expect(narrate({ missionStatus: "paused_plan_acceptance" }).line).toBe(
      "The mission contract looks ready. On-chain actions stay blocked until you accept it and start the mission.",
    );
    expect(narrate({ missionStatus: "paused_user_form" }).line).toBeNull();
  });

  it("waking leaves the words to the boot steps", () => {
    expect(narrate({ waking: true })).toEqual({ state: "waking", line: null });
  });
});

function message(overrides: Partial<SessionMessageDto>): SessionMessageDto {
  return {
    id: 1,
    sessionId: "00000000-0000-4000-8000-000000000001",
    role: "user",
    kind: "text",
    content: "hello",
    createdAt: "2026-10-17T10:00:00.000Z",
    toolCallId: null,
    toolName: null,
    toolCalls: null,
    explorerRefs: null,
    reasoning: null,
    durationMs: null,
    success: null,
    displayStatus: null,
    board: null,
    interruptDisposition: null,
    ...overrides,
  };
}

describe("quotable user messages", () => {
  it("collapses whitespace and keeps a short message whole", () => {
    expect(quotableMessage("  And\n  ETH?  ")).toBe("And ETH?");
  });

  it("cuts a long message with an ellipsis at the bound", () => {
    const cut = quotableMessage("word ".repeat(40));
    expect(cut).not.toBeNull();
    expect(cut?.length).toBeLessThanOrEqual(NARRATION_MESSAGE_MAX);
    expect(cut?.endsWith("…")).toBe(true);
  });

  it("has nothing to quote from an empty message", () => {
    expect(quotableMessage("   \n ")).toBeNull();
  });

  it("takes the newest user text or steering message, never a tool or assistant row", () => {
    const rows: readonly SessionMessageDto[] = [
      message({ id: 1, content: "first question" }),
      message({ id: 2, role: "assistant", content: "an answer" }),
      message({ id: 3, kind: "steering", content: "change of plan" }),
      message({ id: 4, role: "tool", kind: "tool_result", content: "{}" }),
      message({ id: 5, role: "assistant", content: "another answer" }),
    ];
    expect(lastUserMessageOf(rows)).toBe("change of plan");
    expect(lastUserMessageOf(rows.slice(0, 2))).toBe("first question");
    expect(lastUserMessageOf([])).toBeNull();
  });
});
