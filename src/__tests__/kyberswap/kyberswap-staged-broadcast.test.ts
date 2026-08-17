/**
 * Behavior tests for `signStageBroadcast` — the staged sign→persist→broadcast
 * primitive Agent Scan's execute handler uses for every planned transaction
 * (allowance reset, allowance grant, swap). Pins the exact ordering plan
 * §11.1 requires: sign locally, compute the hash, call `onHashStaged` BEFORE
 * the raw transaction reaches the network, THEN broadcast + bounded receipt
 * wait — and that a send-time or confirm-time failure is reported as
 * `ambiguous`, never assumed to be a definitive failure.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { keccak256, type Address, type Hex } from "viem";
import { signStageBroadcast } from "@tools/kyberswap/evm/staged-broadcast.js";
import {
  DependentLegGasEstimateError,
  DEPENDENT_LEG_ESTIMATE_ATTEMPTS,
} from "@tools/evm-chains/dependent-leg-gas-estimate.js";
import { RECEIPT_WAIT_ATTEMPTS } from "@tools/evm-chains/receipt-guard.js";

const OWNER = "0x18b467Cb28FC07Ca6E17A964b3319051B3072B79" as Address;
const TO = "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5" as Address;
const SERIALIZED = "0x02f8710182012a8459682f008459682f2f82520894111111111111111111111111111111111111111180840123456780c0" as Hex;
const HASH = keccak256(SERIALIZED);
const REPLACEMENT_HASH = `0x${"d".repeat(64)}` as Hex;
const NONCE = 42;

function makeClients(opts: {
  sendThrows?: boolean;
  receiptThrows?: boolean;
  receiptStatus?: "success" | "reverted";
  /** Per-attempt receipt-wait script (a receipt resolves, an Error rejects) — overrides `receiptThrows`/`receiptStatus`. */
  receiptScript?: Array<{ status: string; logs: unknown[] } | Error>;
  gasEstimate?: bigint;
  estimateThrows?: boolean;
  /** Per-attempt estimate script (a bigint resolves, an Error rejects) — overrides the options above. */
  estimateScript?: Array<bigint | Error>;
  preparedGasOverride?: bigint;
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
  preparedMaxFeePerGasOverride?: bigint;
  headBlock?: bigint;
  replacement?: {
    data?: Hex;
    gas?: bigint;
    maxFeePerGas?: bigint;
    maxPriorityFeePerGas?: bigint;
  };
} = {}) {
  const calls: string[] = [];
  const estimateArgs: Array<Record<string, unknown>> = [];
  const preparedRequests: Array<Record<string, unknown>> = [];
  const signedRequests: Array<Record<string, unknown>> = [];
  const script = opts.estimateScript ? [...opts.estimateScript] : undefined;
  const receiptScript = opts.receiptScript ? [...opts.receiptScript] : undefined;
  const publicClient = {
    getBlockNumber: vi.fn(async () => {
      calls.push("getBlockNumber");
      return opts.headBlock ?? 0n;
    }),
    estimateGas: vi.fn(async (args: Record<string, unknown>) => {
      calls.push("estimateGas");
      estimateArgs.push(args);
      if (script) {
        const next = script.shift();
        if (next === undefined) throw new Error("test: estimateGas called past the scripted bound");
        if (next instanceof Error) throw next;
        return next;
      }
      if (opts.estimateThrows) throw new Error("execution reverted: Call failed");
      return opts.gasEstimate ?? 100_000n;
    }),
    estimateFeesPerGas: vi.fn(async () => ({
      maxFeePerGas: opts.maxFeePerGas ?? 20_000_000_000n,
      maxPriorityFeePerGas: opts.maxPriorityFeePerGas ?? 2_000_000_000n,
    })),
    sendRawTransaction: vi.fn(async () => {
      calls.push("sendRawTransaction");
      if (opts.sendThrows) throw new Error("network down");
      return HASH;
    }),
    waitForTransactionReceipt: vi.fn(async (args: Record<string, unknown>) => {
      calls.push("waitForTransactionReceipt");
      if (opts.replacement) {
        const onReplaced = args.onReplaced as ((value: unknown) => void) | undefined;
        onReplaced?.({
          reason: "repriced",
          replacedTransaction: { hash: HASH },
          transaction: {
            hash: REPLACEMENT_HASH,
            from: OWNER,
            nonce: NONCE,
            to: TO,
            input: opts.replacement.data ?? "0x",
            value: 0n,
            gas: opts.replacement.gas ?? 200_000n,
            maxFeePerGas: opts.replacement.maxFeePerGas ?? 20_000_000_000n,
            maxPriorityFeePerGas:
              opts.replacement.maxPriorityFeePerGas ?? 2_000_000_000n,
          },
          transactionReceipt: { status: "success", logs: [] },
        });
      }
      if (receiptScript) {
        const next = receiptScript.shift();
        if (next === undefined) throw new Error("test: waitForTransactionReceipt called past the scripted bound");
        if (next instanceof Error) throw next;
        return next;
      }
      if (opts.receiptThrows) throw new Error("could not confirm");
      return { status: opts.receiptStatus ?? "success", logs: [] };
    }),
  };
  const walletClient = {
    account: { address: OWNER },
    chain: { id: 1 },
    prepareTransactionRequest: vi.fn(async (request: Record<string, unknown>) => {
      calls.push("prepareTransactionRequest");
      preparedRequests.push(request);
      return {
        nonce: NONCE,
        to: TO,
        data: "0x",
        value: 0n,
        // `undefined` unless a test simulates viem's `wallet_fillTransaction`
        // path replacing the requested gas with the node's own figure.
        ...(opts.preparedGasOverride === undefined ? {} : { gas: opts.preparedGasOverride }),
        ...(request.maxFeePerGas === undefined
          ? {}
          : { maxFeePerGas: opts.preparedMaxFeePerGasOverride ?? request.maxFeePerGas }),
        ...(request.maxPriorityFeePerGas === undefined
          ? {}
          : { maxPriorityFeePerGas: request.maxPriorityFeePerGas }),
      };
    }),
    signTransaction: vi.fn(async (request: Record<string, unknown>) => {
      calls.push("signTransaction");
      signedRequests.push(request);
      return SERIALIZED;
    }),
  };
  return { publicClient, walletClient, calls, estimateArgs, preparedRequests, signedRequests } as unknown as {
    publicClient: Parameters<typeof signStageBroadcast>[0];
    walletClient: Parameters<typeof signStageBroadcast>[1];
    calls: string[];
    estimateArgs: Array<Record<string, unknown>>;
    preparedRequests: Array<Record<string, unknown>>;
    signedRequests: Array<Record<string, unknown>>;
  };
}

