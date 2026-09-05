/**
 * `pools.claim_fees` - the preview that must not lie, and the claim that must
 * not guess.
 *
 * Three properties are worth a suite here:
 *
 *   1. THE PREVIEW USES THE SIMULATION, not the locker's `claimable*` mappings.
 *      Measured live, those mappings read 0/0 while a simulation returned a real
 *      paired amount, so a preview built on them would tell a user their fees
 *      are gone. The mappings still appear, under an "already collected" label.
 *   2. BOTH LEGS TRAVEL WITH THEIR ASSET AND SCALE. USDG is 6 decimals and the
 *      launched token is 18; a swapped or scale-less pair is a millionfold
 *      error.
 *   3. THE CLAIM DECLINES RATHER THAN GUESSING. A simulation that cannot run is
 *      never reported as "nothing to claim", and a confirmed receipt whose
 *      `Claimed` event cannot be proven leaves the row pending with the
 *      decoder's reason instead of recording the simulation as a settlement.
 *
 * The receipt logs are REAL ENCODED events from the verified ABI.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  encodeAbiParameters,
  encodeEventTopics,
  getAddress,
  type Address,
  type Hex,
} from "viem";

import { PARTY_LOCKER_CLAIMED_EVENT_ABI } from "@tools/pools-fun/abi.js";
import { POOLS_SUITES } from "@tools/pools-fun/constants.js";
import * as readClaim from "@tools/pools-fun/claim/read-claim.js";
import * as tokenRegistration from "@tools/pools-fun/evm/token-registration.js";
import * as evmClient from "@tools/evm-chains/evm-client.js";
import * as stagedBroadcast from "@tools/evm-chains/staged-broadcast.js";
import * as activity from "@vex-agent/db/repos/agent-activity.js";
import * as pendingProvenance from "@vex-agent/tools/protocols/runtime/pending-provenance.js";
import * as signingClients from "@vex-agent/tools/protocols/shared/launch-signing-clients.js";
import * as walletResolve from "@vex-agent/tools/internal/wallet/resolve.js";
import { POOLS_HANDLERS } from "@vex-agent/tools/protocols/pools/handlers.js";
import type { ProtocolExecutionContext } from "@vex-agent/tools/protocols/types.js";
import { makeProtocolContext } from "../../_test-context.js";

const SUITE = POOLS_SUITES.find((s) => s.version === 1)!;
const LOCKER = getAddress(SUITE.locker);
const WALLET = getAddress("0x33eF6673BD80cB11fcC41b82Bc2181E65cC4d2fA");
const TOKEN = getAddress("0x01e685d39e6bf52ad0c421a4be1e092ce684e6bb");
const POOL = getAddress("0x50136d4174129585ec766eacf2f00cd1856690ca");
const USDG = getAddress("0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168");
const TX_HASH = `0x${"ab".repeat(32)}` as Hex;
const BLOCK = 39_620_464n;

/** The measured live shape: mappings at zero, simulation paying a real amount. */
const PAID_PAIRED = 599_999_999_999n;

function concreteTopics(topics: readonly (string | readonly string[] | null)[]): string[] {
  return topics.filter((topic): topic is string => typeof topic === "string");
}

function claimedLog(over: Partial<{ account: Address; tokenAmount: bigint; pairedAmount: bigint }> = {}) {
  const f = { account: WALLET, tokenAmount: 0n, pairedAmount: PAID_PAIRED, ...over };
  return {
    address: LOCKER,
    topics: concreteTopics(
      encodeEventTopics({
        abi: PARTY_LOCKER_CLAIMED_EVENT_ABI,
        eventName: "Claimed",
        args: { token: TOKEN, account: f.account },
      }),
    ),
    data: encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [f.tokenAmount, f.pairedAmount]),
  };
}

let simulation: readClaim.PoolsClaimSimulation;
let contextResult: readClaim.ReadPoolsClaimContextResult;
let outcome: stagedBroadcast.StagedBroadcastOutcome;
let created: Record<string, unknown>[] = [];
let confirmed: Record<string, unknown>[] = [];
let failedRows: { failureCode: string }[] = [];
let pendingReasons: string[] = [];
let logs: { address: string; topics: string[]; data: string }[];
let registration: tokenRegistration.PoolsLockerRegistration;

function context(over: Partial<ProtocolExecutionContext> = {}): ProtocolExecutionContext {
  return makeProtocolContext({ sessionId: "sess-1", sessionPermission: "full", approved: true, ...over });
}

