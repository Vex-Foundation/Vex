/**
 * The DESKTOP two-stage launch: prepare -> deploy, and everything that must not
 * be deployable.
 *
 * The verified fingerprint lives in PROCESS MEMORY, and the four properties that
 * makes safe are the four this suite asserts as behaviour rather than as
 * comments: it EXPIRES, it is SINGLE USE, it is SESSION-KEYED, and CANCEL drops
 * it. Each of them is the difference between a form click and a second launch.
 *
 * The plan builder is stubbed here on purpose. What stage 1 proves is covered by
 * the verifier and authorization suites; what THIS file is about is the handle:
 * who may redeem it, how often, and for how long.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { getAddress, type Address, type Hex } from "viem";

import { POOLS_CHAIN_ID, poolsLaunchSuite } from "@tools/pools-fun/constants.js";
import * as planModule from "@vex-agent/tools/protocols/pools/handlers/launch/execute/plan.js";
import * as authorizeModule from "@vex-agent/tools/protocols/pools/handlers/launch/execute/authorize.js";
import * as broadcastModule from "@vex-agent/tools/protocols/pools/handlers/launch/execute/broadcast.js";
import * as signingClients from "@vex-agent/tools/protocols/shared/launch-signing-clients.js";
import {
  preparedLaunchCount,
  resetPreparedLaunches,
} from "@vex-agent/tools/protocols/pools/launch/fingerprint-store.js";
import {
  cancelPoolsLaunch,
  deployPoolsLaunch,
  preparePoolsLaunch,
} from "@vex-agent/tools/protocols/pools/launch.js";
import type { PoolsLaunchInputs } from "@vex-agent/tools/protocols/pools/launch/runtime-contract.js";

const GATEWAY = getAddress(poolsLaunchSuite().gateway);
const WALLET = getAddress("0x33eF6673BD80cB11fcC41b82Bc2181E65cC4d2fA");
const OTHER_WALLET = getAddress("0x9999999999999999999999999999999999999999");
const TOKEN = getAddress("0x01e685d39e6bf52ad0c421a4be1e092ce684e6bb");
const POOL = getAddress("0x50136d4174129585ec766eacf2f00cd1856690ca");
const WETH = getAddress("0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73");
const SALT = `0x${"7a".repeat(32)}` as Hex;
const CALLDATA = `0x${"cd".repeat(64)}` as Hex;
const FINGERPRINT = `0x${"ef".repeat(32)}` as Hex;
const TX_HASH = `0x${"ab".repeat(32)}` as Hex;
const METADATA_URI = "ipfs://meta";

const SESSION = { sessionId: "sess-1", walletAddress: WALLET };
const OTHER_SESSION = { sessionId: "sess-2", walletAddress: WALLET };

const INPUTS: PoolsLaunchInputs = {
  name: "Vex Flamingo",
  symbol: "VEXFLAM",
  pairedAsset: "weth",
  image: { kind: "locker", imageId: "img-1" },
  prebuy: { amountHuman: "0.01" },
  feeRecipient: { kind: "session_wallet" },
};

/**
 * A decoded launch tuple with NO signed price quote - the WETH shape.
 *
 * All-zero is a real value here rather than an absence: the gateway takes the
 * attestation struct by value, so a pair that needs no signed quote carries six
 * zeroes and an empty signature. The fingerprint window reads these fields to
 * decide how long a prepared launch may sit (a signed quote lives for seconds,
 * not minutes), so a fixture that omitted them would exercise a different code
 * path from every real launch.
 */
function launchTuple(
  over: Partial<planModule.PoolsLaunchPlan["tuple"]> = {},
): planModule.PoolsLaunchPlan["tuple"] {
  return {
    name: "Vex Flamingo",
    symbol: "VEXFLAM",
    metadataUri: METADATA_URI,
    userSalt: SALT,
    pairedAsset: WETH,
    expectedStartTick: -207_240,
    // Twenty minutes out, so the gateway's own deadline is never the tightest
    // clock in a test that is not about deadlines.
    deadline: BigInt(Math.floor(Date.now() / 1000) + 20 * 60),
    feeRecipient: WALLET,
    nativeDevBuyAmount: 10_000_000_000_000_000n,
    erc20DevBuyAmountIn: 0n,
    devBuyMinOut: 1n,
    expectedFeeWei: 1_051_674_002_092_832n,
    priceAttestation: {
      asset: WETH,
      underlyingPriceUsdE18: 0n,
      expectedUiMultiplier: 0n,
      observedAt: 0n,
      expiresAt: 0n,
      pricingEpoch: 0n,
    },
    priceSignature: "0x" as Hex,
    ...over,
  };
}