function hooks() {
  const staged: unknown[] = [];
  let acceptedCalled = false;
  return {
    onHashStaged: vi.fn(async (handles: unknown) => {
      staged.push(handles);
    }),
    onAccepted: vi.fn(async () => {
      acceptedCalled = true;
    }),
    staged,
    get acceptedCalled() {
      return acceptedCalled;
    },
  };
}

describe("signStageBroadcast", () => {
  it("persists the hash BEFORE broadcasting, then confirms on a successful mined receipt", async () => {
    const { publicClient, walletClient, calls } = makeClients();
    const h = hooks();

    const outcome = await signStageBroadcast(publicClient, walletClient, { to: TO, data: "0x" }, h);

    expect(outcome).toEqual({ kind: "confirmed", txHash: HASH, receipt: { status: "success", logs: [] } });
    // onHashStaged fired before sendRawTransaction — the durability contract.
    expect(h.onHashStaged).toHaveBeenCalledWith({ txHash: HASH, fromAddress: OWNER, nonce: NONCE });
    expect(calls.indexOf("sendRawTransaction")).toBeGreaterThan(calls.indexOf("signTransaction"));
    expect(h.onAccepted).toHaveBeenCalledTimes(1);
    expect(h.acceptedCalled).toBe(true);
  });

  it("stages the hash even when the row will end up ambiguous (never silently lost)", async () => {
    const { publicClient, walletClient } = makeClients({ sendThrows: true });
    const h = hooks();

    const outcome = await signStageBroadcast(publicClient, walletClient, { to: TO, data: "0x" }, h);

    expect(outcome).toMatchObject({ kind: "ambiguous", txHash: HASH, stage: "send" });
    expect(h.onHashStaged).toHaveBeenCalledTimes(1);
    // A send-time failure never reaches the broadcast-accepted bookkeeping.
    expect(h.onAccepted).not.toHaveBeenCalled();
  });

  it("reports a mined revert distinctly from a confirmation failure", async () => {
    const { publicClient, walletClient } = makeClients({ receiptStatus: "reverted" });
    const h = hooks();

    const outcome = await signStageBroadcast(publicClient, walletClient, { to: TO, data: "0x" }, h);

    expect(outcome).toEqual({ kind: "reverted", txHash: HASH, receipt: { status: "reverted", logs: [] } });
    expect(h.onAccepted).toHaveBeenCalledTimes(1);
  });

  it("swallows an onAccepted bookkeeping throw — the broadcast is already in flight", async () => {
    const { publicClient, walletClient } = makeClients();
    const h = hooks();
    h.onAccepted.mockRejectedValueOnce(new Error("db hiccup"));

    const outcome = await signStageBroadcast(publicClient, walletClient, { to: TO, data: "0x" }, h);

    expect(outcome).toEqual({ kind: "confirmed", txHash: HASH, receipt: { status: "success", logs: [] } });
  });

  it("reports an unresolvable receipt-wait as ambiguous — never a definitive failure", async () => {
    const { publicClient, walletClient } = makeClients({ receiptThrows: true });
    const h = hooks();

    const outcome = await signStageBroadcast(
      publicClient, walletClient, { to: TO, data: "0x" }, h, undefined, { delayMs: 0 },
    );

    expect(outcome).toMatchObject({ kind: "ambiguous", txHash: HASH, stage: "confirm" });
    // Ambiguity is declared only after the BOUNDED retry of the read.
    expect(publicClient.waitForTransactionReceipt).toHaveBeenCalledTimes(RECEIPT_WAIT_ATTEMPTS);
    // The RPC DID accept the submission before confirmation became ambiguous.
    expect(h.onAccepted).toHaveBeenCalledTimes(1);
  });

  it("recovers a TRANSIENT receipt-wait failure — the swap confirms instead of going pending", async () => {
    // The live incident: `waitForTransactionReceipt` threw once on an RPC
    // hiccup for a swap that HAD already mined, and one throw was enough to
    // record the row pending forever.
    const { publicClient, walletClient, calls } = makeClients({
      receiptScript: [new Error("HTTP request failed"), { status: "success", logs: [] }],
    });
    const h = hooks();

    const outcome = await signStageBroadcast(
      publicClient, walletClient, { to: TO, data: "0x" }, h, undefined, { delayMs: 0 },
    );

    expect(outcome).toEqual({ kind: "confirmed", txHash: HASH, receipt: { status: "success", logs: [] } });
    expect(publicClient.waitForTransactionReceipt).toHaveBeenCalledTimes(2);
    // ONLY the read repeated. Re-sending a signed transaction can double-spend.
    expect(calls.filter((c) => c === "sendRawTransaction")).toHaveLength(1);
  });

  it("never retries the wait after a MINED REVERT — a resolved receipt is a definitive answer", async () => {
    const { publicClient, walletClient } = makeClients({ receiptStatus: "reverted" });

    const outcome = await signStageBroadcast(
      publicClient, walletClient, { to: TO, data: "0x" }, hooks(), undefined, { delayMs: 0 },
    );

    expect(outcome.kind).toBe("reverted");
    expect(publicClient.waitForTransactionReceipt).toHaveBeenCalledTimes(1);
  });
});

