/**
 * `pools.launch_execute` - THE BROADCAST HALF.
 *
 * What these tests protect is the ORDERING that keeps a user from paying for
 * something that did not happen, and the DECLINE-OVER-GUESS rule on the way
 * back:
 *
 *   - the bytes broadcast are the bytes the authorization named;
 *   - a REVERTED launch is never charged a Vex fee;
 *   - an AMBIGUOUS launch terminalizes NOTHING and tells the user not to retry;
 *   - a CONFIRMED launch whose identity cannot be PROVEN from the receipt stays
 *     pending with the decoder's own reason, writes no token, and charges no fee;
 *   - a CONFIRMED and PROVEN launch writes the identity index first, confirms the
 *     intent, and only THEN charges the fee.
 *
 * The receipt logs are REAL ENCODED EVENTS built from the verified ABIs, never
 * hand-written topics: a settlement path tested against invented logs proves
 * nothing about the logs it will actually meet.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  encodeAbiParameters,
  encodeEventTopics,
  getAddress,
  type Address,
  type Hex,
} from "viem";

import {
  PARTY_FACTORY_TOKEN_LAUNCHED_ABI,
  POOLS_GATEWAY_LAUNCH_EVENT_ABI,
} from "@tools/pools-fun/abi.js";
import { POOLS_CHAIN_ID, poolsLaunchSuite } from "@tools/pools-fun/constants.js";
import * as stagedBroadcast from "@tools/evm-chains/staged-broadcast.js";
import * as tokenRegistration from "@tools/pools-fun/evm/token-registration.js";
import * as activity from "@vex-agent/db/repos/agent-activity.js";
import * as launchedTokens from "@vex-agent/db/repos/launched-tokens.js";
import * as intents from "@vex-agent/db/repos/token-launch-intents.js";
import * as dbClient from "@vex-agent/db/client.js";
import * as lease from "@vex-agent/engine/runtime/lease-and-status.js";
import * as feeRun from "@vex-agent/tools/protocols/shared/native-fee-leg/run.js";
import * as pendingProvenance from "@vex-agent/tools/protocols/runtime/pending-provenance.js";
import * as attribution from "@vex-agent/tools/protocols/pools/handlers/launch/execute/attribute.js";
import { broadcastPoolsLaunch } from "@vex-agent/tools/protocols/pools/handlers/launch/execute/broadcast.js";
import type { PoolsLaunchPlan } from "@vex-agent/tools/protocols/pools/handlers/launch/execute/plan.js";

const SUITE = poolsLaunchSuite();
const GATEWAY = getAddress(SUITE.gateway);
const FACTORY = getAddress(SUITE.factory);
const LOCKER = getAddress(SUITE.locker);
const WALLET = getAddress("0x33eF6673BD80cB11fcC41b82Bc2181E65cC4d2fA");
const STRANGER = getAddress("0x9999999999999999999999999999999999999999");
const TOKEN = getAddress("0x01e685d39e6bf52ad0c421a4be1e092ce684e6bb");
const POOL = getAddress("0x50136d4174129585ec766eacf2f00cd1856690ca");
const WETH = getAddress("0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73");
const SALT = `0x${"7a".repeat(32)}` as Hex;
const TX_HASH = `0x${"ab".repeat(32)}` as Hex;
const CALLDATA = `0x${"cd".repeat(64)}` as Hex;
const FINGERPRINT = `0x${"ef".repeat(32)}` as Hex;
const METADATA_URI = "ipfs://bafkreifaguifkgqdrrs2cwlbjejqblrguynowkm3zb77yvq3gsydqacywm";
const ATTEST_SIGNATURE = `0x${"ab".repeat(65)}`;

const FEE_WEI = 1_051_674_002_092_832n;
const PREBUY_WEI = 10_000_000_000_000_000n;
const VALUE_WEI = FEE_WEI + PREBUY_WEI;
const DEV_BUY_OUT = 112_657_539_798_287_513_447_808n;

function concreteTopics(topics: readonly (string | readonly string[] | null)[]): string[] {
  return topics.filter((topic): topic is string => typeof topic === "string");
}

function gatewayLog(over: Partial<{ launcher: Address; feeRecipient: Address }> = {}) {
  const f = { launcher: WALLET, feeRecipient: WALLET, ...over };
  return {
    address: GATEWAY,
    topics: concreteTopics(
      encodeEventTopics({
        abi: POOLS_GATEWAY_LAUNCH_EVENT_ABI,
        eventName: "GatewayLaunch",
        args: { token: TOKEN, pool: POOL, launcher: f.launcher },
      }),
    ),
    data: encodeAbiParameters(
      [{ type: "address" }, { type: "address" }, { type: "bytes32" }, { type: "uint256" }, { type: "uint256" }],
      [WETH, f.feeRecipient, SALT, FEE_WEI, DEV_BUY_OUT],
    ),
  };
}

function factoryLog() {
  return {
    address: FACTORY,
    topics: concreteTopics(
      encodeEventTopics({
        abi: PARTY_FACTORY_TOKEN_LAUNCHED_ABI,
        eventName: "TokenLaunched",
        args: { token: TOKEN, pool: POOL, creator: GATEWAY },
      }),
    ),
    data: encodeAbiParameters(
      [{ type: "address" }, { type: "address" }, { type: "address" }, { type: "int24" }, { type: "string" }, { type: "uint256" }],
      [WETH, GATEWAY, WALLET, -197_600, METADATA_URI, DEV_BUY_OUT],
    ),
  };
}

/** A plan that has already passed the verifier - this half never re-runs it. */
function plan(): PoolsLaunchPlan {
  return {
    call: { chainId: POOLS_CHAIN_ID, to: GATEWAY, data: CALLDATA, valueWei: VALUE_WEI, fingerprint: FINGERPRINT },
    tuple: {} as never,
    feeLeg: {
      feeWei: 2_629_185_005_232n,
      netWei: VALUE_WEI,
      txParams: { to: STRANGER, data: "0x" as Hex, value: 2_629_185_005_232n },
      event: { eventRole: "pools_fee", kind: "launch", protocol: "pools" } as never,
      disclosure: {} as never,
    },
    anchors: {} as never,
    predictedPoolAddress: POOL,
    metadataUri: METADATA_URI,
    imageLanded: true,
    binding: {
      name: "Vex Flamingo",
      symbol: "VEXFLAM",
      metadataUri: METADATA_URI,
      imageUrl: "https://example.test/flamingo.png",
      imageId: "img-1",
      chainId: POOLS_CHAIN_ID,
      gateway: GATEWAY,
      pairedAsset: "weth",
      pairedAssetAddress: WETH,
      predictedTokenAddress: TOKEN,
      userSalt: SALT,
      deploymentFeeWei: FEE_WEI.toString(),
      prebuyWei: PREBUY_WEI.toString(),
      msgValueWei: VALUE_WEI.toString(),
      vexFeeWei: "2629185005232",
      gasBoundWei: "5000000000000000",
      anchorBlockNumber: "39620464",
      feeRecipient: WALLET,
      walletAddress: WALLET,
      calldata: CALLDATA,
      callFingerprint: FINGERPRINT,
      sessionId: "sess-1",
      permission: "full",
    },
  };
}

