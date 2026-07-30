/**
 * `acceptContract` → `engine.mission.update` emit contract.
 *
 * Two things are asserted, and the second matters more than the first:
 * the accepted arm emits, and the emit happens AFTER the transaction has
 * COMMITted. The repo has already shipped the bug where an event implied a row
 * a subscriber then could not read; the ordering assertion is what stops it
 * coming back through this path.
 *
 * Refusal arms emit nothing — a rejected acceptance changed no row, so a
 * refetch would be pure cost.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  mockGetMissionForUpdate,
  mockUpdateAcceptance,
  mockGetActiveRun,
  mockGetActivePlan,
  fakeClientQuery,
  makeMission,
} from "./_acceptance-mocks.js";

const { acceptContract } = await import(
  "../../../../vex-agent/engine/mission/acceptance.js"
);
const { computeContractHash, CONTRACT_HASH_VERSION } = await import(
  "../../../../vex-agent/engine/mission/contract-hash.js"
);
const { missionToDraft } = await import(
  "../../../../vex-agent/engine/mission/mapper.js"
);
const { missionUpdateBus } = await import(
  "../../../../vex-agent/engine/runtime/mission-bus.js"
);

function acceptedMissionPair() {
  const mission = makeMission();
  const hash = computeContractHash(missionToDraft(mission));
  mockGetMissionForUpdate
    .mockResolvedValueOnce(mission)
    .mockResolvedValueOnce(
      makeMission({
        acceptedContractHash: hash,
        acceptedContractAt: "2026-07-29T11:00:00.000Z",
        acceptedContractBy: "host",
        contractHashVersion: CONTRACT_HASH_VERSION,
      }),
    );
  mockGetActiveRun.mockResolvedValueOnce(null);
  return hash;
}

describe("acceptContract mission-update emit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fakeClientQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    mockGetActivePlan.mockResolvedValue(null);
  });

  it("emits `accepted` with a bounded payload, only after COMMIT", async () => {
    const hash = acceptedMissionPair();
    const events: Array<Record<string, unknown>> = [];
    // Snapshot the tx statements seen at emit time — COMMIT must already be
    // among them.
    const statementsAtEmit: string[][] = [];
    const off = missionUpdateBus.subscribe((event) => {
      events.push(event as unknown as Record<string, unknown>);
      statementsAtEmit.push(
        fakeClientQuery.mock.calls.map((call) => String(call[0])),
      );
    });

    try {
      const outcome = await acceptContract({
        sessionId: "session-1",
        missionId: "mission-1",
        contractHash: hash,
      });
      expect(outcome.outcome).toBe("accepted");
    } finally {
      off();
    }

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "engine.mission.update",
      sessionId: "session-1",
      missionId: "mission-1",
      kind: "accepted",
    });
    expect(statementsAtEmit[0]).toContain("COMMIT");
    expect(mockUpdateAcceptance).toHaveBeenCalledTimes(1);
  });

  it("emits nothing when acceptance is refused", async () => {
    mockGetMissionForUpdate.mockResolvedValueOnce(
      makeMission({ rootSessionId: "OTHER" }),
    );
    const listener = vi.fn();
    const off = missionUpdateBus.subscribe(listener);
    try {
      const outcome = await acceptContract({
        sessionId: "session-1",
        missionId: "mission-1",
        contractHash: "x".repeat(64),
      });
      expect(outcome.outcome).toBe("session_mismatch");
    } finally {
      off();
    }
    expect(listener).not.toHaveBeenCalled();
  });
});
