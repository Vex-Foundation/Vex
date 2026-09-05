/**
 * Unit tests for `engine/mission/acceptance.ts` — `assertAcceptedContract`
 * current-day status outcomes (mission_not_found / not_accepted /
 * stale_acceptance / accepted / the BEGIN+COMMIT tx shape).
 *
 * Split out of `acceptance.test.ts` to stay under the repo's 500-line cap;
 * shared mocks/fixtures live in `_acceptance-mocks.ts`. The frozen
 * Hyperliquid-removal V2 contract-hash compat case lives in the sibling
 * `acceptance-legacy-v2.test.ts` (Agent Scan Phase 3).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  mockGetMissionForUpdate,
  fakeClientQuery,
  makeMission,
} from "./_acceptance-mocks.js";

const { assertAcceptedContract } = await import(
  "../../../../vex-agent/engine/mission/acceptance.js"
);
const { computeContractHash, LEGACY_V6_CONTRACT_HASH_VERSION } = await import(
  "../../../../vex-agent/engine/mission/contract-hash.js"
);
const { missionToDraft } = await import(
  "../../../../vex-agent/engine/mission/mapper.js"
);

describe("assertAcceptedContract — status outcomes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fakeClientQuery.mockResolvedValue({ rows: [], rowCount: 0 });
  });

  it("returns mission_not_found when the row is missing", async () => {
    mockGetMissionForUpdate.mockResolvedValueOnce(null);
    const outcome = await assertAcceptedContract({ missionId: "mission-1" });
    expect(outcome.outcome).toBe("mission_not_found");
  });

  it("returns not_accepted when accepted_contract_hash is null", async () => {
    mockGetMissionForUpdate.mockResolvedValueOnce(
      makeMission({ acceptedContractHash: null, contractHashVersion: null }),
    );
    const outcome = await assertAcceptedContract({ missionId: "mission-1" });
    expect(outcome.outcome).toBe("not_accepted");
    if (outcome.outcome === "not_accepted") {
      expect(outcome.missionId).toBe("mission-1");
    }
  });

  it("returns stale_acceptance when the recomputed hash drifted", async () => {
    const mission = makeMission({
      acceptedContractHash: "0".repeat(64),
      acceptedContractAt: "2026-05-22T11:00:00.000Z",
      acceptedContractBy: "host",
      contractHashVersion: 1,
    });
    mockGetMissionForUpdate.mockResolvedValueOnce(mission);

    const outcome = await assertAcceptedContract({ missionId: "mission-1" });
    expect(outcome.outcome).toBe("stale_acceptance");
    if (outcome.outcome === "stale_acceptance") {
      expect(outcome.acceptedHash).toBe("0".repeat(64));
      expect(outcome.currentHash).toBe(computeContractHash(missionToDraft(mission), 1));
      expect(outcome.currentHash).not.toBe(outcome.acceptedHash);
    }
  });

  it("returns accepted when the four-tuple matches the current draft", async () => {
    const mission = makeMission();
    const currentHash = computeContractHash(missionToDraft(mission), 1);
    mockGetMissionForUpdate.mockResolvedValueOnce({
      ...mission,
      acceptedContractHash: currentHash,
      acceptedContractAt: "2026-05-22T11:00:00.000Z",
      acceptedContractBy: "host",
      contractHashVersion: 1,
    });

    const outcome = await assertAcceptedContract({ missionId: "mission-1" });
    expect(outcome.outcome).toBe("accepted");
    if (outcome.outcome === "accepted") {
      expect(outcome.contractHash).toBe(currentHash);
      expect(outcome.contractHashVersion).toBe(1);
    }
  });

  it("returns accepted for a v6 declaration that never stored assetKind", async () => {
    const acceptedHash = "0b2633813c1300cc87e56b177797eb04011bee4dd9253ea8d06caba6e9428914";
    mockGetMissionForUpdate.mockResolvedValueOnce(makeMission({
      capitalSourceJson: {
        type: "wallet",
        amount: "500 USDC",
        deployedCapital: {
          amountRaw: "3044000000000000000000",
          decimals: 18,
          chainId: 4663,
          assetAddress: "0x0f9f0000000000000000000000000000000000ee",
          assetSymbol: "VEX",
        },
      },
      acceptedContractHash: acceptedHash,
      acceptedContractAt: "2026-05-22T11:00:00.000Z",
      acceptedContractBy: "host",
      contractHashVersion: LEGACY_V6_CONTRACT_HASH_VERSION,
    }));

    const outcome = await assertAcceptedContract({ missionId: "mission-1" });

    expect(outcome.outcome).toBe("accepted");
    if (outcome.outcome !== "accepted") return;
    expect(outcome.contractHash).toBe(acceptedHash);
    expect(outcome.contractHashVersion).toBe(LEGACY_V6_CONTRACT_HASH_VERSION);
  });

  it("opens and closes a transaction (BEGIN + COMMIT) for the gate read", async () => {
    mockGetMissionForUpdate.mockResolvedValueOnce(
      makeMission({ acceptedContractHash: null, contractHashVersion: null }),
    );
    await assertAcceptedContract({ missionId: "mission-1" });
    const sqlCalls = fakeClientQuery.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(sqlCalls).toContain("BEGIN");
    expect(sqlCalls).toContain("COMMIT");
  });
});
