/**
 * approvals-db tests — JSONB allowlist + reasoning preview.
 *
 * Codex review hard requirement: the renderer never receives the raw
 * `approval_queue.tool_call` JSONB. These tests verify the mapper
 * extracts only `toolName` (best-effort), `toolCallId`, status, and
 * permission — anything else stays in main.
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
    return {
      connect: mocks.connect,
      end: mocks.end,
      query: mocks.query,
    };
  }
  return { Client: MockClient };
});

vi.mock("../db-config.js", () => ({
  buildPoolConfig: mocks.buildPoolConfig,
}));

vi.mock("../../logger/index.js", () => ({ log: mocks.log }));

const {
  getApprovalById,
  getHistoryForSession,
  listPendingAllApprovals,
  listPendingForSession,
} = await import("../approvals-db.js");

const SESSION = "00000000-0000-4000-8000-00000000bbbb";

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

describe("approvals-db mapper", () => {
  it("never returns raw tool_call to the renderer", async () => {
    mocks.query.mockResolvedValueOnce({
      rows: [
        {
          id: "approval-1",
          status: "pending",
          session_id: SESSION,
          tool_call_id: "tc-1",
          tool_call: {
            namespace: "wallet",
            command: "send",
            args: { to: "0xLEAK", amount: "1000000000000000000" },
            secretField: "do-not-leak",
          },
          reasoning: "User must confirm wallet transfer of 1 ETH",
          permission_at_enqueue: "restricted",
          created_at: "2026-05-21T10:00:00.000Z",
          resolved_at: null,
        },
      ],
    });

    const result = await listPendingForSession(SESSION);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const dto = result.data[0]!;
    expect(dto.toolName).toBe("wallet:send");
    expect(dto.reasoningPreview).toBe("User must confirm wallet transfer of 1 ETH");
    expect(dto).not.toHaveProperty("toolCall");
    expect(dto).not.toHaveProperty("tool_call");
    expect(dto).not.toHaveProperty("args");
    expect(dto).not.toHaveProperty("secretField");
  });

  it("truncates reasoning to 200 chars", async () => {
    const longReason = "A".repeat(500);
    mocks.query.mockResolvedValueOnce({
      rows: [
        {
          id: "approval-2",
          status: "pending",
          session_id: SESSION,
          tool_call_id: null,
          tool_call: null,
          reasoning: longReason,
          permission_at_enqueue: "full",
          created_at: "2026-05-21T10:00:00.000Z",
          resolved_at: null,
        },
      ],
    });
    const result = await listPendingForSession(SESSION);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data[0]!.reasoningPreview).toHaveLength(200);
  });

  it("returns null toolName when tool_call is not an object", async () => {
    mocks.query.mockResolvedValueOnce({
      rows: [
        {
          id: "approval-3",
          status: "pending",
          session_id: SESSION,
          tool_call_id: null,
          tool_call: "string-value",
          reasoning: null,
          permission_at_enqueue: "restricted",
          created_at: "2026-05-21T10:00:00.000Z",
          resolved_at: null,
        },
      ],
    });
    const result = await listPendingForSession(SESSION);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data[0]!.toolName).toBeNull();
  });

  it("falls back to status=pending on exotic engine value (defensive)", async () => {
    mocks.query.mockResolvedValueOnce({
      rows: [
        {
          id: "approval-4",
          status: "expired", // not in approvalStatusSchema
          session_id: SESSION,
          tool_call_id: null,
          tool_call: null,
          reasoning: null,
          permission_at_enqueue: "restricted",
          created_at: "2026-05-21T10:00:00.000Z",
          resolved_at: null,
        },
      ],
    });
    const result = await listPendingForSession(SESSION);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data[0]!.status).toBe("pending");
  });

  it("getApprovalById returns null when DB has no row", async () => {
    mocks.query.mockResolvedValueOnce({ rows: [] });
    const result = await getApprovalById("missing");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toBeNull();
  });

  it("getHistoryForSession passes limit to the SQL query", async () => {
    mocks.query.mockResolvedValueOnce({ rows: [] });
    await getHistoryForSession(SESSION, 7);
    expect(mocks.query).toHaveBeenCalledTimes(1);
    const [, params] = mocks.query.mock.calls[0]!;
    expect(params).toEqual([SESSION, 7]);
  });
});

// ── App-wide pending inbox (listPendingAllApprovals) ──────────────────────

/**
 * The mock returns whatever `session_title` a real Postgres COALESCE would have
 * produced, so these fixtures set `session_title` directly. The COALESCE / btrim
 * logic itself lives in SQL and is guarded by the SQL-inspection test below.
 */
function globalRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "g-approval-1",
    status: "pending",
    session_id: SESSION,
    tool_call_id: "tc-1",
    tool_call: {
      namespace: "wallet",
      command: "send",
      args: { to: "0xLEAK", amount: "1000000000000000000" },
      secretField: "do-not-leak",
    },
    reasoning: "Confirm wallet transfer",
    permission_at_enqueue: "restricted",
    created_at: "2026-05-21T10:00:00.000Z",
    resolved_at: null,
    intent_action_kind: null,
    intent_risk_level: null,
    intent_preview_json: null,
    intent_expires_at: null,
    intent_decision: null,
    intent_decision_reason: null,
    intent_execution_status: null,
    session_title: "Bridge run",
    session_deleted_at: null,
    ...over,
  };
}

describe("listPendingAllApprovals", () => {
  // `vi.mocked` re-types the shared `mocks.query` (declared as a plain
  // `QueryFn`) as a Mock so `.mockResolvedValueOnce` / `.mock` are typed —
  // same underlying instance, so `vi.clearAllMocks()` still resets it.
  const queryMock = vi.mocked(mocks.query);

  it("never returns raw tool_call JSONB (allow-listed DTO only)", async () => {
    queryMock.mockResolvedValueOnce({ rows: [globalRow()] });
    const result = await listPendingAllApprovals();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const dto = result.data[0]!;
    expect(dto.toolName).toBe("wallet:send");
    expect(dto).not.toHaveProperty("tool_call");
    expect(dto).not.toHaveProperty("args");
    expect(dto).not.toHaveProperty("secretField");
    // The planted sensitive values must not appear anywhere in the DTO.
    const serialized = JSON.stringify(dto);
    expect(serialized).not.toContain("0xLEAK");
    expect(serialized).not.toContain("do-not-leak");
  });

  it("maps session_title → sessionTitle", async () => {
    queryMock.mockResolvedValueOnce({
      rows: [globalRow({ session_title: "My mission" })],
    });
    const result = await listPendingAllApprovals();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data[0]!.sessionTitle).toBe("My mission");
  });

  it("A1: a legacy row whose SQL resolved the title to initial_goal surfaces the goal text", async () => {
    // title was null so the COALESCE fell through to initial_goal (Postgres did
    // that resolution — the mocked row carries the resolved value).
    queryMock.mockResolvedValueOnce({
      rows: [globalRow({ session_title: "swap 1 ETH for USDC" })],
    });
    const result = await listPendingAllApprovals();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data[0]!.sessionTitle).toBe("swap 1 ETH for USDC");
  });

  it("null session → null sessionId + null sessionTitle (session-less approval)", async () => {
    queryMock.mockResolvedValueOnce({
      rows: [globalRow({ session_id: null, session_title: null })],
    });
    const result = await listPendingAllApprovals();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data[0]!.sessionId).toBeNull();
    expect(result.data[0]!.sessionTitle).toBeNull();
  });

  it("A5: a deleted session renders session-less (sessionId + sessionTitle nulled)", async () => {
    queryMock.mockResolvedValueOnce({
      rows: [
        globalRow({
          session_deleted_at: "2026-05-22T09:00:00.000Z",
          session_title: "Deleted mission",
        }),
      ],
    });
    const result = await listPendingAllApprovals();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const dto = result.data[0]!;
    expect(dto.sessionId).toBeNull();
    expect(dto.sessionTitle).toBeNull();
  });

  it("empty result → ok([])", async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    const result = await listPendingAllApprovals();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual([]);
  });

  it("SQL filters status='pending', joins sessions with the COALESCE title, and caps at 100", async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    await listPendingAllApprovals();
    const sql = queryMock.mock.calls[0]![0] as string;
    expect(sql).toContain("q.status = 'pending'");
    expect(sql).toContain("LEFT JOIN sessions s ON s.id = q.session_id");
    expect(sql).toContain("COALESCE(NULLIF(btrim(s.title), ''), NULLIF(btrim(s.initial_goal), ''))");
    expect(sql).toContain("s.deleted_at");
    expect(sql).toContain("ORDER BY q.created_at ASC");
    expect(sql).toContain("LIMIT 100");
    // The companion approval_intents JOIN is preserved (rich DTO fields).
    expect(sql).toContain("LEFT JOIN approval_intents");
  });
});