describe("signStageBroadcast gas limit", () => {
  it("signs with headroom above the node estimate, not the bare estimate", async () => {
    const { publicClient, walletClient, preparedRequests, signedRequests } = makeClients({
      gasEstimate: 100_000n,
    });

    await signStageBroadcast(publicClient, walletClient, { to: TO, data: "0x" }, hooks());

    expect(preparedRequests).toHaveLength(1);
    expect(preparedRequests[0]!.gas).toBe(200_000n);
    // The serialized bytes are what the chain enforces.
    expect(signedRequests[0]!.gas).toBe(200_000n);
  });

  it("keeps the headroom when preparation hands back the node's own unbuffered gas", async () => {
    // viem may fill fees/nonce via the node's `wallet_fillTransaction`, whose
    // reply overwrites `gas`. That must not silently undo the headroom.
    const { publicClient, walletClient, signedRequests } = makeClients({
      gasEstimate: 100_000n,
      preparedGasOverride: 100_000n,
    });

    await signStageBroadcast(publicClient, walletClient, { to: TO, data: "0x" }, hooks());

    expect(signedRequests[0]!.gas).toBe(200_000n);
  });

  it("would have covered the Base ETH→USDC route that mined-reverted out of gas", async () => {
    // Regression pin for the 2026-07-24 loss (Base tx
    // 0x038e553fe2caaa5206bd1d90a5b1b1a352b8cd3934332a2f4721a95304d07f37 and
    // three siblings). viem's bare `eth_estimateGas` returned 1_026_236, which
    // is exactly the limit that was signed; replaying that calldata at the
    // transaction's own block proves ~1_634_838 was actually required, so the
    // executor sub-call ran out of gas and MetaAggregationRouterV2 surfaced it
    // as `Error("Call failed")` after burning 998_261 gas. The signed limit
    // must clear the real requirement, not merely match the estimate.
    const REVERTED_TX_SIGNED_LIMIT = 1_026_236n;
    const REVERTED_TX_MEASURED_REQUIREMENT = 1_634_838n;
    const { publicClient, walletClient, signedRequests } = makeClients({
      gasEstimate: REVERTED_TX_SIGNED_LIMIT,
    });

    await signStageBroadcast(publicClient, walletClient, { to: TO, data: "0x" }, hooks());

    const signedGas = signedRequests[0]!.gas;
    expect(typeof signedGas).toBe("bigint");
    expect(signedGas as bigint).toBeGreaterThanOrEqual(REVERTED_TX_MEASURED_REQUIREMENT);
  });

  it("estimates against the exact call that will be signed, including native value", async () => {
    // A native-input swap whose estimate omitted `value` would price a
    // different call than the one being signed.
    const { publicClient, walletClient, estimateArgs } = makeClients();

    await signStageBroadcast(
      publicClient,
      walletClient,
      { to: TO, data: "0xdeadbeef", value: 11_000_000_000_000_000n },
      hooks(),
    );

    expect(estimateArgs).toHaveLength(1);
    expect(estimateArgs[0]).toMatchObject({
      to: TO,
      data: "0xdeadbeef",
      value: 11_000_000_000_000_000n,
    });
  });

  it("never signs, stages, or broadcasts when the pre-sign estimate reverts", async () => {
    const { publicClient, walletClient, calls } = makeClients({ estimateThrows: true });
    const h = hooks();

    await expect(
      signStageBroadcast(publicClient, walletClient, { to: TO, data: "0x" }, h),
    ).rejects.toThrow();

    expect(h.onHashStaged).not.toHaveBeenCalled();
    expect(calls).not.toContain("signTransaction");
    expect(calls).not.toContain("sendRawTransaction");
    // No confirmed prior leg was supplied, so there is no stale-state
    // hypothesis: one attempt, the node's error, done.
    expect(calls.filter((c) => c === "estimateGas")).toHaveLength(1);
  });
});

