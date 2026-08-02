/**
 * C0 trusted provenance — the reader that refuses instead of guessing.
 *
 * The property under test is a security one: a dispatch that carries NO
 * mission provenance must be refused BY NAME, never treated as "no mission,
 * therefore fine". The `full_autonomy` authorization variant has no human act
 * to bind; the mission is the only thing that authorized the spend.
 */

import { describe, it, expect } from "vitest";

import {
  requireExecutionProvenance,
} from "@vex-agent/tools/protocols/execution-provenance.js";
import type { ProtocolExecutionContext } from "@vex-agent/tools/protocols/types.js";

function context(
  overrides: Partial<ProtocolExecutionContext> = {},
): ProtocolExecutionContext {
  return {
    sessionPermission: "full",
    approved: false,
    walletResolution: { source: "session", evm: null, solana: null },
    walletPolicy: { kind: "invalid", reason: "test" },
    ...overrides,
  } as ProtocolExecutionContext;
}

describe("requireExecutionProvenance", () => {
  it("returns the provenance when session, mission and run are all present", () => {
    const result = requireExecutionProvenance(
      context({ sessionId: "s1", missionId: "m1", missionRunId: "r1" }),
    );
    expect(result).toEqual({
      ok: true,
      provenance: { sessionId: "s1", missionId: "m1", missionRunId: "r1" },
    });
  });

  it("refuses a dispatch with no mission provenance and names every missing field", () => {
    const result = requireExecutionProvenance(context({ sessionId: "s1" }));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.missing).toEqual(["missionId", "missionRunId"]);
    expect(result.reason).toContain("missionId");
    expect(result.reason).toContain("missionRunId");
  });

  it("treats explicit null the same as absent", () => {
    const result = requireExecutionProvenance(
      context({ sessionId: "s1", missionId: null, missionRunId: "r1" }),
    );
    expect(result.ok).toBe(false);
  });

  it("treats a whitespace-only id as absent rather than as an id", () => {
    const result = requireExecutionProvenance(
      context({ sessionId: "s1", missionId: "   ", missionRunId: "r1" }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.missing).toEqual(["missionId"]);
  });
});
