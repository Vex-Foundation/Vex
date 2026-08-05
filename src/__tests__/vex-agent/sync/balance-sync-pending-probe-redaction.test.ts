/**
 * CANARY — the pending-activity snapshot probe must never log a raw throw.
 *
 * `fullBalanceSync({ snapshot: "when-settled" })` — the PERIODIC/worker policy,
 * which is the one the background pipeline actually uses — asks
 * `hasPendingActivityForWallets` whether any row is still in flight. That probe
 * talks to Postgres, and a driver/connection failure carries the connection
 * string (and therefore the password) in its message. The site logged
 * `err.message` verbatim, so a DB outage wrote the credential into the log file;
 * the logger performs no redaction of its own (rule 06).
 *
 * This suite drives the REAL `isSnapshotAllowed` path by rejecting the probe,
 * and asserts that not one fragment of the secret-bearing text survives into the
 * emitted log line. The pre-existing IPC-level canary cannot see this: it mocks
 * `refreshPortfolioNow` wholesale, and manual refresh uses `snapshot: "always"`,
 * which bypasses the probe entirely.
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

const mockHasPendingActivity = vi.fn();
vi.mock("@vex-agent/db/repos/agent-activity.js", () => ({
  hasPendingActivityForWallets: (...a: unknown[]) => mockHasPendingActivity(...a),
}));

const { fullBalanceSync } = await import("../../../vex-agent/sync/balance-sync.js");

/** The literal shape a `pg` connection failure carries — password included. */
const SECRET_PASSWORD = "sup3rS3cretVexPgPassw0rd";
const SECRET_BEARING_MESSAGE =
  `connection to server at "db.internal" failed: ` +
  `postgres://vex:${SECRET_PASSWORD}@db.internal:5432/vex?sslmode=require ` +
  `Bearer eyJhbGciOiJIUzI1NiJ9.ZmFrZQ.c2ln`;

beforeEach(() => {
  vi.clearAllMocks();
  mockScan.mockResolvedValue({ tokens: [], scannedChainIds: [], chainErrors: [] });
  mockGetCachedKhalaniChains.mockResolvedValue([{ id: 8453, name: "Base", type: "eip155" }]);
  mockListWallets.mockImplementation((family: string) =>
    family === "solana" ? [] : [{ id: "evm_1", address: "0xAAAaaa", label: "EVM 1", createdAt: "" }],
  );
});

function pendingProbeLogLine(): string {
  const call = mockWarn.mock.calls.find(([event]) => event === "sync.balance.pending_probe_failed");
  expect(call, "the probe failure must still be logged").toBeDefined();
  return JSON.stringify(call);
}

describe("pending-activity probe failure logging", () => {
  it("carries NO fragment of a secret-bearing rejection into the log line", async () => {
    mockHasPendingActivity.mockRejectedValue(new Error(SECRET_BEARING_MESSAGE));

    await fullBalanceSync({ snapshot: "when-settled" });

    const line = pendingProbeLogLine();
    expect(line).not.toContain(SECRET_PASSWORD);
    expect(line).not.toContain("postgres://");
    expect(line).not.toContain("eyJhbGciOiJIUzI1NiJ9");
    expect(line).not.toContain("Bearer");
  });

  it("redacts a secret carried only on the `cause` of a wrapping throw", async () => {
    mockHasPendingActivity.mockRejectedValue(
      new Error("pending probe failed", { cause: new Error(SECRET_BEARING_MESSAGE) }),
    );

    await fullBalanceSync({ snapshot: "when-settled" });

    const line = pendingProbeLogLine();
    expect(line).not.toContain(SECRET_PASSWORD);
    expect(line).not.toContain("postgres://");
  });

  it("bounds a pathologically long rejection instead of writing it whole", async () => {
    mockHasPendingActivity.mockRejectedValue(new Error("x".repeat(20_000)));

    await fullBalanceSync({ snapshot: "when-settled" });

    expect(pendingProbeLogLine().length).toBeLessThan(2_000);
  });

  it("still refuses the snapshot when the probe throws (conservative direction)", async () => {
    mockHasPendingActivity.mockRejectedValue(new Error(SECRET_BEARING_MESSAGE));

    const result = await fullBalanceSync({ snapshot: "when-settled" });

    expect(result.snapshots).toHaveLength(0);
  });
});
