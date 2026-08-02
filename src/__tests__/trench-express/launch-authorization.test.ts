/**
 * §C0 — the authorization record, and the re-derive-and-compare gate.
 *
 * The gate is NOT "is there a record?" — it is "does a binding re-derived from
 * first principles, right now, still equal the one that was authorized?".
 * Everything here pins that: which fields are bound, which drift refuses, and
 * the one field that is deliberately allowed to move.
 */

import { describe, it, expect } from "vitest";

import {
  checkLaunchAuthorizationUnchanged,
  composeLaunchMsgValue,
  describeLaunchAuthorization,
  launchImageDigest,
  type LaunchAuthorizationBinding,
} from "@vex-agent/tools/protocols/trench/handlers/launch/authorization.js";

const BINDING: LaunchAuthorizationBinding = {
  name: "Vex x Trench",
  symbol: "VEXTE",
  description: "a launch",
  links: ["https://vex.example"],
  imageId: "img_01",
  imageDigest: "0xdigest",
  chainId: 4663,
  contract: "0x3857c6c4FE93Abb40945dfc8B9d690384cBae014",
  creationFeeWei: "1000000000000000",
  prebuyWei: "300000000000000",
  msgValueWei: "1300000000000000",
  vexFeeWei: "3250000000000",
  anchorBlockNumber: "25749542",
  calldata: "0xdeadbeef",
  callFingerprint: "0xfingerprint",
  sessionId: "sess-1",
  walletAddress: "0x33eF00000000000000000000000000000000d2fA",
  permission: "full",
};

describe("composeLaunchMsgValue", () => {
  it("is the exact bigint sum of fee and prebuy", () => {
    expect(composeLaunchMsgValue(1_000n, 300n)).toBe(1_300n);
  });

  it("is the fee alone when there is no prebuy", () => {
    expect(composeLaunchMsgValue(1_000n, 0n)).toBe(1_000n);
  });

  it("refuses a zero fee — an unproven fee is not a free launch", () => {
    expect(() => composeLaunchMsgValue(0n, 100n)).toThrow(/creation fee/i);
  });

  it("refuses a negative prebuy", () => {
    expect(() => composeLaunchMsgValue(1_000n, -1n)).toThrow(/prebuy/i);
  });
});

describe("launchImageDigest", () => {
  it("is deterministic and distinguishes a one-byte change", () => {
    const a = launchImageDigest(new Uint8Array([1, 2, 3]));
    expect(launchImageDigest(new Uint8Array([1, 2, 3]))).toBe(a);
    expect(launchImageDigest(new Uint8Array([1, 2, 4]))).not.toBe(a);
  });
});

describe("checkLaunchAuthorizationUnchanged", () => {
  it("passes when nothing moved", () => {
    expect(checkLaunchAuthorizationUnchanged(BINDING, { ...BINDING })).toEqual({ ok: true });
  });

  it("REFUSES a creation fee that drifted, naming BOTH numbers", () => {
    const result = checkLaunchAuthorizationUnchanged(BINDING, {
      ...BINDING,
      creationFeeWei: "2000000000000000",
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toContain("1000000000000000");
    expect(result.reason).toContain("2000000000000000");
    expect(result.reason).toContain("Nothing was signed");
  });

  it("REFUSES an image swapped between authorization and execution", () => {
    const result = checkLaunchAuthorizationUnchanged(BINDING, {
      ...BINDING,
      imageDigest: "0xother",
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.drift.map((d) => d.field)).toEqual(["imageDigest"]);
  });

  it("REFUSES a permission downgraded after authorization", () => {
    // full → restricted between authorize and sign must not still execute
    // under authority the session no longer has.
    const result = checkLaunchAuthorizationUnchanged(BINDING, {
      ...BINDING,
      permission: "restricted",
    });
    expect(result.ok).toBe(false);
  });

  it("REFUSES substituted calldata and a substituted fingerprint", () => {
    expect(checkLaunchAuthorizationUnchanged(BINDING, { ...BINDING, calldata: "0xbad" }).ok).toBe(false);
    expect(
      checkLaunchAuthorizationUnchanged(BINDING, { ...BINDING, callFingerprint: "0xbad" }).ok,
    ).toBe(false);
  });

  it("REFUSES a msg.value that grew even when fee and prebuy look unchanged", () => {
    expect(
      checkLaunchAuthorizationUnchanged(BINDING, { ...BINDING, msgValueWei: "9900000000000000" }).ok,
    ).toBe(false);
  });

  it("REFUSES a different wallet or a different session", () => {
    expect(checkLaunchAuthorizationUnchanged(BINDING, { ...BINDING, sessionId: "sess-2" }).ok).toBe(false);
    expect(
      checkLaunchAuthorizationUnchanged(BINDING, { ...BINDING, walletAddress: "0x0000000000000000000000000000000000000001" }).ok,
    ).toBe(false);
  });

  it("REFUSES edited form fields — a renamed token is a different launch", () => {
    expect(checkLaunchAuthorizationUnchanged(BINDING, { ...BINDING, symbol: "EVIL" }).ok).toBe(false);
    expect(checkLaunchAuthorizationUnchanged(BINDING, { ...BINDING, links: [] }).ok).toBe(false);
  });

  it("ALLOWS the anchor block to move — the block always advances, the FEE must not", () => {
    expect(
      checkLaunchAuthorizationUnchanged(BINDING, { ...BINDING, anchorBlockNumber: "25999999" }),
    ).toEqual({ ok: true });
  });

  it("reports EVERY field that moved, not just the first", () => {
    const result = checkLaunchAuthorizationUnchanged(BINDING, {
      ...BINDING,
      creationFeeWei: "2000000000000000",
      imageDigest: "0xother",
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.drift.map((d) => d.field).sort()).toEqual(["creationFeeWei", "imageDigest"]);
  });
});

describe("describeLaunchAuthorization", () => {
  it("NEVER calls full autonomy 'consent' — no human acted", () => {
    const text = describeLaunchAuthorization("full_autonomy");
    expect(text).not.toMatch(/consent/i);
    expect(text).toContain("no human acted");
  });

  it("names the human acts honestly", () => {
    expect(describeLaunchAuthorization("user_submit")).toContain("user's own Deploy");
    expect(describeLaunchAuthorization("approval_card")).toContain("approval");
  });
});
