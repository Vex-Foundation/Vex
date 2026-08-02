/**
 * The payable `create()` — calldata and the native-value proof.
 *
 * This is the exact spend gate for a launch. `msg.value` on a Trench create is
 * TWO different kinds of money in one number: the launchpad's creation fee, and
 * the user's own prebuy principal. The rule this file pins is that BOTH are
 * proven separately and their exact bigint sum IS `msg.value` — no tolerance, no
 * remainder, no "close enough".
 *
 * Rule 90's thousandfold-error trap is the reason the fee is a
 * `verified_contract_read` carrying its anchored block, and not a constant: a
 * fee we cannot re-derive at signing time is a hint, not a floor.
 */

import { describe, it, expect } from "vitest";
import { decodeFunctionData, type Address, type Hex } from "viem";

import { TRENCH_DIAMOND_ABI } from "@tools/trench-express/abi.js";
import { TRENCH_DIAMOND_ADDRESS, TRENCH_CHAIN_ID } from "@tools/trench-express/constants.js";
import {
  buildCreateCalldata,
  buildLaunchNativeValueAuthorization,
  launchCreationFeeComponent,
  launchPrebuyPrincipal,
  TRENCH_LAUNCH_DATA,
  TRENCH_LAUNCH_DEX,
  TRENCH_LAUNCH_STRATEGY,
} from "@tools/trench-express/evm/create-launch.js";
import { checkNativeValueAuthorizedForCall } from "@tools/evm-chains/native-value-authorization/index.js";

const DIAMOND = TRENCH_DIAMOND_ADDRESS as Address;
const FEE = 1_000_000_000_000_000n; // 0.001 ETH
const ANCHOR = 25_749_542n;
const IMAGE = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]); // 4-byte JPEG magic

const FIELDS = {
  name: "Vex x Trench",
  symbol: "VEXTE",
  description: "a launch",
  links: ["https://vex.example"],
  imageBytes: IMAGE,
};

describe("buildCreateCalldata", () => {
  it("encodes the probe-proven argument order and the only legal enum values", () => {
    const data = buildCreateCalldata({ ...FIELDS, prebuyWei: 0n });
    const decoded = decodeFunctionData({ abi: TRENCH_DIAMOND_ABI, data });

    expect(decoded.functionName).toBe("create");
    const args = decoded.args as readonly unknown[];
    expect(args[0]).toBe("Vex x Trench");
    expect(args[1]).toBe("VEXTE");
    expect(args[2]).toBe("a launch");
    expect(args[3]).toBe("0xffd8ffe0"); // image bytes, hex-encoded
    expect(args[4]).toEqual(["https://vex.example"]);
    expect(args[5]).toBe(TRENCH_LAUNCH_DATA);
    expect(args[6]).toBe(TRENCH_LAUNCH_STRATEGY);
    expect(args[7]).toBe(TRENCH_LAUNCH_DEX);
    expect(args[8]).toBe(0n);
  });

  it("pins strategy/dex/data to the ONLY values the live probe proved legal", () => {
    expect(TRENCH_LAUNCH_STRATEGY).toBe(0);
    expect(TRENCH_LAUNCH_DEX).toBe(0);
    expect(TRENCH_LAUNCH_DATA).toBe("0x");
  });

  it("carries the prebuy as the initialBuy ARGUMENT, not only as value", () => {
    const prebuy = 300_000_000_000_000n;
    const decoded = decodeFunctionData({
      abi: TRENCH_DIAMOND_ABI,
      data: buildCreateCalldata({ ...FIELDS, prebuyWei: prebuy }),
    });
    expect((decoded.args as readonly unknown[])[8]).toBe(prebuy);
  });

  it("REFUSES an empty image — a Vex product rule, not a contract rule", () => {
    // The Diamond accepts empty image bytes and would mint a permanently
    // image-less token. We do not.
    expect(() =>
      buildCreateCalldata({ ...FIELDS, imageBytes: new Uint8Array(), prebuyWei: 0n }),
    ).toThrow(/image/i);
  });
});

