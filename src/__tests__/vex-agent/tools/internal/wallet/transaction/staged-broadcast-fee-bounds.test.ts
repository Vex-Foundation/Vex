/**
 * THE APPROVED FEE CEILING, enforced on the bytes that would be signed.
 *
 * The defect this closes is specific and it is not hypothetical:
 * `prepareTransactionRequest` fills the fee fields from the node's own
 * suggestion, and viem may route preparation through `wallet_fillTransaction`,
 * whose reply overwrites what the caller asked for. On a venue path that is
 * tolerable - the user authorized a trade, not a gas price. On the generic
 * signing path the caps ARE what the user approved, so a request whose fields
 * exceed them must never reach `signTransaction`.
 *
 * So every case below asserts the same two things together: the refusal, and
 * that NOTHING was signed, staged or sent. A test that only checked the throw
 * would pass on an implementation that threw after broadcasting.
 */

import { describe, it, expect, vi } from "vitest";
import {
  createPublicClient,
  createWalletClient,
  http,
  type Chain,
  type Transport,
} from "viem";
import { parseAccount } from "viem/accounts";
import { base } from "viem/chains";

vi.mock("@tools/evm-chains/dependent-leg-gas-estimate.js", () => ({
  estimateGasForPlanLeg: async () => 21_000n,
}));
vi.mock("@tools/evm-chains/gas-limit-headroom.js", () => ({
  // Identity, so the assertions below are about the BOUNDS and not about how
  // much headroom the repo happens to add today.
  gasLimitWithHeadroom: (estimate: bigint) => estimate,
}));
vi.mock("@tools/evm-chains/receipt-guard.js", () => ({
  waitForReceiptWithRetry: async () => ({ status: "success", blockNumber: 1n }),
}));

const {
  signStageBroadcast,
  StagedFeeBoundsExceededError,
} = await import("@tools/evm-chains/staged-broadcast.js");

const ACCOUNT = { address: "0x1111111111111111111111111111111111111111" as const };
const TO = "0x2222222222222222222222222222222222222222";
const TEST_CHAIN: Chain = base;

function testTransport(): Transport {
  return http("http://127.0.0.1:1");
}

interface Trace {
  signed: number;
  staged: number;
  sent: number;
  requested: Record<string, unknown> | null;
}

/**
 * A wallet client whose `prepareTransactionRequest` returns fields the CALLER
 * did not ask for - the node-fills-it-in case. `fill` is what the node hands
 * back on top of the caller's request.
 */
function harness(fill: Record<string, unknown>) {
  const trace: Trace = { signed: 0, staged: 0, sent: 0, requested: null };
  const walletClient = Object.assign(createWalletClient({
    account: parseAccount(ACCOUNT.address),
    chain: TEST_CHAIN,
    transport: testTransport(),
  }), {
    chain: TEST_CHAIN,
    prepareTransactionRequest: async (request: Record<string, unknown>) => {
      trace.requested = request;
      return { ...request, nonce: 7, ...fill };
    },
    signTransaction: async () => {
      trace.signed += 1;
      return "0xdeadbeef";
    },
  });
  const publicClient = Object.assign(createPublicClient({
    chain: TEST_CHAIN,
    transport: testTransport(),
  }), {
    sendRawTransaction: async () => {
      trace.sent += 1;
      return "0xhash";
    },
  });
  const hooks = {
    onNonceReserved: async (request: { nodePendingNonce: number }) => request.nodePendingNonce,
    onHashStaged: async () => {
      trace.staged += 1;
    },
    onAccepted: async () => undefined,
  };
  return { trace, walletClient, publicClient, hooks };
}

function run(h: ReturnType<typeof harness>, bounds: Parameters<typeof signStageBroadcast>[6]) {
  return signStageBroadcast(
    h.publicClient,
    h.walletClient,
    { to: TO as `0x${string}`, data: "0x" as `0x${string}`, value: 0n },
    h.hooks,
    undefined,
    undefined,
    bounds,
  );
}

const EIP1559_BOUNDS = {
  mode: "eip1559" as const,
  gasLimit: 21_000n,
  maxFeePerGasWei: 1_000_000_000n,
  maxPriorityFeePerGasWei: 1_000_000n,
};

