/**
 * The launch broadcast's ORDER and UNITS — the four money-path invariants that
 * cost the user something when they break.
 *
 *   1. CAS MISS STOPS THE BROADCAST. `markBroadcastPendingWith` returning
 *      `null` means someone else owns this intent; its return used to be
 *      dropped on the floor, so a losing racer signed and sent anyway. The hook
 *      runs BEFORE `sendRawTransaction`, so throwing there aborts with nothing
 *      sent (`staged-broadcast.ts:68-75`).
 *   2. THE DURABLE INDEX IS WRITTEN BEFORE THE INTENT IS CONFIRMED. Confirming
 *      first and crashing leaves a `confirmed` launch with no `launched_tokens`
 *      row and nothing to recover it — the repair sweep only sees
 *      `broadcast_pending` (`launch-identity-repair.ts:126`).
 *   3. `initial_buy_*` IS THE AUTHORIZED NATIVE PREBUY (wei, 18 decimals), the
 *      amount SPENT — not the token units received. The decoded tokens-out is
 *      the activity row's executed OUTPUT leg.
 *   4. FEE LAST, AND NEVER FOR AN UNPROVEN LAUNCH. An undecodable identity
 *      leaves the intent pending, settles the planned fee row, and signs
 *      nothing.
 */

import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { encodeAbiParameters, encodeEventTopics, getAddress, type Address, type Hex } from "viem";

import { TRENCH_DIAMOND_ABI } from "@tools/trench-express/abi.js";
import { TRENCH_CHAIN_ID, TRENCH_DIAMOND_ADDRESS } from "@tools/trench-express/constants.js";
import type { StagedBroadcastOutcome } from "@tools/evm-chains/staged-broadcast.js";
import type { LaunchPlan } from "@vex-agent/tools/protocols/trench/handlers/launch/plan.js";
import type { ValidatedLaunchRequest } from "@vex-agent/tools/protocols/trench/handlers/launch/validate.js";

const DIAMOND = getAddress(TRENCH_DIAMOND_ADDRESS);
const WALLET = getAddress("0x33eF6673BD80cB11fcC41b82Bc2181E65cC4d2fA");
const TOKEN = getAddress("0x58659Ef9Be57216632BFD341FC57736a429EFB91");
const NATIVE = "0x0000000000000000000000000000000000000000" as Address;
const TREASURY = "0x00000000000000000000000000000000000feee5" as Address;

const CREATION_FEE = 1_000_000_000_000_000n;
const PREBUY = 300_000_000_000_000n;
const MSG_VALUE = CREATION_FEE + PREBUY;
const VEX_FEE = (MSG_VALUE * 25n) / 10_000n;
const TOKENS_OUT = 197_913_781_308_210_736_292_461n;

/** Every durable write, in the order it happened. */
let calls: string[];
let outcome: StagedBroadcastOutcome;
let casResult: unknown;
let mockRecord: Mock;
let mockConfirmIntent: Mock;
let mockConfirmActivity: Mock;
let mockAbort: Mock;
let mockRunFee: Mock;
let mockFailActivity: Mock;
let mockConfirmLaunch: Mock;
let mockStampIdentity: Mock;
let mockFillIdentity: Mock;
let sentTransactions: number;

function reset(): void {
  calls = [];
  sentTransactions = 0;
  casResult = { intentId: "intent-1" };
  outcome = confirmedOutcome();
  mockRecord = vi.fn(async (input: unknown) => { calls.push("launched_tokens.record"); return { inserted: true, input }; });
  mockConfirmIntent = vi.fn(async () => { calls.push("intent.confirm"); return { intentId: "intent-1" }; });
  mockConfirmActivity = vi.fn(async () => { calls.push("activity.confirm"); return { applied: true, row: {} }; });
  mockAbort = vi.fn(async (_id: number, from: number) => { calls.push(`activity.abort:${from}`); });
  mockFailActivity = vi.fn(async () => { calls.push("activity.fail"); return { applied: true, row: {} }; });
  mockConfirmLaunch = vi.fn(async () => { calls.push("activity.confirm"); return { applied: true, row: {} }; });
  mockStampIdentity = vi.fn(async () => { calls.push("activity.stamp_identity"); return true; });
  mockFillIdentity = vi.fn(async () => { calls.push("activity.fill_identity"); return true; });
  mockRunFee = vi.fn(async () => { calls.push("fee.run"); return { collection: "confirmed", txHash: "0xfee" }; });
}
reset();

