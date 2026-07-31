/**
 * `deriveToolDisplayStatus` unit coverage.
 *
 * Pins the ambiguous-broadcast display contract: a tool result whose
 * structured `data.status` is exactly `"pending"` yields the `"pending"`
 * display status; EVERY other shape yields `null`. The derivation is
 * display-only — it never touches the model-facing `success` flag — and it
 * treats `data` as untrusted (non-object, array, wrong-typed, or unrelated
 * status values must not produce a status).
 */

import { describe, it, expect } from "vitest";
import { deriveToolDisplayStatus } from "@vex-agent/engine/core/tool-display-status.js";

describe("deriveToolDisplayStatus", () => {
  it("derives 'pending' from the ambiguous-broadcast contract data.status", () => {
    expect(
      deriveToolDisplayStatus({ txHash: "0xabc", status: "pending" }),
    ).toBe("pending");
  });

  it("derives 'pending' from khalani's filled_unverified in-progress body", () => {
    // `khalani/handlers/bridge-poll.ts:66` — the provider says `filled` but the
    // destination fill is UNVERIFIED, so the row is honestly in progress.
    expect(
      deriveToolDisplayStatus({ status: "filled_unverified", orderId: "o1" }),
    ).toBe("pending");
  });

  it("derives 'pending' from relay's in_flight guard body", () => {
    // `relay/handlers/bridge.ts:415`.
    expect(deriveToolDisplayStatus({ status: "in_flight" })).toBe("pending");
  });

  it("returns null for every status outside the closed allowlist", () => {
    expect(deriveToolDisplayStatus({ status: "confirmed" })).toBeNull();
    expect(deriveToolDisplayStatus({ status: "" })).toBeNull();
    // Fail-closed on anything unknown — a new in-progress literal must be
    // admitted deliberately, not inferred.
    expect(deriveToolDisplayStatus({ status: "in-flight" })).toBeNull();
    expect(deriveToolDisplayStatus({ status: "unverified" })).toBeNull();
  });

  it("keeps khalani's TERMINAL failures failed — the funds never arrived", () => {
    expect(deriveToolDisplayStatus({ status: "failed" })).toBeNull();
    expect(deriveToolDisplayStatus({ status: "refunded" })).toBeNull();
  });

  it("returns null when data carries no status at all", () => {
    expect(deriveToolDisplayStatus({})).toBeNull();
    expect(deriveToolDisplayStatus({ txHash: "0xabc" })).toBeNull();
  });

  it("treats data as untrusted — non-object shapes never yield a status", () => {
    expect(deriveToolDisplayStatus(undefined)).toBeNull();
    expect(deriveToolDisplayStatus(null)).toBeNull();
    expect(deriveToolDisplayStatus("pending")).toBeNull();
    expect(deriveToolDisplayStatus(["pending"])).toBeNull();
    expect(deriveToolDisplayStatus([{ status: "pending" }])).toBeNull();
  });

  it("does not coerce a wrong-typed status value", () => {
    expect(deriveToolDisplayStatus({ status: 1 })).toBeNull();
    expect(deriveToolDisplayStatus({ status: true })).toBeNull();
    expect(deriveToolDisplayStatus({ status: { kind: "pending" } })).toBeNull();
    // Case and padding are NOT normalized — the contract is an exact literal.
    expect(deriveToolDisplayStatus({ status: "PENDING" })).toBeNull();
    expect(deriveToolDisplayStatus({ status: " pending" })).toBeNull();
  });
});
