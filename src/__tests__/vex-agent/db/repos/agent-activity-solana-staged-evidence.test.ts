/**
 * `markActivitySolanaBroadcast` evidence extension (`swap-lifecycle.ts`) +
 * `recoverStaleHashlessIntents` (`hashless-recovery.ts`) — W5 design
 * §2/R2/R2c, migration 049; mocked-pool unit tests mirroring
 * `agent-activity-abort-planned-events.test.ts`'s style.
 *
 * Pins:
 *   - `markActivitySolanaBroadcast` persists `recent_blockhash` +
 *     `last_valid_block_height` in the SAME atomic CAS UPDATE as the
 *     signature (never a second write) — required because 049's
 *     `agent_activity_solana_staged_has_evidence` CHECK enforces both NOT
 *     NULL together the moment `submit_attempted_at` is set;
 *   - the existing CAS predicate (`status='pending' AND tx_hash IS NULL AND
 *     chain_family='solana'`) is unchanged;
 *   - `recoverStaleHashlessIntents` targets `pending AND tx_hash IS NULL`
 *     rows older than the lease, bounded by `limit`, and returns every row
 *     it finalized (mapped);
 *   - C1 fix (Batch 4 closure, Codex-verified blocker): the recovery
 *     predicate is scoped to a POSITIVE allowlist of locally-signable event
 *     roles, so the logical `bridge_fill_expected` row (created pending +
 *     hashless BY DESIGN, `bridge-intent.ts`'s `createBridgeActivityIntent`)
 *     is never mistaken for an abandoned local signing attempt;
 *   - C7 fix (Batch 4 closure round 2): the recovery is now
 *     FAMILY-AGNOSTIC — the `chain_family='solana'` predicate is dropped
 *     entirely (an EVM hashless row is reaped identically to a Solana one)
 *     and the role allowlist gained the EVM-only `allowance`/
 *     `allowance_reset` plan roles; every logical/observed bridge row
 *     (`bridge_fill_expected`/`bridge_fill_observed`/`bridge_refund`) still
 *     survives regardless of which chain family it carries, because the
 *     allowlist — not `chain_family` — is now the sole discriminator.
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

function activityRow(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: 1,
    protocol_execution_id: 42,
    event_index: 0,
    event_role: "predict_buy",
    record_version: 1,
    kind: "prediction",
    protocol: "jupiter",
    chain_id: 20011000000,
    chain_slug: "solana",
    status: "pending",
    failure_code: null,
    failure_reason: null,
    token_in_address: null,
    token_in_symbol: null,
    token_in_decimals: null,
    amount_in_human: null,
    amount_in_raw: null,
    token_out_address: null,
    token_out_symbol: null,
    token_out_decimals: null,
    amount_out_human: null,
    amount_out_raw: null,
    executed_amount_in_human: null,
    executed_amount_in_raw: null,
    executed_amount_out_human: null,
    executed_amount_out_raw: null,
    usd_in_est: null,
    usd_out_est: null,
    usd_fee_est: null,
    usd_source: null,
    tx_hash: "5SoLSigBase58",
    from_address: "SoLFromAddr1111111111111111111111111111111",
    nonce: null,
    wallet_address: "SoLFromAddr1111111111111111111111111111111",
    session_id: "00000000-0000-4000-8000-000000000001",
    route_provenance: null,
    from_chain_id: null,
    from_chain_slug: null,
    to_chain_id: null,
    to_chain_slug: null,
    chain_family: "solana",
    provider_order_id: null,
    normalized_route: null,
    provider_status: null,
    evidence_source: null,
    observed_at: null,
    last_attempted_at: null,
    submit_attempted_at: "2026-07-24T10:00:00.000Z",
    recent_blockhash: "11111111111111111111111111111112",
    last_valid_block_height: 12345,
    broadcast_at: null,
    confirmed_at: null,
    last_checked_at: null,
    created_at: "2026-07-24T09:59:00.000Z",
    updated_at: "2026-07-24T10:00:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  resetMocks();
});

describe("markActivitySolanaBroadcast (evidence extension)", () => {
  it("persists tx_hash + recent_blockhash + last_valid_block_height in ONE atomic CAS UPDATE", async () => {
    mockQueryOne.mockResolvedValueOnce(activityRow());

    const result = await repo.markActivitySolanaBroadcast(1, {
      txHash: "5SoLSigBase58",
      fromAddress: "SoLFromAddr1111111111111111111111111111111",
      recentBlockhash: "11111111111111111111111111111112",
      lastValidBlockHeight: 12345,
    });

    expect(mockQueryOne).toHaveBeenCalledTimes(1);
    const [sql, params] = mockQueryOne.mock.calls[0]!;
    expect(sql).toContain("tx_hash = $2");
    expect(sql).toContain("recent_blockhash = $4");
    expect(sql).toContain("last_valid_block_height = $5");
    expect(sql).toMatch(/status\s*=\s*'pending'/);
    expect(sql).toMatch(/tx_hash\s+IS\s+NULL/);
    expect(sql).toMatch(/chain_family\s*=\s*'solana'/);
    expect(params).toEqual([1, "5SoLSigBase58", "SoLFromAddr1111111111111111111111111111111", "11111111111111111111111111111112", 12345]);

    expect(result.applied).toBe(true);
    expect(result.row.recentBlockhash).toBe("11111111111111111111111111111112");
    expect(result.row.lastValidBlockHeight).toBe(12345);
  });

  it("CAS miss (already staged) returns applied:false with the current row", async () => {
    mockQueryOne
      .mockResolvedValueOnce(null) // the UPDATE ... RETURNING misses
      .mockResolvedValueOnce(activityRow({ tx_hash: "already-staged-sig" })); // getCurrentRowOrThrow read

    const result = await repo.markActivitySolanaBroadcast(1, {
      txHash: "new-attempt-sig",
      fromAddress: "SoLFromAddr1111111111111111111111111111111",
      recentBlockhash: "11111111111111111111111111111112",
      lastValidBlockHeight: 12345,
    });

    expect(result.applied).toBe(false);
    expect(result.row.txHash).toBe("already-staged-sig");
  });
});

describe("recoverStaleHashlessIntents", () => {
  it("targets pending, hashless rows older than the lease, bounded by limit — NO chain_family predicate (C7)", async () => {
    mockQuery.mockResolvedValueOnce([]);

    await repo.recoverStaleHashlessIntents(15 * 60 * 1000, 50);

    const [sql, params] = mockQuery.mock.calls[0]!;
    expect(sql).toMatch(/status\s*=\s*'pending'/);
    expect(sql).toMatch(/tx_hash\s+IS\s+NULL/);
    // C7: the family predicate is DROPPED — an EVM row qualifies exactly
    // like a Solana row, discriminated only by event_role + age below.
    expect(sql).not.toMatch(/chain_family/);
    expect(sql).toContain("SET status = 'definitively_failed'");
    expect(sql).toContain("failure_code = 'unknown'");
    expect(sql).toContain("created_at < NOW() - make_interval(secs => $2::float8)");
    expect(sql).toContain("LIMIT $3");
    expect(params).toHaveLength(4); // reason, lease-seconds, limit, allowlist — no 5th family param
    expect(params![1]).toBe(900); // leaseMs / 1000
    expect(params![2]).toBe(50);
  });

  // "EVM row younger than lease survives" (card ask): there is exactly ONE
  // age predicate in the query, unconditional and not branched by family —
  // the same clause that already protected a too-young Solana row protects a
  // too-young EVM row identically, because nothing in this query's WHERE
  // clause can distinguish the two families anymore (C7 dropped the only
  // family predicate that could have done so).
  it("excludes a too-young row via ONE unconditional age predicate — no per-family branch (EVM survives exactly like Solana)", async () => {
    mockQuery.mockResolvedValueOnce([]);

    await repo.recoverStaleHashlessIntents(repo.HASHLESS_INTENT_RECOVERY_LEASE_MS, 25);

    const [sql] = mockQuery.mock.calls[0]!;
    const ageClauseCount = (sql.match(/created_at\s*<\s*NOW\(\)/g) ?? []).length;
    expect(ageClauseCount).toBe(1);
    expect(sql).not.toMatch(/chain_family/);
  });

  it("reaps and maps an EVM-family row identically to a Solana one (no JS-level family filtering)", async () => {
    mockQuery.mockResolvedValueOnce([
      activityRow({
        id: 9,
        status: "definitively_failed",
        failure_code: "unknown",
        event_role: "allowance",
        chain_family: "eip155",
        chain_id: 1,
        chain_slug: "ethereum",
        tx_hash: null,
        submit_attempted_at: null,
        recent_blockhash: null,
        last_valid_block_height: null,
      }),
    ]);

    const rows = await repo.recoverStaleHashlessIntents(repo.HASHLESS_INTENT_RECOVERY_LEASE_MS, 25);

    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(9);
    expect(rows[0]!.chainFamily).toBe("eip155");
    expect(rows[0]!.status).toBe("definitively_failed");
    expect(rows[0]!.failureCode).toBe("unknown");
  });

  it("returns every finalized row, mapped", async () => {
    mockQuery.mockResolvedValueOnce([activityRow({ id: 7, status: "definitively_failed", failure_code: "unknown", tx_hash: null, submit_attempted_at: null, recent_blockhash: null, last_valid_block_height: null })]);

    const rows = await repo.recoverStaleHashlessIntents(repo.HASHLESS_INTENT_RECOVERY_LEASE_MS, 25);

    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(7);
    expect(rows[0]!.status).toBe("definitively_failed");
    expect(rows[0]!.failureCode).toBe("unknown");
  });

  it("returns [] (never throws) when nothing qualifies", async () => {
    mockQuery.mockResolvedValueOnce([]);
    await expect(
      repo.recoverStaleHashlessIntents(repo.HASHLESS_INTENT_RECOVERY_LEASE_MS, 25),
    ).resolves.toEqual([]);
  });

  // C1/C7 regression (Codex-verified blocker, now family-generalized): an
  // expired-lease LOGICAL bridge fill (`bridge_fill_expected` — pending +
  // hashless BY DESIGN, never locally signed) must survive this recovery
  // sweep untouched, REGARDLESS of which chain family it carries — the
  // predicate no longer filters by chain_family at all (C7), so the
  // allowlist is now the SOLE discriminator protecting it on either chain.
  it("scopes the recovery predicate to an allowlist that excludes bridge_fill_expected on EITHER chain family (the expired-lease logical fill survives untouched)", async () => {
    mockQuery.mockResolvedValueOnce([]);

    await repo.recoverStaleHashlessIntents(repo.HASHLESS_INTENT_RECOVERY_LEASE_MS, 25);

    const [sql, params] = mockQuery.mock.calls[0]!;
    expect(sql).toContain("event_role = ANY($4::text[])");

    const allowedRoles = params![3] as string[];
    expect(allowedRoles).not.toContain("bridge_fill_expected");
    expect(allowedRoles).not.toContain("bridge_fill_observed");
    expect(allowedRoles).not.toContain("bridge_refund");
    // bridge_deposit IS allowlisted (Codex batch-4 turn-2 blocker 1): it is
    // locally signed and hashless before staging on EITHER chain, and no
    // bridge-side sweep owns its stale-hashless recovery — this sweep does.
    expect(allowedRoles).toContain("bridge_deposit");
    // C7: the EVM-only allowance-plan roles are now allowlisted too — the
    // ONLY reason they were absent before (Solana has no allowance legs)
    // stops applying once the sweep covers EVM rows.
    expect(allowedRoles).toContain("allowance");
    expect(allowedRoles).toContain("allowance_reset");
    // `bridge_fee` (migration 050) IS allowlisted: it is the FINAL Vex-SIGNED
    // origin leg (`bridge-fee/constants.ts`'s BRIDGE_FEE_ACTIVITY_EVENT_ROLE),
    // recorded as `allowance` before 050 and therefore already reapable here —
    // giving it its own role must not quietly drop that recovery, or a fee leg
    // planned-but-never-signed pins the session's bridge in-flight slot open.
    expect(allowedRoles).toContain("bridge_fee");
    expect(allowedRoles.slice().sort()).toEqual(
      [
        "allowance",
        "allowance_reset",
        "bridge_deposit",
        "bridge_fee",
        "lend_borrow_operate",
        "lend_deposit",
        "lend_withdraw",
        "predict_buy",
        "predict_claim",
        "predict_close",
        "predict_sell",
        "swap",
        // Migration 053 (Pendle). EVM-only, locally signed through ONE choke
        // point, and owned by no Pendle-side sweep — so a row abandoned between
        // intent creation and staging is reapable here or nowhere.
        "yield_pt",
        "yield_yt",
        "yield_py",
        "yield_lp",
        "yield_sy",
        "yield_claim",
        // Migration 062 (Trench launch) and 063 (the Trench Vex fee). Both are
        // EVM-only, both are signed locally, and neither is owned by a sweep
        // that could reap a hashless row — `trench_fee` for exactly the reason
        // `bridge_fee` above is here: it is the FINAL Vex-signed leg, so one
        // planned but never signed is definitively not-attempted.
        "token_launch",
        "trench_fee",
        // Migration 066 (the Uniswap Vex fee). Same leg again on a swap venue
        // whose router takes no fee parameter: EVM-only, locally signed, owned
        // by no sweep, and definitively not-attempted when it is never signed.
        "swap_fee",
        // Migration 079 (the pools.fun Vex fee). The same leg once more, on a
        // launchpad with no Solana deployment: EVM-only, locally signed, owned
        // by no sweep, and definitively not-attempted when it is never signed.
        // `pools_claim` is deliberately ABSENT - a claim is the primary
        // transaction of its own execution, not a dependent leg.
        "pools_fee",
      ].sort(),
    );
  });

  // "allowlist pinned per family semantics" (card ask): each role's family
  // scope is pinned explicitly, not just the flat set above — an EVM-only
  // role, a Solana-only role, and a role shared by both families all behave
  // the same way (allowlisted), which is exactly the point of dropping the
  // chain_family predicate: the ROLE decides eligibility, never the family.
  it("pins allowlist membership per role's real family scope (EVM-only, Solana-only, and shared roles all included)", async () => {
    mockQuery.mockResolvedValueOnce([]);

    await repo.recoverStaleHashlessIntents(repo.HASHLESS_INTENT_RECOVERY_LEASE_MS, 25);

    const [, params] = mockQuery.mock.calls[0]!;
    const allowedRoles = params![3] as string[];

    // Pendle is EVM-only, so its six roles join the EVM-only column.
    const evmOnlyRoles = [
      "allowance", "allowance_reset",
      "yield_pt", "yield_yt", "yield_py", "yield_lp", "yield_sy", "yield_claim",
      // Trench Express is chain 4663 only — the launch and its Vex fee leg are
      // EVM-only by construction.
      "token_launch", "trench_fee",
      // Uniswap has no Solana deployment — its fee leg is EVM-only too.
      "swap_fee",
      // pools.fun is Robinhood Chain (4663) only, so its fee leg is EVM-only.
      "pools_fee",
    ];
    const solanaOnlyRoles = ["lend_deposit", "lend_withdraw", "lend_borrow_operate", "predict_buy", "predict_sell", "predict_claim", "predict_close"];
    // `bridge_fee` (migration 050) is SHARED, not bridge-EVM-only: the Vex fee
    // leg is planned for either origin family — `khalani/bridge-executor.ts`'s
    // `planVexFeeLeg` returns `family: "solana"` (a `solana_fee` descriptor,
    // built by `bridge-fee/solana-fee-transfer.ts`) or `family: "eip155"`, and
    // `khalani/handlers/bridge-execute.ts` picks the receiver with
    // `fromFamily === "solana" ? BRIDGE_FEE_RECEIVER_SOLANA : ..._EVM`.
    const sharedRoles = ["swap", "bridge_deposit", "bridge_fee"];

    for (const role of [...evmOnlyRoles, ...solanaOnlyRoles, ...sharedRoles]) {
      expect(allowedRoles).toContain(role);
    }
    expect(allowedRoles).toHaveLength(evmOnlyRoles.length + solanaOnlyRoles.length + sharedRoles.length);
  });
});