vi.mock("@tools/evm-chains/staged-broadcast.js", () => ({
  signStageBroadcast: async (
    _p: unknown,
    _w: unknown,
    _tx: unknown,
    hooks: { onHashStaged: (h: unknown) => Promise<void>; onAccepted: () => Promise<void> },
  ) => {
    await hooks.onHashStaged({ txHash: "0xlaunchhash", fromAddress: WALLET, nonce: 1 });
    sentTransactions++;
    await hooks.onAccepted();
    return outcome;
  },
}));
vi.mock("@vex-agent/db/client.js", () => ({
  withTransaction: async (fn: (c: unknown) => Promise<unknown>) => fn({}),
}));
vi.mock("@vex-agent/engine/runtime/lease-and-status.js", () => ({
  acquireSessionControlLock: async () => undefined,
}));
vi.mock("@vex-agent/db/repos/token-launch-intents.js", () => ({
  markBroadcastPendingWith: async () => { calls.push("intent.broadcast_pending"); return casResult; },
  confirmWith: (...a: unknown[]) => mockConfirmIntent(...a),
  failWith: async () => { calls.push("intent.fail"); return { intentId: "intent-1" }; },
  consumeIfAuthorizedWith: async () => ({ intentId: "intent-1" }),
  createWith: async () => ({ intentId: "intent-1" }),
}));
vi.mock("@vex-agent/db/repos/launched-tokens.js", () => ({
  record: (...a: unknown[]) => mockRecord(...a),
}));
vi.mock("@vex-agent/db/repos/agent-activity.js", () => ({
  createAgentActivityIntent: async (input: { events: Array<{ eventRole: string }> }) => {
    calls.push("activity.intent");
    return { executionId: 7, events: input.events.map((_e, i) => ({ id: 100 + i })) };
  },
  markActivityBroadcast: async () => ({ applied: true, row: {} }),
  markBroadcastAccepted: async () => ({ applied: true, row: {} }),
  confirmActivityEvent: (...a: unknown[]) => mockConfirmActivity(...a),
  failActivityEvent: (...a: unknown[]) => mockFailActivity(...a),
  confirmLaunchWithOutputIdentity: (...a: unknown[]) => mockConfirmLaunch(...a),
  stampLaunchOutputIdentityByTxHash: (...a: unknown[]) => mockStampIdentity(...a),
  fillLaunchOutputIdentityOnConfirmed: (...a: unknown[]) => mockFillIdentity(...a),
  abortPlannedEvents: (...a: unknown[]) => mockAbort(...a),
}));
vi.mock("@tools/trench-express/evm/curve-reader.js", async (orig) => ({
  ...(await (orig as () => Promise<Record<string, unknown>>)()),
  readTokenDecimals: async () => 18,
}));

const { broadcastLaunch } = await import(
  "@vex-agent/tools/protocols/trench/handlers/launch/execute/broadcast.js"
);

function tokenCreatedLog(): { address: string; topics: string[]; data: string } {
  const [topic0] = encodeEventTopics({ abi: TRENCH_DIAMOND_ABI, eventName: "TokenCreated" }) as [Hex];
  return {
    address: DIAMOND,
    topics: [topic0],
    data: encodeAbiParameters(
      [
        { type: "address" }, { type: "address" }, { type: "uint8" },
        { type: "uint8" }, { type: "bytes" }, { type: "uint256" },
      ],
      [TOKEN, WALLET, 0, 0, "0x", 1n],
    ),
  };
}