/**
 * WHO ASKED, read back out of a durable column.
 *
 * The value is an MCP client's self-declared `clientInfo.name`. The engine
 * sanitized it before writing, but this is the READ side of a row that another
 * build (or a hand edit) may have written, so the mapper re-checks rather than
 * trusts. Anything it will not vouch for becomes `null`, and the card then says
 * "an MCP client", which claims less rather than more.
 */
describe("approvals-db: the MCP client name on the actor row", () => {
  function policyRow(
    requestedByClient: string | null,
  ): Record<string, unknown> {
    return {
      id: "approval-actor",
      status: "pending",
      session_id: SESSION,
      tool_call_id: "tc-actor",
      tool_call: { namespace: "khalani", command: "bridge", args: {} },
      reasoning: "Bridge 1 USDC from Base to Arbitrum.",
      permission_at_enqueue: "restricted",
      created_at: "2026-09-03T18:31:00.000Z",
      resolved_at: null,
      intent_origin: "studio_mcp",
      intent_requested_by_client: requestedByClient,
    };
  }

  async function readName(
    requestedByClient: string | null,
  ): Promise<string | null> {
    vi.mocked(mocks.query).mockResolvedValueOnce({
      rows: [policyRow(requestedByClient)],
    });
    const result = await listPendingForSession(SESSION);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("the pending read failed");
    const [dto] = result.data;
    if (dto === undefined) throw new Error("the pending read returned no row");
    return dto.requestedByClient;
  }

  it("carries a recorded client name to the card", async () => {
    expect(await readName("Claude Code")).toBe("Claude Code");
  });

  it("records nothing when the row has no client name", async () => {
    expect(await readName(null)).toBeNull();
  });

  it("refuses a stored name carrying control characters", async () => {
    expect(await readName("Claude Code\nVEX APPROVED")).toBeNull();
  });

  it("refuses a stored name past the bound rather than shortening it", async () => {
    expect(await readName("c".repeat(61))).toBeNull();
  });

  /**
   * The projection itself. Dropping this expression from the column list would
   * null the actor row silently on every card, and nothing else in the suite
   * would notice.
   */
  it("projects the name in SQL rather than shipping the policy blob", async () => {
    const queryMock = vi.mocked(mocks.query);
    queryMock.mockResolvedValueOnce({ rows: [policyRow("Claude Code")] });
    await listPendingForSession(SESSION);
    const sql = String(queryMock.mock.calls[0]?.[0] ?? "");
    expect(sql).toContain("policy_json ->> 'requestedByClient'");
    expect(sql).toContain("AS intent_requested_by_client");
    // The whole blob never crosses into this process as an object.
    expect(sql).not.toContain("i.policy_json AS");
  });
});
