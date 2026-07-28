/**
 * The `agent_activity` repo's YIELD contract (migration 053, card B1) — the
 * companion change that migration's own header calls REQUIRED, not optional.
 *
 * Migration 053 is explicit that its CHECKs are a floor: they prove legs are
 * PRESENT, not that they are RIGHT, and the real contract "belongs in the
 * finalizer beside the swap-specific guard, which is keyed on
 * `event_role === 'swap'` and therefore does NOT cover these roles today".
 *
 * Two things are pinned here.
 *
 * 1. THE OPTION-C SECOND LEG IS ACTUALLY WRITTEN AND READ. Migration 053 added
 *    14 nullable columns; a mapper that silently drops them, or a writer that
 *    never binds them, would leave `py.mint` recording only its PT and none of
 *    its YT — the exact falsehood Option C exists to end — with every CHECK
 *    still passing, because a NULL second leg is legal on paper.
 *
 * 2. THE PER-ROLE CONFIRM GUARD. The five roles disagree about what "both legs"
 *    means, and getting it wrong is dangerous in a specific direction: a guard
 *    that demanded an input leg from `yield_claim` would make the one shape a
 *    claim always has UNWRITABLE, pushing the finalizer toward inventing a value
 *    to satisfy the database.
 *
 * Plus the hashless-recovery allowlist: the five roles are signed locally
 * through one choke point and no Pendle-side sweep owns a hashless row, so a
 * crash between intent creation and staging must be reapable — otherwise the
 * row is pending forever.
 */

import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

