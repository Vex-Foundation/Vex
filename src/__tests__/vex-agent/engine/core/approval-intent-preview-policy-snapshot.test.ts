/**
 * The policy snapshot an approval is enqueued with - pure-function tests.
 *
 * Split out of `approval-intent-preview.test.ts` (2026-09-04) when that file
 * passed the 750-line gate. It is a different contract from the preview: the
 * snapshot records WHO asked and UNDER WHAT PERMISSION, and it is read by the
 * audit row rather than bound by the approval digest. Assertions are unchanged
 * by the move.
 */

import { describe, it, expect } from "vitest";
import type { InternalToolContext } from "@vex-agent/tools/internal/types.js";
import { makeTestContext } from "../../tools/_test-context.js";
import { buildPolicySnapshot } from "@vex-agent/engine/core/approval-intent-preview.js";

describe("buildPolicySnapshot", () => {
  const baseContext: InternalToolContext = makeTestContext({
    sessionId: "00000000-0000-4000-8000-000000000001",
    missionRunId: "run-1",
    missionId: "mission-1",
    sessionKind: "mission",
    contextUsageBand: "warning",
  });

  it("snapshots the documented policy fields verbatim", () => {
    const snap = buildPolicySnapshot(baseContext);
    expect(snap).toEqual({
      permission: "restricted",
      sessionKind: "mission",
      missionRunActive: true,
      contextUsageBand: "warning",
      missionId: "mission-1",
      missionRunId: "run-1",
      // Nobody external asked: this is Vex's own agent loop, so the snapshot
      // records no client and the card names none rather than inventing one.
      requestedByClient: null,
    });
  });

  it("derives missionRunActive=false when missionRunId is null", () => {
    const snap = buildPolicySnapshot({ ...baseContext, missionRunId: null });
    expect(snap.missionRunActive).toBe(false);
    expect(snap.missionRunId).toBeNull();
  });

  it("captures permission='full' in the approval audit snapshot", () => {
    const snap = buildPolicySnapshot({ ...baseContext, sessionPermission: "full" });
    expect(snap.permission).toBe("full");
  });

  it("captures contextUsageBand at enqueue time (not re-derived later)", () => {
    const snap = buildPolicySnapshot({ ...baseContext, contextUsageBand: "critical" });
    expect(snap.contextUsageBand).toBe("critical");
  });
});
