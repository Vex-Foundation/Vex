/**
 * Uniswap staged execution primitives — ERC-20 allowance reads/allowlist
 * (`erc20.ts`) and the sign/broadcast pair the execute handler stages around
 * `agent_activity.markActivityBroadcast` (`execute.ts`).
 *
 * Renamed from `uniswap-receipt-status.test.ts` — the old monolithic
 * `sendUniswapTransaction`/`ensureUniswapAllowanceExact` this file used to
 * test are gone (superseded by the staged flow the execute handler now owns
 * per-broadcast); the mined-revert-detection case they used to cover is a
 * generic `waitForSuccessfulReceipt` behavior already pinned by
 * `evm-chains/receipt-guard.test.ts`.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { keccak256, type Address, type Hex } from "viem";

import { ErrorCodes } from "../../../errors.js";
import { readUniswapAllowance } from "@tools/uniswap/erc20.js";
import {
  signUniswapTransaction as signUniswapTransactionBase,
  broadcastUniswapTransaction,
  buildApproveTx,
} from "@tools/uniswap/execute.js";
import {
  DependentLegGasEstimateError,
  DEPENDENT_LEG_ESTIMATE_ATTEMPTS,
} from "@tools/evm-chains/dependent-leg-gas-estimate.js";

const TOKEN = "0x8Ff92566f2e81BDd68EDfAa8cde73942A723796b" as Address;
const OWNER = "0x1111111111111111111111111111111111111111" as Address;
const ROUTER = "0xcaf681a66d020601342297493863e78c959e5cb2" as Address; // Robinhood SwapRouter02 (allowlisted)
const SIGNED_TX = "0x02f8b0018203118080825208808080c080a0" as Hex;

function signUniswapTransaction(
  publicClient: Parameters<typeof signUniswapTransactionBase>[0],
  walletClient: Parameters<typeof signUniswapTransactionBase>[1],
  tx: Parameters<typeof signUniswapTransactionBase>[2],
  priorLeg?: Parameters<typeof signUniswapTransactionBase>[3],
): ReturnType<typeof signUniswapTransactionBase> {
  return signUniswapTransactionBase(
    publicClient,
    walletClient,
    tx,
    priorLeg,
    async (request) => request.nodePendingNonce,
  );
}

describe("readUniswapAllowance", () => {
  it("reads allowance(owner, spender) via the public client", async () => {
    const readContract = vi.fn().mockResolvedValue(123n);
    const client = { readContract };
    const allowance = await readUniswapAllowance(client as never, TOKEN, OWNER, ROUTER);
    expect(allowance).toBe(123n);
    expect(readContract).toHaveBeenCalledWith(
      expect.objectContaining({ address: TOKEN, functionName: "allowance", args: [OWNER, ROUTER] }),
    );
  });
});

describe("buildApproveTx", () => {
  it("encodes approve(spender, amount) targeting the token contract with zero value", () => {
    const tx = buildApproveTx(TOKEN, ROUTER, 500n);
    expect(tx.to.toLowerCase()).toBe(TOKEN.toLowerCase());
    expect(tx.value).toBe(0n);
    expect(tx.data.startsWith("0x095ea7b3")).toBe(true); // approve(address,uint256) selector
  });

  it("encodes a zero-amount reset identically shaped (USDT-style non-zero-to-non-zero guard)", () => {
    const tx = buildApproveTx(TOKEN, ROUTER, 0n);
    expect(tx.value).toBe(0n);
    expect(tx.data.startsWith("0x095ea7b3")).toBe(true);
  });
});

// ── Staged sign/broadcast (plan §11.1 durability contract) ──────────────────
//
// `signUniswapTransaction`/`broadcastUniswapTransaction` are the two halves the
// execute handler stages around `agent_activity.markActivityBroadcast` — the
// hash persisted BEFORE broadcast must be the SAME hash the node later
// confirms, so `signUniswapTransaction` derives it locally from the signed
// bytes rather than trusting a value returned only after broadcast.

/** A measured direct single-hop V3 `exactInputSingle` estimate — deliberately not a round number. */
const SINGLE_HOP_GAS_ESTIMATE = 247_113n;

