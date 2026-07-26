/**
 * Unit tests for `engine/mission/diff.ts` (`getContractStatus`).
 *
 * Agent Scan Phase 3, Batch 3b closure card FIX-A: confirms the H4 freeze
 * guarantee still holds once the renew-internals stripping fix exists — a
 * mission ACCEPTED while `CONTRACT_HASH_VERSION` was 2 (carrying a historical
 * `constraints_json.hyperliquidRisk` envelope) must keep reading
 * `isAccepted: true` / `isDirty: false` via `mission.getDiff`. No dedicated
 * test existed for this function before this card (see `H4.md`'s "Blockers /
 * risks" note) — this is the targeted regression test the card requires, not
 * full coverage of `getContractStatus`.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockGetMission = vi.fn();

vi.mock("@vex-agent/db/repos/missions.js", () => ({
  getMission: (...args: unknown[]) => mockGetMission(...args),
}));

const { getContractStatus } = await import(
  "../../../../vex-agent/engine/mission/diff.js"
);
const { computeContractHash, LEGACY_V2_CONTRACT_HASH_VERSION } = await import(
  "../../../../vex-agent/engine/mission/contract-hash.js"
);
const { extractLegacyHyperliquidRiskV2, missionToDraft } = await import(
  "../../../../vex-agent/engine/mission/mapper.js"
);

function makeMission(overrides: Record<string, unknown> = {}) {
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
    approvedAt: "2026-05-22T10:00:00.000Z",
    acceptedContractHash: null,
    acceptedContractAt: null,
    acceptedContractBy: null,
    contractHashVersion: null,
    renewedFromMissionId: null,
    ...overrides,
  };
}

describe("getContractStatus", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reports isAccepted=true / isDirty=false for a mission accepted under the frozen legacy v2 contract (historical Hyperliquid risk)", async () => {
    const hyperliquidRisk = {
      leverageCap: 3,
      perOrderNotionalPct: 20,
      totalNotionalPct: 100,
    };
    const mission = makeMission({
      constraintsJson: { deadline: "2026-04-04", hyperliquidRisk },
      contractHashVersion: LEGACY_V2_CONTRACT_HASH_VERSION,
      acceptedContractAt: "2026-05-22T10:00:00.000Z",
      acceptedContractBy: "host",
    });
    const acceptedHash = computeContractHash(
      missionToDraft(mission),
      LEGACY_V2_CONTRACT_HASH_VERSION,
      extractLegacyHyperliquidRiskV2(mission),
    );
    mockGetMission.mockResolvedValueOnce({
      ...mission,
      acceptedContractHash: acceptedHash,
    });

    const outcome = await getContractStatus({
      sessionId: "session-1",
      missionId: "mission-1",
    });

    expect(outcome.outcome).toBe("ready");
    if (outcome.outcome !== "ready") return;
    expect(outcome.isAccepted).toBe(true);
    expect(outcome.isDirty).toBe(false);
    expect(outcome.acceptedContractHashVersion).toBe(LEGACY_V2_CONTRACT_HASH_VERSION);
  });

  it("reports isDirty=true for a v2-accepted mission whose live draft changed since acceptance", async () => {
    const hyperliquidRisk = {
      leverageCap: 3,
      perOrderNotionalPct: 20,
      totalNotionalPct: 100,
    };
    const accepted = makeMission({
      constraintsJson: { deadline: "2026-04-04", hyperliquidRisk },
      contractHashVersion: LEGACY_V2_CONTRACT_HASH_VERSION,
      acceptedContractAt: "2026-05-22T10:00:00.000Z",
      acceptedContractBy: "host",
    });
    const acceptedHash = computeContractHash(
      missionToDraft(accepted),
      LEGACY_V2_CONTRACT_HASH_VERSION,
      extractLegacyHyperliquidRiskV2(accepted),
    );
    // Goal edited after acceptance — draft has drifted from the accepted hash.
    mockGetMission.mockResolvedValueOnce({
      ...accepted,
      goal: "Accumulate 20 SOL",
      acceptedContractHash: acceptedHash,
    });

    const outcome = await getContractStatus({
      sessionId: "session-1",
      missionId: "mission-1",
    });

    expect(outcome.outcome).toBe("ready");
    if (outcome.outcome !== "ready") return;
    expect(outcome.isAccepted).toBe(false);
    expect(outcome.isDirty).toBe(true);
  });
});
