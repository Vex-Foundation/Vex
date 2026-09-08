import { beforeEach, describe, expect, it, vi } from "vitest";

import { onboardingIntent } from "../../helpers/lighter-intents.js";

import type {
  LighterDepositRepairAttemptResult,
  LighterOnboardingIntentRow,
  LighterUnresolvedDepositQueuePage,
} from "@vex-agent/db/repos/lighter-onboarding-intents.js";

/**
 * The starvation history the round-1 review reproduced: 25 older core
 * deposits that no evidence can move plus ONE newer rhc deposit. The old
 * production reader asked each environment for the same limit and offset,
 * merged the two pages, sorted by updatedAt and sliced back to the limit, so
 * the newest row fell off every slice and no rotation offset could ever reach
 * it. This test drives the REAL production dependency wiring over a stubbed
 * repository, which is the seam that defect lived at.
 */

const mocks = vi.hoisted(() => ({
  listUnresolvedDepositsByAttempt: vi.fn(),
  recordDepositRepairAttempt: vi.fn(),
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

const {
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

/**
 * The repository contract: one order over BOTH environments, least recently
 * attempted first, with the same `limit + 1` lookahead the SQL uses. The
 * attempt markers the sweep writes are durable here, exactly as they are in the
 * table, so the second sweep's order is computed from the first sweep's work.
 */
const attempts = new Map<string, number>();
let attemptClock = 0;

function attemptOrderedPage(page: { readonly limit: number }): LighterUnresolvedDepositQueuePage {
  const ordered = [...HISTORY].sort((left, right) => {
    const leftAt = attempts.get(left.intentId);
    const rightAt = attempts.get(right.intentId);
    if (leftAt !== rightAt) {
      if (leftAt === undefined) return -1;
      if (rightAt === undefined) return 1;
      return leftAt - rightAt;
    }
    return left.updatedAt.getTime() - right.updatedAt.getTime()
      || left.intentId.localeCompare(right.intentId);
  });
  return { rows: ordered.slice(0, page.limit), hasMore: ordered.length > page.limit };
}

describe("Lighter deposit repair over the production repository wiring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    attempts.clear();
    attemptClock = 0;
    mocks.listUnresolvedDepositsByAttempt.mockImplementation(
      async (page: { readonly limit: number }) => attemptOrderedPage(page),
    );
    mocks.recordDepositRepairAttempt.mockImplementation(
      async (intentId: string, _result: LighterDepositRepairAttemptResult) => {
        attemptClock += 1;
        attempts.set(intentId, attemptClock);
        return true;
      },
    );
  });

  it("examines the one newer rhc deposit behind 25 unresolvable core deposits", async () => {
    const base = buildProductionLighterDepositRepairDeps();
    const examined: string[] = [];

    for (let sweep = 0; sweep < 2; sweep += 1) {
      const result = await repairUnresolvedLighterDeposits(base);
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