/** Ordered log of the money-path calls, so ORDER can be asserted, not just presence. */
let order: string[] = [];
let signedTxParams: { to: string; data: string; value: bigint } | null = null;
let abortedFrom: number[] = [];
let failedRows: { failureCode: string }[] = [];
let pendingReasons: string[] = [];
let confirmedIntents: string[] = [];
let failedIntents: string[] = [];
let indexedTokens: Record<string, unknown>[] = [];
let feeRuns: number;
/** What the attestation leg was handed, so its ORDER and inputs can be asserted. */
let attestPosts: Array<{ tokenAddress: string; signature: string | null; txHash: string }>;
let outcome: stagedBroadcast.StagedBroadcastOutcome;
let logs: { address: string; topics: string[]; data: string }[];

function receipt() {
  return { logs, blockNumber: 39_620_500n } as never;
}

beforeEach(() => {
  order = [];
  signedTxParams = null;
  abortedFrom = [];
  failedRows = [];
  pendingReasons = [];
  confirmedIntents = [];
  failedIntents = [];
  indexedTokens = [];
  feeRuns = 0;
  attestPosts = [];
  logs = [gatewayLog(), factoryLog()];

  // The badge leg, stubbed at its own module boundary. These tests own the
  // ORDERING contract (identity → signature → fee → POST) and the rule that the
  // launch is never affected by any of it; the leg's own gate, wire body and
  // classification are pinned in the pools-fun suite.
  vi.spyOn(attribution, "signAndStorePoolsAttestation").mockImplementation(async () => {
    order.push("attest_sign");
    return ATTEST_SIGNATURE;
  });
  vi.spyOn(attribution, "postPoolsLaunchAttribution").mockImplementation(
    async (tokenAddress, signature, txHash) => {
      order.push("attest_post");
      attestPosts.push({ tokenAddress, signature, txHash });
    },
  );
  outcome = { kind: "confirmed", txHash: TX_HASH, receipt: receipt() } as never;

  vi.spyOn(dbClient, "withTransaction").mockImplementation(
    async (fn: (client: never) => Promise<unknown>) => fn({} as never) as never,
  );
  vi.spyOn(lease, "acquireSessionControlLock").mockResolvedValue(undefined as never);

  vi.spyOn(activity, "createAgentActivityIntent").mockResolvedValue({
    executionId: 7,
    events: [{ id: 70 }, { id: 71 }],
  } as never);
  vi.spyOn(activity, "markActivityBroadcast").mockResolvedValue({ applied: true } as never);
  vi.spyOn(activity, "markBroadcastAccepted").mockResolvedValue({ applied: true } as never);
  vi.spyOn(activity, "confirmLaunchWithOutputIdentity").mockResolvedValue({ applied: true } as never);
  vi.spyOn(activity, "fillLaunchOutputIdentityOnConfirmed").mockResolvedValue(true as never);
  vi.spyOn(activity, "stampLaunchOutputIdentityByTxHash").mockResolvedValue(undefined as never);
  vi.spyOn(activity, "failActivityEvent").mockImplementation(async (_id, input) => {
    failedRows.push(input as { failureCode: string });
    return undefined as never;
  });
  vi.spyOn(activity, "abortPlannedEvents").mockImplementation(async (_execId, fromIndex) => {
    abortedFrom.push(fromIndex);
    return undefined as never;
  });
  vi.spyOn(pendingProvenance, "noteHandlerPendingReason").mockImplementation(async (_t, _id, reason) => {
    pendingReasons.push(reason);
  });

  vi.spyOn(launchedTokens, "record").mockImplementation(async (input) => {
    order.push("index");
    indexedTokens.push(input as unknown as Record<string, unknown>);
    return { inserted: true } as never;
  });
  vi.spyOn(intents, "markBroadcastPendingWith").mockResolvedValue({ intentId: "i-1" } as never);
  vi.spyOn(intents, "confirmWith").mockImplementation(async (_c, intentId) => {
    order.push("confirm_intent");
    confirmedIntents.push(intentId);
    return { intentId } as never;
  });
  vi.spyOn(intents, "failWith").mockImplementation(async (_c, intentId) => {
    failedIntents.push(intentId);
    return { intentId } as never;
  });

  vi.spyOn(tokenRegistration, "readPoolsTokenDecimals").mockResolvedValue(18);

  vi.spyOn(feeRun, "runNativeFeeLeg").mockImplementation(async () => {
    order.push("fee");
    feeRuns++;
    return { collection: "confirmed", collectionNote: "charged", txHash: "0xfee" };
  });

  vi.spyOn(stagedBroadcast, "signStageBroadcast").mockImplementation(
    async (_public, _wallet, txParams, hooks) => {
      order.push("broadcast");
      signedTxParams = txParams as { to: string; data: string; value: bigint };
      await hooks?.onHashStaged?.({ txHash: TX_HASH } as never);
      await hooks?.onAccepted?.();
      return outcome;
    },
  );
});