interface StagedClientOptions {
  readonly gasEstimate?: bigint;
  readonly estimateThrows?: boolean;
  /** Per-attempt estimate script (a bigint resolves, an Error rejects) — overrides the two above. */
  readonly estimateScript?: ReadonlyArray<bigint | Error>;
  /** Simulates viem's `wallet_fillTransaction` reply replacing the requested gas. */
  readonly preparedGasOverride?: bigint;
  readonly headBlock?: bigint;
}

// `null` = "prepared request carries no nonce" (an explicit `undefined` arg would
// trigger the JS default and silently re-inject 7).
function stagedClients(nonce: number | null = 7, opts: StagedClientOptions = {}) {
  const calls: string[] = [];
  const estimateArgs: Array<Record<string, unknown>> = [];
  const preparedRequests: Array<Record<string, unknown>> = [];
  const signedRequests: Array<Record<string, unknown>> = [];
  const prepareTransactionRequest = vi.fn(async (request: Record<string, unknown>) => {
    calls.push("prepareTransactionRequest");
    preparedRequests.push(request);
    return {
      account: { address: OWNER },
      chain: { id: 4663 },
      to: ROUTER,
      data: "0x",
      value: 0n,
      ...(nonce === null ? {} : { nonce }),
      // `undefined` unless a test simulates the node's fill reply replacing
      // the requested gas with its own unbuffered figure.
      ...(opts.preparedGasOverride === undefined ? {} : { gas: opts.preparedGasOverride }),
    };
  });
  const signTransaction = vi.fn(async (request: Record<string, unknown>) => {
    calls.push("signTransaction");
    signedRequests.push(request);
    return SIGNED_TX;
  });
  const script = opts.estimateScript ? [...opts.estimateScript] : undefined;
  const estimateGas = vi.fn(async (args: Record<string, unknown>) => {
    calls.push("estimateGas");
    estimateArgs.push(args);
    if (script) {
      const next = script.shift();
      if (next === undefined) throw new Error("test: estimateGas called past the scripted bound");
      if (next instanceof Error) throw next;
      return next;
    }
    if (opts.estimateThrows) throw new Error("execution reverted: STF");
    return opts.gasEstimate ?? SINGLE_HOP_GAS_ESTIMATE;
  });
  const getBlockNumber = vi.fn(async () => {
    calls.push("getBlockNumber");
    return opts.headBlock ?? 0n;
  });
  const sendRawTransaction = vi.fn(async () => {
    calls.push("sendRawTransaction");
    return keccak256(SIGNED_TX);
  });
  const walletClient = {
    account: { address: OWNER },
    chain: { id: 4663 },
    prepareTransactionRequest,
    signTransaction,
  };
  const publicClient = { estimateGas, getBlockNumber, sendRawTransaction };
  return {
    walletClient,
    publicClient,
    calls,
    estimateArgs,
    preparedRequests,
    signedRequests,
    prepareTransactionRequest,
    signTransaction,
    estimateGas,
    sendRawTransaction,
  };
}

describe("signUniswapTransaction", () => {
  it("prepares, signs, and derives the tx hash locally from the signed bytes", async () => {
    const { publicClient, walletClient } = stagedClients();
    const signed = await signUniswapTransaction(publicClient as never, walletClient as never, {
      to: ROUTER,
      data: "0x",
      value: 0n,
    });
    expect(signed.serializedTransaction).toBe(SIGNED_TX);
    expect(signed.txHash).toBe(keccak256(SIGNED_TX));
    expect(signed.fromAddress).toBe(OWNER);
    expect(signed.nonce).toBe(7);
  });

  it("throws when the prepared request has no resolved nonce", async () => {
    const { publicClient, walletClient } = stagedClients(null);
    await expect(
      signUniswapTransaction(publicClient as never, walletClient as never, { to: ROUTER, data: "0x", value: 0n }),
    ).rejects.toMatchObject({ code: ErrorCodes.SWAP_FAILED });
  });
});

