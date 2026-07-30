/**
 * ID-SHAPE contract: engine-minted ids must survive every boundary schema.
 *
 * THE BUG THIS EXISTS TO PREVENT. Only `sessions.id` is a database UUID.
 * Mission ids and mission-run ids are engine-minted tokens
 * (`mission-<epochMillis>-<hex>` from `engine/mission/renew.ts`,
 * `run-<epochMillis>-<hex>` from `core/runner/mission-prepare.ts`). A `.uuid()`
 * on either is not a tightening — it is a VALIDATE-THEN-DROP bug: the value is
 * well-formed, main rejects it, the event never reaches the renderer, and the
 * surface silently falls back to polling. It fails only for users who renewed a
 * mission, which is exactly the case least likely to be caught by hand.
 *
 * The fixtures below are built with the REAL generator expressions, not
 * hand-written look-alikes, so a change to how ids are minted shows up here.
 */

import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { engineErrorEventSchema } from "../schemas/engine-error.js";
import { missionUpdateEventSchema } from "../schemas/mission-update.js";
import {
  missionIdField,
  missionRunIdField,
  sessionIdField,
} from "../schemas/mission/_common.js";

/** Verbatim from `engine/mission/renew.ts:217`. */
const renewedMissionId = (): string =>
  `mission-${Date.now()}-${randomUUID().slice(0, 8)}`;

/** Verbatim from `core/runner/mission-prepare.ts:215`. */
const preparedRunId = (): string => `run-${Date.now()}-${randomUUID().slice(0, 8)}`;

const SESSION = randomUUID();

describe("canonical id fields", () => {
  it("accepts the engine's renewed mission id and prepared run id", () => {
    expect(missionIdField.safeParse(renewedMissionId()).success).toBe(true);
    expect(missionRunIdField.safeParse(preparedRunId()).success).toBe(true);
  });

  it("still accepts a UUID mission id — the original creation path", () => {
    expect(missionIdField.safeParse(randomUUID()).success).toBe(true);
  });

  it("keeps sessionId a real UUID — that one IS database-generated", () => {
    expect(sessionIdField.safeParse(SESSION).success).toBe(true);
    expect(sessionIdField.safeParse(renewedMissionId()).success).toBe(false);
  });

  it("rejects an empty id rather than forwarding a meaningless reference", () => {
    expect(missionIdField.safeParse("").success).toBe(false);
    expect(missionRunIdField.safeParse("").success).toBe(false);
  });
});

describe("missionUpdate — a RENEWED mission survives the boundary", () => {
  const event = (missionId: string | null) => ({
    type: "engine.mission.update" as const,
    sessionId: SESSION,
    missionId,
    kind: "draft_updated" as const,
    occurredAt: new Date().toISOString(),
  });

  it("validates an update for a renewed mission (the dropped case)", () => {
    const parsed = missionUpdateEventSchema.safeParse(event(renewedMissionId()));
    expect(parsed.success).toBe(true);
  });

  it("validates a UUID mission and a null mission (chat-session approval)", () => {
    expect(missionUpdateEventSchema.safeParse(event(randomUUID())).success).toBe(true);
    expect(missionUpdateEventSchema.safeParse(event(null)).success).toBe(true);
  });
});

describe("engine.error — a run-scoped failure survives the boundary", () => {
  const event = (missionRunId: string | null) => ({
    type: "engine.runtime.error" as const,
    sessionId: SESSION,
    missionRunId,
    scope: "mission" as const,
    category: "capacity" as const,
    errorType: "rate_limit_exceeded",
    errorClass: null,
    statusCode: 429,
    causeCode: null,
    retryAfterSeconds: 41,
    occurredAt: new Date().toISOString(),
    correlationId: null,
  });

  it("validates a failure naming the run it came from", () => {
    // A `.uuid()` here would have dropped every MISSION failure — the ones a
    // user most needs to see — while letting chat-turn failures through.
    expect(engineErrorEventSchema.safeParse(event(preparedRunId())).success).toBe(true);
  });

  it("validates a run-less failure (chat turn, memory job)", () => {
    expect(engineErrorEventSchema.safeParse(event(null)).success).toBe(true);
  });
});
