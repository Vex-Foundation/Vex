import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const enqueueWith = vi.fn();
const createWith = vi.fn();
const updateStatus = vi.fn();
const mockGetById = vi.fn();

vi.mock("@vex-agent/db/repos/approvals.js", () => ({ enqueueWith }));
vi.mock("@vex-agent/db/repos/approval-intents.js", () => ({ createWith }));
vi.mock("@vex-agent/db/repos/mission-runs.js", () => ({ updateStatus }));
vi.mock("@vex-agent/db/client.js", () => ({
  withTransaction: async (fn: (client: object) => Promise<unknown>) => fn({}),
}));
vi.mock("@vex-agent/db/repos/wallet-intents.js", () => ({
  getById: (...a: unknown[]) => mockGetById(...a),
}));

const { enqueueApprovalIntent } = await import(
  "../../../../vex-agent/engine/core/turn-loop-tool-batch/approval-stop.js"
);

const PREPARED_EXPIRY = "2026-07-12T10:10:00.000Z";
const INTENT_ID = "intent-00000000-0000-4000-8000-000000000001";
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

function pendingWalletIntent(overrides: Record<string, unknown> = {}) {
  return {
    intentId: INTENT_ID,
    sessionId: "session-1",
    walletAddress: "SoLanaAddr1111111111111111111111111111111",
    network: "solana" as const,
    chainAlias: null,
    toAddress: "3SnLmaqoEczS2ft7RLQ1BRhtsLuAauWnx9K7pDjSRQrp",
    amount: "32.813008",
    token: "ANSEM",
    previewJson: { label: "x", criticalArgs: {} },
    status: "pending" as const,
    expiresAt: PREPARED_EXPIRY,
    consumedAt: null,
    cancelledAt: null,
    txHash: null,
    failureReason: null,
    idempotencyKey: INTENT_ID,
    createdAt: "2026-07-12T10:00:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-07-12T10:00:00.000Z"));
  vi.clearAllMocks();
  mockGetById.mockResolvedValue(pendingWalletIntent());
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
      name: "wallet_send_confirm",
      arguments: {
        network: "solana",
        intentId: INTENT_ID,
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
      contextUsageBand: "normal",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
    intentActionKind: "user_wallet_broadcast" as const,
    ...overrides,
  };
}

describe("prepared-action approval intent", () => {
  it("binds wallet_send_confirm preview from the wallet_intents row (ignores model spoof + trustedPreview args)", async () => {
    await enqueueApprovalIntent(
      baseArgs({
        trustedPreview: TRUSTED_PREVIEW,
        trustedExpiresAt: PREPARED_EXPIRY,
      }),
    );

    expect(mockGetById).toHaveBeenCalledWith(INTENT_ID, "session-1");
    expect(createWith).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        previewJson: {
          toolName: "wallet_send_confirm",
          criticalArgs: {
            network: "solana",
            chain: null,
            to: "3SnLmaqoEczS2ft7RLQ1BRhtsLuAauWnx9K7pDjSRQrp",
            amount: "32.813008",
            token: "ANSEM",
          },
        },
        expiresAt: PREPARED_EXPIRY,
      }),
    );
    const stored = createWith.mock.calls[0]![1];
    expect(JSON.stringify(stored.previewJson)).not.toContain(
      "model-spoofed-recipient",
    );
    expect(JSON.stringify(stored.previewJson)).not.toContain("999999");
  });

  it("floors the approval TTL at the wallet intent expiry when it is earlier than the default 1h window", async () => {
    // System time 10:00:00; intent expiry 10:10:00 — well inside the 1h
    // default (11:00:00), so the approval must expire with the intent, not
    // outlive it.
    await enqueueApprovalIntent(
      baseArgs({
        trustedPreview: TRUSTED_PREVIEW,
        trustedExpiresAt: PREPARED_EXPIRY,
      }),
    );
    const stored = createWith.mock.calls[0]![1];
    expect(stored.expiresAt).toBe(PREPARED_EXPIRY);
  });

  it("floors at the default 1h TTL when the wallet intent lives longer than the default window", async () => {
    mockGetById.mockResolvedValueOnce(
      pendingWalletIntent({ expiresAt: "2026-07-12T23:00:00.000Z" }),
    );
    await enqueueApprovalIntent(
      baseArgs({
        trustedPreview: TRUSTED_PREVIEW,
        trustedExpiresAt: "2026-07-12T23:00:00.000Z",
      }),
    );
    const stored = createWith.mock.calls[0]![1];
    expect(stored.expiresAt).toBe(
      new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    );
  });

  it("floors the approval TTL at an ALREADY-PAST wallet intent expiry only via fail-closed bind (never enqueues)", async () => {
    // System time 10:00:00; intent already expired — bind refuses so we never
    // silently mint a fresh 1h approval window over a dead intent.
    const pastExpiry = "2026-07-12T09:00:00.000Z";
    mockGetById.mockResolvedValueOnce(
      pendingWalletIntent({ expiresAt: pastExpiry }),
    );
    await expect(
      enqueueApprovalIntent(
        baseArgs({
          trustedPreview: TRUSTED_PREVIEW,
          trustedExpiresAt: pastExpiry,
        }),
      ),
    ).rejects.toThrow(/intent expired/);
    expect(createWith).not.toHaveBeenCalled();
  });

  it("direct model wallet_send_confirm path still binds full to/amount from the DB row (no thin card)", async () => {
    // No trustedPreview — the historical bug path that painted network+intentId only.
    await enqueueApprovalIntent(baseArgs());
    const stored = createWith.mock.calls[0]![1];
    expect(stored.previewJson.toolName).toBe("wallet_send_confirm");
    expect(stored.previewJson.criticalArgs).toEqual({
      network: "solana",
      chain: null,
      to: "3SnLmaqoEczS2ft7RLQ1BRhtsLuAauWnx9K7pDjSRQrp",
      amount: "32.813008",
      token: "ANSEM",
    });
    expect(stored.previewJson.criticalArgs).not.toHaveProperty("intentId");
    expect(stored.expiresAt).toBe(PREPARED_EXPIRY);
  });

  it("fails closed and does not enqueue when the wallet intent is missing", async () => {
    mockGetById.mockResolvedValueOnce(null);
    await expect(enqueueApprovalIntent(baseArgs())).rejects.toThrow(
      /intent not found/,
    );
    expect(createWith).not.toHaveBeenCalled();
    expect(enqueueWith).not.toHaveBeenCalled();
  });

  it("non-wallet tools still use args-derived / trusted preview path", async () => {
    await enqueueApprovalIntent(
      baseArgs({
        toolCall: {
          id: "swap-call",
          name: "kyberswap.swap.sell",
          arguments: {
            chain: "ethereum",
            tokenIn: "USDC",
            tokenOut: "ETH",
            amountIn: "100",
          },
        },
        result: {
          success: false,
          output: "approval required",
          pendingApproval: true,
          actionKind: "user_wallet_broadcast",
        },
        intentActionKind: "user_wallet_broadcast",
      }),
    );
    expect(mockGetById).not.toHaveBeenCalled();
    const stored = createWith.mock.calls[0]![1];
    expect(stored.previewJson.toolName).toBe("kyberswap.swap.sell");
    expect(stored.previewJson.criticalArgs).toMatchObject({
      chain: "ethereum",
      tokenIn: "USDC",
      amountIn: "100",
    });
  });
});
