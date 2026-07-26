/**
 * Behavior tests for `estimateGasForPlanLeg` — the read-after-write policy for
 * an EVM leg that follows a leg the same plan already confirmed.
 *
 * Pins the live 2026-07-24/25 regression and the safety property it must not
 * trade away:
 *   - an estimate that reverts and then SUCCEEDS on a later attempt yields a
 *     gas figure (the leg proceeds) — reproduced on Khalani AND Relay with
 *     real funds, where an immediate retry of an unchanged transaction landed;
 *   - an estimate that fails on EVERY attempt still throws, so the caller
 *     refuses the leg before signing;
 *   - the retry is BOUNDED — exactly `DEPENDENT_LEG_ESTIMATE_ATTEMPTS` calls,
 *     never a loop that outlives the quote it was priced against;
 *   - with no confirmed prior leg there is no stale-state hypothesis, so the
 *     node's error propagates unchanged after ONE attempt (today's behavior
 *     for a first-touch revert is untouched);
 *   - the retry waits for the estimating client's head to reach the prior
 *     leg's receipt block rather than only sleeping.
 *
 * The revert strings are the ones the two live failures actually produced.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Account, Address } from "viem";
import {
  estimateGasForPlanLeg,
  priorLegAnchorFrom,
  dependentLegEstimateGuidance,
  DependentLegGasEstimateError,
  DEPENDENT_LEG_ESTIMATE_ATTEMPTS,
  DEPENDENT_LEG_ESTIMATE_MARKER,
} from "@tools/evm-chains/dependent-leg-gas-estimate.js";

/** Khalani Base→Arbitrum, deposit refused while allowance 0x2445ce73… was already confirmed. */
const KHALANI_LIVE_REVERT = "Execution reverted with reason: ERC20: transfer amount exceeds allowance.";
/** Relay Base→Arbitrum, same shape, deposit refused while allowance 0x68dec753… was already confirmed. */
const RELAY_LIVE_REVERT = "Execution reverted for an unknown reason.";

const ACCOUNT = { address: "0x18b467Cb28FC07Ca6E17A964b3319051B3072B79" as Address } as Account;
const TO = "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5" as Address;
const APPROVAL_BLOCK = 34_567_890n;

const call = { account: ACCOUNT, to: TO, data: "0xdeadbeef" as const, value: 0n };

function makeClient(opts: { estimate: Array<bigint | Error>; head?: bigint | Error }) {
  const remaining = [...opts.estimate];
  const estimateGas = vi.fn(async () => {
    const next = remaining.shift();
    if (next === undefined) throw new Error("test: estimateGas called more times than the bound allows");
    if (next instanceof Error) throw next;
    return next;
  });
  const getBlockNumber = vi.fn(async () => {
    if (opts.head instanceof Error) throw opts.head;
    return opts.head ?? APPROVAL_BLOCK;
  });
  return { client: { estimateGas, getBlockNumber } as unknown as Parameters<typeof estimateGasForPlanLeg>[0], estimateGas, getBlockNumber };
}