describe("signStageBroadcast approval-bound fee exposure", () => {
  const ceiling = {
    gasLimit: 200_000n,
    maxFeePerGas: 20_000_000_000n,
    maxPriorityFeePerGas: 2_000_000_000n,
    maxNetworkFeeWei: 4_000_000_000_000_000n,
  };

  it("serializes only the live EIP-1559 fees proven within the approved ceiling", async () => {
    const { publicClient, walletClient, signedRequests } = makeClients();

    await signStageBroadcast(
      publicClient,
      walletClient,
      { to: TO, data: "0x" },
      hooks(),
      undefined,
      undefined,
      ceiling,
    );

    expect(signedRequests[0]).toMatchObject({
      gas: 200_000n,
      maxFeePerGas: 20_000_000_000n,
      maxPriorityFeePerGas: 2_000_000_000n,
    });
  });

  it.each([
    ["gas", { gasEstimate: 100_001n }],
    ["max fee", { maxFeePerGas: 20_000_000_001n }],
    ["priority fee", { maxPriorityFeePerGas: 2_000_000_001n }],
  ])("refuses increased %s before signing, staging, or broadcasting", async (_name, options) => {
    const { publicClient, walletClient, calls } = makeClients(options);
    const h = hooks();

    await expect(signStageBroadcast(
      publicClient,
      walletClient,
      { to: TO, data: "0x" },
      h,
      undefined,
      undefined,
      ceiling,
    )).rejects.toThrow(/approved transaction ceiling/);

    expect(h.onHashStaged).not.toHaveBeenCalled();
    expect(calls).not.toContain("signTransaction");
    expect(calls).not.toContain("sendRawTransaction");
  });

  it("refuses a preparation result that raises the approved maximum fee", async () => {
    const { publicClient, walletClient, calls } = makeClients({
      preparedMaxFeePerGasOverride: 20_000_000_001n,
    });

    await expect(signStageBroadcast(
      publicClient,
      walletClient,
      { to: TO, data: "0x" },
      hooks(),
      undefined,
      undefined,
      ceiling,
    )).rejects.toThrow(/prepared EIP-1559 fees/);

    expect(calls).not.toContain("signTransaction");
    expect(calls).not.toContain("sendRawTransaction");
  });

  it("preserves an exact fee-only replacement within the approved ceiling", async () => {
    const { publicClient, walletClient } = makeClients({ replacement: {} });

    const outcome = await signStageBroadcast(
      publicClient,
      walletClient,
      { to: TO, data: "0x" },
      hooks(),
      undefined,
      undefined,
      ceiling,
    );

    expect(outcome).toMatchObject({
      kind: "confirmed",
      replacement: {
        reason: "repriced",
        replacedTxHash: HASH,
        replacementTxHash: REPLACEMENT_HASH,
        fromAddress: OWNER,
        nonce: NONCE,
      },
    });
  });

  it("refuses to confirm a replacement above the approved fee ceiling", async () => {
    const { publicClient, walletClient } = makeClients({
      replacement: { maxFeePerGas: ceiling.maxFeePerGas + 1n },
    });

    const outcome = await signStageBroadcast(
      publicClient,
      walletClient,
      { to: TO, data: "0x" },
      hooks(),
      undefined,
      undefined,
      ceiling,
    );

    expect(outcome).toMatchObject({
      kind: "ambiguous",
      stage: "confirm",
      reason: expect.stringContaining("approved fee ceiling"),
    });
  });

  it("refuses to confirm a replacement that changes the staged calldata", async () => {
    const { publicClient, walletClient } = makeClients({
      replacement: { data: "0x1234" },
    });

    const outcome = await signStageBroadcast(
      publicClient,
      walletClient,
      { to: TO, data: "0x" },
      hooks(),
      undefined,
      undefined,
      ceiling,
    );

    expect(outcome).toMatchObject({
      kind: "ambiguous",
      stage: "confirm",
      reason: expect.stringContaining("calldata"),
    });
  });
});