// ── Gas limit (shared `gasLimitWithHeadroom` policy) ────────────────────────
//
// Mirrors `kyberswap-staged-broadcast.test.ts`'s gas block. Uniswap has the
// same latent defect the KyberSwap loss exposed: signing viem's bare
// `eth_estimateGas` leaves zero headroom, and that estimate moves block to
// block with how many liquidity ticks the swap crosses. Direct single-hop
// pools are cheap enough that it has not bitten this venue yet — a multi-hop
// or volatile-pool route is a different story.

describe("signUniswapTransaction gas limit", () => {
  it("signs with headroom above the node estimate, not the bare estimate", async () => {
    const { publicClient, walletClient, preparedRequests, signedRequests } = stagedClients();

    await signUniswapTransaction(publicClient as never, walletClient as never, {
      to: ROUTER,
      data: "0x",
      value: 0n,
    });

    expect(preparedRequests).toHaveLength(1);
    expect(preparedRequests[0]!.gas).toBe(494_226n); // 247_113 * 2
    // The serialized bytes are what the chain enforces.
    expect(signedRequests[0]!.gas).toBe(494_226n);
  });

  it("keeps the headroom when preparation hands back the node's own unbuffered gas", async () => {
    // viem's `prepareTransactionRequest` attempts `wallet_fillTransaction`
    // whenever fees/nonce still need filling (both do here), and spreads the
    // node's `gas` over the requested one. That must not silently undo the
    // headroom on the object actually signed.
    const { publicClient, walletClient, signedRequests } = stagedClients(7, {
      preparedGasOverride: SINGLE_HOP_GAS_ESTIMATE,
    });

    await signUniswapTransaction(publicClient as never, walletClient as never, {
      to: ROUTER,
      data: "0x",
      value: 0n,
    });

    expect(signedRequests[0]!.gas).toBe(494_226n);
  });

  it("would have covered the volatile route profile that mined-reverted out of gas on KyberSwap", async () => {
    // Regression pin against the 2026-07-24 loss (Base tx
    // 0x038e553fe2caaa5206bd1d90a5b1b1a352b8cd3934332a2f4721a95304d07f37 and
    // three siblings). That venue's bare `eth_estimateGas` returned 1_026_236,
    // which is exactly the limit that was signed; replaying the calldata at the
    // transaction's own block proves ~1_634_838 was actually required. Uniswap
    // signs through a different function but the same estimator, so its signed
    // limit must clear the real requirement, not merely match the estimate.
    const REVERTED_TX_SIGNED_LIMIT = 1_026_236n;
    const REVERTED_TX_MEASURED_REQUIREMENT = 1_634_838n;
    const { publicClient, walletClient, signedRequests } = stagedClients(7, {
      gasEstimate: REVERTED_TX_SIGNED_LIMIT,
    });

    await signUniswapTransaction(publicClient as never, walletClient as never, {
      to: ROUTER,
      data: "0x",
      value: 0n,
    });

    const signedGas = signedRequests[0]!.gas;
    expect(typeof signedGas).toBe("bigint");
    expect(signedGas as bigint).toBeGreaterThanOrEqual(REVERTED_TX_MEASURED_REQUIREMENT);
  });

  it("estimates against the exact call that will be signed, including native value", async () => {
    // A native-input swap (`swapExactETHForTokens` / V3 multicall with
    // msg.value) whose estimate omitted `value` would price a different call
    // than the one being signed.
    const { publicClient, walletClient, estimateArgs } = stagedClients();
    const NATIVE_INPUT = 3_741_882_005_113_640n;

    await signUniswapTransaction(publicClient as never, walletClient as never, {
      to: ROUTER,
      data: "0x7ff36ab5",
      value: NATIVE_INPUT,
    });

    expect(estimateArgs).toHaveLength(1);
    expect(estimateArgs[0]).toMatchObject({
      to: ROUTER,
      data: "0x7ff36ab5",
      value: NATIVE_INPUT,
    });
  });

  it("never signs when the pre-sign estimate reverts — the caller stages nothing", async () => {
    const { publicClient, walletClient, calls } = stagedClients(7, { estimateThrows: true });

    await expect(
      signUniswapTransaction(publicClient as never, walletClient as never, { to: ROUTER, data: "0x", value: 0n }),
    ).rejects.toThrow();

    expect(calls).not.toContain("prepareTransactionRequest");
    expect(calls).not.toContain("signTransaction");
    expect(calls).not.toContain("sendRawTransaction");
    // No confirmed prior leg was supplied — one attempt, the node's own error.
    expect(calls.filter((c) => c === "estimateGas")).toHaveLength(1);
  });
});

