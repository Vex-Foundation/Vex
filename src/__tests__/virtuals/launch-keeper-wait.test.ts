/**
 * The keeper wait: the three answers, and the two the money path turns on.
 *
 * OBSERVED is what makes Vex's fee collectible (owner F3). NOT OBSERVED is what
 * waives it permanently. Everything below exists so the second can never be
 * produced by anything except an actual elapsed wait - in particular not by a
 * flaky RPC answer, which is the failure MetaMask's
 * `PendingTransactionTracker` converts into a FAILED transaction
 * (`PendingTransactionTracker.ts:490-495`) and which the Vex wallet-reference
 * audit records as an explicit rejection.
 *
 * THE CLOCK IS INJECTED, so nothing here sleeps. A wall-clock sleep would make
 * the suite slow AND would prove nothing about the deadline: the assertion
 * would be about the test's patience rather than the loop's.
 *
 * THE LOGS ARE REALLY ENCODED, from the same ABI the decoder reads: topics
 * through `encodeEventTopics`, data through `encodeAbiParameters`. The observed
 * path is therefore proven end to end rather than against a hand-typed topic,
 * which would only prove that the stub matches the stub.
 */

import { describe, expect, it, vi } from "vitest";
import {
  encodeAbiParameters,
  encodeEventTopics,
  getAbiItem,
  getAddress,
  type AbiEvent,
  type Address,
  type Hex,
} from "viem";

import {
  BONDING_V5_LAUNCH_ABI,
  KEEPER_WAIT_MS,
  waitForKeeperLaunch,
  type KeeperLogReader,
  type KeeperWaitClock,
} from "@tools/virtuals/launch/index.js";
import {
  virtualsCurveDeployment,
  type VirtualsCurveDeployment,
} from "@tools/virtuals/curve/index.js";

function deployment(key: string): VirtualsCurveDeployment {
  const found = virtualsCurveDeployment(key);
  if (found === undefined) throw new Error(`no deployment for ${key}`);
  return found;
}
const BASE = deployment("base");
const TOKEN: Address = getAddress("0x84A0326C64d9f0E1F640062638807722E1dde87f");
const OTHER_TOKEN: Address = getAddress("0xd1eF7097c42d2a94033148aEC7cA70235dcdC411");
const PAIR: Address = getAddress("0x5724d6793c69187Dc9C0F2d34262DE308fC2F399");
const KEEPER_TX: Hex = "0x9eca4cb55ca76974830c2b0145a4a923df4935bf651f1ff6c87dd5868f720f99";

type StubLog = {
  address: string;
  topics: readonly string[];
  data: string;
  transactionHash: Hex;
  blockNumber: bigint;
};

function eventItem(name: "Launched" | "CancelledLaunch"): AbiEvent {
  const item = getAbiItem({ abi: BONDING_V5_LAUNCH_ABI, name });
  if (item === undefined || item.type !== "event") throw new Error(`no ${name} event in the ABI`);
  return item;
}

/**
 * Encode one log the way the chain does: indexed members into topics, the rest
 * into `data`, both derived from the SAME ABI the decoder reads. viem 2.54 has
 * no `encodeEventLog`, so the two halves are built explicitly.
 */
function encodeLog(name: "Launched" | "CancelledLaunch", args: Record<string, unknown>): {
  topics: readonly string[];
  data: Hex;
} {
  const event = eventItem(name);
  const topics = encodeEventTopics({ abi: [event], eventName: name, args });
  const dataInputs = event.inputs.filter((input) => input.indexed !== true);
  const values = dataInputs.map((input) => args[input.name ?? ""]);
  return { topics, data: encodeAbiParameters(dataInputs, values) };
}

/** A real `Launched` log, encoded from the lane's own ABI. */
function launchedLog(token: Address = TOKEN, txHash: Hex = KEEPER_TX): StubLog {
  const encoded = encodeLog("Launched", {
    token,
    pair: PAIR,
    virtualId: 50_000_019_577n,
    initialPurchase: 2_000_000_000_000_000_000n,
    initialPurchasedAmount: 232_886_927_515_708_105_641_275n,
    launchParams: {
      launchMode: 0,
      airdropBips: 0,
      needAcf: false,
      antiSniperTaxType: 1,
      isProject60days: false,
    },
  });
  return {
    address: BASE.bondingV5,
    topics: encoded.topics,
    data: encoded.data,
    transactionHash: txHash,
    blockNumber: 50_870_291n,
  };
}

