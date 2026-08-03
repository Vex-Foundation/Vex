/**
 * W2h — THE UNDER-FUNDED LAUNCH SAYS SO.
 *
 * This is the 2026-08-02 incident, pinned. `launch_preview`/`launch_execute`
 * failed four times in a row with a chain-blaming refusal while the node had
 * already said the truth: "the total cost … exceeds the balance of the
 * account". The cause was ORDER — gas was estimated before the balance was
 * gated, and an under-funded wallet makes `eth_estimateGas` itself reject, so
 * the money failure arrived disguised as an unestimable chain.
 *
 * Three things are proven here, and all three are money-path:
 *
 *   1. The balance is READ AND GATED BEFORE the gas estimate — a wallet that
 *      cannot even cover `msg.value` + the Vex fee is refused without the
 *      estimate ever being attempted.
 *   2. A gas rejection that READS as "cannot pay" is reported as the BALANCE
 *      failure, never as "this chain would not estimate gas".
 *   3. A gas rejection that is genuinely about the chain still says so — and
 *      now carries the provider's real, sanitized cause instead of a bare
 *      chain accusation.
 *
 * Every refusal ends in a remediation the user can act on, because a refusal
 * the agent cannot act on is what made it retry blind four times.
 */

import { afterEach, describe, expect, it } from "vitest";
import { formatEther, type Address } from "viem";

import {
  registerLaunchImageByteResolver,
  resetLaunchImageByteResolver,
} from "@vex-agent/tools/protocols/trench/launch-image-byte-resolver.js";
import { buildLaunchPlan } from "@vex-agent/tools/protocols/trench/handlers/launch/plan.js";
import {
  TRENCH_CREATION_FEE_SLOT,
  TRENCH_CREATION_FEE_FIXTURE,
} from "@tools/trench-express/evm/creation-fee.js";
import type { PlanTrenchFeeLeg } from "@vex-agent/tools/protocols/trench/handlers/launch/fee-seam.js";
import type { ValidatedLaunchRequest } from "@vex-agent/tools/protocols/trench/handlers/launch/validate.js";

const WALLET = "0x33eF000000000000000000000000000000000001" as Address;
const NATIVE = "0x0000000000000000000000000000000000000000" as Address;
const FEE = TRENCH_CREATION_FEE_FIXTURE.feeWei;
const ANCHOR = 25_749_542n;
const GAS_ESTIMATE = 2_000_000n;
const GAS_PRICE = 20_000_000n;
const IMAGE_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);

const REQUEST: ValidatedLaunchRequest = {
  name: "Vex x Trench",
  symbol: "VEXTE",
  description: "a launch",
  links: ["https://vex.example"],
  imageId: "img_01",
  prebuyWei: 300_000_000_000_000n,
};

const MSG_VALUE = FEE + REQUEST.prebuyWei;
const VEX_FEE = (MSG_VALUE * 25n) / 10_000n;

/**
 * The exact sentence viem raises when the account cannot pay for a call it was
 * asked to estimate — the words the 2026-08-02 log carried while the agent was
 * told the chain would not estimate.
 */
const VIEM_INSUFFICIENT_FUNDS =
  "The total cost (gas * gas fee + value) of executing this transaction exceeds the balance of the account.";

const feePlanner: PlanTrenchFeeLeg = (req) => {
  const feeWei = (req.baseWei * 25n) / 10_000n;
  if (feeWei === 0n) return null;
  return {
    feeWei,
    netWei: req.baseWei - feeWei,
    txParams: { to: "0x00000000000000000000000000000000000feee5" as Address, value: feeWei },
    event: {} as never,
    disclosure: {},
  } as never;
};

interface ClientCalls {
  readonly order: string[];
}

function publicClient(calls: ClientCalls, overrides: Record<string, unknown> = {}) {
  return {
    async getBlockNumber() { return ANCHOR; },
    async getStorageAt(args: { slot: string }) {
      return args.slot.toLowerCase() === TRENCH_CREATION_FEE_SLOT.toLowerCase()
        ? TRENCH_CREATION_FEE_FIXTURE.rawWord
        : undefined;
    },
    async estimateGas() { calls.order.push("estimateGas"); return GAS_ESTIMATE; },
    async getGasPrice() { return GAS_PRICE; },
    async getBalance() { calls.order.push("getBalance"); return MSG_VALUE * 100n; },
    ...overrides,
  } as never;
}

