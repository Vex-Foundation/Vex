/**
 * `pools.holder_rewards_claim` and `pools.holder_rewards_distribute` - the state
 * machine of a money path, walked row by row.
 *
 * WHAT THIS SUITE PROTECTS, stated as the ways a holder could be harmed:
 *
 *   1. THE TARGET IS NEVER THE PROVIDER'S. The distributor comes from the
 *      suite deployer's own event and is bound to that suite by its `token()`,
 *      `factory()` and `locker()`. A launchpad whose prepared calldata disagrees
 *      REFUSES the operation; a launchpad that is merely unreachable does not,
 *      because a third party must not be able to veto a self-custodial claim.
 *   2. NO KEY IS OPENED ON A NON-SIGNING PATH. `dryRun` and `simulateOnly` take
 *      the read-only client, and `simulateOnly` additionally writes no durable
 *      row and returns `executed: false`.
 *   3. THE ROW IS THE ONE THE VOCABULARY DEFINES. `holder_reward_claim` with
 *      output legs and NO input leg; a second output leg only when the runtime
 *      actually pays one, because `roleLegsIncomplete` would otherwise hold the
 *      row forever. `reward_distribution` with NO legs at all.
 *   4. NOTHING IS GUESSED AT SETTLEMENT. An unproven receipt leaves the row
 *      pending; an ambiguous broadcast is never terminal and never retried.
 *   5. THERE IS NO VEX FEE, and a parameter that names one is refused by name at
 *      the boundary rather than dropped.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  encodeAbiParameters,
  encodeEventTopics,
  getAddress,
  type Address,
  type Hex,
} from "viem";

import { POOLS_SUITES } from "@tools/pools-fun/constants.js";
import * as tokenRegistration from "@tools/pools-fun/evm/token-registration.js";
import * as holderRead from "@tools/pools-fun/holder-rewards/read.js";
import * as mutations from "@tools/pools-fun/holder-rewards/mutations.js";
import * as crossCheck from "@tools/pools-fun/holder-rewards/prepare-cross-check.js";
import { POOLS_REWARD_CLAIMED_DUAL_EVENT_ABI } from "@tools/pools-fun/holder-rewards/decode.js";
import * as poolsClient from "@tools/pools-fun/client.js";
import * as evmClient from "@tools/evm-chains/evm-client.js";
import * as stagedBroadcast from "@tools/evm-chains/staged-broadcast.js";
import * as activity from "@vex-agent/db/repos/agent-activity.js";
import * as pendingProvenance from "@vex-agent/tools/protocols/runtime/pending-provenance.js";
import * as signingClients from "@vex-agent/tools/protocols/shared/launch-signing-clients.js";
import * as walletResolve from "@vex-agent/tools/internal/wallet/resolve.js";
import { POOLS_HANDLERS } from "@vex-agent/tools/protocols/pools/handlers.js";
import { executeProtocolTool } from "@vex-agent/tools/protocols/runtime.js";
import type { ProtocolExecutionContext } from "@vex-agent/tools/protocols/types.js";
import { makeProtocolContext } from "../../_test-context.js";

const SUITE = POOLS_SUITES.find((s) => s.version === 3)!;
const WALLET = getAddress("0x33eF6673BD80cB11fcC41b82Bc2181E65cC4d2fA");
const TOKEN = getAddress("0x07801a668adf02e806ef8ef5a54804747afdfdf7");
const DISTRIBUTOR = getAddress("0x7b53d176E76F87D0ba5173b6e596aFEe717e6b0b");
const PAIRED = getAddress("0x4a0E65A3EcceC6dBe60AE065F2e7bb85Fae35eEa");
const DEPLOYER = getAddress(SUITE.holderRewardsDeployer!);
const TX_HASH = `0x${"cd".repeat(32)}` as Hex;
const BLOCK = 54_491_219n;

/** The live both-mode figures, so a scale mistake shows up as a wrong number. */
const TOKEN_PAYOUT = 41_781_226_920_045_611_661n;
const PAIRED_PAYOUT = 1_949_252_557_207n;

let onchain: holderRead.PoolsHolderRewardsOnChain;
let registration: tokenRegistration.PoolsLockerRegistration;
let binding: mutations.PoolsDistributorBinding;
let simulation: mutations.PoolsHolderRewardsClaimSimulation;
let distributeSimulation: mutations.PoolsRewardDistributeSimulation;
let check: crossCheck.PoolsPrepareCrossCheck;
let outcome: stagedBroadcast.StagedBroadcastOutcome;
let logs: { address: string; topics: string[]; data: string }[];
let created: Record<string, unknown>[] = [];
let confirmed: Record<string, unknown>[] = [];
let failedRows: { failureCode: string }[] = [];
let pendingReasons: string[] = [];
let signedTx: { to: string; data: string; value: bigint } | null = null;
let signerOpened = 0;