afterEach(() => vi.restoreAllMocks());

async function run() {
  return broadcastPoolsLaunch({
    intentId: "intent-1",
    sessionId: "sess-1",
    walletAddress: WALLET,
    plan: plan(),
    params: { name: "Vex Flamingo", symbol: "VEXFLAM" },
    publicClient: {} as never,
    walletClient: {} as never,
  });
}

describe("the bytes broadcast are the bytes that were authorized", () => {
  it("signs the plan's own call, never a rebuilt one", async () => {
    await run();
    expect(signedTxParams).toEqual({ to: GATEWAY, data: CALLDATA, value: VALUE_WEI });
  });
});

describe("a confirmed and PROVEN launch", () => {
  it("writes the identity index BEFORE confirming the intent, and charges the fee LAST", async () => {
    const result = await run();
    expect(result.success).toBe(true);
    // The whole ordering contract in one assertion: a fee that ran before the
    // launch was proven would be a charge for an unproven launch.
    //
    // The two `attest_*` steps joined this sequence with the VEX badge leg. The
    // MONEY order is unchanged - index, then intent, then fee - and the badge's
    // POST is strictly after the fee, which is the property the badge lane was
    // required to preserve.
    expect(order).toEqual([
      "broadcast",
      "index",
      "attest_sign",
      "confirm_intent",
      "fee",
      "attest_post",
    ]);
    expect(confirmedIntents).toEqual(["intent-1"]);
    expect(feeRuns).toBe(1);
  });

  it("records the launch under the pools.fun launchpad, with the PROVEN token", async () => {
    await run();
    expect(indexedTokens[0]!.launchpad).toBe("pools_fun");
    expect(indexedTokens[0]!.tokenAddress).toBe(TOKEN);
    expect(indexedTokens[0]!.chainId).toBe(POOLS_CHAIN_ID);
    // The prebuy is denominated in what was SPENT, with its decimals beside it.
    expect(indexedTokens[0]!.initialBuyRaw).toBe(PREBUY_WEI.toString());
    expect(indexedTokens[0]!.initialBuyDecimals).toBe(18);
  });

  it("reports the pool, the fee recipient and the prebuy fill the receipt PROVED", async () => {
    const result = await run();
    const data = result.data as Record<string, unknown>;
    expect(data.tokenAddress).toBe(TOKEN);
    expect(data.poolAddress).toBe(POOL);
    expect(data.feeRecipient).toBe(WALLET);
    expect(data.prebuyTokensOutRaw).toBe(DEV_BUY_OUT.toString());
    expect(data.prebuyTokensOutDecimals).toBe(18);
    expect(data.status).toBe("confirmed");
  });

  it("reports the token's decimals as NULL when they cannot be read, never as 18", async () => {
    vi.spyOn(tokenRegistration, "readPoolsTokenDecimals").mockRejectedValue(new Error("node down"));
    const result = await run();
    const data = result.data as Record<string, unknown>;
    expect(data.prebuyTokensOutDecimals).toBeNull();
    // The raw amount is unaffected - only the display is degraded.
    expect(data.prebuyTokensOutRaw).toBe(DEV_BUY_OUT.toString());
  });

  it("still reports the launch as successful when the Vex fee leg fails", async () => {
    vi.spyOn(feeRun, "runNativeFeeLeg").mockRejectedValue(new Error("fee exploded"));
    const result = await run();
    expect(result.success).toBe(true);
    expect(confirmedIntents).toEqual(["intent-1"]);
  });
});