type QueryOneMock = Mock<(sql: string, params?: unknown[]) => Promise<Record<string, unknown> | null>>;
type QueryMock = Mock<(sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>>;

let mockQueryOne: QueryOneMock;
let mockQuery: QueryMock;

function resetMocks() {
  mockQueryOne = vi
    .fn<(sql: string, params?: unknown[]) => Promise<Record<string, unknown> | null>>()
    .mockResolvedValue(null);
  mockQuery = vi
    .fn<(sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>>()
    .mockResolvedValue([]);
}
resetMocks();

vi.mock("@vex-agent/db/client.js", () => ({
  query: (sql: string, params?: unknown[]) => mockQuery(sql, params),
  queryOne: (sql: string, params?: unknown[]) => mockQueryOne(sql, params),
  execute: vi.fn(),
  queryWith: vi.fn(),
  queryOneWith: vi.fn(),
  executeWith: vi.fn(),
  withTransaction: vi.fn(),
}));

const repo = await import("@vex-agent/db/repos/agent-activity.js");

const PT = "0x1111111111111111111111111111111111111111";
const YT = "0x2222222222222222222222222222222222222222";

function yieldRow(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: 1,
    protocol_execution_id: 42,
    event_index: 0,
    event_role: "yield_py",
    record_version: 1,
    kind: "yield",
    protocol: "pendle",
    chain_id: 8453,
    chain_slug: "base",
    status: "pending",
    wallet_address: "0xwallet",
    chain_family: "eip155",
    created_at: new Date("2026-07-27T00:00:00Z"),
    updated_at: new Date("2026-07-27T00:00:00Z"),
    ...overrides,
  };
}

beforeEach(() => {
  resetMocks();
  vi.clearAllMocks();
});

// ── 1. The Option-C second leg survives the round trip ───────────────

describe("the Option-C second-leg columns are mapped, not dropped", () => {
  it("reads every second-leg column back onto the domain row", async () => {
    mockQueryOne.mockResolvedValueOnce(
      yieldRow({
        token_out2_address: YT,
        token_out2_symbol: "YT-sUSDe",
        token_out2_decimals: 18,
        amount_out2_human: "1",
        amount_out2_raw: "1000000000000000000",
        executed_amount_out2_human: "0.99",
        executed_amount_out2_raw: "990000000000000000",
      }),
    );

    const row = await repo.getActivityEventById(1);

    expect(row).toMatchObject({
      tokenOut2Address: YT,
      tokenOut2Symbol: "YT-sUSDe",
      tokenOut2Decimals: 18,
      amountOut2Raw: "1000000000000000000",
      executedAmountOut2Raw: "990000000000000000",
    });
  });

  it("maps an ABSENT second-leg decimals to null, never to 0", async () => {
    // `Number(null)` is 0, and 0 decimals is a REAL, valid answer for some
    // tokens — so a null-to-0 coercion would turn "we do not know" into a
    // confident thousandfold error rather than an obvious gap.
    mockQueryOne.mockResolvedValueOnce(yieldRow({ token_in2_decimals: null, token_out2_decimals: undefined }));

    const row = await repo.getActivityEventById(1);

    expect(row?.tokenIn2Decimals).toBeNull();
    expect(row?.tokenOut2Decimals).toBeNull();
  });
});

// ── 2. The per-role confirm guard ────────────────────────────────────

describe("confirmActivityEvent enforces migration 053's PER-ROLE leg contract", () => {
  /** Make `getActivityEventById` (the guard's first read) return this row. */
  function currentRow(overrides: Partial<Record<string, unknown>>) {
    mockQueryOne.mockResolvedValueOnce(yieldRow(overrides));
  }

  it("yield_claim confirms on an OUTPUT credit alone — it has no input leg", async () => {
    currentRow({ event_role: "yield_claim" });
    mockQueryOne.mockResolvedValueOnce(yieldRow({ event_role: "yield_claim", status: "confirmed" }));

    const res = await repo.confirmActivityEvent(1, { executedAmountOutRaw: "420000" });

    expect(res.applied).toBe(true);
  });

  it("yield_claim REFUSES an executed input leg — a claim spends nothing", async () => {
    currentRow({ event_role: "yield_claim" });
    await expect(
      repo.confirmActivityEvent(1, { executedAmountOutRaw: "1", executedAmountInRaw: "1" }),
    ).rejects.toThrow(/must not carry an executed input leg/);
  });

  it("yield_claim REFUSES a confirmation with no credit at all", async () => {
    currentRow({ event_role: "yield_claim" });
    await expect(repo.confirmActivityEvent(1, {})).rejects.toThrow(/requires executedAmountOutRaw/);
  });

  it.each(["yield_pt", "yield_yt"])("%s requires BOTH executed legs", async (role) => {
    currentRow({ event_role: role });
    await expect(repo.confirmActivityEvent(1, { executedAmountInRaw: "1" })).rejects.toThrow(
      /requires executedAmountInRaw \+ executedAmountOutRaw/,
    );
  });

  it("yield_py requires the SECOND leg whenever the row populated one", async () => {
    // A mint that proved its PT but not its YT is exactly the half-truth
    // Option C exists to prevent.
    currentRow({ event_role: "yield_py", token_out2_address: YT });
    await expect(
      repo.confirmActivityEvent(1, { executedAmountInRaw: "1", executedAmountOutRaw: "1" }),
    ).rejects.toThrow(/second OUTPUT leg.*executedAmountOut2Raw/);
  });

  it("yield_py requires the second INPUT leg on a redeem", async () => {
    currentRow({ event_role: "yield_py", token_in2_address: YT });
    await expect(
      repo.confirmActivityEvent(1, { executedAmountInRaw: "1", executedAmountOutRaw: "1" }),
    ).rejects.toThrow(/second INPUT leg.*executedAmountIn2Raw/);
  });

  it("yield_lp applies the dual invariant ONLY where the dual columns are populated", async () => {
    // Single-token add/remove is the shipped shape; demanding a second leg from
    // it would make the ordinary case unwritable.
    currentRow({ event_role: "yield_lp", token_in2_address: null, token_out2_address: null });
    mockQueryOne.mockResolvedValueOnce(yieldRow({ event_role: "yield_lp", status: "confirmed" }));

    const res = await repo.confirmActivityEvent(1, {
      executedAmountInRaw: "1",
      executedAmountOutRaw: "1",
    });

    expect(res.applied).toBe(true);
  });

  it("persists the executed SECOND-leg amounts in the SAME CAS update", async () => {
    currentRow({ event_role: "yield_py", token_out2_address: YT });
    mockQueryOne.mockResolvedValueOnce(yieldRow({ event_role: "yield_py", status: "confirmed" }));

    await repo.confirmActivityEvent(1, {
      executedAmountInRaw: "1000000",
      executedAmountOutRaw: "1",
      executedAmountOut2Raw: "2",
      executedAmountOut2Human: "0.000000000000000002",
    });

    const [sql, params] = mockQueryOne.mock.calls[1]!;
    expect(sql).toContain("executed_amount_out2_raw");
    expect(sql).toMatch(/WHERE id = \$1 AND status = 'pending'/);
    expect(params).toContain("2");
  });

  it("leaves the pre-existing 'swap' guard untouched", async () => {
    currentRow({ event_role: "swap", kind: "swap" });
    await expect(repo.confirmActivityEvent(1, {})).rejects.toThrow(/event_role 'swap' requires/);
  });
});

// ── 3. Hashless recovery covers every yield role ─────────────────────

describe("the five yield roles are reapable by the hashless-intent sweep", () => {
  it.each(["yield_pt", "yield_yt", "yield_py", "yield_lp", "yield_claim"])(
    "%s is in the locally-signable allowlist, so a crash before staging is recovered",
    async (role) => {
      // Every Pendle mutation is signed locally through ONE choke point, and no
      // Pendle-side sweep owns a hashless row (the EVM repair sweep requires
      // `submit_attempted_at IS NOT NULL`, which only staging sets). Without
      // this allowlist entry the row sits `pending` forever.
      mockQuery.mockResolvedValueOnce([]);
      await repo.recoverStaleHashlessIntents(15 * 60 * 1000, 50);

      const [sql, params] = mockQuery.mock.calls[0]!;
      expect(sql).toMatch(/tx_hash\s+IS\s+NULL/);
      expect(sql).toMatch(/status\s*=\s*'pending'/);
      const allowlist = params!.find((p) => Array.isArray(p)) as string[];
      expect(allowlist).toContain(role);
    },
  );

  it("still finds each yield row by its NONCE-bearing identity after recovery", async () => {
    // The recovered row is returned mapped, so the sweep's caller can report
    // exactly which never-signed attempt was abandoned.
    mockQuery.mockResolvedValueOnce([
      yieldRow({ id: 9, event_role: "yield_lp", status: "definitively_failed", failure_code: "unknown", nonce: 17 }),
    ]);

    const rows = await repo.recoverStaleHashlessIntents(15 * 60 * 1000, 50);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 9, eventRole: "yield_lp", status: "definitively_failed", nonce: 17 });
  });
});