function concreteTopics(topics: readonly (string | readonly string[] | null)[]): string[] {
  return topics.filter((topic): topic is string => typeof topic === "string");
}

function claimedLog(over: { account?: Address; amount?: bigint; amountPaired?: bigint } = {}) {
  const f = { account: WALLET, amount: TOKEN_PAYOUT, amountPaired: PAIRED_PAYOUT, ...over };
  return {
    address: DISTRIBUTOR,
    topics: concreteTopics(
      encodeEventTopics({
        abi: [POOLS_REWARD_CLAIMED_DUAL_EVENT_ABI],
        eventName: "RewardClaimed",
        args: { account: f.account },
      }),
    ),
    data: encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [f.amount, f.amountPaired]),
  };
}

/**
 * The `ok` arm of the on-chain read, narrowed.
 *
 * The read's type is a five-arm union and only one arm carries the distributor
 * fields, so a spread over the union is not a type at all. Narrowing here proves
 * the fixture really is the `ok` arm instead of asserting past the question.
 */
function boundOnchain(): Extract<holderRead.PoolsHolderRewardsOnChain, { status: "ok" }> {
  if (onchain.status !== "ok") throw new Error("the test fixture is not the bound arm");
  return onchain;
}

function context(over: Partial<ProtocolExecutionContext> = {}): ProtocolExecutionContext {
  return makeProtocolContext({ sessionId: "sess-1", sessionPermission: "full", approved: true, ...over });
}

beforeEach(() => {
  created = [];
  confirmed = [];
  failedRows = [];
  pendingReasons = [];
  signedTx = null;
  signerOpened = 0;
  logs = [claimedLog()];

  registration = {
    status: "registered",
    suite: SUITE,
    launcher: WALLET,
    info: {
      pairedAssetAddress: PAIRED,
      pool: getAddress("0xfc60cf7ef2c4d50fce84bee08614109351a5f63f"),
      creator: WALLET,
      feeRecipient: WALLET,
      lockedPositionIds: [],
      feeSplitAvailable: true,
      feeSplitBps: { creator: 2000, platform: 2500, buyback: 3000, community: 2500, stockCreator: 2000, stockProtocol: 8000 },
    },
  };
  onchain = {
    status: "ok",
    blockNumber: BLOCK.toString(),
    suiteVersion: 3,
    deployer: DEPLOYER,
    distributor: DISTRIBUTOR,
    rewardMode: "both",
    rewardModeWire: 2,
    distributorSelfReportedMode: "both",
    wallet: WALLET.toLowerCase(),
    tokenLeg: { asset: TOKEN, symbol: "DRBRH", decimals: 18, earnedRaw: TOKEN_PAYOUT.toString() },
    pairedLeg: { asset: PAIRED, symbol: "SPCX", decimals: 18, earnedRaw: PAIRED_PAYOUT.toString() },
    walletExcluded: false,
    eligibleSupplyRaw: "1322257129358659407244569",
    rewardRateRaw: "1250396616857187500",
    remainingStreamRaw: "1",
    periodFinish: 1_788_600_000,
    isStockPair: false,
    distributorToken: TOKEN,
    distributorFactory: SUITE.factory,
  };
  binding = { locker: getAddress(SUITE.locker), pairedAsset: PAIRED, bountyBps: 50 };
  simulation = {
    kind: "would_pay",
    tokenAmountRaw: TOKEN_PAYOUT,
    pairedAmountRaw: PAIRED_PAYOUT,
    returnWordCount: 2,
  };
  distributeSimulation = { kind: "would_distribute", words: [1n, 2n, 3n, 4n, 5n], named: false };
  check = { status: "agrees", providerTo: DISTRIBUTOR, providerData: "0x4e71d92d" };
  outcome = { kind: "confirmed", txHash: TX_HASH, receipt: { logs, blockNumber: BLOCK } } as never;

  vi.spyOn(walletResolve, "resolveSelectedAddress").mockReturnValue(WALLET);
  vi.spyOn(tokenRegistration, "readPoolsOnChainSnapshot").mockImplementation(async () => ({
    blockNumber: BLOCK.toString(),
    locker: registration,
    decimals: { status: "ok", value: 18 },
    metadataUri: { status: "ok", value: null },
  }));
  vi.spyOn(holderRead, "readPoolsHolderRewardsOnChain").mockImplementation(async () => onchain);
  vi.spyOn(mutations, "readPoolsDistributorBinding").mockImplementation(async () => binding);
  vi.spyOn(mutations, "simulatePoolsHolderRewardsClaim").mockImplementation(async () => simulation);
  vi.spyOn(mutations, "simulatePoolsRewardDistribute").mockImplementation(async () => distributeSimulation);
  vi.spyOn(crossCheck, "crossCheckPoolsHolderRewardsPrepare").mockImplementation(async () => check);
  vi.spyOn(poolsClient, "getPoolsFunClient").mockReturnValue({
    holderRewards: async () => ({
      hasWorkToDistribute: true,
      pendingFees: { token: "1", paired: "2" },
      buybackBacklog: "3",
      lastBuybackAt: 1,
      conversion: "none",
      paysCallerBounty: false,
    }),
  } as never);
  vi.spyOn(evmClient, "getLocalPublicClient").mockReturnValue({
    estimateGas: async () => 180_000n,
  } as never);
  vi.spyOn(signingClients, "openLaunchSigningClients").mockImplementation(() => {
    signerOpened += 1;
    return {
      ok: true,
      clients: { publicClient: { estimateGas: async () => 180_000n } as never, walletClient: {} as never },
    };
  });
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
  vi.spyOn(stagedBroadcast, "signStageBroadcast").mockImplementation(async (_p, _w, tx, hooks) => {
    signedTx = tx as never;
    // The pre-sign gate is driven with the request that WOULD be serialized, so
    // a gate that only inspects the caller's inputs cannot pass this suite.
    await hooks?.onBeforeSign?.({
      to: tx.to,
      data: tx.data,
      value: tx.value ?? 0n,
      gas: 180_000n,
      nonce: 1,
      gasPrice: 1n,
      maxFeePerGas: undefined,
      maxPriorityFeePerGas: undefined,
    });
    await hooks?.onHashStaged?.({ txHash: TX_HASH } as never);
    await hooks?.onAccepted?.();
    return outcome;
  });
});

