/**
 * `resumeAgentAfterUserForm` — waking the agent after the human answered the
 * form it opened (§C3b), and the ONE interface main-side code has to that wake.
 *
 * The mechanics in `user-form-runtime.ts` had zero production callers: the agent
 * asked, the user deployed, and the turn sat parked forever holding an
 * unanswered tool call. This module is the launch-shaped orchestration over
 * those mechanics — claim the parked run exactly once, append the tool result
 * that answers the ORIGINAL call, stamp the intent in the same transaction.
 *
 * What these pins protect:
 *
 *   - **Exactly once.** A second submit (double click, retried IPC, a submit
 *     racing the expiry sweep) must NOT append a second result. Two guards, and
 *     the test covers both: the run-lease claim for a mission, and the
 *     `result_message_id IS NULL` CAS for a chat session, where there is no run
 *     to claim and the stamp is the only gate.
 *   - **Never a hang.** Dismissal and expiry resume with an honest result rather
 *     than leaving the turn parked, and the wording is the shared
 *     `userFormDismissalOutput` — not a second copy that could drift.
 *   - **It answers THIS call.** The result carries the intent's persisted
 *     `toolCallId`; an intent with none can never be resumed against.
 *   - **Refusals are named, not thrown.** The caller is main-side IPC, which
 *     must distinguish "already answered" (do nothing) from "busy" (retryable).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const SESSION_ID = "sess-1";
const INTENT_ID = "launch-intent-001";
const TOOL_CALL_ID = "call_abc123";

let intent: Record<string, unknown> | null;
let claimOutcome: Record<string, unknown>;
let committed: Record<string, unknown>[];
let stampReturns: unknown;
let stampCalls: unknown[][];

vi.mock("@vex-agent/db/repos/token-launch-intents.js", () => ({
  getById: async (intentId: string, sessionId: string) =>
    intent === null ? null : { ...intent, intentId, sessionId },
  stampResultMessageWith: async (...args: unknown[]) => {
    stampCalls.push(args);
    return stampReturns;
  },
}));

vi.mock("@vex-agent/engine/core/user-form-runtime.js", async () => {
  const actual = await vi.importActual<Record<string, unknown>>(
    "@vex-agent/engine/core/user-form-runtime.js",
  );
  return {
    ...actual,
    claimUserFormResume: async () => claimOutcome,
    commitUserFormToolResult: async (input: Record<string, unknown>) => {
      committed.push(input);
      const stamp = input.stamp as (c: unknown, id: number) => Promise<void>;
      await stamp({}, 4242);
    },
  };
});

const { resumeAgentAfterUserForm } = await import(
  "@vex-agent/engine/core/launch-form-resume.js"
);
const { userFormDismissalOutput } = await import(
  "@vex-agent/engine/core/user-form-runtime.js"
);

beforeEach(() => {
  intent = {
    sessionId: SESSION_ID,
    missionRunId: "run-1",
    toolCallId: TOOL_CALL_ID,
    status: "confirmed",
    name: "Vex Coin",
    symbol: "VEX",
  };
  claimOutcome = { outcome: "claimed" };
  committed = [];
  stampReturns = { intentId: INTENT_ID };
  stampCalls = [];
});

function launched() {
  return {
    intentId: INTENT_ID,
    sessionId: SESSION_ID,
    outcome: {
      kind: "launched" as const,
      txHash: "0xdead",
      tokenAddress: "0x58659Ef9B4E4Fd0b0C0dE0b0c0de0B0c0De0b91A",
    },
  };
}

describe("a successful launch wakes the agent with the outcome", () => {
  it("appends ONE result answering the intent's original tool call", async () => {
    const result = await resumeAgentAfterUserForm(launched());
    expect(result).toEqual({ resumed: true });
    expect(committed).toHaveLength(1);
    expect(committed[0]).toMatchObject({
      success: true,
      ref: { sessionId: SESSION_ID, missionRunId: "run-1", toolCallId: TOOL_CALL_ID },
    });
  });

  it("names the token and the transaction, and says the user did it", async () => {
    await resumeAgentAfterUserForm(launched());
    const output = String(committed[0]!.output);
    expect(output).toContain("0x58659Ef9B4E4Fd0b0C0dE0b0c0de0B0c0De0b91A");
    expect(output).toContain("0xdead");
    expect(output).toContain("user");
  });

  it("stamps the intent inside the SAME transaction as the result row", async () => {
    await resumeAgentAfterUserForm(launched());
    expect(stampCalls).toHaveLength(1);
    expect(stampCalls[0]![3]).toBe(4242);
  });
});

describe("dismissal and expiry resume honestly instead of hanging", () => {
  it("uses the shared dismissal wording, not a second copy", async () => {
    await resumeAgentAfterUserForm({
      intentId: INTENT_ID,
      sessionId: SESSION_ID,
      outcome: { kind: "dismissed" },
    });
    expect(committed[0]!.output).toBe(userFormDismissalOutput("dismissed"));
    expect(committed[0]!.success).toBe(false);
  });

  it("expiry says the form expired", async () => {
    await resumeAgentAfterUserForm({
      intentId: INTENT_ID,
      sessionId: SESSION_ID,
      outcome: { kind: "expired" },
    });
    expect(committed[0]!.output).toBe(userFormDismissalOutput("expired"));
  });

  it("a failed launch tells the model nothing was created", async () => {
    await resumeAgentAfterUserForm({
      intentId: INTENT_ID,
      sessionId: SESSION_ID,
      outcome: { kind: "failed", reason: "Refusing to launch: insufficient balance." },
    });
    expect(committed[0]!.success).toBe(false);
    expect(String(committed[0]!.output)).toContain("insufficient balance");
  });
});

describe("exactly once — a second submit can never append a second result", () => {
  it("a lost run claim refuses as already_resolved and appends nothing", async () => {
    claimOutcome = { outcome: "already_resolved", currentStatus: "running" };
    const result = await resumeAgentAfterUserForm(launched());
    expect(result).toEqual({ resumed: false, reason: "already_resolved" });
    expect(committed).toHaveLength(0);
  });

  it("a busy lease is reported as RETRYABLE, distinct from already_resolved", async () => {
    claimOutcome = { outcome: "busy" };
    const result = await resumeAgentAfterUserForm(launched());
    expect(result).toEqual({ resumed: false, reason: "busy" });
    expect(committed).toHaveLength(0);
  });

  it("a chat session with an already-stamped intent refuses at the stamp", async () => {
    // No run to claim, so the `result_message_id IS NULL` CAS is the ONLY gate.
    // A null stamp must roll the transcript row back, not commit a second result.
    intent = { ...intent, missionRunId: null };
    stampReturns = null;
    const result = await resumeAgentAfterUserForm(launched());
    expect(result).toEqual({ resumed: false, reason: "already_resolved" });
  });
});

describe("it refuses by name rather than guessing", () => {
  it("an unknown intent is not_found", async () => {
    intent = null;
    expect(await resumeAgentAfterUserForm(launched())).toEqual({
      resumed: false,
      reason: "intent_not_found",
    });
    expect(committed).toHaveLength(0);
  });

  it("an intent with no parked call cannot be resumed against", async () => {
    intent = { ...intent, toolCallId: null };
    expect(await resumeAgentAfterUserForm(launched())).toEqual({
      resumed: false,
      reason: "no_parked_call",
    });
    expect(committed).toHaveLength(0);
  });
});
