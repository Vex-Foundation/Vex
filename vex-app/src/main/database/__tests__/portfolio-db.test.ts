/**
 * portfolio-db tests — server-side address resolution + dual-scope
 * aggregation, with NO real DB.
 *
 * Mirrors usage-db.test.ts (mocked `pg` Client + `db-config` + logger).
 * Additionally mocks the two server-side address sources:
 *  - `@vex-lib/wallet.js` `listWallets` (global inventory), and
 *  - `../sessions-db.js` `getSessionWalletScope` (session scope).
 *
 * Security invariants under test:
 *  - empty allow-list (no wallets / empty session scope) → empty DTO,
 *    and NO SQL is ever issued (fail closed BEFORE query);
 *  - every SELECT binds `wallet_address = ANY($1::text[])` with the
 *    resolved address array (never a renderer-supplied address);
 *  - CROSS-SESSION ISOLATION: a session scoped to wallet A binds ONLY
 *    wallet A's address — wallet B's address never appears in any param;
 *  - NUMERIC/float8 coercion + null-snapshot fallback;
 *  - a failed session-scope read propagates (fail closed).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SOLANA_NATIVE_PERSISTED_ADDRESS } from "@tools/solana-ecosystem/shared/solana-asset-identity.js";

type QueryFn = (
  text: string,
  params?: readonly unknown[],
) => Promise<{ rows: ReadonlyArray<Record<string, unknown>> }>;

const mocks = vi.hoisted(() => ({
  query: vi.fn() as ReturnType<typeof vi.fn> & QueryFn,
  connect: vi.fn(),
  end: vi.fn(),
  buildPoolConfig: vi.fn(),
  listWallets: vi.fn(),
  getSessionWalletScope: vi.fn(),
  readProjectPortfolioScope: vi.fn(),
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

vi.mock("@vex-lib/wallet.js", () => ({
  listWallets: mocks.listWallets,
}));

vi.mock("../sessions-db.js", () => ({
  getSessionWalletScope: mocks.getSessionWalletScope,
}));

// Mocked as its own module, exactly like the session arm's resolver: the
// project scope must NOT consume one of the four scripted portfolio queries,
// or every test that also exercises the project path would desync.
vi.mock("../projects/portfolio-scope.js", () => ({
  readProjectPortfolioScope: mocks.readProjectPortfolioScope,
}));

vi.mock("../../logger/index.js", () => ({ log: mocks.log }));

const { getPortfolio } = await import("../portfolio-db.js");

const SESSION = "00000000-0000-4000-8000-00000000aaaa";
const WALLET_A = "0xAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaa";
const WALLET_B = "0xBBBBbbbbBBBBbbbbBBBBbbbbBBBBbbbbBBBBbbbb";
const SOL_ADDR = "So11111111111111111111111111111111111111112";
const SOLANA_CHAIN_ID = 20_011_000_000;

function scopeOk(evmAddr: string | null, solAddr: string | null) {
  return {
    ok: true as const,
    data: {
      evm: evmAddr ? { id: "evm_1", address: evmAddr } : null,
      solana: solAddr ? { id: "sol_1", address: solAddr } : null,
    },
  };
}

/** All bound params across every issued query call, flattened. */
function allBoundParams(): unknown[] {
  return mocks.query.mock.calls.flatMap((call) => {
    const params = call[1];
    return Array.isArray(params) ? params.flat() : [];
  });
}

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

/**
 * Script the four queries (live total, token lines, per-chain breakdown,
 * snapshot) in order. The portfolio-db issues exactly these four when the
 * allow-list is non-empty.
 */
function scriptPortfolioQueries(opts: {
  live: unknown;
  tokens: ReadonlyArray<Record<string, unknown>>;
  snapshot: Record<string, unknown> | null;
  /** Optional older complete-cycle group — drives PnL = latest.total − prev.total. */
  previousSnapshot?: Record<string, unknown> | null;
  /** Flat breakdown rows (chain totals repeated per top-token line). */
  breakdown?: ReadonlyArray<Record<string, unknown>>;
}): void {
  const snapshotRows = [opts.snapshot, opts.previousSnapshot ?? null].filter(
    (r): r is Record<string, unknown> => r != null,
  );
  mocks.query
    .mockResolvedValueOnce({ rows: [{ live: opts.live }] })
    .mockResolvedValueOnce({ rows: opts.tokens })
    .mockResolvedValueOnce({ rows: opts.breakdown ?? [] })
    .mockResolvedValueOnce({ rows: snapshotRows });
}

