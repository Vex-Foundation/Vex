/**
 * The Vex fee on a Trench trade — ORDERING, the invariant that matters most.
 *
 * `src/tools/bridge-fee/index.ts:16-18` states it for bridges and it is
 * identical here: "a bridge that fails at any point NEVER charges a fee for a
 * bridge that did not happen. The worst case is that Vex misses revenue — never
 * that the user pays for nothing. Do not reorder to fee-first."
 *
 * Every test below is one half of that sentence. They are written against the
 * real handler rather than the fee module, because the ordering only exists in
 * the composition — a fee module that is correct in isolation and invoked one
 * step too early is exactly the defect this file exists to catch.
 */

import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { encodeAbiParameters, encodeEventTopics, getAddress, type Address, type Hex } from "viem";

import type { ProtocolExecutionContext } from "@vex-agent/tools/protocols/types.js";
import type { StagedBroadcastOutcome } from "@tools/evm-chains/staged-broadcast.js";
import { TRENCH_DIAMOND_ABI } from "@tools/trench-express/abi.js";
import { TRENCH_DIAMOND_ADDRESS } from "@tools/trench-express/constants.js";
import { TRENCH_FEE_RECEIVER_EVM, type TrenchFeeDisclosure } from "@tools/trench-express/fee/index.js";
import type { TrenchFeeCollection } from "@vex-agent/tools/protocols/trench/fee/run.js";

const WALLET = getAddress("0x33eF6673BD80cB11fcC41b82Bc2181E65cC4d2fA");
const TOKEN = getAddress("0x58659Ef9Be57216632BFD341FC57736a429EFB91");
const DIAMOND = getAddress(TRENCH_DIAMOND_ADDRESS);

interface SignedTx { readonly to: Address; readonly value?: bigint; readonly data?: Hex }

let outcomes: StagedBroadcastOutcome[];
let signedTxs: SignedTx[];
let plannedEvents: Array<{ eventRole: string; eventIndex: number; amountInRaw?: string }>;
let mockSign: Mock;
let mockReadQuote: Mock;
let quotedFor: bigint[];
let mockConfirm: Mock;
let mockFail: Mock;
let mockAbort: Mock;

function reset(): void {
  outcomes = [];
  signedTxs = [];
  plannedEvents = [];
  quotedFor = [];
  mockSign = vi.fn(async (_p: unknown, _w: unknown, tx: SignedTx, hooks: { onHashStaged: (h: unknown) => Promise<void>; onAccepted: () => Promise<void> }) => {
    signedTxs.push(tx);
    await hooks.onHashStaged({ txHash: `0xhash${signedTxs.length}`, fromAddress: WALLET, nonce: signedTxs.length });
    await hooks.onAccepted();
    return outcomes.shift()!;
  });
  mockReadQuote = vi.fn(async (_c: unknown, args: { amountInRaw: bigint }) => {
    quotedFor.push(args.amountInRaw);
    return 1_000_000_000_000_000_000n;
  });
  mockConfirm = vi.fn().mockResolvedValue({ applied: true, row: {} });
  mockFail = vi.fn().mockResolvedValue({ applied: true, row: {} });
  mockAbort = vi.fn().mockResolvedValue(undefined);
}
reset();

vi.mock("@tools/evm-chains/staged-broadcast.js", () => ({
  signStageBroadcast: (...a: unknown[]) => mockSign(...a),
}));
vi.mock("@tools/evm-chains/evm-client.js", () => ({
  getLocalEvmClients: () => ({ publicClient: {}, walletClient: {} }),
}));
vi.mock("@tools/trench-express/evm/curve-reader.js", async (orig) => ({
  ...(await (orig as () => Promise<Record<string, unknown>>)()),
  readCurveQuote: (...a: unknown[]) => mockReadQuote(...a),
  readTokenDecimals: async () => 18,
}));
vi.mock("@vex-agent/tools/internal/wallet/resolve.js", () => ({
  resolveSelectedAddress: () => WALLET,
  resolveSigningWallet: () => ({ family: "eip155", privateKey: `0x${"11".repeat(32)}` }),
  walletScopeErrorToResult: (e: unknown) => ({ success: false, output: String(e) }),
}));
vi.mock("@vex-agent/db/repos/tracked-tokens.js", () => ({ pinTrackedToken: async () => undefined }));
vi.mock("@vex-agent/db/repos/agent-activity.js", () => ({
  createAgentActivityIntent: async (input: { events: Array<{ eventRole: string; eventIndex: number; tokenIn?: { amountRaw?: string } }> }) => {
    plannedEvents = input.events.map((e) => ({ eventRole: e.eventRole, eventIndex: e.eventIndex, amountInRaw: e.tokenIn?.amountRaw }));
    return { executionId: 7, events: input.events.map((_e, i) => ({ id: 100 + i })) };
  },
  createAgentActivityPreBroadcastFailure: async () => ({ executionId: 7 }),
  markActivityBroadcast: async () => ({ applied: true, row: {} }),
  markBroadcastAccepted: async () => ({ applied: true, row: {} }),
  confirmActivityEvent: (...a: unknown[]) => mockConfirm(...a),
  failActivityEvent: (...a: unknown[]) => mockFail(...a),
  abortPlannedEvents: (...a: unknown[]) => mockAbort(...a),
}));

