/**
 * Uniswap execute — staged-broadcast durability contract. FIX ROUND 2 (Codex
 * final-review round 1 findings 1/2/3/8; Coordinator addendum 2
 * C14/C16/C17/C18/C24), FIX ROUND 3's C29 correction (Codex final-review
 * round 2 finding 1), and FIX ROUND 4's "last mile" C37/C38/C39/C41
 * (Codex final-review round 3 findings 1/2/3/6; Coordinator addendum 4):
 *
 *   - C14: a `markActivityBroadcast` CAS miss THROWS — nothing is ever sent
 *     untracked.
 *   - C29 (supersedes FIX2's C15): a broadcast (`sendRawTransaction`)
 *     rejection is UNCONDITIONALLY ambiguous, never definitively failed —
 *     there is no pre-wire/post-wire distinction to draw at this stage
 *     (viem mints its RPC-error classes from the node's OWN JSON-RPC
 *     response, not a local pre-dispatch check; see
 *     `revert-mapping.ts`'s file header for the full evidence trail). A
 *     `failed` outcome can still occur downstream via a SIGN-time error
 *     (`classifyUniswapRevertError`, unambiguously pre-wire) or a mined
 *     revert from the receipt wait — neither of which is a broadcast-stage
 *     rejection.
 *   - C16: `markBroadcastAccepted`/`confirmActivityEvent` throwing is a
 *     bounded, logged, NEVER-propagated bookkeeping failure — the swap's own
 *     outcome (broadcast/confirmed) is never downgraded to a generic failure.
 *   - C17: an ambiguous or reverted event aborts every STRICTLY-DOWNSTREAM
 *     never-signed planned event via `abortPlannedEvents`.
 *   - C18: once the intent exists, an unexpected error goes through the
 *     SAME `_executionId` — never a second `protocol_executions` row.
 *   - C24: the manifest's five-field contract is final — `dryRun` is hard
 *     rejected before anything else runs.
 *   - C37: `uniswapFailureMessage` is a THIN delegate to the centralized
 *     `summarizeProtocolError` boundary (no local HTML-strip supplement
 *     anymore) — including the SIGN-time decoded revert-classification text.
 *   - C38: a settlement-decode throw AFTER on-chain confirmation is BOUNDED
 *     — never escapes to the generic outer catch, never loses the tx hash.
 *   - C39: the locally-derived `signed.txHash` is authoritative end-to-end —
 *     never the RPC-echoed hash.
 *   - C41: `confirmActivityEvent().applied` is honored — a CAS miss against
 *     a conflicting row is `confirmed_unrecorded`, not silently "confirmed".
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { InvalidParamsRpcError } from "viem";
import { VexError, ErrorCodes } from "../../../errors.js";
import type { ProtocolExecutionContext } from "@vex-agent/tools/protocols/types.js";

const TOKEN_IN = "0x8Ff92566f2e81BDd68EDfAa8cde73942A723796b";
const TOKEN_OUT = "0xc6911796042b15d7Fa4F6CDe69e245DdCd3d9c31";
const WALLET = "0x1111111111111111111111111111111111111111";
const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";

const ensureErc20Balance = vi.fn();
const readUniswapAllowance = vi.fn();
const signUniswapTransaction = vi.fn();
const broadcastUniswapTransaction = vi.fn();
const pinTrackedToken = vi.fn();
const getLocalChain = vi.fn();
const createAgentActivityIntent = vi.fn();
const createAgentActivityPreBroadcastFailure = vi.fn();
const markActivityBroadcast = vi.fn();
const markBroadcastAccepted = vi.fn();
const confirmActivityEvent = vi.fn();
const failActivityEvent = vi.fn();
const abortPlannedEvents = vi.fn();
const decodeUniswapExecutedLegs = vi.fn();
const clearUniswapPairReveal = vi.fn();
const waitForSuccessfulReceipt = vi.fn();
const classifyUniswapRevertError = vi.fn();
const loggerWarn = vi.fn();

vi.mock("@tools/uniswap/chains.js", () => ({
  resolveUniswapDeployment: vi.fn(() => ({
    key: "robinhood",
    name: "Robinhood Chain",
    chainId: 4663,
    weth: WETH,
    v2: { router02: "0x89e5db8b5aa49aa85ac63f691524311aeb649eba" },
  })),
}));
vi.mock("@tools/uniswap/evm-client.js", () => ({
  getUniswapPublicClient: vi.fn(() => ({})),
  getUniswapEvmClients: vi.fn(() => ({ publicClient: {}, walletClient: {} })),
}));
vi.mock("@tools/uniswap/erc20.js", () => ({
  readUniswapErc20Metadata: vi.fn(async (_client: unknown, address: string) => ({
    address, symbol: "TKN", decimals: 18, isNative: false,
  })),
  validateUniswapSpender: vi.fn(),
  readUniswapAllowance: (...args: unknown[]) => readUniswapAllowance(...args),
}));
vi.mock("@tools/uniswap/quote.js", () => ({
  quoteBestRoute: vi.fn(async () => ({ route: { version: "v2", path: [TOKEN_IN, TOKEN_OUT], amountOut: 10n } })),
  applySlippage: vi.fn((amount: bigint) => amount),
}));
vi.mock("@tools/uniswap/execute.js", () => ({
  NATIVE_TOKEN_ADDRESS: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE",
  buildSwapTx: vi.fn(() => ({ to: "0xrouter", data: "0x", value: 0n })),
  buildApproveTx: vi.fn(() => ({ to: "0xtoken", data: "0x", value: 0n })),
  signUniswapTransaction: (...args: unknown[]) => signUniswapTransaction(...args),
  broadcastUniswapTransaction: (...args: unknown[]) => broadcastUniswapTransaction(...args),
}));
vi.mock("@tools/uniswap/safety.js", () => ({ checkRouteFactories: vi.fn(), probeFotSignal: vi.fn(), UNISWAP_MIN_LIQUIDITY_USD: 5000 }));
vi.mock("@tools/uniswap/receipt-decoder.js", () => ({
  decodeUniswapExecutedLegs: (...args: unknown[]) => decodeUniswapExecutedLegs(...args),
}));
vi.mock("@tools/uniswap/revert-mapping.js", () => ({
  classifyUniswapRevertError: (...args: unknown[]) => classifyUniswapRevertError(...args),
  classifyPreBroadcastFailure: vi.fn(() => ({ failureCode: "unknown", failureReason: "unused" })),
}));
vi.mock("@tools/dexscreener/client.js", () => ({ getDexScreenerClient: vi.fn() }));
vi.mock("@tools/evm-chains/registry.js", () => ({ getLocalChain: (...args: unknown[]) => getLocalChain(...args) }));
vi.mock("@tools/evm-chains/erc20-balance-guard.js", () => ({
  ensureErc20Balance: (...args: unknown[]) => ensureErc20Balance(...args),
}));
vi.mock("@tools/evm-chains/receipt-guard.js", () => ({
  waitForSuccessfulReceipt: (...args: unknown[]) => waitForSuccessfulReceipt(...args),
}));
vi.mock("@vex-agent/db/repos/tracked-tokens.js", () => ({ pinTrackedToken: (...args: unknown[]) => pinTrackedToken(...args) }));
vi.mock("@vex-agent/db/repos/agent-activity.js", () => ({
  createAgentActivityIntent: (...args: unknown[]) => createAgentActivityIntent(...args),
  createAgentActivityPreBroadcastFailure: (...args: unknown[]) => createAgentActivityPreBroadcastFailure(...args),
  markActivityBroadcast: (...args: unknown[]) => markActivityBroadcast(...args),
  markBroadcastAccepted: (...args: unknown[]) => markBroadcastAccepted(...args),
  confirmActivityEvent: (...args: unknown[]) => confirmActivityEvent(...args),
  failActivityEvent: (...args: unknown[]) => failActivityEvent(...args),
  abortPlannedEvents: (...args: unknown[]) => abortPlannedEvents(...args),
}));
vi.mock("@vex-agent/tools/internal/wallet/resolve.js", () => ({
  resolveSelectedAddress: vi.fn(() => WALLET),
  resolveSigningWallet: vi.fn(() => ({ family: "eip155", address: WALLET, privateKey: `0x${"ab".repeat(32)}` })),
  walletScopeErrorToResult: vi.fn((err: unknown) => ({ success: false, output: String(err) })),
}));
// The Vex fee leg (migration 066) rides the SHARED staged broadcaster, not
// this venue's own sign/broadcast pair. Confirmed by default so the fee never
// changes the swap-side outcome these tests are about.
vi.mock("@tools/evm-chains/staged-broadcast.js", () => ({
  signStageBroadcast: async (
    _p: unknown, _w: unknown, _tx: unknown,
    hooks: { onHashStaged: (h: unknown) => Promise<void>; onAccepted: () => Promise<void> },
  ) => {
    await hooks.onHashStaged({ txHash: "0xfeehash", fromAddress: WALLET, nonce: 9 });
    await hooks.onAccepted();
    return { kind: "confirmed", txHash: "0xfeehash", receipt: { blockNumber: 2n } };
  },
}));
// The fee-eligibility oracle is a token fact, never a network call in a unit test.
vi.mock("@tools/kyberswap/token-api/client.js", () => ({
  getKyberTokenApiClient: () => ({ getHoneypotFotInfo: async () => ({ isHoneypot: false, isFOT: false, tax: 0 }) }),
}));
vi.mock("@utils/logger.js", () => ({
  default: { info: vi.fn(), warn: (...args: unknown[]) => loggerWarn(...args), debug: vi.fn() },
}));

const { UNISWAP_SWAP_HANDLERS } = await import("@vex-agent/tools/protocols/uniswap/handlers/swap.js");
const execute = UNISWAP_SWAP_HANDLERS["uniswap.swap.execute"]!;

const context = {
  sessionPermission: "full",
  approved: true,
  sessionId: "session-1",
  walletResolution: { source: "default" },
  walletPolicy: { kind: "none" },
} as unknown as ProtocolExecutionContext;

const SWAP_ONLY_PARAMS = { chain: "robinhood", tokenIn: TOKEN_IN, tokenOut: TOKEN_OUT, amountIn: "1" };

beforeEach(() => {
  vi.clearAllMocks();
  ensureErc20Balance.mockResolvedValue(undefined);
  readUniswapAllowance.mockResolvedValue(10n ** 30n); // sufficient by default — one (swap) event
  signUniswapTransaction.mockResolvedValue({ serializedTransaction: "0xsigned", txHash: "0xhash", fromAddress: WALLET, nonce: 1 });
  broadcastUniswapTransaction.mockResolvedValue("0xhash");
  waitForSuccessfulReceipt.mockResolvedValue({ logs: [] });
  decodeUniswapExecutedLegs.mockReturnValue({ executedAmountInRaw: 1n, executedAmountOutRaw: 1n });
  // The swap leg plus the `swap_fee` leg migration 066 added — the intent
  // always returns a row for EVERY planned event, the fee row included.
  createAgentActivityIntent.mockResolvedValue({
    executionId: 1,
    events: [
      { id: 100, eventIndex: 0, eventRole: "swap" },
      { id: 101, eventIndex: 1, eventRole: "swap_fee" },
    ],
  });
  createAgentActivityPreBroadcastFailure.mockResolvedValue({ executionId: 999, event: {} });
  markActivityBroadcast.mockResolvedValue({ applied: true, row: {} });
  markBroadcastAccepted.mockResolvedValue({ applied: true, row: {} });
  confirmActivityEvent.mockResolvedValue({ applied: true, row: {} });
  failActivityEvent.mockResolvedValue({ applied: true, row: {} });
  abortPlannedEvents.mockResolvedValue(undefined);
  pinTrackedToken.mockResolvedValue({ inserted: true });
  getLocalChain.mockReturnValue({ chainId: 4663 });
  classifyUniswapRevertError.mockReturnValue({ failureCode: "broadcast_error", failureReason: "boom" });
});

describe("C24 — dryRun is hard-rejected (five-field contract is final)", () => {
  it("rejects dryRun:true before touching any staged-broadcast machinery", async () => {
    const result = await execute({ ...SWAP_ONLY_PARAMS, dryRun: true }, context);
    expect(result.success).toBe(false);
    expect(result.output).toContain("does not support dryRun");
    expect(createAgentActivityIntent).not.toHaveBeenCalled();
    expect(signUniswapTransaction).not.toHaveBeenCalled();
  });
});

describe("C37 — uniswapFailureMessage is a THIN delegate to the centralized summarizeProtocolError boundary", () => {
  it("never lets a secret-shaped key reach the ToolResult output (delegated redaction, no local supplement)", async () => {
    // A pre-broadcast failure (before anything is signed) — exercises
    // `failPreBroadcast`'s own `uniswapFailureMessage(err)` call.
    readUniswapAllowance.mockRejectedValueOnce(
      new Error("upstream failed: api_key=sk-abcdef1234567890abcdef1234567890"),
    );
    const result = await execute(SWAP_ONLY_PARAMS, context);
    expect(result.success).toBe(false);
    expect(result.output).not.toContain("sk-abcdef1234567890abcdef1234567890");
  });

  it("preserves a VexError's authored hint (summarizeProtocolError's own fold-in behavior)", async () => {
    readUniswapAllowance.mockRejectedValueOnce(
      new VexError(ErrorCodes.SWAP_FAILED, "boom", "retry with a smaller amount"),
    );
    const result = await execute(SWAP_ONLY_PARAMS, context);
    expect(result.success).toBe(false);
    expect(result.output).toContain("retry with a smaller amount");
  });

  // NOTE: HTML-document removal, Bearer-before-header ordering, and balanced/
  // nested body removal are now `runtime/errors.ts`'s responsibility (C37,
  // Codex final-review round 3 finding 1 — W-SPINE, same contract), not
  // this handler's. FIX3 previously pinned a local HTML-strip supplement
  // here; that supplement is deleted (this handler adds nothing on top of
  // `summarizeProtocolError` anymore), so its adversarial coverage belongs in
  // `runtime-errors.test.ts`, not duplicated in this venue's test file.

  it("routes the SIGN-time decoded revert-classification text (untrusted, provider/chain-controlled) through the SAME scrub boundary before it reaches output or the DB row", async () => {
    // `classifyUniswapRevertError`'s `failureReason` can be a DECODED on-chain
    // revert string a malformed/non-standard contract controls — this must
    // never reach the ToolResult output or `agent_activity.failure_reason`
    // un-scrubbed (swap.ts's sign-time catch in `runStagedBroadcast`).
    classifyUniswapRevertError.mockReturnValue({
      failureCode: "broadcast_error",
      failureReason: "reverted with api_key=sk-abcdef1234567890abcdef1234567890",
    });
    signUniswapTransaction.mockRejectedValueOnce(new Error("sign failed"));
    const result = await execute(SWAP_ONLY_PARAMS, context);
    expect(result.success).toBe(false);
    expect(result.output).not.toContain("sk-abcdef1234567890abcdef1234567890");
    // The SAME scrubbed value is what the DB write receives too — one shared
    // `classification` object, never a raw/un-scrubbed duplicate persisted.
    expect(failActivityEvent).toHaveBeenCalledWith(
      100,
      expect.objectContaining({
        failureReason: expect.not.stringContaining("sk-abcdef1234567890abcdef1234567890"),
      }),
    );
  });
});

describe("C34 — the confirmed success output reports the DECODED executed amount, never the request echo", () => {
  it("uses formatUnits(decoded.executedAmountInRaw) for amountIn, not the raw requested string", async () => {
    // The request asks for "1" token (human units); the chain settled a
    // DIFFERENT net amount (fee-on-transfer / partial fill) — the success
    // message must reflect on-chain truth, not what was requested.
    decodeUniswapExecutedLegs.mockReturnValue({ executedAmountInRaw: 999_999_999_999n, executedAmountOutRaw: 1n });
    const result = await execute(SWAP_ONLY_PARAMS, context);
    expect(result.success).toBe(true);
    const parsed = JSON.parse(result.output as string) as { amountIn: string };
    expect(parsed.amountIn).toBe("0.000000999999999999");
    expect(parsed.amountIn).not.toBe("1");
  });
});

describe("C14 — markActivityBroadcast CAS miss refuses to broadcast", () => {
  it("never calls broadcastUniswapTransaction and reports a bounded failure with the SAME _executionId", async () => {
    markActivityBroadcast.mockResolvedValue({ applied: false, row: { id: 100, status: "pending" } });
    const result = await execute(SWAP_ONLY_PARAMS, context);
    expect(broadcastUniswapTransaction).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect((result.data as { _executionId: number })._executionId).toBe(1);
    // C18: the outer catch handles this — never a SECOND execution.
    expect(createAgentActivityPreBroadcastFailure).not.toHaveBeenCalled();
  });
});

describe("C29 — every broadcast rejection is unconditionally ambiguous, never definitively failed", () => {
  it("an uncertain-timing broadcast failure stays pending, never fails the row", async () => {
    broadcastUniswapTransaction.mockRejectedValue(new Error("timeout"));
    const result = await execute(SWAP_ONLY_PARAMS, context);
    expect(failActivityEvent).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect((result.data as { status: string }).status).toBe("pending");
  });

  it("an RPC-response-shaped rejection (e.g. InvalidParamsRpcError) ALSO stays pending — it is NOT a safe pre-wire signal", async () => {
    // C29: this class is minted by viem from the NODE's own JSON-RPC error
    // response (see `revert-mapping.ts`'s file header) — the request already
    // reached the server, so it carries no special "safe to fail" meaning at
    // the broadcast stage. There is no classifier left to special-case it.
    broadcastUniswapTransaction.mockRejectedValue(new InvalidParamsRpcError(new Error("boom")));
    const result = await execute(SWAP_ONLY_PARAMS, context);
    expect(failActivityEvent).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect((result.data as { status: string }).status).toBe("pending");
  });
});

describe("C16 — post-broadcast bookkeeping failures never become a generic failure", () => {
  it("markBroadcastAccepted throwing does not stop the flow — still waits for the receipt and confirms", async () => {
    markBroadcastAccepted.mockRejectedValue(new Error("db down"));
    const result = await execute(SWAP_ONLY_PARAMS, context);
    expect(waitForSuccessfulReceipt).toHaveBeenCalled();
    expect(result.success).toBe(true);
    expect((result.data as { txHash: string }).txHash).toBe("0xhash");
  });

  it("confirmActivityEvent throwing for the swap event still reports success, marked confirmed_unrecorded", async () => {
    confirmActivityEvent.mockRejectedValue(new Error("db down"));
    const result = await execute(SWAP_ONLY_PARAMS, context);
    expect(result.success).toBe(true);
    expect((result.data as { status: string }).status).toBe("confirmed_unrecorded");
    expect((result.data as { txHash: string }).txHash).toBe("0xhash");
  });
});

describe("C17 — an ambiguous/reverted event aborts every downstream never-signed event", () => {
  beforeEach(() => {
    // Force a 2-event plan: allowance (idx 0) then swap (idx 1).
    readUniswapAllowance.mockResolvedValue(0n);
    createAgentActivityIntent.mockResolvedValue({
      executionId: 2,
      events: [
        { id: 200, eventIndex: 0, eventRole: "allowance" },
        { id: 201, eventIndex: 1, eventRole: "swap" },
        { id: 202, eventIndex: 2, eventRole: "swap_fee" },
      ],
    });
  });

  it("an ambiguous allowance broadcast aborts the downstream swap event (never signed)", async () => {
    broadcastUniswapTransaction.mockRejectedValueOnce(new Error("timeout"));
    const result = await execute(SWAP_ONLY_PARAMS, context);
    expect(abortPlannedEvents).toHaveBeenCalledWith(2, 1, expect.stringContaining("ambiguous"));
    expect(signUniswapTransaction).toHaveBeenCalledTimes(1); // the swap event was never signed
    expect(result.success).toBe(false);
  });

  it("a reverted allowance (sign-time failure, the only source of a definitive 'failed' outcome pre-receipt) aborts the downstream swap event (never signed)", async () => {
    // C29: a broadcast-stage rejection can no longer produce "failed" — only
    // a SIGN-time throw (unambiguously pre-wire) or a mined revert can, per
    // `runStagedBroadcast`. Exercise the sign-time path here.
    signUniswapTransaction.mockRejectedValueOnce(new Error("nonce too low"));
    const result = await execute(SWAP_ONLY_PARAMS, context);
    expect(abortPlannedEvents).toHaveBeenCalledWith(2, 1, expect.stringContaining("reverted"));
    expect(signUniswapTransaction).toHaveBeenCalledTimes(1);
    expect(broadcastUniswapTransaction).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
  });

  it("C36: never re-supplies the repo's own mandatory 'not attempted:' prefix — abortPlannedEvents owns it exclusively", async () => {
    broadcastUniswapTransaction.mockRejectedValueOnce(new Error("timeout"));
    await execute(SWAP_ONLY_PARAMS, context);
    const [, , reason] = abortPlannedEvents.mock.calls[0] as [number, number, string];
    expect(reason.toLowerCase()).not.toContain("not attempted");
  });
});

describe("C18 — an unexpected post-intent error never creates a second execution", () => {
  it("aborts remaining plans with an 'execute aborted' reason, reuses the SAME _executionId, and never calls createAgentActivityPreBroadcastFailure", async () => {
    // C38 moved settlement-decode failures OUT of this catch's reach (they
    // are now bounded — see the dedicated C38 block below); a genuinely
    // unexpected, uncaught throw is exercised here via the SAME
    // CAS-miss mechanism C14 pins, since that is a legitimate "escapes every
    // local try/catch" error from this loop's perspective.
    markActivityBroadcast.mockResolvedValue({ applied: false, row: { id: 100, status: "pending" } });
    const result = await execute(SWAP_ONLY_PARAMS, context);
    expect(createAgentActivityPreBroadcastFailure).not.toHaveBeenCalled();
    expect(abortPlannedEvents).toHaveBeenCalledWith(1, 0, expect.stringContaining("execute aborted"));
    expect(result.success).toBe(false);
    expect((result.data as { _executionId: number })._executionId).toBe(1);
  });
});

describe("C38 — a settlement-decode throw AFTER on-chain confirmation is BOUNDED, never loses the known tx hash", () => {
  it("treats a decoder throw exactly like an undecodable receipt: success:true, confirmed_pending_amounts, txHash preserved", async () => {
    decodeUniswapExecutedLegs.mockImplementation(() => {
      throw new Error("unexpected decode crash");
    });
    const result = await execute(SWAP_ONLY_PARAMS, context);
    expect(result.success).toBe(true);
    expect((result.data as { status: string; txHash: string }).status).toBe("confirmed_pending_amounts");
    expect((result.data as { status: string; txHash: string }).txHash).toBe("0xhash");
    // Never reaches the generic outer post-intent catch/second-execution path.
    expect(createAgentActivityPreBroadcastFailure).not.toHaveBeenCalled();
    expect(abortPlannedEvents).not.toHaveBeenCalled();
  });
});

describe("C39 — the locally-derived signed.txHash is authoritative end-to-end, never the RPC-echoed hash", () => {
  it("waits for and reports signed.txHash even when the RPC echoes a different hash, and logs the mismatch", async () => {
    broadcastUniswapTransaction.mockResolvedValue("0xdifferenthash");
    const result = await execute(SWAP_ONLY_PARAMS, context);
    expect(waitForSuccessfulReceipt).toHaveBeenCalledWith(expect.anything(), "0xhash", expect.anything());
    expect(result.success).toBe(true);
    expect((result.data as { txHash: string }).txHash).toBe("0xhash");
    expect(loggerWarn).toHaveBeenCalledWith(
      "uniswap.swap.execute.broadcast_hash_mismatch",
      expect.objectContaining({ signedTxHash: "0xhash", rpcEchoedHash: "0xdifferenthash" }),
    );
  });
});

describe("C41 — confirmation recording is real ONLY when confirmActivityEvent().applied, or an already-confirmed row with MATCHING amounts", () => {
  it("a CAS miss against a conflicting (non-matching) row reports confirmed_unrecorded, never a plain confirmed", async () => {
    confirmActivityEvent.mockResolvedValue({
      applied: false,
      row: { status: "definitively_failed", executedAmountInRaw: "999", executedAmountOutRaw: "1" },
    });
    const result = await execute(SWAP_ONLY_PARAMS, context);
    expect(result.success).toBe(true);
    expect((result.data as { status: string }).status).toBe("confirmed_unrecorded");
  });

  it("a CAS miss against an ALREADY-confirmed row with matching executed amounts is a real recorded confirmation", async () => {
    // decoded amounts default to 1n/1n in beforeEach — the "already recorded"
    // row must match those exact raw strings to count as idempotent, not a conflict.
    confirmActivityEvent.mockResolvedValue({
      applied: false,
      row: { status: "confirmed", executedAmountInRaw: "1", executedAmountOutRaw: "1" },
    });
    const result = await execute(SWAP_ONLY_PARAMS, context);
    expect(result.success).toBe(true);
    expect((result.data as { status: string }).status).toBe("confirmed");
  });
});
