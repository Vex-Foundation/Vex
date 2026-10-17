import { describe, expect, it } from "vitest";
import {
  DATABASE_MARGIN_BYTES,
  diskVerdict,
  memoryVerdict,
} from "../local-runtime-requirements.js";

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;
/** EMBEDDING_MODEL_SPEC.bytes (main/runtime/native/model-store.ts). */
const MODEL_BYTES = 333_590_944;

const firstRun = { modelVerified: false, modelBytesToWrite: MODEL_BYTES };
const returning = { modelVerified: true, modelBytesToWrite: 0 };

describe("disk", () => {
  it("plenty of room is ok", () => {
    expect(diskVerdict({ ...firstRun, freeBytes: 120 * GiB, totalBytes: 500 * GiB })).toEqual({ level: "ok" });
  });

  it("warns under 2 GiB free, whatever the volume's size", () => {
    expect(diskVerdict({ ...returning, freeBytes: 2 * GiB - 1, totalBytes: 8 * GiB })).toEqual({
      level: "warn",
      reason: "low_free",
    });
    expect(diskVerdict({ ...returning, freeBytes: 2 * GiB, totalBytes: 8 * GiB })).toEqual({ level: "ok" });
  });

  it("warns under 10% free only while free space is under 20 GiB", () => {
    // 16 GiB free of 228 GiB (7%): this Mac's disk the day the rule was written.
    expect(diskVerdict({ ...returning, freeBytes: 16 * GiB, totalBytes: 228 * GiB })).toEqual({
      level: "warn",
      reason: "low_fraction",
    });
    // 7% of a large disk, but 21 GiB free: no warning.
    expect(diskVerdict({ ...returning, freeBytes: 21 * GiB, totalBytes: 300 * GiB })).toEqual({ level: "ok" });
    // Under 20 GiB but 10% or more free.
    expect(diskVerdict({ ...returning, freeBytes: 5 * GiB, totalBytes: 50 * GiB })).toEqual({ level: "ok" });
  });

  it("blocks a first run that cannot fit the model plus the database's margin", () => {
    const requiredBytes = MODEL_BYTES + DATABASE_MARGIN_BYTES;
    expect(diskVerdict({ ...firstRun, freeBytes: requiredBytes - 1, totalBytes: 64 * GiB })).toEqual({
      level: "block",
      requiredBytes,
    });
    // Exactly enough is not blocked, though it is low.
    expect(diskVerdict({ ...firstRun, freeBytes: requiredBytes, totalBytes: 64 * GiB })).toEqual({
      level: "warn",
      reason: "low_free",
    });
  });

  it("counts only the model bytes still to come", () => {
    const half = { modelVerified: false, modelBytesToWrite: MODEL_BYTES / 2 };
    expect(diskVerdict({ ...half, freeBytes: MODEL_BYTES / 2 + DATABASE_MARGIN_BYTES, totalBytes: 64 * GiB }).level).toBe("warn");
  });

  it("never blocks once the model is verified on disk", () => {
    expect(diskVerdict({ ...returning, freeBytes: 10 * MiB, totalBytes: 64 * GiB })).toEqual({
      level: "warn",
      reason: "low_free",
    });
  });
});

describe("memory", () => {
  it("warns under 4 GB of memory", () => {
    expect(memoryVerdict(3 * GiB)).toBe("warn");
    expect(memoryVerdict(3_999_999_999)).toBe("warn");
  });

  it("a 4 GB machine, reported a little under 4 GiB, is not warned", () => {
    expect(memoryVerdict(4 * GiB - 150 * MiB)).toBe("ok");
    expect(memoryVerdict(16 * GiB)).toBe("ok");
  });
});