// ── 4. The intent writer binds the second legs ───────────────────────

describe("createPendingActivityEvent binds the Option-C columns", () => {
  it("writes both second-leg families in one INSERT", async () => {
    mockQueryOne.mockResolvedValueOnce(yieldRow());

    await repo.createPendingActivityEvent({
      protocolExecutionId: 1,
      eventIndex: 0,
      eventRole: "yield_py",
      kind: "yield",
      protocol: "pendle",
      chainId: 8453,
      walletAddress: "0xwallet",
      sessionId: "s",
      tokenIn: { tokenAddress: PT, tokenDecimals: 18, amountRaw: "1", amountHuman: "0.000000000000000001" },
      tokenIn2: { tokenAddress: YT, tokenDecimals: 18, amountRaw: "1", amountHuman: "0.000000000000000001" },
    });

    const [sql, params] = mockQueryOne.mock.calls[0]!;
    expect(sql).toContain("token_in2_address");
    expect(sql).toContain("token_out2_address");
    expect(params).toContain(YT);
  });

  it("leaves every second-leg column NULL for a single-leg row", async () => {
    mockQueryOne.mockResolvedValueOnce(yieldRow());

    await repo.createPendingActivityEvent({
      protocolExecutionId: 1,
      eventIndex: 0,
      eventRole: "yield_pt",
      kind: "yield",
      protocol: "pendle",
      chainId: 8453,
      walletAddress: "0xwallet",
      sessionId: "s",
      tokenIn: { tokenAddress: PT, tokenDecimals: 18, amountRaw: "1", amountHuman: "1" },
    });

    // The last ten bind params are the two second-leg families; all NULL keeps
    // `agent_activity_second_leg_roles_only` satisfied for a non-py/lp role.
    const params = mockQueryOne.mock.calls[0]![1]!;
    expect(params.slice(-10).every((v) => v === null)).toBe(true);
  });
});

