/**
 * Vex's OWN gas bound for a Morpho transaction.
 *
 * Two properties are asserted, and they are the two that cost money when they
 * are wrong.
 *
 * COMPOSITION. `boundMorphoGas` does not own a multiplier. It composes a FRESH
 * per-transaction `eth_estimateGas` with the single repo-wide headroom policy in
 * `evm-chains/gas-limit-headroom.ts`, whose module comment records the on-chain
 * forensics behind the number. The test therefore asserts the COMPOSITION
 * against that policy function rather than restating the multiplier, because a
 * test that hard-codes 2x is a second copy of the policy and would keep passing
 * after the policy moved. That is the "do not copy the logic under test into the
 * test" rule from rules/90 read in the only direction that is safe here.
 *
 * HINT IS NEVER A FLOOR. KyberSwap advertised 356,167 gas for a call that needed
 * ~1,634,838, which is why no provider figure is allowed to set the limit. The
 * Morpho SDK publishes no gas figure for a bundle at all, so the danger here is
 * the opposite one: that a future edit starts reading a `gas` field off the
 * built transaction because one happens to be present. These cases put a
 * deliberately absurd `gas` on the built transaction and prove the bound ignores
 * it in BOTH directions, high and low.
 *
 * The estimate is also asserted to be requested FRESH per call, never cached
 * across two calls with different calldata: a reused estimate is a stale bound.
 */

import { describe, it, expect } from "vitest";

import { boundMorphoGas, type MorphoBuiltTransaction } from "@tools/morpho/mutations.js";
import { gasLimitWithHeadroom } from "../../../tools/evm-chains/gas-limit-headroom.js";
import { getMorphoActionClient } from "../../../tools/morpho/mutations/client.js";
import { definedValue } from "../../_test-value-guards.js";

const BASE_CHAIN_ID = 8453;

const FROM = "0x00000000000000000000000000000000000000a1" as const;
const BUNDLER = "0x00000000000000000000000000000000000000b3" as const;

interface EstimateCall {
  readonly to: string;
  readonly data: string;
  readonly value: bigint | undefined;
}

/**
 * The REAL Morpho action client with `estimateGas` alone replaced, recording
 * what it was asked.
 *
 * A four-key object literal is not a `MorphoActionClient`, so a hand-built
 * double could only be passed through a type escape - and an escaped double
 * keeps compiling after the client's contract moves. Building the genuine
 * client (its transport is never reached, because `estimateGas` is the only
 * action `boundMorphoGas` calls) and overriding that one action keeps the
 * double's type exactly the contract's. Same idiom as
 * `src/__tests__/vex-agent/tools/internal/wallet/send-execute-evm.test.ts`.
 */
function clientReturning(answer: bigint | Error) {
  const calls: EstimateCall[] = [];
  const client = Object.assign(getMorphoActionClient(BASE_CHAIN_ID), {
    estimateGas(args: { to: string; data: string; value?: bigint }) {
      calls.push({ to: args.to, data: args.data, value: args.value });
      return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
    },
  });
  return { client, calls };
}

function tx(overrides: Partial<MorphoBuiltTransaction> & Record<string, unknown> = {}): MorphoBuiltTransaction {
  return { to: BUNDLER, data: "0xdeadbeef", value: 0n, ...overrides } as MorphoBuiltTransaction;
}

