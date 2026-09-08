/**
 * `launched_tokens` repo — the durable identity index (mocked pool).
 *
 * The property that matters here is IDEMPOTENCE, because two independent
 * writers converge on this table: the launch handler's own post-confirm write
 * and the crash-recovery identity repair. Either may run first, both may run,
 * and the repair may run many times. If `record` were not an upsert, the second
 * writer would throw on the unique identity index and a repair sweep would log
 * an error forever.
 *
 * Also pinned: `DO NOTHING` rather than `DO UPDATE` (the first writer to prove a
 * token exists wins — a later reconciler must not overwrite an on-chain fact it
 * is merely re-deriving), case-insensitive identity, and the rule-90 pairing of
 * a raw amount with its decimals.
 */

import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

type QueryOneMock = Mock<(sql: string, params?: unknown[]) => Promise<Record<string, unknown> | null>>;
type QueryMock = Mock<(sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>>;

let mockQueryOne: QueryOneMock;
let mockQuery: QueryMock;

function resetMocks(): void {
  mockQueryOne = vi.fn<(sql: string, params?: unknown[]) => Promise<Record<string, unknown> | null>>()
    .mockResolvedValue(null);
  mockQuery = vi.fn<(sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>>()
    .mockResolvedValue([]);
}
resetMocks();

vi.mock("@vex-agent/db/client.js", () => ({
  query: (sql: string, params?: unknown[]) => mockQuery(sql, params),
  queryOne: (sql: string, params?: unknown[]) => mockQueryOne(sql, params),
  execute: vi.fn(),
  withTransaction: vi.fn(),
}));

const repo = await import("@vex-agent/db/repos/launched-tokens.js");

beforeEach(() => resetMocks());

const WALLET = "0xAbCdEf1234567890abcdef1234567890AbCdEf12";
const TOKEN = "0x58659Ef9B4E4Fd0b0C0dE0b0c0de0B0c0De0b91A";
const TX = "0xfeed0000000000000000000000000000000000000000000000000000000beef";

function dbRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "1",
    wallet_address: WALLET,
    chain_id: "4663",
    launchpad: "trench_express",
    token_address: TOKEN,
    name: "Test Coin",
    symbol: "TEST",
    image_ref: "img_abc",
    create_tx_hash: TX,
    initial_buy_raw: null,
    initial_buy_decimals: null,
    initial_buy_token_address: null,
    session_id: null,
    protocol_execution_id: null,
    created_at: new Date("2026-08-02T10:00:00.000Z"),
    ...over,
  };
}

const INPUT = {
  walletAddress: WALLET,
  chainId: 4663,
  tokenAddress: TOKEN,
  name: "Test Coin",
  symbol: "TEST",
  launchpad: "pools_fun",
  createTxHash: TX,
};

describe("record — idempotent by construction", () => {
  it("inserts on the case-insensitive identity index with DO NOTHING", async () => {
    mockQueryOne.mockResolvedValue(dbRow());
    const result = await repo.record(INPUT);
    expect(result.inserted).toBe(true);
    const sql = firstCall(mockQueryOne).sql;
    expect(sql).toContain("ON CONFLICT (chain_id, LOWER(token_address)) DO NOTHING");
    // DO UPDATE would let a re-derivation overwrite the first proof of an
    // on-chain fact. The first writer wins, deliberately.
    expect(sql).not.toContain("DO UPDATE");
  });

  it("writes the launchpad the CALLER named, and cannot be given none", async () => {
    // It used to default to `trench_express` for callers that predated the
    // second venue. Migration 108 retired that venue and dropped both the
    // database DEFAULT and this one: chain 4663 carries more than one
    // launchpad, so a defaulted discriminator would file a launch under a
    // protocol nobody chose - and, since the retirement, under one that no
    // longer exists.
    mockQueryOne.mockResolvedValue(dbRow());
    await repo.record({ ...INPUT, launchpad: "pools_fun" });
    const params = mockQueryOne.mock.calls[0]?.[1];
    if (params === undefined) throw new Error("expected record to issue a query with params");
    expect(params[2]).toBe("pools_fun");
  });

  it("a CONFLICT reports inserted:false and returns the EXISTING row — not an error", async () => {
    // This is the repair sweep re-running after the handler already wrote the
    // row. It must be free, not a logged failure.
    mockQueryOne
      .mockResolvedValueOnce(null)                        // the INSERT conflicted
      .mockResolvedValueOnce(dbRow({ name: "Handler Wrote This" })); // the read-back
    const result = await repo.record(INPUT);
    expect(result.inserted).toBe(false);
    expect(result.row.name).toBe("Handler Wrote This");
  });

  it("throws when a CONFLICT fires but nothing can be read back", async () => {
    // The identity index and the lookup would then disagree about what identity
    // means. Reporting a launch as unsaved would be worse than a loud failure.
    mockQueryOne.mockResolvedValue(null);
    await expect(repo.record(INPUT)).rejects.toThrow(/no existing row could be read back/);
  });
});

