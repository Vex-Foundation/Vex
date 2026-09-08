/**
 * THE POSITION SNAPSHOT SWEEP - bounded, credential-gated, and honest about
 * what an observation can and cannot say.
 *
 * The defects pinned here:
 *
 *   1. AN UNBOUNDED SWEEP. Reading every scope every tick is how a sync lane
 *      starves the ones sharing its worker. The bound is a number, and the
 *      report says what it left rather than pretending it did everything.
 *   2. OBSERVING AN ACCOUNT THIS INSTALL NO LONGER HOLDS. The account endpoint
 *      would answer a public read by index, so nothing stops the sweep except
 *      the credential gate - and publishing observations of an account whose
 *      credential is gone is reporting on somebody else's trading.
 *   3. A DERIVED PnL. Any figure computed on our side is wrong the moment the
 *      account traded outside Vex, and funding and fee inclusion are the
 *      provider's conventions. Reported or absent, never derived.
 *   4. A ZERO-SIZE POSITION SHOWN AS EXPOSURE. The provider returns rows for
 *      markets with no position; storing them would show a user positions they
 *      do not have.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

import type { LighterAccountPosition } from "@tools/lighter/types.js";

const mockQuery = vi.fn();
const mockWithTransaction = vi.fn();
const mockGetAccount = vi.fn();
const mockResolveAuth = vi.fn();

vi.mock("@vex-agent/db/client.js", () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  withTransaction: (...args: unknown[]) => mockWithTransaction(...args),
}));

vi.mock("@tools/lighter/client.js", () => ({
  getLighterClient: () => ({ getAccount: (...args: unknown[]) => mockGetAccount(...args) }),
}));

vi.mock("@vex-agent/tools/protocols/lighter/read-account-auth.js", () => ({
  resolveLighterReadOnlyAccountAuth: (...args: unknown[]) => mockResolveAuth(...args),
}));

vi.mock("@utils/logger.js", () => {
  const stub = { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() };
  return { default: stub, logger: stub };
});

const {
  snapshotLighterPositions,
  projectLighterPosition,
  storeLighterPositionObservation,
  LIGHTER_SNAPSHOT_SCOPES_PER_SWEEP,
} = await import("@vex-agent/sync/lighter-position-snapshot.js");

function position(overrides: Partial<LighterAccountPosition> = {}): LighterAccountPosition {
  return {
    market_id: 1,
    symbol: "ETH-USD",
    initial_margin_fraction: "0.1",
    open_order_count: 0,
    pending_order_count: 0,
    position_tied_order_count: 0,
    sign: 1,
    position: "0.4",
    avg_entry_price: "2500.5",
    position_value: "1000.2",
    unrealized_pnl: "12.5",
    realized_pnl: "-3.25",
    liquidation_price: "1800",
    margin_mode: 0,
    allocated_margin: "100",
    ...overrides,
  };
}

/** Scope rows as the projection query returns them, with the total attached. */
function scopeRows(count: number): Array<Record<string, unknown>> {
  return Array.from({ length: count }, (_unused, index) => ({
    environment: "core",
    account_index: String(700000 + index),
    total: String(count),
  }));
}

/** A fake transaction that records every statement the store ran. */
function captureTransaction(): { statements: Array<{ sql: string; params: unknown[] }> } {
  const statements: Array<{ sql: string; params: unknown[] }> = [];
  mockWithTransaction.mockImplementation(async (run: (client: unknown) => Promise<unknown>) =>
    run({
      query: async (sql: string, params: unknown[] = []) => {
        statements.push({ sql, params });
        return { rowCount: 1, rows: [{ id: 1 }] };
      },
    }),
  );
  return { statements };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockResolveAuth.mockResolvedValue({ accountIndex: 700000, token: "read-only" });
  mockGetAccount.mockResolvedValue({
    code: 200,
    accounts: [{ account_index: 700000, positions: [position()] }],
  });
  captureTransaction();
});