describe("boundMorphoGas composes the node estimate with the repo-wide headroom policy", () => {
  it("reports the node estimate and the headroomed limit as two separate, labelled numbers", async () => {
    const { client } = clientReturning(1_000_000n);

    const bound = await boundMorphoGas(client, tx(), FROM, "deposit");

    expect(bound.nodeEstimate).toBe("1000000");
    expect(bound.vexGasLimit).toBe(gasLimitWithHeadroom(1_000_000n).toString());
    // The two must not be the same number: signing the bare estimate is the
    // 2026-07-24 loss this policy exists to prevent.
    expect(bound.vexGasLimit).not.toBe(bound.nodeEstimate);
    expect(BigInt(definedValue(bound.vexGasLimit, "vexGasLimit")))
      .toBeGreaterThan(BigInt(definedValue(bound.nodeEstimate, "nodeEstimate")));
    expect(bound.unavailableReason).toBeNull();
  });

  it("holds the composition across magnitudes, so no bracket is special-cased", async () => {
    for (const estimate of [21_000n, 356_167n, 1_634_838n, 30_000_000n]) {
      const { client } = clientReturning(estimate);
      const bound = await boundMorphoGas(client, tx(), FROM, "deposit");
      expect(bound.vexGasLimit, `estimate ${estimate}`).toBe(gasLimitWithHeadroom(estimate).toString());
    }
  });

  it("says the gas is UNKNOWN, with a cause, rather than reporting zero when the node refuses", async () => {
    // A deposit whose approval does not exist yet cannot be estimated, and that
    // is the ordinary case rather than an error. Zero would read as free.
    const { client } = clientReturning(new Error("execution reverted: ERC20: insufficient allowance"));

    const bound = await boundMorphoGas(client, tx(), FROM, "deposit");

    expect(bound.nodeEstimate).toBeNull();
    expect(bound.vexGasLimit).toBeNull();
    expect(bound.unavailableReason).toContain("UNKNOWN, not zero");
    expect(bound.unavailableReason).toContain("missing approval");
  });

  it("keeps a secret-shaped RPC failure out of the reported cause", async () => {
    const { client } = clientReturning(
      new Error("HTTP request failed to https://mainnet.example.com/v2/SUPERSECRETKEY body 0x" + "ab".repeat(40)),
    );

    const bound = await boundMorphoGas(client, tx(), FROM, "deposit");

    expect(bound.unavailableReason).not.toContain("SUPERSECRETKEY");
    expect(bound.unavailableReason).not.toContain("https://");
    expect(bound.unavailableReason).toContain("[url]");
  });
});

describe("a gas figure carried on the built transaction is never a floor, a ceiling, or an input", () => {
  it("ignores an absurdly LOW gas field on the transaction and bounds from the fresh estimate", async () => {
    // The KyberSwap shape: a published figure far below what the call needs.
    const { client } = clientReturning(1_634_838n);

    const bound = await boundMorphoGas(client, tx({ gas: 356_167n }), FROM, "deposit");

    expect(bound.nodeEstimate).toBe("1634838");
    expect(bound.vexGasLimit).toBe(gasLimitWithHeadroom(1_634_838n).toString());
    expect(bound.vexGasLimit).not.toBe("356167");
  });

  it("ignores an absurdly HIGH gas field too, so a builder cannot inflate what Vex would sign", async () => {
    const { client } = clientReturning(150_000n);

    const bound = await boundMorphoGas(client, tx({ gas: 30_000_000n, gasLimit: 30_000_000n }), FROM, "deposit");

    expect(bound.vexGasLimit).toBe(gasLimitWithHeadroom(150_000n).toString());
    expect(BigInt(definedValue(bound.vexGasLimit, "vexGasLimit"))).toBeLessThan(30_000_000n);
  });

  it("passes only the transaction's to, data and value to the node, never a supplied gas", async () => {
    const { client, calls } = clientReturning(500_000n);

    await boundMorphoGas(client, tx({ gas: 999n }), FROM, "deposit");

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ to: BUNDLER, data: "0xdeadbeef", value: 0n });
  });

  it("estimates FRESH for each transaction rather than reusing an earlier answer", async () => {
    const { client, calls } = clientReturning(500_000n);

    await boundMorphoGas(client, tx({ data: "0xaaaa" }), FROM, "deposit");
    await boundMorphoGas(client, tx({ data: "0xbbbb" }), FROM, "deposit");

    expect(calls.map((c) => c.data)).toEqual(["0xaaaa", "0xbbbb"]);
  });

  it("states in its own note that there is no provider hint to hold to a ceiling", async () => {
    const { client } = clientReturning(500_000n);

    const bound = await boundMorphoGas(client, tx(), FROM, "deposit");

    expect(bound.note).toContain("no provider hint");
    // A limit is not a cost, and the note must keep saying so.
    expect(bound.note).toContain("gas USED");
  });
});
