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
  recordLighterSnapshotAttempt,
  snapshotLighterPositions,
  projectLighterPosition,
  projectLighterObservationForWire,
  listUnsentLighterPositionObservations,
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
      "initialMarginFraction",
      "liquidationPrice",
      "marginMode",
      "marketIndex",
      "marketSymbol",
      "realizedPnl",
      "size",
      "unrealizedPnl",
    ]);
  });

  it.each([
    ["10.00", 1, 1000, "isolated" as const],
    ["50.00", 0, 5000, "cross" as const],
    ["100", 0, 10_000, "cross" as const],
  ])(
    "reads the account endpoint's percent string %s and margin code %i as the canonical unit",
    (percent, mode, fraction, marginMode) => {
      const projected = projectLighterPosition(
        position({ initial_margin_fraction: percent, margin_mode: mode }),
      );
      expect(projected?.initialMarginFraction).toBe(fraction);
      expect(projected?.marginMode).toBe(marginMode);
    },
  );

  // A non-textual fraction is a provider row this build has not seen. It is
  // built through the DTO's own open index signature (`[key: string]: unknown`)
  // rather than through a cast that would hide the wrong type from the reader.
  const nonTextual: Record<string, unknown> = { ...position(), initial_margin_fraction: 10 };

  it.each([
    ["a fraction Vex cannot read exactly", position({ initial_margin_fraction: "33.333" })],
    ["a fraction above 100 percent", position({ initial_margin_fraction: "150.00" })],
    ["a zero fraction", position({ initial_margin_fraction: "0" })],
    ["a non-textual fraction", nonTextual as LighterAccountPosition],
  ])("leaves the leverage unknown on %s, and still keeps the position", (_label, row) => {
    const projected = projectLighterPosition(row);
    // The margin terms are context. The size, entry and PnL are the fact, and
    // they do not become less true because one optional field is unreadable.
    expect(projected?.size).toBe("0.4");
    expect(projected?.entryPrice).toBe("2500.5");
    expect(projected?.initialMarginFraction).toBeNull();
  });

  it("leaves an unknown margin-mode code unknown rather than calling it cross", () => {
    const projected = projectLighterPosition(position({ margin_mode: 7 }));
    expect(projected?.marginMode).toBeNull();
    expect(projected?.size).toBe("0.4");
  });
});

describe("reading an observation back out of storage", () => {
  /** One stored row as the owed-observations query returns it. */
  function storedRow(positions: unknown): Record<string, unknown> {
    return {
      id: 1,
      environment: "core",
      account_index: "743799",
      observation_id: "obs-1",
      observed_at: "2026-09-07T10:00:00.000Z",
      coverage_markets: "all",
      complete: true,
      positions,
    };
  }

  it("reads the margin terms back through their own named fields", async () => {
    mockQuery.mockResolvedValue([storedRow([{
      marketIndex: 1, marketSymbol: "ETH-USD", size: "0.4",
      entryPrice: "2500.5", unrealizedPnl: null, realizedPnl: null, liquidationPrice: null,
      initialMarginFraction: 1000, marginMode: "isolated",
    }])]);

    const [observation] = await listUnsentLighterPositionObservations(10);
    expect(observation?.positions[0]).toMatchObject({
      initialMarginFraction: 1000,
      marginMode: "isolated",
    });
  });

  it.each([
    ["an observation stored before these fields existed", {}],
    ["an explicit null", { initialMarginFraction: null, marginMode: null }],
    ["a fraction outside the canonical range", { initialMarginFraction: 20_000, marginMode: "sideways" }],
    ["values of the wrong type", { initialMarginFraction: "1000", marginMode: 1 }],
  ])("reads %s as unknown, without losing the position", async (_label, margin) => {
    mockQuery.mockResolvedValue([storedRow([{
      marketIndex: 1, marketSymbol: "ETH-USD", size: "0.4",
      entryPrice: "2500.5", unrealizedPnl: null, realizedPnl: null, liquidationPrice: null,
      ...margin,
    }])]);

    const [observation] = await listUnsentLighterPositionObservations(10);
    expect(observation?.positions).toHaveLength(1);
    expect(observation?.positions[0]?.size).toBe("0.4");
    expect(observation?.positions[0]?.initialMarginFraction).toBeNull();
    expect(observation?.positions[0]?.marginMode).toBeNull();
  });
});

