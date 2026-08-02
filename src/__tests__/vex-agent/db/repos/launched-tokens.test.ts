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
  createTxHash: TX,
};

describe("record — idempotent by construction", () => {
  it("inserts on the case-insensitive identity index with DO NOTHING", async () => {
    mockQueryOne.mockResolvedValue(dbRow());
    const result = await repo.record(INPUT);
    expect(result.inserted).toBe(true);
    const sql = mockQueryOne.mock.calls[0]![0].replace(/\s+/g, " ");
    expect(sql).toContain("ON CONFLICT (chain_id, LOWER(token_address)) DO NOTHING");
    // DO UPDATE would let a re-derivation overwrite the first proof of an
    // on-chain fact. The first writer wins, deliberately.
    expect(sql).not.toContain("DO UPDATE");
  });

  it("defaults the launchpad rather than leaving it implicit", async () => {
    mockQueryOne.mockResolvedValue(dbRow());
    await repo.record(INPUT);
    expect(mockQueryOne.mock.calls[0]![1]![2]).toBe("trench_express");
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
    const sql = mockQueryOne.mock.calls[0]![0].replace(/\s+/g, " ");
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
