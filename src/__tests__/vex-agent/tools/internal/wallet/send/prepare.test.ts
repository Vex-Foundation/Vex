/**
 * wallet/send.ts — puzzle 5 phase 4 unit tests.
 *
 * Pinned invariants:
 *   - prepare creates DB row with full fields + 10-min TTL
 *   - confirm session-scoped getById (cross-session yields not found)
 *   - confirm approval gate: !approved && restricted → pendingApproval, NO consume
 *   - confirm expired / cancelled / wrong status → fail BEFORE approval gate
 *   - all 4 ExecuteOutcome paths route to correct repo write:
 *     confirmed → markExecuted, chain_failed → markFailed(txHash set),
 *     confirmation_unknown → markFailed(txHash set),
 *     pre_broadcast_failed → markFailed(txHash=null)
 *   - PATH D-AUDIT: markExecuted throws → markAuditFailed best-effort,
 *     ToolResult still success (tx real)
 *   - structural-only output: secret in error → no raw, only ErrorKind+hash
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockCreate = vi.fn().mockResolvedValue(undefined);
const mockGetById = vi.fn();
const mockConsumeIfPending = vi.fn();
const mockMarkExecuted = vi.fn();
const mockMarkFailed = vi.fn();
const mockMarkAuditFailed = vi.fn();

vi.mock("@vex-agent/db/repos/wallet-intents.js", () => ({
  create: (...a: unknown[]) => mockCreate(...a),
  getById: (...a: unknown[]) => mockGetById(...a),
  consumeIfPending: (...a: unknown[]) => mockConsumeIfPending(...a),
  markExecuted: (...a: unknown[]) => mockMarkExecuted(...a),
  markFailed: (...a: unknown[]) => mockMarkFailed(...a),
  markAuditFailed: (...a: unknown[]) => mockMarkAuditFailed(...a),
}));

const mockExecuteSolana = vi.fn();
const mockExecuteEvm = vi.fn();

vi.mock("../../../../../../vex-agent/tools/internal/wallet/send-execute-solana.js", () => ({
  executeSolanaTransfer: (...a: unknown[]) => mockExecuteSolana(...a),
}));

vi.mock("../../../../../../vex-agent/tools/internal/wallet/send-execute-evm.js", () => ({
  executeEvmTransfer: (...a: unknown[]) => mockExecuteEvm(...a),
}));

// Phase 5B: send.ts resolves the wallet via the engine resolver (resolve.ts),
// not the zero-arg multi-auth primitives. Mock that boundary. Returned signer
// addresses match the fixture intents so the confirm address-assert passes
// (walletAddressesEqual is real).
vi.mock("../../../../../../vex-agent/tools/internal/wallet/resolve.js", () => ({
  resolveSelectedAddress: vi.fn((_r: unknown, _p: unknown, family: string) =>
    family === "solana"
      ? "SoLanaAddr1111111111111111111111111111111"
      : "0xabcdef1234567890abcdef1234567890abcdef12"),
  resolveSigningWallet: vi.fn((_r: unknown, _p: unknown, family: string) =>
    family === "solana"
      ? { family: "solana", address: "SoLanaAddr1111111111111111111111111111111", secretKey: new Uint8Array(64) }
      : { family: "eip155", address: "0xabcdef1234567890abcdef1234567890abcdef12", privateKey: "0x" + "1".repeat(64) }),
  walletScopeErrorToResult: (err: unknown) => { throw err; },
}));

vi.mock("@utils/logger.js", () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

const { handleWalletSendPrepare, handleWalletSendConfirm } = await import(
  "../../../../../../vex-agent/tools/internal/wallet/send.js"
);

const SESSION_ID = "00000000-0000-4000-8000-000000000001";

interface FixtureIntent {
  intentId: string;
  sessionId: string;
  walletAddress: string;
  network: "eip155" | "solana";
  chainAlias: string | null;
  toAddress: string;
  amount: string;
  token: string | null;
  status:
    | "pending"
    | "consuming"
    | "executed"
    | "failed"
    | "audit_failed"
    | "cancelled"
    | "expired";
  expiresAt: string;
  consumedAt: string | null;
  cancelledAt: string | null;
  txHash: string | null;
  failureReason: string | null;
  idempotencyKey: string | null;
  createdAt: string;
  previewJson: Record<string, unknown>;
}

function pendingIntent(overrides: Partial<FixtureIntent> = {}): FixtureIntent {
  return {
    intentId: "intent-test-1",
    sessionId: SESSION_ID,
    walletAddress: "0xabcdef1234567890abcdef1234567890abcdef12",
    network: "eip155",
    chainAlias: "base",
    toAddress: "0xfedcba0987654321fedcba0987654321fedcba09",
    amount: "1.5",
    token: null,
    status: "pending",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    consumedAt: null,
    cancelledAt: null,
    txHash: null,
    failureReason: null,
    idempotencyKey: "intent-test-1",
    createdAt: "2026-05-24T20:00:00.000Z",
    previewJson: { label: "test", criticalArgs: {} },
    ...overrides,
  };
}

function makeContext(overrides: Partial<{ sessionPermission: "restricted" | "full"; approved: boolean; sessionId: string }> = {}) {
  return {
    sessionId: SESSION_ID,
    loadedDocuments: new Map(),
    sessionPermission: "restricted" as const,
    approved: false,
    role: "parent" as const,
    missionRunId: null,
    missionId: null,
    sessionKind: "agent" as const,
    contextUsageBand: "normal" as const,
    sourceSurface: "vex_agent" as const,
    sourceSession: SESSION_ID,
    walletResolution: { source: "default" as const },
    walletPolicy: { kind: "none" as const },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── handleWalletSendPrepare ─────────────────────────────────────────────

describe("handleWalletSendPrepare", () => {
  it("creates a DB intent row with 10-min TTL + structured preview", async () => {
    const result = await handleWalletSendPrepare(
      { network: "eip155", chain: "base", to: "0xfedcba0987654321fedcba0987654321fedcba09", amount: "1.5" },
      makeContext(),
    );

    expect(result.success).toBe(true);
    expect(mockCreate).toHaveBeenCalledTimes(1);
    const createArgs = mockCreate.mock.calls[0][0];
    expect(createArgs).toMatchObject({
      sessionId: SESSION_ID,
      walletAddress: "0xabcdef1234567890abcdef1234567890abcdef12",
      network: "eip155",
      chainAlias: "base",
      toAddress: "0xfedcba0987654321fedcba0987654321fedcba09",
      amount: "1.5",
      token: null,
    });
    expect(createArgs.intentId).toMatch(/^intent-[0-9a-f-]+$/);
    expect(createArgs.idempotencyKey).toBe(createArgs.intentId);

    const expiresAt = new Date(createArgs.expiresAt).getTime();
    const now = Date.now();
    expect(expiresAt - now).toBeGreaterThan(8 * 60_000);
    expect(expiresAt - now).toBeLessThan(11 * 60_000);

    expect(createArgs.previewJson).toMatchObject({
      label: expect.any(String),
      criticalArgs: {
        network: "eip155",
        chain: "base",
        to: "0xfedcba0987654321fedcba0987654321fedcba09",
        amount: "1.5",
        token: null,
      },
    });
    expect(result.preparedActionFollowUp).toEqual({
      toolName: "wallet_send_confirm",
      args: {
        network: "eip155",
        intentId: createArgs.intentId,
      },
      expiresAt: createArgs.expiresAt,
      approvalPreview: {
        toolName: "wallet_send_confirm",
        criticalArgs: createArgs.previewJson.criticalArgs,
      },
    });
  });

  it("rejects missing required fields", async () => {
    const result = await handleWalletSendPrepare(
      { network: "eip155", to: "0xfed", amount: "" },
      makeContext(),
    );
    expect(result.success).toBe(false);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("rejects eip155 without chain", async () => {
    const result = await handleWalletSendPrepare(
      { network: "eip155", to: "0xfed", amount: "1.0" },
      makeContext(),
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain("chain");
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("rejects invalid numeric amount", async () => {
    const result = await handleWalletSendPrepare(
      { network: "solana", to: "SoLAdr", amount: "abc" },
      makeContext(),
    );
    expect(result.success).toBe(false);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("uses solana wallet address for solana network", async () => {
    const result = await handleWalletSendPrepare(
      { network: "solana", to: "SoLAdr11111111111111111111111111111111", amount: "0.5" },
      makeContext(),
    );
    expect(mockCreate.mock.calls[0][0].walletAddress).toBe(
      "SoLanaAddr1111111111111111111111111111111",
    );
    expect(mockCreate.mock.calls[0][0].chainAlias).toBeNull();
    expect(result.preparedActionFollowUp).toMatchObject({
      args: { network: "solana" },
      approvalPreview: {
        criticalArgs: {
          network: "solana",
          chain: null,
          to: "SoLAdr11111111111111111111111111111111",
          amount: "0.5",
          token: null,
        },
      },
    });
  });
});