describe("projecting one provider position", () => {
  it("signs the size, because a short is not a long", () => {
    expect(projectLighterPosition(position({ sign: -1, position: "0.4" }))?.size).toBe("-0.4");
    expect(projectLighterPosition(position({ sign: 1, position: "0.4" }))?.size).toBe("0.4");
  });

  it("carries PnL only as the provider reported it", () => {
    const projected = projectLighterPosition(position());
    expect(projected?.unrealizedPnl).toBe("12.5");
    expect(projected?.realizedPnl).toBe("-3.25");
  });

  it("leaves PnL absent rather than deriving it when the provider omits it", () => {
    const projected = projectLighterPosition(position({ unrealized_pnl: "", realized_pnl: "" }));
    expect(projected?.unrealizedPnl).toBeNull();
    expect(projected?.realizedPnl).toBeNull();
  });

  it("drops a zero-size row rather than showing exposure that does not exist", () => {
    expect(projectLighterPosition(position({ position: "0" }))).toBeNull();
    expect(projectLighterPosition(position({ position: "0.000" }))).toBeNull();
  });

  it("keeps only named fields, never the provider's own row", () => {
    const projected = projectLighterPosition(
      position({ allocated_margin: "100", total_discount: "7", margin_mode: 1 }),
    );
    expect(Object.keys(projected ?? {}).sort()).toEqual([
      "entryPrice",
      "liquidationPrice",
      "marketIndex",
      "marketSymbol",
      "realizedPnl",
      "size",
      "unrealizedPnl",
    ]);
  });
});

describe("the sweep's bound", () => {
  it("asks for at most the per-sweep bound and reports what it left", async () => {
    mockQuery.mockResolvedValue(scopeRows(LIGHTER_SNAPSHOT_SCOPES_PER_SWEEP).map((row) => ({
      ...row,
      total: "12",
    })));

    const report = await snapshotLighterPositions();

    expect(mockQuery.mock.calls[0]?.[1]).toEqual([LIGHTER_SNAPSHOT_SCOPES_PER_SWEEP]);
    expect(report.examined).toBe(LIGHTER_SNAPSHOT_SCOPES_PER_SWEEP);
    expect(report.hasMore).toBe(true);
    expect(report.remainingScopes).toBe(12 - LIGHTER_SNAPSHOT_SCOPES_PER_SWEEP);
  });

  it("reports hasMore false when it reached every scope", async () => {
    mockQuery.mockResolvedValue(scopeRows(2));
    const report = await snapshotLighterPositions();
    expect(report.hasMore).toBe(false);
    expect(report.remainingScopes).toBe(0);
  });
});

describe("the credential gate", () => {
  it("never reads an account whose credential this install can no longer resolve", async () => {
    mockQuery.mockResolvedValue(scopeRows(1));
    mockResolveAuth.mockResolvedValue(null);

    const report = await snapshotLighterPositions();

    expect(mockGetAccount).not.toHaveBeenCalled();
    expect(mockWithTransaction).not.toHaveBeenCalled();
    expect(report).toMatchObject({ awaitingVault: 1, observed: 0 });
  });

  it("observes a scope whose credential is live", async () => {
    mockQuery.mockResolvedValue(scopeRows(1));
    const report = await snapshotLighterPositions();
    expect(mockGetAccount).toHaveBeenCalledTimes(1);
    expect(report.observed).toBe(1);
  });

  it("keeps observing the other scopes when one read fails", async () => {
    mockQuery.mockResolvedValue(scopeRows(2));
    mockGetAccount
      .mockRejectedValueOnce(new Error("provider unavailable"))
      .mockResolvedValue({ code: 200, accounts: [{ account_index: 700001, positions: [] }] });

    const report = await snapshotLighterPositions();

    expect(report.errors).toBe(1);
    expect(report.observed).toBe(1);
    expect(report.lastError).toBe("provider unavailable");
  });
});

describe("completeness", () => {
  it("marks an observation complete when the account's positions were read", async () => {
    mockQuery.mockResolvedValue(scopeRows(1));
    const capture = captureTransaction();

    await snapshotLighterPositions();

    const insert = capture.statements.find((s) => s.sql.includes("lighter_position_observations"));
    expect(insert?.params[5]).toBe(true);
    expect(insert?.params[4]).toBe('"all"');
  });

  it("marks it INCOMPLETE when the response did not carry the account", async () => {
    mockQuery.mockResolvedValue(scopeRows(1));
    mockGetAccount.mockResolvedValue({ code: 200, accounts: [] });
    const capture = captureTransaction();

    await snapshotLighterPositions();

    const insert = capture.statements.find((s) => s.sql.includes("lighter_position_observations"));
    // Complete would close every position the account holds on the strength of
    // a page that never mentioned it.
    expect(insert?.params[5]).toBe(false);
  });

  it("treats an empty positions array as a COMPLETE observation of no positions", async () => {
    mockQuery.mockResolvedValue(scopeRows(1));
    mockGetAccount.mockResolvedValue({ code: 200, accounts: [{ account_index: 700000, positions: [] }] });
    const capture = captureTransaction();

    await snapshotLighterPositions();

    const insert = capture.statements.find((s) => s.sql.includes("lighter_position_observations"));
    expect(insert?.params[5]).toBe(true);
    expect(insert?.params[6]).toBe("[]");
  });
});

