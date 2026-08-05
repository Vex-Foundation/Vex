import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { encodeAbiParameters, encodeEventTopics, getAddress, type Address, type Hex } from "viem";

import type { ProtocolExecutionContext } from "@vex-agent/tools/protocols/types.js";
import type { StagedBroadcastOutcome } from "@tools/evm-chains/staged-broadcast.js";
import { TRENCH_DIAMOND_ABI } from "@tools/trench-express/abi.js";
import { TRENCH_DIAMOND_ADDRESS } from "@tools/trench-express/constants.js";

const WALLET = getAddress("0x33eF6673BD80cB11fcC41b82Bc2181E65cC4d2fA");
const TOKEN = getAddress("0x58659Ef9Be57216632BFD341FC57736a429EFB91");
const DIAMOND = getAddress(TRENCH_DIAMOND_ADDRESS);

// ── mock state ──────────────────────────────────────────────────────────────
let outcomes: StagedBroadcastOutcome[];
let signCalls: number;
let mockSign: Mock;
let mockReadQuote: Mock;
let mockConfirm: Mock;
let mockFail: Mock;
let mockAbort: Mock;
let mockPin: Mock;

function reset(): void {
  outcomes = [];
  signCalls = 0;
  mockSign = vi.fn(async (_pub: unknown, _wal: unknown, _tx: unknown, hooks: { onHashStaged: (h: unknown) => Promise<void>; onAccepted: () => Promise<void> }) => {
    signCalls += 1;
    await hooks.onHashStaged({ txHash: "0xhash", fromAddress: WALLET, nonce: 1 });
    await hooks.onAccepted();
    return outcomes.shift()!;
  });
  mockReadQuote = vi.fn().mockResolvedValue(1_000_000_000_000_000_000n);
  mockConfirm = vi.fn().mockResolvedValue({ applied: true, row: {} });
  mockFail = vi.fn().mockResolvedValue({ applied: true, row: {} });
  mockAbort = vi.fn().mockResolvedValue(undefined);
  mockPin = vi.fn().mockResolvedValue(undefined);
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
vi.mock("@vex-agent/db/repos/tracked-tokens.js", () => ({
  pinTrackedToken: (...a: unknown[]) => mockPin(...a),
}));
vi.mock("@vex-agent/db/repos/agent-activity.js", () => ({
  createAgentActivityIntent: async () => ({ executionId: 7, events: [{ id: 10 }, { id: 11 }] }),
  createAgentActivityPreBroadcastFailure: async () => ({ executionId: 7 }),
  markActivityBroadcast: async () => ({ applied: true, row: {} }),
  markBroadcastAccepted: async () => ({ applied: true, row: {} }),
  confirmActivityEvent: (...a: unknown[]) => mockConfirm(...a),
  failActivityEvent: (...a: unknown[]) => mockFail(...a),
  abortPlannedEvents: (...a: unknown[]) => mockAbort(...a),
  // Real export since migration 067. Without it the handler's best-effort
  // `noteHandlerPendingReason` throws inside its own catch and the pending-reason
  // path is silently skipped instead of exercised.
  notePendingReason: vi.fn(async () => ({ applied: true })),
}));

const { trenchTradeExecuteHandler } = await import("@vex-agent/tools/protocols/trench/handlers/trade-execute.js");

function ctx(): ProtocolExecutionContext {
  return { sessionPermission: "full", approved: true, walletResolution: { source: "default" }, walletPolicy: { kind: "none" }, sessionId: "s1" };
}

function transferLog(from: Address, to: Address, value: bigint) {
  const [t0, t1, t2] = encodeEventTopics({
    abi: [{ type: "event", name: "Transfer", inputs: [
      { name: "from", type: "address", indexed: true }, { name: "to", type: "address", indexed: true }, { name: "value", type: "uint256", indexed: false }] }],
    eventName: "Transfer", args: { from, to },
  }) as [Hex, Hex, Hex];
  return { address: TOKEN, topics: [t0, t1, t2], data: encodeAbiParameters([{ type: "uint256" }], [value]) };
}
function curveLog(name: "Bought" | "Sold", v1: bigint, v2: bigint) {
  const [t0] = encodeEventTopics({ abi: TRENCH_DIAMOND_ABI, eventName: name }) as [Hex];
  return { address: DIAMOND, topics: [t0], data: encodeAbiParameters(
    [{ type: "address" }, { type: "address" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }], [WALLET, TOKEN, v1, v2, 1n]) };
}
function confirmed(logs: unknown[]): StagedBroadcastOutcome {
  return { kind: "confirmed", txHash: "0xhash", receipt: { blockNumber: 1n, status: "success", logs } } as unknown as StagedBroadcastOutcome;
}

const BUY = { chain: "robinhood", tokenIn: "ETH", tokenOut: TOKEN, amountIn: "0.01" };
const SELL = { chain: "robinhood", tokenIn: TOKEN, tokenOut: "ETH", amountIn: "5" };

beforeEach(reset);

describe("trench.trade_execute — staged-loop behaviors", () => {
  it("(a) ambiguity stays pending and is NEVER re-broadcast", async () => {
    outcomes = [{ kind: "ambiguous", txHash: "0xhash", stage: "send", reason: "no receipt observed for the broadcast trade leg" }];
    const r = await trenchTradeExecuteHandler(BUY, ctx());
    expect(signCalls).toBe(1); // never retried / re-broadcast
    expect(r.success).toBe(false);
    expect((r.data as { status?: string }).status).toBe("pending");
    expect(mockAbort).toHaveBeenCalledWith(7, 1, expect.any(String));
  });

  it("(b) an approve revert means the sell leg is NEVER signed", async () => {
    outcomes = [{ kind: "reverted", txHash: "0xhash", receipt: { blockNumber: 1n, status: "reverted", logs: [] } } as unknown as StagedBroadcastOutcome];
    const r = await trenchTradeExecuteHandler(SELL, ctx());
    expect(signCalls).toBe(1); // approve only; sell never reached
    expect(mockFail).toHaveBeenCalled();
    expect((r.data as { status?: string }).status).toBe("reverted");
  });

  it("(c) a declined sell decode returns OUTPUT PENDING, never the quote estimate", async () => {
    // amountInRaw for "5" tokens @18dec = 5e18; Sold.v2 mismatched → decline.
    const soldLogs = [transferLog(WALLET, DIAMOND, 5_000_000_000_000_000_000n), curveLog("Sold", 784_080_000_000_000n, 999n)];
    outcomes = [confirmed([]), confirmed(soldLogs)]; // approve confirms, then sell confirms
    mockReadQuote.mockResolvedValue(784_080_000_000_000n); // the quote estimate
    const r = await trenchTradeExecuteHandler(SELL, ctx());
    expect((r.data as { status?: string }).status).toBe("confirmed_pending_amounts");
    // The quoted estimate must NOT be presented as the executed output.
    expect(r.output).not.toContain("784080000000000");
    expect(r.output).toContain("proceeds");
  });

  it("(d) a CAS-miss on confirm reports confirmed_unrecorded, not a clean confirm", async () => {
    const tokensOut = 197_913_781_308_210_736_292_461n;
    outcomes = [confirmed([curveLog("Bought", 495n, tokensOut), transferLog(DIAMOND, WALLET, tokensOut)])];
    mockReadQuote.mockResolvedValue(tokensOut);
    mockConfirm.mockResolvedValue({ applied: false, row: { status: "pending" } });
    const r = await trenchTradeExecuteHandler(BUY, ctx());
    expect((r.data as { status?: string }).status).toBe("confirmed_unrecorded");
    expect(mockPin).toHaveBeenCalled();
  });
});
