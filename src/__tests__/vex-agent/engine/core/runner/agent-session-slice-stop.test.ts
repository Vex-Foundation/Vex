/**
 * A wake-driven agent slice must be STOPPABLE.
 *
 * The owner's contract has two halves: autonomous work is not interrupted, and
 * the operator can always stop it. The second half had no mechanism at all for
 * a background slice — an interactive turn is stoppable only because the IPC
 * caller owns the AbortSignal, and a wake-driven slice has no request-scoped
 * caller. It ran with no signal in either turn-loop position.
 *
 * Two mechanisms are pinned here:
 *   1. the DURABLE pre-slice gate — a session stopped while the wake sat queued
 *      never spends a token;
 *   2. the LIVE session-slice AbortController — registered for exactly the
 *      duration of the slice, threaded into BOTH turn-loop positions so a Stop
 *      lands at the iteration boundary, inside a tool batch, and mid-stream.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockResolveProvider = vi.fn();
const mockHydrate = vi.fn();
const mockRunTurnLoop = vi.fn();
const mockGateOnOperatorStop = vi.fn();
const mockWithSessionControlLock = vi.fn();

vi.mock("@vex-agent/inference/registry.js", () => ({
  resolveProvider: () => mockResolveProvider(),
}));

vi.mock("@vex-agent/engine/events/index.js", () => ({
  appendMessage: vi.fn().mockResolvedValue(undefined),
  appendEngineMessage: vi.fn().mockResolvedValue(undefined),
  emitTranscriptAppend: vi.fn(),
}));

vi.mock("../../../../../vex-agent/engine/core/hydrate.js", () => ({
  hydrateEngineSession: (...a: unknown[]) => mockHydrate(...a),
}));

vi.mock("../../../../../vex-agent/engine/core/turn-loop.js", () => ({
  runTurnLoop: (...a: unknown[]) => mockRunTurnLoop(...a),
}));

vi.mock("@vex-agent/db/repos/loop-wake.js", () => ({
  enqueue: vi.fn().mockResolvedValue(null),
  cancelForSession: vi.fn().mockResolvedValue(0),
  getPendingForSession: vi.fn().mockResolvedValue(null),
}));

vi.mock("@vex-agent/tools/registry.js", () => ({
  getOpenAITools: vi.fn().mockReturnValue([]),
}));

vi.mock("@utils/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@vex-agent/engine/runtime/lease-and-status.js", () => ({
  claimSessionLease: vi.fn(),
  withSessionControlLock: (...a: unknown[]) => mockWithSessionControlLock(...a),
  gateOnOperatorStopWithClient: (...a: unknown[]) => mockGateOnOperatorStop(...a),
}));

vi.mock("@vex-agent/engine/runtime/lease-handle.js", () => ({
  createLeaseHandle: vi.fn(),
}));

vi.mock("@vex-agent/engine/runtime/release-and-emit.js", () => ({
  releaseLeaseAndEmitControlState: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@vex-agent/tools/protocols/catalog.js", () => ({
  PROTOCOL_TOOLS: [],
  PROTOCOL_NAMESPACE_ALLOWLIST: [],
}));

const { continueAgentSessionUnderLease } = await import(
  "../../../../../vex-agent/engine/core/runner/agent.js"
);
const {
  abortSessionSliceLocal,
  hasSessionSliceAbortController,
  registerSessionSliceAbortController,
} = await import(
  "../../../../../vex-agent/engine/runtime/session-slice-abort.js"
);

function makeProvider() {
  return {
    loadConfig: vi.fn().mockResolvedValue({
      provider: "openrouter",
      model: "test",
      contextLimit: 128000,
      maxOutputTokens: 4096,
    }),
  };
}

function makeHydratedSession() {
  return {
    context: {
      sessionId: "session-1",
      sessionKind: "agent",
      sessionPermission: "full",
      missionId: null,
      missionRunId: null,
      loadedDocuments: new Map(),
    },
    messages: [],
    summary: null,
    tokenCount: 0,
  };
}

/**
 * The session lease owner the wake executor claims and holds around the slice
 * (`wake-executor-<wakeId>` in production).
 */
const WAKE_OWNER = "wake-executor-wake-1";

/** `runTurnLoop` positional args: 10 = boundary signal, 11 = inference signal. */
function capturedSignals(): {
  boundary: AbortSignal | undefined;
  inference: AbortSignal | undefined;
} {
  const call = mockRunTurnLoop.mock.calls[0];
  if (call === undefined) throw new Error("runTurnLoop was never called");
  return {
    boundary: call[9] as AbortSignal | undefined,
    inference: call[10] as AbortSignal | undefined,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockResolveProvider.mockResolvedValue(makeProvider());
  mockHydrate.mockResolvedValue(makeHydratedSession());
  mockGateOnOperatorStop.mockResolvedValue({ kind: "clear" });
  mockWithSessionControlLock.mockImplementation(
    async (_sessionId: string, fn: (client: unknown) => Promise<unknown>) =>
      fn({ query: vi.fn() }),
  );
  mockRunTurnLoop.mockResolvedValue({
    text: "done", toolCallsMade: 1, pendingApprovals: [], stopReason: null,
  });
});