afterEach(() => vi.restoreAllMocks());

const claim = (params: Record<string, unknown>, ctx = context()) =>
  POOLS_HANDLERS["pools.holder_rewards_claim"]!(params, ctx);
const distribute = (params: Record<string, unknown>, ctx = context()) =>
  POOLS_HANDLERS["pools.holder_rewards_distribute"]!(params, ctx);

describe("the preview reads the SIMULATION and opens no key", () => {
  it("reports both legs with their asset, scale and the accrual figure beside them", async () => {
    const result = await claim({ tokenAddress: TOKEN, dryRun: true });
    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    const legs = data.wouldPay as Record<string, unknown>[];

    expect(legs).toHaveLength(2);
    expect(legs[0]).toMatchObject({ side: "token", assetAddress: TOKEN, decimals: 18 });
    expect(legs[0]!.amountRaw).toBe(TOKEN_PAYOUT.toString());
    // 18 decimals: 41781226920045611661 raw is 41.78..., not 4.17e19.
    expect(legs[0]!.amount).toBe("41.781226920045611661");
    expect(legs[1]).toMatchObject({ side: "paired", assetAddress: PAIRED });
    expect(legs[1]!.amount).toBe("0.000001949252557207");
    expect(signerOpened).toBe(0);
    expect(created).toHaveLength(0);
  });

  it("names the distributor, its mode and where that mode came from", async () => {
    const result = await claim({ tokenAddress: TOKEN, dryRun: true });
    const data = result.data as Record<string, Record<string, unknown>>;
    expect(data.distributor!.address).toBe(DISTRIBUTOR);
    expect(data.distributor!.rewardMode).toBe("both");
    expect(String(data.distributor!.rewardModeAuthority)).toContain("DistributorDeployed event");
    expect(String(data.distributor!.rewardModeAuthority)).toContain("Not the launchpad's row");
  });

  it("states that Vex takes NOTHING", async () => {
    const result = await claim({ tokenAddress: TOKEN, dryRun: true });
    const data = result.data as Record<string, unknown>;
    expect(data.vexFee).toBeNull();
    expect(String(data.vexFeeNote)).toContain("Vex charges NOTHING");
  });

  it("reports NO paired leg - absent, not zero - on a single-word runtime", async () => {
    simulation = { kind: "would_pay", tokenAmountRaw: TOKEN_PAYOUT, pairedAmountRaw: null, returnWordCount: 1 };
    const result = await claim({ tokenAddress: TOKEN, dryRun: true });
    const legs = (result.data as Record<string, unknown>).wouldPay as unknown[];
    expect(legs).toHaveLength(1);
  });

  it("says whose rewards it simulated when a different holder was asked about", async () => {
    const other = "0x329a795fd7037132a1ae0fc74b5bc3aa6458b44b";
    const result = await claim({ tokenAddress: TOKEN, dryRun: true, walletAddress: other });
    const data = result.data as Record<string, unknown>;
    expect(String(data.simulatedForAnotherHolder)).toContain(getAddress(other));
    expect(String(data.simulatedForAnotherHolder)).toContain("NOT this session's wallet");
  });
});

