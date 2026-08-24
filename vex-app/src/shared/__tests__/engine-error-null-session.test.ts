/**
 * Null-session contract for `EV.engine.error`.
 *
 * A `null` sessionId is a POSITIVE claim that the failure is system-wide — not
 * "unknown", not a wildcard. Memory-manager jobs are the case: `memory_jobs`
 * has no `session_id` column because consolidation and reconcile are global
 * maintenance over `knowledge_entries`.
 *
 * The nullability is deliberately on the FIELD, not in the field's own
 * validator: when a session IS named it must still be a real UUID, because
 * that is the path where a malformed id actually does damage.
 */

import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  engineErrorEventSchema,
  engineErrorScopeSchema,
} from "../schemas/engine-error.js";

function event(over: Record<string, unknown> = {}) {
  return {
    type: "engine.runtime.error" as const,
    sessionId: randomUUID(),
    missionRunId: null,
    scope: "turn" as const,
    category: "capacity" as const,
    errorType: null,
    errorClass: null,
    statusCode: null,
    causeCode: null,
    retryAfterSeconds: null,
    occurredAt: new Date().toISOString(),
    correlationId: null,
    ...over,
  };
}

describe("engineErrorEventSchema - sessionId nullability", () => {
  it("accepts a null sessionId (global failure)", () => {
    const parsed = engineErrorEventSchema.safeParse(
      event({ sessionId: null, scope: "memory" }),
    );
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.sessionId).toBeNull();
  });

  it("accepts a real UUID sessionId (session-scoped failure)", () => {
    expect(engineErrorEventSchema.safeParse(event()).success).toBe(true);
  });

  it("STILL rejects a malformed sessionId - nullable is not loose", () => {
    // The whole point of nullable-on-the-field: a present session id is the
    // path where a bad value routes a banner to the wrong place, so it keeps
    // its UUID guard.
    expect(engineErrorEventSchema.safeParse(event({ sessionId: "" })).success).toBe(
      false,
    );
    expect(
      engineErrorEventSchema.safeParse(event({ sessionId: "not-a-uuid" })).success,
    ).toBe(false);
    expect(
      engineErrorEventSchema.safeParse(event({ sessionId: "session-123" })).success,
    ).toBe(false);
  });

  it("rejects an absent sessionId - null must be stated, not implied", () => {
    const { sessionId: _omitted, ...withoutSession } = event();
    expect(engineErrorEventSchema.safeParse(withoutSession).success).toBe(false);
  });
});

describe("engineErrorScopeSchema - closed vocabulary", () => {
  it("includes `memory` and stays closed", () => {
    expect(engineErrorScopeSchema.options).toEqual([
      "turn",
      "mission",
      "wake",
      "compact",
      "memory",
      "approval",
    ]);
    expect(engineErrorScopeSchema.safeParse("whatever").success).toBe(false);
  });

  it("validates a memory-scoped global failure end to end", () => {
    const parsed = engineErrorEventSchema.safeParse(
      event({
        sessionId: null,
        scope: "memory",
        category: "unknown",
        missionRunId: null,
      }),
    );
    expect(parsed.success).toBe(true);
  });
});