describe("the AgentScan wire payload", () => {
  it("does not grow a key because the ledger learned one", () => {
    const payload = projectLighterObservationForWire(
      {
        id: 1,
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
          initialMarginFraction: 1000,
          marginMode: "isolated",
        }],
      },
      new Map([[1, 4]]),
    );

    // The mapper names every field it sends, which is exactly what keeps a new
    // durable fact off the external wire until someone decides to send it.
    expect(Object.keys(payload?.positions[0] ?? {}).sort()).toEqual([
      "entryPrice",
      "liquidationPrice",
      "marketIndex",
      "marketSymbol",
      "realizedPnl",
      "size",
      "sizeDecimals",
      "unrealizedPnl",
    ]);
    expect(JSON.stringify(payload)).not.toContain("initialMarginFraction");
    expect(JSON.stringify(payload)).not.toContain("marginMode");
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

/** Every attempt marker the sweep wrote, in order, as (accountIndex, result). */
function attemptMarkers(): Array<[number, string]> {
  return mockQuery.mock.calls
    .filter((call) => String(call[0]).includes("INSERT INTO lighter_position_sweep_state"))
    .map((call) => {
      const params = call[1] as unknown[];
      return [Number(params[1]), String(params[2])] as [number, string];
    });
}

describe("fair scheduling", () => {
  it("orders the queue by the last ATTEMPT, never by the last observation", async () => {
    mockQuery.mockResolvedValue(scopeRows(1));

    await snapshotLighterPositions();

    const [sql] = mockQuery.mock.calls[0] ?? [];
    // The defect: five scopes that always fail never get a last-observation
    // time, so under a success ordering they sort first forever and fill every
    // bounded sweep. A sixth healthy account is then never observed at all.
    expect(String(sql)).toContain("ORDER BY sweep.last_attempt_at ASC NULLS FIRST");
    expect(String(sql)).not.toContain("last_observed_at ASC");
  });

  it("marks the attempt BEFORE the read and settles it AFTER, whatever it produced", async () => {
    mockQuery.mockResolvedValue(scopeRows(1));

    await snapshotLighterPositions();

    expect(attemptMarkers()).toEqual([[700000, "attempted"], [700000, "observed"]]);
  });

  it("marks a scope with NO CREDENTIAL as attempted, so it cannot hold its slot", async () => {
    mockQuery.mockResolvedValue(scopeRows(1));
    mockResolveAuth.mockResolvedValue(null);

    await snapshotLighterPositions();

    expect(attemptMarkers()).toEqual([[700000, "attempted"], [700000, "no_credential"]]);
  });

  it("marks a scope the PROVIDER REFUSED as attempted, with the reason", async () => {
    mockQuery.mockResolvedValue(scopeRows(1));
    mockGetAccount.mockRejectedValue(new Error("provider unavailable"));

    await snapshotLighterPositions();

    expect(attemptMarkers()).toEqual([[700000, "attempted"], [700000, "provider_unavailable"]]);
  });

  it("keeps the sweep alive when the marker write itself fails", async () => {
    // A bookkeeping failure must not turn one scope into the whole sweep's
    // failure; the scope stays marked `attempted`, which still orders it fairly.
    mockQuery.mockImplementation(async (sql: string) => {
      if (String(sql).includes("INSERT INTO lighter_position_sweep_state")
        && String(sql).includes("last_attempt_result = EXCLUDED")) {
        throw new Error("marker write failed");
      }
      return scopeRows(1);
    });

    const report = await snapshotLighterPositions();

    expect(report.observed).toBe(1);
    expect(report.errors).toBe(0);
  });

  it("records the settled result with the scope it belongs to", async () => {
    // `clearAllMocks` clears calls, not implementations: the case above
    // installed a throwing one and this case owns its own.
    mockQuery.mockResolvedValue([]);
    await recordLighterSnapshotAttempt({ environment: "rhc", accountIndex: 22869, result: "observed" });
    const [sql, params] = mockQuery.mock.calls[0] ?? [];
    expect(String(sql)).toContain("ON CONFLICT (environment, account_index) DO UPDATE");
    expect(params).toEqual(["rhc", 22869, "observed"]);
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
        initialMarginFraction: 1000,
        marginMode: "isolated",
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
        initialMarginFraction: null, marginMode: null,
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
        initialMarginFraction: null, marginMode: null,
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

    expect(result).toEqual({ marketsUpdated: 0, ignoredAsStale: false, replayed: true });
    // Reserve the scope row, read its watermark, attempt the observation - and
    // then stop: a replay of an observation already stored moves nothing.
    expect(statements.map((s) => s.sql.includes("lighter_position_market_state"))).not.toContain(true);
    expect(statements).toHaveLength(3);
  });
});