const { trenchTradeExecuteHandler } = await import("@vex-agent/tools/protocols/trench/handlers/trade-execute.js");

function ctx(): ProtocolExecutionContext {
  return { sessionPermission: "full", approved: true, walletResolution: { source: "default" }, walletPolicy: { kind: "none" }, sessionId: "s1" };
}
function curveLog(name: "Bought" | "Sold", v1: bigint, v2: bigint) {
  const [t0] = encodeEventTopics({ abi: TRENCH_DIAMOND_ABI, eventName: name }) as [Hex];
  return { address: DIAMOND, topics: [t0], data: encodeAbiParameters(
    [{ type: "address" }, { type: "address" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }], [WALLET, TOKEN, v1, v2, 1n]) };
}
function transferLog(from: Address, to: Address, value: bigint) {
  const [t0, t1, t2] = encodeEventTopics({
    abi: [{ type: "event", name: "Transfer", inputs: [
      { name: "from", type: "address", indexed: true }, { name: "to", type: "address", indexed: true }, { name: "value", type: "uint256", indexed: false }] }],
    eventName: "Transfer", args: { from, to },
  }) as [Hex, Hex, Hex];
  return { address: TOKEN, topics: [t0, t1, t2], data: encodeAbiParameters([{ type: "uint256" }], [value]) };
}
function confirmed(logs: unknown[]): StagedBroadcastOutcome {
  return { kind: "confirmed", txHash: "0xhash", receipt: { blockNumber: 1n, status: "success", logs } } as unknown as StagedBroadcastOutcome;
}
/** The live shape `withFeeDisclosure` merges into the trade result. */
type VexFeeReport = TrenchFeeCollection & { readonly disclosure: TrenchFeeDisclosure };

function feeOf(r: { data?: unknown }): VexFeeReport {
  return (r.data as { vexFee: VexFeeReport }).vexFee;
}

// 0.01 ETH = 1e16 wei → fee = 25e12 wei, curve gets 1e16 − 25e12.
const BUY = { chain: "robinhood", tokenIn: "ETH", tokenOut: TOKEN, amountIn: "0.01" };
const SELL = { chain: "robinhood", tokenIn: TOKEN, tokenOut: "ETH", amountIn: "5" };
const BUY_TOTAL = 10_000_000_000_000_000n;
const BUY_FEE = 25_000_000_000_000n;

beforeEach(reset);