describe("simulateOnly runs the whole path and stops before the key", () => {
  it("returns the would-be transaction with executed: false and writes nothing", async () => {
    const result = await claim({ tokenAddress: TOKEN, simulateOnly: true });
    expect(result.success).toBe(true);
    const data = result.data as Record<string, Record<string, unknown>>;
    expect(data.executed).toBe(false);
    expect(data.claimed).toBe(false);
    expect(data.wouldSign!.to).toBe(DISTRIBUTOR);
    expect(data.wouldSign!.data).toBe("0x4e71d92d");
    expect(data.wouldSign!.value).toBe("0");
    expect(data.wouldSign!.gasLimit).toBe("360000");
    expect(signerOpened).toBe(0);
    expect(created).toHaveLength(0);
  });

  it("refuses to sign when the node will not price the claim", async () => {
    vi.spyOn(evmClient, "getLocalPublicClient").mockReturnValue({
      estimateGas: async () => { throw new Error("no"); },
    } as never);
    const result = await claim({ tokenAddress: TOKEN, simulateOnly: true });
    expect(result.success).toBe(false);
    expect(result.output).toContain("UNKNOWN");
  });

  it("refuses dryRun and simulateOnly together rather than silently preferring one", async () => {
    const result = await claim({ tokenAddress: TOKEN, dryRun: true, simulateOnly: true });
    expect(result.success).toBe(false);
    expect(result.output).toContain("Pick one");
  });

  it("stops the distribute at the same place", async () => {
    const result = await distribute({ tokenAddress: TOKEN, simulateOnly: true });
    const data = result.data as Record<string, Record<string, unknown>>;
    expect(data.executed).toBe(false);
    expect(data.wouldSign!.data).toBe("0xe4fc6b6d");
    expect(signerOpened).toBe(0);
    expect(created).toHaveLength(0);
  });
});

describe("the launchpad corroborates and can refuse, but never redirects", () => {
  it("REFUSES when the provider's calldata disagrees with ours", async () => {
    check = {
      status: "disagrees",
      differences: ["the launchpad would send this claim to 0xdead..."],
      providerTo: "0xdead00000000000000000000000000000000dead",
      providerData: "0x4e71d92d",
    };
    const result = await claim({ tokenAddress: TOKEN });
    expect(result.success).toBe(false);
    expect(result.output).toContain("does not match the transaction Vex built");
    expect(created).toHaveLength(0);
    expect(signedTx).toBeNull();
  });

  it("PROCEEDS when the provider is unreachable, and says the check is missing", async () => {
    // A third-party outage must not be able to block a self-custodial claim.
    check = { status: "unavailable", detail: "HTTP request failed" };
    const result = await claim({ tokenAddress: TOKEN, dryRun: true });
    expect(result.success).toBe(true);
    const check1 = (result.data as Record<string, Record<string, unknown>>).crossCheck!;
    expect(check1.status).toBe("unavailable");
    expect(String(check1.detail)).toContain("Nothing was learned either way");
  });

  it("PROCEEDS when the provider declines, and does not read that as agreement", async () => {
    check = { status: "declined", detail: "Nothing to claim" };
    const result = await claim({ tokenAddress: TOKEN, dryRun: true });
    const check1 = (result.data as Record<string, Record<string, unknown>>).crossCheck!;
    expect(check1.status).toBe("declined");
    expect(String(check1.detail)).toContain("not a disagreement about bytes");
  });
});

