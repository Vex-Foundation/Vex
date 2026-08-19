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
import { POOLS_FACTORY_ADDRESS, POOLS_GATEWAY_ADDRESS } from "@tools/pools-fun/constants.js";

const GATEWAY = getAddress(POOLS_GATEWAY_ADDRESS);
const FACTORY = getAddress(POOLS_FACTORY_ADDRESS);
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

function gatewayLog(over: Partial<{ launcher: Address }> = {}) {
  const launcher = over.launcher ?? WALLET;
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
      [WETH, WALLET, SALT, 1_051_674_002_092_832n, DEV_BUY_OUT],
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

/** The authorized plan, exactly as the sweep reconstructs it from the intent. */
function poolsPlan(over: Partial<Record<string, string | null>> = {}) {
  return {
    feeRecipient: WALLET,
    pairedAsset: WETH,
    userSalt: SALT,
    predictedTokenAddress: TOKEN,
    gateway: GATEWAY,
    ...over,
  } as never;
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
