/**
 * `applyMissionPatch` → `engine.mission.update` emit contract.
 *
 * The draft/readiness half of the push. `readiness_changed` wins over
 * `draft_updated` when both are true — it is the transition the "Start
 * mission" affordance is gated on, and a consumer that only listens for the
 * coarser kind would otherwise miss it.
 *
 * A no-op patch emits nothing: an event that implies a change nobody made
 * costs the renderer a refetch for no new state.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockGetMission = vi.fn();
const mockGetMissionForUpdate = vi.fn();
const mockUpdateDraft = vi.fn();
const mockSetStatus = vi.fn();
const mockClearAcceptance = vi.fn();

vi.mock("@vex-agent/db/repos/missions.js", () => ({
  createDraft: vi.fn(),
  getMission: (...a: unknown[]) => mockGetMission(...a),
  getMissionForUpdate: (...a: unknown[]) => mockGetMissionForUpdate(...a),
  updateDraft: (...a: unknown[]) => mockUpdateDraft(...a),
  setStatus: (...a: unknown[]) => mockSetStatus(...a),
  clearAcceptance: (...a: unknown[]) => mockClearAcceptance(...a),
}));

vi.mock("@vex-agent/db/client.js", () => ({
  execute: vi.fn(),
  query: vi.fn().mockResolvedValue([]),
  queryOne: vi.fn().mockResolvedValue(null),
  withTransaction: vi.fn(async (fn: (client: unknown) => unknown) => fn({})),
}));

const { applyMissionPatch } = await import(
  "../../../../vex-agent/engine/mission/setup.js"
);
const { missionUpdateBus } = await import(
  "../../../../vex-agent/engine/runtime/mission-bus.js"
);

/** A complete draft — `validateDraft` reports it ready. */
function completeMission(overrides: Record<string, unknown> = {}) {
  return {
    id: "mission-1",
    rootSessionId: "session-1",
    status: "draft",
    title: "SOL DCA",
    goal: "Accumulate 10 SOL",
    constraintsJson: {},
    successCriteriaJson: ["Accumulated 10 SOL"],
    stopConditionsJson: ["capital_depleted"],
    riskProfile: "conservative",
    capitalSourceJson: { type: "wallet", amount: "500 USDC" },
    allowedProtocols: ["jupiter"],
    allowedChains: ["solana"],
    allowedWallets: ["solana"],
    createdAt: "2026-07-29T10:00:00.000Z",
    updatedAt: "2026-07-29T10:00:00.000Z",
    approvedAt: null,
    acceptedContractHash: null,
    acceptedContractAt: null,
    acceptedContractBy: null,
    contractHashVersion: null,
    renewedFromMissionId: null,
    ...overrides,
  };
}

function captureEvents(): {
  events: Array<Record<string, unknown>>;
  off: () => void;
} {
  const events: Array<Record<string, unknown>> = [];
  const off = missionUpdateBus.subscribe((event) =>
    events.push(event as unknown as Record<string, unknown>),
  );
  return { events, off };
}

describe("applyMissionPatch mission-update emit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("emits `readiness_changed` when the patch completes the draft", async () => {
    const before = completeMission({ status: "draft" });
    mockGetMission.mockResolvedValue(before);
    mockGetMissionForUpdate.mockResolvedValue(before);

    const { events, off } = captureEvents();
    try {
      await applyMissionPatch("mission-1", { goal: "Accumulate 10 SOL" });
    } finally {
      off();
    }

    expect(mockSetStatus).toHaveBeenCalledWith("mission-1", "ready");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "engine.mission.update",
      sessionId: "session-1",
      missionId: "mission-1",
      kind: "readiness_changed",
    });
  });

  it("emits `draft_updated` when a patch lands without crossing readiness", async () => {
    const ready = completeMission({ status: "ready" });
    mockGetMission.mockResolvedValue(ready);
    mockGetMissionForUpdate.mockResolvedValue(ready);

    const { events, off } = captureEvents();
    try {
      await applyMissionPatch("mission-1", { goal: "Accumulate 12 SOL" });
    } finally {
      off();
    }

    expect(mockSetStatus).not.toHaveBeenCalled();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "draft_updated" });
  });

  it("emits nothing for a no-op patch", async () => {
    const ready = completeMission({ status: "ready" });
    mockGetMission.mockResolvedValue(ready);
    mockGetMissionForUpdate.mockResolvedValue(ready);

    const { events, off } = captureEvents();
    try {
      await applyMissionPatch("mission-1", { nothing: "applicable" });
    } finally {
      off();
    }

    expect(mockUpdateDraft).not.toHaveBeenCalled();
    expect(events).toHaveLength(0);
  });
});