/** Drive the bounded backoff/head-poll timers to completion without real waiting. */
async function settle<T>(promise: Promise<T>): Promise<T> {
  const raced = promise.then((value) => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error }));
  await vi.advanceTimersByTimeAsync(60_000);
  const result = await raced;
  if (!result.ok) throw result.error;
  return result.value;
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("estimateGasForPlanLeg — a leg that follows a confirmed prior leg", () => {
  it("returns an estimate when a later attempt succeeds (the live Khalani/Relay recovery)", async () => {
    const { client, estimateGas } = makeClient({
      estimate: [new Error(KHALANI_LIVE_REVERT), 250_000n],
    });

    const gas = await settle(
      estimateGasForPlanLeg(client, call, { blockNumber: APPROVAL_BLOCK }),
    );

    expect(gas).toBe(250_000n);
    expect(estimateGas).toHaveBeenCalledTimes(2);
  });

  it("recovers on the LAST allowed attempt too", async () => {
    const { client, estimateGas } = makeClient({
      estimate: [new Error(KHALANI_LIVE_REVERT), new Error(KHALANI_LIVE_REVERT), 250_000n],
    });

    await expect(settle(estimateGasForPlanLeg(client, call, { blockNumber: APPROVAL_BLOCK }))).resolves.toBe(250_000n);
    expect(estimateGas).toHaveBeenCalledTimes(DEPENDENT_LEG_ESTIMATE_ATTEMPTS);
  });

  it("still refuses the leg when every attempt fails, and the retry is bounded at exactly 3 attempts", async () => {
    const { client, estimateGas } = makeClient({
      estimate: [new Error(RELAY_LIVE_REVERT), new Error(RELAY_LIVE_REVERT), new Error(RELAY_LIVE_REVERT)],
    });

    const err = await settle(
      estimateGasForPlanLeg(client, call, { blockNumber: APPROVAL_BLOCK }).catch((e: unknown) => e),
    );

    expect(err).toBeInstanceOf(DependentLegGasEstimateError);
    // The bound is the point: a genuine revert must not spin forever.
    expect(estimateGas).toHaveBeenCalledTimes(3);
    expect(DEPENDENT_LEG_ESTIMATE_ATTEMPTS).toBe(3);
  });

  it("waits for the estimating client's head to reach the prior leg's block before re-estimating", async () => {
    const order: string[] = [];
    const estimateGas = vi.fn(async () => {
      order.push("estimateGas");
      throw new Error(KHALANI_LIVE_REVERT);
    });
    const getBlockNumber = vi.fn(async () => {
      order.push("getBlockNumber");
      return APPROVAL_BLOCK;
    });
    const client = { estimateGas, getBlockNumber } as unknown as Parameters<typeof estimateGasForPlanLeg>[0];

    await settle(estimateGasForPlanLeg(client, call, { blockNumber: APPROVAL_BLOCK }).catch(() => undefined));

    expect(order).toEqual(["estimateGas", "getBlockNumber", "estimateGas", "getBlockNumber", "estimateGas"]);
    // Anchored, not blind: the head is read fresh, never from viem's block cache.
    expect(getBlockNumber).toHaveBeenCalledWith({ cacheTime: 0 });
  });

  it("keeps polling while the client's head is still behind the prior leg, then estimates anyway (bounded)", async () => {
    const heads = [APPROVAL_BLOCK - 3n, APPROVAL_BLOCK - 2n, APPROVAL_BLOCK - 1n];
    const getBlockNumber = vi.fn(async () => heads.shift() ?? APPROVAL_BLOCK - 1n);
    const estimateGas = vi.fn(async () => 120_000n);
    const client = { estimateGas, getBlockNumber } as unknown as Parameters<typeof estimateGasForPlanLeg>[0];
    // First attempt fails so the retry path (and its head poll) is entered.
    estimateGas.mockRejectedValueOnce(new Error(KHALANI_LIVE_REVERT));

    const gas = await settle(estimateGasForPlanLeg(client, call, { blockNumber: APPROVAL_BLOCK }));

    expect(gas).toBe(120_000n);
    // 3 polls max per retry — never an unbounded wait for a node that never catches up.
    expect(getBlockNumber).toHaveBeenCalledTimes(3);
  });

  it("does not let a failing head read mask the estimate failure", async () => {
    const { client, estimateGas } = makeClient({
      estimate: [new Error(KHALANI_LIVE_REVERT), new Error(KHALANI_LIVE_REVERT), new Error(KHALANI_LIVE_REVERT)],
      head: new Error("rpc: getBlockNumber unavailable"),
    });

    const err = await settle(
      estimateGasForPlanLeg(client, call, { blockNumber: APPROVAL_BLOCK }).catch((e: unknown) => e),
    );

    expect(err).toBeInstanceOf(DependentLegGasEstimateError);
    expect((err as DependentLegGasEstimateError).observedHeadBlock).toBeNull();
    expect(estimateGas).toHaveBeenCalledTimes(3);
  });
});