/** A real `CancelledLaunch` log, encoded from the same ABI. */
function cancelledLog(token: Address = TOKEN): StubLog {
  const encoded = encodeLog("CancelledLaunch", {
    token,
    pair: PAIR,
    virtualId: 50_000_019_577n,
    initialPurchase: 2_000_000_000_000_000_000n,
  });
  return {
    address: BASE.bondingV5,
    topics: encoded.topics,
    data: encoded.data,
    transactionHash: "0x1111111111111111111111111111111111111111111111111111111111111111",
    blockNumber: 50_870_300n,
  };
}

/** A clock the test drives. Every `sleep` advances `now` by exactly that much. */
function fakeClock(): KeeperWaitClock & { readonly sleeps: number[] } {
  let now = 1_000_000;
  const sleeps: number[] = [];
  return {
    sleeps,
    now: () => now,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      now += ms;
    },
  };
}

const LAUNCHED_EVENT = eventItem("Launched");

interface StubOptions {
  readonly launched?: readonly StubLog[];
  readonly cancelled?: readonly StubLog[];
  /** Throw for the first N calls, then answer normally. */
  readonly throwsForCalls?: number;
}

function stubReader(options: StubOptions): { reader: KeeperLogReader; callCount: () => number } {
  let calls = 0;
  const reader: KeeperLogReader = {
    getLogs: async (params) => {
      calls += 1;
      if (options.throwsForCalls !== undefined && calls <= options.throwsForCalls) {
        throw new Error("rpc unavailable");
      }
      const isLaunched = params.event.name === LAUNCHED_EVENT.name;
      const rows = isLaunched ? options.launched ?? [] : options.cancelled ?? [];
      // The node filters on the indexed token; the stub honours that so the
      // decoder's own re-check is tested against a well-behaved node too.
      const wanted = params.args.token.slice(2).toLowerCase();
      return rows.filter((row) => (row.topics[1] ?? "").toLowerCase().endsWith(wanted));
    },
  };
  return { reader, callCount: () => calls };
}

