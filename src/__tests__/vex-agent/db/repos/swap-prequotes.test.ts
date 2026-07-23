/**
 * swap-prequotes repo — Stage 6c unit tests (mocked pool).
 *
 * Pins:
 *   - INSERT shape (16 params order matches migration 029 columns)
 *   - safety_detail / route_ref bound via jsonb()::jsonb
 *   - findLatestFreshByMatch predicate: session_id AND match_hash AND kind AND
 *     expires_at > NOW() AND consumed_at IS NULL ORDER BY created_at DESC
 *     LIMIT 1 (cross-session + expired + consumed + cross-kind rows miss)
 *   - consumeIfUnconsumed CAS: session-scoped, only unconsumed rows
 *   - existsFreshFailByMatch predicate: session_id AND match_hash AND kind AND
 *     safety_verdict='fail' AND expires_at > NOW() LIMIT 1 (boolean) — Stage 7
 *   - TIMESTAMPTZ Date → ISO normalisation; BIGINT chain_id string → number
 */

import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

type PoolQueryOneMock = Mock<
  (sql: string, params?: unknown[]) => Promise<Record<string, unknown> | null>
>;
type PoolExecuteMock = Mock<(sql: string, params?: unknown[]) => Promise<number>>;

let mockQueryOne: PoolQueryOneMock;
let mockExecute: PoolExecuteMock;

function resetMocks() {
  mockQueryOne = vi
    .fn<(sql: string, params?: unknown[]) => Promise<Record<string, unknown> | null>>()
    .mockResolvedValue(null);
  mockExecute = vi
    .fn<(sql: string, params?: unknown[]) => Promise<number>>()
    .mockResolvedValue(1);
}
resetMocks();

vi.mock("@vex-agent/db/client.js", () => ({
  query: vi.fn(),
  queryOne: (sql: string, params?: unknown[]) => mockQueryOne(sql, params),
  execute: (sql: string, params?: unknown[]) => mockExecute(sql, params),
  queryWith: vi.fn(),
  queryOneWith: vi.fn(),
  executeWith: vi.fn(),
}));

const repo = await import("@vex-agent/db/repos/swap-prequotes.js");

beforeEach(() => {
  resetMocks();
});

// ── Fixtures ────────────────────────────────────────────────────────────

const PREQUOTE_ID = "prequote-test-001";
const SESSION_ID = "00000000-0000-4000-8000-000000000001";
const MATCH_HASH = "a".repeat(64);
const WALLET_ADDR = "0xabcdef1234567890abcdef1234567890abcdef12";
const EXPIRES_AT = "2026-06-04T10:15:00.000Z";
const CREATED_AT = "2026-06-04T10:00:00.000Z";

function fullRow(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    prequote_id: PREQUOTE_ID,
    session_id: SESSION_ID,
    match_hash: MATCH_HASH,
    kind: "swap",
    family: "eip155",
    provider: "kyberswap",
    chain_id: "8453", // BIGINT comes back as string from node-postgres
    wallet_address: WALLET_ADDR,
    token_in: "0xAAA",
    token_out: "0xBBB",
    amount: "1.5",
    slippage_bps: 50,
    safety_verdict: "pass",
    safety_detail: { tokenIn: { native: true }, tokenOut: { isHoneypot: false, isFOT: false, tax: 0 } },
    route_ref: null,
    created_at: CREATED_AT,
    expires_at: EXPIRES_AT,
    consumed_at: null,
    ...overrides,
  };
}

function buildCreateInput(
  overrides: Partial<repo.CreatePrequoteInput> = {},
): repo.CreatePrequoteInput {
  return {
    prequoteId: PREQUOTE_ID,
    sessionId: SESSION_ID,
    matchHash: MATCH_HASH,
    kind: "swap",
    family: "eip155",
    provider: "kyberswap",
    chainId: 8453,
    walletAddress: WALLET_ADDR,
    tokenIn: "0xAAA",
    tokenOut: "0xBBB",
    amount: "1.5",
    slippageBps: 50,
    safetyVerdict: "pass",
    safetyDetail: { tokenIn: { native: true }, tokenOut: { isHoneypot: false, isFOT: false, tax: 0 } },
    routeRef: null,
    expiresAt: EXPIRES_AT,
    ...overrides,
  };
}

// ── create ──────────────────────────────────────────────────────────────