function plan(): planModule.PoolsLaunchPlan {
  return {
    call: { chainId: POOLS_CHAIN_ID, to: GATEWAY, data: CALLDATA, valueWei: 1_061_674_002_092_832n, fingerprint: FINGERPRINT },
    tuple: launchTuple(),
    feeLeg: null,
    anchors: {} as never,
    predictedPoolAddress: POOL,
    metadataUri: METADATA_URI,
    imageLanded: true,
    gas: { limit: 0n, priceWei: 0n, boundWei: 0n },
    simulateOnly: false,
    binding: {
      name: "Vex Flamingo",
      symbol: "VEXFLAM",
      metadataUri: METADATA_URI,
      imageUrl: "https://example.test/f.png",
      imageId: "img-1",
      chainId: POOLS_CHAIN_ID,
      gateway: GATEWAY,
      pairedAsset: "weth",
      pairedAssetAddress: WETH,
      predictedTokenAddress: TOKEN,
      userSalt: SALT,
      deploymentFeeWei: "1051674002092832",
      prebuyWei: "10000000000000000",
      msgValueWei: "1061674002092832",
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

let authorizeCalls: { kind: string; intentId: string }[] = [];
let broadcastCalls: number;
let signerAddress: Address;

beforeEach(() => {
  resetPreparedLaunches();
  authorizeCalls = [];
  broadcastCalls = 0;
  signerAddress = WALLET;

  vi.spyOn(signingClients, "openLaunchSigningClients").mockImplementation(() => ({
    ok: true,
    clients: {
      publicClient: {} as never,
      walletClient: { account: { address: signerAddress } } as never,
    },
  }));
  vi.spyOn(planModule, "buildPoolsLaunchPlan").mockImplementation(async () => ({
    ok: true,
    plan: plan(),
  }));
  vi.spyOn(authorizeModule, "authorizeAndConsumePoolsLaunch").mockImplementation(async (input) => {
    authorizeCalls.push({ kind: input.authorizationKind, intentId: input.intentId });
    return { ok: true };
  });
  vi.spyOn(broadcastModule, "broadcastPoolsLaunch").mockImplementation(async () => {
    broadcastCalls++;
    return {
      success: true,
      output: "launched",
      data: {
        status: "confirmed",
        txHash: TX_HASH,
        tokenAddress: TOKEN,
        poolAddress: POOL,
        _executionId: 42,
      },
    };
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  resetPreparedLaunches();
});

async function prepared() {
  const result = await preparePoolsLaunch(SESSION, INPUTS);
  if (!result.ok) throw new Error(`prepare refused: ${result.refusal.message}`);
  return result.value;
}

describe("stage 1 hands back a handle and nothing else", () => {
  it("returns the FINAL token address, the resolved recipient and every cost leg with its decimals", async () => {
    const value = await prepared();
    expect(value.predictedTokenAddress).toBe(TOKEN);
    expect(value.resolvedFeeRecipient).toBe(WALLET);
    expect(value.costs.transactionValue.rawWei).toBe("1061674002092832");
    expect(value.costs.transactionValue.decimals).toBe(18);
    expect(value.costs.gasBound.rawWei).toBe("5000000000000000");
    // Stage 1 authorizes nothing and signs nothing.
    expect(authorizeCalls).toHaveLength(0);
    expect(broadcastCalls).toBe(0);
  });

  it("accepts an X handle on the MANUAL path and shows the address it resolved to", async () => {
    // The user is the verifier here: what stage 1 displays is decoded from the
    // very bytes Deploy will consume, so confirming the address IS confirming
    // the transaction. Vex never claims to have verified the handle mapping.
    const resolved = getAddress("0x1234567890123456789012345678901234567890");
    vi.spyOn(planModule, "buildPoolsLaunchPlan").mockImplementation(async (input) => {
      const built = plan();
      expect(input.feeRecipient).toEqual({ kind: "x_username", username: "vex" });
      return {
        ok: true,
        plan: { ...built, binding: { ...built.binding, feeRecipient: resolved } },
      };
    });
    const result = await preparePoolsLaunch(SESSION, {
      ...INPUTS,
      feeRecipient: { kind: "x_username", username: "@vex" },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.resolvedFeeRecipient).toBe(resolved);
  });

  it("refuses an ETH first buy on a non-WETH pair, the way the gateway would", async () => {
    const result = await preparePoolsLaunch(SESSION, { ...INPUTS, pairedAsset: "usdg" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.kind).toBe("invalid_inputs");
    expect(result.refusal.message).toContain("WETH");
  });

  it("refuses when the wallet that would sign is not the one this launch is for", async () => {
    signerAddress = OTHER_WALLET;
    const result = await preparePoolsLaunch(SESSION, INPUTS);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.kind).toBe("wallet_unavailable");
  });
});

describe("stage 2 redeems the handle exactly once", () => {
  it("authorizes as user_submit - the form IS the approval - and broadcasts", async () => {
    const { fingerprintId } = await prepared();
    const result = await deployPoolsLaunch(SESSION, { fingerprintId });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.tokenAddress).toBe(TOKEN);
    expect(result.value.txHash).toBe(TX_HASH);
    expect(result.value.activityId).toBe(42);
    expect(authorizeCalls).toEqual([{ kind: "user_submit", intentId: authorizeCalls[0]!.intentId }]);
    expect(broadcastCalls).toBe(1);
  });

  it("refuses a SECOND deploy of the same handle - two clicks are not two launches", async () => {
    const { fingerprintId } = await prepared();
    await deployPoolsLaunch(SESSION, { fingerprintId });
    const second = await deployPoolsLaunch(SESSION, { fingerprintId });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.refusal.kind).toBe("fingerprint_expired");
    expect(broadcastCalls).toBe(1);
    expect(authorizeCalls).toHaveLength(1);
  });

  it("refuses another SESSION's handle, with the same answer a miss gets", async () => {
    const { fingerprintId } = await prepared();
    const result = await deployPoolsLaunch(OTHER_SESSION, { fingerprintId });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // Identical to the not-found refusal on purpose: a distinct reply would
    // confirm that another session's prepared launch exists.
    expect(result.refusal.kind).toBe("fingerprint_expired");
    expect(broadcastCalls).toBe(0);
    // And it is still redeemable by its owner - a stranger's attempt must not
    // consume it either.
    const owner = await deployPoolsLaunch(SESSION, { fingerprintId });
    expect(owner.ok).toBe(true);
  });

  it("refuses an EXPIRED handle and leaves nothing behind", async () => {
    vi.useFakeTimers();
    try {
      const { fingerprintId } = await prepared();
      expect(preparedLaunchCount()).toBe(1);
      // Past the fingerprint window: the quote is stale, and the deployment fee
      // it names moves.
      vi.advanceTimersByTime(11 * 60 * 1000);
      const result = await deployPoolsLaunch(SESSION, { fingerprintId });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.refusal.kind).toBe("fingerprint_expired");
      expect(broadcastCalls).toBe(0);
      // Swept, not merely refused: the store cannot grow without bound.
      expect(preparedLaunchCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses to sign when the wallet changed between prepare and Deploy", async () => {
    const { fingerprintId } = await prepared();
    signerAddress = OTHER_WALLET;
    const result = await deployPoolsLaunch(SESSION, { fingerprintId });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.kind).toBe("wallet_unavailable");
    expect(authorizeCalls).toHaveLength(0);
    expect(broadcastCalls).toBe(0);
  });

  it("reports a pending launch as a refusal that says it is recorded, not as a success", async () => {
    vi.spyOn(broadcastModule, "broadcastPoolsLaunch").mockResolvedValue({
      success: false,
      output: "could not be confirmed yet - DO NOT retry",
      data: { status: "pending", txHash: TX_HASH, _executionId: 42 },
    });
    const { fingerprintId } = await prepared();
    const result = await deployPoolsLaunch(SESSION, { fingerprintId });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.message).toContain("DO NOT retry");
    expect(result.refusal.message).toContain("resolves automatically");
  });
});

describe("cancel drops the handle", () => {
  it("makes a later Deploy click find nothing", async () => {
    const { fingerprintId } = await prepared();
    const cancelled = await cancelPoolsLaunch(SESSION, { fingerprintId });
    expect(cancelled.ok && cancelled.value.cancelled).toBe(true);
    expect(preparedLaunchCount()).toBe(0);

    const result = await deployPoolsLaunch(SESSION, { fingerprintId });
    expect(result.ok).toBe(false);
    expect(broadcastCalls).toBe(0);
  });

  it("cannot cancel another session's prepared launch", async () => {
    const { fingerprintId } = await prepared();
    const cancelled = await cancelPoolsLaunch(OTHER_SESSION, { fingerprintId });
    expect(cancelled.ok && cancelled.value.cancelled).toBe(false);
    expect(preparedLaunchCount()).toBe(1);
  });
});

/**
 * THE HOLDERS SHAPE, end to end through the desktop lane.
 *
 * A fees-to-holders launch is the one case where the address that was SIGNED and
 * the address the fees actually reach are different, by construction: the tuple
 * carries the gateway's `FEES_TO_HOLDERS*` sentinel and the gateway resolves it
 * to the distributor it deploys inside the same transaction. Both halves of the
 * lane have to respect that - the confirmation screen must not present a
 * sentinel as somebody's wallet, and the deployed result must report the address
 * the receipt proved rather than the constant that was signed.
 */
describe("a fees-to-holders launch names the sentinel before, and the distributor after", () => {
  /** `gateway.FEES_TO_HOLDERS_BOTH()`, measured on the V3 gateway 2026-09-04. */
  const SENTINEL_BOTH = getAddress("0x968b0c1e896fb1ddb2042957fc0614c67ab7ffc4");
  const DISTRIBUTOR = getAddress("0xbcD65C71dff8c71B199013dc9E5eAEBf86A4fF73");

  function holdersPlan(): planModule.PoolsLaunchPlan {
    const base = plan();
    return {
      ...base,
      tuple: launchTuple({ feeRecipient: SENTINEL_BOTH }),
      binding: {
        ...base.binding,
        feeRecipient: SENTINEL_BOTH,
        holderRewards: { mode: "both", sentinel: SENTINEL_BOTH },
      },
    };
  }

  it("stage 1 hands the confirmation the MODE and the sentinel, not a wallet", async () => {
    vi.spyOn(planModule, "buildPoolsLaunchPlan").mockResolvedValue({ ok: true, plan: holdersPlan() });
    const prepared = await preparePoolsLaunch(SESSION, {
      ...INPUTS,
      feeRecipient: { kind: "holders", mode: "both" },
    });
    if (!prepared.ok) throw new Error(`stage 1 refused: ${prepared.refusal.message}`);
    expect(prepared.value.holderRewards).toEqual({ mode: "both", sentinel: SENTINEL_BOTH });
    // The sentinel IS what the calldata carries, so it is reported as the
    // resolved recipient of the signed bytes - and the screen renders the mode
    // beside it rather than presenting it as a wallet.
    expect(prepared.value.resolvedFeeRecipient).toBe(SENTINEL_BOTH);
  });

  it("stage 2 reports the DISTRIBUTOR the receipt proved, never the sentinel that was signed", async () => {
    vi.spyOn(planModule, "buildPoolsLaunchPlan").mockResolvedValue({ ok: true, plan: holdersPlan() });
    vi.spyOn(broadcastModule, "broadcastPoolsLaunch").mockResolvedValue({
      success: true,
      output: "launched",
      data: {
        status: "confirmed",
        txHash: TX_HASH,
        tokenAddress: TOKEN,
        poolAddress: POOL,
        // What the gateway actually emitted, after resolving the sentinel.
        feeRecipient: DISTRIBUTOR,
        _executionId: 9,
      },
    });
    const prepared = await preparePoolsLaunch(SESSION, {
      ...INPUTS,
      feeRecipient: { kind: "holders", mode: "both" },
    });
    if (!prepared.ok) throw new Error(`stage 1 refused: ${prepared.refusal.message}`);
    const deployed = await deployPoolsLaunch(SESSION, { fingerprintId: prepared.value.fingerprintId });
    if (!deployed.ok) throw new Error(`deploy refused: ${deployed.refusal.message}`);
    expect(deployed.value.resolvedFeeRecipient).toBe(DISTRIBUTOR);
    expect(deployed.value.resolvedFeeRecipient).not.toBe(SENTINEL_BOTH);
  });
});
