import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  list: vi.fn(), findIntent: vi.fn(), findClaim: vi.fn(), expireClaim: vi.fn(),
  unsubmitted: vi.fn(), getLease: vi.fn(), auth: vi.fn(), reconcile: vi.fn(),
}));

vi.mock("@vex-agent/db/repos/lighter-withdrawal-intents.js", () => ({
  listReconciliationCandidates: mocks.list,
  findByIntentId: mocks.findIntent,
}));
vi.mock("@vex-agent/db/repos/lighter-withdrawal-claims.js", () => ({
  findLatestForWithdrawalIntent: mocks.findClaim,
  expirePreparedWith: mocks.expireClaim,
  markUnsubmittedFailureWith: mocks.unsubmitted,
}));
vi.mock("@vex-agent/db/repos/lighter-evm-execution-leases.js", () => ({
  getLighterEvmExecutionLease: mocks.getLease,
}));
vi.mock("@vex-agent/tools/protocols/lighter/read-account-auth.js", () => ({
  resolveLighterReadOnlyAccountAuth: mocks.auth,
}));
vi.mock("@vex-agent/tools/protocols/lighter/withdrawal-reconciliation.js", () => ({
  reconcileLighterWithdrawal: mocks.reconcile,
}));
vi.mock("@vex-agent/engine/runtime/lease-and-status/session-control-lock.js", () => ({
  withSessionControlLocks: vi.fn(async (_sessionIds: string[], fn: (db: object) => Promise<unknown>) => fn({})),
}));
vi.mock("@tools/lighter/client.js", () => ({ getLighterClient: vi.fn(() => ({})) }));
vi.mock("@tools/uniswap/deployments.js", () => ({ getUniswapDeployment: vi.fn(() => ({ chainId: 1 })) }));
vi.mock("@tools/uniswap/evm-client.js", () => ({ getUniswapPublicClient: vi.fn(() => ({})) }));

const { repairUnresolvedLighterWithdrawals } = await import(
  "@vex-agent/sync/lighter-withdrawal-repair.js"
);

function intent(state = "secure_waiting") {
  return {
    intentId: "withdrawal-1", sessionId: "session-1", accountIndex: 42,
    environment: "core", settlementChainId: 1,
    walletAddress: "0x1111111111111111111111111111111111111111", executionState: state,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.list.mockResolvedValue([intent()]);
  mocks.findClaim.mockResolvedValue(null);
  mocks.auth.mockResolvedValue({ accountIndex: 42 });
  mocks.reconcile.mockResolvedValue(intent("claimable"));
});

describe("background Lighter withdrawal repair", () => {
  it("does not unlock or reconcile when bounded read authorization is unavailable", async () => {
    mocks.auth.mockResolvedValue(null);
    await expect(repairUnresolvedLighterWithdrawals()).resolves.toMatchObject({
      examined: 1, advanced: 0, awaitingVault: 1, errors: 0,
    });
    expect(mocks.reconcile).not.toHaveBeenCalled();
  });

  it("advances only through the evidence reconciliation path", async () => {
    await expect(repairUnresolvedLighterWithdrawals()).resolves.toMatchObject({
      examined: 1, advanced: 1, awaitingVault: 0, errors: 0,
    });
    expect(mocks.reconcile).toHaveBeenCalledTimes(1);
  });

  it("uses RHC read authorization and settlement identity for RHC candidates", async () => {
    mocks.list.mockResolvedValue([{ ...intent(), environment: "rhc", settlementChainId: 4663 }]);
    mocks.reconcile.mockResolvedValue({ ...intent("claimable"), environment: "rhc", settlementChainId: 4663 });
    await expect(repairUnresolvedLighterWithdrawals()).resolves.toMatchObject({ advanced: 1, errors: 0 });
    expect(mocks.auth).toHaveBeenCalledWith("rhc", 42);
    expect(mocks.reconcile).toHaveBeenCalledWith(expect.objectContaining({
      intent: expect.objectContaining({ environment: "rhc", settlementChainId: 4663 }),
    }));
  });

  it("expires an abandoned prepared claim before continuing reconciliation", async () => {
    mocks.findClaim.mockResolvedValue({
      claimId: "claim-1", sessionId: "session-2", state: "prepared",
      expiresAt: "2000-01-01T00:00:00.000Z",
    });
    mocks.expireClaim.mockResolvedValue(true);
    mocks.findIntent.mockResolvedValue(intent("claimable"));
    await repairUnresolvedLighterWithdrawals();
    expect(mocks.expireClaim).toHaveBeenCalledWith({}, "claim-1", "session-2");
    expect(mocks.reconcile).toHaveBeenCalledWith(expect.objectContaining({
      intent: expect.objectContaining({ executionState: "claimable" }),
    }));
  });
});
