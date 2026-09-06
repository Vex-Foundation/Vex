/**
 * CANARY - the snapshot's cycle-start probe must never log a raw throw.
 *
 * `fullBalanceSync({ snapshot: "when-settled" })` - the PERIODIC/worker policy,
 * which is the one the background pipeline actually uses - stamps the activity
 * fence before the scan. That probe talks to Postgres, and a driver/connection
 * failure carries the connection string (and therefore the password) in its
 * message. Such a site once logged `err.message` verbatim, so a DB outage wrote
 * the credential into the log file; the logger performs no redaction of its own
 * (rule 06).
 *
 * The probe this suite drove originally was the pre-flight pending-activity
 * read, which is gone: in-flight money no longer withholds a snapshot, so there
 * is nothing for it to pre-flight. `readCycleStartFence` is the SAME risk on
 * the SAME cycle - a Postgres call whose failure is summarized into a warn log
 * and whose unknown answer must fail closed - so the canary moved to it rather
 * than being deleted with its subject. The pre-existing IPC-level canary cannot
 * see this: it mocks `refreshPortfolioNow` wholesale.
 *
 * THE FILENAME still says "pending probe" and the subject no longer does.
 * Renaming it to `balance-sync-fence-probe-redaction.test.ts` reads to
 * `scripts/check-test-unsafe-escapes.mjs` as a test DELETION and needs a
 * reviewed entry in `scripts/deleted-test-allowlist.mjs`, which this lane does
 * not own. The rename is a follow-up for whoever owns that allowlist; the
 * coverage is here and complete either way.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockWarn = vi.fn();
vi.mock("@utils/logger.js", () => ({
  default: { info: vi.fn(), warn: (...a: unknown[]) => mockWarn(...a), error: vi.fn(), debug: vi.fn() },
}));

const mockListWallets = vi.fn();
vi.mock("@tools/wallet/inventory.js", () => ({
  listWallets: (family: string) => mockListWallets(family),
}));

const mockScan = vi.fn();
vi.mock("@tools/khalani/balances.js", () => ({
  getTokenBalancesAcrossChains: (...a: unknown[]) => mockScan(...a),
}));

const mockGetCachedKhalaniChains = vi.fn();
vi.mock("@tools/khalani/chains.js", () => ({
  getCachedKhalaniChains: () => mockGetCachedKhalaniChains(),
  resolveChainId: () => {
    throw new Error("unsupported");
  },
}));

vi.mock("../../../vex-agent/sync/local-chain-balance-sync.js", () => ({
  syncLocalChainForWallet: vi.fn().mockResolvedValue({ chainId: 4663, tokensUpdated: 0, skipped: true }),
}));

vi.mock("../../../vex-agent/sync/pendle-enrichment.js", () => ({
  enrichPendleBalances: (_f: string, _a: string, _c: number, rows: unknown) => rows,
  seedPendleChainBalances: (_f: string, _a: string, chainId: number) => ({
    chainId,
    tokensUpdated: 0,
    skipped: true,
  }),
}));

vi.mock("@vex-agent/db/repos/balances.js", () => ({
  replaceBalancesForChain: vi.fn().mockResolvedValue(0),
  getBalances: vi.fn().mockResolvedValue([]),
  getBalancesByChain: vi.fn().mockResolvedValue([]),
  insertSnapshot: vi.fn().mockResolvedValue({ snapshotId: 1, pnlVsPrev: null }),
  getLatestSnapshot: vi.fn().mockResolvedValue(null),
  getSnapshotHistory: vi.fn().mockResolvedValue([]),
}));

/**
 * The snapshot group is published inside ONE transaction that locks
 * `agent_activity` and reads the in-flight ledger under that lock. This suite
 * is about the cycle-start probe, so the fake client answers "nothing in
 * flight, and the activity generation did not move" - except when
 * `fenceRejection` is armed, which is the path under test.
 */
let fenceRejection: Error | null = null;
const mockDbQuery = vi.fn(async (sql: string) => {
  if (String(sql).includes("MAX(id)")) {
    if (fenceRejection !== null) throw fenceRejection;
    return {
      rows: [{ max_id: "0", row_count: "0", pending_count: "0", confirmed_count: "0" }],
      rowCount: 1,
    };
  }
  return { rows: [], rowCount: 0 };
});
const fakeDbClient = { query: (sql: string, params?: unknown[]) => mockDbQuery(sql, params) };
vi.mock("@vex-agent/db/client.js", () => ({
  getPool: () => fakeDbClient,
  withTransaction: (fn: (c: unknown) => Promise<unknown>) => fn(fakeDbClient),
}));

const { fullBalanceSync } = await import("../../../vex-agent/sync/balance-sync.js");

/** The literal shape a `pg` connection failure carries - password included. */
const SECRET_PASSWORD = "sup3rS3cretVexPgPassw0rd";
const SECRET_BEARING_MESSAGE =
  `connection to server at "db.internal" failed: ` +
  `postgres://vex:${SECRET_PASSWORD}@db.internal:5432/vex?sslmode=require ` +
  `Bearer eyJhbGciOiJIUzI1NiJ9.ZmFrZQ.c2ln`;

beforeEach(() => {
  vi.clearAllMocks();
  fenceRejection = null;
  mockScan.mockResolvedValue({ tokens: [], scannedChainIds: [], chainErrors: [] });
  mockGetCachedKhalaniChains.mockResolvedValue([{ id: 8453, name: "Base", type: "eip155" }]);
  mockListWallets.mockImplementation((family: string) =>
    family === "solana" ? [] : [{ id: "evm_1", address: "0xAAAaaa", label: "EVM 1", createdAt: "" }],
  );
});

function fenceProbeLogLine(): string {
  const call = mockWarn.mock.calls.find(([event]) => event === "sync.balance.activity_fence_failed");
  expect(call, "the probe failure must still be logged").toBeDefined();
  return JSON.stringify(call);
}

describe("cycle-start fence probe failure logging", () => {
  it("carries NO fragment of a secret-bearing rejection into the log line", async () => {
    fenceRejection = new Error(SECRET_BEARING_MESSAGE);

    await fullBalanceSync({ snapshot: "when-settled" });

    const line = fenceProbeLogLine();
    expect(line).not.toContain(SECRET_PASSWORD);
    expect(line).not.toContain("postgres://");
    expect(line).not.toContain("eyJhbGciOiJIUzI1NiJ9");
    expect(line).not.toContain("Bearer");
  });

  it("redacts a secret carried only on the `cause` of a wrapping throw", async () => {
    fenceRejection = new Error("fence probe failed", { cause: new Error(SECRET_BEARING_MESSAGE) });

    await fullBalanceSync({ snapshot: "when-settled" });

    const line = fenceProbeLogLine();
    expect(line).not.toContain(SECRET_PASSWORD);
    expect(line).not.toContain("postgres://");
  });

  it("bounds a pathologically long rejection instead of writing it whole", async () => {
    fenceRejection = new Error("x".repeat(20_000));

    await fullBalanceSync({ snapshot: "when-settled" });

    expect(fenceProbeLogLine().length).toBeLessThan(2_000);
  });

  it("still refuses the snapshot when the probe throws (conservative direction)", async () => {
    fenceRejection = new Error(SECRET_BEARING_MESSAGE);

    const result = await fullBalanceSync({ snapshot: "when-settled" });

    // Without a cycle-start stamp the transition fence can prove nothing, so
    // unknown stays fail-closed. This is the ONE probe failure that still
    // withholds a group; in-flight money never does.
    expect(result.snapshots).toHaveLength(0);
    expect(result.snapshotSkippedReason).toBe("gate_probe_failed");
  });
});