describe("a launch that cannot be PROVEN from its receipt", () => {
  it("declines with the decoder's own reason, writes no token and charges no fee", async () => {
    // One thing wrong: the gateway event credits a stranger. Everything else in
    // the receipt is a valid launch - which is exactly the case that must not be
    // recorded as the user's token.
    logs = [gatewayLog({ launcher: STRANGER }), factoryLog()];
    outcome = { kind: "confirmed", txHash: TX_HASH, receipt: receipt() } as never;

    const result = await run();
    expect(indexedTokens).toHaveLength(0);
    expect(confirmedIntents).toHaveLength(0);
    expect(feeRuns).toBe(0);
    expect(pendingReasons).toContain("settlement_undecodable");
    const data = result.data as Record<string, unknown>;
    expect(data.status).toBe("confirmed_pending_identity");
    expect(String(data.reason).length).toBeGreaterThan(0);
    expect(result.output).toContain("DO NOT launch again");
  });

  it("declines when the receipt carries no gateway event at all", async () => {
    logs = [factoryLog()];
    outcome = { kind: "confirmed", txHash: TX_HASH, receipt: receipt() } as never;
    const result = await run();
    expect(indexedTokens).toHaveLength(0);
    expect(feeRuns).toBe(0);
    expect(String((result.data as Record<string, unknown>).reason)).toContain("GatewayLaunch");
  });
});

