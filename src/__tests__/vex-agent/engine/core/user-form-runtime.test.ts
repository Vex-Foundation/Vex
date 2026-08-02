/**
 * C3b — the `paused_user_form` continuation.
 *
 * The three properties that keep an unattended, real-funds path honest:
 *   1. it parks WITHOUT enqueuing an approval (no approval card, ever);
 *   2. the resume is claimed EXACTLY ONCE — a second submit cannot append a
 *      second tool result for the same call;
 *   3. cancel and expiry RESUME the turn with an honest result instead of
 *      leaving it hanging on an unanswered tool call.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

const updateStatus = vi.fn();
const claimRunLeaseAndFlipToRunning = vi.fn();
const acquireSessionControlLock = vi.fn();
const appendMessage = vi.fn();
const emitToolResultAppended = vi.fn();
const withTransaction = vi.fn();

vi.mock("@vex-agent/db/repos/mission-runs.js", () => ({ updateStatus }));
vi.mock("@vex-agent/engine/runtime/lease-and-status.js", () => ({
  claimRunLeaseAndFlipToRunning,
  acquireSessionControlLock,
}));
vi.mock("@vex-agent/engine/events/index.js", () => ({ appendMessage }));
vi.mock(
  "@vex-agent/engine/core/approval-runtime/post-tx/result-message.js",
  () => ({ emitToolResultAppended }),
);
vi.mock("@vex-agent/db/client.js", () => ({ withTransaction }));

const {
  USER_FORM_RESUME_CLAIMABLE_RUN_STATUSES,
  claimUserFormResume,
  commitUserFormToolResult,
  parkRunForUserForm,
  userFormDismissalOutput,
} = await import("@vex-agent/engine/core/user-form-runtime.js");

const REF = { sessionId: "s1", missionRunId: "r1", toolCallId: "call_1" } as const;
const CLIENT = { query: vi.fn() };

beforeEach(() => {
  vi.clearAllMocks();
  withTransaction.mockImplementation(async (fn: (c: unknown) => Promise<unknown>) => fn(CLIENT));
  appendMessage.mockResolvedValue({ id: 42 });
});

describe("parking", () => {
  it("parks the run on paused_user_form — never on paused_approval", async () => {
    await parkRunForUserForm(REF);
    expect(updateStatus).toHaveBeenCalledWith("r1", "paused_user_form", "user_form_required");
    expect(updateStatus).not.toHaveBeenCalledWith("r1", "paused_approval", expect.anything());
  });

  it("parks nothing for a chat session — there is no run to park", async () => {
    await parkRunForUserForm({ ...REF, missionRunId: null });
    expect(updateStatus).not.toHaveBeenCalled();
  });
});

describe("exactly-once claim", () => {
  it("claims only from paused_user_form", () => {
    expect([...USER_FORM_RESUME_CLAIMABLE_RUN_STATUSES]).toEqual(["paused_user_form"]);
  });

  it("claims the run and flips it back to running", async () => {
    claimRunLeaseAndFlipToRunning.mockResolvedValue({ outcome: "claimed" });
    await expect(claimUserFormResume(REF, "owner_1")).resolves.toEqual({ outcome: "claimed" });
    expect(claimRunLeaseAndFlipToRunning).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "s1",
        missionRunId: "r1",
        fromStatuses: ["paused_user_form"],
        ownerId: "owner_1",
      }),
    );
  });

  it("refuses a SECOND submit — the run already left paused_user_form", async () => {
    claimRunLeaseAndFlipToRunning.mockResolvedValue({
      outcome: "status_mismatch",
      currentStatus: "running",
    });
    await expect(claimUserFormResume(REF, "owner_1")).resolves.toEqual({
      outcome: "already_resolved",
      currentStatus: "running",
    });
  });

  it("keeps `busy` (retryable) distinct from `already_resolved` (never retryable)", async () => {
    // Collapsing these would either duplicate a tool result or abandon a
    // transient lease conflict.
    claimRunLeaseAndFlipToRunning.mockResolvedValue({ outcome: "lease_busy", currentLease: {} });
    await expect(claimUserFormResume(REF, "owner_1")).resolves.toEqual({ outcome: "busy" });
  });
});

describe("result append — row + stamp in ONE transaction", () => {
  it("takes the session control lock FIRST, then appends, then stamps", async () => {
    const order: string[] = [];
    acquireSessionControlLock.mockImplementation(async () => void order.push("lock"));
    appendMessage.mockImplementation(async () => {
      order.push("append");
      return { id: 42 };
    });
    const stamp = vi.fn(async () => void order.push("stamp"));

    await commitUserFormToolResult({ ref: REF, success: true, output: "ok", stamp });

    expect(order).toEqual(["lock", "append", "stamp"]);
    expect(stamp).toHaveBeenCalledWith(CLIENT, 42);
  });

  it("answers the ORIGINAL tool call id, or the turn can never close", async () => {
    await commitUserFormToolResult({
      ref: REF,
      success: true,
      output: "ok",
      stamp: async () => {},
    });
    expect(appendMessage).toHaveBeenCalledWith(
      "s1",
      expect.objectContaining({ role: "tool", toolCallId: "call_1" }),
      expect.anything(),
      expect.anything(),
    );
  });

  it("emits the transcript event only AFTER the transaction commits", async () => {
    const order: string[] = [];
    withTransaction.mockImplementation(async (fn: (c: unknown) => Promise<unknown>) => {
      const out = await fn(CLIENT);
      order.push("commit");
      return out;
    });
    emitToolResultAppended.mockImplementation(() => void order.push("emit"));

    await commitUserFormToolResult({
      ref: REF,
      success: true,
      output: "ok",
      stamp: async () => {},
    });
    expect(order).toEqual(["commit", "emit"]);
  });

  it("a throwing stamp rolls the transcript row back and emits nothing", async () => {
    withTransaction.mockImplementation(async (fn: (c: unknown) => Promise<unknown>) => fn(CLIENT));
    const stamp = vi.fn(async () => {
      throw new Error("already settled");
    });

    await expect(
      commitUserFormToolResult({ ref: REF, success: true, output: "ok", stamp }),
    ).rejects.toThrow("already settled");
    expect(emitToolResultAppended).not.toHaveBeenCalled();
  });
});

describe("cancel / expiry never hang the turn", () => {
  it("tells the model the user DECLINED, and that nothing happened", () => {
    const output = userFormDismissalOutput("dismissed");
    expect(output).toContain("dismissed the form");
    expect(output).toContain("no funds moved");
    expect(output).toContain("declined");
  });

  it("distinguishes an expiry from a dismissal — they are different facts", () => {
    const expired = userFormDismissalOutput("expired");
    expect(expired).toContain("expired");
    expect(expired).not.toContain("dismissed the form");
    expect(expired).not.toBe(userFormDismissalOutput("dismissed"));
  });

  it("never claims the user approved anything", () => {
    for (const reason of ["dismissed", "expired"] as const) {
      expect(userFormDismissalOutput(reason).toLowerCase()).not.toContain("approved");
    }
  });
});
