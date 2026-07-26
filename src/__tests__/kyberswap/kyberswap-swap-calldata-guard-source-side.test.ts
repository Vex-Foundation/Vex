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
import { encodeFunctionData, getAddress, type Address } from "viem";

import {
  verifyBuiltKyberSwap,
  META_AGGREGATION_ROUTER_V2_SWAP_ABI,
} from "@tools/kyberswap/evm/swap-calldata-guard.js";
import { deriveRouteFirstHops } from "@tools/kyberswap/evm/swap-source-transfer-binding.js";

import { harnessFor } from "./fixtures/route-build/capture-harness.js";
import capture from "./fixtures/route-build/base-usdc-to-native-50bps.json" with { type: "json" };
import nativeCapture from "./fixtures/route-build/base-native-to-usdc-50bps.json" with { type: "json" };
import splitCapture from "./fixtures/route-build/arbitrum-usdc-to-usdt-split-100bps.json" with { type: "json" };
import poolCapture from "./fixtures/route-build/robinhood-virtual-to-native-pool-receiver-50bps.json" with { type: "json" };
import poolSplitCapture from "./fixtures/route-build/ethereum-usdc-to-weth-pool-split-50bps.json" with { type: "json" };
import executorSplitCapture from "./fixtures/route-build/ethereum-usdc-to-weth-executor-split-50bps.json" with { type: "json" };
import nonAddressPoolCapture from "./fixtures/route-build/arbitrum-usdc-to-usdt-nonaddress-pools-50bps.json" with { type: "json" };

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

  // The router hands the input DIRECTLY to a UniswapV2-style pool whenever a
  // path's first hop is one: a V2 pair swaps against tokens it already holds,
  // so the transfer-then-call is the protocol's own shape and skipping the
  // executor saves a hop. Nothing about it is chain-specific — measured on the
  // DEFAULT source set (exactly what Vex requests) on Robinhood 4663 AND on
  // Ethereum mainnet. The first version of this binding modelled only the
  // executor shape and refused every one of these honest builds.
  describe("a route pool may receive the input directly", () => {
    const poolHarness = harnessFor(poolCapture);
    const splitHarness = harnessFor(poolSplitCapture);

    it("the real Robinhood 4663 capture sends the input to the route's pool, NOT the executor", () => {
      const { desc, callTarget } = poolHarness.decode();
      const firstHopPool = poolCapture.routeSummary.route[0]![0]!;
      expect(firstHopPool.exchange).toBe("uniswap");
      expect(desc.srcReceivers.map((a) => getAddress(a))).toEqual([getAddress(firstHopPool.pool)]);
      expect(getAddress(desc.srcReceivers[0]!)).not.toBe(getAddress(callTarget));
      // Still the input net of the 25 bps fee — the amount bound is untouched.
      expect(desc.srcAmounts).toEqual([BigInt(firstHopPool.swapAmount)]);
      expect(desc.srcAmounts[0]).toBe(997_500_000_000_000_000n);
      expect(desc.amount).toBe(1_000_000_000_000_000_000n);
    });

    it("the Robinhood pool-receiver capture is ACCEPTED", () => {
      expect(verifyBuiltKyberSwap(poolHarness.built(), poolHarness.approved())).toEqual({ ok: true });
    });

    it("a 3-path split across three route pools is ACCEPTED", () => {
      const { desc } = splitHarness.decode();
      expect(poolSplitCapture.routePathCount).toBe(3);
      expect(desc.srcReceivers).toHaveLength(3);
      expect(verifyBuiltKyberSwap(splitHarness.built(), splitHarness.approved())).toEqual({ ok: true });
    });

    it("each pool receives exactly what the quoted route says it swaps, and the total is still net of fee", () => {
      const { desc } = splitHarness.decode();
      const firstHops = poolSplitCapture.routeSummary.route.map((path) => path[0]!);
      expect(desc.srcReceivers.map((a) => getAddress(a))).toEqual(firstHops.map((h) => getAddress(h.pool)));
      expect(desc.srcAmounts).toEqual(firstHops.map((h) => BigInt(h.swapAmount)));
      const total = desc.srcAmounts.reduce((sum, v) => sum + v, 0n);
      expect(total).toBe(desc.amount - (desc.amount * 25n) / 10_000n);
    });

    // Admitting pools must not stop the DOMINANT shape from passing: 159 of the
    // 228 builds in the widest sweep route everything through the executor even
    // though their routes name perfectly good pools.
    it("a 9-path route whose pools are all real addresses still passes when the build uses the EXECUTOR", () => {
      const h = harnessFor(executorSplitCapture);
      const { desc, callTarget } = h.decode();
      expect(executorSplitCapture.routePathCount).toBe(9);
      expect(deriveRouteFirstHops(executorSplitCapture.routeSummary.route)).toHaveLength(9);
      expect(desc.srcReceivers.map((a) => getAddress(a))).toEqual([getAddress(callTarget)]);
      expect(verifyBuiltKyberSwap(h.built(), h.approved())).toEqual({ ok: true });
    });

    // `route[].pool` is NOT always an address: uniswap-v4 reports a 32-byte pool
    // ID and PMM/RFQ legs report identifiers like
    // `pmm_13_0x…_0x…`. Reading the split must then fail as a UNIT — a partial
    // set would let a build match a smaller split than the route describes.
    it("a route naming non-address pools yields NO approved pools, leaving the executor the only accepted destination", () => {
      const h = harnessFor(nonAddressPoolCapture);
      const firstHops = nonAddressPoolCapture.routeSummary.route.map((path) => path[0]!);
      expect(firstHops.some((hop) => !hop.pool.startsWith("0x") || hop.pool.length !== 42)).toBe(true);
      expect(deriveRouteFirstHops(nonAddressPoolCapture.routeSummary.route)).toEqual([]);
      // The build itself is executor-shape, so it is still accepted.
      expect(verifyBuiltKyberSwap(h.built(), h.approved())).toEqual({ ok: true });
    });

    it("refuses a pool receiver when the route could not be read at all", () => {
      const { desc } = poolHarness.decode();
      const verdict = verifyBuiltKyberSwap(
        poolHarness.built(),
        poolHarness.approved({ routeFirstHops: [] }),
      );
      expect(verdict.ok).toBe(false);
      if (verdict.ok) return;
      expect(verdict.reason).toBe(
        `it sends ${desc.srcAmounts[0]} to ${desc.srcReceivers[0]}, which the quoted route never names`,
      );
    });
  });

  describe("the widened receiver set is still closed", () => {
    const splitHarness = harnessFor(poolSplitCapture);

    it("refuses an attacker appended to an otherwise honest POOL split (the skim, on the new shape)", () => {
      const { desc } = splitHarness.decode();
      const skim = 1_000_000n;
      const calldata = splitHarness.reencode({
        srcReceivers: [...desc.srcReceivers, ATTACKER],
        srcAmounts: [desc.srcAmounts[0]! - skim, ...desc.srcAmounts.slice(1), skim],
      });
      const verdict = verifyBuiltKyberSwap(splitHarness.built({ calldata }), splitHarness.approved());

      expect(verdict.ok).toBe(false);
      if (verdict.ok) return;
      expect(verdict.kind).toBe("build_integrity");
      expect(verdict.reason).toBe(`it sends ${skim} to ${ATTACKER}, which the quoted route never names`);
    });

    // The receiver set alone is not enough: a pool in the route can be one the
    // attacker provides liquidity to, so the per-pool SHARE is pinned as well.
    it("refuses input moved BETWEEN two legitimate route pools", () => {
      const { desc } = splitHarness.decode();
      const shifted = 5_000_000n;
      const calldata = splitHarness.reencode({
        srcAmounts: [desc.srcAmounts[0]! - shifted, desc.srcAmounts[1]! + shifted, desc.srcAmounts[2]!],
      });
      const verdict = verifyBuiltKyberSwap(splitHarness.built({ calldata }), splitHarness.approved());

      expect(verdict.ok).toBe(false);
      if (verdict.ok) return;
      expect(verdict.kind).toBe("build_integrity");
      // The total is untouched, so only the per-pool binding can catch this.
      expect(desc.srcAmounts.reduce((s, v) => s + v, 0n)).toBe(
        [desc.srcAmounts[0]! - shifted, desc.srcAmounts[1]! + shifted, desc.srcAmounts[2]!].reduce((s, v) => s + v, 0n),
      );
      expect(verdict.reason).toBe(
        `it moves ${desc.srcAmounts[0]! - shifted} to ${getAddress(desc.srcReceivers[0]!)}; the quoted route swaps ${desc.srcAmounts[0]} there`,
      );
    });

    it("refuses a MID-route pool, which no observed build ever transfers to", () => {
      const { desc } = splitHarness.decode();
      // Path 2 of this capture is USDC -> USDT -> WETH; its SECOND hop pool is
      // in the route but is never a source destination.
      const midRoutePool = poolSplitCapture.routeSummary.route[1]![1]!.pool;
      expect(getAddress(midRoutePool)).not.toBe(getAddress(desc.srcReceivers[1]!));
      const calldata = splitHarness.reencode({
        srcReceivers: [desc.srcReceivers[0]!, midRoutePool as Address, desc.srcReceivers[2]!],
      });
      const verdict = verifyBuiltKyberSwap(splitHarness.built({ calldata }), splitHarness.approved());

      expect(verdict.ok).toBe(false);
      if (verdict.ok) return;
      expect(verdict.reason).toBe(
        `it sends ${desc.srcAmounts[1]} to ${getAddress(midRoutePool)}, which the quoted route never names`,
      );
    });

    it("refuses a pool split whose TOTAL is short of the input net of fee", () => {
      const { desc } = splitHarness.decode();
      const calldata = splitHarness.reencode({
        srcAmounts: [desc.srcAmounts[0]! - 1n, desc.srcAmounts[1]!, desc.srcAmounts[2]!],
      });
      const verdict = verifyBuiltKyberSwap(splitHarness.built({ calldata }), splitHarness.approved());

      expect(verdict.ok).toBe(false);
      if (verdict.ok) return;
      const net = desc.amount - (desc.amount * 25n) / 10_000n;
      expect(verdict.reason).toBe(`it moves ${net - 1n} of the input where ${net} is approved net of fee`);
    });

    it("refuses a pool split whose TOTAL exceeds the input net of fee", () => {
      const { desc } = splitHarness.decode();
      const calldata = splitHarness.reencode({
        srcAmounts: [desc.srcAmounts[0]! + 1n, desc.srcAmounts[1]!, desc.srcAmounts[2]!],
      });
      const verdict = verifyBuiltKyberSwap(splitHarness.built({ calldata }), splitHarness.approved());

      expect(verdict.ok).toBe(false);
      if (verdict.ok) return;
      const net = desc.amount - (desc.amount * 25n) / 10_000n;
      expect(verdict.reason).toBe(`it moves ${net + 1n} of the input where ${net} is approved net of fee`);
    });

    // Never seen in 278 builds: the router either uses its executor or the
    // route's pools, never both. Refused as the fail-closed choice — and
    // because diverting a pool's share to the executor leaves that pool short,
    // the refusal names the pool rather than falling back to the generic
    // shape message.
    it("refuses a list that MIXES the executor with a route pool", () => {
      const { desc, callTarget } = splitHarness.decode();
      const calldata = splitHarness.reencode({
        srcReceivers: [callTarget, desc.srcReceivers[1]!, desc.srcReceivers[2]!],
        srcAmounts: [...desc.srcAmounts],
      });
      const verdict = verifyBuiltKyberSwap(splitHarness.built({ calldata }), splitHarness.approved());

      expect(verdict.ok).toBe(false);
      if (verdict.ok) return;
      expect(verdict.kind).toBe("build_integrity");
      expect(verdict.reason).toBe(
        `it moves 0 to ${getAddress(desc.srcReceivers[0]!)}; the quoted route swaps ${desc.srcAmounts[0]} there`,
      );
    });

    // The fallback shape message. Reachable only when the route's own first
    // hops do not account for the whole input, so every named pool can be paid
    // in full and the executor still take a slice.
    it("refuses a split the route does not describe, when no single pool is short", () => {
      const { desc, callTarget } = splitHarness.decode();
      const net = desc.amount - (desc.amount * 25n) / 10_000n;
      const calldata = splitHarness.reencode({
        srcReceivers: [desc.srcReceivers[0]!, callTarget],
        srcAmounts: [desc.srcAmounts[0]!, net - desc.srcAmounts[0]!],
      });
      const verdict = verifyBuiltKyberSwap(
        splitHarness.built({ calldata }),
        // A route whose only readable first hop is the pool above.
        splitHarness.approved({
          routeFirstHops: [{ pool: getAddress(desc.srcReceivers[0]!), inputAmount: desc.srcAmounts[0]! }],
        }),
      );

      expect(verdict.ok).toBe(false);
      if (verdict.ok) return;
      expect(verdict.reason).toBe("it splits the input across 2 destinations the quoted route does not describe");
    });

    it("refuses a pool receiver whose route hop belongs to a DIFFERENT trade", () => {
      // The Robinhood capture's build, held against Ethereum's route.
      const otherHarness = harnessFor(poolCapture);
      const verdict = verifyBuiltKyberSwap(
        otherHarness.built(),
        otherHarness.approved({
          routeFirstHops: deriveRouteFirstHops(poolSplitCapture.routeSummary.route),
        }),
      );
      expect(verdict.ok).toBe(false);
      if (verdict.ok) return;
      expect(verdict.reason).toContain("which the quoted route never names");
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
      // Since route pools became admissible destinations, this is caught on
      // MEMBERSHIP rather than on receiver count — and the refusal now names
      // the attacker and the skim, which the count-based one never did.
      expect(verdict.reason).toBe(`it sends ${skim} to ${ATTACKER}, which the quoted route never names`);
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
        `it sends 9975000 to ${ATTACKER}, which the quoted route never names`,
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
      expect(verdict.reason).toBe("it moves none of the input, so the swap cannot be funded");
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