beforeEach(() => {
  created = [];
  confirmed = [];
  failedRows = [];
  pendingReasons = [];
  logs = [claimedLog()];
  simulation = { kind: "would_pay", tokenAmountRaw: 0n, pairedAmountRaw: PAID_PAIRED };
  contextResult = {
    ok: true,
    context: {
      blockNumber: BLOCK,
      suite: SUITE,
      pairedAsset: USDG,
      poolAddress: POOL,
      feeRecipient: WALLET,
      tokenDecimals: 18,
      pairedDecimals: 6,
      alreadyCollected: {
        token: { assetAddress: TOKEN, amountRaw: 0n, decimals: 18 },
        paired: { assetAddress: USDG, amountRaw: 0n, decimals: 6 },
      },
    },
  };
  outcome = { kind: "confirmed", txHash: TX_HASH, receipt: { logs, blockNumber: BLOCK } } as never;

  vi.spyOn(walletResolve, "resolveSelectedAddress").mockReturnValue(WALLET);
  // WHICH SUITE HOLDS THE TOKEN is now the handler's first question, and its
  // four outcomes are the four ways a claim can be refused before any locker is
  // addressed. Defaulted to a clean V1 registration here; the refusal cases
  // below override it.
  registration = {
    status: "registered",
    suite: SUITE,
    launcher: WALLET,
    info: {
      pairedAssetAddress: USDG,
      pool: POOL,
      creator: WALLET,
      feeRecipient: WALLET,
      lockedPositionIds: [],
      feeSplitAvailable: true,
      feeSplitBps: { creator: 2000, platform: 2500, buyback: 3000, community: 2500, stockCreator: 2000, stockProtocol: 8000 },
    },
  };
  vi.spyOn(tokenRegistration, "readPoolsOnChainSnapshot").mockImplementation(async () => ({
    blockNumber: BLOCK.toString(),
    locker: registration,
    decimals: { status: "ok", value: 18 },
    metadataUri: { status: "ok", value: null },
  }));
  vi.spyOn(readClaim, "readPoolsClaimContext").mockImplementation(async () => contextResult);
  vi.spyOn(readClaim, "simulatePoolsClaim").mockImplementation(async () => simulation);
  vi.spyOn(evmClient, "getLocalPublicClient").mockReturnValue({
    estimateGas: async () => 180_000n,
  } as never);
  vi.spyOn(signingClients, "openLaunchSigningClients").mockImplementation(() => ({
    ok: true,
    clients: { publicClient: { estimateGas: async () => 180_000n } as never, walletClient: {} as never },
  }));
  vi.spyOn(activity, "createAgentActivityIntent").mockImplementation(async (input) => {
    created.push(input as unknown as Record<string, unknown>);
    return { executionId: 9, events: [{ id: 90 }] } as never;
  });
  vi.spyOn(activity, "markActivityBroadcast").mockResolvedValue({ applied: true } as never);
  vi.spyOn(activity, "markBroadcastAccepted").mockResolvedValue({ applied: true } as never);
  vi.spyOn(activity, "confirmActivityEvent").mockImplementation(async (_id, input) => {
    confirmed.push(input as unknown as Record<string, unknown>);
    return { applied: true } as never;
  });
  vi.spyOn(activity, "failActivityEvent").mockImplementation(async (_id, input) => {
    failedRows.push(input as { failureCode: string });
    return undefined as never;
  });
  vi.spyOn(pendingProvenance, "noteHandlerPendingReason").mockImplementation(async (_t, _id, reason) => {
    pendingReasons.push(reason);
  });
  vi.spyOn(stagedBroadcast, "signStageBroadcast").mockImplementation(async (_p, _w, _tx, hooks) => {
    await hooks?.onHashStaged?.({ txHash: TX_HASH } as never);
    await hooks?.onAccepted?.();
    return outcome;
  });
});

afterEach(() => vi.restoreAllMocks());

async function claim(params: Record<string, unknown>, ctx = context()) {
  return POOLS_HANDLERS["pools.claim_fees"]!(params, ctx);
}

describe("dryRun previews from the SIMULATION, never from the mappings", () => {
  it("reports both legs with their asset and decimals, and signs nothing", async () => {
    const result = await claim({ token: TOKEN, dryRun: true });
    expect(result.success).toBe(true);
    const data = result.data as Record<string, Record<string, Record<string, unknown>>>;

    expect(data.claimable!.tokenLeg!.assetAddress).toBe(TOKEN);
    expect(data.claimable!.tokenLeg!.decimals).toBe(18);
    expect(data.claimable!.pairedLeg!.assetAddress).toBe(USDG);
    expect(data.claimable!.pairedLeg!.amountRaw).toBe(PAID_PAIRED.toString());
    // USDG is 6 decimals: 599999999999 raw is 599999.999999, not 5.99e-7.
    expect(data.claimable!.pairedLeg!.decimals).toBe(6);
    expect(data.claimable!.pairedLeg!.human).toBe("599999.999999");
    expect(created).toHaveLength(0);
  });

  it("shows the mappings ONLY under an already-collected label", async () => {
    const result = await claim({ token: TOKEN, dryRun: true });
    const data = result.data as Record<string, Record<string, unknown>>;
    // The mappings are 0/0 while the simulation pays - the exact live case.
    expect((data.alreadyCollected!.pairedLeg as Record<string, unknown>).amountRaw).toBe("0");
    expect(String(data.alreadyCollected!.note)).toContain("not what a claim would pay");
    expect(String(data.note)).toContain("NOT a claimable total");
  });

  it("never opens a signing wallet for a preview", async () => {
    await claim({ token: TOKEN, dryRun: true });
    expect(signingClients.openLaunchSigningClients).not.toHaveBeenCalled();
  });
});