describe("a distributor that does not belong to this token's suite is refused", () => {
  it.each([
    ["token", () => { onchain = { ...boundOnchain(), distributorToken: PAIRED }; }, "token()"],
    ["factory", () => { onchain = { ...boundOnchain(), distributorFactory: PAIRED }; }, "factory()"],
    ["locker", () => { binding = { ...binding, locker: PAIRED }; }, "locker()"],
  ])("refuses when its %s names something else", async (_label, mutate, needle) => {
    mutate();
    const result = await claim({ tokenAddress: TOKEN });
    expect(result.success).toBe(false);
    expect(result.output).toContain(needle);
    expect(result.output).toContain("Nothing was signed");
    expect(created).toHaveLength(0);
  });

  it("does NOT refuse when a view simply did not answer, which differs between runtimes", async () => {
    binding = { locker: null, pairedAsset: null, bountyBps: null };
    onchain = { ...boundOnchain(), distributorFactory: null };
    const result = await claim({ tokenAddress: TOKEN, dryRun: true });
    expect(result.success).toBe(true);
  });
});

describe("the four suite outcomes are four different answers", () => {
  it("names V1 as a suite that never had holder rewards", async () => {
    onchain = { status: "suite_without_holder_rewards", suiteVersion: 1 };
    const result = await claim({ tokenAddress: TOKEN });
    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.status).toBe("unsupported_on_this_suite");
    expect(data.claimed).toBe(false);
  });

  it("reports a token that never opted in, in words rather than as zeroes", async () => {
    onchain = { status: "no_holder_rewards", blockNumber: BLOCK.toString(), suiteVersion: 3, deployer: DEPLOYER };
    const result = await claim({ tokenAddress: TOKEN });
    const data = result.data as Record<string, unknown>;
    expect(data.status).toBe("no_holder_rewards");
    expect(String(data.detail)).toContain("opted into AT LAUNCH and cannot be turned on afterwards");
  });

  it("REFUSES rather than claiming absence on the suite whose deployer registry is empty", async () => {
    // MEASURED 2026-09-04: the V2 deployer has emitted `DistributorDeployed`
    // zero times ever, while the V2 FACTORY has emitted `HolderRewardsEnabled`
    // thirteen times. An absent event on that deployer proves nothing, so
    // asserting "this token does not stream fees to holders" would be false in
    // the direction that tells a holder their rewards do not exist.
    onchain = {
      status: "no_holder_rewards",
      blockNumber: BLOCK.toString(),
      suiteVersion: 2,
      deployer: "0x2da890c5F7c17ca1c07d0D3c709F4Ca3B9F34378",
    };
    const result = await claim({ tokenAddress: TOKEN });
    expect(result.success).toBe(false);
    expect(result.output).toContain("has never emitted a DistributorDeployed event for any token");
    expect(result.output).toContain("proves nothing either way");
    expect(created).toHaveLength(0);
  });

  it("refuses an AMBIGUOUS registration rather than picking a suite", async () => {
    registration = { status: "ambiguous", detail: "two suites claim this token." } as never;
    const result = await claim({ tokenAddress: TOKEN });
    expect(result.success).toBe(false);
    expect(result.output).toContain("will not pick one suite");
  });

  it("refuses an UNREGISTERED token by name", async () => {
    registration = { status: "unregistered" } as never;
    const result = await claim({ tokenAddress: TOKEN });
    expect(result.success).toBe(false);
    expect(result.output).toContain("no pools.fun contract suite holds");
  });

  it("never reports an UNAVAILABLE read as nothing to claim", async () => {
    onchain = { status: "unavailable", detail: "the node did not answer." };
    const result = await claim({ tokenAddress: TOKEN });
    expect(result.success).toBe(false);
    expect(result.output).toContain("not a statement that there is nothing to claim");
  });
});

describe("nothing to claim is a fact, and so is exclusion", () => {
  it("signs nothing when the distributor reverts NothingToClaim", async () => {
    simulation = { kind: "nothing_to_claim", revert: "NothingToClaim" };
    const result = await claim({ tokenAddress: TOKEN });
    expect(result.success).toBe(true);
    expect((result.data as Record<string, unknown>).status).toBe("nothing_to_claim");
    expect(created).toHaveLength(0);
  });

  it("signs nothing when every leg simulates to zero", async () => {
    // The newer runtime returns zeroes rather than reverting for a wallet that
    // holds none of the token. Signing that spends gas to move nothing.
    simulation = { kind: "would_pay", tokenAmountRaw: 0n, pairedAmountRaw: 0n, returnWordCount: 2 };
    const result = await claim({ tokenAddress: TOKEN });
    expect((result.data as Record<string, unknown>).status).toBe("nothing_to_claim");
    expect(created).toHaveLength(0);
  });

  it("reports an excluded wallet as its own permanent state", async () => {
    simulation = { kind: "excluded", revert: "ExcludedAccount" };
    const result = await claim({ tokenAddress: TOKEN });
    expect((result.data as Record<string, unknown>).status).toBe("wallet_excluded");
    expect(created).toHaveLength(0);
  });

  it("never reports an unavailable simulation as nothing to claim", async () => {
    simulation = { kind: "unavailable", reason: "the node did not say why" };
    const result = await claim({ tokenAddress: TOKEN });
    expect(result.success).toBe(false);
    expect(result.output).toContain("not a statement that there is nothing to claim");
    expect(created).toHaveLength(0);
  });
});