describe("identity is case-insensitive", () => {
  it("getByIdentity matches on LOWER(token_address)", async () => {
    mockQueryOne.mockResolvedValue(dbRow());
    await repo.getByIdentity(4663, TOKEN.toLowerCase());
    const sql = firstCall(mockQueryOne).sql;
    expect(sql).toContain("LOWER(token_address) = LOWER($2)");
  });
});

describe("listForWallets — the trench.my_launches read path", () => {
  it("scopes to the server-resolved wallet set, lowercased, most recent first", async () => {
    mockQuery.mockResolvedValue([dbRow()]);
    await repo.listForWallets({ walletAddresses: [WALLET], chainId: 4663, limit: 25 });
    const [sql, params] = mockQuery.mock.calls[0]!;
    const flat = sql.replace(/\s+/g, " ");
    expect(flat).toContain("LOWER(wallet_address) = ANY($1::text[])");
    expect(flat).toContain("ORDER BY created_at DESC, id DESC");
    expect(params![0]).toEqual([WALLET.toLowerCase()]);
    expect(params![1]).toBe(4663);
    expect(params![2]).toBe(25);
  });

  it("omitting chainId binds no chain predicate and keeps LIMIT's index correct", async () => {
    mockQuery.mockResolvedValue([]);
    await repo.listForWallets({ walletAddresses: [WALLET], limit: 10 });
    const [sql, params] = mockQuery.mock.calls[0]!;
    expect(sql).not.toContain("chain_id =");
    expect(sql.replace(/\s+/g, " ")).toContain("LIMIT $2");
    expect(params).toEqual([[WALLET.toLowerCase()], 10]);
  });
});

/**
 * Launchpad confinement, pinned in the FAST suite as well.
 *
 * The behavioural proof lives in
 * `integration/repos/launched-tokens-launchpad-confinement.int.test.ts`, where a
 * real table holds both venues' rows - a mocked pool cannot prove a selection.
 * These assertions exist because that suite needs Docker: they keep the
 * predicate from being deleted unnoticed by anyone running only `pnpm test`.
 */
/**
 * The first query this repo call issued, with whitespace flattened.
 *
 * A throwing accessor rather than a non-null assertion: if the repo issued no
 * query at all, "no call" is the defect and it should be named, not turned into
 * an undefined-property crash three lines later.
 */
function firstCall(mock: QueryMock | QueryOneMock): { sql: string; params: readonly unknown[] } {
  const call = mock.mock.calls[0];
  if (call === undefined) throw new Error("expected the repo to issue a query, but none was made");
  return { sql: call[0].replace(/\s+/g, " "), params: call[1] ?? [] };
}

describe("launchpad confinement - chain_id stopped being a venue selector at 082", () => {
  it("claimAgentscanAttestCandidates selects by LAUNCHPAD and binds no chain at all", async () => {
    // Sharper than its twin: `attest_signature` is the TRENCH-formatted proof
    // over AgentScan's canonical message, so a pools row here would ship a
    // signature over the wrong bytes. Migration 102 dropped the chain parameter
    // instead - the AgentScan registry covers 4663 AND Base 8453, so a chain
    // predicate here would strand every launch on the other one.
    await repo.claimAgentscanAttestCandidates({ limit: 25, retryAfterSeconds: 600 });
    const { sql, params } = firstCall(mockQuery);
    expect(sql).toContain("launchpad = 'trench_express'");
    expect(sql).not.toContain("chain_id = $");
    expect(params).toEqual([25, "600"]);
  });

  it("every pools lane selector is confined to pools_fun", async () => {
    await repo.claimPoolsAttributionCandidates({ limit: 25, retryWindowSeconds: 600 });
    expect(firstCall(mockQuery).sql).toContain("launchpad = 'pools_fun'");

    resetMocks();
    await repo.countPoolsUnsignedAttributionGap();
    expect(firstCall(mockQueryOne).sql).toContain("launchpad = 'pools_fun'");

    resetMocks();
    await repo.stampPoolsAttestSignature({
      chainId: 4663,
      tokenAddress: TOKEN,
      attestSignature: "0xsig",
    });
    expect(firstCall(mockQueryOne).sql).toContain("launchpad = 'pools_fun'");
  });
});

