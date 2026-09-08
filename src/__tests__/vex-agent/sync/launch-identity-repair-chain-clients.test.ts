/**
 * WHICH NODE ANSWERS a launch receipt, per launchpad and per chain.
 *
 * The defect the 2026-09-07 review measured is silent and permanent: the
 * production dispatcher asked the LOCAL chain registry for every protocol, and
 * that registry holds only Robinhood. A Virtuals launch on Base (8453) - the
 * chain most Virtuals launches happen on - therefore returned `null` before any
 * decoder was reached, which the sweep reads as "not mined yet" and re-checks
 * forever. The reviewer's unmocked probe of the production dependency with a
 * real Base preLaunch hash answered `{"localBase":null,"receiptOutcome":null}`.
 * The user's agent exists on chain and nothing in Vex would ever reconcile it.
 *
 * The previous suite hid this by mocking Base INTO the local registry. This one
 * uses the REAL registry for both chains and scripts only the socket: the
 * transport builder is the single seam, so the registry lookup, the Virtuals
 * deployment table, `getVirtualsCurvePublicClient`, viem's own client and its
 * receipt formatter all run for real. An unscripted JSON-RPC method throws by
 * name rather than answering `undefined`.
 *
 * Ownership under test: the Virtuals deployment's own public client owns Base
 * reads. Base is deliberately NOT in the local chain registry - adding it there
 * would give every unrelated caller a Base client nobody decided to own.
 */

import { describe, expect, it, vi } from "vitest";
import {
  custom,
  encodeAbiParameters,
  encodeEventTopics,
  getAddress,
  numberToHex,
  type Hex,
  type Transport,
} from "viem";

import { BONDING_V5_LAUNCH_ABI } from "@tools/virtuals/launch/index.js";
import { virtualsCurveDeployment } from "@tools/virtuals/curve/index.js";
import { getLocalChain } from "@tools/evm-chains/registry.js";
import { definedValue } from "../../_test-value-guards.js";

const BASE = definedValue(virtualsCurveDeployment("base"), "the Base Virtuals deployment");
const ROBINHOOD = definedValue(
  virtualsCurveDeployment("robinhood"),
  "the Robinhood Virtuals deployment",
);

const TOKEN = getAddress("0x84A0326C64d9f0E1F640062638807722E1dde87f");
const PAIR = getAddress("0x50136d4174129585ec766eacf2f00cd1856690ca");
const WALLET = getAddress("0x33eF6673BD80cB11fcC41b82Bc2181E65cC4d2fA");
const TX_HASH = `0x${"d0".repeat(32)}` as Hex;
const BLOCK_HASH = `0x${"ab".repeat(32)}` as Hex;
const INITIAL_PURCHASE = 997_500_000_000_000_000n;
const VIRTUAL_ID = 139_289n;
const RECEIPT_BLOCK = 50_870_256n;

/**
 * THE ONLY SEAM. Every request the code under test issues is recorded with the
 * chain whose transport was built for it, so the test can assert WHICH chain was
 * dialled - the fact this suite exists to prove - and not merely that a receipt
 * came back.
 */
const dialled: { chainId: number; method: string }[] = [];
let scriptedReceipt: Record<string, unknown> | null = null;

function scriptedTransport(chainId: number): Transport {
  return custom({
    request: async ({ method }: { method: string }) => {
      dialled.push({ chainId, method });
      if (method === "eth_chainId") return numberToHex(chainId);
      if (method === "eth_getTransactionReceipt") return scriptedReceipt;
      throw new Error(`this test scripts no JSON-RPC method ${method}`);
    },
  });
}

vi.mock("@tools/evm-chains/rpc-transport.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tools/evm-chains/rpc-transport.js")>()),
  buildEvmTransport: (chainId: number) => scriptedTransport(chainId),
  buildPinnedEvmTransport: (chainId: number) => scriptedTransport(chainId),
}));

const { buildProductionLaunchRepairDeps } = await import(
  "@vex-agent/sync/launch-identity-repair.js"
);

function concreteTopics(topics: readonly (string | readonly string[] | null)[]): string[] {
  return topics.filter((topic): topic is string => typeof topic === "string");
}

/** A real `PreLaunched` event, encoded from the verified BondingV5 ABI. */
function preLaunchedLog(bondingV5: string): Record<string, unknown> {
  return {
    address: bondingV5,
    topics: concreteTopics(
      encodeEventTopics({
        abi: BONDING_V5_LAUNCH_ABI,
        eventName: "PreLaunched",
        args: { token: TOKEN, pair: PAIR },
      }),
    ),
    data: encodeAbiParameters(
      [
        { type: "uint256" },
        { type: "uint256" },
        {
          type: "tuple",
          components: [
            { name: "launchMode", type: "uint8" },
            { name: "airdropBips", type: "uint16" },
            { name: "needAcf", type: "bool" },
            { name: "antiSniperTaxType", type: "uint8" },
            { name: "isProject60days", type: "bool" },
          ],
        },
      ],
      [
        VIRTUAL_ID,
        INITIAL_PURCHASE,
        { launchMode: 0, airdropBips: 0, needAcf: false, antiSniperTaxType: 1, isProject60days: false },
      ],
    ),
    blockHash: BLOCK_HASH,
    blockNumber: numberToHex(RECEIPT_BLOCK),
    logIndex: "0x0",
    removed: false,
    transactionHash: TX_HASH,
    transactionIndex: "0x0",
  };
}

