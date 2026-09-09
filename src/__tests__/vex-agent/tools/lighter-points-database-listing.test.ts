import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readLighterPointsForWallets } from "@vex-agent/tools/protocols/lighter/points.js";
import { configureLighterReadOnlyAccountAuthOutcomeResolver } from "@vex-agent/tools/protocols/lighter/read-account-auth.js";
import { POINTS_FIXTURE } from "../../lighter/points-fixture.js";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  leaderboard: vi.fn(),
  live: vi.fn(),
  referral: vi.fn(),
}));
vi.mock("@vex-agent/db/client.js", () => ({ query: mocks.query, queryOne: vi.fn() }));
vi.mock("@tools/lighter/client.js", () => ({ getLighterClient: () => ({
  getLeaderboard: mocks.leaderboard,
  getLivePointsTotal: mocks.live,
  getReferralPoints: mocks.referral,
}) }));

const WALLET = "0x1111111111111111111111111111111111111111";
const OTHER = "0x2222222222222222222222222222222222222222";
let dispose: (() => void) | undefined;
beforeEach(() => {
  vi.resetAllMocks();
  mocks.leaderboard.mockResolvedValue(POINTS_FIXTURE.anonymousAllForWallet);
  mocks.live.mockResolvedValue(POINTS_FIXTURE.livePoints);
  mocks.referral.mockResolvedValue(POINTS_FIXTURE.referralPoints);
});
afterEach(() => { dispose?.(); });

describe("points database listing joined to local authorization", () => {
  it("uses every resolved workflow, joining by environment and account independently", async () => {
    mocks.query.mockResolvedValue([
      { environment: "rhc", wallet_address: WALLET, resolved_account_index: "123",
        api_key_index: 4, public_key_fingerprint: "test-public-fingerprint", workflow_state: "ready_to_trade", last_stable_state: "ready_to_trade", total_count: "3" },
      { environment: "core", wallet_address: WALLET, resolved_account_index: "123",
        api_key_index: 5, public_key_fingerprint: "test-public-fingerprint", workflow_state: "ready_to_trade", last_stable_state: "ready_to_trade", total_count: "3" },
      { environment: "rhc", wallet_address: OTHER, resolved_account_index: "456",
        api_key_index: null, public_key_fingerprint: null, workflow_state: "account_resolved", last_stable_state: "account_resolved", total_count: "3" },
    ]);
    const resolveAuth = vi.fn(async (environment: string, accountIndex: number) =>
      environment === "core"
        ? { kind: "auth" as const, auth: { token: "test-read-authorization", accountIndex } }
        : { kind: "unavailable" as const, reason: "no_credential" as const, detail: "No local credential." });
    dispose = configureLighterReadOnlyAccountAuthOutcomeResolver(resolveAuth);

    const report = await readLighterPointsForWallets({ signal: new AbortController().signal });

    expect(report.walletCount).toBe(3);
    expect(report.rows).toMatchObject([
      { kind: "credential_missing_here", environment: "rhc", accountIndex: 123,
        apiKeyIndex: 4, tradingKeyRegistered: true, walletAddress: WALLET },
      { kind: "points", environment: "core", accountIndex: 123, walletAddress: WALLET },
      { kind: "credential_missing_here", environment: "rhc", accountIndex: 456,
        apiKeyIndex: null, tradingKeyRegistered: false, walletAddress: OTHER },
    ]);
    expect(resolveAuth.mock.calls).toEqual([["rhc", 123], ["core", 123], ["rhc", 456]]);
    expect(mocks.leaderboard).toHaveBeenCalledTimes(2);
    expect(mocks.live).toHaveBeenCalledTimes(1);
    expect(mocks.referral).toHaveBeenCalledTimes(1);
    const query = mocks.query.mock.calls[0];
    expect(query?.[0]).toContain("WHERE resolved_account_index IS NOT NULL");
    expect(query?.[0]).not.toContain("workflow_state =");
    expect(query?.[1]).toEqual([100]);
    for (const row of report.rows) expect(row).not.toHaveProperty("publicKeyFingerprint");
  });

  it("reports empty only when the database has no resolved accounts", async () => {
    mocks.query.mockResolvedValue([]);
    const resolveAuth = vi.fn();
    dispose = configureLighterReadOnlyAccountAuthOutcomeResolver(resolveAuth);
    const report = await readLighterPointsForWallets({ signal: new AbortController().signal });
    expect(report).toMatchObject({ rows: [], walletCount: 0 });
    expect(resolveAuth).not.toHaveBeenCalled();
    expect(mocks.leaderboard).not.toHaveBeenCalled();
  });

  it("propagates unavailable database state instead of returning an empty list", async () => {
    mocks.query.mockRejectedValue(new Error("Test database unavailable."));
    await expect(readLighterPointsForWallets({ signal: new AbortController().signal }))
      .rejects.toThrow("Test database unavailable.");
    expect(mocks.leaderboard).not.toHaveBeenCalled();
  });

  it("rejects invalid persisted key indexes before local authorization", async () => {
    mocks.query.mockResolvedValue([{ environment: "rhc", wallet_address: WALLET,
      resolved_account_index: "123", api_key_index: 255,
      public_key_fingerprint: "test-public-fingerprint", workflow_state: "ready_to_trade", last_stable_state: "ready_to_trade", total_count: "1" }]);
    const resolveAuth = vi.fn();
    dispose = configureLighterReadOnlyAccountAuthOutcomeResolver(resolveAuth);
    await expect(readLighterPointsForWallets({ signal: new AbortController().signal }))
      .rejects.toThrow("api_key_index is not a safe integer");
    expect(resolveAuth).not.toHaveBeenCalled();
  });
});
