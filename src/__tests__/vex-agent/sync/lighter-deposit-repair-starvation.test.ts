import { beforeEach, describe, expect, it, vi } from "vitest";

import { onboardingIntent } from "../../helpers/lighter-intents.js";

import type {
  LighterOnboardingIntentRow,
  LighterUnresolvedDepositCursor,
  LighterUnresolvedDepositPage,
} from "@vex-agent/db/repos/lighter-onboarding-intents.js";

/**
 * The starvation history Codex reproduced against round 1: 25 older core
 * deposits that no evidence can move plus ONE newer rhc deposit. The old
 * production reader asked each environment for the same limit and offset,
 * merged the two pages, sorted by updatedAt and sliced back to the limit, so
 * the newest row fell off every slice and no rotation offset could ever reach
 * it. This test drives the REAL production dependency wiring over a stubbed
 * repository, which is the seam that defect lived at.
 */

const mocks = vi.hoisted(() => ({
  listUnresolvedDeposits: vi.fn(),
  query: vi.fn(async () => {
    throw new Error("the deposit sweep must not reach the database in this test");
  }),
  getTxFromL1: vi.fn(),
  getAccountsByL1Address: vi.fn(),
  getUniswapDeployment: vi.fn((chainId: number) => ({ chainId })),
  getUniswapPublicClient: vi.fn(() => ({
    getTransactionReceipt: vi.fn(),
  })),
}));

vi.mock("@vex-agent/db/client.js", () => ({
  query: mocks.query,
  queryOne: mocks.query,
  execute: mocks.query,
}));
vi.mock("@vex-agent/db/repos/lighter-onboarding-intents.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@vex-agent/db/repos/lighter-onboarding-intents.js")>()),
  listUnresolvedDeposits: mocks.listUnresolvedDeposits,
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

const {
  LIGHTER_DEPOSIT_REPAIR_ROTATION_PERIOD_MS,
  LIGHTER_DEPOSIT_REPAIR_SWEEP_LIMIT,
  buildProductionLighterDepositRepairDeps,
  repairUnresolvedLighterDeposits,
} = await import("@vex-agent/sync/lighter-deposit-repair.js");

function pendingIntent(
  environment: "core" | "rhc",
  index: number,
  updatedAt: string,
): LighterOnboardingIntentRow {
  return onboardingIntent({
    intentId: `lighter-onboard-${environment}-${String(index).padStart(4, "0")}`,
    environment,
    chainId: environment === "rhc" ? 4663 : 1,
    depositContract: environment === "rhc"
      ? "0x94bAB9693Ba2f6358507eFfcbd372b0660AFfF9d"
      : "0x3B4D794a66304F130a4Db8F2551B0070dfCf5ca7",
    approvalStatus: "approval_pending",
    executionState: "approval_pending",
    updatedAt: new Date(updatedAt),
  });
}

const STARVED_RHC = pendingIntent("rhc", 0, "2030-01-01T11:00:00.000Z");

const HISTORY: readonly LighterOnboardingIntentRow[] = [
  ...Array.from({ length: LIGHTER_DEPOSIT_REPAIR_SWEEP_LIMIT }, (_value, index) =>
    pendingIntent("core", index, `2030-01-01T10:${String(index).padStart(2, "0")}:00.000Z`)),
  STARVED_RHC,
];

/** The repository contract: one global order, keyset paging, limit + 1 lookahead. */
function keysetPage(page: {
  readonly limit: number;
  readonly cursor: LighterUnresolvedDepositCursor | null;
}): LighterUnresolvedDepositPage {
  const after = page.cursor;
  const remaining = after === null
    ? [...HISTORY]
    : HISTORY.filter((row) => (
      row.updatedAt.getTime() > after.updatedAt.getTime()
      || (row.updatedAt.getTime() === after.updatedAt.getTime()
        && row.intentId > after.intentId)
    ));
  const window = remaining.slice(0, page.limit);
  const last = window.at(-1);
  return {
    rows: window,
    hasMore: remaining.length > page.limit,
    nextCursor: last === undefined
      ? null
      : { updatedAt: last.updatedAt, intentId: last.intentId },
  };
}

describe("Lighter deposit repair over the production repository wiring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listUnresolvedDeposits.mockImplementation(async (page: {
      readonly limit: number;
      readonly cursor: LighterUnresolvedDepositCursor | null;
    }) => keysetPage(page));
  });

  it("examines the one newer rhc deposit behind 25 unresolvable core deposits", async () => {
    const base = buildProductionLighterDepositRepairDeps();
    const examined: string[] = [];

    for (let sweep = 0; sweep < 2; sweep += 1) {
      const result = await repairUnresolvedLighterDeposits({
        ...base,
        now: () => sweep * LIGHTER_DEPOSIT_REPAIR_ROTATION_PERIOD_MS,
      });
      examined.push(...result.reports.map((entry) => entry.intentId));
    }

    // The row that used to be unreachable now has a repair report of its own.
    const rhcReport = examined.filter((intentId) => intentId === STARVED_RHC.intentId);
    expect(rhcReport).toHaveLength(1);
    expect(new Set(examined).size).toBe(HISTORY.length);
    // Approval-pending rows never touch a provider: the fairness fix does not
    // buy reachability with extra chain or Lighter traffic.
    expect(mocks.getTxFromL1).not.toHaveBeenCalled();
    expect(mocks.getAccountsByL1Address).not.toHaveBeenCalled();
    expect(mocks.query).not.toHaveBeenCalled();
  });
});
