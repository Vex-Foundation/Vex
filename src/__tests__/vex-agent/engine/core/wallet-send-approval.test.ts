/**
 * Wallet-send approval binding — preview from durable intent row + cancel on reject.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockGetById = vi.fn();
const mockCancelIfPending = vi.fn();

vi.mock("@vex-agent/db/repos/wallet-intents.js", () => ({
  getById: (...a: unknown[]) => mockGetById(...a),
  cancelIfPending: (...a: unknown[]) => mockCancelIfPending(...a),
}));

vi.mock("@utils/logger.js", () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

const {
  bindWalletSendConfirmApproval,
  cancelWalletIntentAfterApprovalRejection,
} = await import("@vex-agent/engine/core/wallet-send-approval.js");

const SESSION = "session-1";
const INTENT_ID = "intent-00000000-0000-4000-8000-000000000001";

function pendingIntent(overrides: Record<string, unknown> = {}) {
  return {
    intentId: INTENT_ID,
    sessionId: SESSION,
    walletAddress: "0xwallet",
    network: "eip155" as const,
    chainAlias: "base",
    toAddress: "0xrealrecipient00000000000000000000000001",
    amount: "1.5",
    token: "USDC",
    previewJson: { label: "x", criticalArgs: {} },
    status: "pending" as const,
    expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    consumedAt: null,
    cancelledAt: null,
    txHash: null,
    failureReason: null,
    idempotencyKey: INTENT_ID,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-07-12T10:00:00.000Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("bindWalletSendConfirmApproval", () => {
  it("builds criticalArgs from the wallet_intents row, never from model args", async () => {
    mockGetById.mockResolvedValueOnce(pendingIntent());
    const bound = await bindWalletSendConfirmApproval(SESSION, {
      network: "eip155",
      intentId: INTENT_ID,
      to: "0xmodel-spoofed",
      amount: "999999",
    });
    expect(mockGetById).toHaveBeenCalledWith(INTENT_ID, SESSION);
    expect(bound.preview).toEqual({
      toolName: "wallet_send_confirm",
      criticalArgs: {
        network: "eip155",
        chain: "base",
        to: "0xrealrecipient00000000000000000000000001",
        amount: "1.5",
        token: "USDC",
      },
    });
    expect(JSON.stringify(bound.preview)).not.toContain("0xmodel-spoofed");
    expect(JSON.stringify(bound.preview)).not.toContain("999999");
    expect(bound.expiresAt).toBe(pendingIntent().expiresAt);
  });

  it("fails closed when intent is missing", async () => {
    mockGetById.mockResolvedValueOnce(null);
    await expect(
      bindWalletSendConfirmApproval(SESSION, {
        network: "eip155",
        intentId: INTENT_ID,
      }),
    ).rejects.toThrow(/intent not found/);
  });

  it("fails closed when intent is not pending", async () => {
    mockGetById.mockResolvedValueOnce(pendingIntent({ status: "cancelled" }));
    await expect(
      bindWalletSendConfirmApproval(SESSION, {
        network: "eip155",
        intentId: INTENT_ID,
      }),
    ).rejects.toThrow(/intent is cancelled/);
  });

  it("fails closed when intent is expired", async () => {
    mockGetById.mockResolvedValueOnce(
      pendingIntent({ expiresAt: "2026-07-12T09:00:00.000Z" }),
    );
    await expect(
      bindWalletSendConfirmApproval(SESSION, {
        network: "eip155",
        intentId: INTENT_ID,
      }),
    ).rejects.toThrow(/intent expired/);
  });

  it("fails closed on network mismatch", async () => {
    mockGetById.mockResolvedValueOnce(pendingIntent({ network: "solana" }));
    await expect(
      bindWalletSendConfirmApproval(SESSION, {
        network: "eip155",
        intentId: INTENT_ID,
      }),
    ).rejects.toThrow(/network mismatch/);
  });

  it("fails closed when network/intentId missing from args", async () => {
    await expect(
      bindWalletSendConfirmApproval(SESSION, { network: "eip155" }),
    ).rejects.toThrow(/missing network or intentId/);
    expect(mockGetById).not.toHaveBeenCalled();
  });
});

describe("cancelWalletIntentAfterApprovalRejection", () => {
  it("cancels pending wallet intent for wallet_send_confirm queue rows", async () => {
    mockCancelIfPending.mockResolvedValueOnce(pendingIntent({ status: "cancelled" }));
    await cancelWalletIntentAfterApprovalRejection(SESSION, {
      command: "wallet_send_confirm",
      args: { network: "eip155", intentId: INTENT_ID },
    });
    expect(mockCancelIfPending).toHaveBeenCalledWith(INTENT_ID, SESSION);
  });

  it("supports legacy {name, arguments} queue shape", async () => {
    mockCancelIfPending.mockResolvedValueOnce(null);
    await cancelWalletIntentAfterApprovalRejection(SESSION, {
      name: "wallet_send_confirm",
      arguments: { network: "solana", intentId: INTENT_ID },
    });
    expect(mockCancelIfPending).toHaveBeenCalledWith(INTENT_ID, SESSION);
  });

  it("no-ops for non-wallet tools", async () => {
    await cancelWalletIntentAfterApprovalRejection(SESSION, {
      command: "kyberswap.swap.sell",
      args: { amountIn: "1" },
    });
    expect(mockCancelIfPending).not.toHaveBeenCalled();
  });

  it("no-ops when intentId is missing", async () => {
    await cancelWalletIntentAfterApprovalRejection(SESSION, {
      command: "wallet_send_confirm",
      args: { network: "eip155" },
    });
    expect(mockCancelIfPending).not.toHaveBeenCalled();
  });

  it("swallows cancel DB errors (approval reject must still complete)", async () => {
    mockCancelIfPending.mockRejectedValueOnce(new Error("db down"));
    await expect(
      cancelWalletIntentAfterApprovalRejection(SESSION, {
        command: "wallet_send_confirm",
        args: { intentId: INTENT_ID },
      }),
    ).resolves.toBeUndefined();
  });
});