function baseInput(client: unknown) {
  return {
    request: REQUEST,
    sessionId: "sess-underfunded",
    walletAddress: WALLET,
    permission: "full" as const,
    publicClient: client,
    planFeeLeg: feePlanner,
    nativeAddress: NATIVE,
  };
}

function mountImage(): void {
  registerLaunchImageByteResolver(async () => ({ bytes: IMAGE_BYTES, digest: "0xstoreddigest" }));
}

afterEach(resetLaunchImageByteResolver);

describe("W2h — an under-funded launch produces the BALANCE message", () => {
  it("gates the balance BEFORE estimating gas — the estimate is never attempted", async () => {
    mountImage();
    const calls: ClientCalls = { order: [] };
    const result = await buildLaunchPlan(baseInput(publicClient(calls, {
      async getBalance() { calls.order.push("getBalance"); return 1n; },
    })) as never);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    expect(result.code).toBe("insufficient_native_balance");
    // ORDER IS THE FIX: the balance was read, and nothing asked the node to
    // price a call the wallet demonstrably cannot pay for.
    expect(calls.order).toEqual(["getBalance"]);
  });

  it("names the shortfall and the remedy, and never blames the chain", async () => {
    mountImage();
    const calls: ClientCalls = { order: [] };
    const result = await buildLaunchPlan(baseInput(publicClient(calls, {
      async getBalance() { return 1n; },
    })) as never);

    if (result.ok) throw new Error("expected a refusal");
    expect(result.reason).toBe(
      `Refusing to launch: this launch needs at least ${formatEther(MSG_VALUE + VEX_FEE)} ETH `
        + `before network gas (${formatEther(MSG_VALUE)} creation fee + prebuy, `
        + `${formatEther(VEX_FEE)} Vex fee), and the wallet holds ${formatEther(1n)} ETH. `
        + "Top up the wallet on Robinhood Chain or lower the prebuy, then try again. Nothing was signed.",
    );
    expect(result.reason).not.toContain("would not estimate gas");
  });

  it("reports an insufficient-funds GAS REJECTION as the balance failure it is", async () => {
    // The wallet clears the pre-gas floor but not the full sequence, so the
    // node is the first thing to notice — exactly the incident's shape.
    mountImage();
    const calls: ClientCalls = { order: [] };
    const result = await buildLaunchPlan(baseInput(publicClient(calls, {
      async getBalance() { return MSG_VALUE + VEX_FEE; },
      async estimateGas() { throw new Error(VIEM_INSUFFICIENT_FUNDS); },
    })) as never);

    if (result.ok) throw new Error("expected a refusal");
    expect(result.code).toBe("insufficient_native_balance");
    expect(result.reason).toContain("needs at least");
    expect(result.reason).toContain("Top up the wallet on Robinhood Chain");
    expect(result.reason).not.toContain("would not estimate gas");
    // And not a syllable of the provider's raw sentence is needed to say it.
    expect(result.reason).toContain("Nothing was signed");
  });

  it("still refuses a GENUINELY unestimable chain — now with the real cause attached", async () => {
    mountImage();
    const calls: ClientCalls = { order: [] };
    const result = await buildLaunchPlan(baseInput(publicClient(calls, {
      async estimateGas() { throw new Error("method eth_estimateGas is not available"); },
    })) as never);

    if (result.ok) throw new Error("expected a refusal");
    expect(result.code).toBe("gas_unestimable");
    expect(result.reason).toContain("eth_estimateGas is not available");
    expect(result.reason).toContain("Nothing was signed");
  });

  it("an unreadable balance carries the provider's real cause, not a viem class name", async () => {
    mountImage();
    const calls: ClientCalls = { order: [] };
    const result = await buildLaunchPlan(baseInput(publicClient(calls, {
      async getBalance() { throw new Error("upstream node returned 503"); },
    })) as never);

    if (result.ok) throw new Error("expected a refusal");
    expect(result.code).toBe("balance_unreadable");
    expect(result.reason).toContain("503");
    expect(result.reason).toContain("Nothing was signed");
  });

  it("an unreadable creation fee carries the provider's real cause too", async () => {
    mountImage();
    const calls: ClientCalls = { order: [] };
    const result = await buildLaunchPlan(baseInput(publicClient(calls, {
      async getStorageAt() { throw new Error("archive node refused the pinned block"); },
    })) as never);

    if (result.ok) throw new Error("expected a refusal");
    expect(result.code).toBe("fee_unreadable");
    expect(result.reason).toContain("archive node refused the pinned block");
  });
});