describe("create", () => {
  it("INSERTs 16 columns in declared order matching migration 029", async () => {
    await repo.create(buildCreateInput());
    expect(mockExecute).toHaveBeenCalledTimes(1);
    const [sql, params] = mockExecute.mock.calls[0]!;
    expect(sql).toContain("INSERT INTO swap_prequotes");
    expect(sql).toContain(
      "prequote_id, session_id, match_hash, kind, family, provider,\n  chain_id, wallet_address, token_in, token_out, amount, slippage_bps,\n  safety_verdict, safety_detail, route_ref, expires_at",
    );
    expect(sql).toContain("$14::jsonb, $15::jsonb");
    expect(params).toEqual([
      PREQUOTE_ID,
      SESSION_ID,
      MATCH_HASH,
      "swap",
      "eip155",
      "kyberswap",
      8453,
      WALLET_ADDR,
      "0xAAA",
      "0xBBB",
      "1.5",
      50,
      "pass",
      expect.stringContaining("native"), // JSON-serialised safety_detail
      null, // route_ref null
      EXPIRES_AT,
    ]);
  });

  it("serialises route_ref via jsonb when present", async () => {
    await repo.create(buildCreateInput({ routeRef: { routerAddress: "0xROUTER" } }));
    const [, params] = mockExecute.mock.calls[0]!;
    expect(params![14]).toEqual(expect.stringContaining("routerAddress"));
  });

  it("preserves null chain_id + null slippage for Solana", async () => {
    await repo.create(
      buildCreateInput({ family: "solana", provider: "jupiter", chainId: null, slippageBps: null }),
    );
    const [, params] = mockExecute.mock.calls[0]!;
    expect(params![4]).toBe("solana");
    expect(params![6]).toBeNull(); // chain_id
    expect(params![11]).toBeNull(); // slippage_bps
  });
});

// ── findLatestFreshByMatch ──────────────────────────────────────────────

describe("findLatestFreshByMatch", () => {
  it("SELECTs newest fresh unconsumed row (session + match + kind + expires + not consumed)", async () => {
    mockQueryOne.mockResolvedValueOnce(null);
    await repo.findLatestFreshByMatch(SESSION_ID, MATCH_HASH, "swap");
    const [sql, params] = mockQueryOne.mock.calls[0]!;
    expect(sql).toContain("FROM swap_prequotes");
    expect(sql).toContain("WHERE session_id = $1");
    expect(sql).toContain("AND match_hash = $2");
    expect(sql).toContain("AND kind = $3");
    expect(sql).toContain("AND expires_at > NOW()");
    expect(sql).toContain("AND consumed_at IS NULL");
    expect(sql).toContain("ORDER BY created_at DESC");
    expect(sql).toContain("LIMIT 1");
    expect(params).toEqual([SESSION_ID, MATCH_HASH, "swap"]);
  });

  it("returns null when no fresh row matches (expired OR cross-session OR cross-kind miss)", async () => {
    // The DB enforces freshness + session + kind scope in the predicate; a miss
    // returns null here. 'expired', 'other-session', and 'other-kind' all
    // surface as the same null (the bridge-kind isolation test relies on this).
    mockQueryOne.mockResolvedValueOnce(null);
    const result = await repo.findLatestFreshByMatch(SESSION_ID, MATCH_HASH, "swap");
    expect(result).toBeNull();
  });

  it("maps a full row, normalising BIGINT chain_id (string) → number", async () => {
    mockQueryOne.mockResolvedValueOnce(fullRow());
    const row = await repo.findLatestFreshByMatch(SESSION_ID, MATCH_HASH, "swap");
    expect(row).toEqual({
      prequoteId: PREQUOTE_ID,
      sessionId: SESSION_ID,
      matchHash: MATCH_HASH,
      kind: "swap",
      family: "eip155",
      provider: "kyberswap",
      chainId: 8453,
      walletAddress: WALLET_ADDR,
      tokenIn: "0xAAA",
      tokenOut: "0xBBB",
      amount: "1.5",
      slippageBps: 50,
      safetyVerdict: "pass",
      safetyDetail: { tokenIn: { native: true }, tokenOut: { isHoneypot: false, isFOT: false, tax: 0 } },
      routeRef: null,
      createdAt: CREATED_AT,
      expiresAt: EXPIRES_AT,
      consumedAt: null,
    });
  });

  it("normalises null chain_id (Solana) and Date timestamps to ISO", async () => {
    mockQueryOne.mockResolvedValueOnce(
      fullRow({
        family: "solana",
        provider: "jupiter",
        chain_id: null,
        slippage_bps: null,
        created_at: new Date("2026-06-04T10:00:00.000Z"),
        expires_at: new Date("2026-06-04T10:15:00.000Z"),
      }),
    );
    const row = await repo.findLatestFreshByMatch(SESSION_ID, MATCH_HASH, "swap");
    expect(row?.chainId).toBeNull();
    expect(row?.slippageBps).toBeNull();
    expect(row?.createdAt).toBe("2026-06-04T10:00:00.000Z");
    expect(row?.expiresAt).toBe("2026-06-04T10:15:00.000Z");
    expect(typeof row?.createdAt).toBe("string");
  });

  it("passes the kind through to the predicate (bridge isolation)", async () => {
    mockQueryOne.mockResolvedValueOnce(null);
    await repo.findLatestFreshByMatch(SESSION_ID, MATCH_HASH, "bridge");
    const [, params] = mockQueryOne.mock.calls[0]!;
    expect(params).toEqual([SESSION_ID, MATCH_HASH, "bridge"]);
  });
});

