/**
 * Unit tests for `engine/mission/acceptance.ts` — `assertAcceptedContract`
 * frozen Hyperliquid-removal V2 contract-hash compat case (Agent Scan
 * Phase 3 / H4).
 *
 * Split out of `acceptance.test.ts` to keep the legacy-hash regression test
 * visible on its own, mirroring the source-level split between
 * `contract-hash.ts` and the frozen `contract-hash-legacy-v2.ts` module.
 * Shared mocks/fixtures live in `_acceptance-mocks.ts`; current-day
 * `assertAcceptedContract` status outcomes live in the sibling
 * `acceptance-assert-status.test.ts`.
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
const { computeContractHash } = await import(
  "../../../../vex-agent/engine/mission/contract-hash.js"
);
const { extractLegacyHyperliquidRiskV2, missionToDraft } = await import(
  "../../../../vex-agent/engine/mission/mapper.js"
);

describe("assertAcceptedContract — legacy V2 contract hash compat", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fakeClientQuery.mockResolvedValue({ rows: [], rowCount: 0 });
  });

  // Agent Scan Phase 3 (Hyperliquid removal): a mission accepted while
  // `CONTRACT_HASH_VERSION` was 2 must still pass this gate — the frozen v2
  // legacy material (`contract-hash-legacy-v2.ts`) reproduces its exact
  // original hash from the raw `constraints_json.hyperliquidRisk` this
  // mission still carries, even though `MissionDraft` no longer surfaces it.
  it("returns accepted for a mission accepted under the frozen legacy v2 contract hash (historical Hyperliquid risk)", async () => {
    const hyperliquidRisk = { leverageCap: 3, perOrderNotionalPct: 20, totalNotionalPct: 100 };
    const mission = makeMission({ constraintsJson: { deadline: "2026-04-04", hyperliquidRisk } });
    const legacyHash = computeContractHash(missionToDraft(mission), 2, extractLegacyHyperliquidRiskV2(mission));
    mockGetMissionForUpdate.mockResolvedValueOnce({
      ...mission,
      acceptedContractHash: legacyHash,
      acceptedContractAt: "2026-05-22T11:00:00.000Z",
      acceptedContractBy: "host",
      contractHashVersion: 2,
    });

    const outcome = await assertAcceptedContract({ missionId: "mission-1" });
    expect(outcome.outcome).toBe("accepted");
    if (outcome.outcome === "accepted") {
      expect(outcome.contractHash).toBe(legacyHash);
      expect(outcome.contractHashVersion).toBe(2);
    }
  });
});
