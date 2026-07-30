/**
 * Resume regression — the `running` flip in `resumePreparedMissionRun` must be
 * a terminal-guarded CAS, not an unconditional write.
 *
 * `resumeMissionRun` reads the run and rejects a terminal one at the TOP of the
 * function, then awaits a provider resolve, a config load and a mission read
 * before the run core is entered. That is a check-then-act window: an operator
 * Stop landing inside it used to be overwritten by an unconditional
 * `updateStatus(runId, "running")`, which cleared the stop evidence the user's
 * Stop had written and then ran a full turn on a stopped run.
 *
 * The CAS makes the refusal authoritative, and the refusal must abandon the
 * turn — `runTurnLoop` may not be reached.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockStartRunIfNotTerminal = vi.fn().mockResolvedValue(true);
const mockUpdateStatus = vi.fn();
const mockRunTurnLoop = vi.fn();
const mockHydrate = vi.fn().mockResolvedValue(null);
const mockFinalizeError = vi.fn();
const mockFinalizeStatus = vi.fn();
const mockFinalizeUserStopAfterThrow = vi.fn();

vi.mock("@vex-agent/db/repos/mission-runs.js", () => ({
  startRunIfNotTerminal: (...a: unknown[]) => mockStartRunIfNotTerminal(...a),
  updateStatus: (...a: unknown[]) => mockUpdateStatus(...a),
}));

vi.mock("../../../../../vex-agent/engine/core/hydrate.js", () => ({
  hydrateEngineSession: (...a: unknown[]) => mockHydrate(...a),
}));

vi.mock("../../../../../vex-agent/engine/core/turn-loop.js", () => ({
  runTurnLoop: (...a: unknown[]) => mockRunTurnLoop(...a),
}));

vi.mock("../../../../../vex-agent/engine/core/runner/mission-finalize.js", () => ({
  finalizeMissionRunError: (...a: unknown[]) => mockFinalizeError(...a),
  finalizeMissionRunStatus: (...a: unknown[]) => mockFinalizeStatus(...a),
}));

vi.mock("../../../../../vex-agent/engine/runtime/lease-and-status.js", () => ({
  applyUserStopTransaction: (...a: unknown[]) => mockFinalizeUserStopAfterThrow(...a),
}));

vi.mock("@vex-agent/tools/registry.js", () => ({
  getOpenAITools: () => [],
}));

vi.mock("@vex-agent/engine/events/index.js", () => ({
  appendEngineMessage: vi.fn(),
}));

import { resumePreparedMissionRun } from "../../../../../vex-agent/engine/core/runner/mission-run.js";
import { MissionRunPausedError } from "../../../../../vex-agent/engine/types.js";

function preparedResume() {
  return {
    runId: "run-1",
    run: {
      id: "run-1",
      missionId: "mission-1",
      sessionId: "session-1",
      status: "paused_wake",
      iterationCount: 3,
      contractSnapshotJson: null,
    },
    mission: { id: "mission-1" },
    provider: {},
    config: { contextLimit: 100_000 },
  } as unknown as Parameters<typeof resumePreparedMissionRun>[0];
}

describe("resumePreparedMissionRun — guarded running flip", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStartRunIfNotTerminal.mockResolvedValue(true);
    mockHydrate.mockResolvedValue(null);
  });

  it("flips the run to running through the terminal-guarded CAS", async () => {
    // Hydrate returns null so the body stops right after the flip — this test
    // is about WHICH write starts the resume, not about the turn itself.
    await expect(resumePreparedMissionRun(preparedResume())).rejects.toBeInstanceOf(
      MissionRunPausedError,
    );

    expect(mockStartRunIfNotTerminal).toHaveBeenCalledWith("run-1");
    expect(mockUpdateStatus).not.toHaveBeenCalled();
  });

  it("refuses to resume — and never runs a turn — when the run went terminal first", async () => {
    mockStartRunIfNotTerminal.mockResolvedValue(false);

    await expect(resumePreparedMissionRun(preparedResume())).rejects.toBeInstanceOf(
      MissionRunPausedError,
    );

    // The turn loop is the thing that must not happen: running it would do
    // real work on a run the operator already stopped.
    expect(mockRunTurnLoop).not.toHaveBeenCalled();
    expect(mockHydrate).not.toHaveBeenCalled();
    expect(mockUpdateStatus).not.toHaveBeenCalled();
  });
});