describe("waitForKeeperLaunch", () => {
  it("OBSERVES the keeper's launch and reports the transaction that did it", async () => {
    const clock = fakeClock();
    const { reader } = stubReader({ launched: [launchedLog()] });
    const outcome = await waitForKeeperLaunch({
      client: reader,
      deployment: BASE,
      token: TOKEN,
      fromBlock: 50_870_256n,
      budgetMs: 10_000,
      clock,
    });

    expect(outcome.kind).toBe("observed");
    if (outcome.kind !== "observed") throw new Error("expected observed");
    expect(outcome.txHash).toBe(KEEPER_TX);
    expect(outcome.launched.token).toBe(TOKEN);
    expect(outcome.launched.pair).toBe(PAIR);
    // The figure the launch handler records as the output leg: what the initial
    // purchase actually bought, which only `Launched` carries.
    expect(outcome.launched.initialPurchasedAmountRaw).toBe(232_886_927_515_708_105_641_275n);
    // It returned on the FIRST read rather than waiting out the budget.
    expect(clock.sleeps).toEqual([]);
  });

  it("does not mistake another agent's Launched for this one's", async () => {
    const clock = fakeClock();
    const { reader } = stubReader({ launched: [launchedLog(OTHER_TOKEN)] });
    const outcome = await waitForKeeperLaunch({
      client: reader,
      deployment: BASE,
      token: TOKEN,
      fromBlock: 0n,
      budgetMs: 4_000,
      clock,
    });
    expect(outcome.kind).toBe("not_observed");
  });

  it("reports a cancel as a cancel, with the amount the contract returned", async () => {
    const clock = fakeClock();
    const { reader } = stubReader({ cancelled: [cancelledLog()] });
    const outcome = await waitForKeeperLaunch({
      client: reader,
      deployment: BASE,
      token: TOKEN,
      fromBlock: 0n,
      budgetMs: 10_000,
      clock,
    });
    expect(outcome.kind).toBe("cancelled");
    if (outcome.kind !== "cancelled") throw new Error("expected cancelled");
    expect(outcome.cancelled.token).toBe(TOKEN);
    expect(outcome.cancelled.refundedRaw).toBe(2_000_000_000_000_000_000n);
  });

  it("waits the WHOLE budget before answering not_observed, and says how long", async () => {
    const clock = fakeClock();
    const { reader, callCount } = stubReader({});
    const outcome = await waitForKeeperLaunch({
      client: reader,
      deployment: BASE,
      token: TOKEN,
      fromBlock: 0n,
      budgetMs: 10_000,
      pollMs: 5_000,
      clock,
    });

    expect(outcome.kind).toBe("not_observed");
    if (outcome.kind !== "not_observed") throw new Error("expected not_observed");
    expect(outcome.waitedMs).toBeGreaterThanOrEqual(10_000);
    // The chain ANSWERED and had nothing, which is a different fact from "we
    // could not ask" - so there is no error to report.
    expect(outcome.lastReadError).toBeNull();
    expect(callCount()).toBeGreaterThan(1);
  });

  it("NEVER lets a failing RPC read end the wait", async () => {
    // The defect this covers: one transient error turning a launched agent into
    // `awaiting_keeper`, which would waive a fee that was actually earned AND
    // tell the user their agent is not live when it is.
    const clock = fakeClock();
    const { reader } = stubReader({ throwsForCalls: 1_000 });
    const outcome = await waitForKeeperLaunch({
      client: reader,
      deployment: BASE,
      token: TOKEN,
      fromBlock: 0n,
      budgetMs: 8_000,
      pollMs: 2_000,
      clock,
    });

    expect(outcome.kind).toBe("not_observed");
    if (outcome.kind !== "not_observed") throw new Error("expected not_observed");
    // REPORTED, not swallowed.
    expect(outcome.lastReadError).toBe("rpc unavailable");
    expect(clock.sleeps.length).toBeGreaterThan(1);
  });

  it("recovers from a transient failure and still observes the launch", async () => {
    const clock = fakeClock();
    const { reader } = stubReader({ launched: [launchedLog()], throwsForCalls: 2 });
    const outcome = await waitForKeeperLaunch({
      client: reader,
      deployment: BASE,
      token: TOKEN,
      fromBlock: 0n,
      budgetMs: 20_000,
      pollMs: 2_000,
      clock,
    });
    expect(outcome.kind).toBe("observed");
  });

  it("clamps the poll interval into the 2-5 s band Rabby's watcher uses", async () => {
    const clock = fakeClock();
    const { reader } = stubReader({});
    await waitForKeeperLaunch({
      client: reader,
      deployment: BASE,
      token: TOKEN,
      fromBlock: 0n,
      budgetMs: 30_000,
      // Far below the floor: hammering a node every 10 ms is what the band
      // exists to prevent.
      pollMs: 10,
      clock,
    });
    expect(clock.sleeps.length).toBeGreaterThan(0);
    for (const slept of clock.sleeps) {
      expect(slept).toBeGreaterThanOrEqual(2_000);
      expect(slept).toBeLessThanOrEqual(5_000);
    }
  });

  it("never sleeps past its own deadline", async () => {
    const clock = fakeClock();
    const { reader } = stubReader({});
    const outcome = await waitForKeeperLaunch({
      client: reader,
      deployment: BASE,
      token: TOKEN,
      fromBlock: 0n,
      budgetMs: 3_000,
      pollMs: 5_000,
      clock,
    });
    expect(outcome.kind).toBe("not_observed");
    if (outcome.kind !== "not_observed") throw new Error("expected not_observed");
    // The last sleep is truncated to what is left, so a slow poll cannot hold
    // the approved signer open past the bound the handler promised.
    expect(outcome.waitedMs).toBeLessThanOrEqual(3_000);
  });

  it("defaults to a bounded wait rather than an unbounded one", () => {
    // Three minutes: the measured keeper latency was about a minute, and an
    // unbounded wait would hold the approved signer open forever.
    expect(KEEPER_WAIT_MS).toBe(180_000);
    expect(KEEPER_WAIT_MS).toBeLessThan(10 * 60_000);
  });

  it("can only READ - it has no way to send launch(), by construction", async () => {
    // The lane's central rule, asserted structurally rather than by convention:
    // the wait's client type is one filtered log read, so there is nothing here
    // that could send a transaction. The spy proves the surface is unused even
    // when a richer object is handed in.
    const clock = fakeClock();
    const writeSpy = vi.fn();
    const { reader } = stubReader({});
    const richer = { ...reader, writeContract: writeSpy, sendTransaction: writeSpy };
    await waitForKeeperLaunch({
      client: richer,
      deployment: BASE,
      token: TOKEN,
      fromBlock: 0n,
      budgetMs: 2_500,
      pollMs: 2_000,
      clock,
    });
    expect(writeSpy).not.toHaveBeenCalled();
  });
});
