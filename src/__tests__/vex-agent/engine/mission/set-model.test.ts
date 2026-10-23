/**
 * `setMissionModel` - the host writer for the F06 contract model. A write
 * clears acceptance (hash v10 material), a started mission refuses, a
 * cross-session id is `not_found`, a malformed model is `invalid`, and
 * nothing is written on a refusal.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockGetMissionForUpdate = vi.fn();
const mockMerge = vi.fn();
const mockClearAcceptance = vi.fn();

vi.mock("@vex-agent/db/client.js", () => ({
  withTransaction: vi.fn(async (fn: (client: unknown) => unknown) => fn({})),
}));

vi.mock("@vex-agent/db/repos/missions.js", () => ({
  getMissionForUpdate: (...a: unknown[]) => mockGetMissionForUpdate(...a),
  mergeConstraintModel: (...a: unknown[]) => mockMerge(...a),
  clearAcceptance: (...a: unknown[]) => mockClearAcceptance(...a),
}));

const { setMissionModel } = await import("../../../../vex-agent/engine/mission/set-model.js");

const SONNET = { provider: "vexcloud", modelId: "anthropic/claude-sonnet-5.5" } as const;

function mission(overrides: Record<string, unknown> = {}) {
  return {
    id: "mission-1",
    rootSessionId: "session-1",
    status: "ready",
    acceptedContractHash: null,
    constraintsJson: {},
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockMerge.mockResolvedValue(undefined);
  mockClearAcceptance.mockResolvedValue(undefined);
});

describe("setMissionModel", () => {
  it("writes the model for an editable mission", async () => {
    mockGetMissionForUpdate.mockResolvedValue(mission());
    const r = await setMissionModel({ sessionId: "session-1", missionId: "mission-1", model: SONNET });
    expect(r).toEqual({ outcome: "updated", model: SONNET, acceptanceCleared: false });
    expect(mockMerge).toHaveBeenCalledWith({}, "mission-1", SONNET);
    expect(mockClearAcceptance).not.toHaveBeenCalled();
  });

  it("clears a prior acceptance, because the model is contract material", async () => {
    mockGetMissionForUpdate.mockResolvedValue(mission({ acceptedContractHash: "abc" }));
    const r = await setMissionModel({ sessionId: "session-1", missionId: "mission-1", model: null });
    expect(r).toEqual({ outcome: "updated", model: null, acceptanceCleared: true });
    expect(mockMerge).toHaveBeenCalledWith({}, "mission-1", null);
    expect(mockClearAcceptance).toHaveBeenCalledWith({}, "mission-1");
  });

  it("refuses a started mission without writing: the run uses its frozen model", async () => {
    mockGetMissionForUpdate.mockResolvedValue(mission({ status: "running" }));
    const r = await setMissionModel({ sessionId: "session-1", missionId: "mission-1", model: SONNET });
    expect(r).toEqual({ outcome: "blocked_status", status: "running" });
    expect(mockMerge).not.toHaveBeenCalled();
  });

  it("collapses a cross-session id to not_found", async () => {
    mockGetMissionForUpdate.mockResolvedValue(mission({ rootSessionId: "other" }));
    const r = await setMissionModel({ sessionId: "session-1", missionId: "mission-1", model: SONNET });
    expect(r).toEqual({ outcome: "not_found" });
    expect(mockMerge).not.toHaveBeenCalled();
  });

  it("refuses a malformed model before opening a transaction", async () => {
    const r = await setMissionModel({
      sessionId: "session-1",
      missionId: "mission-1",
      model: { provider: "anthropic", modelId: "x" } as unknown as typeof SONNET,
    });
    expect(r).toEqual({ outcome: "invalid", reason: "Unknown model." });
    expect(mockGetMissionForUpdate).not.toHaveBeenCalled();
  });
});
