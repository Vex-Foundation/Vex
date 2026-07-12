import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const enqueueWith = vi.fn();
const createWith = vi.fn();
const updateStatus = vi.fn();

vi.mock("@vex-agent/db/repos/approvals.js", () => ({ enqueueWith }));
vi.mock("@vex-agent/db/repos/approval-intents.js", () => ({ createWith }));
vi.mock("@vex-agent/db/repos/mission-runs.js", () => ({ updateStatus }));
vi.mock("@vex-agent/db/client.js", () => ({
  withTransaction: async (fn: (client: object) => Promise<unknown>) => fn({}),
}));

const { enqueueApprovalIntent } = await import(
  "../../../../vex-agent/engine/core/turn-loop-tool-batch/approval-stop.js"
);

const PREPARED_EXPIRY = "2026-07-12T10:10:00.000Z";
const TRUSTED_PREVIEW = {
  toolName: "wallet_send_confirm",
  criticalArgs: {
    network: "solana",
    chain: null,
    to: "3SnLmaqoEczS2ft7RLQ1BRhtsLuAauWnx9K7pDjSRQrp",
    amount: "32.813008",
    token: "ANSEM",
  },
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-07-12T10:00:00.000Z"));
  vi.clearAllMocks();
});

afterEach(() => vi.useRealTimers());

describe("prepared-action approval intent", () => {
  it("uses the trusted wallet preview and never outlives the prepared intent", async () => {
    await enqueueApprovalIntent({
      context: {
        sessionId: "session-1",
        sessionPermission: "restricted",
        missionRunId: null,
      } as any,
      toolCall: {
        id: "confirm-call",
        name: "wallet_send_confirm",
        arguments: {
          network: "solana",
          intentId: "intent-00000000-0000-4000-8000-000000000001",
          to: "model-spoofed-recipient",
          amount: "999999",
        },
      },
      result: {
        success: false,
        output: "approval required",
        pendingApproval: true,
        actionKind: "user_wallet_broadcast",
      },
      toolContext: {
        sessionPermission: "restricted",
        sessionKind: "agent",
        missionRunId: null,
        missionId: null,
        role: "parent",
        contextUsageBand: "normal",
      } as any,
      intentActionKind: "user_wallet_broadcast",
      trustedPreview: TRUSTED_PREVIEW,
      trustedExpiresAt: PREPARED_EXPIRY,
    });

    expect(createWith).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        previewJson: TRUSTED_PREVIEW,
        expiresAt: PREPARED_EXPIRY,
      }),
    );
    const stored = createWith.mock.calls[0]![1];
    expect(JSON.stringify(stored.previewJson)).not.toContain(
      "model-spoofed-recipient",
    );
    expect(JSON.stringify(stored.previewJson)).not.toContain("999999");
  });
});
