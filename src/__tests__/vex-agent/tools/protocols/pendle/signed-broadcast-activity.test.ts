/**
 * The Pendle activity spine (card B1) — `sendPendleRouterTx` is the ONE place a
 * Pendle Router call is signed, and now also the one place it is RECORDED.
 *
 * These are the four cases the card requires be driven by a test, and each one
 * guards a rule that costs real money when it breaks:
 *
 *   1. CAS MISS → NOTHING IS BROADCAST. If the durable row is not in the state
 *      we believe it to be, an untracked transaction with real funds behind it
 *      is strictly worse than no transaction at all.
 *   2. CLAIM CREDIT. A claim spends nothing, so a receipt that mined
 *      successfully but credited nothing decodable is NOT a successful claim —
 *      confirming it would book income that does not exist.
 *   3. AMBIGUITY NEVER TERMINALIZES. A send/receipt failure leaves the row
 *      `pending` — never `definitively_failed`, never re-broadcast — and returns
 *      the exact refuse-to-retry sentence.
 *   4. THE HASH IS NEVER SWALLOWED (H-4). Once the node has returned a hash,
 *      every branch carries it, including the ones that fail afterwards.
 *
 * The settlement DECODER is deliberately NOT mocked: executed amounts come from
 * real ERC-20 Transfer logs run through the real net-delta accounting, so a test
 * that passes here is evidence the confirm path can only confirm what a receipt
 * actually proves.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { getAddress, keccak256, toHex, type Hex } from "viem";

const createAgentActivityIntent = vi.fn();
const markActivityBroadcast = vi.fn();
const markBroadcastAccepted = vi.fn();
const confirmActivityEvent = vi.fn();
const failActivityEvent = vi.fn();
const createAgentActivityPreBroadcastFailure = vi.fn();
const pinConfirmedPendleAcquisition = vi.fn();

vi.mock("@vex-agent/db/repos/agent-activity.js", () => ({
  createAgentActivityIntent: (...a: unknown[]) => createAgentActivityIntent(...a),
  markActivityBroadcast: (...a: unknown[]) => markActivityBroadcast(...a),
  markBroadcastAccepted: (...a: unknown[]) => markBroadcastAccepted(...a),
  confirmActivityEvent: (...a: unknown[]) => confirmActivityEvent(...a),
  failActivityEvent: (...a: unknown[]) => failActivityEvent(...a),
  createAgentActivityPreBroadcastFailure: (...a: unknown[]) => createAgentActivityPreBroadcastFailure(...a),
  // Real export since migration 067. Without it the handler's best-effort
  // `noteHandlerPendingReason` throws inside its own catch and the pending-reason
  // path is silently skipped instead of exercised.
  notePendingReason: vi.fn(async () => ({ applied: true })),
}));
vi.mock("@vex-agent/sync/pendle-acquisition-pin.js", () => ({
  pinConfirmedPendleAcquisition: (...a: unknown[]) => pinConfirmedPendleAcquisition(...a),
}));

const {
  sendPendleRouterTx,
  recordPendleRefusal,
  PENDLE_AMBIGUOUS_BROADCAST_MESSAGE,
} = await import("@vex-agent/tools/protocols/pendle/handlers/signed-broadcast.js");

// ── Fixtures ──────────────────────────────────────────────────────────

const WALLET = getAddress("0x742d35cc6634c0532925a3b844bc454e4438f44e");
const ROUTER = getAddress("0x888888888889758F76e7103c6CbF23ABbF58F946");
const USDC = getAddress("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
const PT = getAddress("0x1111111111111111111111111111111111111111");
const YT = getAddress("0x2222222222222222222222222222222222222222");
const CALLDATA = "0xdeadbeef" as Hex;
const SERIALIZED = "0x02f8b10101" as Hex;
const EXPECTED_HASH = keccak256(SERIALIZED);
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

function padded(address: string): string {
  return `0x${"0".repeat(24)}${address.slice(2).toLowerCase()}`;
}

/** One ERC-20 Transfer log, exactly as a mined receipt carries it. */
function transfer(token: string, from: string, to: string, amount: bigint) {
  return {
    address: token,
    topics: [TRANSFER_TOPIC, padded(from), padded(to)] as string[],
    data: toHex(amount, { size: 32 }),
  };
}

const ZERO = "0x0000000000000000000000000000000000000000";

type SendOutcome = "ok" | "throw";
type ReceiptOutcome =
  | { readonly status: "success"; readonly logs: ReturnType<typeof transfer>[] }
  | { readonly status: "reverted" }
  | { readonly status: "throw" };

