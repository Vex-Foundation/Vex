/**
 * Pure type guard tests - narrowing semantics for VexError.details
 * with failedAt metadata.
 */

import { describe, it, expect } from "vitest";
import { extractFailedAt } from "../extractFailedAt.js";

describe("extractFailedAt", () => {
  it("returns FailedAt when details has valid {version, file} nested object", () => {
    expect(
      extractFailedAt({
        failedAt: { version: 15, file: "015_add_index.sql" },
      }),
    ).toEqual({ version: 15, file: "015_add_index.sql" });
  });

  it("returns null when details is not an object", () => {
    expect(extractFailedAt(null)).toBeNull();
    expect(extractFailedAt(undefined)).toBeNull();
    expect(extractFailedAt("string")).toBeNull();
    expect(extractFailedAt(42)).toBeNull();
  });

  it("returns null when failedAt key is missing", () => {
    expect(extractFailedAt({ other: "stuff" })).toBeNull();
    expect(extractFailedAt({})).toBeNull();
  });

  it("returns null when failedAt is not an object", () => {
    expect(extractFailedAt({ failedAt: "v15" })).toBeNull();
    expect(extractFailedAt({ failedAt: null })).toBeNull();
  });

  it("returns null when failedAt has wrong field types", () => {
    expect(extractFailedAt({ failedAt: { version: "15", file: "x" } })).toBeNull();
    expect(extractFailedAt({ failedAt: { version: 15, file: 42 } })).toBeNull();
    expect(extractFailedAt({ failedAt: { version: 15 } })).toBeNull();
    expect(extractFailedAt({ failedAt: { file: "x" } })).toBeNull();
  });

  it("ignores extra fields on failedAt object", () => {
    expect(
      extractFailedAt({
        failedAt: {
          version: 7,
          file: "007.sql",
          extra: "ignored",
          ts: 12345,
        },
      }),
    ).toEqual({ version: 7, file: "007.sql" });
  });
});