describe("pools attribution lane - write-once and CAS shapes", () => {
  it("the stamp is write-once: it refuses a row that already has a signature", async () => {
    await repo.stampPoolsAttestSignature({
      chainId: 4663,
      tokenAddress: TOKEN,
      attestSignature: "0xsig",
    });
    const sql = firstCall(mockQueryOne).sql;
    expect(sql).toContain("pools_attest_signature IS NULL");
    // `null` from the pool means no row matched - already signed, or not pools.
    expect(await repo.stampPoolsAttestSignature({
      chainId: 4663,
      tokenAddress: TOKEN,
      attestSignature: "0xsig",
    })).toBe(false);
  });

  it("the claim excludes BOTH terminal states, not just success", async () => {
    // A definitively refused row must leave the candidate set for good; leaving
    // it in would re-serve a row whose answer can never change.
    await repo.claimPoolsAttributionCandidates({ limit: 25, retryWindowSeconds: 600 });
    const sql = firstCall(mockQuery).sql;
    expect(sql).toContain("pools_attributed_at IS NULL");
    expect(sql).toContain("pools_attribution_rejected_at IS NULL");
    expect(sql).toContain("pools_attest_signature IS NOT NULL");
    expect(sql).toContain("FOR UPDATE SKIP LOCKED");
    // Stamped in the SAME statement - otherwise a refused row starves the rest.
    expect(sql).toContain("SET pools_attribution_attempted_at = NOW()");
  });

  it("the claim binds limit and the retry window, and takes no chainId", async () => {
    await repo.claimPoolsAttributionCandidates({ limit: 7, retryWindowSeconds: 900 });
    expect(firstCall(mockQuery).params).toEqual([7, "900"]);
  });

  it("the claim maps the pools signature and the create tx hash the POST needs", async () => {
    mockQuery.mockResolvedValue([
      {
        id: "5",
        chain_id: "4663",
        token_address: TOKEN,
        pools_attest_signature: "0xpools",
        create_tx_hash: TX,
      },
    ]);
    const [candidate] = await repo.claimPoolsAttributionCandidates({
      limit: 25,
      retryWindowSeconds: 600,
    });
    expect(candidate).toEqual({
      id: 5,
      chainId: 4663,
      tokenAddress: TOKEN,
      attestSignature: "0xpools",
      createTxHash: TX,
    });
  });

  it("BOTH terminal writers CAS on BOTH terminal columns", async () => {
    // Not just on their own column: a late success must not overwrite a
    // recorded refusal, and a late refusal must not overwrite a landed badge.
    await repo.markPoolsAttributed({ id: 5 });
    const attributedSql = firstCall(mockQueryOne).sql;
    expect(attributedSql).toContain("pools_attributed_at IS NULL");
    expect(attributedSql).toContain("pools_attribution_rejected_at IS NULL");

    resetMocks();
    await repo.markPoolsAttributionRejected({ id: 5, code: "not_pools_launch" });
    const rejectedSql = firstCall(mockQueryOne).sql;
    expect(rejectedSql).toContain("pools_attributed_at IS NULL");
    expect(rejectedSql).toContain("pools_attribution_rejected_at IS NULL");
  });

  it("a rejection writes its reason in the SAME statement as the timestamp", async () => {
    // 087's CHECK makes the pair a database fact; writing them apart could not
    // even commit.
    await repo.markPoolsAttributionRejected({ id: 5, code: "invalid_signature" });
    const sql = firstCall(mockQueryOne).sql;
    expect(sql).toContain("pools_attribution_rejected_at = NOW()");
    expect(sql).toContain("pools_attribution_rejection_code = $2");
    expect(firstCall(mockQueryOne).params).toEqual([5, "invalid_signature"]);
  });

  it("a CAS that matched nothing reports false rather than throwing", async () => {
    expect(await repo.markPoolsAttributed({ id: 5 })).toBe(false);
    expect(await repo.markPoolsAttributionRejected({ id: 5, code: "validation_failed" })).toBe(false);
  });
});

describe("rule 90 — a raw amount travels with its decimals", () => {
  it("maps a recorded prebuy with both fields", async () => {
    mockQueryOne.mockResolvedValue(
      dbRow({ initial_buy_raw: "1000000000000000", initial_buy_decimals: 18, initial_buy_token_address: "0x0" }),
    );
    const row = await repo.getByIdentity(4663, TOKEN);
    expect(row?.initialBuyRaw).toBe("1000000000000000");
    expect(row?.initialBuyDecimals).toBe(18);
  });

  it("decimals of 0 survive — NOT NULL, never truthiness", async () => {
    mockQueryOne.mockResolvedValue(dbRow({ initial_buy_raw: "7", initial_buy_decimals: 0 }));
    const row = await repo.getByIdentity(4663, TOKEN);
    expect(row?.initialBuyDecimals).toBe(0);
  });

  it("BIGSERIAL id and BIGINT chain_id survive node-pg's string round trip", async () => {
    mockQueryOne.mockResolvedValue(dbRow());
    const row = await repo.getByIdentity(4663, TOKEN);
    expect(row?.id).toBe(1);
    expect(row?.chainId).toBe(4663);
  });
});
