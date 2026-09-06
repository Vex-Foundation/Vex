/**
 * THE VIRTUALS ARM of the crash-recovery sweep, at both of its ends.
 *
 * The defect the 2026-09-06 final review found is silent and permanent: the
 * production dispatcher handled `pools_fun` explicitly and routed EVERYTHING
 * else to the retired Trench decoder. A Virtuals `preLaunch` whose broadcast
 * came back ambiguous therefore decoded to nothing, which the sweep correctly
 * reads as ambiguity and re-checks forever - so the row stayed
 * `broadcast_pending`, never reached `awaiting_keeper`, and the keeper sweep
 * (which claims only `awaiting_keeper`) never saw it. The user's agent exists
 * on chain, their VIRTUAL sits inside BondingV5, and nothing in Vex would ever
 * finish the launch.
 *
 * A recovered Virtuals launch lands in `awaiting_keeper`, NOT `confirmed`: the
 * `preLaunch` proves the agent exists, and only the keeper's own `launch()`
 * makes it live. The Vex fee is waived there permanently (owner F3), and this
 * sweep holds no signer, so a fee is structurally impossible here.
 *
 * Logs are REAL ENCODED EVENTS from the verified BondingV5 ABI.
 */

import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { encodeAbiParameters, encodeEventTopics, getAddress, type Hex } from "viem";

import { BONDING_V5_LAUNCH_ABI } from "@tools/virtuals/launch/index.js";
import { virtualsCurveDeployment } from "@tools/virtuals/curve/index.js";
import { definedValue } from "../../_test-value-guards.js";

const BASE = definedValue(virtualsCurveDeployment("base"), "the Base Virtuals deployment");
const BONDING_V5 = getAddress(BASE.bondingV5);
const TOKEN = getAddress("0x84A0326C64d9f0E1F640062638807722E1dde87f");
const PAIR = getAddress("0x50136d4174129585ec766eacf2f00cd1856690ca");
const WALLET = getAddress("0x33eF6673BD80cB11fcC41b82Bc2181E65cC4d2fA");
const TX_HASH = `0x${"d0".repeat(32)}` as Hex;
const INITIAL_PURCHASE = 997_500_000_000_000_000n;

// ── the production dispatcher's half ────────────────────────────────────────

let receiptLogs: { address: string; topics: string[]; data: string }[] = [];
const RECEIPT_BLOCK = 50_870_256n;

vi.mock("@tools/evm-chains/registry.js", () => ({
  getLocalChain: () => ({ id: 8453, name: "Base" }),
}));
vi.mock("@tools/evm-chains/evm-client.js", () => ({
  getLocalPublicClient: () => ({
    getTransactionReceipt: async () => ({
      status: "success",
      blockNumber: RECEIPT_BLOCK,
      logs: receiptLogs,
    }),
  }),
}));

// ── the sweep's half ────────────────────────────────────────────────────────

let pending: unknown[] = [];
let mockConfirm: Mock;
let mockRecord: Mock;
let mockStampIdentity: Mock;
let mockSettleOutcome: Mock;

function reset(): void {
  pending = [];
  mockConfirm = vi.fn(async () => ({ intentId: "i1" }));
  mockRecord = vi.fn(async () => ({ inserted: true }));
  mockStampIdentity = vi.fn(async () => true);
  mockSettleOutcome = vi.fn(async () => true);
}
reset();

vi.mock("@vex-agent/db/repos/token-launch-intents.js", () => ({
  claimBroadcastPendingForSweep: async () => pending,
  confirmWith: (...a: unknown[]) => mockConfirm(...a),
  failWith: async () => ({ intentId: "i1" }),
}));
vi.mock("@vex-agent/db/repos/launched-tokens.js", () => ({
  record: (...a: unknown[]) => mockRecord(...a),
}));
vi.mock("@vex-agent/db/repos/agent-activity.js", () => ({
  stampLaunchOutputIdentityByTxHash: (...a: unknown[]) => mockStampIdentity(...a),
  findLaunchActivityTerminalByTxHash: async () => null,
}));
vi.mock("@vex-agent/engine/runtime/lease-and-status/session-control-lock.js", () => ({
  withSessionControlLock: async (_s: string, fn: (c: unknown) => Promise<unknown>) => fn({}),
}));
vi.mock("@vex-agent/tools/protocols/virtuals/handlers/launch/intent.js", () => ({
  settleLaunchOutcome: (input: unknown) => mockSettleOutcome(input),
}));

const { buildProductionLaunchRepairDeps, repairLaunchIdentities } = await import(
  "@vex-agent/sync/launch-identity-repair.js"
);

function concreteTopics(topics: readonly (string | readonly string[] | null)[]): string[] {
  return topics.filter((topic): topic is string => typeof topic === "string");
}

function preLaunchedLog(emitter: string = BONDING_V5) {
  return {
    address: emitter,
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
      [139_289n, INITIAL_PURCHASE, { launchMode: 0, airdropBips: 0, needAcf: false, antiSniperTaxType: 1, isProject60days: false }],
    ),
  };
}

/** The `virtuals` block a live intent carries, exactly as the preview sealed it. */
function sealedBlock(): Record<string, unknown> {
  return {
    chainKey: "base",
    bondingV5: BONDING_V5,
    imageUrl: "https://assets.example/a/abc123.jpeg",
    cores: [0, 1, 2],
    antiSniperTaxType: 1,
    nameSuffix: "by_virtuals",
    onChainName: "Otaku Analyst by Virtuals",
    urls: ["", "", "", ""],
    calldataFingerprint: "0xfeed",
    launchAmountRaw: "997500000000000000",
    protocolFeeRaw: "0",
  };
}