function boughtLog(): { address: string; topics: string[]; data: string } {
  const [topic0] = encodeEventTopics({ abi: TRENCH_DIAMOND_ABI, eventName: "Bought" }) as [Hex];
  return {
    address: DIAMOND,
    topics: [topic0],
    data: encodeAbiParameters(
      [{ type: "address" }, { type: "address" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }],
      [WALLET, TOKEN, 297_000_000_000_000n, TOKENS_OUT, 2_501_584_250n],
    ),
  };
}

function confirmedOutcome(logs: Array<{ address: string; topics: string[]; data: string }> = []): StagedBroadcastOutcome {
  return {
    kind: "confirmed",
    txHash: "0xlaunchhash",
    receipt: { status: "success", blockNumber: 1000n, logs },
  } as never;
}

const REQUEST: ValidatedLaunchRequest = {
  name: "Vex x Trench",
  symbol: "VEXTE",
  description: "a launch",
  links: ["https://vex.example"],
  imageId: "img_01",
  prebuyWei: PREBUY,
};

function plan(withFee = true): LaunchPlan {
  return {
    calldata: "0xdeadbeef",
    txParams: { to: DIAMOND, data: "0xdeadbeef", value: MSG_VALUE },
    binding: {
      creationFeeWei: CREATION_FEE.toString(),
      prebuyWei: PREBUY.toString(),
      anchorBlockNumber: "999",
      imageId: "img_01",
      imageDigest: "0xdigest",
      callFingerprint: "0xfingerprint",
    },
    feeLeg: withFee
      ? ({
        feeWei: VEX_FEE,
        netWei: MSG_VALUE - VEX_FEE,
        txParams: { to: TREASURY, data: "0x", value: VEX_FEE },
        event: { eventRole: "vex_fee", kind: "launch" },
      } as never)
      : null,
    preview: {} as never,
  } as never;
}

function input(over: Record<string, unknown> = {}) {
  return {
    intentId: "intent-1",
    sessionId: "sess-1",
    walletAddress: WALLET,
    plan: plan(),
    request: REQUEST,
    params: {},
    publicClient: {} as never,
    walletClient: {} as never,
    deps: { planFeeLeg: () => null, runFeeLeg: (...a: unknown[]) => mockRunFee(...a) },
    ...over,
  } as never;
}

beforeEach(() => { reset(); });

