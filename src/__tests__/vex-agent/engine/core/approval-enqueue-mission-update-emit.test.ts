/**
 * `enqueueApprovalIntent` → `engine.mission.update` emit contract.
 *
 * The approval half of the push: a new approval card must appear immediately
 * instead of on the next 15 s inbox poll. The emit sits OUTSIDE the enqueue
 * transaction, so by the time a subscriber refetches `listPending` the queue
 * row, the intent row and the `paused_approval` flip are all durable.
 *
 * The auto-rejected arm (operator stopped the run while the tool was in
 * flight) emits nothing — that approval can never be decided, so there is no
 * card to show.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const enqueueWith = vi.fn();
const createWith = vi.fn();
const rejectWith = vi.fn();
const updateStatus = vi.fn();
const gateOnOperatorStopWithClient = vi.fn();
const acquireSessionControlLock = vi.fn();

vi.mock("@vex-agent/db/repos/approvals.js", () => ({ enqueueWith, rejectWith }));
vi.mock("@vex-agent/db/repos/approval-intents.js", () => ({ createWith }));
vi.mock("@vex-agent/db/repos/mission-runs.js", () => ({ updateStatus }));
vi.mock("@vex-agent/engine/runtime/lease-and-status.js", () => ({
  acquireSessionControlLock: (...a: unknown[]) => acquireSessionControlLock(...a),
  gateOnOperatorStopWithClient: (...a: unknown[]) =>
    gateOnOperatorStopWithClient(...a),
}));
vi.mock("@vex-agent/db/client.js", () => ({
  withTransaction: async (fn: (client: object) => Promise<unknown>) => fn({}),
  executeWith: vi.fn().mockResolvedValue(1),
  queryWith: vi.fn().mockResolvedValue([]),
  queryOneWith: vi.fn().mockResolvedValue(null),
}));

const { enqueueApprovalIntent } = await import(
  "../../../../vex-agent/engine/core/turn-loop-tool-batch/approval-stop.js"
);
const { missionUpdateBus } = await import(
  "../../../../vex-agent/engine/runtime/mission-bus.js"
);

function baseArgs() {
  return {
    context: {
      sessionId: "session-1",
      sessionPermission: "restricted",
      missionId: "mission-1",
      missionRunId: "run-1",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
    toolCall: {
      id: "call-1",
      name: "wallet_send",
      arguments: { network: "solana", amount: "1" },
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    result: {
      success: false,
      output: "approval required",
      pendingApproval: true,
      actionKind: "user_wallet_broadcast",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    toolContext: { sessionId: "session-1", permission: "restricted" } as any,
    intentActionKind: "user_wallet_broadcast" as const,
  };
}

describe("enqueueApprovalIntent mission-update emit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    gateOnOperatorStopWithClient.mockResolvedValue({ kind: "clear" });
  });

  it("emits `approval_enqueued` after the enqueue transaction resolves", async () => {
    const events: Array<Record<string, unknown>> = [];
    const off = missionUpdateBus.subscribe((event) =>
      events.push(event as unknown as Record<string, unknown>),
    );
    try {
      const outcome = await enqueueApprovalIntent(baseArgs());
      expect(outcome.kind).toBe("enqueued");
    } finally {
      off();
    }

    expect(createWith).toHaveBeenCalledTimes(1);
    expect(updateStatus).toHaveBeenCalledTimes(1);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "engine.mission.update",
      sessionId: "session-1",
      missionId: "mission-1",
      kind: "approval_enqueued",
    });
  });

  it("emits nothing when the approval is auto-rejected onto a stopped run", async () => {
    gateOnOperatorStopWithClient.mockResolvedValue({
      kind: "stopped",
      runStatus: "stopped",
    });
    const listener = vi.fn();
    const off = missionUpdateBus.subscribe(listener);
    try {
      const outcome = await enqueueApprovalIntent(baseArgs());
      expect(outcome.kind).toBe("auto_rejected");
    } finally {
      off();
    }
    expect(listener).not.toHaveBeenCalled();
  });
});
