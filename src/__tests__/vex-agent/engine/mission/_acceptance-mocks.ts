/**
 * Shared vi.mock setup + fixtures for the `acceptance.ts` test split:
 * `acceptance.test.ts` (acceptContract), `acceptance-assert-status.test.ts`
 * (assertAcceptedContract status outcomes), and `acceptance-legacy-v2.test.ts`
 * (assertAcceptedContract frozen Hyperliquid-removal V2 compat case).
 *
 * Imported as named bindings BEFORE any dynamic import of `acceptance.js` in
 * each sibling file, so the vi.mock registrations below are in effect when
 * the module under test loads its repo/client dependencies (same pattern as
 * `src/__tests__/vex-agent/tools/_dispatcher-test-mocks.ts`).
 */

import { vi } from "vitest";

export const mockGetMissionForUpdate = vi.fn();
export const mockUpdateAcceptance = vi.fn();
export const mockGetActiveRun = vi.fn();
export const mockGetActivePlan = vi.fn();
export const mockSetAccepted = vi.fn();

vi.mock("@vex-agent/db/repos/missions.js", () => ({
  getMissionForUpdate: (...args: unknown[]) => mockGetMissionForUpdate(...args),
  updateAcceptance: (...args: unknown[]) => mockUpdateAcceptance(...args),
}));

vi.mock("@vex-agent/db/repos/mission-runs.js", () => ({
  getActiveRun: (...args: unknown[]) => mockGetActiveRun(...args),
}));

// Co-accept (Approach A) reaches `session-plans` for the enabled+unaccepted
// branch. Mocking the repo at its module boundary — same style as the missions
// / mission-runs repos above — gives precise control over `getActivePlan` and
// `setAccepted` per case. The default (no plan row) returns null so the existing
// contract-only outcomes behave byte-for-byte as before.
vi.mock("@vex-agent/db/repos/session-plans.js", () => ({
  getActivePlan: (...args: unknown[]) => mockGetActivePlan(...args),
  setAccepted: (...args: unknown[]) => mockSetAccepted(...args),
}));

// `withTransaction` is exercised for real — it just calls the fn with a
// fake client object and runs BEGIN/COMMIT against it. We mock the pool
// so the BEGIN/COMMIT noop doesn't error.
export const fakeClientQuery = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
const fakeClientRelease = vi.fn();

vi.mock("@vex-agent/db/client.js", () => ({
  getPool: () => ({
    connect: async () => ({
      query: fakeClientQuery,
      release: fakeClientRelease,
    }),
  }),
  // Keep `withTransaction` real so the BEGIN/COMMIT contract is exercised.
  withTransaction: async (fn: (client: unknown) => Promise<unknown>) => {
    const fakeClient = { query: fakeClientQuery, release: fakeClientRelease };
    await fakeClientQuery("BEGIN");
    try {
      const result = await fn(fakeClient);
      await fakeClientQuery("COMMIT");
      return result;
    } catch (err) {
      await fakeClientQuery("ROLLBACK");
      throw err;
    }
  },
  // The session-plans repo (co-accept path) is mocked above, so these tx-aware
  // query helpers are not reached today. Exported anyway — mirroring
  // commit-start.test.ts — so the mock stays complete if a future repo call
  // routes through them, instead of throwing "No export defined".
  executeWith: vi.fn(),
  queryOneWith: vi.fn().mockResolvedValue(null),
}));

export function makeMission(overrides: Record<string, unknown> = {}) {
  return {
    id: "mission-1",
    rootSessionId: "session-1",
    status: "ready",
    title: "SOL DCA",
    goal: "Accumulate 10 SOL",
    constraintsJson: { deadline: "2026-04-04" },
    successCriteriaJson: ["Accumulated 10 SOL"],
    stopConditionsJson: ["capital_depleted"],
    riskProfile: "conservative",
    capitalSourceJson: { type: "wallet", amount: "500 USDC" },
    allowedProtocols: ["jupiter"],
    allowedChains: ["solana"],
    allowedWallets: ["solana"],
    createdAt: "2026-05-22T10:00:00.000Z",
    updatedAt: "2026-05-22T10:00:00.000Z",
    approvedAt: null,
    acceptedContractHash: null,
    acceptedContractAt: null,
    acceptedContractBy: null,
    contractHashVersion: null,
    renewedFromMissionId: null,
    ...overrides,
  };
}

/**
 * A mapped `SessionPlan` (the repo's domain shape). Plan-mode OFF / no plan is
 * the default in `beforeEach` (getActivePlan → null); these fixtures cover the
 * enabled branches.
 */
export function makePlan(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: "session-1",
    enabled: true,
    planMd: "# Action plan\n1. Objective",
    acceptedAt: null as string | null,
    accepted: false,
    offNoticePending: false,
    createdAt: "2026-05-22T09:00:00.000Z",
    updatedAt: "2026-05-22T09:30:00.000Z",
    ...overrides,
  };
}