describe("Trench fee — the fee leg is ALWAYS LAST", () => {
  it("BUY: the curve buy is signed FIRST and the treasury transfer LAST", async () => {
    const tokensOut = 197_913_781_308_210_736_292_461n;
    outcomes = [confirmed([curveLog("Bought", 495n, tokensOut), transferLog(DIAMOND, WALLET, tokensOut)]), confirmed([])];
    mockReadQuote.mockImplementation(async () => tokensOut);

    const r = await trenchTradeExecuteHandler(BUY, ctx());

    expect(signedTxs).toHaveLength(2);
    // Leg 1 is the curve call at the Diamond; leg 2 is the bare value transfer.
    expect(signedTxs[0]!.to).toBe(DIAMOND);
    expect(signedTxs[1]!.to).toBe(TRENCH_FEE_RECEIVER_EVM);
    expect(signedTxs[1]!.value).toBe(BUY_FEE);
    // A plain transfer, never a contract call.
    expect(signedTxs[1]!.data).toBe("0x");
    expect(r.success).toBe(true);
    expect(feeOf(r).collection).toBe("confirmed");
  });

  it("BUY: the fee row is planned LAST in the intent, before anything is broadcast", async () => {
    const tokensOut = 197_913_781_308_210_736_292_461n;
    outcomes = [confirmed([curveLog("Bought", 495n, tokensOut), transferLog(DIAMOND, WALLET, tokensOut)]), confirmed([])];
    mockReadQuote.mockImplementation(async () => tokensOut);
    await trenchTradeExecuteHandler(BUY, ctx());

    expect(plannedEvents.map((e) => e.eventRole)).toEqual(["swap", "trench_fee"]);
    expect(plannedEvents.at(-1)!.eventIndex).toBe(plannedEvents.length - 1);
    // The fee row records the fee itself in its own first-leg columns.
    expect(plannedEvents.at(-1)!.amountInRaw).toBe(BUY_FEE.toString());
  });

  it("BUY: the curve is quoted for amount MINUS fee, so the disclosed output is what arrives", async () => {
    const tokensOut = 197_913_781_308_210_736_292_461n;
    outcomes = [confirmed([curveLog("Bought", 495n, tokensOut), transferLog(DIAMOND, WALLET, tokensOut)]), confirmed([])];
    mockReadQuote.mockImplementation(async (_c: unknown, args: { amountInRaw: bigint }) => {
      quotedFor.push(args.amountInRaw);
      return tokensOut;
    });
    await trenchTradeExecuteHandler(BUY, ctx());

    expect(quotedFor[0]).toBe(BUY_TOTAL - BUY_FEE);
    // And the buy leg's value is that same post-fee amount, not the total.
    expect(signedTxs[0]!.value).toBe(BUY_TOTAL - BUY_FEE);
  });

  it("SELL: approve, then sell, then the fee — three legs in that order", async () => {
    const proceeds = 784_080_000_000_000n;
    outcomes = [confirmed([]), confirmed([transferLog(WALLET, DIAMOND, 5_000_000_000_000_000_000n), curveLog("Sold", proceeds, 5_000_000_000_000_000_000n)]), confirmed([])];
    mockReadQuote.mockImplementation(async () => proceeds);

    const r = await trenchTradeExecuteHandler(SELL, ctx());

    expect(plannedEvents.map((e) => e.eventRole)).toEqual(["allowance", "swap", "trench_fee"]);
    expect(signedTxs).toHaveLength(3);
    expect(signedTxs[2]!.to).toBe(TRENCH_FEE_RECEIVER_EVM);
    // 25 bps of the ETH RECEIVED — the owner-approved deviation from currency_in.
    expect(signedTxs[2]!.value).toBe((proceeds * 25n) / 10_000n);
    expect(feeOf(r).disclosure.basis).toBe("sell_eth_out");
  });
});

describe("Trench fee — a trade that did not happen is NEVER charged", () => {
  it("a REVERTED buy never signs the fee", async () => {
    outcomes = [{ kind: "reverted", txHash: "0xhash", receipt: { blockNumber: 1n, status: "reverted", logs: [] } } as unknown as StagedBroadcastOutcome];
    const r = await trenchTradeExecuteHandler(BUY, ctx());

    expect(signedTxs).toHaveLength(1); // the buy only
    expect(signedTxs.some((t) => t.to === TRENCH_FEE_RECEIVER_EVM)).toBe(false);
    expect((r.data as { status?: string }).status).toBe("reverted");
    // The fee row is aborted from the reverted leg on, never left pending.
    expect(mockAbort).toHaveBeenCalled();
  });

  it("an AMBIGUOUS buy never signs the fee — the outcome is unknown, so nothing is charged", async () => {
    outcomes = [{ kind: "ambiguous", txHash: "0xhash", stage: "send", reason: "no receipt observed for the broadcast trade leg" }];
    const r = await trenchTradeExecuteHandler(BUY, ctx());

    expect(signedTxs).toHaveLength(1);
    expect(signedTxs.some((t) => t.to === TRENCH_FEE_RECEIVER_EVM)).toBe(false);
    expect((r.data as { status?: string }).status).toBe("pending");
  });

  it("a reverted APPROVE on a sell never reaches the sell OR the fee", async () => {
    outcomes = [{ kind: "reverted", txHash: "0xhash", receipt: { blockNumber: 1n, status: "reverted", logs: [] } } as unknown as StagedBroadcastOutcome];
    await trenchTradeExecuteHandler(SELL, ctx());
    expect(signedTxs).toHaveLength(1);
    expect(signedTxs.some((t) => t.to === TRENCH_FEE_RECEIVER_EVM)).toBe(false);
  });

  it("a SELL whose proceeds cannot be decoded takes NO fee — never 25 bps of a quote", async () => {
    // Sold's cross-check amount is mismatched → the decoder declines.
    const quoted = 784_080_000_000_000n;
    outcomes = [confirmed([]), confirmed([transferLog(WALLET, DIAMOND, 5_000_000_000_000_000_000n), curveLog("Sold", quoted, 999n)])];
    mockReadQuote.mockImplementation(async () => quoted);

    const r = await trenchTradeExecuteHandler(SELL, ctx());

    expect(signedTxs).toHaveLength(2); // approve + sell; the fee was never signed
    expect(signedTxs.some((t) => t.to === TRENCH_FEE_RECEIVER_EVM)).toBe(false);
    expect(feeOf(r).collection).toBe("not_attempted");
    expect(feeOf(r).disclosure.charged).toBe(false);
    // The quote must not appear anywhere as a settled figure.
    expect(r.output).not.toContain(((quoted * 25n) / 10_000n).toString());
  });
});

