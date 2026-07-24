/**
 * Regression: restricted wallet_send_confirm blind/spoof approval attack.
 *
 * Attack (pre-fix):
 *   1. prepare creates a full wallet_intents row + rich follow-up card
 *   2. user rejects (approval flips; intent stayed pending)
 *   3. agent re-calls wallet_send_confirm with only {network, intentId}
 *   4. enqueue painted a thin card (no to/amount) OR a spoofed to/amount
 *   5. user approves thin card → confirm loads full intent → real transfer
 *
 * Post-fix guarantees pinned here:
 *   A. Direct confirm enqueue ALWAYS binds to/amount/token/chain from the row
 *   B. Model-spoofed to/amount never appear in previewJson
 *   C. Reject cancels the wallet intent
 *   D. After cancel, re-bind / re-enqueue fail closed (no second card)
 *   E. Confirm handler refuses a cancelled intent (no pendingApproval)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const enqueueWith = vi.fn();
const createWith = vi.fn();
const updateStatus = vi.fn();
const mockGetById = vi.fn();
const mockCancelIfPending = vi.fn();
const mockConsumeIfPending = vi.fn();

vi.mock("@vex-agent/db/repos/approvals.js", () => ({ enqueueWith }));
vi.mock("@vex-agent/db/repos/approval-intents.js", () => ({ createWith }));
vi.mock("@vex-agent/db/repos/mission-runs.js", () => ({ updateStatus }));
vi.mock("@vex-agent/db/client.js", () => ({
  withTransaction: async (fn: (client: object) => Promise<unknown>) => fn({}),
}));
vi.mock("@vex-agent/db/repos/wallet-intents.js", () => ({
  getById: (...a: unknown[]) => mockGetById(...a),
  cancelIfPending: (...a: unknown[]) => mockCancelIfPending(...a),
  consumeIfPending: (...a: unknown[]) => mockConsumeIfPending(...a),
  create: vi.fn(),
  markExecuted: vi.fn(),
  markFailed: vi.fn(),
  markAuditFailed: vi.fn(),
}));

vi.mock("@utils/logger.js", () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// Confirm handler also resolves a signing wallet — not reached on cancelled path.
vi.mock("@vex-agent/tools/internal/wallet/resolve.js", () => ({
  resolveSelectedAddress: vi.fn(),
  resolveSigningWallet: vi.fn(),
  walletScopeErrorToResult: (err: unknown) => {
    throw err;
  },
}));

const { enqueueApprovalIntent } = await import(
  "../../../../vex-agent/engine/core/turn-loop-tool-batch/approval-stop.js"
);
const {
  bindWalletSendConfirmApproval,
  cancelWalletIntentAfterApprovalRejection,
} = await import("../../../../vex-agent/engine/core/wallet-send-approval.js");
const { handleWalletSendConfirm } = await import(
  "../../../../vex-agent/tools/internal/wallet/send.js"
);

const SESSION = "session-attack-1";
const INTENT_ID = "intent-00000000-0000-4000-8000-0000000000aa";
const REAL_TO = "0xRealRecipient00000000000000000000000001";
const REAL_AMOUNT = "42.5";
const SPOOF_TO = "0xLooksHarmless000000000000000000000002";
const SPOOF_AMOUNT = "0.01";
const EXPIRES = "2026-07-12T10:10:00.000Z";

function pendingIntent(overrides: Record<string, unknown> = {}) {
  return {
    intentId: INTENT_ID,
    sessionId: SESSION,
    walletAddress: "0xabcdef1234567890abcdef1234567890abcdef12",
    network: "eip155" as const,
    chainAlias: "base",
    toAddress: REAL_TO,
    amount: REAL_AMOUNT,
    token: "USDC",
    previewJson: { label: "x", criticalArgs: {} },
    status: "pending" as const,
    expiresAt: EXPIRES,
    consumedAt: null,
    cancelledAt: null,
    txHash: null,
    failureReason: null,
    idempotencyKey: INTENT_ID,
    createdAt: "2026-07-12T10:00:00.000Z",
    ...overrides,
  };
}

function thinConfirmArgs(extra: Record<string, unknown> = {}) {
  return {
    network: "eip155",
    intentId: INTENT_ID,
    ...extra,
  };
}

function enqueueDirectConfirm(args: Record<string, unknown> = thinConfirmArgs()) {
  return enqueueApprovalIntent({
    context: {
      sessionId: SESSION,
      sessionPermission: "restricted",
      missionRunId: null,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
    toolCall: {
      id: "attack-confirm-1",
      name: "wallet_send_confirm",
      arguments: args,
    },
    result: {
      success: false,
      output: "Transfer requires approval under restricted permission.",
      pendingApproval: true,
      actionKind: "user_wallet_broadcast",
    },
    toolContext: {
      sessionPermission: "restricted",
      sessionKind: "agent",
      missionRunId: null,
      missionId: null,
      contextUsageBand: "normal",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
    intentActionKind: "user_wallet_broadcast",
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-07-12T10:00:00.000Z"));
  vi.clearAllMocks();
  mockGetById.mockResolvedValue(pendingIntent());
  mockCancelIfPending.mockImplementation(async (intentId: string, sessionId: string) => {
    if (intentId !== INTENT_ID || sessionId !== SESSION) return null;
    return pendingIntent({ status: "cancelled", cancelledAt: new Date().toISOString() });
  });
});

afterEach(() => vi.useRealTimers());

describe("wallet_send_confirm attack-path regression", () => {
  it("A+B: thin/spoofed direct confirm still enqueues a FULL card from the DB row", async () => {
    await enqueueDirectConfirm(
      thinConfirmArgs({ to: SPOOF_TO, amount: SPOOF_AMOUNT }),
    );

    expect(createWith).toHaveBeenCalledTimes(1);
    const stored = createWith.mock.calls[0]![1] as {
      previewJson: {
        toolName: string;
        criticalArgs: Record<string, unknown>;
      };
    };

    // Full money context present
    expect(stored.previewJson.toolName).toBe("wallet_send_confirm");
    expect(stored.previewJson.criticalArgs).toEqual({
      network: "eip155",
      chain: "base",
      to: REAL_TO,
      amount: REAL_AMOUNT,
      token: "USDC",
    });

    // Not a thin card
    expect(stored.previewJson.criticalArgs).not.toHaveProperty("intentId");
    expect(Object.keys(stored.previewJson.criticalArgs).sort()).toEqual(
      ["amount", "chain", "network", "to", "token"].sort(),
    );

    // Spoof never lands in the approval the user sees
    const serialized = JSON.stringify(stored.previewJson);
    expect(serialized).not.toContain(SPOOF_TO);
    expect(serialized).not.toContain(SPOOF_AMOUNT);
    expect(serialized).toContain(REAL_TO);
    expect(serialized).toContain(REAL_AMOUNT);
  });

  it("C+D: reject cancels intent; re-enqueue / re-bind fail closed (no second card)", async () => {
    // Step 1 — first direct confirm would have shown a full card
    await enqueueDirectConfirm();
    expect(createWith).toHaveBeenCalledTimes(1);

    // Step 2 — user rejects the approval → wallet intent cancelled
    await cancelWalletIntentAfterApprovalRejection(SESSION, {
      command: "wallet_send_confirm",
      args: { network: "eip155", intentId: INTENT_ID },
    });
    expect(mockCancelIfPending).toHaveBeenCalledWith(INTENT_ID, SESSION);

    // Step 3 — intent is now cancelled in DB
    mockGetById.mockResolvedValue(
      pendingIntent({ status: "cancelled", cancelledAt: EXPIRES }),
    );

    // Step 4 — agent tries the attack: re-call confirm with only intentId
    await expect(enqueueDirectConfirm()).rejects.toThrow(/intent is cancelled/);
    // No second approval row
    expect(createWith).toHaveBeenCalledTimes(1);
    expect(enqueueWith).toHaveBeenCalledTimes(1);

    await expect(
      bindWalletSendConfirmApproval(SESSION, thinConfirmArgs()),
    ).rejects.toThrow(/intent is cancelled/);
  });

  it("E: confirm handler refuses cancelled intent (no pendingApproval retry surface)", async () => {
    mockGetById.mockResolvedValue(
      pendingIntent({ status: "cancelled", cancelledAt: EXPIRES }),
    );

    const result = await handleWalletSendConfirm(
      thinConfirmArgs(),
      {
        sessionId: SESSION,
        sessionPermission: "restricted",
        approved: false,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
    );

    expect(result.pendingApproval).toBeUndefined();
    expect(result.success).toBe(false);
    expect(result.output).toMatch(/cancelled/i);
    expect(mockConsumeIfPending).not.toHaveBeenCalled();
  });

  it("missing intent fails closed before any approval is written", async () => {
    mockGetById.mockResolvedValue(null);
    await expect(enqueueDirectConfirm()).rejects.toThrow(/intent not found/);
    expect(createWith).not.toHaveBeenCalled();
    expect(enqueueWith).not.toHaveBeenCalled();
  });

  it("expired intent fails closed before any approval is written", async () => {
    mockGetById.mockResolvedValue(
      pendingIntent({ expiresAt: "2026-07-12T09:59:00.000Z" }),
    );
    await expect(enqueueDirectConfirm()).rejects.toThrow(/intent expired/);
    expect(createWith).not.toHaveBeenCalled();
  });

  it("happy restricted path still surfaces real to/amount for a live pending intent", async () => {
    const bound = await bindWalletSendConfirmApproval(SESSION, thinConfirmArgs());
    expect(bound.preview.criticalArgs.to).toBe(REAL_TO);
    expect(bound.preview.criticalArgs.amount).toBe(REAL_AMOUNT);
    expect(bound.expiresAt).toBe(EXPIRES);

    const approvalId = await enqueueDirectConfirm();
    expect(typeof approvalId).toBe("string");
    expect(approvalId.startsWith("approval-")).toBe(true);
    expect(createWith.mock.calls[0]![1].previewJson.criticalArgs.to).toBe(REAL_TO);
  });
});