// ── existsFreshFailByMatch (Stage 7) ────────────────────────────────────

describe("existsFreshFailByMatch", () => {
  it("SELECTs 1 with session_id + match_hash + kind + safety_verdict='fail' + freshness", async () => {
    mockQueryOne.mockResolvedValueOnce(null);
    await repo.existsFreshFailByMatch(SESSION_ID, MATCH_HASH, "swap");
    const [sql, params] = mockQueryOne.mock.calls[0]!;
    expect(sql).toContain("SELECT 1 FROM swap_prequotes");
    expect(sql).toContain("WHERE session_id = $1");
    expect(sql).toContain("AND match_hash = $2");
    expect(sql).toContain("AND kind = $3");
    expect(sql).toContain("AND safety_verdict = 'fail'");
    expect(sql).toContain("AND expires_at > NOW()");
    expect(sql).toContain("LIMIT 1");
    expect(params).toEqual([SESSION_ID, MATCH_HASH, "swap"]);
  });

  it("returns true when a fresh fail row exists", async () => {
    mockQueryOne.mockResolvedValueOnce({ "?column?": 1 });
    expect(await repo.existsFreshFailByMatch(SESSION_ID, MATCH_HASH, "swap")).toBe(true);
  });

  it("returns false when no fresh fail row exists (expired / other-session / other-kind miss)", async () => {
    // The DB predicate enforces freshness + session + kind + verdict='fail'; any
    // of expired, cross-session, or cross-kind surfaces as the same null → false.
    mockQueryOne.mockResolvedValueOnce(null);
    expect(await repo.existsFreshFailByMatch(SESSION_ID, MATCH_HASH, "swap")).toBe(false);
  });
});

// ── consumeIfUnconsumed (single-use ticket) ─────────────────────────────

describe("consumeIfUnconsumed", () => {
  it("CAS-updates only the owning session's unconsumed row", async () => {
    mockExecute.mockResolvedValueOnce(1);
    const won = await repo.consumeIfUnconsumed(PREQUOTE_ID, SESSION_ID);
    expect(won).toBe(true);
    const [sql, params] = mockExecute.mock.calls[0]!;
    expect(sql).toContain("UPDATE swap_prequotes");
    expect(sql).toContain("SET consumed_at = NOW()");
    expect(sql).toContain("WHERE prequote_id = $1");
    expect(sql).toContain("AND session_id = $2");
    expect(sql).toContain("AND consumed_at IS NULL");
    expect(params).toEqual([PREQUOTE_ID, SESSION_ID]);
  });

  it("returns false when another caller already consumed (or wrong session)", async () => {
    mockExecute.mockResolvedValueOnce(0);
    expect(await repo.consumeIfUnconsumed(PREQUOTE_ID, SESSION_ID)).toBe(false);
  });

  it("maps consumed_at on findLatestFreshByMatch when present", async () => {
    mockQueryOne.mockResolvedValueOnce(
      fullRow({ consumed_at: "2026-06-04T10:05:00.000Z" }),
    );
    // Note: the SQL predicate excludes consumed rows; this only pins mapRow.
    const row = await repo.findLatestFreshByMatch(SESSION_ID, MATCH_HASH, "swap");
    expect(row?.consumedAt).toBe("2026-06-04T10:05:00.000Z");
  });
});
