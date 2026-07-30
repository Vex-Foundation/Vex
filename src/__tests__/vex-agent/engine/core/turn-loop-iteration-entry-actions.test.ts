/**
 * The iteration-boundary action pipeline.
 *
 * The guard ORDER is the contract these tests defend: a session that is
 * stopping must never start compaction work on its way out, and an apply must
 * always beat a trigger that could supersede the very preparation being
 * applied.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import {
  runIterationEntryGuards,
  type IterationBoundaryAction,
  type IterationBoundaryOutcome,
} from "@vex-agent/engine/core/turn-loop-iteration-entry.js";
import { observePendingControlRequest } from "@vex-agent/engine/core/turn-loop-observe.js";

vi.mock("@vex-agent/engine/core/turn-loop-observe.js", () => ({
  observePendingControlRequest: vi.fn(async () => ({ kind: "no_request" })),
}));

const observeMock = vi.mocked(observePendingControlRequest);

function action(
  name: string,
  phase: IterationBoundaryAction["phase"],
  outcome: IterationBoundaryOutcome = { kind: "continue" },
  log?: string[],
): IterationBoundaryAction {
  return {
    name,
    phase,
    run: async () => {
      log?.push(name);
      return outcome;
    },
  };
}

function guardArgs(
  overrides: Partial<Parameters<typeof runIterationEntryGuards>[0]> = {},
) {
  return {
    sessionId: "session-1",
    missionRunId: "run-1",
    iteration: 1,
    maxIterations: 10,
    elapsedMs: 0,
    timeoutMs: 60_000,
    ...overrides,
  };
}

beforeEach(() => {
  observeMock.mockResolvedValue({ kind: "no_request" });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("guard ordering — actions never run on an iteration that is stopping", () => {
  it("does not run actions when the abort signal is already aborted", async () => {
    const ran: string[] = [];
    const controller = new AbortController();
    controller.abort();

    const outcome = await runIterationEntryGuards(
      guardArgs({
        abortSignal: controller.signal,
        boundaryActions: [action("trigger", "trigger", { kind: "continue" }, ran)],
      }),
    );

    expect(outcome).toEqual({ kind: "abort_user_stopped" });
    expect(ran).toEqual([]);
  });

  it.each([
    ["paused_user_applied", "control_paused_user"],
    ["stop_applied", "control_stopped"],
  ] as const)(
    "does not run actions on a pending control request (%s)",
    async (observed, expectedKind) => {
      observeMock.mockResolvedValue({ kind: observed, correlationId: "corr-1" });
      const ran: string[] = [];

      const outcome = await runIterationEntryGuards(
        guardArgs({
          boundaryActions: [action("trigger", "trigger", { kind: "continue" }, ran)],
        }),
      );

      expect(outcome.kind).toBe(expectedKind);
      expect(ran).toEqual([]);
    },
  );

  it("does not run actions when a runtime stop condition fires", async () => {
    const ran: string[] = [];

    const outcome = await runIterationEntryGuards(
      guardArgs({
        iteration: 10,
        maxIterations: 10,
        boundaryActions: [action("trigger", "trigger", { kind: "continue" }, ran)],
      }),
    );

    expect(outcome.kind).toBe("runtime_stop");
    expect(ran).toEqual([]);
  });
});

describe("action pipeline", () => {
  it("runs each action exactly once and proceeds when all continue", async () => {
    const ran: string[] = [];

    const outcome = await runIterationEntryGuards(
      guardArgs({
        boundaryActions: [
          action("a", "trigger", { kind: "continue" }, ran),
          action("b", "trigger", { kind: "continue" }, ran),
        ],
      }),
    );

    expect(outcome).toEqual({ kind: "proceed" });
    expect(ran).toEqual(["a", "b"]);
  });

  it("runs apply-phase actions before trigger-phase ones REGARDLESS of array order", async () => {
    // The structural guarantee: three packages edit the call site across build
    // stages, so the win-order must not depend on how the array is written.
    const ran: string[] = [];

    await runIterationEntryGuards(
      guardArgs({
        boundaryActions: [
          action("trigger", "trigger", { kind: "continue" }, ran),
          action("apply", "apply", { kind: "continue" }, ran),
        ],
      }),
    );

    expect(ran).toEqual(["apply", "trigger"]);
  });

  it("short-circuits on the first non-continue outcome and skips later actions", async () => {
    const ran: string[] = [];

    const outcome = await runIterationEntryGuards(
      guardArgs({
        boundaryActions: [
          action(
            "apply",
            "apply",
            { kind: "compaction_applied", generation: 7, archivedMessages: 12 },
            ran,
          ),
          action("trigger", "trigger", { kind: "continue" }, ran),
        ],
      }),
    );

    expect(outcome).toEqual({
      kind: "compaction_applied",
      generation: 7,
      archivedMessages: 12,
    });
    // A trigger that ran here could supersede the preparation just applied.
    expect(ran).toEqual(["apply"]);
  });

  it("surfaces a deferral as its own outcome kind, distinct from any noop", async () => {
    // Deferring for unresolved money state is the gate WORKING. It must stay
    // distinguishable from a failed/no-op compaction so the caller cannot
    // count it toward `criticalNoopCounter` and escalate a healthy run to
    // `paused_error` for waiting correctly.
    const outcome = await runIterationEntryGuards(
      guardArgs({
        boundaryActions: [
          action("apply", "apply", {
            kind: "compaction_apply_deferred",
            reasons: [{ kind: "wallet_intent_live", ref: "intent-1" }],
          }),
        ],
      }),
    );

    expect(outcome.kind).toBe("compaction_apply_deferred");
    if (outcome.kind === "compaction_apply_deferred") {
      expect(outcome.reasons).toHaveLength(1);
      expect(outcome.reasons[0].kind).toBe("wallet_intent_live");
    }
  });

  it("swallows a throwing action, continues the pipeline, and still proceeds", async () => {
    const ran: string[] = [];
    const outcome = await runIterationEntryGuards(
      guardArgs({
        boundaryActions: [
          {
            name: "boom",
            phase: "apply",
            run: async () => {
              throw new Error("action exploded");
            },
          },
          action("trigger", "trigger", { kind: "continue" }, ran),
        ],
      }),
    );

    expect(outcome).toEqual({ kind: "proceed" });
    expect(ran).toEqual(["trigger"]);
  });

  it("proceeds normally when no actions are supplied", async () => {
    const outcome = await runIterationEntryGuards(guardArgs());
    expect(outcome).toEqual({ kind: "proceed" });
  });
});