describe("a CAS miss on the intent stops the broadcast", () => {
  it("does not send when markBroadcastPendingWith returns null — someone else owns this intent", async () => {
    casResult = null;
    const result = await broadcastLaunch(input());

    expect(sentTransactions).toBe(0);
    expect(result.success).toBe(false);
    // No fee leg ever ran for a launch that was never broadcast.
    expect(mockRunFee).not.toHaveBeenCalled();
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it("says SIGNED LOCALLY BUT NEVER BROADCAST — signing already happened", async () => {
    casResult = null;
    const result = await broadcastLaunch(input());
    // `signStageBroadcast` signs BEFORE `onHashStaged` runs. Claiming "nothing
    // was signed" tells the user a signed transaction does not exist when one
    // does — with a consumed nonce.
    expect(result.output).toContain("signed locally but never broadcast");
    expect(result.output).not.toContain("Nothing was signed");
  });

  it("terminalizes the hash-staged activity row — abortPlannedEvents cannot reach it", async () => {
    casResult = null;
    await broadcastLaunch(input());
    // `abortPlannedEvents` only finalizes rows with `tx_hash IS NULL`
    // (`swap-lifecycle.ts`), and this row already carries the staged hash. Left
    // alone it stays `pending` forever and the repair sweep chases a hash that
    // was never sent.
    expect(mockFailActivity).toHaveBeenCalledTimes(1);
    expect(mockFailActivity.mock.calls[0]![0]).toBe(100);
    // `failure_code` is a closed, SQL-lockstepped enum, so the specific name
    // is carried in the reason rather than as an invented code.
    expect(mockFailActivity.mock.calls[0]![1]).toMatchObject({
      failureCode: "broadcast_error",
    });
    expect(mockFailActivity.mock.calls[0]![1].failureReason).toContain("SignedNotBroadcast:cas_miss");
  });
});

describe("the confirmed path writes the durable index BEFORE confirming the intent", () => {
  beforeEach(() => { outcome = confirmedOutcome([tokenCreatedLog(), boughtLog()]); });

  // ORDER UPDATED (round 3): the intent confirm is LAST. The sweep claims only
  // `broadcast_pending` rows, so confirming the intent BEFORE the activity row
  // is finalized opens a crash window nothing can ever close — the intent is no
  // longer a candidate and the activity row stays pending forever. Every write
  // that the sweep cannot redo must happen while the intent is still claimable.
  it("orders launched_tokens.record → activity.confirm → intent.confirm (LAST) → fee", async () => {
    await broadcastLaunch(input());
    expect(calls.filter((c) => c !== "intent.broadcast_pending" && c !== "activity.intent")).toEqual([
      "launched_tokens.record",
      "activity.confirm",
      "intent.confirm",
      "fee.run",
    ]);
  });

  it("stores the AUTHORIZED NATIVE PREBUY in initial_buy_*, never the token units received", async () => {
    await broadcastLaunch(input());
    expect(mockRecord).toHaveBeenCalledTimes(1);
    expect(mockRecord.mock.calls[0]![0]).toMatchObject({
      chainId: TRENCH_CHAIN_ID,
      tokenAddress: TOKEN,
      createTxHash: "0xlaunchhash",
      initialBuyRaw: PREBUY.toString(),
      initialBuyDecimals: 18,
      initialBuyTokenAddress: NATIVE,
    });
    expect(mockRecord.mock.calls[0]![0]).not.toMatchObject({ initialBuyRaw: TOKENS_OUT.toString() });
  });

  it("writes the output IDENTITY and amount atomically at confirm", async () => {
    await broadcastLaunch(input());
    // Not `confirmActivityEvent`: that updates amounts only, leaving
    // `token_out_address` NULL forever — and the app's token history matches on
    // exactly that column, so the launch never appears in its own token's
    // history. The launch-specific finalizer writes both in one UPDATE.
    expect(mockConfirmActivity).not.toHaveBeenCalled();
    expect(mockConfirmLaunch).toHaveBeenCalledTimes(1);
    expect(mockConfirmLaunch.mock.calls[0]![1]).toMatchObject({
      executedAmountInRaw: MSG_VALUE.toString(),
      executedAmountOutRaw: TOKENS_OUT.toString(),
      tokenOutAddress: TOKEN,
      tokenOutSymbol: "VEXTE",
      tokenOutDecimals: 18,
    });
  });

  it("records nothing in initial_buy_* when there was no prebuy, and reports zero tokens out", async () => {
    outcome = confirmedOutcome([tokenCreatedLog()]);
    await broadcastLaunch(input({ request: { ...REQUEST, prebuyWei: 0n } }));
    expect(mockRecord.mock.calls[0]![0]).toMatchObject({
      initialBuyRaw: null,
      initialBuyDecimals: null,
      initialBuyTokenAddress: null,
    });
    expect(mockConfirmLaunch.mock.calls[0]![1]).toMatchObject({ executedAmountOutRaw: "0" });
  });
});

describe("an undecodable identity is pending, never charged, and never terminal", () => {
  it("settles the planned fee row, signs no fee, and does not confirm the intent", async () => {
    outcome = confirmedOutcome([]); // confirmed on-chain, but no decodable TokenCreated

    const result = await broadcastLaunch(input());

    expect(result.success).toBe(true);
    expect((result.data as { status: string }).status).toBe("confirmed_pending_identity");
    expect(mockRunFee).not.toHaveBeenCalled();
    expect(mockConfirmIntent).not.toHaveBeenCalled();
    expect(mockRecord).not.toHaveBeenCalled();
    // The planned fee row is settled rather than left pending forever.
    expect(mockAbort).toHaveBeenCalledWith(7, 1, expect.stringContaining("identity"));
  });
});

describe("a proven launch whose prebuy amount cannot be decoded", () => {
  it("keeps the activity row pending rather than confirming it with an invented amount", async () => {
    outcome = confirmedOutcome([tokenCreatedLog()]); // prebuy expected, but no Bought event

    const result = await broadcastLaunch(input());

    expect(result.success).toBe(true);
    // Identity is proven, so the durable records ARE written.
    expect(mockRecord).toHaveBeenCalledTimes(1);
    expect(mockConfirmIntent).toHaveBeenCalledTimes(1);
    // But no amount is invented for the executed output leg.
    expect(mockConfirmLaunch).not.toHaveBeenCalled();
  });

  it("still stamps WHICH TOKEN it created onto the pending activity row", async () => {
    outcome = confirmedOutcome([tokenCreatedLog()]);
    await broadcastLaunch(input());
    // The identity is proven even though the amount is not. Leaving
    // `token_out_address` NULL would hide the launch from its own token's
    // history for as long as the amount stays unproven — which may be forever.
    expect(mockStampIdentity).toHaveBeenCalledWith("0xlaunchhash", TOKEN);
    // And it happens BEFORE the intent leaves the sweep's claimable set.
    expect(calls.indexOf("activity.stamp_identity")).toBeLessThan(calls.indexOf("intent.confirm"));
  });
});

describe("a reverted launch is never charged a fee", () => {
  it("fails the row, aborts the fee leg, and settles the intent", async () => {
    outcome = { kind: "reverted", txHash: "0xlaunchhash", receipt: { status: "reverted" } } as never;
    const result = await broadcastLaunch(input());
    expect(result.success).toBe(false);
    expect(mockRunFee).not.toHaveBeenCalled();
    expect(mockAbort).toHaveBeenCalledWith(7, 1, expect.any(String));
  });
});

/**
 * THE SWEEP-BEATS-FINALIZER RACE.
 *
 * The generic status-only repair confirms a pending activity row from its hash
 * after ~90s (`sync/agent-activity-repair.ts`). If it wins, the launch's own
 * finalizer — a CAS on `status = 'pending'` — MISSES, and the decoded identity
 * and amounts are lost permanently: no sweep ever revisits a `confirmed` row,
 * and the launch is invisible in its own token's history.
 *
 * The miss is benign and recoverable, so it gets a guarded fill-in rather than
 * a failure. What is NOT acceptable is ignoring the miss and confirming the
 * intent anyway — that closes the last window in which anything could have
 * repaired the row.
 */
describe("when the status-only sweep confirms the activity row first", () => {
  beforeEach(() => { outcome = confirmedOutcome([tokenCreatedLog(), boughtLog()]); });

  it("falls back to the fill-in writer and still lands the identity", async () => {
    mockConfirmLaunch.mockImplementation(async () => { calls.push("activity.confirm"); return { applied: false, row: {} }; });

    await broadcastLaunch(input());

    expect(mockFillIdentity).toHaveBeenCalledTimes(1);
    expect(mockFillIdentity.mock.calls[0]![1]).toMatchObject({
      executedAmountOutRaw: TOKENS_OUT.toString(),
      tokenOutAddress: TOKEN,
    });
    // And the intent still confirms — AFTER the identity landed.
    expect(calls.indexOf("activity.fill_identity")).toBeLessThan(calls.indexOf("intent.confirm"));
  });

  it("does NOT confirm the intent when neither writer could land the identity", async () => {
    mockConfirmLaunch.mockImplementation(async () => { calls.push("activity.confirm"); return { applied: false, row: {} }; });
    mockFillIdentity.mockImplementation(async () => { calls.push("activity.fill_identity"); return false; });

    const result = await broadcastLaunch(input());

    // Confirming here would remove the intent from the sweep's claimable set
    // with the identity still unwritten and nothing left to repair it.
    expect(mockConfirmIntent).not.toHaveBeenCalled();
    // The launch DID happen, so it is not reported as a failure.
    expect(result.success).toBe(true);
  });
});