/**
 * Read-after-write regression (live 2026-07-24/25, Khalani AND Relay, real
 * funds): the deposit leg is estimated AFTER the approval leg's receipt
 * confirms, and the estimating node does not always reflect that approval yet.
 * `priorLeg` is the approval's receipt anchor — see
 * `@tools/evm-chains/dependent-leg-gas-estimate.js`.
 */
describe("signStageBroadcast — estimate after a confirmed prior leg", () => {
  const APPROVAL_BLOCK = 34_567_890n;
  /** The exact string the Khalani deposit leg was refused with. */
  const LIVE_ALLOWANCE_REVERT = "Execution reverted with reason: ERC20: transfer amount exceeds allowance.";

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  async function settle<T>(promise: Promise<T>): Promise<T> {
    const raced = promise.then((value) => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error }));
    await vi.advanceTimersByTimeAsync(60_000);
    const result = await raced;
    if (!result.ok) throw result.error;
    return result.value;
  }

  it("signs and broadcasts the leg when the estimate succeeds on a later attempt", async () => {
    const { publicClient, walletClient, calls } = makeClients({
      estimateScript: [new Error(LIVE_ALLOWANCE_REVERT), 100_000n],
      headBlock: APPROVAL_BLOCK,
    });
    const h = hooks();

    const outcome = await settle(
      signStageBroadcast(publicClient, walletClient, { to: TO, data: "0x" }, h, { blockNumber: APPROVAL_BLOCK }),
    );

    // The live discriminator: nothing about the transaction changed, only that
    // the node caught up — so the leg must proceed, not be refused.
    expect(outcome).toEqual({ kind: "confirmed", txHash: HASH, receipt: { status: "success", logs: [] } });
    expect(h.onHashStaged).toHaveBeenCalledTimes(1);
    expect(calls.filter((c) => c === "estimateGas")).toHaveLength(2);
    expect(calls).toContain("sendRawTransaction");
  });

  it("still refuses the leg pre-sign when every bounded attempt fails — nothing signed, staged, or broadcast", async () => {
    const { publicClient, walletClient, calls } = makeClients({
      estimateScript: [
        new Error(LIVE_ALLOWANCE_REVERT),
        new Error(LIVE_ALLOWANCE_REVERT),
        new Error(LIVE_ALLOWANCE_REVERT),
      ],
      headBlock: APPROVAL_BLOCK,
    });
    const h = hooks();

    const err = await settle(
      signStageBroadcast(publicClient, walletClient, { to: TO, data: "0x" }, h, { blockNumber: APPROVAL_BLOCK })
        .catch((e: unknown) => e),
    );

    expect(err).toBeInstanceOf(DependentLegGasEstimateError);
    expect(h.onHashStaged).not.toHaveBeenCalled();
    expect(calls).not.toContain("signTransaction");
    expect(calls).not.toContain("sendRawTransaction");
    // Bounded: the safety property is preserved without an unbounded retry loop.
    expect(calls.filter((c) => c === "estimateGas")).toHaveLength(DEPENDENT_LEG_ESTIMATE_ATTEMPTS);
  });

  it("prices the recovered attempt exactly like the first — same call, headroom unchanged", async () => {
    const { publicClient, walletClient, estimateArgs, signedRequests } = makeClients({
      estimateScript: [new Error(LIVE_ALLOWANCE_REVERT), 100_000n],
      headBlock: APPROVAL_BLOCK,
    });

    await settle(
      signStageBroadcast(
        publicClient, walletClient,
        { to: TO, data: "0xdeadbeef", value: 11_000_000_000_000_000n },
        hooks(), { blockNumber: APPROVAL_BLOCK },
      ),
    );

    expect(estimateArgs).toHaveLength(2);
    expect(estimateArgs[1]).toEqual(estimateArgs[0]);
    // The headroom policy is untouched by the retry.
    expect(signedRequests[0]!.gas).toBe(200_000n);
  });
});