describe("a reverted launch", () => {
  beforeEach(() => {
    outcome = { kind: "reverted", txHash: TX_HASH, receipt: receipt() } as never;
  });

  it("fails the row, never charges the fee, and terminalizes the intent", async () => {
    const result = await run();
    expect(result.success).toBe(false);
    expect(failedRows[0]!.failureCode).toBe("mined_revert");
    expect(feeRuns).toBe(0);
    // The fee row is aborted from index 1: the launch row itself keeps its own
    // failure.
    expect(abortedFrom).toContain(1);
    expect(failedIntents).toEqual(["intent-1"]);
    expect(indexedTokens).toHaveLength(0);
  });
});

describe("an ambiguous broadcast", () => {
  beforeEach(() => {
    outcome = { kind: "ambiguous", txHash: TX_HASH, stage: "confirm" } as never;
  });

  it("terminalizes NOTHING, notes why it is pending, and tells the user not to retry", async () => {
    const result = await run();
    expect(result.success).toBe(false);
    // Nothing terminal: no failed row, no failed intent, no confirm, no fee.
    expect(failedRows).toHaveLength(0);
    expect(failedIntents).toHaveLength(0);
    expect(confirmedIntents).toHaveLength(0);
    expect(feeRuns).toBe(0);
    expect(pendingReasons).toContain("broadcast_ambiguous_confirm");
    expect(result.output).toContain("DO NOT retry");
    expect((result.data as Record<string, unknown>).status).toBe("pending");
  });
});

describe("a staging CAS miss means another executor owns this launch", () => {
  it("refuses without sending, and never reports that nothing was signed", async () => {
    vi.spyOn(intents, "markBroadcastPendingWith").mockResolvedValue(null as never);
    const result = await run();
    expect(result.success).toBe(false);
    // The transaction WAS signed locally, so the copy must not claim otherwise -
    // that is the one sentence a user would act on.
    expect(result.output).toContain("signed locally but never broadcast");
    expect(failedRows[0]!.failureCode).toBe("broadcast_error");
    expect(feeRuns).toBe(0);
  });
});

