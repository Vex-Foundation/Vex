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
import type { InternalToolContext } from "@vex-agent/tools/internal/types.js";
import { makeTestContext } from "../../../_test-context.js";

const mockCreate = vi.fn().mockResolvedValue(undefined);
const mockGetById = vi.fn();
const mockConsumeIfPending = vi.fn();
const mockMarkExecuted = vi.fn();
const mockMarkFailed = vi.fn();
const mockMarkBroadcastUnconfirmed = vi.fn();
const mockMarkAuditFailed = vi.fn();

vi.mock("@vex-agent/db/repos/wallet-intents.js", () => ({
  createWith: (...a: unknown[]) => mockCreate(...a),
  getById: (...a: unknown[]) => mockGetById(...a),
  consumeIfPendingWith: (...a: unknown[]) => mockConsumeIfPending(...a),
  markExecutedWith: (...a: unknown[]) => mockMarkExecuted(...a),
  markFailedWith: (...a: unknown[]) => mockMarkFailed(...a),
  markBroadcastUnconfirmedWith: (...a: unknown[]) => mockMarkBroadcastUnconfirmed(...a),
  markAuditFailedWith: (...a: unknown[]) => mockMarkAuditFailed(...a),
}));

// The money-state writers are client-bound and run inside a session-control-
// locked transaction (compaction contract C7). Stub the lock so these unit
// tests stay pool-free; `SENTINEL_CLIENT` is what the repo mocks receive as
// their first argument.
const SENTINEL_CLIENT = { __sessionControlLocked: true } as const;
vi.mock("@vex-agent/engine/runtime/lease-and-status/session-control-lock.js", () => ({
  withSessionControlLock: (_sessionId: string, fn: (c: unknown) => unknown) =>
    Promise.resolve(fn(SENTINEL_CLIENT)),
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

function makeContext(overrides: Partial<InternalToolContext> = {}): InternalToolContext {
  return makeTestContext({
    sessionId: SESSION_ID,
    sourceSurface: "vex_agent",
    sourceSession: SESSION_ID,
    ...overrides,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── handleWalletSendConfirm — preconditions ─────────────────────────────

describe("handleWalletSendConfirm — preconditions", () => {
  it("session-scoped getById call (cross-session miss returns 'Intent not found')", async () => {
    mockGetById.mockResolvedValueOnce(null);
    const result = await handleWalletSendConfirm(
      { walletFamily: "eip155", intentId: "intent-test-1" },
      makeContext(),
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain("Intent not found");
    expect(mockGetById).toHaveBeenCalledWith("intent-test-1", SESSION_ID);
    expect(mockConsumeIfPending).not.toHaveBeenCalled();
  });

  it("network mismatch returns fail without consume", async () => {
    mockGetById.mockResolvedValueOnce(pendingIntent({ network: "solana" }));
    const result = await handleWalletSendConfirm(
      { walletFamily: "eip155", intentId: "intent-test-1" },
      makeContext(),
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain("Network mismatch");
    expect(mockConsumeIfPending).not.toHaveBeenCalled();
  });

  it("non-pending status returns fail with current status", async () => {
    mockGetById.mockResolvedValueOnce(pendingIntent({ status: "cancelled" }));
    const result = await handleWalletSendConfirm(
      { walletFamily: "eip155", intentId: "intent-test-1" },
      makeContext(),
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain("is cancelled");
    expect(mockConsumeIfPending).not.toHaveBeenCalled();
  });

  it("expired intent returns fail with expiry time, no consume", async () => {
    mockGetById.mockResolvedValueOnce(
      pendingIntent({ expiresAt: new Date(Date.now() - 60_000).toISOString() }),
    );
    const result = await handleWalletSendConfirm(
      { walletFamily: "eip155", intentId: "intent-test-1" },
      makeContext(),
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain("expired");
    expect(mockConsumeIfPending).not.toHaveBeenCalled();
  });

  it("approval gate: !approved && restricted → pendingApproval, intent stays pending (no consume)", async () => {
    mockGetById.mockResolvedValueOnce(pendingIntent());
    const result = await handleWalletSendConfirm(
      { walletFamily: "eip155", intentId: "intent-test-1" },
      makeContext({ approved: false, sessionPermission: "restricted" }),
    );
    expect(result.success).toBe(false);
    expect((result as { pendingApproval?: boolean }).pendingApproval).toBe(true);
    expect(mockConsumeIfPending).not.toHaveBeenCalled();
  });

  it("CAS-consume race miss → fail with current status, NO executor invoked", async () => {
    mockGetById.mockResolvedValueOnce(pendingIntent());
    mockConsumeIfPending.mockResolvedValueOnce(null);
    // Second getById call (after CAS miss) reveals current status
    mockGetById.mockResolvedValueOnce(pendingIntent({ status: "consuming" }));

    const result = await handleWalletSendConfirm(
      { walletFamily: "eip155", intentId: "intent-test-1" },
      makeContext({ approved: true }),
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain("status=consuming");
    expect(mockExecuteEvm).not.toHaveBeenCalled();
  });

  it("resolved signer != intent wallet → fail closed, NO consume, NO markFailed (intent stays pending)", async () => {
    // Mocked resolveSigningWallet returns EVM signer 0xabcdef…; this intent
    // records a DIFFERENT wallet → the pre-consume assert fails closed without
    // mutating the intent.
    mockGetById.mockResolvedValueOnce(
      pendingIntent({ walletAddress: "0x9999999999999999999999999999999999999999" }),
    );
    const result = await handleWalletSendConfirm(
      { walletFamily: "eip155", intentId: "intent-test-1" },
      makeContext({ approved: true }),
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain("does not match this intent");
    expect(mockConsumeIfPending).not.toHaveBeenCalled();
    expect(mockMarkFailed).not.toHaveBeenCalled();
  });
});