function clients(send: SendOutcome, receipt: ReceiptOutcome) {
  const sendRawTransaction = vi.fn(async () => {
    if (send === "throw") throw new Error("rpc unavailable");
    return EXPECTED_HASH;
  });
  const waitForTransactionReceipt = vi.fn(async () => {
    if (receipt.status === "throw") throw new Error("receipt wait timed out");
    if (receipt.status === "reverted") return { status: "reverted", logs: [], blockNumber: 1n };
    return { status: "success", logs: receipt.logs, blockNumber: 1n };
  });
  return {
    publicClient: {
      estimateGas: vi.fn(async () => 1_000_000n),
      sendRawTransaction,
      waitForTransactionReceipt,
    } as never,
    walletClient: {
      account: { address: WALLET },
      chain: { id: 8453 },
      prepareTransactionRequest: vi.fn(async (r: Record<string, unknown>) => ({ ...r, nonce: 42 })),
      signTransaction: vi.fn(async () => SERIALIZED),
    } as never,
    sendRawTransaction,
    waitForTransactionReceipt,
  };
}

const BASE_PLAN = {
  toolId: "pendle.pt.buy",
  chainId: 8453,
  chainSlug: "base",
  walletAddress: WALLET,
  sessionId: "session-1",
  intentParams: {},
} as const;

const PT_PLAN = {
  ...BASE_PLAN,
  eventRole: "yield_pt",
  tokenIn: { tokenAddress: USDC, tokenDecimals: 6, amountRaw: "1000000", amountHuman: "1" },
  tokenOut: { tokenAddress: PT, tokenDecimals: 18, amountRaw: "1000000000000000000", amountHuman: "1" },
} as const;

beforeEach(() => {
  vi.clearAllMocks();
  createAgentActivityIntent.mockResolvedValue({ executionId: 7, events: [{ id: 99 }] });
  markActivityBroadcast.mockResolvedValue({ applied: true, row: {} });
  markBroadcastAccepted.mockResolvedValue({ applied: true, row: {} });
  confirmActivityEvent.mockResolvedValue({ applied: true, row: {} });
  failActivityEvent.mockResolvedValue({ applied: true, row: {} });
  pinConfirmedPendleAcquisition.mockResolvedValue(undefined);
});

const tx = { to: ROUTER, data: CALLDATA, value: 0n };

// ── 1. CAS miss refuses to broadcast ─────────────────────────────────

describe("a markActivityBroadcast CAS miss REFUSES to broadcast", () => {
  it("does not send the signed payload when the hash cannot be staged", async () => {
    markActivityBroadcast.mockResolvedValue({ applied: false, row: {} });
    const c = clients("ok", { status: "success", logs: [] });

    await expect(sendPendleRouterTx(c.publicClient, c.walletClient, tx, PT_PLAN)).rejects.toThrow(
      /CAS miss.*refusing to broadcast untracked/,
    );

    // The whole point: real funds were NOT committed to an untracked attempt.
    expect(c.sendRawTransaction).not.toHaveBeenCalled();
    expect(c.waitForTransactionReceipt).not.toHaveBeenCalled();
    expect(confirmActivityEvent).not.toHaveBeenCalled();
    expect(failActivityEvent).not.toHaveBeenCalled();
  });

  it("stages the hash BEFORE the submit, never after", async () => {
    const order: string[] = [];
    markActivityBroadcast.mockImplementation(async () => {
      order.push("stage");
      return { applied: true, row: {} };
    });
    const c = clients("ok", { status: "success", logs: [transfer(USDC, WALLET, ZERO, 1_000_000n), transfer(PT, ZERO, WALLET, 10n ** 18n)] });
    (c.sendRawTransaction as unknown as { mockImplementation: (f: () => Promise<Hex>) => void }).mockImplementation(async () => {
      order.push("submit");
      return EXPECTED_HASH;
    });

    await sendPendleRouterTx(c.publicClient, c.walletClient, tx, PT_PLAN);

    expect(order).toEqual(["stage", "submit"]);
    expect(markActivityBroadcast.mock.calls[0]).toEqual([99, { txHash: EXPECTED_HASH, fromAddress: WALLET, nonce: 42 }]);
  });

  it("creates the durable intent BEFORE anything is signed", async () => {
    const c = clients("ok", { status: "success", logs: [] });
    await sendPendleRouterTx(c.publicClient, c.walletClient, tx, PT_PLAN).catch(() => undefined);
    const intent = createAgentActivityIntent.mock.calls[0]![0] as { events: { kind: string; eventRole: string }[] };
    expect(intent.events[0]!.kind).toBe("yield");
    expect(intent.events[0]!.eventRole).toBe("yield_pt");
  });
});

