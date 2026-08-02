/**
 * Dismissing the launch dialog.
 *
 * Pinned:
 *  - the intent is cancelled BEFORE the agent is woken, so a resumed agent
 *    cannot re-read a still-live intent and conclude the form is open;
 *  - a CAS miss (already deployed, already cancelled, expired) is `cancelled:
 *    false` — an honest report, not an error, and NOT a second "dismissed"
 *    answer to a call somebody already answered;
 *  - `resumedAgentTurn` reports what HAPPENED. A user-origin launch has no
 *    parked call, so it is `false` while the cancel itself succeeded;
 *  - a wake that fails does not turn a completed cancellation into a failure.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const wakeParkedAgent = vi.fn(
  async (_intentId: string, _sessionId: string, _outcome: unknown) => true,
);
vi.mock("../execute-seam.js", () => ({
  wakeParkedAgent: (intentId: string, sessionId: string, outcome: unknown) =>
    wakeParkedAgent(intentId, sessionId, outcome),
}));

vi.mock("../../logger/index.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const cancelIfAwaitingWith = vi.fn();
vi.mock("@vex-agent/db/repos/token-launch-intents.js", () => ({
  cancelIfAwaitingWith: (client: unknown, intentId: string, sessionId: string) =>
    cancelIfAwaitingWith(client, intentId, sessionId),
}));

const withSessionControlLock = vi.fn(
  async (_sessionId: string, fn: (client: unknown) => Promise<unknown>) => fn({}),
);
vi.mock("@vex-agent/engine/runtime/lease-and-status/session-control-lock.js", () => ({
  withSessionControlLock: (sessionId: string, fn: (client: unknown) => Promise<unknown>) =>
    withSessionControlLock(sessionId, fn),
}));

const { cancelLaunch } = await import("../cancel.js");

const SESSION_ID = "3f0d2f7a-1c2b-4b3c-8d4e-5f6a7b8c9d0e";
const INTENT_ID = "int_abc";

beforeEach(() => {
  cancelIfAwaitingWith.mockResolvedValue({ intentId: INTENT_ID, status: "cancelled" });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("cancelLaunch", () => {
  it("cancels the intent, then wakes the parked agent with `dismissed`", async () => {
    const order: string[] = [];
    cancelIfAwaitingWith.mockImplementation(async () => {
      order.push("cancel");
      return { intentId: INTENT_ID };
    });
    wakeParkedAgent.mockImplementation(async () => {
      order.push("wake");
      return true;
    });

    const outcome = await cancelLaunch({ sessionId: SESSION_ID, intentId: INTENT_ID });

    expect(order).toEqual(["cancel", "wake"]);
    expect(wakeParkedAgent).toHaveBeenCalledWith(INTENT_ID, SESSION_ID, { kind: "dismissed" });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("unreachable");
    expect(outcome.result).toEqual({ cancelled: true, resumedAgentTurn: true });
  });

  it("is session-scoped and takes the session control lock", async () => {
    await cancelLaunch({ sessionId: SESSION_ID, intentId: INTENT_ID });
    expect(withSessionControlLock).toHaveBeenCalledWith(SESSION_ID, expect.any(Function));
    expect(cancelIfAwaitingWith).toHaveBeenCalledWith(expect.anything(), INTENT_ID, SESSION_ID);
  });

  it("reports `resumedAgentTurn: false` when no agent was parked (a user-origin launch)", async () => {
    wakeParkedAgent.mockResolvedValue(false);
    const outcome = await cancelLaunch({ sessionId: SESSION_ID, intentId: INTENT_ID });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("unreachable");
    // The cancel still SUCCEEDED — there was simply nobody waiting.
    expect(outcome.result).toEqual({ cancelled: true, resumedAgentTurn: false });
  });

  it("a CAS miss is an honest `cancelled: false`, and wakes nobody", async () => {
    cancelIfAwaitingWith.mockResolvedValue(null);
    const outcome = await cancelLaunch({ sessionId: SESSION_ID, intentId: INTENT_ID });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("unreachable");
    expect(outcome.result).toEqual({ cancelled: false, resumedAgentTurn: false });
    // Answering an already-resolved call a second time is the failure this avoids.
    expect(wakeParkedAgent).not.toHaveBeenCalled();
  });

  it("refuses without leaking database detail when the write fails", async () => {
    cancelIfAwaitingWith.mockRejectedValue(
      new Error("connect ECONNREFUSED postgres://vex:hunter2@127.0.0.1:5432/vex"),
    );
    const outcome = await cancelLaunch({ sessionId: SESSION_ID, intentId: INTENT_ID });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.refusal.detail).not.toContain("hunter2");
    expect(outcome.refusal.detail).not.toContain("postgres");
  });
});