/**
 * Uniswap plans `allowance` → `swap` in ONE execute and waits for the
 * approval's receipt in between, so it has the same read-after-write exposure
 * the Khalani and Relay bridges hit live on 2026-07-24/25: the swap leg's
 * pre-sign estimate can run against a node that has not applied the approval
 * it just confirmed.
 */
describe("signUniswapTransaction — swap leg estimated after a confirmed allowance", () => {
  const APPROVAL_BLOCK = 34_567_890n;
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

  it("signs the swap when the estimate succeeds on a retry, with the headroom policy unchanged", async () => {
    const { publicClient, walletClient, signedRequests, calls } = stagedClients(7, {
      estimateScript: [new Error(LIVE_ALLOWANCE_REVERT), SINGLE_HOP_GAS_ESTIMATE],
      headBlock: APPROVAL_BLOCK,
    });

    const signed = await settle(signUniswapTransaction(
      publicClient as never, walletClient as never,
      { to: ROUTER, data: "0x", value: 0n },
      { blockNumber: APPROVAL_BLOCK },
    ));

    expect(signed.txHash).toBe(keccak256(SIGNED_TX));
    expect(signedRequests[0]!.gas).toBe(494_226n);
    expect(calls.filter((c) => c === "estimateGas")).toHaveLength(2);
  });

  it("still refuses the swap pre-sign when every bounded attempt fails", async () => {
    const { publicClient, walletClient, calls } = stagedClients(7, {
      estimateScript: [
        new Error(LIVE_ALLOWANCE_REVERT),
        new Error(LIVE_ALLOWANCE_REVERT),
        new Error(LIVE_ALLOWANCE_REVERT),
      ],
      headBlock: APPROVAL_BLOCK,
    });

    const err = await settle(signUniswapTransaction(
      publicClient as never, walletClient as never,
      { to: ROUTER, data: "0x", value: 0n },
      { blockNumber: APPROVAL_BLOCK },
    ).catch((e: unknown) => e));

    expect(err).toBeInstanceOf(DependentLegGasEstimateError);
    expect(calls).not.toContain("signTransaction");
    expect(calls).not.toContain("sendRawTransaction");
    expect(calls.filter((c) => c === "estimateGas")).toHaveLength(DEPENDENT_LEG_ESTIMATE_ATTEMPTS);
  });
});

describe("broadcastUniswapTransaction", () => {
  it("submits the signed bytes via sendRawTransaction and returns the node's hash", async () => {
    const { publicClient, sendRawTransaction } = stagedClients();
    const hash = await broadcastUniswapTransaction(publicClient as never, SIGNED_TX);
    expect(sendRawTransaction).toHaveBeenCalledWith({ serializedTransaction: SIGNED_TX });
    expect(hash).toBe(keccak256(SIGNED_TX));
  });
});