describe("estimateGasForPlanLeg — a leg with no confirmed prior leg", () => {
  it("makes exactly ONE attempt and rethrows the node's own error untouched", async () => {
    const revert = new Error(KHALANI_LIVE_REVERT);
    const { client, estimateGas, getBlockNumber } = makeClient({ estimate: [revert] });

    const err = await settle(estimateGasForPlanLeg(client, call, undefined).catch((e: unknown) => e));

    // Nothing of ours is behind this call, so there is no staleness to suspect.
    expect(err).toBe(revert);
    expect(err).not.toBeInstanceOf(DependentLegGasEstimateError);
    expect(estimateGas).toHaveBeenCalledTimes(1);
    expect(getBlockNumber).not.toHaveBeenCalled();
  });

  it("omits `data` from the estimate when the leg carries none", async () => {
    const { client, estimateGas } = makeClient({ estimate: [90_000n] });

    await settle(estimateGasForPlanLeg(client, { account: ACCOUNT, to: TO, value: 7n }, undefined));

    expect(estimateGas).toHaveBeenCalledWith({ account: ACCOUNT, to: TO, value: 7n });
  });
});

describe("failure-class distinction", () => {
  it("carries a greppable marker + the anchor evidence in the message that becomes the durable reason", async () => {
    const { client } = makeClient({
      estimate: [new Error(KHALANI_LIVE_REVERT), new Error(KHALANI_LIVE_REVERT), new Error(KHALANI_LIVE_REVERT)],
      head: APPROVAL_BLOCK - 1n,
    });

    const err = await settle(
      estimateGasForPlanLeg(client, call, { blockNumber: APPROVAL_BLOCK }).catch((e: unknown) => e),
    );

    const message = (err as DependentLegGasEstimateError).message;
    expect(message.startsWith(DEPENDENT_LEG_ESTIMATE_MARKER)).toBe(true);
    expect(message).toContain("attempts=3");
    expect(message).toContain(`prior_leg_block=${APPROVAL_BLOCK}`);
    expect(message).toContain(`rpc_head=${APPROVAL_BLOCK - 1n}`);
    expect(message).toContain("nothing_signed");
    // The node's own reason survives, and the full error stays as `cause`.
    expect(message).toContain("ERC20: transfer amount exceeds allowance");
    expect((err as DependentLegGasEstimateError).cause).toBeInstanceOf(Error);
    // Fits the venues' 200-char scrub cap, so the marker is never truncated away.
    expect(message.length).toBeLessThanOrEqual(200);
  });

  it("guides the agent to a bounded retry, never to 'do not retry'", () => {
    const err = new DependentLegGasEstimateError({
      attempts: 3,
      priorLegBlockNumber: APPROVAL_BLOCK,
      observedHeadBlock: APPROVAL_BLOCK,
      cause: new Error(RELAY_LIVE_REVERT),
    });

    const guidance = dependentLegEstimateGuidance(err);

    expect(guidance).toContain("Nothing was signed or broadcast");
    expect(guidance).toContain("reasonable");
    expect(guidance).toContain("do not keep retrying");
    expect(guidance).not.toMatch(/do not re-?bridge/i);
  });
});

describe("priorLegAnchorFrom", () => {
  it("accepts a real receipt block and rejects anything else (no anchor → today's single attempt)", () => {
    expect(priorLegAnchorFrom(APPROVAL_BLOCK)).toEqual({ blockNumber: APPROVAL_BLOCK });
    expect(priorLegAnchorFrom(undefined)).toBeUndefined();
    expect(priorLegAnchorFrom(null)).toBeUndefined();
    expect(priorLegAnchorFrom("34567890")).toBeUndefined();
    expect(priorLegAnchorFrom(34_567_890)).toBeUndefined();
  });
});
