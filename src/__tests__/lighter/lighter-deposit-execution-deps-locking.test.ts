import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  withSessionControlLock: vi.fn(),
  markAllowanceVerifiedWith: vi.fn(),
  markApproveSubmittedWith: vi.fn(),
  markApproveConfirmedWith: vi.fn(),
  markDepositSubmittedWith: vi.fn(),
  recordApproveReplacementWith: vi.fn(),
  recordDepositReplacementWith: vi.fn(),
  markDepositConfirmedWith: vi.fn(),
  markAmbiguousWith: vi.fn(),
  markFailedWith: vi.fn(),
}));

vi.mock("@vex-agent/engine/runtime/lease-and-status/session-control-lock.js", () => ({
  withSessionControlLock: (...args: unknown[]) =>
    mocks.withSessionControlLock(...args),
}));
vi.mock("@vex-agent/db/repos/lighter-onboarding-intents.js", () => ({
  markAllowanceVerifiedWith: mocks.markAllowanceVerifiedWith,
  markApproveSubmittedWith: mocks.markApproveSubmittedWith,
  markApproveConfirmedWith: mocks.markApproveConfirmedWith,
  markDepositSubmittedWith: mocks.markDepositSubmittedWith,
  recordApproveReplacementWith: mocks.recordApproveReplacementWith,
  recordDepositReplacementWith: mocks.recordDepositReplacementWith,
  markDepositConfirmedWith: mocks.markDepositConfirmedWith,
  markAmbiguousWith: mocks.markAmbiguousWith,
  markFailedWith: mocks.markFailedWith,
}));
vi.mock("@tools/uniswap/deployments.js", () => ({
  getUniswapDeployment: () => ({ chainId: 1 }),
}));
vi.mock("@tools/uniswap/evm-client.js", () => ({
  getUniswapEvmClients: () => ({ publicClient: {}, walletClient: {} }),
}));
vi.mock("@tools/lighter/wallet-funding/release-gates.js", () => ({
  LIGHTER_DEPOSIT_RELEASE_GATE: { isEnabled: () => false },
}));
vi.mock("@tools/evm-chains/staged-broadcast.js", () => ({
  signStageBroadcast: vi.fn(),
}));

const { buildLighterDepositExecutionDeps } = await import(
  "@tools/lighter/wallet-funding/deposit-execution-deps.js"
);

describe("Lighter deposit execution lifecycle locking", () => {
  it("routes every executor state write through the owning session lock", async () => {
    const lockedClient = { marker: "locked-client" };
    mocks.withSessionControlLock.mockImplementation(async (_sessionId, write) =>
      write(lockedClient));
    for (const writer of [
      mocks.markAllowanceVerifiedWith,
      mocks.markApproveSubmittedWith,
      mocks.markApproveConfirmedWith,
      mocks.markDepositSubmittedWith,
      mocks.recordApproveReplacementWith,
      mocks.recordDepositReplacementWith,
      mocks.markDepositConfirmedWith,
      mocks.markAmbiguousWith,
      mocks.markFailedWith,
    ]) {
      writer.mockResolvedValue(null);
    }

    const deps = buildLighterDepositExecutionDeps({
      privateKey: `0x${"1".repeat(64)}`,
      sessionId: "session-1",
      assertExecutionLease: vi.fn(),
    });

    await deps.intents.markAllowanceVerified("intent-1");
    const approveStaged = {
      txHash: `0x${"a".repeat(64)}`,
      fromAddress: "0x1111111111111111111111111111111111111111",
      nonce: 7,
    };
    const depositStaged = {
      txHash: `0x${"b".repeat(64)}`,
      fromAddress: "0x1111111111111111111111111111111111111111",
      nonce: 8,
    };
    await deps.intents.markApproveSubmitted("intent-1", approveStaged);
    await deps.intents.markApproveConfirmed("intent-1", `0x${"a".repeat(64)}`);
    await deps.intents.markDepositSubmitted("intent-1", depositStaged);
    const replacement = {
      originalTxHash: approveStaged.txHash,
      replacementTxHash: `0x${"d".repeat(64)}`,
      reason: "repriced" as const,
      observedAt: new Date("2030-01-01T00:00:00.000Z"),
    };
    await deps.intents.recordApproveReplacement("intent-1", replacement);
    await deps.intents.recordDepositReplacement("intent-1", {
      ...replacement,
      originalTxHash: depositStaged.txHash,
      replacementTxHash: `0x${"e".repeat(64)}`,
    });
    await deps.intents.markDepositConfirmed("intent-1", {
      txHash: `0x${"b".repeat(64)}`,
      blockHash: `0x${"c".repeat(64)}`,
      blockNumber: "123",
      accountIndex: 42,
      walletAddress: "0x1111111111111111111111111111111111111111",
      assetIndex: 3,
      routeType: 0,
      amountUnits: "11000000",
    });
    await deps.intents.markAmbiguous("intent-1", "uncertain");
    await deps.intents.markFailed("intent-1", "reverted");

    expect(mocks.withSessionControlLock).toHaveBeenCalledTimes(9);
    for (const call of mocks.withSessionControlLock.mock.calls) {
      expect(call[0]).toBe("session-1");
    }
    expect(mocks.markApproveSubmittedWith).toHaveBeenCalledWith(
      lockedClient,
      "intent-1",
      approveStaged,
    );
    expect(mocks.markDepositSubmittedWith).toHaveBeenCalledWith(
      lockedClient,
      "intent-1",
      depositStaged,
    );
  });
});