describe("Trench fee — a failed fee leaves the trade untouched", () => {
  it("a REVERTED fee still reports a SUCCESSFUL trade", async () => {
    const tokensOut = 197_913_781_308_210_736_292_461n;
    outcomes = [
      confirmed([curveLog("Bought", 495n, tokensOut), transferLog(DIAMOND, WALLET, tokensOut)]),
      { kind: "reverted", txHash: "0xfee", receipt: { blockNumber: 2n, status: "reverted", logs: [] } } as unknown as StagedBroadcastOutcome,
    ];
    mockReadQuote.mockImplementation(async () => tokensOut);

    const r = await trenchTradeExecuteHandler(BUY, ctx());

    expect(r.success).toBe(true);
    expect((r.data as { status?: string }).status).toBe("confirmed");
    expect(feeOf(r).collection).toBe("reverted");
    expect(feeOf(r).collectionNote).toContain("unaffected");
  });

  it("an AMBIGUOUS fee is NEVER re-sent — a blind retry could charge twice", async () => {
    const tokensOut = 197_913_781_308_210_736_292_461n;
    outcomes = [
      confirmed([curveLog("Bought", 495n, tokensOut), transferLog(DIAMOND, WALLET, tokensOut)]),
      { kind: "ambiguous", txHash: "0xfee", stage: "send", reason: "no receipt observed for the broadcast fee transfer" },
    ];
    mockReadQuote.mockImplementation(async () => tokensOut);

    const r = await trenchTradeExecuteHandler(BUY, ctx());

    // Exactly two signatures: the buy and ONE fee attempt.
    expect(signedTxs).toHaveLength(2);
    expect(r.success).toBe(true);
    expect(feeOf(r).collection).toBe("unconfirmed");
    expect(feeOf(r).collectionNote).toContain("never re-sent");
  });

  it("a fee that throws before signing leaves the trade successful and takes nothing", async () => {
    const tokensOut = 197_913_781_308_210_736_292_461n;
    outcomes = [confirmed([curveLog("Bought", 495n, tokensOut), transferLog(DIAMOND, WALLET, tokensOut)])];
    mockReadQuote.mockImplementation(async () => tokensOut);
    mockSign.mockImplementationOnce(async (_p: unknown, _w: unknown, tx: SignedTx, hooks: { onHashStaged: (h: unknown) => Promise<void>; onAccepted: () => Promise<void> }) => {
      signedTxs.push(tx);
      await hooks.onHashStaged({ txHash: "0xhash1", fromAddress: WALLET, nonce: 1 });
      await hooks.onAccepted();
      return outcomes.shift()!;
    }).mockImplementationOnce(async () => { throw new Error("gas estimate failed"); });

    const r = await trenchTradeExecuteHandler(BUY, ctx());

    expect(r.success).toBe(true);
    expect(feeOf(r).collection).toBe("not_attempted");
    expect(feeOf(r).txHash).toBeNull();
  });
});

describe("Trench fee — dust", () => {
  it("a buy too small to owe a fee plans NO fee row and signs ONE leg", async () => {
    // 3e-16 ETH = 300 wei → 25 bps floors to 0.
    const tokensOut = 19_791_378n;
    outcomes = [confirmed([curveLog("Bought", 495n, tokensOut), transferLog(DIAMOND, WALLET, tokensOut)])];
    mockReadQuote.mockImplementation(async (_c: unknown, args: { amountInRaw: bigint }) => {
      quotedFor.push(args.amountInRaw);
      return tokensOut;
    });

    const r = await trenchTradeExecuteHandler(
      { ...BUY, amountIn: "0.0000000000000003" },
      ctx(),
    );

    expect(plannedEvents.map((e) => e.eventRole)).toEqual(["swap"]);
    expect(signedTxs).toHaveLength(1);
    expect(feeOf(r).collection).toBe("not_charged");
    expect(feeOf(r).disclosure.charged).toBe(false);
    // The whole amount reached the curve — nothing was withheld.
    expect(quotedFor[0]).toBe(300n);
  });
});
