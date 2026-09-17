import { describe, expect, it } from "vitest";
import type { SuperboardKeyStatus } from "@shared/schemas/superboard-key.js";
import { superboardRegisterStatus } from "../settings-sections.js";

const SHARE = "A".repeat(43);

function failedPending(): SuperboardKeyStatus {
  return {
    kind: "pending",
    shareToken: SHARE,
    attempt: {
      kind: "failed",
      at: "2026-09-08T12:00:00.000Z",
      failure: { kind: "transport", reason: "timeout" },
      detail: "VexError: Request timed out after 15000ms",
      correlationId: "corr-1",
      durationMs: 15012,
    },
  };
}

describe("superboardRegisterStatus", () => {
  it("keeps the loading dash unguessed", () => {
    expect(superboardRegisterStatus(null)).toEqual({ word: "-", tone: "neutral" });
  });

  it("keeps Not ready and Not set distinct", () => {
    expect(superboardRegisterStatus({ kind: "not_ready" })).toEqual({
      word: "Not ready",
      tone: "warning",
    });
    expect(superboardRegisterStatus({ kind: "missing" })).toEqual({
      word: "Not set",
      tone: "warning",
    });
  });

  it("links quietly and warns only on a failed attempt", () => {
    expect(
      superboardRegisterStatus({ kind: "pending", shareToken: SHARE, attempt: { kind: "none" } }),
    ).toEqual({ word: "Linking", tone: "neutral" });
    expect(superboardRegisterStatus(failedPending())).toEqual({
      word: "Not linked",
      tone: "warning",
    });
  });

  it("stays Linked whatever the rotation capability says", () => {
    for (const rotation of [
      { kind: "available" },
      { kind: "unavailable", reason: "server" },
      { kind: "unavailable", reason: "unknown" },
    ] as const) {
      expect(
        superboardRegisterStatus({
          kind: "registered",
          shareToken: SHARE,
          rotation,
          rotatedAt: null,
        }),
      ).toEqual({ word: "Linked", tone: "success" });
    }
  });

  it("names a rotation in flight Rotating", () => {
    const pending = failedPending();
    if (pending.kind !== "pending") throw new Error("fixture must be pending");
    for (const attempt of [{ kind: "none" } as const, pending.attempt]) {
      expect(
        superboardRegisterStatus({
          kind: "registered",
          shareToken: SHARE,
          rotation: { kind: "pending", attempt },
          rotatedAt: null,
        }),
      ).toEqual({ word: "Rotating", tone: "neutral" });
    }
  });
});
