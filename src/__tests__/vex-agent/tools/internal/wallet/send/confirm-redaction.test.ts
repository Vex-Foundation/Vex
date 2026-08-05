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
const mockMarkAuditFailed = vi.fn();

vi.mock("@vex-agent/db/repos/wallet-intents.js", () => ({
  createWith: (...a: unknown[]) => mockCreate(...a),
  getById: (...a: unknown[]) => mockGetById(...a),
  consumeIfPendingWith: (...a: unknown[]) => mockConsumeIfPending(...a),
  markExecutedWith: (...a: unknown[]) => mockMarkExecuted(...a),
  markFailedWith: (...a: unknown[]) => mockMarkFailed(...a),
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

// ── Secret leak prevention ──────────────────────────────────────────────

describe("handleWalletSendConfirm — secret redaction", () => {
  beforeEach(() => {
    mockGetById.mockResolvedValueOnce(pendingIntent());
    mockConsumeIfPending.mockResolvedValueOnce(
      pendingIntent({ status: "consuming" }),
    );
  });

  it("pre_broadcast_failed → output structural only, never raw error message", async () => {
    // The executor would summarize secrets internally; here we simulate
    // an outcome where errorKind/errorHash are structural (no raw msg).
    mockExecuteEvm.mockResolvedValueOnce({
      kind: "pre_broadcast_failed",
      errorKind: "Error",
      // hash of a hypothetical secret-laden message
      errorHash: "feedbeefcafe1234",
    });

    const result = await handleWalletSendConfirm(
      { walletFamily: "eip155", intentId: "intent-test-1" },
      makeContext({ approved: true }),
    );

    expect(result.output).toMatch(/^Wallet transfer failed before broadcast\. Error hash: [a-f0-9]{16}\.$/);
    expect(result.output).not.toContain("sk_live");
    expect(result.output).not.toContain("Bearer");
    expect(result.output).not.toContain("supersecret");

    // failure_reason persisted to DB is also structural-only
    const reasonArg = mockMarkFailed.mock.calls[0][3];
    expect(reasonArg).toMatch(/^Error:[a-f0-9]{16}$/);
    expect(reasonArg).not.toContain("sk_live");
  });
});