/**
 * THE VEX BADGE LEG - cosmetic, and provably unable to cost anything.
 *
 * Two properties, and they pull in opposite directions, which is why both are
 * pinned here rather than trusted to the leg's own module:
 *
 *   ORDER    the signature is produced right after the durable identity record
 *            (it can only be signed while the launch's wallet client is open),
 *            and the POST goes LAST - after the fee. A badge that sat in front
 *            of the fee leg would put an optional partner request between the
 *            user's launch and Vex's revenue.
 *   HARMLESS every way this leg can fail - a wallet that refuses, a partner
 *            that refuses, a client that throws outright - leaves a confirmed
 *            launch, a charged fee, and the same success payload.
 */
describe("the VEX badge leg is ordered last and can never cost a launch", () => {
  it("signs right after the identity record, and POSTs after the fee", async () => {
    await run();
    expect(order).toEqual([
      "broadcast",
      "index",
      "attest_sign",
      "confirm_intent",
      "fee",
      "attest_post",
    ]);
  });

  it("hands the POST the decoded token, the stored signature and the launch tx as locator", async () => {
    await run();
    expect(attestPosts).toEqual([
      { tokenAddress: TOKEN, signature: ATTEST_SIGNATURE, txHash: TX_HASH },
    ]);
  });

  it("confirms the launch when the WALLET REFUSES to sign", async () => {
    vi.mocked(attribution.signAndStorePoolsAttestation).mockImplementation(async () => {
      order.push("attest_sign");
      return null;
    });

    const result = await run();

    expect(result.success).toBe(true);
    expect((result.data as Record<string, unknown>).status).toBe("confirmed");
    expect(confirmedIntents).toEqual(["intent-1"]);
    expect(feeRuns).toBe(1);
    // The leg is still CALLED with null: refusing to send is the leg's own
    // decision, not something the broadcast path second-guesses.
    expect(attestPosts).toEqual([{ tokenAddress: TOKEN, signature: null, txHash: TX_HASH }]);
  });

  it("confirms the launch when the PARTNER REFUSES the attestation", async () => {
    // A rejection is an ordinary resolved outcome inside the leg; nothing about
    // it reaches this path. Pinned anyway, because the day it starts throwing
    // is the day a badge fails a launch.
    vi.mocked(attribution.postPoolsLaunchAttribution).mockImplementation(async () => {
      order.push("attest_post");
    });

    const result = await run();

    expect(result.success).toBe(true);
    expect((result.data as Record<string, unknown>).status).toBe("confirmed");
    expect(feeRuns).toBe(1);
  });

  it("confirms the launch when the attestation CLIENT THROWS", async () => {
    vi.mocked(attribution.postPoolsLaunchAttribution).mockRejectedValue(
      new Error("attestation exploded"),
    );

    const result = await run();

    expect(result.success).toBe(true);
    expect((result.data as Record<string, unknown>).status).toBe("confirmed");
    expect(confirmedIntents).toEqual(["intent-1"]);
    expect(feeRuns).toBe(1);
    expect(indexedTokens).toHaveLength(1);
  });

  it("confirms the launch when SIGNING THROWS outright", async () => {
    vi.mocked(attribution.signAndStorePoolsAttestation).mockRejectedValue(
      new Error("wallet locked"),
    );

    const result = await run();

    // The signing call sits inside the bookkeeping try/catch, so a throw is
    // logged as a record failure - the launch itself still succeeds and the fee
    // is still charged.
    expect(result.success).toBe(true);
    expect((result.data as Record<string, unknown>).status).toBe("confirmed");
    expect(feeRuns).toBe(1);
  });

  it("never attributes a REVERTED launch", async () => {
    outcome = { kind: "reverted", txHash: TX_HASH, receipt: receipt() };
    await run();
    expect(order).not.toContain("attest_sign");
    expect(order).not.toContain("attest_post");
  });

  it("never attributes a launch whose identity could not be PROVEN", async () => {
    logs = [factoryLog()];
    outcome = { kind: "confirmed", txHash: TX_HASH, receipt: receipt() };
    await run();
    expect(order).not.toContain("attest_sign");
    expect(order).not.toContain("attest_post");
  });
});
