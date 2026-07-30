/**
 * `resumeMissionRun` post-flip safety (puzzle 04 phase 6).
 *
 * Codex review requirement #1:
 *
 *   1. Terminal-status check must be OUTSIDE the finalize-on-error
 *      try. A direct `resumeMissionRun(runId)` on a `completed` /
 *      `failed` / `stopped` / `cancelled` row must throw without
 *      rewriting the durable status to `paused_error`.
 *
 *   2. When `resumePreparedMissionRun` already finalizes internally
 *      and re-throws `MissionRunPausedError`, the outer
 *      `resumeMissionRun` catch must NOT call `finalizeMissionRunError`
 *      again. Re-finalizing would emit duplicate bug reports and
 *      rewrite the already-set `paused_error` row.
 *
 * Coverage is in this focused file (not the umbrella `runner.test.ts`)
 * so phase 6 doesn't grow an already-over-budget test file.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { MissionRunPausedError } from "../../../../../vex-agent/engine/types.js";

const mockGetRun = vi.fn();
const mockGetMission = vi.fn();
const mockUpdateRunStatus = vi.fn();
const mockResolveProvider = vi.fn();
const mockHydrate = vi.fn();
const mockRunTurnLoop = vi.fn();
const mockAddMessage = vi.fn();
const mockAddEngineMessage = vi.fn();

// The paused_error park now runs the DURABLE OPERATOR-STOP CONSUMER inside its
// own transaction (see `mission-auto-retry.ts`): it takes the session control
// lock and gates on a queued `stop_terminal` request before writing. Both
// collaborators are stubbed to "no stop queued" here so these tests keep
// asserting the park itself.
vi.mock(
  "@vex-agent/engine/runtime/lease-and-status/operator-stop-boundary.js",
  () => ({ gateOnOperatorStopWithClient: async () => ({ kind: "clear" }) }),
);
vi.mock(
  "@vex-agent/engine/runtime/lease-and-status/session-control-lock.js",
  () => ({ acquireSessionControlLock: async () => undefined }),
);

vi.mock("@vex-agent/db/repos/mission-runs.js", () => ({
  getRun: (...a: unknown[]) => mockGetRun(...a),
  updateStatus: (...a: unknown[]) => mockUpdateRunStatus(...a),
  createRun: vi.fn(),
  getActiveRun: vi.fn().mockResolvedValue(null),
  getActiveRunBySession: vi.fn().mockResolvedValue(null),
  getLatestFailedRunBySession: vi.fn().mockResolvedValue(null),
  incrementIterations: vi.fn(),
  setLastCheckpoint: vi.fn(),
}));

vi.mock("@vex-agent/db/repos/missions.js", () => ({
  getMission: (...a: unknown[]) => mockGetMission(...a),
  getMissionForUpdate: (...a: unknown[]) => mockGetMission(a[1]),
  setStatus: vi.fn(),
  setApprovedAt: vi.fn(),
  updateAcceptance: vi.fn(),
  clearAcceptance: vi.fn(),
  getMissionBySession: vi.fn().mockResolvedValue(null),
}));

vi.mock("@vex-agent/db/repos/sessions.js", () => ({
  getSession: vi.fn().mockResolvedValue({
    id: "session-1",
    mode: "mission",
    permission: "restricted",
    tokenCount: 0,
  }),
  updateTokenCount: vi.fn(),
}));

vi.mock("@vex-agent/db/repos/messages.js", () => ({
  MESSAGE_DB_COLUMNS: [],
  addMessage: (...a: unknown[]) => mockAddMessage(...a),
  addEngineMessage: (...a: unknown[]) => mockAddEngineMessage(...a),
  addMessageReturningId: vi.fn().mockResolvedValue({
    id: 1,
    role: "assistant",
    content: "",
    timestamp: new Date().toISOString(),
  }),
  getLiveMessages: vi.fn().mockResolvedValue([]),
}));

vi.mock("@vex-agent/engine/events/index.js", () => ({
  appendMessage: (...a: unknown[]) => mockAddMessage(...a),
  appendEngineMessage: (...a: unknown[]) => mockAddEngineMessage(...a),
  emitTranscriptAppend: vi.fn(),
}));

vi.mock("@vex-agent/inference/registry.js", () => ({
  resolveProvider: () => mockResolveProvider(),
}));

vi.mock("../../../../../vex-agent/engine/core/hydrate.js", () => ({
  hydrateEngineSession: (...a: unknown[]) => mockHydrate(...a),
}));

vi.mock("../../../../../vex-agent/engine/core/turn-loop.js", () => ({
  runTurnLoop: (...a: unknown[]) => mockRunTurnLoop(...a),
}));

vi.mock("@vex-agent/tools/registry.js", () => ({
  getOpenAITools: vi.fn().mockReturnValue([]),
}));

vi.mock("@vex-agent/tools/protocols/catalog.js", () => ({
  PROTOCOL_TOOLS: [],
  PROTOCOL_NAMESPACE_ALLOWLIST: [],
}));

vi.mock("@vex-agent/db/client.js", () => ({
  execute: vi.fn(),
  query: vi.fn().mockResolvedValue([]),
  queryOne: vi.fn().mockResolvedValue(null),
  getPool: vi.fn().mockReturnValue({
    connect: vi.fn().mockResolvedValue({
      query: vi.fn().mockResolvedValue({ rows: [] }),
      release: vi.fn(),
    }),
  }),
  queryWith: vi.fn().mockResolvedValue([]),
  queryOneWith: vi.fn().mockResolvedValue(null),
  executeWith: vi.fn().mockResolvedValue(1),
  withTransaction: vi.fn().mockImplementation(
    async (fn: (client: unknown) => Promise<unknown>) => {
      const stubClient = {
        query: vi.fn().mockResolvedValue({ rows: [] }),
        release: vi.fn(),
      };
      return await fn(stubClient);
    },
  ),
}));

vi.mock("@utils/logger.js", () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

const { resumeMissionRun } = await import(
  "../../../../../vex-agent/engine/core/runner/mission.js"
);

beforeEach(() => {
  vi.clearAllMocks();
  mockResolveProvider.mockResolvedValue({
    loadConfig: vi.fn().mockResolvedValue({ contextLimit: 200_000 }),
  });
  mockHydrate.mockResolvedValue({
    context: {
      sessionId: "session-1",
      sessionPermission: "restricted",
      sessionKind: "mission",
    },
    messages: [],
    summary: null,
    tokenCount: 0,
  });
  mockGetMission.mockResolvedValue({
    id: "mission-1",
    rootSessionId: "session-1",
    status: "running",
  });
});

describe("resumeMissionRun safety", () => {
  it("refuses terminal runs WITHOUT calling finalize (audit history is immutable)", async () => {
    // Terminal-status check must be OUTSIDE the finalize-on-error try.
    // A direct call on a terminal run must NOT rewrite the durable
    // status to `paused_error`.
    mockGetRun.mockResolvedValueOnce({
      id: "run-1",
      missionId: "mission-1",
      sessionId: "session-1",
      status: "completed",
      iterationCount: 5,
    });
    await expect(resumeMissionRun("run-1")).rejects.toThrow(/terminal/);
    expect(mockUpdateRunStatus).not.toHaveBeenCalledWith(
      "run-1",
      "paused_error",
      expect.anything(),
      expect.anything(),
    );
  });

  it("does not double-finalize when resumePreparedMissionRun already finalized", async () => {
    // When the internal turn loop catch finalizes + wraps the error in
    // `MissionRunPausedError`, the outer `resumeMissionRun` catch must
    // NOT call `finalizeMissionRunError` again. Without the instanceof
    // guard, finalize would fire twice + emit duplicate bug reports.
    mockGetRun.mockResolvedValueOnce({
      id: "run-1",
      missionId: "mission-1",
      sessionId: "session-1",
      status: "paused_wake",
      iterationCount: 5,
    });
    mockRunTurnLoop.mockRejectedValueOnce(new Error("provider exploded"));

    await expect(resumeMissionRun("run-1")).rejects.toBeInstanceOf(
      MissionRunPausedError,
    );

    // Internal finalize wrote one `paused_error` transition. If the
    // outer catch double-finalized, we'd see TWO `paused_error` calls.
    const pausedErrorCalls = mockUpdateRunStatus.mock.calls.filter(
      (call) => call[1] === "paused_error",
    );
    expect(pausedErrorCalls).toHaveLength(1);
  });
});