describe("wake-driven slice — lease ownership", () => {
  /**
   * The executor holds the session lease for the WHOLE slice, so the slice's
   * turn loop must be able to prove ownership. Dropping it here is invisible at
   * runtime — the compaction cutover just silently never applies — which is why
   * this is asserted on the exact value rather than on "some owner".
   */
  it("threads the executor's lease owner id into the slice's turn loop config", async () => {
    await continueAgentSessionUnderLease("session-1", WAKE_OWNER);

    const loopConfig = mockRunTurnLoop.mock.calls[0]![7] as {
      runnerOwnerId?: string;
    };
    expect(loopConfig.runnerOwnerId).toBe(WAKE_OWNER);
  });
});

describe("wake-driven slice — durable pre-slice gate", () => {
  it("spends NOTHING when the operator already stopped the session", async () => {
    mockGateOnOperatorStop.mockResolvedValue({
      kind: "stopped",
      runStatus: "stopped",
    });

    const result = await continueAgentSessionUnderLease("session-1", WAKE_OWNER);

    expect(result.stopReason).toBe("user_stopped");
    expect(result.toolCallsMade).toBe(0);
    // Not one token: no provider resolved, no hydrate, no loop.
    expect(mockResolveProvider).not.toHaveBeenCalled();
    expect(mockRunTurnLoop).not.toHaveBeenCalled();
  });

  it("takes the gate under the session control lock", async () => {
    await continueAgentSessionUnderLease("session-1", WAKE_OWNER);

    expect(mockWithSessionControlLock).toHaveBeenCalledWith(
      "session-1",
      expect.any(Function),
    );
    expect(mockGateOnOperatorStop).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ sessionId: "session-1", missionRunId: null }),
    );
  });
});

describe("wake-driven slice — live cancellation owner", () => {
  it("threads ONE live signal into BOTH turn-loop positions", async () => {
    await continueAgentSessionUnderLease("session-1", WAKE_OWNER);

    const { boundary, inference } = capturedSignals();
    expect(boundary).toBeInstanceOf(AbortSignal);
    expect(inference).toBeInstanceOf(AbortSignal);
    // Same controller: a single Stop must reach the boundary, the tool batch
    // (which falls back to the inference signal) and the in-flight stream.
    expect(boundary).toBe(inference);
  });

  it("an operator Stop during the slice aborts the signal the loop holds", async () => {
    let observed: AbortSignal | undefined;
    mockRunTurnLoop.mockImplementation(async (...args: unknown[]) => {
      observed = args[9] as AbortSignal;
      // The slice is airborne — this is the moment the operator presses Stop.
      expect(hasSessionSliceAbortController("session-1")).toBe(true);
      expect(abortSessionSliceLocal("session-1")).toBe(true);
      return {
        text: null,
        toolCallsMade: 2,
        pendingApprovals: [],
        stopReason: "user_stopped",
      };
    });

    const result = await continueAgentSessionUnderLease("session-1", WAKE_OWNER);

    expect(observed?.aborted).toBe(true);
    expect(result.stopReason).toBe("user_stopped");
  });

  it("unregisters the controller after the slice, including on throw", async () => {
    await continueAgentSessionUnderLease("session-1", WAKE_OWNER);
    expect(hasSessionSliceAbortController("session-1")).toBe(false);

    mockRunTurnLoop.mockRejectedValueOnce(new Error("provider down"));
    await expect(continueAgentSessionUnderLease("session-1", WAKE_OWNER)).rejects.toThrow(
      "provider down",
    );
    expect(hasSessionSliceAbortController("session-1")).toBe(false);
  });

  it("aborting a session with no live slice is a no-op, not a throw", () => {
    expect(abortSessionSliceLocal("session-nobody")).toBe(false);
  });

  it("a stopped slice schedules NO continuation", async () => {
    const loopWake = await import("@vex-agent/db/repos/loop-wake.js");
    mockRunTurnLoop.mockImplementation(async () => {
      abortSessionSliceLocal("session-1");
      return {
        text: null,
        toolCallsMade: 2,
        pendingApprovals: [],
        stopReason: "iteration_limit",
      };
    });

    await continueAgentSessionUnderLease("session-1", WAKE_OWNER);

    expect(loopWake.enqueue).not.toHaveBeenCalled();
  });
});

/**
 * ROUND-10 BLOCKER 2b — the registration window.
 *
 * The durable gate used to run BEFORE the controller was registered, with
 * provider and config loading in between. A Stop committing anywhere in that
 * interval was invisible twice over: the gate had already read `clear`, and
 * `abortSessionSliceLocal` found no controller to fire. The slice then ran to
 * completion, unstoppable, which is the exact failure the whole mechanism
 * exists to prevent.
 *
 * Registering FIRST closes the window with no residue, because the two
 * mechanisms now overlap instead of leaving a seam between them:
 *   - a Stop committed BEFORE the gate reads → the gate sees the row;
 *   - a Stop committed AFTER the gate reads → the controller already exists,
 *     so the IPC's `abortSessionSliceLocal` fires it and the slice observes it.
 * There is no third interval.
 */
