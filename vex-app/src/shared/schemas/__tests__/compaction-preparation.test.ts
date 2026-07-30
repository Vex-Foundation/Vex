/**
 * Compaction-preparation schema contract.
 *
 * The DTO is the leak surface of this package: the underlying row holds a
 * verbatim frozen copy of the conversation, a model-authored summary, and free
 * error text. The properties pinned here are that the schema is CLOSED (a
 * smuggled prose key is rejected, not ignored), that its enums are closed, and
 * that the apply outcome discriminates.
 */

import { describe, expect, it } from "vitest";
import {
  compactionApplyRequestResultSchema,
  compactionPreparationDtoSchema,
  compactionPreparationEventSchema,
  compactionPreparationResultSchema,
} from "../compaction-preparation.js";

const SESSION = "00000000-0000-4000-8000-0000000000d1";
const ISO = "2026-07-29T10:00:00.000Z";

function dto(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sessionId: SESSION,
    status: "summary_ready",
    summaryStatus: "succeeded",
    chunksStatus: "pending",
    summaryAttemptCount: 1,
    summaryMaxAttempts: 3,
    chunksAttemptCount: 0,
    chunksMaxAttempts: 3,
    hasSummary: true,
    applySource: null,
    applyRequestedAt: null,
    appliedAt: null,
    createdAt: ISO,
    completedAt: null,
    ...over,
  };
}

describe("compactionPreparationDtoSchema", () => {
  it("accepts the bounded projection", () => {
    expect(compactionPreparationDtoSchema.safeParse(dto()).success).toBe(true);
  });

  it("REJECTS a payload carrying summary text — the strict parse is the guard", () => {
    const leaked = compactionPreparationDtoSchema.safeParse(
      dto({ summary: "the model's condensation of the conversation" }),
    );
    expect(leaked.success).toBe(false);
  });

  it("rejects a payload carrying the frozen corpus or error prose", () => {
    expect(
      compactionPreparationDtoSchema.safeParse(dto({ corpus: "user: hi" }))
        .success,
    ).toBe(false);
    expect(
      compactionPreparationDtoSchema.safeParse(dto({ lastError: "429 …" }))
        .success,
    ).toBe(false);
  });

  it("carries no free-string field at all — every key is a scalar, enum or ISO date", () => {
    const parsed = compactionPreparationDtoSchema.parse(dto());
    expect(Object.keys(parsed).sort()).toEqual([
      "appliedAt",
      "applyRequestedAt",
      "applySource",
      "chunksAttemptCount",
      "chunksMaxAttempts",
      "chunksStatus",
      "completedAt",
      "createdAt",
      "hasSummary",
      "sessionId",
      "status",
      "summaryAttemptCount",
      "summaryMaxAttempts",
      "summaryStatus",
    ]);
  });

  it("the status enum is closed", () => {
    expect(
      compactionPreparationDtoSchema.safeParse(dto({ status: "compacting" }))
        .success,
    ).toBe(false);
  });

  it("the result is nullable — no preparation is a normal state", () => {
    expect(compactionPreparationResultSchema.parse(null)).toBeNull();
  });
});

describe("compactionApplyRequestResultSchema", () => {
  it("discriminates each outcome", () => {
    for (const outcome of [
      "queued",
      "no_live_runner",
      "already_requested",
      "not_ready",
    ] as const) {
      const parsed = compactionApplyRequestResultSchema.parse({
        outcome,
        status: "apply_requested",
      });
      expect(parsed.outcome).toBe(outcome);
    }
    expect(
      compactionApplyRequestResultSchema.parse({ outcome: "gone" }).outcome,
    ).toBe("gone");
  });

  it("rejects an unknown outcome and an outcome carrying a message", () => {
    expect(
      compactionApplyRequestResultSchema.safeParse({ outcome: "applied" })
        .success,
    ).toBe(false);
    expect(
      compactionApplyRequestResultSchema.safeParse({
        outcome: "queued",
        status: "apply_requested",
        message: "provider said …",
      }).success,
    ).toBe(false);
  });
});

describe("compactionPreparationEventSchema", () => {
  it("accepts the metadata-only event and rejects an extra field", () => {
    const base = {
      type: "engine.compaction.preparation",
      sessionId: SESSION,
      status: "summary_ready",
      summaryReady: true,
      correlationId: null,
    };
    expect(compactionPreparationEventSchema.safeParse(base).success).toBe(true);
    expect(
      compactionPreparationEventSchema.safeParse({ ...base, summary: "…" })
        .success,
    ).toBe(false);
  });
});