function virtualsIntent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    intentId: "i1",
    sessionId: "sess-1",
    chainId: 8453,
    protocol: "virtuals",
    walletAddress: WALLET,
    name: "Otaku Analyst",
    symbol: "OTAKU",
    imageId: null,
    txHash: TX_HASH,
    prebuyRaw: "1000000000000000000",
    prebuyDecimals: 18,
    virtuals: sealedBlock(),
    ...overrides,
  };
}

beforeEach(() => {
  reset();
  receiptLogs = [preLaunchedLog()];
});

describe("the production dispatcher decodes a Virtuals preLaunch receipt", () => {
  it("proves the token, the pair and the parked purchase from PreLaunched", async () => {
    const deps = buildProductionLaunchRepairDeps();
    const outcome = await deps.resolveLaunchOutcome({
      chainId: 8453,
      txHash: TX_HASH,
      walletAddress: WALLET,
      protocol: "virtuals",
      poolsPlan: null,
    });

    expect(outcome).toEqual({
      kind: "pre_launched",
      virtuals: {
        tokenAddress: TOKEN,
        pairAddress: PAIR,
        virtualId: "139289",
        initialPurchaseRaw: INITIAL_PURCHASE.toString(),
        initialPurchaseDecimals: BASE.virtualDecimals,
        virtualAddress: getAddress(BASE.virtual),
        preLaunchBlock: RECEIPT_BLOCK.toString(),
      },
    });
  });

  it("declines a PreLaunched emitted by anything other than the pinned BondingV5", async () => {
    receiptLogs = [preLaunchedLog(getAddress("0x9999999999999999999999999999999999999999"))];
    const deps = buildProductionLaunchRepairDeps();
    const outcome = await deps.resolveLaunchOutcome({
      chainId: 8453,
      txHash: TX_HASH,
      walletAddress: WALLET,
      protocol: "virtuals",
      poolsPlan: null,
    });
    expect(outcome).toBeNull();
  });
});

describe("the sweep moves a recovered Virtuals launch to awaiting_keeper", () => {
  it("indexes the agent, stamps the activity identity and waives the fee", async () => {
    pending = [virtualsIntent()];
    const result = await repairLaunchIdentities({
      resolveLaunchOutcome: async () => ({
        kind: "pre_launched",
        virtuals: {
          tokenAddress: TOKEN,
          pairAddress: PAIR,
          virtualId: "139289",
          initialPurchaseRaw: INITIAL_PURCHASE.toString(),
          initialPurchaseDecimals: 18,
          virtualAddress: getAddress(BASE.virtual),
          preLaunchBlock: RECEIPT_BLOCK.toString(),
        },
      }),
    });

    expect(result).toMatchObject({ checked: 1, awaitingKeeper: 1, indexed: 1, repaired: 0, stillPending: 0 });

    // The agent is filed under its OWN venue, with the purchase denominated in
    // VIRTUAL - never in native ETH, and never in the agent token that the
    // keeper has not bought yet.
    expect(mockRecord).toHaveBeenCalledTimes(1);
    expect(mockRecord.mock.calls[0]?.[0]).toMatchObject({
      launchpad: "virtuals",
      tokenAddress: TOKEN,
      initialBuyRaw: INITIAL_PURCHASE.toString(),
      initialBuyDecimals: 18,
      initialBuyTokenAddress: getAddress(BASE.virtual),
    });
    expect(mockStampIdentity).toHaveBeenCalledWith(TX_HASH, TOKEN);

    // `awaiting_keeper`, with the block the keeper sweep scans from and the fee
    // waived. NEVER `confirmed`: only the keeper's launch() makes the agent live.
    expect(mockConfirm).not.toHaveBeenCalled();
    expect(mockSettleOutcome).toHaveBeenCalledTimes(1);
    expect(mockSettleOutcome.mock.calls[0]?.[0]).toMatchObject({
      intentId: "i1",
      sessionId: "sess-1",
      txHash: TX_HASH,
      tokenAddress: TOKEN,
      outcome: "awaiting_keeper",
      block: {
        pairAddress: PAIR,
        virtualId: "139289",
        initialPurchaseRaw: INITIAL_PURCHASE.toString(),
        preLaunchBlock: RECEIPT_BLOCK.toString(),
        vexFeeWaived: true,
      },
    });
  });

  it("leaves the intent pending when its sealed block cannot be read", async () => {
    pending = [virtualsIntent({ virtuals: { chainKey: "base" } })];
    const result = await repairLaunchIdentities({
      resolveLaunchOutcome: async () => ({
        kind: "pre_launched",
        virtuals: {
          tokenAddress: TOKEN,
          pairAddress: PAIR,
          virtualId: "139289",
          initialPurchaseRaw: INITIAL_PURCHASE.toString(),
          initialPurchaseDecimals: 18,
          virtualAddress: getAddress(BASE.virtual),
          preLaunchBlock: RECEIPT_BLOCK.toString(),
        },
      }),
    });
    expect(result).toMatchObject({ checked: 1, awaitingKeeper: 0, stillPending: 1 });
    expect(mockSettleOutcome).not.toHaveBeenCalled();
    expect(mockRecord).not.toHaveBeenCalled();
  });
});
