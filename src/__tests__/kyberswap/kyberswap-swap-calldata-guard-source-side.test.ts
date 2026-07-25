/**
 * The SOURCE side of KyberSwap's build calldata — the router's input-token
 * transfer list (`srcReceivers` / `srcAmounts`).
 *
 * Split from `kyberswap-swap-calldata-guard.test.ts` (which covers the target,
 * value, pair, recipient, fee line and price floor) because this is a distinct
 * question with its own fixtures: the two captures that pin the NATIVE-input
 * and multi-path shapes exist only for these cases.
 *
 * As in the sibling suite, every mutation decodes the real capture, changes ONE
 * field, and re-encodes through the same verified router ABI the guard uses.
 */

import { describe, it, expect } from "vitest";
import { encodeFunctionData, getAddress } from "viem";

import {
  verifyBuiltKyberSwap,
  META_AGGREGATION_ROUTER_V2_SWAP_ABI,
} from "@tools/kyberswap/evm/swap-calldata-guard.js";

import { harnessFor } from "./fixtures/route-build/capture-harness.js";
import capture from "./fixtures/route-build/base-usdc-to-native-50bps.json" with { type: "json" };
import nativeCapture from "./fixtures/route-build/base-native-to-usdc-50bps.json" with { type: "json" };
import splitCapture from "./fixtures/route-build/arbitrum-usdc-to-usdt-split-100bps.json" with { type: "json" };

const base = harnessFor(capture);
const decodeCapture = base.decode;
const reencode = base.reencode;
const builtFromCapture = base.built;
const approvedFromCapture = base.approved;

