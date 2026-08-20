/**
 * long-memory schema tests (memory-system S9 rewire) — boundary validation
 * for the read-only long-term memory list.
 *
 * Pins: bounded input limit, the engine-mirrored enum sets, and the DTO's
 * SANITIZATION contract (strict object — a raw `content_md` / embedding
 * field fails the parse instead of leaking through).
 */

import { describe, expect, it } from "vitest";
import {
  LONG_MEMORY_LIST_DEFAULT_LIMIT,
  LONG_MEMORY_LIST_MAX_LIMIT,
  LONG_MEMORY_MATURITY_STATES,
  LONG_MEMORY_SOURCES,
  LONG_MEMORY_STATUSES,
  longMemoryEntryDtoSchema,
  longMemoryListInputSchema,
  longMemoryListResultSchema,
} from "../long-memory.js";

const ISO = "2026-05-21T10:00:00.000Z";

function validEntry(): Record<string, unknown> {
  return {
    id: 1,
    kind: "risk_rule",
    title: "Avoid X",
    summary: "Short summary",
    tags: ["risk"],
    confidence: 0.8,
    status: "active",
    source: "observed",
    maturityState: "established",
    pinned: false,
    createdAt: ISO,
    updatedAt: ISO,
  };
}

describe("longMemoryListInputSchema", () => {
  it("defaults the limit and accepts an optional status", () => {
    const parsed = longMemoryListInputSchema.parse({});
    expect(parsed.limit).toBe(LONG_MEMORY_LIST_DEFAULT_LIMIT);
    expect(parsed.status).toBeUndefined();

    const filtered = longMemoryListInputSchema.parse({ status: "archived" });
    expect(filtered.status).toBe("archived");
  });

  it("caps the limit at the max and rejects above it", () => {
    expect(
      longMemoryListInputSchema.parse({ limit: LONG_MEMORY_LIST_MAX_LIMIT })
        .limit,
    ).toBe(LONG_MEMORY_LIST_MAX_LIMIT);
    expect(
      longMemoryListInputSchema.safeParse({
        limit: LONG_MEMORY_LIST_MAX_LIMIT + 1,
      }).success,
    ).toBe(false);
    expect(longMemoryListInputSchema.safeParse({ limit: 0 }).success).toBe(
      false,
    );
  });

  it("rejects unknown keys and unknown statuses (strict boundary)", () => {
    expect(
      longMemoryListInputSchema.safeParse({ scope: "all" }).success,
    ).toBe(false);
    expect(
      longMemoryListInputSchema.safeParse({ status: "draft" }).success,
    ).toBe(false);
  });
});

describe("longMemoryEntryDtoSchema", () => {
  it("accepts a fully-populated sanitized entry", () => {
    expect(longMemoryEntryDtoSchema.safeParse(validEntry()).success).toBe(true);
  });

  it("accepts null source/maturityState/confidence (legacy rows)", () => {
    const parsed = longMemoryEntryDtoSchema.safeParse({
      ...validEntry(),
      source: null,
      maturityState: null,
      confidence: null,
    });
    expect(parsed.success).toBe(true);
  });

  it("REJECTS raw narrative/embedding fields (strict DTO - sanitization pin)", () => {
    for (const forbidden of [
      "content_md",
      "source_refs",
      "content_hash",
      "embedding",
    ]) {
      const result = longMemoryEntryDtoSchema.safeParse({
        ...validEntry(),
        [forbidden]: "RAW",
      });
      expect(result.success, forbidden).toBe(false);
    }
  });

  it("rejects out-of-set status/source/maturity values", () => {
    expect(
      longMemoryEntryDtoSchema.safeParse({ ...validEntry(), status: "draft" })
        .success,
    ).toBe(false);
    expect(
      longMemoryEntryDtoSchema.safeParse({ ...validEntry(), source: "rumor" })
        .success,
    ).toBe(false);
    expect(
      longMemoryEntryDtoSchema.safeParse({
        ...validEntry(),
        maturityState: "legendary",
      }).success,
    ).toBe(false);
  });
});

describe("enum sets mirror the engine", () => {
  it("statuses", () => {
    expect([...LONG_MEMORY_STATUSES]).toEqual([
      "active",
      "superseded",
      "invalidated",
      "archived",
    ]);
  });

  it("sources", () => {
    expect([...LONG_MEMORY_SOURCES]).toEqual([
      "observed",
      "user_confirmed",
      "inferred",
      "hypothesis",
    ]);
  });

  it("maturity states", () => {
    expect([...LONG_MEMORY_MATURITY_STATES]).toEqual([
      "probationary",
      "established",
      "reinforced",
      "decayed",
    ]);
  });
});

describe("longMemoryListResultSchema", () => {
  it("parses an array of entries", () => {
    expect(
      longMemoryListResultSchema.safeParse([validEntry(), validEntry()])
        .success,
    ).toBe(true);
  });
});
