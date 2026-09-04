/**
 * The `/pools-fun/launches/prepare` contract, proven against the bytes the
 * provider actually sends TODAY.
 *
 * WHY THIS FILE EXISTS. The provider changed three fields of this endpoint under
 * us, and the launch path was 100% dead as a result: `feeRecipient` went from a
 * string to an object on BOTH the request and the response, `pairedAsset` went
 * from a string to an object on the response, and `value` is hex where every
 * sibling amount is decimal. The first defect returned HTTP 400 on every launch;
 * the other two would have thrown inside the validator on the first body that
 * got past it. Each is pinned here so the next drift is a red test rather than a
 * dead launch path.
 */

import { describe, expect, it } from "vitest";
import { getAddress } from "viem";

import { captureResponse, errorCapture, CAPTURES } from "./_captures.js";
import { validatePrepareResponse } from "@tools/pools-fun/validation.js";
import { decodeLaunchCalldata } from "@tools/pools-fun/launch/verify-calldata.js";
import { toPrepareFeeRecipient } from "@vex-agent/tools/protocols/pools/handlers/launch/execute/plan.js";

const live = () => captureResponse(CAPTURES.prepareWalletRecipient);
const FIXTURE_WALLET = "0x1111111111111111111111111111111111111111";

describe("the live prepare body validates", () => {
  it("accepts the real response verbatim", () => {
    const parsed = validatePrepareResponse(live());
    expect(parsed.feeRecipient.address).toBe(FIXTURE_WALLET);
    expect(parsed.pairedAsset.symbol).toBe("WETH");
    expect(parsed.requiresReprepare).toBe(false);
  });

  it("normalises the HEX `value` to decimal wei, because every sibling amount is decimal", () => {
    // The raw byte is `0x3bc7def507320`; the same number appears as
    // `deploymentFeeWei: "1051674002092832"` on the same body.
    const raw = live() as { value: string; deploymentFeeWei: string };
    expect(raw.value.startsWith("0x")).toBe(true);
    const parsed = validatePrepareResponse(live());
    expect(parsed.value).toBe(raw.deploymentFeeWei);
  });

  it("keeps `display` as a display field, not an address", () => {
    // A truncated label could never be compared to a full address; typing it
    // strictly would have taken the launch path down for a UI string.
    expect(validatePrepareResponse(live()).feeRecipient.display).toBe("0x1111…1111");
    const noDisplay = { ...(live() as object), feeRecipient: { address: FIXTURE_WALLET } };
    expect(validatePrepareResponse(noDisplay).feeRecipient.display).toBeNull();
  });

  it("no longer DECODES, because launches are V3-only and the V1 fragment is deleted", () => {
    // An intentional contract change, recorded rather than quietly dropped.
    // Launches target the V3 suite (owner decision D-suites) whose `launch`
    // selector is 0x3cc0226c over a 14-member tuple; V1's 0xb3ee5495 over 12
    // members has no consumer left, and keeping both fragments in one ABI would
    // make `decodeFunctionData` ambiguous on the exact call that spends money.
    // The verifier reports this as a named `selector_and_encoding` refusal.
    expect(live().data.slice(0, 10)).toBe("0xb3ee5495");
    expect(decodeLaunchCalldata(live().data as `0x${string}`)).toBeNull();
  });

  it("the V3 response's recipient IS the one inside its own calldata", () => {
    // The relation point 4 checks, now pinned on the suite that is actually
    // launched against. The holders capture is the one that mirrors exactly; the
    // plain-WETH capture does NOT, and that measured provider defect is pinned
    // in `launch-verifier-v3-suite.test.ts` rather than smoothed over here.
    const parsed = validatePrepareResponse(captureResponse(CAPTURES.prepareV3HoldersBoth));
    const tuple = decodeLaunchCalldata(parsed.data as `0x${string}`);
    expect(tuple).not.toBeNull();
    expect(getAddress(tuple!.feeRecipient)).toBe(getAddress(parsed.feeRecipient.address));
  });
});

describe("the OLD shapes are now refused, not silently accepted", () => {
  it("refuses a bare-string feeRecipient", () => {
    const stale = { ...(live() as object), feeRecipient: FIXTURE_WALLET };
    expect(() => validatePrepareResponse(stale)).toThrow(/feeRecipient/);
  });

  it("refuses a bare-string pairedAsset", () => {
    const stale = { ...(live() as object), pairedAsset: "weth" };
    expect(() => validatePrepareResponse(stale)).toThrow(/pairedAsset/);
  });

  it("refuses a feeRecipient object whose address is not an address", () => {
    const broken = { ...(live() as object), feeRecipient: { address: "vexdotfun", display: "vex" } };
    expect(() => validatePrepareResponse(broken)).toThrow(/feeRecipient\.address/);
  });

  it("refuses a `value` that is neither decimal nor hex", () => {
    const broken = { ...(live() as object), value: "1.05 ETH" };
    expect(() => validatePrepareResponse(broken)).toThrow(/value/);
  });
});

describe("our recipient choice maps onto the launchpad's {type, value}", () => {
  // All three of Vex's recipient kinds. `session_wallet` never reaches the
  // provider under that name: it is collapsed into `{kind: "address"}` holding
  // the session wallet before a plan is built, so it maps to `wallet` too.
  it("an address becomes {type: 'wallet'}", () => {
    expect(toPrepareFeeRecipient({ kind: "address", address: FIXTURE_WALLET })).toEqual({
      type: "wallet",
      value: FIXTURE_WALLET,
    });
  });

  it("the session wallet, once collapsed to an address, becomes {type: 'wallet'}", () => {
    const sessionWallet = getAddress("0x33ef6673bd80cb11fcc41b82bc2181e65cc4d2fa");
    expect(toPrepareFeeRecipient({ kind: "address", address: sessionWallet })).toEqual({
      type: "wallet",
      value: sessionWallet,
    });
  });

  it("an X handle becomes {type: 'x'} and is NEVER coerced to a wallet", () => {
    const mapped = toPrepareFeeRecipient({ kind: "x_username", username: "vexdotfun" });
    expect(mapped).toEqual({ type: "x", value: "vexdotfun" });
    expect(mapped.type).not.toBe("wallet");
  });
});

describe("an unresolvable X handle", () => {
  it("is a diagnosable provider refusal, not a silent fallback to the wallet", () => {
    // Measured live: the shape is right, the handle is simply unknown to the
    // launchpad. The distinction matters - a fallback here would send a user's
    // fee stream somewhere they never named.
    const capture = errorCapture(CAPTURES.prepareXUnresolvable);
    expect(capture.httpStatus).toBe(400);
    expect((capture.response as { error: string }).error).toContain("Could not resolve the x fee recipient");
  });
});