describe("storing an observation", () => {
  it("writes the observation and its market state in ONE transaction", async () => {
    const capture = captureTransaction();

    await storeLighterPositionObservation({
      environment: "core",
      accountIndex: 743799,
      observationId: "obs-1",
      observedAt: "2026-09-07T10:00:00.000Z",
      coverage: "all",
      complete: true,
      positions: [{
        marketIndex: 1,
        marketSymbol: "ETH-USD",
        size: "0.4",
        entryPrice: "2500.5",
        unrealizedPnl: "12.5",
        realizedPnl: null,
        liquidationPrice: "1800",
      }],
    });

    expect(mockWithTransaction).toHaveBeenCalledTimes(1);
    expect(capture.statements.map((s) => s.sql.includes("lighter_position_observations"))).toContain(true);
    expect(capture.statements.map((s) => s.sql.includes("lighter_position_market_state"))).toContain(true);
  });

  it("guards every market write on being NEWER than what is stored", async () => {
    const capture = captureTransaction();

    await storeLighterPositionObservation({
      environment: "core",
      accountIndex: 743799,
      observationId: "obs-1",
      observedAt: "2026-09-07T10:00:00.000Z",
      coverage: "all",
      complete: true,
      positions: [{
        marketIndex: 1, marketSymbol: "ETH-USD", size: "0.4",
        entryPrice: null, unrealizedPnl: null, realizedPnl: null, liquidationPrice: null,
      }],
    });

    const upsert = capture.statements.find((s) => s.sql.includes("ON CONFLICT (environment, account_index, market_index)"));
    expect(upsert?.sql).toContain("WHERE lighter_position_market_state.observed_at < EXCLUDED.observed_at");
  });

  it("closes uncovered markets from a COMPLETE observation, keeping their marker", async () => {
    const capture = captureTransaction();

    await storeLighterPositionObservation({
      environment: "core",
      accountIndex: 743799,
      observationId: "obs-2",
      observedAt: "2026-09-07T11:00:00.000Z",
      coverage: "all",
      complete: true,
      positions: [],
    });

    const closure = capture.statements.find((s) => s.sql.includes("open = FALSE"));
    expect(closure).toBeDefined();
    // The row survives with `open = FALSE`; deleting it would make a closed
    // market indistinguishable from one never seen, and the next late backfill
    // would resurrect the position.
    expect(closure?.sql).not.toContain("DELETE");
    expect(closure?.sql).toContain("observed_at < $4::timestamptz");
  });

  it("never infers a closure from an INCOMPLETE observation", async () => {
    const capture = captureTransaction();

    await storeLighterPositionObservation({
      environment: "core",
      accountIndex: 743799,
      observationId: "obs-3",
      observedAt: "2026-09-07T12:00:00.000Z",
      coverage: [1],
      complete: false,
      positions: [{
        marketIndex: 1, marketSymbol: "ETH-USD", size: "0.4",
        entryPrice: null, unrealizedPnl: null, realizedPnl: null, liquidationPrice: null,
      }],
    });

    expect(capture.statements.find((s) => s.sql.includes("open = FALSE"))).toBeUndefined();
  });

  it("does nothing further when the observation id was already stored", async () => {
    const statements: Array<{ sql: string }> = [];
    mockWithTransaction.mockImplementation(async (run: (client: unknown) => Promise<unknown>) =>
      run({
        query: async (sql: string) => {
          statements.push({ sql });
          return { rowCount: 0, rows: [] };
        },
      }),
    );

    const result = await storeLighterPositionObservation({
      environment: "core",
      accountIndex: 743799,
      observationId: "obs-1",
      observedAt: "2026-09-07T10:00:00.000Z",
      coverage: "all",
      complete: true,
      positions: [],
    });

    expect(result.marketsUpdated).toBe(0);
    expect(statements).toHaveLength(1);
  });
});