// ── 2. Claim credit ──────────────────────────────────────────────────

describe("a claim is confirmed ONLY on a decoded credit", () => {
  const CLAIM_PLAN = {
    ...BASE_PLAN,
    toolId: "pendle.claim",
    eventRole: "yield_claim",
    // NO tokenIn, ever — a claim spends nothing.
    tokenOut: { tokenAddress: USDC, tokenDecimals: 6 },
  } as const;

  it("confirms when the receipt proves an ERC-20 credit to the wallet", async () => {
    const c = clients("ok", { status: "success", logs: [transfer(USDC, ZERO, WALLET, 420_000n)] });

    const result = await sendPendleRouterTx(c.publicClient, c.walletClient, tx, CLAIM_PLAN);

    expect(result.kind).toBe("confirmed");
    expect(confirmActivityEvent).toHaveBeenCalledWith(99, {
      executedAmountOutRaw: "420000",
      executedAmountOutHuman: "0.42",
    });
    // A confirmed claim must carry NO executed input leg: nothing was spent.
    const confirmArg = confirmActivityEvent.mock.calls[0]![1] as Record<string, unknown>;
    expect(confirmArg.executedAmountInRaw).toBeUndefined();
  });

  it("receipt-success with ZERO credits stays pending, and says so honestly", async () => {
    // Mined fine. Swept nothing. Booking income here would be a fabrication.
    const c = clients("ok", { status: "success", logs: [] });

    const result = await sendPendleRouterTx(c.publicClient, c.walletClient, tx, CLAIM_PLAN);

    expect(result).toMatchObject({ kind: "unproven", reason: "no_credit", txHash: EXPECTED_HASH });
    expect(confirmActivityEvent).not.toHaveBeenCalled();
    expect(failActivityEvent).not.toHaveBeenCalled();
    expect(result.kind === "unproven" && result.message).toMatch(/credited no decodable token/);
    expect(result.kind === "unproven" && result.message).toMatch(/[Dd]o not retry/);
  });

  it("a wallet OUTFLOW is not a credit — a claim that only paid gas-token out stays pending", async () => {
    const c = clients("ok", { status: "success", logs: [transfer(USDC, WALLET, ZERO, 500n)] });
    const result = await sendPendleRouterTx(c.publicClient, c.walletClient, tx, CLAIM_PLAN);
    expect(result).toMatchObject({ kind: "unproven", reason: "no_credit" });
  });
});

// ── 3. Ambiguity never terminalizes ──────────────────────────────────

describe("an ambiguous broadcast leaves the row pending", () => {
  it("returns the exact refuse-to-retry sentence on a failed submit", async () => {
    const c = clients("throw", { status: "success", logs: [] });

    const result = await sendPendleRouterTx(c.publicClient, c.walletClient, tx, PT_PLAN);

    expect(result).toMatchObject({ kind: "unproven", reason: "ambiguous", txHash: EXPECTED_HASH, executionId: 7 });
    expect(result.kind === "unproven" && result.message).toBe(
      "Cannot prove whether this broadcast landed — do not retry; this attempt is recorded as pending and resolves automatically.",
    );
    expect(result.kind === "unproven" && result.message).toBe(PENDLE_AMBIGUOUS_BROADCAST_MESSAGE);
  });

  it("returns the same sentence when the receipt wait itself fails", async () => {
    const c = clients("ok", { status: "throw" });
    const result = await sendPendleRouterTx(c.publicClient, c.walletClient, tx, PT_PLAN);
    expect(result).toMatchObject({ kind: "unproven", reason: "ambiguous" });
  });

  it("NEVER terminalizes an ambiguous attempt", async () => {
    for (const c of [clients("throw", { status: "success", logs: [] }), clients("ok", { status: "throw" })]) {
      await sendPendleRouterTx(c.publicClient, c.walletClient, tx, PT_PLAN);
    }
    expect(failActivityEvent).not.toHaveBeenCalled();
    expect(confirmActivityEvent).not.toHaveBeenCalled();
  });

  it("a mined REVERT is definitive, and is the one path that fails the row", async () => {
    const c = clients("ok", { status: "reverted" });
    const result = await sendPendleRouterTx(c.publicClient, c.walletClient, tx, PT_PLAN);
    expect(result.kind).toBe("reverted");
    expect(failActivityEvent).toHaveBeenCalledWith(99, expect.objectContaining({ failureCode: "mined_revert" }));
  });
});