describe("the durable row is the one the vocabulary defines", () => {
  it("writes holder_reward_claim with two output legs and NO input leg", async () => {
    await claim({ tokenAddress: TOKEN });
    const event = (created[0]!.events as Record<string, unknown>[])[0]!;
    expect(event.eventRole).toBe("holder_reward_claim");
    expect(event.kind).toBe("claim");
    expect(event.tokenIn).toBeUndefined();
    expect(event.tokenIn2).toBeUndefined();
    expect(event.vexFee).toBeUndefined();
    expect(event.tokenOut).toMatchObject({ tokenAddress: TOKEN, tokenDecimals: 18 });
    expect(event.tokenOut2).toMatchObject({ tokenAddress: PAIRED });
  });

  it("declares NO second leg when the runtime pays only one", async () => {
    // `roleLegsIncomplete` requires an executed second amount for any row that
    // names a second token, so a leg the chain will never fill would hold this
    // row incomplete forever.
    simulation = { kind: "would_pay", tokenAmountRaw: TOKEN_PAYOUT, pairedAmountRaw: null, returnWordCount: 1 };
    logs = [{
      address: DISTRIBUTOR,
      topics: concreteTopics(
        encodeEventTopics({
          abi: [POOLS_REWARD_CLAIMED_DUAL_EVENT_ABI],
          eventName: "RewardClaimed",
          args: { account: WALLET },
        }),
      ),
      data: encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [TOKEN_PAYOUT, 0n]),
    }];
    outcome = { kind: "confirmed", txHash: TX_HASH, receipt: { logs, blockNumber: BLOCK } } as never;
    await claim({ tokenAddress: TOKEN });
    const event = (created[0]!.events as Record<string, unknown>[])[0]!;
    expect(event.tokenOut2).toBeUndefined();
    expect(confirmed[0]!.executedAmountOut2Raw).toBeUndefined();
  });

  it("writes reward_distribution with NO legs on either side", async () => {
    await distribute({ tokenAddress: TOKEN });
    const event = (created[0]!.events as Record<string, unknown>[])[0]!;
    expect(event.eventRole).toBe("reward_distribution");
    expect(event.kind).toBe("claim");
    expect(event.tokenIn).toBeUndefined();
    expect(event.tokenOut).toBeUndefined();
    expect(event.tokenOut2).toBeUndefined();
    expect(event.vexFee).toBeUndefined();
    // The caller's bounty is PROVENANCE, never a leg the server's role binding
    // would refuse.
    expect(event.routeProvenance).toMatchObject({ distributor: DISTRIBUTOR, callerBountyBps: 50 });
    expect(confirmed[0]).toEqual({});
  });
});

describe("the pre-sign gate binds the bytes, not the caller's intentions", () => {
  it("signs exactly the distributor and the claim() selector, with no value", async () => {
    await claim({ tokenAddress: TOKEN });
    expect(signedTx).toMatchObject({ to: DISTRIBUTOR, data: "0x4e71d92d", value: 0n });
  });

  it("throws before the key when the request's target moved", async () => {
    vi.spyOn(stagedBroadcast, "signStageBroadcast").mockImplementation(async (_p, _w, _tx, hooks) => {
      await hooks?.onBeforeSign?.({
        to: PAIRED,
        data: "0x4e71d92d",
        value: 0n,
        gas: 1n,
        nonce: 1,
        gasPrice: 1n,
        maxFeePerGas: undefined,
        maxPriorityFeePerGas: undefined,
      });
      throw new Error("unreachable");
    });
    const result = await claim({ tokenAddress: TOKEN });
    expect(result.success).toBe(false);
    expect(result.output).toContain("refused before signing");
    expect(failedRows[0]!.failureCode).toBe("broadcast_error");
  });

  it("throws before the key when native value would be attached", async () => {
    vi.spyOn(stagedBroadcast, "signStageBroadcast").mockImplementation(async (_p, _w, tx, hooks) => {
      await hooks?.onBeforeSign?.({
        to: tx.to,
        data: tx.data,
        value: 1n,
        gas: 1n,
        nonce: 1,
        gasPrice: 1n,
        maxFeePerGas: undefined,
        maxPriorityFeePerGas: undefined,
      });
      throw new Error("unreachable");
    });
    const result = await claim({ tokenAddress: TOKEN });
    expect(result.success).toBe(false);
    expect(result.output).toContain("refused before signing");
  });
});

