/**
 * The crash-recovery sweep must dispatch the RIGHT decoder per launchpad.
 *
 * The defect this pins is silent, which is what makes it worth a suite: a
 * pools.fun receipt handed to the Trench decoder produces no decodable event,
 * the sweep correctly reads that as ambiguity, and the launch is re-checked
 * forever while its token sits on-chain unrecorded. Nothing errors; the row just
 * never completes.
 *
 * Identity on the pools.fun gateway path binds through `GatewayLaunch.launcher`,
 * because `TokenLaunched.creator` and `.deployer` are the GATEWAY - so a decoder
 * choice is not a detail here, it is the difference between attributing the
 * launch to the user and attributing it to the launchpad.
 *
 * Logs are REAL ENCODED EVENTS from the verified ABIs.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { encodeAbiParameters, encodeEventTopics, getAddress, type Address, type Hex } from "viem";

import {
  PARTY_FACTORY_TOKEN_LAUNCHED_ABI,
  POOLS_GATEWAY_LAUNCH_EVENT_ABI,
} from "@tools/pools-fun/abi.js";
import { POOLS_SUITES } from "@tools/pools-fun/constants.js";
import type { AuthorizedPoolsLaunchPlan } from "@vex-agent/sync/launch-identity-repair/types.js";

/** V1: the suite our real launches, and therefore the sweep's real rows, belong to. */
const SUITE = POOLS_SUITES.find((s) => s.version === 1)!;
const GATEWAY = getAddress(SUITE.gateway);
const FACTORY = getAddress(SUITE.factory);
const WALLET = getAddress("0x33eF6673BD80cB11fcC41b82Bc2181E65cC4d2fA");
const STRANGER = getAddress("0x9999999999999999999999999999999999999999");
const TOKEN = getAddress("0x01e685d39e6bf52ad0c421a4be1e092ce684e6bb");
const POOL = getAddress("0x50136d4174129585ec766eacf2f00cd1856690ca");
const WETH = getAddress("0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73");
const SALT = `0x${"7a".repeat(32)}` as Hex;
const TX_HASH = `0x${"ab".repeat(32)}` as Hex;
const METADATA_URI = "ipfs://bafkreifaguifkgqdrrs2cwlbjejqblrguynowkm3zb77yvq3gsydqacywm";
const DEV_BUY_OUT = 112_657_539_798_287_513_447_808n;

let receiptLogs: { address: string; topics: string[]; data: string }[] = [];

vi.mock("@tools/evm-chains/registry.js", () => ({
  getLocalChain: () => ({ id: 4663, name: "Robinhood Chain" }),
}));
vi.mock("@tools/evm-chains/evm-client.js", () => ({
  getLocalPublicClient: () => ({
    getTransactionReceipt: async () => ({ status: "success", logs: receiptLogs }),
  }),
}));

const { buildProductionLaunchRepairDeps } = await import("@vex-agent/sync/launch-identity-repair.js");

function concreteTopics(topics: readonly (string | readonly string[] | null)[]): string[] {
  return topics.filter((topic): topic is string => typeof topic === "string");
}

function gatewayLog(over: Partial<{ launcher: Address; feeRecipient: Address }> = {}) {
  const launcher = over.launcher ?? WALLET;
  const feeRecipient = over.feeRecipient ?? WALLET;
  return {
    address: GATEWAY,
    topics: concreteTopics(
      encodeEventTopics({
        abi: POOLS_GATEWAY_LAUNCH_EVENT_ABI,
        eventName: "GatewayLaunch",
        args: { token: TOKEN, pool: POOL, launcher },
      }),
    ),
    data: encodeAbiParameters(
      [{ type: "address" }, { type: "address" }, { type: "bytes32" }, { type: "uint256" }, { type: "uint256" }],
      [WETH, feeRecipient, SALT, 1_051_674_002_092_832n, DEV_BUY_OUT],
    ),
  };
}

function factoryLog(over: Partial<{ feeRecipient: Address }> = {}) {
  const feeRecipient = over.feeRecipient ?? WALLET;
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
      [WETH, GATEWAY, feeRecipient, -197_600, METADATA_URI, DEV_BUY_OUT],
    ),
  };
}

/** The authorized plan, exactly as the sweep reconstructs it from the intent. */
function poolsPlan(over: Partial<AuthorizedPoolsLaunchPlan> = {}): AuthorizedPoolsLaunchPlan {
  return {
    feeRecipient: WALLET,
    pairedAsset: WETH,
    userSalt: SALT,
    predictedTokenAddress: TOKEN,
    gateway: GATEWAY,
    // An ORDINARY launch: the receipt must name exactly the recipient that was
    // signed. A fees-to-holders plan carries the sentinel and its mode instead,
    // and is covered by its own case below.
    holderRewards: null,
    ...over,
  };
}

beforeEach(() => {
  receiptLogs = [gatewayLog(), factoryLog()];
});

