/**
 * THE VIRTUALS ARM of the crash-recovery sweep: what it does with a decoded
 * pre-launch.
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
 * WHICH NODE answers a Virtuals receipt, and the decode of the `PreLaunched`
 * event itself, are proven in `launch-identity-repair-chain-clients.test.ts`
 * against the REAL chain registry. They used to be proven here over a registry
 * mocked to contain Base, which is exactly the mask that hid the Base defect the
 * 2026-09-07 review measured. This suite owns the other end: what the sweep DOES
 * with a decoded pre-launch.
 */

import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { getAddress, type Hex } from "viem";

import { virtualsCurveDeployment } from "@tools/virtuals/curve/index.js";
import { definedValue } from "../../_test-value-guards.js";

const BASE = definedValue(virtualsCurveDeployment("base"), "the Base Virtuals deployment");
const BONDING_V5 = getAddress(BASE.bondingV5);
const TOKEN = getAddress("0x84A0326C64d9f0E1F640062638807722E1dde87f");
const PAIR = getAddress("0x50136d4174129585ec766eacf2f00cd1856690ca");
const WALLET = getAddress("0x33eF6673BD80cB11fcC41b82Bc2181E65cC4d2fA");
const TX_HASH = `0x${"d0".repeat(32)}` as Hex;
const INITIAL_PURCHASE = 997_500_000_000_000_000n;
const RECEIPT_BLOCK = 50_870_256n;

let pending: unknown[] = [];
let mockConfirm: Mock;
let mockRecord: Mock;
let mockStampIdentity: Mock;
let mockMarkKeeperOwed: Mock;
let mockSettleOutcome: Mock;

function reset(): void {
  pending = [];
  mockConfirm = vi.fn(async () => ({ intentId: "i1" }));
  mockRecord = vi.fn(async () => ({ inserted: true }));
  mockStampIdentity = vi.fn(async () => true);
  mockMarkKeeperOwed = vi.fn(async () => true);
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
  markLaunchKeeperPurchaseOwedByTxHash: (...a: unknown[]) => mockMarkKeeperOwed(...a),
  findLaunchActivityTerminalByTxHash: async () => null,
}));
vi.mock("@vex-agent/engine/runtime/lease-and-status/session-control-lock.js", () => ({
  withSessionControlLock: async (_s: string, fn: (c: unknown) => Promise<unknown>) => fn({}),
}));
vi.mock("@vex-agent/tools/protocols/virtuals/handlers/launch/intent.js", () => ({
  settleLaunchOutcome: (input: unknown) => mockSettleOutcome(input),
}));

const { repairLaunchIdentities } = await import("@vex-agent/sync/launch-identity-repair.js");

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

    // AND THE KEEPER OBLIGATION, because this arm recovers exactly the launches
    // whose handler did not finish - the ones whose payout is owed by the venue
    // and recorded as owed by nobody. Without it, the reporting grace releases a
    // TERMINAL launch event with an empty payout while the keeper has not acted,
    // and the server's single `pending -> terminal` merge window is spent.
    expect(mockMarkKeeperOwed).toHaveBeenCalledWith(TX_HASH);

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
    // Nothing was written at all, the obligation included: a row this sweep
    // could not read is a repairable record, not a launch to make claims about.
    expect(mockMarkKeeperOwed).not.toHaveBeenCalled();
  });
});