describe("a simulation that cannot run is not 'nothing to claim'", () => {
  it("refuses and says so explicitly", async () => {
    simulation = { kind: "unavailable", reason: "HTTP request failed" };
    const result = await claim({ token: TOKEN, dryRun: true });
    expect(result.success).toBe(false);
    expect(result.output).toContain("not a statement that there is nothing to claim");
  });

  it("reports the locker's own NothingToClaim as a fact, and signs nothing", async () => {
    simulation = { kind: "nothing_to_claim", revert: "NothingToClaim" };
    const result = await claim({ token: TOKEN });
    expect(result.success).toBe(true);
    expect(result.output).toContain("nothing to claim");
    expect(created).toHaveLength(0);
  });
});

describe("a real claim writes ONE row with TWO output legs", () => {
  it("plans both legs, with no input leg at all", async () => {
    await claim({ token: TOKEN });
    const event = (created[0]!.events as Record<string, unknown>[])[0]!;
    expect(event.eventRole).toBe("pools_claim");
    // ITS OWN KIND: a payout filed under `launch` would land inside every
    // launch feed, filter and count (owner decision 2026-08-19).
    expect(event.kind).toBe("claim");
    expect((event.tokenOut as Record<string, unknown>).tokenAddress).toBe(TOKEN);
    expect((event.tokenOut2 as Record<string, unknown>).tokenAddress).toBe(USDG);
    expect((event.tokenOut2 as Record<string, unknown>).tokenDecimals).toBe(6);
    // A claim spends nothing; an input leg would be evidence of a bad decode.
    expect(event.tokenIn).toBeUndefined();
    expect(event.tokenIn2).toBeUndefined();
  });

  it("confirms with BOTH executed amounts, taken from the receipt's own event", async () => {
    const result = await claim({ token: TOKEN });
    expect(result.success).toBe(true);
    expect(confirmed[0]!.executedAmountOutRaw).toBe("0");
    expect(confirmed[0]!.executedAmountOut2Raw).toBe(PAID_PAIRED.toString());
    const data = result.data as Record<string, unknown>;
    expect(data.status).toBe("confirmed");
    expect(data.txHash).toBe(TX_HASH);
  });

  it("treats a proven 0/0 payout as a SUCCESS, not a failure", async () => {
    logs = [claimedLog({ tokenAmount: 0n, pairedAmount: 0n })];
    outcome = { kind: "confirmed", txHash: TX_HASH, receipt: { logs, blockNumber: BLOCK } } as never;
    const result = await claim({ token: TOKEN });
    expect(result.success).toBe(true);
    expect((result.data as Record<string, unknown>).paidNothing).toBe(true);
  });
});

describe("the claim declines rather than guessing on the way back", () => {
  it("leaves the row pending, with the decoder's reason, when the payout is unproven", async () => {
    // The receipt confirmed but credits somebody else - the amounts this wallet
    // received are not established, and the simulation must not stand in.
    logs = [claimedLog({ account: getAddress("0x9999999999999999999999999999999999999999") })];
    outcome = { kind: "confirmed", txHash: TX_HASH, receipt: { logs, blockNumber: BLOCK } } as never;

    const result = await claim({ token: TOKEN });
    expect(confirmed).toHaveLength(0);
    expect(pendingReasons).toContain("settlement_undecodable");
    expect(result.output).toContain("DO NOT");
    expect((result.data as Record<string, unknown>).status).toBe("confirmed_pending_amounts");
  });

  it("terminalizes nothing on an ambiguous broadcast and tells the user not to retry", async () => {
    outcome = { kind: "ambiguous", txHash: TX_HASH, stage: "confirm" } as never;
    const result = await claim({ token: TOKEN });
    expect(result.success).toBe(false);
    expect(failedRows).toHaveLength(0);
    expect(confirmed).toHaveLength(0);
    expect(pendingReasons).toContain("broadcast_ambiguous_confirm");
    expect(result.output).toContain("DO NOT retry");
  });

  it("fails the row on a mined revert", async () => {
    outcome = { kind: "reverted", txHash: TX_HASH, receipt: { logs: [], blockNumber: BLOCK } } as never;
    const result = await claim({ token: TOKEN });
    expect(result.success).toBe(false);
    expect(failedRows[0]!.failureCode).toBe("mined_revert");
    expect(confirmed).toHaveLength(0);
  });

  it("refuses a token the locker never registered, before anything is signed", async () => {
    contextResult = { ok: false, reason: "0x… is not registered with the pools.fun locker" };
    const result = await claim({ token: TOKEN });
    expect(result.success).toBe(false);
    expect(result.output).toContain("not registered");
    expect(created).toHaveLength(0);
  });

  it("needs an ADDRESS, and says why a symbol will not do", async () => {
    const result = await claim({ token: "VEXFLAM" });
    expect(result.success).toBe(false);
    expect(result.output).toContain("not unique");
  });
});
