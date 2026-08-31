/**
 * The persisted mission error text is BOUNDED, and the bound is REPORTED.
 *
 * A bare `slice` here would hand the operator and the support record a
 * partial provider message that looks like the whole one. The contract is:
 * under the limit the message is verbatim with no marker; over it, the
 * stored text names the cut and the ORIGINAL length so the reader can tell
 * exactly how much is missing.
 */

import { describe, expect, it } from "vitest";
import {
  ERROR_MESSAGE_LIMIT,
  boundErrorMessage,
} from "../../../../../vex-agent/engine/core/runner/mission-finalize/error-pause.js";

describe("boundErrorMessage", () => {
  it("stores a short message verbatim and adds no truncation marker", () => {
    const message = "upstream provider returned 502";
    expect(boundErrorMessage(message)).toBe(message);
    expect(boundErrorMessage(message)).not.toContain("truncated");
  });

  it("stores a message exactly at the limit verbatim", () => {
    const message = "x".repeat(ERROR_MESSAGE_LIMIT);
    expect(boundErrorMessage(message)).toBe(message);
    expect(boundErrorMessage(message)).not.toContain("truncated");
  });

  it("keeps the first ERROR_MESSAGE_LIMIT characters when the message is longer", () => {
    const original = "y".repeat(ERROR_MESSAGE_LIMIT + 1234);
    const bounded = boundErrorMessage(original);
    expect(bounded.startsWith(original.slice(0, ERROR_MESSAGE_LIMIT))).toBe(true);
  });

  it("names the cut and the original length instead of hiding the rest", () => {
    const originalLength = ERROR_MESSAGE_LIMIT + 1234;
    const bounded = boundErrorMessage("y".repeat(originalLength));
    // The marker must state BOTH how much is shown and how much existed;
    // a bare "..." would tell the reader nothing about what is missing.
    expect(bounded).toContain(
      `[truncated: first ${ERROR_MESSAGE_LIMIT} of ${originalLength} characters shown]`,
    );
    expect(bounded).not.toMatch(/\.\.\.$/);
  });
});
