/**
 * Contract tests for the `vex.sessions.rename` boundary schemas: the input
 * rides the same `sessionTitleSchema` bound the create path uses, and the
 * result is a nullable list item.
 */

import { describe, expect, it } from "vitest";
import {
  SESSION_TITLE_MAX_LENGTH,
  sessionRenameInputSchema,
  sessionRenameResultSchema,
} from "../sessions.js";

const ID = "11111111-1111-4111-8111-111111111111";

describe("sessionRenameInputSchema", () => {
  it("accepts a uuid id + bounded name, trimming whitespace", () => {
    const parsed = sessionRenameInputSchema.parse({ id: ID, name: "  Renamed  " });
    expect(parsed).toEqual({ id: ID, name: "Renamed" });
  });

  it("rejects an empty or whitespace-only name", () => {
    expect(sessionRenameInputSchema.safeParse({ id: ID, name: "" }).success).toBe(false);
    expect(sessionRenameInputSchema.safeParse({ id: ID, name: "   " }).success).toBe(false);
  });

  it("rejects a name past the 80-char bound (and accepts exactly 80)", () => {
    const atLimit = "a".repeat(SESSION_TITLE_MAX_LENGTH);
    expect(sessionRenameInputSchema.safeParse({ id: ID, name: atLimit }).success).toBe(true);
    expect(
      sessionRenameInputSchema.safeParse({ id: ID, name: `${atLimit}b` }).success,
    ).toBe(false);
  });

  it("rejects a non-uuid id and unknown extra fields (strict)", () => {
    expect(
      sessionRenameInputSchema.safeParse({ id: "not-a-uuid", name: "x" }).success,
    ).toBe(false);
    expect(
      sessionRenameInputSchema.safeParse({ id: ID, name: "x", extra: 1 }).success,
    ).toBe(false);
  });
});

describe("sessionRenameResultSchema", () => {
  it("accepts null (unknown / soft-deleted id)", () => {
    expect(sessionRenameResultSchema.safeParse(null).success).toBe(true);
  });
});