describe("settlement declines rather than guessing, and never retries", () => {
  it("confirms both executed legs from the receipt's own event", async () => {
    const result = await claim({ tokenAddress: TOKEN });
    expect(result.success).toBe(true);
    expect(confirmed[0]).toMatchObject({
      executedAmountOutRaw: TOKEN_PAYOUT.toString(),
      executedAmountOut2Raw: PAIRED_PAYOUT.toString(),
    });
    expect((result.data as Record<string, unknown>).status).toBe("confirmed");
  });

  it("leaves the row pending when the receipt does not prove OUR payout", async () => {
    logs = [claimedLog({ account: getAddress("0x329a795fd7037132a1ae0fc74b5bc3aa6458b44b") })];
    outcome = { kind: "confirmed", txHash: TX_HASH, receipt: { logs, blockNumber: BLOCK } } as never;
    const result = await claim({ tokenAddress: TOKEN });
    expect(result.success).toBe(true);
    expect((result.data as Record<string, unknown>).status).toBe("confirmed_pending_amounts");
    expect(pendingReasons).toContain("settlement_undecodable");
    expect(confirmed).toHaveLength(0);
  });

  it("keeps an ambiguous broadcast non-terminal and tells the agent not to retry", async () => {
    outcome = { kind: "ambiguous", txHash: TX_HASH } as never;
    const result = await claim({ tokenAddress: TOKEN });
    expect(result.success).toBe(false);
    expect(result.output).toContain("DO NOT retry");
    expect((result.data as Record<string, unknown>).status).toBe("pending");
    expect(failedRows).toHaveLength(0);
    expect(pendingReasons).toContain("broadcast_ambiguous_confirm");
  });

  it("names the distributor's own revert on a mined failure", async () => {
    outcome = { kind: "reverted", txHash: TX_HASH, receipt: { logs: [], blockNumber: BLOCK } } as never;
    simulation = { kind: "nothing_to_claim", revert: "NothingToClaim" };
    // The preview arm would have stopped on this simulation, so drive the revert
    // path directly: the simulation is re-read only AFTER the receipt.
    let calls = 0;
    vi.spyOn(mutations, "simulatePoolsHolderRewardsClaim").mockImplementation(async () => {
      calls += 1;
      return calls === 1
        ? { kind: "would_pay", tokenAmountRaw: TOKEN_PAYOUT, pairedAmountRaw: PAIRED_PAYOUT, returnWordCount: 2 }
        : { kind: "nothing_to_claim", revert: "NothingToClaim" };
    });
    const result = await claim({ tokenAddress: TOKEN });
    expect(result.success).toBe(false);
    expect(result.output).toContain("NothingToClaim()");
    expect(failedRows[0]!.failureCode).toBe("mined_revert");
  });

  it("reports a leg the preview promised and the receipt paid zero on", async () => {
    logs = [claimedLog({ amountPaired: 0n })];
    outcome = { kind: "confirmed", txHash: TX_HASH, receipt: { logs, blockNumber: BLOCK } } as never;
    const result = await claim({ tokenAddress: TOKEN });
    const data = result.data as Record<string, unknown>;
    expect(data.status).toBe("confirmed");
    expect((data.settlementDiscrepancy as string[])[0]).toContain("receipt shows 0");
    expect(String(data.settlementDiscrepancyNote)).toContain("The receipt is the truth");
  });

  it("calls a proven 0/0 claim a success rather than a broken tool", async () => {
    logs = [claimedLog({ amount: 0n, amountPaired: 0n })];
    outcome = { kind: "confirmed", txHash: TX_HASH, receipt: { logs, blockNumber: BLOCK } } as never;
    const result = await claim({ tokenAddress: TOKEN });
    expect(result.success).toBe(true);
    expect((result.data as Record<string, unknown>).paidNothing).toBe(true);
  });
});