// ── 4. The hash is never swallowed (H-4) ─────────────────────────────

describe("once a hash exists, every outcome carries it (H-4)", () => {
  it("carries the hash through a bookkeeping failure after confirmation", async () => {
    // The funds have already moved. A DB write failing afterwards must not be
    // reported as the trade itself failing, and must not lose the hash.
    confirmActivityEvent.mockRejectedValue(new Error("db down"));
    const c = clients("ok", {
      status: "success",
      logs: [transfer(USDC, WALLET, ZERO, 1_000_000n), transfer(PT, ZERO, WALLET, 10n ** 18n)],
    });

    const result = await sendPendleRouterTx(c.publicClient, c.walletClient, tx, PT_PLAN);

    expect(result).toMatchObject({ kind: "confirmed", txHash: EXPECTED_HASH });
  });

  it("carries the hash through an auto-pin failure", async () => {
    pinConfirmedPendleAcquisition.mockRejectedValue(new Error("pin failed"));
    const c = clients("ok", {
      status: "success",
      logs: [transfer(USDC, WALLET, ZERO, 1_000_000n), transfer(PT, ZERO, WALLET, 10n ** 18n)],
    });
    const result = await sendPendleRouterTx(c.publicClient, c.walletClient, tx, PT_PLAN);
    expect(result).toMatchObject({ kind: "confirmed", txHash: EXPECTED_HASH });
  });

  it("every non-throwing outcome carries the SAME hash the node was given", async () => {
    const cases: Array<[SendOutcome, ReceiptOutcome]> = [
      ["throw", { status: "success", logs: [] }],
      ["ok", { status: "throw" }],
      ["ok", { status: "reverted" }],
      ["ok", { status: "success", logs: [] }],
    ];
    for (const [send, receipt] of cases) {
      const c = clients(send, receipt);
      const result = await sendPendleRouterTx(c.publicClient, c.walletClient, tx, PT_PLAN);
      expect(result.txHash).toBe(EXPECTED_HASH);
    }
  });
});

// ── Executed amounts are decoded, never quoted ───────────────────────

describe("executed amounts come from the receipt, never from the plan", () => {
  it("confirms with the DECODED net deltas even when they differ from the quote", async () => {
    // Quote said 1.0 PT out; the chain delivered 0.97. The quote must not win.
    const c = clients("ok", {
      status: "success",
      logs: [transfer(USDC, WALLET, ZERO, 1_000_000n), transfer(PT, ZERO, WALLET, 970_000_000_000_000_000n)],
    });

    await sendPendleRouterTx(c.publicClient, c.walletClient, tx, PT_PLAN);

    expect(confirmActivityEvent).toHaveBeenCalledWith(99, {
      executedAmountInRaw: "1000000",
      executedAmountInHuman: "1",
      executedAmountOutRaw: "970000000000000000",
      executedAmountOutHuman: "0.97",
    });
  });

  it("a mined-but-unprovable receipt stays pending rather than confirming the quote", async () => {
    const c = clients("ok", { status: "success", logs: [transfer(USDC, WALLET, ZERO, 1_000_000n)] });
    const result = await sendPendleRouterTx(c.publicClient, c.walletClient, tx, PT_PLAN);
    expect(result).toMatchObject({ kind: "unproven", reason: "undecodable" });
    expect(confirmActivityEvent).not.toHaveBeenCalled();
  });

  it("a py.mint stages BOTH Option-C out legs and confirms both from the receipt", async () => {
    const plan = {
      ...BASE_PLAN,
      toolId: "pendle.py.mint",
      eventRole: "yield_py",
      tokenIn: { tokenAddress: USDC, tokenDecimals: 6, amountRaw: "1000000", amountHuman: "1" },
      tokenOut: { tokenAddress: PT, tokenDecimals: 18, amountRaw: "1000000000000000000", amountHuman: "1" },
      tokenOut2: { tokenAddress: YT, tokenDecimals: 18, amountRaw: "1000000000000000000", amountHuman: "1" },
    } as const;
    const c = clients("ok", {
      status: "success",
      logs: [
        transfer(USDC, WALLET, ZERO, 1_000_000n),
        transfer(PT, ZERO, WALLET, 10n ** 18n),
        transfer(YT, ZERO, WALLET, 10n ** 18n),
      ],
    });

    const result = await sendPendleRouterTx(c.publicClient, c.walletClient, tx, plan);

    expect(result.kind).toBe("confirmed");
    const staged = createAgentActivityIntent.mock.calls[0]![0] as { events: Record<string, unknown>[] };
    expect(staged.events[0]!.tokenOut2).toMatchObject({ tokenAddress: YT });
    expect(confirmActivityEvent).toHaveBeenCalledWith(99, expect.objectContaining({
      executedAmountOut2Raw: "1000000000000000000",
      executedAmountOut2Human: "1",
    }));
  });

  it("a py.mint whose SECOND leg cannot be proven stays pending — never half-confirmed", async () => {
    const plan = {
      ...BASE_PLAN,
      toolId: "pendle.py.mint",
      eventRole: "yield_py",
      tokenIn: { tokenAddress: USDC, tokenDecimals: 6 },
      tokenOut: { tokenAddress: PT, tokenDecimals: 18 },
      tokenOut2: { tokenAddress: YT, tokenDecimals: 18 },
    } as const;
    const c = clients("ok", {
      status: "success",
      logs: [transfer(USDC, WALLET, ZERO, 1_000_000n), transfer(PT, ZERO, WALLET, 10n ** 18n)],
    });

    const result = await sendPendleRouterTx(c.publicClient, c.walletClient, tx, plan);

    expect(result).toMatchObject({ kind: "unproven", reason: "undecodable" });
    expect(confirmActivityEvent).not.toHaveBeenCalled();
  });
});