// ── 5. The PRE-BROADCAST failure writer binds them too ───────────────
//
// A refusal that happened before a signature is the one terminal state that may
// not know its second instrument (an unresolved market IS the refusal), so both
// shapes must be writable: the unresolved one without leg 2, and the resolved
// one WITH it. A writer that could only express the first would make every
// recorded PY refusal narrower than the truth it had.

describe("recordPreBroadcastFailure binds the Option-C columns", () => {
  const failureFields = {
    protocolExecutionId: 1,
    eventIndex: 0,
    eventRole: "yield_py",
    kind: "yield",
    protocol: "pendle",
    chainId: 8453,
    walletAddress: "0xwallet",
    sessionId: "s",
    failureCode: "route_not_found",
    failureReason: "market unresolved",
  } as const;

  it("writes an UNRESOLVED refusal with no second leg at all", async () => {
    mockQueryOne.mockResolvedValueOnce(
      yieldRow({ status: "definitively_failed", failure_code: "route_not_found" }),
    );

    const event = await repo.recordPreBroadcastFailure({
      ...failureFields,
      tokenOut: { tokenAddress: PT },
    });

    const [sql, params] = mockQueryOne.mock.calls[0]!;
    expect(sql).toContain("'definitively_failed'");
    // All ten second-leg binds are NULL — the row claims nothing it cannot name.
    expect(params!.slice(-12, -2).every((v) => v === null)).toBe(true);
    expect(event.status).toBe("definitively_failed");
    // The fixture row omits the column entirely, as an unset DB column reads.
    expect(event.tokenOut2Address ?? null).toBeNull();
  });

  it("writes a RESOLVED refusal carrying the second leg, and maps it back", async () => {
    mockQueryOne.mockResolvedValueOnce(
      yieldRow({
        status: "definitively_failed",
        failure_code: "route_not_found",
        token_out2_address: YT,
        token_out2_decimals: 18,
        amount_out2_raw: "1000000000000000000",
      }),
    );

    const event = await repo.recordPreBroadcastFailure({
      ...failureFields,
      tokenOut: { tokenAddress: PT, tokenDecimals: 18, amountRaw: "1", amountHuman: "0.000000000000000001" },
      tokenOut2: {
        tokenAddress: YT,
        tokenDecimals: 18,
        amountRaw: "1000000000000000000",
        amountHuman: "1",
      },
    });

    const [sql, params] = mockQueryOne.mock.calls[0]!;
    expect(sql).toContain("token_out2_address");
    expect(sql).toContain("token_out2_decimals");
    expect(params).toContain(YT);
    // The decimals travel with the raw amount — `agent_activity_second_leg_out_
    // amount_has_token` rejects the row otherwise.
    expect(params).toContain(18);
    expect(event).toMatchObject({
      status: "definitively_failed",
      tokenOut2Address: YT,
      tokenOut2Decimals: 18,
      amountOut2Raw: "1000000000000000000",
    });
  });
});