/** The wire shape a node returns for a mined `preLaunch`, formatted by viem itself. */
function preLaunchReceipt(bondingV5: string): Record<string, unknown> {
  return {
    blockHash: BLOCK_HASH,
    blockNumber: numberToHex(RECEIPT_BLOCK),
    contractAddress: null,
    cumulativeGasUsed: "0x5208",
    effectiveGasPrice: "0x3b9aca00",
    from: WALLET.toLowerCase(),
    gasUsed: "0x5208",
    logs: [preLaunchedLog(bondingV5)],
    logsBloom: `0x${"00".repeat(256)}`,
    status: "0x1",
    to: bondingV5.toLowerCase(),
    transactionHash: TX_HASH,
    transactionIndex: "0x0",
    type: "0x2",
  };
}

function resolveOn(chainId: number, bondingV5: string): Promise<unknown> {
  dialled.length = 0;
  scriptedReceipt = preLaunchReceipt(bondingV5);
  return buildProductionLaunchRepairDeps().resolveLaunchOutcome({
    chainId,
    txHash: TX_HASH,
    walletAddress: WALLET,
    protocol: "virtuals",
    poolsPlan: null,
  });
}

describe("the launch identity sweep reads a Virtuals receipt on every Virtuals chain", () => {
  it("BASE (8453) is not in the local chain registry, and the sweep still reaches the decoder", async () => {
    // The premise, asserted rather than assumed: this suite is worthless the day
    // Base is added to the local registry, because the guard it exercises would
    // no longer be the one that ran in production.
    expect(getLocalChain(8453)).toBeUndefined();

    const outcome = await resolveOn(8453, BASE.bondingV5);

    expect(outcome).toEqual({
      kind: "pre_launched",
      virtuals: {
        tokenAddress: TOKEN,
        pairAddress: PAIR,
        virtualId: VIRTUAL_ID.toString(),
        initialPurchaseRaw: INITIAL_PURCHASE.toString(),
        initialPurchaseDecimals: BASE.virtualDecimals,
        virtualAddress: getAddress(BASE.virtual),
        preLaunchBlock: RECEIPT_BLOCK.toString(),
      },
    });
    // Read on BASE, and only on Base. A receipt fetched from the wrong chain
    // would decode to nothing here and to the wrong token in the worst case.
    expect(dialled).toContainEqual({ chainId: 8453, method: "eth_getTransactionReceipt" });
    expect(dialled.every((call) => call.chainId === 8453)).toBe(true);
  });

  it("ROBINHOOD (4663) still resolves, through the same deployment-owned client", async () => {
    expect(getLocalChain(4663)).toBeDefined();

    const outcome = await resolveOn(4663, ROBINHOOD.bondingV5);

    expect(outcome).toEqual({
      kind: "pre_launched",
      virtuals: {
        tokenAddress: TOKEN,
        pairAddress: PAIR,
        virtualId: VIRTUAL_ID.toString(),
        initialPurchaseRaw: INITIAL_PURCHASE.toString(),
        initialPurchaseDecimals: ROBINHOOD.virtualDecimals,
        virtualAddress: getAddress(ROBINHOOD.virtual),
        preLaunchBlock: RECEIPT_BLOCK.toString(),
      },
    });
    expect(dialled.every((call) => call.chainId === 4663)).toBe(true);
  });

  it("declines a PreLaunched emitted by anything other than the pinned BondingV5", async () => {
    const outcome = await resolveOn(8453, getAddress("0x9999999999999999999999999999999999999999"));
    expect(outcome).toBeNull();
    // Null because the DECODER refused a stranger's log, not because no client
    // could be built for Base - the two failures are indistinguishable at the
    // sweep's contract, and only one of them is correct.
    expect(dialled).toContainEqual({ chainId: 8453, method: "eth_getTransactionReceipt" });
  });

  it("dials nothing at all for a chain where Virtuals has no curve", async () => {
    // Ethereum mainnet: no Virtuals deployment and not in the local registry.
    // The sweep declines BEFORE any node is asked - it does not fall through to
    // a client that would answer for a different chain.
    dialled.length = 0;
    scriptedReceipt = preLaunchReceipt(BASE.bondingV5);
    const outcome = await buildProductionLaunchRepairDeps().resolveLaunchOutcome({
      chainId: 1,
      txHash: TX_HASH,
      walletAddress: WALLET,
      protocol: "virtuals",
      poolsPlan: null,
    });

    expect(outcome).toBeNull();
    expect(dialled).toEqual([]);
  });

  it("keeps the pools.fun and legacy arms on the local chain registry", async () => {
    // pools.fun runs on Robinhood only. A pools intent carrying a chain the
    // local registry does not hold is declined without a node call, exactly as
    // before this change: the Virtuals deployment table is not a general chain
    // registry and must not answer for another launchpad.
    dialled.length = 0;
    scriptedReceipt = preLaunchReceipt(BASE.bondingV5);
    const outcome = await buildProductionLaunchRepairDeps().resolveLaunchOutcome({
      chainId: 8453,
      txHash: TX_HASH,
      walletAddress: WALLET,
      protocol: "pools_fun",
      poolsPlan: null,
    });

    expect(outcome).toBeNull();
    expect(dialled).toEqual([]);
  });
});