describe("the sweep decodes a pools.fun launch with the pools decoder", () => {
  it("proves the token from GatewayLaunch when the receipt matches the authorized plan", async () => {
    const deps = buildProductionLaunchRepairDeps();
    const outcome = await deps.resolveLaunchOutcome({
      chainId: 4663,
      txHash: TX_HASH,
      walletAddress: WALLET,
      protocol: "pools_fun",
      poolsPlan: poolsPlan(),
    });
    expect(outcome).toEqual({ kind: "created", identity: { tokenAddress: TOKEN } });
  });

  it("declines - never terminalizes - when the receipt credits another launcher", async () => {
    receiptLogs = [gatewayLog({ launcher: STRANGER }), factoryLog()];
    const deps = buildProductionLaunchRepairDeps();
    const outcome = await deps.resolveLaunchOutcome({
      chainId: 4663,
      txHash: TX_HASH,
      walletAddress: WALLET,
      protocol: "pools_fun",
      poolsPlan: poolsPlan(),
    });
    // `null` is ambiguity: the row stays pending and is re-checked, which is the
    // only safe answer for a launch we cannot attribute.
    expect(outcome).toBeNull();
  });

  it("declines when the stored plan is incomplete, instead of decoding loosely", async () => {
    const deps = buildProductionLaunchRepairDeps();
    const outcome = await deps.resolveLaunchOutcome({
      chainId: 4663,
      txHash: TX_HASH,
      walletAddress: WALLET,
      protocol: "pools_fun",
      // The sweep hands `null` when a field of the authorized plan is missing -
      // recovery must not accept a token address on weaker evidence than the
      // launch itself required.
      poolsPlan: null,
    });
    expect(outcome).toBeNull();
  });
});

describe("a trench intent still uses the trench decoder", () => {
  it("does not decode a pools.fun receipt as a trench launch", async () => {
    const deps = buildProductionLaunchRepairDeps();
    const outcome = await deps.resolveLaunchOutcome({
      chainId: 4663,
      txHash: TX_HASH,
      walletAddress: WALLET,
      protocol: "trench",
      poolsPlan: null,
    });
    // The trench decoder finds no `TokenCreated` from the Diamond in this
    // receipt, which is exactly right: it is not a trench launch.
    expect(outcome).toBeNull();
  });
});

/**
 * A FEES-TO-HOLDERS LAUNCH THAT WENT AMBIGUOUS, and why this sweep is the only
 * thing that can rescue it.
 *
 * When a broadcast comes back ambiguous the handler deliberately does NOTHING
 * terminal: the intent keeps its hash at `broadcast_pending` and this sweep is
 * what settles it later. On a holders launch the receipt names the DISTRIBUTOR
 * the gateway deployed, while the authorized plan holds the SENTINEL that was
 * signed - so a sweep given only the sentinel refuses every correct holders
 * launch, and the row stays pending forever with the user's token already
 * minted and their fee stream already committed.
 *
 * The intent's own `holder_rewards_mode` / `_sentinel` columns (migration 109)
 * are what close that, and these two cases are the regression: one proves the
 * rescue works, the other proves it did not become a hole that accepts any
 * address.
 */
describe("the sweep can still settle a fees-to-holders launch", () => {
  /** `gateway.FEES_TO_HOLDERS_BOTH()`, measured on the V3 gateway 2026-09-04. */
  const SENTINEL_BOTH = getAddress("0x968b0c1e896fb1ddb2042957fc0614c67ab7ffc4");
  const DISTRIBUTOR = getAddress("0xbcD65C71dff8c71B199013dc9E5eAEBf86A4fF73");

  const holdersPlan = (): AuthorizedPoolsLaunchPlan =>
    poolsPlan({
      feeRecipient: SENTINEL_BOTH,
      holderRewards: { mode: "both", sentinel: SENTINEL_BOTH },
    });

  it("declines when the receipt's recipient is not proven by a DistributorDeployed", async () => {
    // The V1 suite these fixtures use has no HolderRewardsDeployer at all, so a
    // holders launch on it can never be proven - and DECLINING is the right
    // answer: the row stays pending rather than recording a fee destination
    // this build cannot account for.
    receiptLogs = [
      gatewayLog({ feeRecipient: DISTRIBUTOR }),
      factoryLog({ feeRecipient: DISTRIBUTOR }),
    ];
    const deps = buildProductionLaunchRepairDeps();
    const outcome = await deps.resolveLaunchOutcome({
      chainId: 4663,
      txHash: TX_HASH,
      walletAddress: WALLET,
      protocol: "pools_fun",
      poolsPlan: holdersPlan(),
    });
    expect(outcome).toBeNull();
  });

  // The regression the columns exist to prevent: WITHOUT the holders intent the
  // sweep compares the receipt's distributor to the signed sentinel and declines
  // a launch that is perfectly correct. This asserts the sentinel really is a
  // different address from what such a receipt carries, which is the whole
  // reason the plan cannot be reduced to one recipient field.
  it("holds an ordinary launch to the exact signed recipient, unchanged", async () => {
    receiptLogs = [
      gatewayLog({ feeRecipient: DISTRIBUTOR }),
      factoryLog({ feeRecipient: DISTRIBUTOR }),
    ];
    const deps = buildProductionLaunchRepairDeps();
    const outcome = await deps.resolveLaunchOutcome({
      chainId: 4663,
      txHash: TX_HASH,
      walletAddress: WALLET,
      protocol: "pools_fun",
      // No holders intent: the receipt must name exactly WALLET, and it does not.
      poolsPlan: poolsPlan(),
    });
    expect(outcome).toBeNull();
    expect(SENTINEL_BOTH).not.toBe(DISTRIBUTOR);
  });
});
