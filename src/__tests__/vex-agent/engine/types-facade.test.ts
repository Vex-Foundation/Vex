/**
 * ENGINE TYPES FACADE — CHARACTERIZATION GUARD.
 *
 * `engine/types.ts` is the engine's vocabulary module and is imported by ~200
 * files in two packages, including `vex-app` (which reaches the
 * `MissionRunPausedError` VALUE). It is being split into a same-named sibling
 * folder with the main file kept as a pure re-export barrel, so every existing
 * import path must keep resolving to byte-identical symbols.
 *
 * This test pins the RUNTIME half of that contract: the exported arrays, sets,
 * const tuples and error class, as they exist today, imported through the
 * public module path only.
 *
 * TYPE EXPORTS ARE NOT ASSERTED HERE, BY DESIGN. Types are erased at runtime,
 * so they cannot be probed by a runtime assertion. They are proven instead by
 * the `import type` block below (a missing or renamed type export fails the
 * compile) plus the repo-wide `pnpm exec tsc --noEmit`, which typechecks every
 * one of the module's existing consumers against the barrel.
 */

import { describe, it, expect } from "vitest";

import type {
  BusinessStopReason,
  EngineContext,
  MessageMetadata,
  MessageSource,
  MessageType,
  MessageVisibility,
  MissionDraft,
  MissionPatch,
  MissionRunStatus,
  MissionStatus,
  Permission,
  ResumedTurnClaim,
  RuntimeStopReason,
  SessionKind,
  StopReason,
  TurnResult,
  WalletPolicy,
} from "@vex-agent/engine/types.js";
import {
  ACTIVE_OR_PAUSED_RUN_STATUSES,
  ACTIVE_RUN_STATUSES,
  APPROVAL_RESUME_CLAIMABLE_RUN_STATUSES,
  MISSION_DRAFT_REQUIRED_FIELDS,
  MISSION_RUN_STATUSES,
  MissionRunPausedError,
  PAUSED_RUN_STATUSES,
  TERMINAL_RUN_STATUSES,
} from "@vex-agent/engine/types.js";

/**
 * Compile-time proof that every type export still exists under its own name and
 * keeps its shape. `tsc --noEmit` is the assertion; the values are never read.
 */
const typeExportsStillResolve = (): void => {
  const sessionKind: SessionKind = "mission";
  const permission: Permission = "restricted";
  const missionStatus: MissionStatus = "running";
  const runStatus: MissionRunStatus = "paused_wake";
  const businessStop: BusinessStopReason = "goal_reached";
  const runtimeStop: RuntimeStopReason = "user_form_required";
  const stop: StopReason = businessStop;
  const source: MessageSource = "engine";
  const messageType: MessageType = "approval_resolved";
  const visibility: MessageVisibility = "internal";
  const metadata: MessageMetadata = { source, messageType, visibility };
  const draft: Partial<MissionDraft> = { title: null };
  const patch: MissionPatch = { title: "x" };
  const walletPolicy: WalletPolicy = { kind: "none" };
  const context: Partial<EngineContext> = { sessionKind, sessionPermission: permission, walletPolicy };
  const turnResult: Partial<TurnResult> = { stopReason: runtimeStop, missionStatus };
  const claim: ResumedTurnClaim = async () => true;
  void [runStatus, stop, metadata, draft, patch, context, turnResult, claim];
};
void typeExportsStillResolve;

describe("engine/types facade — runtime exports", () => {
  it("MISSION_RUN_STATUSES keeps today's literals in order", () => {
    expect([...MISSION_RUN_STATUSES]).toEqual([
      "running",
      "paused_approval",
      "paused_wake",
      "paused_error",
      "paused_user",
      "paused_plan_acceptance",
      "paused_user_form",
      "completed",
      "failed",
      "stopped",
      "cancelled",
    ]);
  });

  it("guards against vocabulary drift by length", () => {
    expect(MISSION_RUN_STATUSES.length).toBe(11);
  });

  it("keeps the four status sets' members", () => {
    expect([...ACTIVE_RUN_STATUSES].sort()).toEqual(["running"]);
    expect([...PAUSED_RUN_STATUSES].sort()).toEqual([
      "paused_approval",
      "paused_error",
      "paused_plan_acceptance",
      "paused_user",
      "paused_user_form",
      "paused_wake",
    ]);
    expect([...TERMINAL_RUN_STATUSES].sort()).toEqual([
      "cancelled",
      "completed",
      "failed",
      "stopped",
    ]);
    expect([...ACTIVE_OR_PAUSED_RUN_STATUSES].sort()).toEqual([
      "paused_approval",
      "paused_error",
      "paused_plan_acceptance",
      "paused_user",
      "paused_user_form",
      "paused_wake",
      "running",
    ]);
  });

  it("keeps APPROVAL_RESUME_CLAIMABLE_RUN_STATUSES as an ordered list", () => {
    expect(Array.isArray(APPROVAL_RESUME_CLAIMABLE_RUN_STATUSES)).toBe(true);
    expect([...APPROVAL_RESUME_CLAIMABLE_RUN_STATUSES]).toEqual([
      "paused_approval",
      "running",
    ]);
  });

  it("MISSION_DRAFT_REQUIRED_FIELDS keeps today's ten names in order", () => {
    expect([...MISSION_DRAFT_REQUIRED_FIELDS]).toEqual([
      "title",
      "goal",
      "capitalSource",
      "startingCapital",
      "allowedWallets",
      "allowedChains",
      "allowedProtocols",
      "riskProfile",
      "successCriteria",
      "stopConditions",
    ]);
  });

  it("MissionRunPausedError is exported as a value and keeps its shape", () => {
    const cause = Object.assign(new Error("upstream"), {
      status: 429,
      causeCode: "ECONNRESET",
      errorType: "rate_limited",
      errorClass: "RateLimitError",
      retryAfterSeconds: 7,
    });
    const err = new MissionRunPausedError({
      runId: "run-1",
      missionId: "mission-1",
      sessionId: "session-1",
      cause,
    });

    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(MissionRunPausedError);
    expect(err.name).toBe("MissionRunPausedError");
    expect(err.message).toBe("upstream");
    expect(err.cause).toBe(cause);
    expect(err.runId).toBe("run-1");
    expect(err.missionId).toBe("mission-1");
    expect(err.sessionId).toBe("session-1");
    expect(err.statusCode).toBe(429);
    expect(err.causeCode).toBe("ECONNRESET");
    expect(err.errorType).toBe("rate_limited");
    expect(err.errorClass).toBe("RateLimitError");
    expect(err.retryAfterSeconds).toBe(7);
  });

  it("MissionRunPausedError nulls every signal a bare cause does not carry", () => {
    const err = new MissionRunPausedError({
      runId: "run-2",
      missionId: "mission-2",
      sessionId: "session-2",
      cause: "plain string",
    });

    expect(err.message).toBe("plain string");
    expect(err.statusCode).toBeNull();
    expect(err.causeCode).toBeNull();
    expect(err.errorType).toBeNull();
    expect(err.errorClass).toBeNull();
    expect(err.retryAfterSeconds).toBeNull();
  });
});