describe("verifyBuiltKyberSwap — source-side transfer binding", () => {
  const ATTACKER = "0x00000000000000000000000000000000DeaDBeef";

  describe("the honest shape, as three real captures produced it", () => {
    it("an ERC-20 sell routes the input to the executor it calls, net of fee", () => {
      const { desc, callTarget } = decodeCapture();
      expect(desc.srcReceivers.map((a) => getAddress(a))).toEqual([getAddress(callTarget)]);
      // amount - floor(amount * 25 / 10000): 10000000 - 25000.
      expect(desc.srcAmounts).toEqual([9_975_000n]);
      expect(desc.amount).toBe(10_000_000n);
    });

    it("a native sell carries NO input transfers — the input rides in msg.value", () => {
      const { desc } = harnessFor(nativeCapture).decode();
      expect(desc.srcReceivers).toEqual([]);
      expect(desc.srcAmounts).toEqual([]);
      expect(nativeCapture.build.transactionValue).toBe(nativeCapture.routeSummary.amountIn);
    });

    it("a 6-path split still uses ONE receiver — the split happens inside the executor", () => {
      const { desc, callTarget } = harnessFor(splitCapture).decode();
      expect(splitCapture.routePathCount).toBeGreaterThan(1);
      expect(desc.srcReceivers.map((a) => getAddress(a))).toEqual([getAddress(callTarget)]);
      expect(desc.srcAmounts).toEqual([249_375_000_000n]);
    });
  });

  describe("honest builds still pass — the binding strands nothing", () => {
    it("the ERC-20 capture passes", () => {
      expect(verifyBuiltKyberSwap(builtFromCapture(), approvedFromCapture())).toEqual({ ok: true });
    });

    it("the native-in capture passes", () => {
      const h = harnessFor(nativeCapture);
      expect(h.approved().srcIsNative).toBe(true);
      expect(verifyBuiltKyberSwap(h.built(), h.approved())).toEqual({ ok: true });
    });

    it("the 6-path split capture passes", () => {
      const h = harnessFor(splitCapture);
      expect(verifyBuiltKyberSwap(h.built(), h.approved())).toEqual({ ok: true });
    });
  });

  describe("diversion of the input is refused", () => {
    it("refuses a build that SKIMS part of the input to an attacker (the shipped hole)", () => {
      const { desc } = decodeCapture();
      const skim = 2_500_000n;
      // Everything else is untouched: same pair, same amount, same dstReceiver,
      // same fee line, same flags, same floor, same router, value 0. The total
      // still satisfies the router's own `total <= desc.amount`.
      const calldata = reencode({
        srcReceivers: [desc.srcReceivers[0]!, ATTACKER],
        srcAmounts: [desc.srcAmounts[0]! - skim, skim],
      });
      const verdict = verifyBuiltKyberSwap(builtFromCapture({ calldata }), approvedFromCapture());

      expect(verdict.ok).toBe(false);
      if (verdict.ok) return;
      expect(verdict.kind).toBe("build_integrity");
      expect(verdict.reason).toContain("splits the input across 2 receivers");
    });

    it("refuses a build that sends the WHOLE input to an attacker", () => {
      const { desc } = decodeCapture();
      const calldata = reencode({ srcReceivers: [ATTACKER], srcAmounts: [desc.srcAmounts[0]!] });
      const verdict = verifyBuiltKyberSwap(builtFromCapture({ calldata }), approvedFromCapture());

      expect(verdict.ok).toBe(false);
      if (verdict.ok) return;
      expect(verdict.kind).toBe("build_integrity");
      // Names the amount AND the address, so the agent logs what it caught.
      expect(verdict.reason).toBe(
        `it sends 9975000 of the input to ${ATTACKER}, not to the executor it calls`,
      );
    });

    it("refuses an input transfer larger than the approved amount net of fee", () => {
      const { desc } = decodeCapture();
      const calldata = reencode({ srcAmounts: [desc.amount] });
      const verdict = verifyBuiltKyberSwap(builtFromCapture({ calldata }), approvedFromCapture());

      expect(verdict.ok).toBe(false);
      if (verdict.ok) return;
      expect(verdict.reason).toBe("it moves 10000000 of the input where 9975000 is approved net of fee");
    });

    it("refuses an input transfer that starves the executor", () => {
      const calldata = reencode({ srcAmounts: [1n] });
      const verdict = verifyBuiltKyberSwap(builtFromCapture({ calldata }), approvedFromCapture());

      expect(verdict.ok).toBe(false);
      if (verdict.ok) return;
      expect(verdict.reason).toContain("approved net of fee");
    });

    it("refuses an ERC-20 sell with no input transfer at all", () => {
      const calldata = reencode({ srcReceivers: [], srcAmounts: [] });
      const verdict = verifyBuiltKyberSwap(builtFromCapture({ calldata }), approvedFromCapture());

      expect(verdict.ok).toBe(false);
      if (verdict.ok) return;
      expect(verdict.reason).toContain("splits the input across 0 receivers");
    });

    it("refuses a receiver list that does not line up with the amount list", () => {
      const { desc } = decodeCapture();
      const calldata = reencode({ srcReceivers: [desc.srcReceivers[0]!, ATTACKER], srcAmounts: [desc.srcAmounts[0]!] });
      const verdict = verifyBuiltKyberSwap(builtFromCapture({ calldata }), approvedFromCapture());

      expect(verdict.ok).toBe(false);
      if (verdict.ok) return;
      expect(verdict.reason).toBe("it lists 2 input receivers against 1 input amounts");
    });

    it("refuses input transfers bolted onto a NATIVE sell, which needs none", () => {
      const h = harnessFor(nativeCapture);
      const calldata = h.reencode({ srcReceivers: [ATTACKER], srcAmounts: [1_000n] });
      const verdict = verifyBuiltKyberSwap(h.built({ calldata }), h.approved());

      expect(verdict.ok).toBe(false);
      if (verdict.ok) return;
      expect(verdict.reason).toBe("it adds 1 input transfer(s) to a native sell, which needs none");
    });
  });

  describe("the net-of-fee expectation matches the router's own arithmetic", () => {
    // The router's `_takeFee` reassigns `desc.amount = amount - floor(amount *
    // bps / 10000)` before the transfer loop, so the FEE floors, not the
    // remainder. A provider probe at amountIn=10000001 returned srcAmounts
    // [9975001]; `floor(amount * 9975 / 10000)` would be 9975000. Pinning the
    // direction here keeps a one-unit error from refusing every honest swap.
    const AMOUNT = 10_000_001n;

    it("accepts the value the provider actually embeds (fee floors)", () => {
      const calldata = reencode({ amount: AMOUNT, srcAmounts: [9_975_001n] });
      const verdict = verifyBuiltKyberSwap(
        builtFromCapture({ calldata }),
        approvedFromCapture({ amountIn: AMOUNT }),
      );
      expect(verdict).toEqual({ ok: true });
    });

    it("refuses the value the other rounding direction would produce", () => {
      const calldata = reencode({ amount: AMOUNT, srcAmounts: [9_975_000n] });
      const verdict = verifyBuiltKyberSwap(
        builtFromCapture({ calldata }),
        approvedFromCapture({ amountIn: AMOUNT }),
      );
      expect(verdict.ok).toBe(false);
    });
  });

  it("refuses the simple-mode entry point, whose input transfers are not in this description", () => {
    const { desc, targetData, clientData } = decodeCapture();
    const calldata = encodeFunctionData({
      abi: META_AGGREGATION_ROUTER_V2_SWAP_ABI,
      functionName: "swapSimpleMode",
      args: [getAddress(ATTACKER), desc, targetData, clientData],
    } as never);
    const verdict = verifyBuiltKyberSwap(builtFromCapture({ calldata }), approvedFromCapture());

    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.kind).toBe("build_integrity");
    expect(verdict.reason).toContain("simple-mode entry point");
  });
});