// ── 6. A refusal records what it knows, including the second leg ─────

describe("recordPendleRefusal persists the Option-C second leg when the refusal knows it", () => {
  beforeEach(() => {
    createAgentActivityPreBroadcastFailure.mockResolvedValue({ executionId: 11, event: { id: 1 } });
  });

  it("passes tokenOut2 through for a py.mint refused after its quote resolved both instruments", async () => {
    // The mint knows PT *and* YT from the Convert route; a refusal that dropped
    // the YT would record a narrower truth than the trade it refused.
    const executionId = await recordPendleRefusal(
      {
        ...BASE_PLAN,
        toolId: "pendle.py.mint",
        eventRole: "yield_py",
        tokenIn: { tokenAddress: USDC, tokenDecimals: 6, amountRaw: "1000000", amountHuman: "1" },
        tokenOut: { tokenAddress: PT, tokenDecimals: 18 },
        tokenOut2: { tokenAddress: YT, tokenDecimals: 18 },
      },
      "route_not_found",
      "price floor unmet",
    );

    expect(executionId).toBe(11);
    const [call] = createAgentActivityPreBroadcastFailure.mock.calls[0]! as [
      { event: Record<string, unknown> },
    ];
    expect(call.event).toMatchObject({
      eventRole: "yield_py",
      kind: "yield",
      tokenOut: { tokenAddress: PT },
      tokenOut2: { tokenAddress: YT, tokenDecimals: 18 },
    });
  });

  it("passes tokenIn2 through for a py.redeem refusal", async () => {
    await recordPendleRefusal(
      {
        ...BASE_PLAN,
        toolId: "pendle.py.redeem",
        eventRole: "yield_py",
        tokenIn: { tokenAddress: PT, tokenDecimals: 18 },
        tokenIn2: { tokenAddress: YT, tokenDecimals: 18 },
      },
      "route_not_found",
      "no route",
    );

    const [call] = createAgentActivityPreBroadcastFailure.mock.calls[0]! as [
      { event: Record<string, unknown> },
    ];
    expect(call.event).toMatchObject({ tokenIn2: { tokenAddress: YT, tokenDecimals: 18 } });
  });

  it("omits both second legs when the refusal never learned them — an unresolved market", async () => {
    // The commonest PY refusal: the market did not resolve, so the YT address
    // is exactly what is missing. The row must still be writable.
    await recordPendleRefusal(
      {
        ...BASE_PLAN,
        toolId: "pendle.py.mint",
        eventRole: "yield_py",
        tokenOut: { tokenAddress: PT },
      },
      "route_not_found",
      "market unresolved",
    );

    const [call] = createAgentActivityPreBroadcastFailure.mock.calls[0]! as [
      { event: Record<string, unknown> },
    ];
    expect("tokenIn2" in call.event).toBe(false);
    expect("tokenOut2" in call.event).toBe(false);
  });
});