describe("portfolio-db getPortfolio - global scope", () => {
  it("returns the empty DTO and issues NO SQL when the inventory is empty", async () => {
    mocks.listWallets.mockReturnValue([]);
    const result = await getPortfolio({ scope: "global" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual({
      scope: "global",
      walletCount: 0,
      liveTotalUsd: 0,
      snapshotTotalUsd: null,
      pnlVsPrev: null,
      snapshotAt: null,
      tokens: [],
      chains: [],
    });
    expect(mocks.query).not.toHaveBeenCalled();
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it("aggregates inventory addresses and binds them into every ANY($1) filter", async () => {
    // evm family returns A + B; solana family returns the sol address.
    mocks.listWallets.mockImplementation((family: string) =>
      family === "evm"
        ? [
            { id: "1", address: WALLET_A, label: "", createdAt: "" },
            { id: "2", address: WALLET_B, label: "", createdAt: "" },
          ]
        : [{ id: "3", address: SOL_ADDR, label: "", createdAt: "" }],
    );
    scriptPortfolioQueries({
      live: "1234.5",
      tokens: [
        { chain_id: "1", token_symbol: "ETH", usd: "1000" },
        { chain_id: "137", token_symbol: "USDC", usd: "234.5" },
      ],
      snapshot: {
        snapshot_group_id: "grp",
        total: "1200",
        at: "2026-05-21T10:00:00.000Z",
      },
      // PnL is latest.total − previous.total = 1200 − 1165.5 = 34.5.
      previousSnapshot: {
        snapshot_group_id: "grp0",
        total: "1165.5",
        at: "2026-05-20T10:00:00.000Z",
      },
    });

    const result = await getPortfolio({ scope: "global" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.scope).toBe("global");
    expect(result.data.walletCount).toBe(3);
    expect(result.data.liveTotalUsd).toBeCloseTo(1234.5, 4);
    expect(result.data.snapshotTotalUsd).toBeCloseTo(1200, 4);
    expect(result.data.pnlVsPrev).toBeCloseTo(34.5, 4);
    expect(result.data.snapshotAt).toBe("2026-05-21T10:00:00.000Z");
    expect(result.data.tokens).toEqual([
      { chainId: 1, symbol: "ETH", tokenName: null, balanceUsd: 1000, amount: null },
      { chainId: 137, symbol: "USDC", tokenName: null, balanceUsd: 234.5, amount: null },
    ]);

    // Every SELECT (live + tokens + breakdown + snapshot) carries the
    // address array as $1.
    const addressParams = mocks.query.mock.calls.map((c) => {
      const p = c[1];
      return Array.isArray(p) ? p[0] : undefined;
    });
    expect(addressParams).toHaveLength(4);
    for (const p of addressParams) {
      expect(p).toEqual([WALLET_A, WALLET_B, SOL_ADDR]);
    }
    // Snapshot completeness param is the address count.
    const snapshotCall = mocks.query.mock.calls[3];
    expect(snapshotCall?.[1]?.[1]).toBe(3);
  });

  it("does NOT lowercase addresses (raw join key preserved)", async () => {
    mocks.listWallets.mockImplementation((family: string) =>
      family === "evm" ? [{ id: "1", address: WALLET_A, label: "", createdAt: "" }] : [],
    );
    scriptPortfolioQueries({ live: "0", tokens: [], snapshot: null });
    await getPortfolio({ scope: "global" });
    const bound = allBoundParams();
    expect(bound).toContain(WALLET_A); // mixed-case kept verbatim
    expect(bound).not.toContain(WALLET_A.toLowerCase());
  });
});

describe("portfolio-db getPortfolio - global scope narrowed to one wallet (WP-L2)", () => {
  beforeEach(() => {
    mocks.listWallets.mockImplementation((family: string) =>
      family === "evm"
        ? [{ id: "1", address: WALLET_A, label: "", createdAt: "" }]
        : [{ id: "2", address: SOL_ADDR, label: "", createdAt: "" }],
    );
  });

  it("narrows every SELECT to exactly the requested inventory wallet", async () => {
    scriptPortfolioQueries({
      live: "500",
      tokens: [{ chain_id: "1", token_symbol: "ETH", usd: "500" }],
      snapshot: null,
    });
    const result = await getPortfolio({ scope: "global", walletAddress: WALLET_A });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.walletCount).toBe(1);

    const bound = allBoundParams();
    expect(bound).toContain(WALLET_A);
    // The decisive isolation assertion: the OTHER inventory wallet is never bound.
    expect(bound).not.toContain(SOL_ADDR);
    for (const call of mocks.query.mock.calls) {
      const arr = Array.isArray(call[1]) ? call[1][0] : undefined;
      expect(arr).toEqual([WALLET_A]);
    }
  });

  it("fails closed with wallets.invalid_selection for an address outside the inventory, no SQL issued", async () => {
    const result = await getPortfolio({
      scope: "global",
      walletAddress: "0xNotConfigured0000000000000000000000000",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("wallets.invalid_selection");
    expect(result.error.domain).toBe("portfolio");
    expect(mocks.query).not.toHaveBeenCalled();
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it("never logs the requested walletAddress", async () => {
    scriptPortfolioQueries({ live: "1", tokens: [], snapshot: null });
    await getPortfolio({ scope: "global", walletAddress: WALLET_A });
    const logged = mocks.log.info.mock.calls.flat().join(" ");
    expect(logged).not.toContain(WALLET_A);
  });
});

describe("portfolio-db getPortfolio - session scope", () => {
  it("returns the empty DTO and issues NO SQL when the session scope is empty", async () => {
    mocks.getSessionWalletScope.mockResolvedValue(scopeOk(null, null));
    const result = await getPortfolio({ scope: "session", sessionId: SESSION });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.scope).toBe("session");
    expect(result.data.walletCount).toBe(0);
    expect(result.data.tokens).toEqual([]);
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it("CROSS-SESSION ISOLATION: a session scoped to wallet A never returns wallet B's rows", async () => {
    // The session is scoped to wallet A only. Even though the DB physically
    // holds rows for wallet B, the ANY($1) filter binds ONLY wallet A — the
    // mock proves the param set excludes B entirely.
    mocks.getSessionWalletScope.mockResolvedValue(scopeOk(WALLET_A, null));
    scriptPortfolioQueries({
      live: "500",
      tokens: [{ chain_id: "1", token_symbol: "ETH", usd: "500" }],
      snapshot: null,
    });

    const result = await getPortfolio({ scope: "session", sessionId: SESSION });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.walletCount).toBe(1);

    const bound = allBoundParams();
    expect(bound).toContain(WALLET_A);
    // The decisive isolation assertion: wallet B is NEVER bound into any query.
    expect(bound).not.toContain(WALLET_B);

    // And the address array bound as $1 is exactly [WALLET_A] on every call.
    for (const call of mocks.query.mock.calls) {
      const arr = Array.isArray(call[1]) ? call[1][0] : undefined;
      expect(arr).toEqual([WALLET_A]);
    }
  });

  it("propagates a failed session-scope read (fail closed, no SQL)", async () => {
    mocks.getSessionWalletScope.mockResolvedValue({
      ok: false as const,
      error: {
        code: "internal.unexpected",
        domain: "internal",
        message: "boom",
        retryable: true,
        userActionable: false,
        redacted: true,
      },
    });
    const result = await getPortfolio({ scope: "session", sessionId: SESSION });
    expect(result.ok).toBe(false);
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it("binds the address COUNT as the snapshot completeness param", async () => {
    mocks.getSessionWalletScope.mockResolvedValue(scopeOk(WALLET_A, SOL_ADDR));
    scriptPortfolioQueries({ live: "0", tokens: [], snapshot: null });
    await getPortfolio({ scope: "session", sessionId: SESSION });
    const snapshotCall = mocks.query.mock.calls[3];
    // [addressArray, addressCount]
    expect(snapshotCall?.[1]?.[1]).toBe(2);
  });
});

describe("portfolio-db getPortfolio - coercion + fallback", () => {
  beforeEach(() => {
    mocks.listWallets.mockImplementation((family: string) =>
      family === "evm" ? [{ id: "1", address: WALLET_A, label: "", createdAt: "" }] : [],
    );
  });

  it("collapses an absent snapshot to null total/pnl/at", async () => {
    scriptPortfolioQueries({ live: "10", tokens: [], snapshot: null });
    const result = await getPortfolio({ scope: "global" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.snapshotTotalUsd).toBeNull();
    expect(result.data.pnlVsPrev).toBeNull();
    expect(result.data.snapshotAt).toBeNull();
    expect(result.data.liveTotalUsd).toBe(10);
  });

  it("tolerates a BIGINT chain_id beyond the JS safe-integer range via Number()", async () => {
    scriptPortfolioQueries({
      live: "1",
      tokens: [{ chain_id: "999999999999999999999", token_symbol: "X", usd: "1" }],
      snapshot: null,
    });
    const result = await getPortfolio({ scope: "global" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.tokens).toHaveLength(1);
    // Number() yields a finite (lossy) value — tolerated, never null here.
    expect(result.data.tokens[0]?.chainId).toBe(Number("999999999999999999999"));
  });

  it("maps a null chain_id / null token_symbol to nulls", async () => {
    scriptPortfolioQueries({
      live: "1",
      tokens: [{ chain_id: null, token_symbol: null, usd: "1" }],
      snapshot: null,
    });
    const result = await getPortfolio({ scope: "global" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.tokens[0]).toEqual({
      chainId: null,
      symbol: null,
      tokenName: null,
      balanceUsd: 1,
      amount: null,
    });
  });

  it("preserves an UNPRICED holding as balanceUsd null with its amount (owner: show funds)", async () => {
    scriptPortfolioQueries({
      live: "0",
      tokens: [
        { chain_id: "4663", token_symbol: "ETH", usd: null, amount: "0.005" },
      ],
      snapshot: null,
    });
    const result = await getPortfolio({ scope: "global" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.tokens[0]).toEqual({
      chainId: 4663,
      symbol: "ETH",
      tokenName: null,
      balanceUsd: null,
      amount: 0.005,
    });
    // The flat query no longer coalesces usd to 0 and computes the human
    // amount PER ROW (divide before summing — mixed decimals stay correct).
    const tokenSql = String(mocks.query.mock.calls[1]?.[0] ?? "");
    expect(tokenSql).not.toContain("COALESCE(SUM(balance_usd)");
    expect(tokenSql).toContain("balance_raw::numeric / power(10::numeric, decimals)");
  });

  it("returns dbUnavailable (domain portfolio) when buildPoolConfig yields null", async () => {
    mocks.buildPoolConfig.mockResolvedValue(null);
    const result = await getPortfolio({ scope: "global" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.domain).toBe("portfolio");
    expect(result.error.code).toBe("internal.unexpected");
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it("returns dbError (domain portfolio) when a query throws", async () => {
    mocks.query.mockRejectedValueOnce(new Error("connection reset"));
    const result = await getPortfolio({ scope: "global" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.domain).toBe("portfolio");
    expect(result.error.code).toBe("internal.unexpected");
  });

  it("never logs raw addresses (only counts)", async () => {
    scriptPortfolioQueries({ live: "1", tokens: [], snapshot: null });
    await getPortfolio({ scope: "global" });
    const logged = mocks.log.info.mock.calls.flat().join(" ");
    expect(logged).not.toContain(WALLET_A);
    expect(logged).toContain("wallets=1");
  });
});

describe("portfolio-db getPortfolio - PnL + token cap (codex review)", () => {
  beforeEach(() => {
    mocks.listWallets.mockImplementation((family: string) =>
      family === "evm" ? [{ id: "1", address: WALLET_A, label: "", createdAt: "" }] : [],
    );
  });

  it("computes PnL as latest.total − previous.total over two complete cycles", async () => {
    scriptPortfolioQueries({
      live: "100",
      tokens: [],
      snapshot: { snapshot_group_id: "g1", total: "100", at: "2026-05-21T10:00:00.000Z" },
      previousSnapshot: { snapshot_group_id: "g0", total: "80", at: "2026-05-20T10:00:00.000Z" },
    });
    const result = await getPortfolio({ scope: "global" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.snapshotTotalUsd).toBeCloseTo(100, 4);
    expect(result.data.pnlVsPrev).toBeCloseTo(20, 4);
    // The snapshot query asks for the latest TWO groups and no longer sums
    // per-wallet pnl_vs_prev.
    const snapshotSql = String(mocks.query.mock.calls[3]?.[0] ?? "");
    expect(snapshotSql).toContain("LIMIT 2");
    expect(snapshotSql).not.toContain("pnl_vs_prev");
  });

  it("leaves PnL null when only one complete cycle exists", async () => {
    scriptPortfolioQueries({
      live: "100",
      tokens: [],
      snapshot: { snapshot_group_id: "g1", total: "100", at: "2026-05-21T10:00:00.000Z" },
    });
    const result = await getPortfolio({ scope: "global" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.snapshotTotalUsd).toBeCloseTo(100, 4);
    expect(result.data.pnlVsPrev).toBeNull();
  });

  it("caps token lines at 500 even if the DB returns more (no output-schema overflow)", async () => {
    const rows = Array.from({ length: 501 }, (_, i) => ({
      chain_id: "1",
      token_symbol: `T${i}`,
      usd: String(501 - i),
    }));
    scriptPortfolioQueries({ live: "1", tokens: rows, snapshot: null });
    const result = await getPortfolio({ scope: "global" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.tokens).toHaveLength(500);
    const tokenSql = String(mocks.query.mock.calls[1]?.[0] ?? "");
    expect(tokenSql).toContain("LIMIT 500");
  });
});

describe("portfolio-db getPortfolio - per-chain breakdown (codex plan review)", () => {
  beforeEach(() => {
    mocks.listWallets.mockImplementation((family: string) =>
      family === "evm" ? [{ id: "1", address: WALLET_A, label: "", createdAt: "" }] : [],
    );
  });

  it("issues a PURPOSE-BUILT window query (not a post-process of the capped flat list)", async () => {
    scriptPortfolioQueries({ live: "0", tokens: [], snapshot: null });
    await getPortfolio({ scope: "global" });
    const breakdownSql = String(mocks.query.mock.calls[2]?.[0] ?? "");
    // Window ranking per chain over the FULL balance set…
    expect(breakdownSql).toContain("ROW_NUMBER() OVER");
    expect(breakdownSql).toContain("PARTITION BY chain_id");
    // …NULL chain ids stay in the legacy flat list only…
    expect(breakdownSql).toContain("chain_id IS NOT NULL");
    // …EVERY funded chain survives (an unpriced-only chain totals 0 instead
    // of being HAVING-filtered away), tokens rank positive-USD-or-unpriced,
    // bounded to the schema caps.
    expect(breakdownSql).not.toContain("HAVING");
    expect(breakdownSql).toContain("COALESCE(SUM(usd), 0)");
    expect(breakdownSql).toContain("usd > 0 OR usd IS NULL");
    expect(breakdownSql).toContain("LIMIT 64");
    expect(breakdownSql).toContain("rn <= 3");
    // Same address allow-list binding as every other SELECT.
    const breakdownParams = mocks.query.mock.calls[2]?.[1];
    expect(Array.isArray(breakdownParams) ? breakdownParams[0] : undefined).toEqual([
      WALLET_A,
    ]);
  });

  it("assembles ordered chains with top-3 tokens and derives family from the chain id", async () => {
    scriptPortfolioQueries({
      live: "100",
      tokens: [],
      snapshot: null,
      breakdown: [
        // Solana chain (Khalani synthetic id) — total 60, two tokens.
        { chain_id: "20011000000", chain_total: "60", token_symbol: "SOL", token_usd: "50" },
        { chain_id: "20011000000", chain_total: "60", token_symbol: "BONK", token_usd: "10" },
        // Ethereum — total 40, one token.
        { chain_id: "1", chain_total: "40", token_symbol: "ETH", token_usd: "40" },
      ],
    });
    const result = await getPortfolio({ scope: "global" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.chains).toEqual([
      {
        chainId: 20011000000,
        family: "solana",
        totalUsd: 60,
        tokens: [
          { symbol: "SOL", tokenName: null, balanceUsd: 50, amount: null },
          { symbol: "BONK", tokenName: null, balanceUsd: 10, amount: null },
        ],
      },
      {
        chainId: 1,
        family: "evm",
        totalUsd: 40,
        tokens: [{ symbol: "ETH", tokenName: null, balanceUsd: 40, amount: null }],
      },
    ]);
  });

  it("keeps an unpriced-only chain (Robinhood 4663) with totalUsd 0 and a null-USD line carrying the amount", async () => {
    scriptPortfolioQueries({
      live: "10",
      tokens: [],
      snapshot: null,
      breakdown: [
        { chain_id: "1", chain_total: "10", token_symbol: "ETH", token_usd: "10" },
        // Native ETH on Robinhood Chain with NO price source: the chain
        // must still appear (totalUsd 0) and the line keeps balanceUsd null
        // with the human amount (owner decision: show funds, no fake $0.00).
        {
          chain_id: "4663",
          chain_total: "0",
          token_symbol: "ETH",
          token_usd: null,
          token_amount: "0.005",
        },
      ],
    });
    const result = await getPortfolio({ scope: "global" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.chains).toEqual([
      {
        chainId: 1,
        family: "evm",
        totalUsd: 10,
        tokens: [{ symbol: "ETH", tokenName: null, balanceUsd: 10, amount: null }],
      },
      {
        chainId: 4663,
        family: "evm",
        totalUsd: 0,
        tokens: [{ symbol: "ETH", tokenName: null, balanceUsd: null, amount: 0.005 }],
      },
    ]);
  });

  it("keeps zero totals; drops negative totals and unparseable chain ids defensively", async () => {
    scriptPortfolioQueries({
      live: "10",
      tokens: [],
      snapshot: null,
      breakdown: [
        { chain_id: "1", chain_total: "10", token_symbol: "ETH", token_usd: "10" },
        // Zero total is now LEGAL (unpriced-only chain); its priced-at-zero
        // line is still dropped from the top-3.
        { chain_id: "137", chain_total: "0", token_symbol: "POL", token_usd: "0" },
        // Should never arrive — the builder still drops them.
        { chain_id: "10", chain_total: "-5", token_symbol: "OP", token_usd: "-5" },
        { chain_id: "not-a-number", chain_total: "5", token_symbol: "X", token_usd: "5" },
      ],
    });
    const result = await getPortfolio({ scope: "global" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.chains).toEqual([
      {
        chainId: 1,
        family: "evm",
        totalUsd: 10,
        tokens: [{ symbol: "ETH", tokenName: null, balanceUsd: 10, amount: null }],
      },
      { chainId: 137, family: "evm", totalUsd: 0, tokens: [] },
    ]);
  });

  it("keeps at most 3 tokens per chain and drops non-positive token lines", async () => {
    scriptPortfolioQueries({
      live: "10",
      tokens: [],
      snapshot: null,
      breakdown: [
        { chain_id: "1", chain_total: "10", token_symbol: "A", token_usd: "4" },
        { chain_id: "1", chain_total: "10", token_symbol: "B", token_usd: "3" },
        { chain_id: "1", chain_total: "10", token_symbol: "C", token_usd: "2" },
        // 4th line + a zero line — both must be dropped (schema max(3), >$0).
        { chain_id: "1", chain_total: "10", token_symbol: "D", token_usd: "1" },
        { chain_id: "1", chain_total: "10", token_symbol: "E", token_usd: "0" },
      ],
    });
    const result = await getPortfolio({ scope: "global" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.chains[0]?.tokens).toEqual([
      { symbol: "A", tokenName: null, balanceUsd: 4, amount: null },
      { symbol: "B", tokenName: null, balanceUsd: 3, amount: null },
      { symbol: "C", tokenName: null, balanceUsd: 2, amount: null },
    ]);
  });

  it("bounds the assembled chains at 64 (schema max) even on excess rows", async () => {
    const breakdown = Array.from({ length: 65 }, (_, i) => ({
      chain_id: String(1000 + i),
      chain_total: String(65 - i),
      token_symbol: `T${i}`,
      token_usd: String(65 - i),
    }));
    scriptPortfolioQueries({ live: "10", tokens: [], snapshot: null, breakdown });
    const result = await getPortfolio({ scope: "global" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.chains).toHaveLength(64);
  });

  it("keeps equal-total chains contiguous (chain_id tie-breaker) - no duplicate entries", async () => {
    scriptPortfolioQueries({ live: "20", tokens: [], snapshot: null });
    await getPortfolio({ scope: "global" });
    // The ORDER BY must carry the deterministic chain_id tie-breaker: with
    // two equal totals Postgres could otherwise interleave rows by rank and
    // the single-pass grouper would emit duplicate chain entries.
    const breakdownSql = String(mocks.query.mock.calls[2]?.[0] ?? "");
    expect(breakdownSql).toContain(
      "ORDER BY t.chain_total DESC, t.chain_id ASC, r.rn ASC NULLS LAST",
    );
  });

  it("assembles two equal-total multi-token chains without splitting either", async () => {
    scriptPortfolioQueries({
      live: "20",
      tokens: [],
      snapshot: null,
      // Contiguous per chain (as the tie-broken ORDER BY guarantees).
      breakdown: [
        { chain_id: "1", chain_total: "10", token_symbol: "ETH", token_usd: "6" },
        { chain_id: "1", chain_total: "10", token_symbol: "USDC", token_usd: "4" },
        { chain_id: "8453", chain_total: "10", token_symbol: "USDC", token_usd: "7" },
        { chain_id: "8453", chain_total: "10", token_symbol: "WETH", token_usd: "3" },
      ],
    });
    const result = await getPortfolio({ scope: "global" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.chains).toHaveLength(2);
    expect(result.data.chains.map((c) => c.chainId)).toEqual([1, 8453]);
    expect(result.data.chains[0]?.tokens).toHaveLength(2);
    expect(result.data.chains[1]?.tokens).toHaveLength(2);
  });

  it("a chain with a positive total but no positive token lines keeps an empty tokens list", async () => {
    scriptPortfolioQueries({
      live: "10",
      tokens: [],
      snapshot: null,
      breakdown: [
        // LEFT JOIN emits the chain with NULL token columns when no ranked
        // line survived the positive-USD-or-unpriced filter.
        { chain_id: "1", chain_total: "10", token_symbol: null, token_usd: null },
      ],
    });
    const result = await getPortfolio({ scope: "global" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.chains).toEqual([
      { chainId: 1, family: "evm", totalUsd: 10, tokens: [] },
    ]);
  });
});

describe("portfolio-db getPortfolio - address-correct aggregation (position branding)", () => {
  beforeEach(() => {
    mocks.listWallets.mockImplementation((family: string) =>
      family === "evm" ? [{ id: "1", address: WALLET_A, label: "", createdAt: "" }] : [],
    );
  });

  const LEGIT_WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
  const SPOOF_WETH = "0x000000000000000000000000000000000000ff";

  it("groups the flat token list by (chain_id, normalized token_address) - semantic identity, never symbol", async () => {
    scriptPortfolioQueries({ live: "0", tokens: [], snapshot: null });
    await getPortfolio({ scope: "global" });
    const tokenSql = String(mocks.query.mock.calls[1]?.[0] ?? "");
    expect(tokenSql).toContain("token_address");
    expect(tokenSql).toContain("GROUP BY chain_id, CASE WHEN token_address ~* '^0x' THEN lower(token_address) ELSE token_address END");
  });

  it("groups the per-chain breakdown by (chain_id, normalized token_address) - semantic identity, never symbol", async () => {
    scriptPortfolioQueries({ live: "0", tokens: [], snapshot: null });
    await getPortfolio({ scope: "global" });
    const breakdownSql = String(mocks.query.mock.calls[2]?.[0] ?? "");
    expect(breakdownSql).toContain("GROUP BY chain_id, CASE WHEN token_address ~* '^0x' THEN lower(token_address) ELSE token_address END");
  });

  it("keeps a same-symbol/different-address pair as SEPARATE flat lines with correct totals and ranking (anti-spoof-collision)", async () => {
    scriptPortfolioQueries({
      live: "1500",
      tokens: [
        // A spoof token declaring the SAME "WETH" symbol as the legit
        // contract, at a DIFFERENT address — must never merge into one line.
        { chain_id: "1", token_address: LEGIT_WETH, token_symbol: "WETH", usd: "1000" },
        { chain_id: "1", token_address: SPOOF_WETH, token_symbol: "WETH", usd: "500" },
      ],
      snapshot: null,
    });
    const result = await getPortfolio({ scope: "global" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Neither line absorbed the other's balance — both survive at their own
    // USD figure, ranked biggest-first, each carrying its OWN address.
    expect(result.data.tokens).toEqual([
      {
        chainId: 1,
        symbol: "WETH",
        tokenAddress: LEGIT_WETH,
        tokenName: null,
        balanceUsd: 1000,
        amount: null,
      },
      {
        chainId: 1,
        symbol: "WETH",
        tokenAddress: SPOOF_WETH,
        tokenName: null,
        balanceUsd: 500,
        amount: null,
      },
    ]);
  });

  it("keeps a same-symbol/different-address pair as SEPARATE top-3 lines within one chain's breakdown", async () => {
    scriptPortfolioQueries({
      live: "1500",
      tokens: [],
      snapshot: null,
      breakdown: [
        {
          chain_id: "1",
          chain_total: "1500",
          token_address: LEGIT_WETH,
          token_symbol: "WETH",
          token_usd: "1000",
        },
        {
          chain_id: "1",
          chain_total: "1500",
          token_address: SPOOF_WETH,
          token_symbol: "WETH",
          token_usd: "500",
        },
      ],
    });
    const result = await getPortfolio({ scope: "global" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.chains).toEqual([
      {
        chainId: 1,
        family: "evm",
        totalUsd: 1500,
        tokens: [
          {
            symbol: "WETH",
            tokenAddress: LEGIT_WETH,
            tokenName: null,
            balanceUsd: 1000,
            amount: null,
          },
          {
            symbol: "WETH",
            tokenAddress: SPOOF_WETH,
            tokenName: null,
            balanceUsd: 500,
            amount: null,
          },
        ],
      },
    ]);
  });

  it("keeps ONE line for one address whose symbol was updated in place (metadata drift, no double count)", async () => {
    // Per ONE wallet, `proj_balances` upserts ON CONFLICT (wallet_address,
    // chain_id, token_address), so a symbol update overwrites the same row.
    // ACROSS wallets the same address can still carry different/stale symbols
    // (one row per wallet) — that case is collapsed by the query itself:
    // GROUP BY normalized address only, with the freshest-synced symbol
    // selected deterministically (see the SQL-shape assertions below).
    scriptPortfolioQueries({
      live: "1000",
      tokens: [
        { chain_id: "1", token_address: LEGIT_WETH, token_symbol: "WETH-RENAMED", usd: "1000" },
      ],
      snapshot: null,
    });
    const result = await getPortfolio({ scope: "global" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.tokens).toEqual([
      {
        chainId: 1,
        symbol: "WETH-RENAMED",
        tokenAddress: LEGIT_WETH,
        tokenName: null,
        balanceUsd: 1000,
        amount: null,
      },
    ]);
  });

  it("keeps native SOL and wSOL separate while returning the route-compatible mint", async () => {
    scriptPortfolioQueries({
      live: "150",
      tokens: [
        {
          chain_id: String(SOLANA_CHAIN_ID),
          token_address: SOLANA_NATIVE_PERSISTED_ADDRESS,
          token_symbol: "SOL",
          usd: "100",
          amount: "1",
        },
        {
          chain_id: String(SOLANA_CHAIN_ID),
          token_address: SOL_ADDR,
          token_symbol: "wSOL",
          usd: "50",
          amount: "0.5",
        },
      ],
      breakdown: [
        {
          chain_id: String(SOLANA_CHAIN_ID),
          chain_total: "150",
          token_address: SOLANA_NATIVE_PERSISTED_ADDRESS,
          token_symbol: "SOL",
          token_usd: "100",
          token_amount: "1",
        },
        {
          chain_id: String(SOLANA_CHAIN_ID),
          chain_total: "150",
          token_address: SOL_ADDR,
          token_symbol: "wSOL",
          token_usd: "50",
          token_amount: "0.5",
        },
      ],
      snapshot: null,
    });

    const result = await getPortfolio({ scope: "global" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.tokens).toHaveLength(2);
    expect(result.data.tokens.map((token) => ({
      symbol: token.symbol,
      tokenAddress: token.tokenAddress,
      amount: token.amount,
    }))).toEqual([
      { symbol: "SOL", tokenAddress: SOL_ADDR, amount: 1 },
      { symbol: "wSOL", tokenAddress: SOL_ADDR, amount: 0.5 },
    ]);
    expect(result.data.chains[0]?.tokens.map((token) => ({
      symbol: token.symbol,
      tokenAddress: token.tokenAddress,
      amount: token.amount,
    }))).toEqual([
      { symbol: "SOL", tokenAddress: SOL_ADDR, amount: 1 },
      { symbol: "wSOL", tokenAddress: SOL_ADDR, amount: 0.5 },
    ]);
  });

  it("threads tokenAddress through the flat mapping (null when the row carries none)", async () => {
    scriptPortfolioQueries({
      live: "1",
      tokens: [{ chain_id: "1", token_address: null, token_symbol: "ETH", usd: "1" }],
      snapshot: null,
    });
    const result = await getPortfolio({ scope: "global" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.tokens[0]?.tokenAddress).toBeNull();
  });
});

describe("portfolio-db getPortfolio - token NAME sanitization (main-side gate)", () => {
  beforeEach(() => {
    mocks.listWallets.mockImplementation((family: string) =>
      family === "evm" ? [{ id: "1", address: WALLET_A, label: "", createdAt: "" }] : [],
    );
  });

  it("preserves a real-world name with an internal space ('USD Coin') in the flat mapping", async () => {
    scriptPortfolioQueries({
      live: "1",
      tokens: [
        { chain_id: "1", token_symbol: "USDC", token_name: "USD Coin", usd: "1" },
      ],
      snapshot: null,
    });
    const result = await getPortfolio({ scope: "global" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.tokens[0]?.tokenName).toBe("USD Coin");
  });

  it("nulls a hostile token_name (control character) while the symbol survives unaffected", async () => {
    scriptPortfolioQueries({
      live: "1",
      tokens: [
        { chain_id: "1", token_symbol: "SCAM", token_name: "BAD\nNAME", usd: "1" },
      ],
      snapshot: null,
    });
    const result = await getPortfolio({ scope: "global" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.tokens[0]?.tokenName).toBeNull();
    expect(result.data.tokens[0]?.symbol).toBe("SCAM");
  });

  it("nulls a zero-width-spoofed token_name", async () => {
    scriptPortfolioQueries({
      live: "1",
      tokens: [
        { chain_id: "1", token_symbol: "USDC", token_name: "USD\u200bCoin", usd: "1" },
      ],
      snapshot: null,
    });
    const result = await getPortfolio({ scope: "global" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.tokens[0]?.tokenName).toBeNull();
  });

  it("nulls an over-64-char token_name without truncating", async () => {
    const longName = "A".repeat(65);
    scriptPortfolioQueries({
      live: "1",
      tokens: [{ chain_id: "1", token_symbol: "X", token_name: longName, usd: "1" }],
      snapshot: null,
    });
    const result = await getPortfolio({ scope: "global" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.tokens[0]?.tokenName).toBeNull();
  });

  it("threads a sanitized token_name through the per-chain breakdown", async () => {
    scriptPortfolioQueries({
      live: "1",
      tokens: [],
      snapshot: null,
      breakdown: [
        {
          chain_id: "1",
          chain_total: "1",
          token_symbol: "USDC",
          token_name: "USD Coin",
          token_usd: "1",
        },
      ],
    });
    const result = await getPortfolio({ scope: "global" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.chains[0]?.tokens[0]?.tokenName).toBe("USD Coin");
  });

  it("selects token_name via the SAME ORDER BY fragment as token_symbol in both queries (tie-ordering determinism by construction)", async () => {
    scriptPortfolioQueries({ live: "0", tokens: [], snapshot: null });
    await getPortfolio({ scope: "global" });
    const tokenSql = String(mocks.query.mock.calls[1]?.[0] ?? "");
    const breakdownSql = String(mocks.query.mock.calls[2]?.[0] ?? "");
    const ORDER = "ORDER BY synced_at DESC NULLS LAST, token_symbol ASC NULLS LAST";
    // Both the symbol aggregate and the name aggregate must share the
    // IDENTICAL ORDER BY fragment — the name aggregate does NOT sort on
    // `token_name` — so array_agg(...)[1] resolves to the SAME source row
    // for both columns even on an exact synced_at tie.
    expect(tokenSql).toContain(`(array_agg(token_symbol ${ORDER}))[1]`);
    expect(tokenSql).toContain(`(array_agg(token_name ${ORDER}))[1]`);
    expect(breakdownSql).toContain(`(array_agg(token_symbol ${ORDER}))[1]`);
    expect(breakdownSql).toContain(`(array_agg(token_name ${ORDER}))[1]`);
  });
});

describe("semantic token identity in aggregation SQL (shape)", () => {
  // The mocked client cannot execute SQL, so these assert the decisive query
  // text: one contract aggregates into ONE line even when wallets' rows
  // differ in EVM address casing or carry stale symbols — grouping must use
  // the normalized address ONLY (never the raw symbol), and the displayed
  // symbol must be the deterministic freshest one.

  const NORMALIZED = "CASE WHEN token_address ~* '^0x' THEN lower(token_address) ELSE token_address END";
  const LATEST_SYMBOL = "(array_agg(token_symbol ORDER BY synced_at DESC NULLS LAST, token_symbol ASC NULLS LAST))[1]";

  it("flat token query groups by normalized address only and selects the latest symbol", async () => {
    scriptPortfolioQueries({ live: "0", tokens: [], snapshot: null });
    await getPortfolio({ scope: "global" });
    const tokenSql = String(mocks.query.mock.calls[1]?.[0] ?? "");
    expect(tokenSql).toContain(`GROUP BY chain_id, ${NORMALIZED}`);
    expect(tokenSql).toContain(LATEST_SYMBOL);
    expect(tokenSql).not.toContain("GROUP BY chain_id, token_address, token_symbol");
  });

  it("per-chain breakdown CTE groups by normalized address only and selects the latest symbol", async () => {
    scriptPortfolioQueries({ live: "0", tokens: [], snapshot: null });
    await getPortfolio({ scope: "global" });
    const cteSql = String(mocks.query.mock.calls[2]?.[0] ?? "");
    expect(cteSql).toContain("WITH lines AS");
    expect(cteSql).toContain(`GROUP BY chain_id, ${NORMALIZED}`);
    expect(cteSql).toContain(LATEST_SYMBOL);
    expect(cteSql).not.toContain("GROUP BY chain_id, token_address, token_symbol");
  });

  it("two wallets sharing one address with different stale symbols arrive as ONE aggregated row (fixture at the query boundary)", async () => {
    // The DB collapses the two wallet rows via the normalized GROUP BY; the
    // fixture models exactly what the fixed query returns — one line, the
    // freshest symbol, summed USD — and the mapping must pass it through
    // without re-splitting or double counting.
    scriptPortfolioQueries({
      live: "1500",
      tokens: [
        { chain_id: "1", token_address: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2", token_symbol: "WETH", usd: "1500" },
      ],
      snapshot: null,
    });
    const result = await getPortfolio({ scope: "global" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.tokens).toHaveLength(1);
    expect(result.data.tokens[0]).toMatchObject({ symbol: "WETH", tokenAddress: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2", balanceUsd: 1500 });
  });
});

describe("portfolio-db getPortfolio - project scope (B0)", () => {
  const PROJECT = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
  const EVM = "0x1111111111111111111111111111111111111111";
  const SOL = "So11111111111111111111111111111111111111112";

  function scoped(
    evm: { id: string; address: string } | null,
    solana: { id: string; address: string } | null,
  ): void {
    mocks.readProjectPortfolioScope.mockResolvedValueOnce({
      kind: "ok",
      wallets: { evm, solana },
    });
  }

  it("aggregates BOTH of the project's selected wallets", async () => {
    scoped({ id: "evm_1", address: EVM }, { id: "sol_1", address: SOL });
    scriptPortfolioQueries({ live: 100, tokens: [], snapshot: null });

    const result = await getPortfolio({ scope: "project", projectId: PROJECT });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.scope).toBe("project");
    const bound = allBoundParams();
    expect(bound).toContain(EVM);
    expect(bound).toContain(SOL);
  });

  it("NARROWS to one wallet when walletId names a project selection", async () => {
    scoped({ id: "evm_1", address: EVM }, { id: "sol_1", address: SOL });
    scriptPortfolioQueries({ live: 40, tokens: [], snapshot: null });

    const result = await getPortfolio({
      scope: "project",
      projectId: PROJECT,
      walletId: "evm_1",
    });

    expect(result.ok).toBe(true);
    const bound = allBoundParams();
    expect(bound).toContain(EVM);
    // The OTHER selected wallet is never bound. Narrowing that still read the
    // aggregate would be a silent widening of the allow-list.
    expect(bound).not.toContain(SOL);
  });

  it("REJECTS a walletId that is not one of THIS project's selections", async () => {
    // The id is a perfectly good inventory id; it is simply not this project's.
    // Honouring it would make the arm a way to read any wallet through a
    // project id, which is the widening the server-side allow-list prevents.
    scoped({ id: "evm_1", address: EVM }, { id: "sol_1", address: SOL });

    const result = await getPortfolio({
      scope: "project",
      projectId: PROJECT,
      walletId: "evm_someone_elses",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("wallets.invalid_selection");
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it("FAILS CLOSED on wallet drift rather than reporting an empty portfolio", async () => {
    mocks.readProjectPortfolioScope.mockResolvedValueOnce({
      kind: "drift",
      family: "evm",
    });

    const result = await getPortfolio({ scope: "project", projectId: PROJECT });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("projects.wallet_drift");
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it("FAILS CLOSED for a missing or TOMBSTONED project", async () => {
    mocks.readProjectPortfolioScope.mockResolvedValueOnce({ kind: "not_found" });

    const result = await getPortfolio({ scope: "project", projectId: PROJECT });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("projects.not_found");
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it("returns an EMPTY portfolio, not an error, when nothing is selected", async () => {
    // A project with no wallet chosen is a real state and a different one from
    // "unknown project" and from "drift".
    scoped(null, null);

    const result = await getPortfolio({ scope: "project", projectId: PROJECT });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.scope).toBe("project");
    expect(result.data.walletCount).toBe(0);
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it("never logs a resolved address", async () => {
    scoped({ id: "evm_1", address: EVM }, null);
    scriptPortfolioQueries({ live: 5, tokens: [], snapshot: null });

    await getPortfolio({ scope: "project", projectId: PROJECT });

    const logged = JSON.stringify([
      ...mocks.log.info.mock.calls,
      ...mocks.log.warn.mock.calls,
      ...mocks.log.error.mock.calls,
    ]);
    expect(logged).not.toContain(EVM);
  });
});
