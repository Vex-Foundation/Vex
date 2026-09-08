import { beforeEach, describe, expect, it, vi } from "vitest";

import type { LighterOnboardingIntentRow } from "@vex-agent/db/repos/lighter-onboarding-intents.js";

const WALLET = "0x1111111111111111111111111111111111111111";
const RHC_GATEWAY = "0x94bAB9693Ba2f6358507eFfcbd372b0660AFfF9d";
const TX_HASH = `0x${"a".repeat(64)}` as const;

const mocks = vi.hoisted(() => ({
  listUnresolvedDepositsByAttempt: vi.fn(),
  recordDepositRepairAttempt: vi.fn(),
  getTxFromL1: vi.fn(),
  getAccountsByL1Address: vi.fn(),
  getUniswapDeployment: vi.fn(),
  getUniswapPublicClient: vi.fn(),
  getTransactionReceipt: vi.fn(),
}));

vi.mock("@vex-agent/db/repos/lighter-onboarding-intents.js", () => ({
  listUnresolvedDepositsByAttempt: mocks.listUnresolvedDepositsByAttempt,
  recordDepositRepairAttempt: mocks.recordDepositRepairAttempt,
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
const { buildProductionLighterDepositRepairDeps } = await import(
  "@vex-agent/sync/lighter-deposit-repair.js"
);

function rhcIntent(): LighterOnboardingIntentRow {
  return {
    intentId: "lighter-onboard-rhc-1",
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
    mocks.listUnresolvedDepositsByAttempt.mockImplementation(async () => ({
      rows: [rhcIntent()],
      hasMore: false,
    }));
    mocks.recordDepositRepairAttempt.mockResolvedValue(true);
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

  it("reads both environments in one order and routes RHC evidence to chain 4663 and RHC APIs", async () => {
    const deps = buildProductionLighterDepositRepairDeps();
    const page = await deps.listUnresolvedDepositsByAttempt({ limit: 25 });
    const [row] = page.rows;
    if (row === undefined) throw new Error("missing RHC fixture");
    expect(page.hasMore).toBe(false);

    await deps.readReceipt(row, TX_HASH);
    await deps.readLighterTx(row, TX_HASH);
    await deps.readOwnedAccounts(row, WALLET);

    // One globally ordered query, not one page per environment: a page that
    // one environment fills cannot hide the other environment's rows.
    expect(mocks.listUnresolvedDepositsByAttempt).toHaveBeenCalledTimes(1);
    expect(mocks.listUnresolvedDepositsByAttempt).toHaveBeenCalledWith({ limit: 25 });
    expect(mocks.getUniswapDeployment).toHaveBeenCalledWith(4663);
    expect(mocks.getTxFromL1).toHaveBeenCalledWith("rhc", { hash: TX_HASH });
    expect(mocks.getAccountsByL1Address).toHaveBeenCalledWith("rhc", {
      l1Address: WALLET,
      cursor: undefined,
    });
  });

  it("routes the attempt marker to the repository and never throws it into the sweep", async () => {
    const deps = buildProductionLighterDepositRepairDeps();
    const row = rhcIntent();

    await deps.recordRepairAttempt(row, "attempted");
    expect(mocks.recordDepositRepairAttempt).toHaveBeenCalledWith(row.intentId, "attempted");

    // A marker write that fails must not turn one row into the whole sweep's
    // failure: that is the starvation the marker exists to prevent, arriving
    // through the back door.
    mocks.recordDepositRepairAttempt.mockRejectedValueOnce(new Error("database unavailable"));
    await expect(deps.recordRepairAttempt(row, "awaiting")).resolves.toBeUndefined();
  });

  it("repairs RHC without per-user RPC configuration", async () => {
    const deps = buildProductionLighterDepositRepairDeps();

    await expect(deps.readReceipt(rhcIntent(), TX_HASH)).resolves.toBeDefined();
    expect(mocks.getUniswapDeployment).toHaveBeenCalledWith(4663);
    expect(mocks.getUniswapPublicClient).toHaveBeenCalled();
  });
});
