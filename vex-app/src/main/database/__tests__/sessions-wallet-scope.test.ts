/**
 * initializeSessionWalletScopeWithClient — puzzle 5 phase 5C.
 *
 * Scripted fake `pg.Client` (mirrors sessions-db.test.ts) drives the
 * initialize-if-empty CAS + mission draft allowed_wallets recompute without a
 * real DB. Asserts: a successful CAS recomputes missions.allowed_wallets from
 * the resulting selection; a CAS miss touches neither sessions nor missions.
 */

import { describe, it, expect, vi } from "vitest";
import type { Client } from "pg";

vi.mock("../../logger/index.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../db-config.js", () => ({ buildPoolConfig: () => ({}) }));

const mod = await import("../sessions-db.js");

interface ScriptedResult {
  rows?: unknown[];
  rowCount?: number;
}
function scriptedClient(results: ReadonlyArray<ScriptedResult>) {
  let i = 0;
  const queryMock = vi.fn(async () => {
    const r = results[i] ?? { rows: [], rowCount: 0 };
    i += 1;
    return r;
  });
  const client = { query: queryMock } as unknown as Client;
  return { client, queryMock };
}

const SID = "00000000-0000-4000-8000-000000000001";
const EVM = { id: "evm_1", address: "0xEvmAddr" };
const SOL = { id: "sol_1", address: "SolAddr" };

function missionsCall(queryMock: ReturnType<typeof vi.fn>) {
  return queryMock.mock.calls.find((c) => String(c[0]).includes("UPDATE missions"));
}

describe("initializeSessionWalletScopeWithClient", () => {
  it("mission session: set evm initializes session + recomputes missions.allowed_wallets", async () => {
    const { client, queryMock } = scriptedClient([
      {}, // BEGIN
      { rowCount: 1 }, // UPDATE evm (was NULL, message_count 0)
      {
        rows: [
          {
            selected_evm_wallet_id: "evm_1",
            selected_evm_wallet_address: "0xEvmAddr",
            selected_solana_wallet_id: null,
            selected_solana_wallet_address: null,
          },
        ],
      }, // SELECT scope
      { rowCount: 1 }, // UPDATE missions
      {}, // COMMIT
    ]);
    const res = await mod.initializeSessionWalletScopeWithClient(client, SID, EVM, null);
    expect(res.status).toBe("updated");
    expect(missionsCall(queryMock)?.[1]).toEqual([SID, ["0xEvmAddr"]]);
  });

  it("CAS miss (family already set or session started) → unchanged, NO missions update", async () => {
    const { client, queryMock } = scriptedClient([
      {}, // BEGIN
      { rowCount: 0 }, // UPDATE evm matched nothing
      {}, // COMMIT
    ]);
    const res = await mod.initializeSessionWalletScopeWithClient(client, SID, EVM, null);
    expect(res.status).toBe("unchanged");
    expect(missionsCall(queryMock)).toBeUndefined();
  });

  it("setting solana when evm already present recomputes allowed_wallets with BOTH", async () => {
    const { client, queryMock } = scriptedClient([
      {}, // BEGIN
      { rowCount: 1 }, // UPDATE solana
      {
        rows: [
          {
            selected_evm_wallet_id: "evm_1",
            selected_evm_wallet_address: "0xEvmAddr",
            selected_solana_wallet_id: "sol_1",
            selected_solana_wallet_address: "SolAddr",
          },
        ],
      }, // SELECT scope (evm already set + new solana)
      { rowCount: 1 }, // UPDATE missions
      {}, // COMMIT
    ]);
    const res = await mod.initializeSessionWalletScopeWithClient(client, SID, null, SOL);
    expect(res.status).toBe("updated");
    expect(missionsCall(queryMock)?.[1]).toEqual([SID, ["0xEvmAddr", "SolAddr"]]);
  });
});

// SessionRow fields read by toListItem (other columns are ignored).
const SESSION_ROW = {
  id: SID,
  scope: "vex_app",
  mode: "mission",
  permission: "restricted",
  title: "M",
  initial_goal: null,
  started_at: new Date(0),
  ended_at: null,
  pinned_at: null,
};

describe("createSessionWithClient", () => {
  const restricted = "restricted" as const;

  it("mission + evm+solana → 4 session wallet cols + missions.allowed_wallets, both INSERTs in one tx", async () => {
    const { client, queryMock } = scriptedClient([
      {}, // BEGIN
      { rowCount: 1 }, // INSERT sessions
      { rowCount: 1 }, // INSERT missions
      { rows: [SESSION_ROW] }, // SELECT
      {}, // COMMIT
    ]);
    const res = await mod.createSessionWithClient(
      client,
      SID,
      {
        mode: "mission",
        name: "M",
        permission: restricted,
        selectedEvmWalletId: "evm_1",
        selectedSolanaWalletId: "sol_1",
      },
      { evm: EVM, solana: SOL },
    );
    expect(res.ok).toBe(true);
    const calls = queryMock.mock.calls;
    expect(calls[0][0]).toBe("BEGIN");
    expect(calls.at(-1)?.[0]).toBe("COMMIT");
    const sessionsInsert = calls.find((c) => String(c[0]).includes("INSERT INTO sessions"));
    expect(sessionsInsert?.[1]).toEqual([
      SID, "vex_app", "mission", "restricted", null, "M",
      "evm_1", "0xEvmAddr", "sol_1", "SolAddr", null,
    ]);
    const missionsInsert = calls.find((c) => String(c[0]).includes("INSERT INTO missions"));
    expect(missionsInsert?.[1]).toEqual([expect.any(String), SID, ["0xEvmAddr", "SolAddr"]]);
  });

  it("mission + evm only → missions.allowed_wallets = [evmAddr]", async () => {
    const { client, queryMock } = scriptedClient([
      {},
      { rowCount: 1 },
      { rowCount: 1 },
      { rows: [SESSION_ROW] },
      {},
    ]);
    await mod.createSessionWithClient(
      client,
      SID,
      { mode: "mission", name: "M", permission: restricted, selectedEvmWalletId: "evm_1", selectedSolanaWalletId: null },
      { evm: EVM, solana: null },
    );
    const missionsInsert = queryMock.mock.calls.find((c) =>
      String(c[0]).includes("INSERT INTO missions"),
    );
    expect(missionsInsert?.[1]).toEqual([expect.any(String), SID, ["0xEvmAddr"]]);
  });

  it("agent session → sessions INSERT only (no missions), wallet cols still set", async () => {
    const { client, queryMock } = scriptedClient([{}, { rowCount: 1 }, { rows: [SESSION_ROW] }, {}]);
    await mod.createSessionWithClient(
      client,
      SID,
      { mode: "agent", name: "A", permission: restricted, selectedEvmWalletId: "evm_1", selectedSolanaWalletId: null },
      { evm: EVM, solana: null },
    );
    expect(
      queryMock.mock.calls.find((c) => String(c[0]).includes("INSERT INTO missions")),
    ).toBeUndefined();
    const sessionsInsert = queryMock.mock.calls.find((c) =>
      String(c[0]).includes("INSERT INTO sessions"),
    );
    expect(sessionsInsert?.[1]?.[6]).toBe("evm_1");
    expect(sessionsInsert?.[1]?.[7]).toBe("0xEvmAddr");
  });
});
