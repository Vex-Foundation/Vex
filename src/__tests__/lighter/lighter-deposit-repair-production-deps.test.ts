import { beforeEach, describe, expect, it, vi } from "vitest";

import type { LighterOnboardingIntentRow } from "@vex-agent/db/repos/lighter-onboarding-intents.js";

const WALLET = "0x1111111111111111111111111111111111111111";
const RHC_GATEWAY = "0x94bAB9693Ba2f6358507eFfcbd372b0660AFfF9d";
const TX_HASH = `0x${"a".repeat(64)}` as const;

const mocks = vi.hoisted(() => ({
  listUnresolved: vi.fn(),
  getTxFromL1: vi.fn(),
  getAccountsByL1Address: vi.fn(),
  getUniswapDeployment: vi.fn(),
  getUniswapPublicClient: vi.fn(),
  getTransactionReceipt: vi.fn(),
  getLocalChain: vi.fn(),
  getConfiguredLocalChainRpcUrl: vi.fn(),
}));

vi.mock("@vex-agent/db/repos/lighter-onboarding-intents.js", () => ({
  listUnresolved: mocks.listUnresolved,
}));
vi.mock("@tools/lighter/client.js", () => ({
  LighterClient: class {
    getTxFromL1 = mocks.getTxFromL1;
    getAccountsByL1Address = mocks.getAccountsByL1Address;
  },
}));
vi.mock("@tools/uniswap/deployments.js", () => ({
  getUniswapDeployment: mocks.getUniswapDeployment,
}));
vi.mock("@tools/uniswap/evm-client.js", () => ({
  getUniswapPublicClient: mocks.getUniswapPublicClient,
}));
vi.mock("@tools/evm-chains/registry.js", () => ({
  getLocalChain: mocks.getLocalChain,
  getConfiguredLocalChainRpcUrl: mocks.getConfiguredLocalChainRpcUrl,
}));

const { buildProductionLighterDepositRepairDeps } = await import(
  "@vex-agent/sync/lighter-deposit-repair.js"
);

function rhcIntent(): LighterOnboardingIntentRow {
  return {
    environment: "rhc",
    capability: "deposit",
    chainId: 4663,
    walletAddress: WALLET,
    depositContract: RHC_GATEWAY,
    depositTo: WALLET,
    assetIndex: 3,
    routeType: 0,
    updatedAt: new Date("2030-01-01T00:00:00.000Z"),
  } as LighterOnboardingIntentRow;
}

describe("production Lighter deposit repair dependencies", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listUnresolved.mockImplementation(async (environment: string) =>
      environment === "rhc" ? [rhcIntent()] : []);
    mocks.getLocalChain.mockReturnValue({ id: 4663 });
    mocks.getConfiguredLocalChainRpcUrl.mockReturnValue("https://managed.example/rhc");
    mocks.getUniswapDeployment.mockImplementation((chainId: number) => ({ chainId }));
    mocks.getUniswapPublicClient.mockReturnValue({
      getTransactionReceipt: mocks.getTransactionReceipt,
    });
    mocks.getTransactionReceipt.mockResolvedValue({
      status: "success",
      transactionHash: TX_HASH,
      blockHash: `0x${"b".repeat(64)}`,
      blockNumber: 40_124_106n,
      from: WALLET,
      to: RHC_GATEWAY,
      logs: [],
    });
    mocks.getTxFromL1.mockResolvedValue({ code: 200 });
    mocks.getAccountsByL1Address.mockResolvedValue({
      code: 200,
      l1_address: WALLET,
      sub_accounts: [],
    });
  });

  it("discovers both environments and routes RHC evidence reads to chain 4663 and RHC APIs", async () => {
    const deps = buildProductionLighterDepositRepairDeps();
    const [row] = await deps.listUnresolved();
    if (row === undefined) throw new Error("missing RHC fixture");

    await deps.readReceipt(row, TX_HASH);
    await deps.readLighterTx(row, TX_HASH);
    await deps.readOwnedAccounts(row, WALLET);

    expect(mocks.listUnresolved).toHaveBeenCalledWith("core");
    expect(mocks.listUnresolved).toHaveBeenCalledWith("rhc");
    expect(mocks.getUniswapDeployment).toHaveBeenCalledWith(4663);
    expect(mocks.getTxFromL1).toHaveBeenCalledWith("rhc", { hash: TX_HASH });
    expect(mocks.getAccountsByL1Address).toHaveBeenCalledWith("rhc", {
      l1Address: WALLET,
      cursor: undefined,
    });
  });

  it("never repairs RHC through the bundled public fallback", async () => {
    mocks.getConfiguredLocalChainRpcUrl.mockReturnValueOnce(null);
    const deps = buildProductionLighterDepositRepairDeps();

    await expect(deps.readReceipt(rhcIntent(), TX_HASH)).rejects.toThrow(
      "requires the explicitly configured production RPC",
    );
    expect(mocks.getUniswapPublicClient).not.toHaveBeenCalled();
  });
});
