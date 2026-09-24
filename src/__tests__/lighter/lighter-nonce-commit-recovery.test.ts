/**
 * The commit-point nonce retry every approved Lighter action runs before it
 * refuses: one recovery pass for a slot an earlier action still holds, then a
 * second observation.
 */

import { describe, expect, it, vi } from "vitest";

import { observeLighterNonceWithRecovery } from "@vex-agent/tools/protocols/lighter/nonce-commit-recovery.js";

const SCOPE = { environment: "rhc" as const, accountIndex: 31824 };

describe("observeLighterNonceWithRecovery", () => {
  it("does not run recovery when the first observation succeeds", async () => {
    const observe = vi.fn(async () => "observed");
    const recover = vi.fn(async () => ({}));

    await expect(observeLighterNonceWithRecovery({ scope: SCOPE, observe, recover })).resolves.toBe("observed");
    expect(recover).not.toHaveBeenCalled();
    expect(observe).toHaveBeenCalledTimes(1);
  });

  it("recovers the account's reservations once and observes again", async () => {
    let released = false;
    const observe = vi.fn(async () => (released ? "observed" : null));
    const recover = vi.fn(async () => { released = true; });

    await expect(observeLighterNonceWithRecovery({ scope: SCOPE, observe, recover })).resolves.toBe("observed");
    expect(recover).toHaveBeenCalledWith(SCOPE);
    expect(observe).toHaveBeenCalledTimes(2);
  });

  it("still observes again when recovery itself fails, and reports the block", async () => {
    const observe = vi.fn(async () => null);
    const recover = vi.fn(async () => { throw new Error("provider down"); });

    await expect(observeLighterNonceWithRecovery({ scope: SCOPE, observe, recover })).resolves.toBeNull();
    expect(observe).toHaveBeenCalledTimes(2);
  });

  it("refuses on the first observation when no recovery is installed", async () => {
    const observe = vi.fn(async () => null);

    await expect(observeLighterNonceWithRecovery({ scope: SCOPE, observe, recover: undefined })).resolves.toBeNull();
    expect(observe).toHaveBeenCalledTimes(1);
  });
});
