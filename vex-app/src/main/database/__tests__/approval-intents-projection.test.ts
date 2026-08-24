/**
 * Approval intent projection tests.
 *
 * Sibling of `approvals-db.test.ts` for the companion
 * `approval_intents` LEFT JOIN contract. This file adds:
 *   - LEFT JOIN read with companion intent populated → DTO carries
 *     actionKind / riskLevel / preview / expiresAt / decision /
 *     decisionReason / executionStatus
 *   - LEFT JOIN read WITHOUT companion intent (back-compat with rows
 *     predating mig 024) → those DTO fields are null
 *   - preview JSONB allow-listing → malformed preview produces `null`
 *     in DTO, NOT a raw blob leak
 *   - SQL inspection — every read query uses the `q.*` + LEFT JOIN
 *     pattern, NOT the legacy `approval_queue` standalone SELECT
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type QueryFn = (
  text: string,
  params?: readonly unknown[],
) => Promise<{ rows: ReadonlyArray<Record<string, unknown>> }>;

const mocks = vi.hoisted(() => ({
  query: vi.fn() as QueryFn,
  connect: vi.fn(),
  end: vi.fn(),
  buildPoolConfig: vi.fn(),
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock("pg", () => {
  function MockClient() {
    return { connect: mocks.connect, end: mocks.end, query: mocks.query };
  }
  return { Client: MockClient };
});

vi.mock("../db-config.js", () => ({ buildPoolConfig: mocks.buildPoolConfig }));
vi.mock("../../logger/index.js", () => ({ log: mocks.log }));

const {
  getApprovalById,
  getHistoryForSession,
  listPendingAllApprovals,
  listPendingForSession,
} = await import("../approvals-db.js");

const SESSION = "00000000-0000-4000-8000-00000000bbbb";
const APPROVAL_ID = "approval-intent-001";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.buildPoolConfig.mockResolvedValue({
    host: "127.0.0.1",
    port: 5777,
    database: "vex",
    user: "vex",
    password: "secret",
  });
  mocks.connect.mockResolvedValue(undefined);
  mocks.end.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.clearAllMocks();
});

// ── Fixtures ──────────────────────────────────────────────────────────

function rowWithIntent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: APPROVAL_ID,
    status: "pending",
    session_id: SESSION,
    tool_call_id: "tc-1",
    tool_call: { namespace: "kyberswap", command: "swap.sell", args: { chain: "base" } },
    reasoning: "swap 1 ETH → USDC on Base",
    permission_at_enqueue: "restricted",
    created_at: "2026-05-23T20:00:00.000Z",
    resolved_at: null,
    intent_action_kind: "user_wallet_broadcast",
    intent_risk_level: "high",
    intent_preview_json: {
      toolName: "kyberswap.swap.sell",
      namespace: "kyberswap",
      criticalArgs: { chain: "base", tokenIn: "ETH", tokenOut: "USDC", amountIn: "1.0" },
    },
    intent_expires_at: null,
    intent_decision: null,
    intent_decision_reason: null,
    intent_execution_status: "not_started",
    ...overrides,
  };
}

function rowWithoutIntent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "legacy-approval-001",
    status: "pending",
    session_id: SESSION,
    tool_call_id: null,
    tool_call: { command: "wallet_balances" },
    reasoning: "read wallet balances",
    permission_at_enqueue: "restricted",
    created_at: "2026-05-23T19:00:00.000Z",
    resolved_at: null,
    intent_action_kind: null,
    intent_risk_level: null,
    intent_preview_json: null,
    intent_expires_at: null,
    intent_decision: null,
    intent_decision_reason: null,
    intent_execution_status: null,
    ...overrides,
  };
}

// ── LEFT JOIN — companion intent populated ───────────────────────────

describe("DTO projection - companion intent present", () => {
  it("surfaces all companion intent fields when JOIN finds an intent row", async () => {
    mocks.query.mockResolvedValueOnce({ rows: [rowWithIntent()] });
    const result = await listPendingForSession(SESSION);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const dto = result.data[0]!;

    expect(dto.actionKind).toBe("user_wallet_broadcast");
    expect(dto.riskLevel).toBe("high");
    expect(dto.preview).toEqual({
      toolName: "kyberswap.swap.sell",
      namespace: "kyberswap",
      criticalArgs: { chain: "base", tokenIn: "ETH", tokenOut: "USDC", amountIn: "1.0" },
    });
    expect(dto.executionStatus).toBe("not_started");
    expect(dto.expiresAt).toBeNull();
    expect(dto.decision).toBeNull();
    expect(dto.decisionReason).toBeNull();
  });

  it("returns ISO datetime string for intent_expires_at when populated", async () => {
    mocks.query.mockResolvedValueOnce({
      rows: [rowWithIntent({ intent_expires_at: new Date("2026-06-01T12:00:00Z") })],
    });
    const result = await listPendingForSession(SESSION);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data[0]!.expiresAt).toBe("2026-06-01T12:00:00.000Z");
  });

  it("surfaces decision + decisionReason when runtime has populated them", async () => {
    mocks.query.mockResolvedValueOnce({
      rows: [
        rowWithIntent({
          intent_decision: "rejected",
          intent_decision_reason: "user clicked reject - wallet not authorized",
          intent_execution_status: "failed",
        }),
      ],
    });
    const result = await listPendingForSession(SESSION);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data[0]!.decision).toBe("rejected");
    expect(result.data[0]!.decisionReason).toBe("user clicked reject - wallet not authorized");
    expect(result.data[0]!.executionStatus).toBe("failed");
  });
});

// ── LEFT JOIN — companion intent missing (back-compat) ───────────────

describe("DTO projection - back-compat with rows predating migration 024", () => {
  it("returns null for all companion fields when LEFT JOIN found no intent", async () => {
    mocks.query.mockResolvedValueOnce({ rows: [rowWithoutIntent()] });
    const result = await listPendingForSession(SESSION);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const dto = result.data[0]!;
    expect(dto.actionKind).toBeNull();
    expect(dto.riskLevel).toBeNull();
    expect(dto.preview).toBeNull();
    expect(dto.expiresAt).toBeNull();
    expect(dto.decision).toBeNull();
    expect(dto.decisionReason).toBeNull();
    expect(dto.executionStatus).toBeNull();
  });

  it("still extracts toolName + reasoningPreview from the legacy approval_queue columns", async () => {
    mocks.query.mockResolvedValueOnce({ rows: [rowWithoutIntent()] });
    const result = await listPendingForSession(SESSION);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const dto = result.data[0]!;
    expect(dto.toolName).toBe("wallet_balances");
    expect(dto.reasoningPreview).toBe("read wallet balances");
  });
});

// ── Preview JSONB allow-listing — drift / leak defense ───────────────

describe("DTO projection - preview JSONB allow-list", () => {
  it("returns null preview when intent_preview_json is malformed (missing toolName)", async () => {
    mocks.query.mockResolvedValueOnce({
      rows: [
        rowWithIntent({
          intent_preview_json: { someUnexpectedShape: true }, // schema requires toolName + criticalArgs
        }),
      ],
    });
    const result = await listPendingForSession(SESSION);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // strict Zod parse rejects → null. Raw blob never reaches renderer.
    expect(result.data[0]!.preview).toBeNull();
  });

  it("rejects preview with nested object inside criticalArgs (defense vs leak)", async () => {
    mocks.query.mockResolvedValueOnce({
      rows: [
        rowWithIntent({
          intent_preview_json: {
            toolName: "wallet_send_prepare",
            criticalArgs: {
              to: { nested: "leak-attempt" }, // schema only allows scalar/null values
            },
          },
        }),
      ],
    });
    const result = await listPendingForSession(SESSION);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data[0]!.preview).toBeNull();
  });

  it("rejects unknown action_kind values (schema drift defense)", async () => {
    mocks.query.mockResolvedValueOnce({
      rows: [
        rowWithIntent({ intent_action_kind: "undocumented_kind" }),
      ],
    });
    const result = await listPendingForSession(SESSION);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Mapper collapses unknown enum to null rather than leaking the raw string.
    expect(result.data[0]!.actionKind).toBeNull();
  });
});

// ── SQL inspection — LEFT JOIN wired across all 3 read paths ─────────

describe("SQL - every read path includes the LEFT JOIN approval_intents", () => {
  it("listPendingForSession uses LEFT JOIN approval_intents", async () => {
    mocks.query.mockResolvedValueOnce({ rows: [] });
    await listPendingForSession(SESSION);
    const sql = mocks.query.mock.calls[0]![0] as string;
    expect(sql).toContain("LEFT JOIN approval_intents");
    expect(sql).toContain("ON i.approval_id = q.id");
  });

  it("getApprovalById uses LEFT JOIN approval_intents", async () => {
    mocks.query.mockResolvedValueOnce({ rows: [] });
    await getApprovalById(APPROVAL_ID);
    const sql = mocks.query.mock.calls[0]![0] as string;
    expect(sql).toContain("LEFT JOIN approval_intents");
  });

  it("getHistoryForSession uses LEFT JOIN approval_intents", async () => {
    mocks.query.mockResolvedValueOnce({ rows: [] });
    await getHistoryForSession(SESSION, 10);
    const sql = mocks.query.mock.calls[0]![0] as string;
    expect(sql).toContain("LEFT JOIN approval_intents");
  });

  it("listPendingAllApprovals reuses the SAME companion LEFT JOIN (single sanitization seam)", async () => {
    vi.mocked(mocks.query).mockResolvedValueOnce({ rows: [] });
    await listPendingAllApprovals();
    const sql = vi.mocked(mocks.query).mock.calls[0]![0] as string;
    expect(sql).toContain("LEFT JOIN approval_intents");
    expect(sql).toContain("ON i.approval_id = q.id");
  });
});

// ── App-wide inbox reuses the companion projection unchanged ─────────────

describe("listPendingAllApprovals - companion intent projection", () => {
  // Re-type the shared `QueryFn` mock as a Mock (same instance) so the mock
  // helpers are typed without adding to the type-error baseline.
  const queryMock = vi.mocked(mocks.query);

  it("surfaces the rich DTO fields via the shared toDto mapper", async () => {
    queryMock.mockResolvedValueOnce({
      rows: [{ ...rowWithIntent(), session_title: "Base swap", session_deleted_at: null }],
    });
    const result = await listPendingAllApprovals();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const dto = result.data[0]!;
    expect(dto.actionKind).toBe("user_wallet_broadcast");
    expect(dto.riskLevel).toBe("high");
    expect(dto.preview).toEqual({
      toolName: "kyberswap.swap.sell",
      namespace: "kyberswap",
      criticalArgs: { chain: "base", tokenIn: "ETH", tokenOut: "USDC", amountIn: "1.0" },
    });
    expect(dto.sessionTitle).toBe("Base swap");
  });

  it("back-compat row (no companion intent) yields null rich fields", async () => {
    queryMock.mockResolvedValueOnce({
      rows: [{ ...rowWithoutIntent(), session_title: null, session_deleted_at: null }],
    });
    const result = await listPendingAllApprovals();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const dto = result.data[0]!;
    expect(dto.actionKind).toBeNull();
    expect(dto.riskLevel).toBeNull();
    expect(dto.preview).toBeNull();
    expect(dto.sessionTitle).toBeNull();
  });
});
