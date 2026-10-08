/**
 * `setMissionReasoningEffort` - the host writer for the E-1 contract field.
 * A write clears acceptance (hash v8 material), a started mission refuses,
 * a cross-session id is `not_found`, and nothing is written on a refusal.
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
  mergeConstraintReasoningEffort: (...a: unknown[]) => mockMerge(...a),
  clearAcceptance: (...a: unknown[]) => mockClearAcceptance(...a),
}));

const { setMissionReasoningEffort } = await import(
  "../../../../vex-agent/engine/mission/set-reasoning-effort.js"
);

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

describe("setMissionReasoningEffort", () => {
  it("writes the effort for an editable mission", async () => {
    mockGetMissionForUpdate.mockResolvedValue(mission());
    const r = await setMissionReasoningEffort({ sessionId: "session-1", missionId: "mission-1", reasoningEffort: "low" });
    expect(r).toEqual({ outcome: "updated", reasoningEffort: "low", acceptanceCleared: false });
    expect(mockMerge).toHaveBeenCalledWith({}, "mission-1", "low");
    expect(mockClearAcceptance).not.toHaveBeenCalled();
  });

  it("clears a prior acceptance, because the effort is contract material", async () => {
    mockGetMissionForUpdate.mockResolvedValue(mission({ acceptedContractHash: "abc" }));
    const r = await setMissionReasoningEffort({ sessionId: "session-1", missionId: "mission-1", reasoningEffort: null });
    expect(r).toEqual({ outcome: "updated", reasoningEffort: null, acceptanceCleared: true });
    expect(mockClearAcceptance).toHaveBeenCalledWith({}, "mission-1");
  });

  it("refuses a started mission without writing: the run uses its frozen effort", async () => {
    mockGetMissionForUpdate.mockResolvedValue(mission({ status: "running" }));
    const r = await setMissionReasoningEffort({ sessionId: "session-1", missionId: "mission-1", reasoningEffort: "high" });
    expect(r).toEqual({ outcome: "blocked_status", status: "running" });
    expect(mockMerge).not.toHaveBeenCalled();
  });

  it("collapses a cross-session id to not_found", async () => {
    mockGetMissionForUpdate.mockResolvedValue(mission({ rootSessionId: "other" }));
    const r = await setMissionReasoningEffort({ sessionId: "session-1", missionId: "mission-1", reasoningEffort: "high" });
    expect(r).toEqual({ outcome: "not_found" });
    expect(mockMerge).not.toHaveBeenCalled();
  });
});