describe("the distribute is honest about whose money moves", () => {
  it("states the bounty rule from the CHAIN, not from the launchpad's echo", async () => {
    const result = await distribute({ tokenAddress: TOKEN, dryRun: true });
    const data = result.data as Record<string, Record<string, unknown>>;
    expect(String(data.bountyRule)).toContain("CALLER_BOUNTY_BPS() is 50");
    expect(String(data.bountyRule)).toContain("out of the BUYBACK");
    // The launchpad said false on this very distributor. It is shown, and named
    // as an echo, rather than believed.
    expect(data.api!.paysCallerBounty).toBe(false);
    expect(String(data.api!.note)).toContain("the on-chain constant above is the authority");
  });

  it("says the caller is paid nothing on a runtime with no bounty at all", async () => {
    binding = { ...binding, bountyBps: null };
    const result = await distribute({ tokenAddress: TOKEN, dryRun: true });
    expect(String((result.data as Record<string, unknown>).bountyRule))
      .toContain("no CALLER_BOUNTY_BPS() at all, so calling distribute() pays the caller NOTHING");
  });

  it("signs nothing when the distributor has no work", async () => {
    distributeSimulation = { kind: "nothing_to_distribute", revert: "NothingToDistribute" };
    const result = await distribute({ tokenAddress: TOKEN });
    expect(result.success).toBe(true);
    expect((result.data as Record<string, unknown>).status).toBe("nothing_to_distribute");
    expect(created).toHaveLength(0);
  });

  it("refuses to label the five-word return whose members are unestablished", async () => {
    const result = await distribute({ tokenAddress: TOKEN, dryRun: true });
    const would = (result.data as Record<string, Record<string, unknown>>).wouldDistribute!;
    expect(would.wordsUnnamed).toHaveLength(5);
    expect(would.feesTokenRaw).toBeUndefined();
    expect(String(would.note)).toContain("meanings are NOT established");
  });

  it("reports an absent bounty as absent, and a declared one as declared", async () => {
    outcome = { kind: "confirmed", txHash: TX_HASH, receipt: { logs: [], blockNumber: BLOCK } } as never;
    const noBounty = await distribute({ tokenAddress: TOKEN });
    const noData = (noBounty.data as Record<string, Record<string, unknown>>).callerBounty!;
    expect(noData.amountRaw).toBeNull();
    expect(String(noData.detail)).toContain("ordinary outcome");
  });

  it("explains that a mined revert is usually another caller winning the race", async () => {
    outcome = { kind: "reverted", txHash: TX_HASH, receipt: { logs: [], blockNumber: BLOCK } } as never;
    const result = await distribute({ tokenAddress: TOKEN });
    expect(result.output).toContain("permissionless race");
  });
});

describe("money-naming parameters are refused BY NAME at the boundary", () => {
  const CONTEXT = context();
  it.each([
    ["recipient", "0x33eF6673BD80cB11fcC41b82Bc2181E65cC4d2fA"],
    ["to", "0x33eF6673BD80cB11fcC41b82Bc2181E65cC4d2fA"],
    ["distributor", "0x33eF6673BD80cB11fcC41b82Bc2181E65cC4d2fA"],
    ["feeRecipient", "0x33eF6673BD80cB11fcC41b82Bc2181E65cC4d2fA"],
    ["vexFee", "1"],
    ["claimFor", "0x33eF6673BD80cB11fcC41b82Bc2181E65cC4d2fA"],
  ])("rejects %s before the handler runs, naming the key", async (key, value) => {
    // Through the REAL dispatcher: `validateProtocolParams` reads the manifest's
    // `rejectedParams`, so an explanation that lived only in a handler would be
    // unreachable in production.
    const result = await executeProtocolTool(
      { toolId: "pools.holder_rewards_claim", params: { tokenAddress: TOKEN, [key]: value } },
      CONTEXT,
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain(`"${key}"`);
  });

  it("explains that there is no fee for a fee recipient to receive", async () => {
    const result = await executeProtocolTool(
      { toolId: "pools.holder_rewards_claim", params: { tokenAddress: TOKEN, feeRecipient: WALLET } },
      CONTEXT,
    );
    expect(result.output).toContain("Vex charges nothing here");
  });

  it("refuses walletAddress on a REAL claim, with the address that would be paid", async () => {
    const result = await claim({
      tokenAddress: TOKEN,
      walletAddress: "0x329a795fd7037132a1ae0fc74b5bc3aa6458b44b",
    });
    expect(result.success).toBe(false);
    expect(result.output).toContain("pays whoever signs");
    expect(result.output).toContain(WALLET);
    expect(created).toHaveLength(0);
  });
});
