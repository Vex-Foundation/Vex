/**
 * STOP REASON - CROSS-PACKAGE VOCABULARY DRIFT GUARD.
 *
 * Sibling of `mission-run-status-vocabulary-drift.test.ts`, for the second
 * closed vocabulary that spans the process boundary. `STOP_REASONS` in
 * `engine/types/stop-reasons.ts` is the single source of truth, but
 * `check:boundaries` forbids `vex-app` from importing `src/vex-agent`, so the
 * app's strict chat schema is a hand-typed literal list and is therefore free
 * to rot.
 *
 * The cost of that rot is not cosmetic. `chatStopReasonSchema` is a STRICT
 * boundary validator: a stop reason the engine really produced and the schema
 * has never heard of does not degrade to "unknown", it fails validation, and
 * the honest account of how a turn ended is replaced by a validation error at
 * the IPC edge. Every stop reason added to the engine must arrive here in the
 * same change.
 *
 * A normal import cannot cross the boundary, so this test reads the mirror as
 * TEXT. Deliberately crude, deliberately unskippable.
 *
 * It also pins the two contracts the mission-autonomy work must NOT touch: the
 * model-facing `MissionStop` tool enum and the business stop list it mirrors.
 * A new RUNTIME cause is an engine fact about a turn; putting it in the tool
 * schema would offer the model a way to CLAIM it, which is a different and
 * much worse thing.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { describe, it, expect } from "vitest";

import {
  BUSINESS_STOP_REASONS,
  RUNTIME_STOP_REASONS,
  STOP_REASONS,
} from "@vex-agent/engine/types.js";
import {
  isBusinessStop,
  isResumablePause,
  isRuntimePause,
  shouldTerminateRun,
} from "@vex-agent/engine/core/stop-conditions.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

function read(relativePath: string): string {
  return readFileSync(resolve(REPO_ROOT, relativePath), "utf8");
}

function literalsBetween(source: string, startAnchor: string, endAnchor: string): string[] {
  const start = source.indexOf(startAnchor);
  expect(start, `anchor not found: ${startAnchor}`).toBeGreaterThan(-1);
  const end = source.indexOf(endAnchor, start + startAnchor.length);
  expect(end, `end anchor not found: ${endAnchor}`).toBeGreaterThan(-1);
  const block = source.slice(start + startAnchor.length, end);
  return [...block.matchAll(/"([a-z_]+)"/g)]
    .map((m) => m[1])
    .filter((literal): literal is string => literal !== undefined);
}

describe("stop reason vocabulary - cross-package drift guard", () => {
  it("the app's strict chat schema mirrors the canonical list, in order", () => {
    // SEQUENCE, not set: a reordering is a reviewed diff rather than a silent
    // one, and the engine tuple documents the business-then-runtime grouping
    // the schema is supposed to keep.
    expect(
      literalsBetween(
        read("vex-app/src/shared/schemas/chat.ts"),
        "export const chatStopReasonSchema = z.enum([",
        "]);",
      ),
    ).toEqual([...STOP_REASONS]);
  });

  it("the canonical list has no duplicates and no overlap between its halves", () => {
    expect(new Set(STOP_REASONS).size).toBe(STOP_REASONS.length);
    const business = new Set<string>(BUSINESS_STOP_REASONS);
    for (const runtime of RUNTIME_STOP_REASONS) {
      expect(business.has(runtime), `${runtime} is in both halves`).toBe(false);
    }
  });
});

describe("classification is exhaustive by construction", () => {
  /**
   * The gap this closes. `isRuntimePause` declares `reason is
   * RuntimeStopReason`, which is a PROMISE that it answers true for every
   * member of that union - and the hand-maintained set behind it answered
   * false for `user_paused` and `user_form_required`, so the predicate
   * narrowed to a type it had just denied. The previous test enumerated eight
   * of the members and could not see it. Enumerating the tuple itself is what
   * makes the promise structural.
   */
  it.each([...RUNTIME_STOP_REASONS])("%s is a runtime pause and not a business stop", (reason) => {
    expect(isRuntimePause(reason)).toBe(true);
    expect(isBusinessStop(reason)).toBe(false);
    expect(shouldTerminateRun(reason)).toBe(false);
  });

  it.each([...BUSINESS_STOP_REASONS])("%s is a business stop and not a runtime pause", (reason) => {
    expect(isBusinessStop(reason)).toBe(true);
    expect(isRuntimePause(reason)).toBe(false);
    expect(shouldTerminateRun(reason)).toBe(true);
  });

  it("only the three directly-resumable pauses are resumable", () => {
    // Every OTHER stop reason, including both new causes, must be non-resumable
    // by default. A resumable stop reason is a claim that some component will
    // pick the run back up on its own.
    const resumable = STOP_REASONS.filter((reason) => isResumablePause(reason));
    expect([...resumable].sort()).toEqual([
      "approval_required",
      "checkpoint_pause",
      "waiting_for_wake",
    ]);
  });
});

describe("the new causes - restart_orphan and tool_call_loop", () => {
  it.each(["restart_orphan", "tool_call_loop"] as const)(
    "%s is a runtime pause, never terminal, never auto-resumable",
    (reason) => {
      expect(RUNTIME_STOP_REASONS).toContain(reason);
      expect(isRuntimePause(reason)).toBe(true);
      expect(isBusinessStop(reason)).toBe(false);
      // `restart_orphan` needs a fresh run (the process that owned the old one
      // is gone); `tool_call_loop` needs a human to change something, because
      // resuming is precisely what the model just proved it would repeat.
      expect(isResumablePause(reason)).toBe(false);
      expect(shouldTerminateRun(reason)).toBe(false);
    },
  );

  it("`no_progress` keeps its mirror - the arm it shares must not silently move", () => {
    // The previous suite had no `no_progress` case at all, so the day it was
    // added to the union nothing here would have failed.
    expect(RUNTIME_STOP_REASONS).toContain("no_progress");
    expect(isRuntimePause("no_progress")).toBe(true);
    expect(isResumablePause("no_progress")).toBe(false);
    expect(
      read("src/vex-agent/engine/core/runner/mission-finalize.ts"),
    ).toContain('stopReason === "no_progress"');
  });

  it("each new cause has a guarded mission-finalize arm, so neither strands a run", () => {
    // Falling through to `return "running"` would leave the run row `running`
    // with no wake and no lease - an orphan the operator can neither resume nor
    // see a reason for.
    const finalize = read("src/vex-agent/engine/core/runner/mission-finalize.ts");
    expect(finalize).toContain('stopReason === "tool_call_loop"');
  });
});

describe("contracts that must NOT gain the new causes", () => {
  /**
   * The model-facing `MissionStop` tool enum. A runtime cause is the ENGINE's
   * account of a turn; exposing it here would let the model claim it, which
   * would let a looping model report itself as having been stopped for looping
   * and a crashed-process cause be asserted by inference output.
   */
  it("the MissionStop tool schema exposes only business stops", () => {
    // The enum literal lives on the registered tool's JSON schema - the shape
    // the MODEL is actually shown - not on the handler.
    const source = literalsBetween(
      read("src/vex-agent/tools/registry/mission.ts"),
      "reason: { type: \"string\", enum: [",
      "]",
    );
    // Exact sequence: business stops minus `user_stopped`, which is the
    // OPERATOR's stop and never the model's to declare.
    expect(source).toEqual(
      BUSINESS_STOP_REASONS.filter((reason) => reason !== "user_stopped"),
    );
  });
});
