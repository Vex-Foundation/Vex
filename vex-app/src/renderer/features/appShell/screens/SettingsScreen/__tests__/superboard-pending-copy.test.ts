import { describe, expect, it } from "vitest";
import { superboardPendingCopy } from "../superboard-pending-copy.js";

describe("superboardPendingCopy", () => {
  it("keeps the quiet pending line when there is no error", () => {
    expect(superboardPendingCopy(null)).toBe("Not linked yet.");
  });

  it("never surfaces HTTP 404 not_found", () => {
    expect(superboardPendingCopy("HTTP 404 not_found")).toBe(
      "Couldn't link this key yet. Try again later.",
    );
  });

  it("maps known AgentScan outcomes to human sentences", () => {
    expect(superboardPendingCopy("unauthorized")).toBe(
      "AgentScan isn't connected. Try again after it's linked.",
    );
    expect(superboardPendingCopy("share_token_conflict")).toBe(
      "This key couldn't be linked.",
    );
    expect(superboardPendingCopy("HTTP 429 rate_limited")).toBe(
      "Too many attempts. Wait a moment and try again.",
    );
  });
});
