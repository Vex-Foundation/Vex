import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const enqueueWith = vi.fn();
const createWith = vi.fn();
const updateStatus = vi.fn();

vi.mock("@vex-agent/db/repos/approvals.js", () => ({ enqueueWith }));
vi.mock("@vex-agent/db/repos/approval-intents.js", () => ({ createWith }));
vi.mock("@vex-agent/db/repos/mission-runs.js", () => ({ updateStatus }));
vi.mock("@vex-agent/db/client.js", () => ({
  withTransaction: async (fn: (client: object) => Promise<unknown>) => fn({}),
  // The enqueue transaction now opens on the session control lock before the
  // operator-stop gate reads anything. These sessions carry no mission run, so
  // the gate short-circuits `clear` right after the lock — but the lock
  // statement itself still has to go somewhere.
  executeWith: vi.fn().mockResolvedValue(1),
  queryWith: vi.fn().mockResolvedValue([]),
  queryOneWith: vi.fn().mockResolvedValue(null),
}));

const { enqueueApprovalIntent } = await import(
  "../../../../vex-agent/engine/core/turn-loop-tool-batch/approval-stop.js"
);

const PREPARED_EXPIRY = "2026-07-12T10:10:00.000Z";
const TRUSTED_PREVIEW = {
  toolName: "WalletSendConfirm",
  criticalArgs: {
    network: "solana",
    chain: null,
    to: "3SnLmaqoEczS2ft7RLQ1BRhtsLuAauWnx9K7pDjSRQrp",
    amount: "32.813008",
    token: "ANSEM",
  },
};

function firstCreatedIntent() {
  const call = createWith.mock.calls[0];
  if (call === undefined) throw new Error("approval intent was not created");
  return call[1];
}

function firstStoredEnvelope(): Record<string, unknown> {
  const call = enqueueWith.mock.calls[0];
  if (call === undefined) throw new Error("approval queue row was not created");
  const envelope: unknown = call[2];
  if (typeof envelope !== "object" || envelope === null || Array.isArray(envelope)) {
    throw new Error("stored approval envelope was not an object");
  }
  return Object.fromEntries(Object.entries(envelope));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-07-12T10:00:00.000Z"));
  vi.clearAllMocks();
});

afterEach(() => vi.useRealTimers());

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function baseArgs(overrides: Record<string, unknown> = {}) {
  return {
    context: {
      sessionId: "session-1",
      sessionPermission: "restricted",
      missionRunId: null,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
    toolCall: {
      id: "confirm-call",
      name: "WalletSendConfirm",
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
      actionKind: "user_wallet_broadcast" as const,
    },
    toolContext: {
      sessionPermission: "restricted",
      sessionKind: "agent",
      missionRunId: null,
      missionId: null,
      contextUsageBand: "normal",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
    intentActionKind: "user_wallet_broadcast" as const,
    ...overrides,
  };
}

describe("prepared-action approval intent", () => {
  it("uses the trusted wallet preview and never outlives the prepared intent", async () => {
    await enqueueApprovalIntent(
      baseArgs({
        trustedPreview: TRUSTED_PREVIEW,
        trustedExpiresAt: PREPARED_EXPIRY,
      }),
    );

    expect(createWith).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        previewJson: TRUSTED_PREVIEW,
        expiresAt: PREPARED_EXPIRY,
      }),
    );
    const stored = firstCreatedIntent();
    expect(JSON.stringify(stored.previewJson)).not.toContain(
      "model-spoofed-recipient",
    );
    expect(JSON.stringify(stored.previewJson)).not.toContain("999999");
  });

  it("floors the approval TTL at the trusted expiry when it is earlier than the default 1h window", async () => {
    // System time 10:00:00; trusted expiry 10:10:00 — well inside the 1h
    // default (11:00:00), so the approval must expire with the intent, not
    // outlive it.
    await enqueueApprovalIntent(
      baseArgs({
        trustedPreview: TRUSTED_PREVIEW,
        trustedExpiresAt: PREPARED_EXPIRY,
      }),
    );
    const stored = firstCreatedIntent();
    expect(stored.expiresAt).toBe(PREPARED_EXPIRY);
  });

  it("falls back to the default 1h TTL when the trusted expiry is LATER than the default window", async () => {
    await enqueueApprovalIntent(
      baseArgs({
        trustedPreview: TRUSTED_PREVIEW,
        trustedExpiresAt: "2026-07-12T23:00:00.000Z",
      }),
    );
    const stored = firstCreatedIntent();
    expect(stored.expiresAt).toBe(
      new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    );
  });

  it("floors the approval TTL at an ALREADY-PAST trusted expiry (fail closed via the existing expiry sweep, never re-extended to the default window)", async () => {
    // System time 10:00:00; trusted expiry is in the past. The prepared
    // wallet intent is already expired, so the synthesized approval must be
    // too — it must never silently gain a fresh 1h window.
    const pastExpiry = "2026-07-12T09:00:00.000Z";
    await enqueueApprovalIntent(
      baseArgs({
        trustedPreview: TRUSTED_PREVIEW,
        trustedExpiresAt: pastExpiry,
      }),
    );
    const stored = firstCreatedIntent();
    expect(stored.expiresAt).toBe(pastExpiry);
  });

  it("falls back to the default 1h TTL when the trusted expiry is malformed", async () => {
    await enqueueApprovalIntent(
      baseArgs({
        trustedPreview: TRUSTED_PREVIEW,
        trustedExpiresAt: "not-a-date",
      }),
    );
    const stored = firstCreatedIntent();
    expect(stored.expiresAt).toBe(
      new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    );
  });

  it("builds the args-derived preview (untrusted-tool default path) when no trusted preview is supplied", async () => {
    await enqueueApprovalIntent(baseArgs());
    const stored = firstCreatedIntent();
    // The default (non-handoff) path derives the preview from the tool's own
    // args via the allow-listed builder — model-visible fields only, still
    // never the raw untouched args object.
    expect(stored.previewJson.toolName).toBe("WalletSendConfirm");
  });
});

/**
 * THE AGENT LANE'S REQUEST DIGEST (pass 6 / N3).
 *
 * It used to be Studio-only, and while it was, a CONSISTENT co-edit of the
 * durable card AND the stored envelope passed every check the agent resume ran:
 * the two agreed with each other because both had been changed, and nothing
 * recorded what the pair looked like when the human approved. The digest is that
 * record, so the lane that dispatches the same money-path tools stores it too.
 */
describe("the agent lane records the request digest at enqueue", () => {
  it("stores the digest of the envelope it also stores, so a resume can recompute it", async () => {
    const { computeRequestDigest } = await import(
      "../../../../vex-agent/engine/core/approval-runtime/tool-call-envelope.js"
    );
    await enqueueApprovalIntent(
      baseArgs({ trustedPreview: TRUSTED_PREVIEW, trustedExpiresAt: PREPARED_EXPIRY }),
    );

    const storedEnvelope = firstStoredEnvelope();
    const stored = firstCreatedIntent();
    expect(stored.requestDigest).toBe(computeRequestDigest(storedEnvelope));
    // Not the placeholder it used to be.
    expect(stored.requestDigest).not.toBeNull();
    // And it is genuinely a function of the envelope: any edit to it moves.
    expect(computeRequestDigest({ ...storedEnvelope, args: { spoofed: true } })).not.toBe(
      stored.requestDigest,
    );
  });
});
