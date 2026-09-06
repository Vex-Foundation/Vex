import { onboardingIntent } from "../helpers/lighter-intents.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

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
  getUniswapDeployment: vi.fn((chainId: number) => ({ chainId })),
  getUniswapEvmClients: vi.fn(),
  readContract: vi.fn(),
  getLocalChain: vi.fn(),
  getLocalChainRpcUrl: vi.fn(),
  readDepositPreflight: vi.fn(),
  assertPreflightWithinApproval: vi.fn(),
  runtimeFeeSafetyLimit: vi.fn(),
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
  getUniswapDeployment: mocks.getUniswapDeployment,
}));
vi.mock("@tools/uniswap/evm-client.js", () => ({
  getUniswapEvmClients: mocks.getUniswapEvmClients,
}));
vi.mock("@tools/evm-chains/staged-broadcast.js", () => ({
  signStageBroadcast: vi.fn(),
}));
vi.mock("@tools/evm-chains/registry.js", () => ({
  getLocalChain: mocks.getLocalChain,
  getLocalChainRpcUrl: mocks.getLocalChainRpcUrl,
}));
vi.mock("@tools/lighter/wallet-funding/deposit-preflight.js", () => ({
  LIGHTER_DEPOSIT_FEE_PREFLIGHT_COMPLETE: true,
  readLighterDepositPreflight: mocks.readDepositPreflight,
}));
vi.mock("@tools/lighter/wallet-funding/deposit-pre-sign.js", () => ({
  assertLighterDepositPreflightWithinApproval: mocks.assertPreflightWithinApproval,
  runtimeFeeSafetyLimit: mocks.runtimeFeeSafetyLimit,
}));

const { buildLighterDepositExecutionDeps } = await import(
  "@tools/lighter/wallet-funding/deposit-execution-deps.js"
);

describe("Lighter deposit execution lifecycle locking", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getUniswapDeployment.mockImplementation((chainId: number) => ({ chainId }));
    mocks.getUniswapEvmClients.mockReturnValue({
      publicClient: { readContract: mocks.readContract },
      walletClient: {},
    });
    mocks.getLocalChain.mockReturnValue({ id: 4663 });
    mocks.getLocalChainRpcUrl.mockReturnValue(
      "https://rpc.mainnet.chain.robinhood.com",
    );
    mocks.readDepositPreflight.mockResolvedValue({ approvalRequired: false });
    mocks.runtimeFeeSafetyLimit.mockReturnValue({
      gasLimit: 200_000n,
      maxFeePerGas: 20_000_000_000n,
      maxPriorityFeePerGas: 2_000_000_000n,
      maxNetworkFeeWei: 4_000_000_000_000_000n,
    });
  });

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
      environment: "core",
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

  it("binds an RHC approval read to chain 4663, USDG, and the exact gateway", async () => {
    const wallet = "0x1111111111111111111111111111111111111111";
    const gateway = "0x94bAB9693Ba2f6358507eFfcbd372b0660AFfF9d";
    mocks.readContract.mockResolvedValueOnce(11_000_000n);
    const deps = buildLighterDepositExecutionDeps({
      environment: "rhc",
      privateKey: `0x${"1".repeat(64)}`,
      sessionId: "session-rhc",
      assertExecutionLease: vi.fn().mockResolvedValue(undefined),
    });

    const result = await deps.runApproveLegIfNeeded({
      walletAddress: wallet,
      spender: gateway,
      amountUnits: 11_000_000n,
      feeCeiling: {
        gasLimit: 100_000n,
        maxFeePerGas: 20_000_000_000n,
        maxPriorityFeePerGas: 2_000_000_000n,
        maxNetworkFeeWei: 2_000_000_000_000_000n,
      },
      onHashStaged: vi.fn(),
    });

    expect(result).toEqual({ skipped: true });
    expect(mocks.getUniswapDeployment).toHaveBeenCalledWith(4663);
    expect(mocks.readContract).toHaveBeenCalledWith(expect.objectContaining({
      address: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
      functionName: "allowance",
      args: [wallet, gateway],
    }));
  });

  it("revalidates RHC through the exact signer client and rejects RPC rotation", async () => {
    const publicClient = { readContract: mocks.readContract };
    mocks.getUniswapEvmClients.mockReturnValueOnce({ publicClient, walletClient: {} });
    const deps = buildLighterDepositExecutionDeps({
      environment: "rhc",
      privateKey: `0x${"1".repeat(64)}`,
      sessionId: "session-rhc",
      assertExecutionLease: vi.fn().mockResolvedValue(undefined),
    });
    const intent = onboardingIntent({
      amountUnits: "11000000",
      walletAddress: "0x1111111111111111111111111111111111111111",
      routeType: 0,
      executionState: "approved",
    });

    await deps.assertFreshPreSignPreflight(intent, "deposit");
    expect(mocks.readDepositPreflight).toHaveBeenCalledWith(expect.objectContaining({
      environment: "rhc",
      publicClient,
    }));

    mocks.getLocalChainRpcUrl.mockReturnValueOnce("https://rotated.example/rhc");
    await expect(deps.assertFreshPreSignPreflight(intent, "deposit")).rejects.toThrow(
      "RPC changed after the signer client was created",
    );
    expect(mocks.readDepositPreflight).toHaveBeenCalledTimes(1);
  });

  it("creates an RHC signer client with the backend public endpoint", () => {
    expect(() => buildLighterDepositExecutionDeps({
      environment: "rhc",
      privateKey: `0x${"1".repeat(64)}`,
      sessionId: "session-rhc",
      assertExecutionLease: vi.fn(),
    })).not.toThrow();
    expect(mocks.getLocalChainRpcUrl).toHaveBeenCalledWith({ id: 4663 });
    expect(mocks.getUniswapEvmClients).toHaveBeenCalled();
  });
});