describe("wake-driven slice — no window between gate and registration", () => {
  it("registers the cancellation owner BEFORE the durable gate", async () => {
    const order: string[] = [];
    mockGateOnOperatorStop.mockImplementation(async () => {
      // If registration had not happened yet, this would be `false` and the
      // operator's Stop would evaporate.
      order.push(
        hasSessionSliceAbortController("session-1")
          ? "controller_exists"
          : "controller_missing",
      );
      return { kind: "clear" };
    });

    await continueAgentSessionUnderLease("session-1", WAKE_OWNER);

    expect(order).toEqual(["controller_exists"]);
  });

  it("a Stop landing just AFTER the gate read still stops the slice", async () => {
    // The real interleaving: the durable row commits a microsecond after the
    // gate's snapshot, so the gate honestly reports `clear` and the in-process
    // signal is what has to catch it.
    mockGateOnOperatorStop.mockImplementation(async () => {
      expect(abortSessionSliceLocal("session-1")).toBe(true);
      return { kind: "clear" };
    });

    await continueAgentSessionUnderLease("session-1", WAKE_OWNER);

    const { boundary, inference } = capturedSignals();
    // The loop is handed an ALREADY-aborted signal in both positions, so it
    // stops at its first checkpoint instead of running a full slice.
    expect(boundary?.aborted).toBe(true);
    expect(inference?.aborted).toBe(true);
  });

  it("still unregisters when the gate declines the slice", async () => {
    mockGateOnOperatorStop.mockResolvedValue({
      kind: "stopped",
      runStatus: "cancelled",
      scope: "session",
    });

    const result = await continueAgentSessionUnderLease("session-1", WAKE_OWNER);

    expect(result.stopReason).toBe("user_stopped");
    expect(mockRunTurnLoop).not.toHaveBeenCalled();
    // Registering earlier must not leak a controller on the declined path.
    expect(hasSessionSliceAbortController("session-1")).toBe(false);
  });
});

/**
 * ROUND-10 BLOCKER 2c — a consumed stop must not outlive the slice it stopped.
 *
 * An aborted slice exited `user_stopped`, scheduled no continuation and
 * unregistered — but never consumed the durable `stop_terminal` row that
 * stopped it. The row stayed open, and the next thing to consult the gate (a
 * fresh user turn, an approval dispatch) found a stop that had already been
 * applied and refused UNRELATED work. An applied stop is consumed exactly once,
 * which is the same rule the shared run-scoped stop body follows.
 */
describe("wake-driven slice — the stop row is consumed on the aborted exit", () => {
  it("consumes the durable stop when the slice was aborted", async () => {
    mockRunTurnLoop.mockImplementation(async () => {
      abortSessionSliceLocal("session-1");
      return {
        text: null,
        toolCallsMade: 2,
        pendingApprovals: [],
        stopReason: "user_stopped",
      };
    });

    await continueAgentSessionUnderLease("session-1", WAKE_OWNER);

    // Gate consulted twice: once to admit the slice, once on the aborted exit
    // to consume what stopped it. The gate IS the shared consumer — reusing it
    // keeps one definition of "apply a session stop".
    expect(mockGateOnOperatorStop).toHaveBeenCalledTimes(2);
    expect(mockGateOnOperatorStop).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ sessionId: "session-1", missionRunId: null }),
    );
  });

  it("does NOT re-consume when the slice ended normally", async () => {
    await continueAgentSessionUnderLease("session-1", WAKE_OWNER);

    // No abort happened, so there is nothing to consume — and consulting the
    // gate again would be a pointless transaction on every healthy slice.
    expect(mockGateOnOperatorStop).toHaveBeenCalledTimes(1);
  });

  it("consumes even when the slice throws after being aborted", async () => {
    mockRunTurnLoop.mockImplementation(async () => {
      abortSessionSliceLocal("session-1");
      throw new Error("provider died mid-abort");
    });

    await expect(
      continueAgentSessionUnderLease("session-1", WAKE_OWNER),
    ).rejects.toThrow("provider died mid-abort");

    expect(mockGateOnOperatorStop).toHaveBeenCalledTimes(2);
    expect(hasSessionSliceAbortController("session-1")).toBe(false);
  });

  it("a consume failure never masks the slice result", async () => {
    mockRunTurnLoop.mockImplementation(async () => {
      abortSessionSliceLocal("session-1");
      return {
        text: "partial work",
        toolCallsMade: 1,
        pendingApprovals: [],
        stopReason: "user_stopped",
      };
    });
    // Second call (the exit consumer) blows up.
    mockGateOnOperatorStop
      .mockResolvedValueOnce({ kind: "clear" })
      .mockRejectedValueOnce(new Error("db blip"));

    const result = await continueAgentSessionUnderLease("session-1", WAKE_OWNER);

    expect(result.text).toBe("partial work");
    expect(hasSessionSliceAbortController("session-1")).toBe(false);
  });
});
