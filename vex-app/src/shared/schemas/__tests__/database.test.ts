/**
 * Schema contract tests for `vex.database.*` (M6). Mirrors docker.test.ts
 * style — strictness + happy + negative paths per skill §12.
 */

import { describe, expect, it } from "vitest";
import {
  migrateInputSchema,
  migrateProgressSchema,
  migrateResultSchema,
} from "../database.js";

describe("migrateInputSchema", () => {
  it("accepts an empty payload", () => {
    expect(migrateInputSchema.safeParse({}).success).toBe(true);
  });

  it("rejects extra fields (strict)", () => {
    expect(migrateInputSchema.safeParse({ extra: 1 }).success).toBe(false);
  });
});

describe("migrateResultSchema", () => {
  it("accepts kind=applied with files + count + message", () => {
    const result = migrateResultSchema.safeParse({
      kind: "applied",
      applied: 3,
      files: ["001_a.sql", "002_b.sql", "003_c.sql"],
      message: "Applied 3 migrations.",
    });
    expect(result.success).toBe(true);
  });

  it("accepts kind=noop with message only", () => {
    const result = migrateResultSchema.safeParse({
      kind: "noop",
      message: "All migrations already applied.",
    });
    expect(result.success).toBe(true);
  });

  it("rejects applied without message", () => {
    const result = migrateResultSchema.safeParse({
      kind: "applied",
      applied: 0,
      files: [],
    });
    expect(result.success).toBe(false);
  });

  it("rejects negative applied count", () => {
    const result = migrateResultSchema.safeParse({
      kind: "applied",
      applied: -1,
      files: [],
      message: "x",
    });
    expect(result.success).toBe(false);
  });

  it("rejects unknown kind (no failed branch - failures go through err())", () => {
    const result = migrateResultSchema.safeParse({
      kind: "failed",
      message: "boom",
    });
    expect(result.success).toBe(false);
  });

  it("rejects extra fields on noop branch", () => {
    const result = migrateResultSchema.safeParse({
      kind: "noop",
      message: "x",
      applied: 0,
    });
    expect(result.success).toBe(false);
  });

  it("rejects extra fields on applied branch", () => {
    const result = migrateResultSchema.safeParse({
      kind: "applied",
      applied: 1,
      files: ["001.sql"],
      message: "x",
      extra: "leak",
    });
    expect(result.success).toBe(false);
  });
});

describe("migrateProgressSchema", () => {
  it("accepts planned event", () => {
    const result = migrateProgressSchema.safeParse({
      phase: "planned",
      index: 0,
      total: 5,
      version: 0,
      file: "",
      ts: 1234,
    });
    expect(result.success).toBe(true);
  });

  it("accepts start event", () => {
    const result = migrateProgressSchema.safeParse({
      phase: "start",
      index: 2,
      total: 5,
      version: 3,
      file: "003_x.sql",
      ts: 1234,
    });
    expect(result.success).toBe(true);
  });

  it("accepts applied event", () => {
    const result = migrateProgressSchema.safeParse({
      phase: "applied",
      index: 4,
      total: 5,
      version: 5,
      file: "005_e.sql",
      ts: 1234,
    });
    expect(result.success).toBe(true);
  });

  it("rejects unknown phase", () => {
    const result = migrateProgressSchema.safeParse({
      phase: "rolling-back",
      index: 0,
      total: 0,
      version: 0,
      file: "",
      ts: 0,
    });
    expect(result.success).toBe(false);
  });

  it("rejects negative index", () => {
    const result = migrateProgressSchema.safeParse({
      phase: "start",
      index: -1,
      total: 5,
      version: 1,
      file: "001.sql",
      ts: 1,
    });
    expect(result.success).toBe(false);
  });

  it("rejects unknown extra fields", () => {
    const result = migrateProgressSchema.safeParse({
      phase: "planned",
      index: 0,
      total: 0,
      version: 0,
      file: "",
      ts: 0,
      extra: "leak",
    });
    expect(result.success).toBe(false);
  });
});