describe("signStageBroadcast bounds", () => {
  it("sets the fee fields FROM the ceiling rather than letting the node choose", async () => {
    const h = harness({ maxFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 1_000_000n });
    const outcome = await run(h, EIP1559_BOUNDS);
    expect(outcome.kind).toBe("confirmed");
    expect(h.trace.requested?.maxFeePerGas).toBe(1_000_000_000n);
    expect(h.trace.requested?.maxPriorityFeePerGas).toBe(1_000_000n);
  });

  it("REFUSES a maxFeePerGas the node raised above the approved ceiling", async () => {
    const h = harness({ maxFeePerGas: 9_000_000_000n, maxPriorityFeePerGas: 1_000_000n });
    await expect(run(h, EIP1559_BOUNDS)).rejects.toBeInstanceOf(StagedFeeBoundsExceededError);
    expect(h.trace.signed).toBe(0);
    expect(h.trace.staged).toBe(0);
    expect(h.trace.sent).toBe(0);
  });

  it("REFUSES a priority fee above the approved ceiling", async () => {
    const h = harness({ maxFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 500_000_000n });
    await expect(run(h, EIP1559_BOUNDS)).rejects.toBeInstanceOf(StagedFeeBoundsExceededError);
    expect(h.trace.signed).toBe(0);
  });

  it("REFUSES a gas limit above the approved ceiling", async () => {
    const h = harness({ maxFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 1_000_000n });
    // The estimate itself now exceeds what the user authorized: a transaction
    // that needs more gas than was approved is a transaction nobody approved,
    // and trimming it to the cap would send one that runs out of gas.
    await expect(run(h, { ...EIP1559_BOUNDS, gasLimit: 20_000n })).rejects.toBeInstanceOf(
      StagedFeeBoundsExceededError,
    );
    expect(h.trace.signed).toBe(0);
  });

  it("REFUSES a legacy gasPrice the node overwrote above the approved ceiling", async () => {
    // The caller sets `gasPrice` from the ceiling; the node's own reply comes
    // back higher. The signed bytes are what the chain enforces, so the check
    // has to run on the request that is actually serialized.
    const h = harness({ gasPrice: 9_000_000_000n });
    await expect(
      run(h, { mode: "legacy", gasLimit: 21_000n, gasPriceWei: 1_000_000_000n }),
    ).rejects.toBeInstanceOf(StagedFeeBoundsExceededError);
    expect(h.trace.signed).toBe(0);
    expect(h.trace.sent).toBe(0);
  });

  it("REFUSES when the prepared request carries NO field for the approved mode", async () => {
    // An absent field is not a hole to wave through: caps for a pricing mode
    // the request does not use cannot bound anything it would pay.
    const h = harness({ gasPrice: undefined });
    await expect(
      run(h, { mode: "legacy", gasLimit: 21_000n, gasPriceWei: 1_000_000_000n }),
    ).rejects.toBeInstanceOf(StagedFeeBoundsExceededError);
    expect(h.trace.signed).toBe(0);
  });

  it("names the field and both numbers, and never a raw provider payload", async () => {
    const h = harness({ maxFeePerGas: 9_000_000_000n, maxPriorityFeePerGas: 1_000_000n });
    await run(h, EIP1559_BOUNDS).catch((err: unknown) => {
      expect(err).toBeInstanceOf(StagedFeeBoundsExceededError);
      if (!(err instanceof StagedFeeBoundsExceededError)) {
        throw new Error("expected StagedFeeBoundsExceededError");
      }
      expect(err.field).toBe("maxFeePerGas");
      expect(err.actual).toBe("9000000000");
      expect(err.approved).toBe("1000000000");
      expect(err.message).toContain("Nothing was signed");
    });
  });

  it("leaves an unbounded caller exactly as it was", async () => {
    const h = harness({ maxFeePerGas: 9_000_000_000n, maxPriorityFeePerGas: 5_000_000n });
    const outcome = await run(h, undefined);
    expect(outcome.kind).toBe("confirmed");
    expect(h.trace.signed).toBe(1);
    expect(h.trace.sent).toBe(1);
    // No fee fields were injected into the request: every existing venue caller
    // keeps the exact preparation it had.
    expect(h.trace.requested?.maxFeePerGas).toBeUndefined();
  });
});