describe("buildLaunchNativeValueAuthorization — the exact-sum gate", () => {
  const authorize = (prebuyWei: bigint, valueWei: bigint) => {
    const data = buildCreateCalldata({ ...FIELDS, prebuyWei });
    return {
      data,
      auth: buildLaunchNativeValueAuthorization({
        chainId: TRENCH_CHAIN_ID,
        data,
        valueWei,
        creationFeeWei: FEE,
        prebuyWei,
        anchorBlockNumber: ANCHOR,
      }),
    };
  };

  it("authorizes fee + prebuy when they sum EXACTLY to msg.value", () => {
    const prebuy = 300_000_000_000_000n;
    const { data, auth } = authorize(prebuy, FEE + prebuy);
    const verdict = checkNativeValueAuthorizedForCall(auth, {
      chainId: TRENCH_CHAIN_ID,
      to: DIAMOND,
      data,
      valueWei: FEE + prebuy,
    });
    expect(verdict).toEqual({ ok: true });

    const kinds = auth.components.map((c) => c.kind).sort();
    expect(kinds).toEqual(["native_principal", "protocol_fee"]);
  });

  it("authorizes a fee-only launch (no prebuy) with ONE component", () => {
    const { data, auth } = authorize(0n, FEE);
    expect(auth.components).toHaveLength(1);
    expect(auth.components[0]!.kind).toBe("protocol_fee");
    expect(
      checkNativeValueAuthorizedForCall(auth, {
        chainId: TRENCH_CHAIN_ID,
        to: DIAMOND,
        data,
        valueWei: FEE,
      }),
    ).toEqual({ ok: true });
  });

  it("REFUSES one wei of unattributed value — no tolerance", () => {
    const prebuy = 300_000_000_000_000n;
    const inflated = FEE + prebuy + 1n;
    const { data, auth } = authorize(prebuy, inflated);
    const verdict = checkNativeValueAuthorizedForCall(auth, {
      chainId: TRENCH_CHAIN_ID,
      to: DIAMOND,
      data,
      valueWei: inflated,
    });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error("unreachable");
    expect(verdict.reason).toMatch(/could not be attributed|1 wei/);
  });

  it("REFUSES when the value handed to the signer is not the value authorized", () => {
    const prebuy = 300_000_000_000_000n;
    const { data, auth } = authorize(prebuy, FEE + prebuy);
    // A larger transaction reaching the signer after classification.
    const verdict = checkNativeValueAuthorizedForCall(auth, {
      chainId: TRENCH_CHAIN_ID,
      to: DIAMOND,
      data,
      valueWei: FEE + prebuy + 10n,
    });
    expect(verdict.ok).toBe(false);
  });

  it("REFUSES when the calldata changed after classification (fingerprint binds it)", () => {
    const prebuy = 300_000_000_000_000n;
    const { auth } = authorize(prebuy, FEE + prebuy);
    const otherData = buildCreateCalldata({
      ...FIELDS,
      symbol: "EVIL",
      prebuyWei: prebuy,
    });
    const verdict = checkNativeValueAuthorizedForCall(auth, {
      chainId: TRENCH_CHAIN_ID,
      to: DIAMOND,
      data: otherData,
      valueWei: FEE + prebuy,
    });
    expect(verdict.ok).toBe(false);
  });

  it("proves the fee as a verified_contract_read carrying its ANCHORED block", () => {
    const { auth } = authorize(0n, FEE);
    const fee = auth.components.find((c) => c.kind === "protocol_fee");
    expect(fee?.evidence).toMatchObject({
      source: "verified_contract_read",
      protocol: "trench",
      blockNumber: ANCHOR,
      returnedWei: FEE,
    });
  });

  it("marks the creation fee as spent_not_recoverable — it does not come back", () => {
    const { auth } = authorize(0n, FEE);
    expect(auth.components[0]!.refund).toBe("spent_not_recoverable");
  });
});

describe("component builders in isolation", () => {
  it("the prebuy principal is vex_constructed — our own arithmetic, no provider echo", () => {
    const component = launchPrebuyPrincipal(500n);
    expect(component.amountWei).toBe(500n);
    expect(component.evidence.source).toBe("vex_constructed");
  });

  it("the fee component records the exact word the anchored read returned", () => {
    const component = launchCreationFeeComponent(FEE, ANCHOR, "0xabcdef12" as Hex);
    expect(component.amountWei).toBe(FEE);
    expect(component.evidence).toMatchObject({
      source: "verified_contract_read",
      returnedWei: FEE,
      blockNumber: ANCHOR,
      callSelector: "0xabcdef12",
    });
  });
});
