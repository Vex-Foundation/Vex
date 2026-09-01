/**
 * `uniswap.swap.execute` — the twin of the KyberSwap pre-sign refusal defect
 * (see `kyberswap-handlers/pre-sign-revert-refusal.test.ts` for the live
 * incident this comes from).
 *
 * Uniswap's shape differs from KyberSwap's and the difference matters. Its
 * `runStagedBroadcast` already CATCHES the sign-time error, classifies it
 * (`classifyUniswapRevertError` — so `Too little received` was already
 * recorded as `slippage`) and returns `{ kind: "failed" }`; the raw error
 * never reaches the outer catch. So the failure code was never the Uniswap
 * bug — the AGENT-FACING message was: "the swap transaction failed
 * (slippage): Too little received. No further steps were attempted." reads
 * like a transaction that happened and lost, names no remedy, and carries
 * neither `not_attempted` nor `retryable`.
 *
 * `{ kind: "failed" }` has TWO sources, and only one of them is pre-sign:
 * the sign-time catch (nothing was ever submitted) and a MINED revert from
 * the receipt wait (bytes were broadcast and burned gas). They must not be
 * given the same words — that distinction was won expensively.
 *
 * `revert-mapping.js` is deliberately NOT mocked here: the point is that ONE
 * mapper serves both venues, so the real table has to be in the loop.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { claimStandingInForTheParams } from "./_uniswap-approved-snapshot.js";
import { ExecutionRevertedError } from "viem";
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

// The fee-eligibility oracle (migration 066's `swap_fee` leg) is a token fact,
// never a live network call in a unit test.
vi.mock("@tools/kyberswap/token-api/client.js", () => ({
  getKyberTokenApiClient: () => ({ getHoneypotFotInfo: async () => ({ isHoneypot: false, isFOT: false, tax: 0 }) }),
}));
// The Vex fee leg rides the SHARED staged broadcaster, not this venue's own
// sign/broadcast pair. Confirmed by default so it never changes the outcome
// these tests are about.
vi.mock("@tools/evm-chains/staged-broadcast.js", () => ({
  signStageBroadcast: async (
    _p: unknown, _w: unknown, _tx: unknown,
    hooks: { onHashStaged: (h: unknown) => Promise<void>; onAccepted: () => Promise<void> },
  ) => {
    await hooks.onHashStaged({ txHash: "0xfeehash", fromAddress: "0x1111111111111111111111111111111111111111", nonce: 9 });
    await hooks.onAccepted();
    return { kind: "confirmed", txHash: "0xfeehash", receipt: { blockNumber: 2n } };
  },
}));
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
// S11a: the quote-safety liquidity check reads through the `price-read`
// seam. An empty pool list keeps this suite's prior behaviour: the check
// finds no liquidity and the suite's subject is elsewhere.
vi.mock("@tools/dexscreener/price-read.js", () => ({
  readTokensPairs: vi.fn(async () => []),
}));
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
// The execute is bound to an APPROVED quote (2026-08-27 incident): it claims one
// before it prices anything. This suite's subject is elsewhere, so the claim
// stands in with the quote this very call would have produced - see
// `_uniswap-approved-snapshot.ts`.
const claimUniswapExecutionSnapshot = vi.fn();
vi.mock("@vex-agent/tools/protocols/prequote/claim.js", () => ({
  claimSwapExecutionSnapshot: vi.fn(),
  claimUniswapExecutionSnapshot: (...args: unknown[]) => claimUniswapExecutionSnapshot(...args),
}));

vi.mock("@utils/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

const { DependentLegGasEstimateError } = await import("@tools/evm-chains/dependent-leg-gas-estimate.js");
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

/** The V3 `SwapRouter` slippage revert — the Uniswap twin of Kyber's `Return amount is not enough`. */
const UNISWAP_SLIPPAGE_REVERT = "Too little received";

function revertedWith(reason: string): ExecutionRevertedError {
  return new ExecutionRevertedError({ message: `execution reverted: ${reason}` });
}

beforeEach(() => {
  vi.clearAllMocks();
  claimUniswapExecutionSnapshot.mockImplementation(
    claimStandingInForTheParams({ chainId: 4663, weth: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73" }),
  );
  ensureErc20Balance.mockResolvedValue(undefined);
  readUniswapAllowance.mockResolvedValue(10n ** 30n); // sufficient — a single (swap) event
  signUniswapTransaction.mockResolvedValue({ serializedTransaction: "0xsigned", txHash: "0xhash", fromAddress: WALLET, nonce: 1 });
  broadcastUniswapTransaction.mockResolvedValue("0xhash");
  waitForSuccessfulReceipt.mockResolvedValue({ logs: [], blockNumber: 900n });
  decodeUniswapExecutedLegs.mockReturnValue({ executedAmountInRaw: 1n, executedAmountOutRaw: 1n });
  createAgentActivityIntent.mockResolvedValue({
    executionId: 1,
    events: [{ id: 100, eventIndex: 0, eventRole: "swap" }],
  });
  createAgentActivityPreBroadcastFailure.mockResolvedValue({ executionId: 999, event: {} });
  markActivityBroadcast.mockResolvedValue({ applied: true, row: {} });
  markBroadcastAccepted.mockResolvedValue({ applied: true, row: {} });
  confirmActivityEvent.mockResolvedValue({ applied: true, row: {} });
  failActivityEvent.mockResolvedValue({ applied: true, row: {} });
  abortPlannedEvents.mockResolvedValue(undefined);
  pinTrackedToken.mockResolvedValue({ inserted: true });
  getLocalChain.mockReturnValue({ chainId: 4663 });
});

describe("uniswap.swap.execute — a sign-time revert is a refusal, not a failed trade", () => {
  it("reports not_attempted + retryable and says nothing was signed", async () => {
    signUniswapTransaction.mockRejectedValueOnce(revertedWith(UNISWAP_SLIPPAGE_REVERT));

    const result = await execute(SWAP_ONLY_PARAMS, context);

    expect(result.success).toBe(false);
    expect((result.data as { status: string }).status).toBe("not_attempted");
    expect((result.data as { retryable?: boolean }).retryable).toBe(true);
    expect(result.output).toMatch(/nothing was signed/i);
    expect(result.output).toMatch(/cannot duplicate/i);
    expect(broadcastUniswapTransaction).not.toHaveBeenCalled();
  });

  it("names the remedy BY PARAMETER NAME and quotes the tolerance actually applied", async () => {
    signUniswapTransaction.mockRejectedValueOnce(revertedWith(UNISWAP_SLIPPAGE_REVERT));

    const result = await execute({ ...SWAP_ONLY_PARAMS, slippageBps: 50 }, context);

    expect(result.output).toContain("slippageBps");
    expect(result.output).toContain("50");
    expect(result.output).toContain("1000");
    expect(result.output).toContain(UNISWAP_SLIPPAGE_REVERT);
  });

  it("records the row as `slippage` (the shared mapper, unchanged)", async () => {
    signUniswapTransaction.mockRejectedValueOnce(revertedWith(UNISWAP_SLIPPAGE_REVERT));

    await execute(SWAP_ONLY_PARAMS, context);

    expect(failActivityEvent).toHaveBeenCalledWith(
      100,
      expect.objectContaining({ failureCode: "slippage" }),
    );
  });

  it("the SAME mapper resolves KyberSwap's wording — one table, both venues", async () => {
    signUniswapTransaction.mockRejectedValueOnce(revertedWith("Return amount is not enough"));

    const result = await execute(SWAP_ONLY_PARAMS, context);

    expect(failActivityEvent).toHaveBeenCalledWith(
      100,
      expect.objectContaining({ failureCode: "slippage" }),
    );
    expect(result.output).toContain("slippageBps");
  });

  it("a sign-time failure with no known remedy stays honest — refused, safe to re-run, no invented advice", async () => {
    signUniswapTransaction.mockRejectedValueOnce(revertedWith("SomeRouter: WEIRD_STATE"));

    const result = await execute(SWAP_ONLY_PARAMS, context);

    expect((result.data as { status: string }).status).toBe("not_attempted");
    expect(result.output).toMatch(/nothing was signed/i);
    expect(result.output).not.toContain("slippageBps");
  });
});

describe("uniswap.swap.execute — ERC-20 input: the swap leg follows a confirmed approval", () => {
  /**
   * The common shape, and the one the native-input fix did not reach: the
   * allowance leg confirms, so the swap leg's estimate is retried against the
   * read-after-write anchor and a persistent failure arrives as
   * `DependentLegGasEstimateError` — never as a first-touch revert.
   */
  beforeEach(() => {
    readUniswapAllowance.mockResolvedValue(0n); // short → an allowance leg is planned
    createAgentActivityIntent.mockResolvedValue({
      executionId: 7,
      events: [
        { id: 99, eventIndex: 0, eventRole: "allowance" },
        { id: 100, eventIndex: 1, eventRole: "swap" },
      ],
    });
  });

  function approvalConfirmsThenEstimateExhausted(reason: string) {
    signUniswapTransaction
      .mockResolvedValueOnce({ serializedTransaction: "0xsigned", txHash: "0xallow", fromAddress: WALLET, nonce: 1 })
      .mockRejectedValueOnce(new DependentLegGasEstimateError({
        attempts: 3,
        priorLegBlockNumber: 900n,
        observedHeadBlock: 902n,
        cause: revertedWith(reason),
      }));
  }

  it("a POOL-STATE reason that survived every retry names slippageBps", async () => {
    approvalConfirmsThenEstimateExhausted(UNISWAP_SLIPPAGE_REVERT);

    const result = await execute({ ...SWAP_ONLY_PARAMS, slippageBps: 50 }, context);

    expect(result.success).toBe(false);
    expect((result.data as { status: string }).status).toBe("not_attempted");
    expect((result.data as { retryable?: boolean }).retryable).toBe(true);
    expect((result.data as { failureCode?: string }).failureCode).toBe("slippage");
    expect(result.output).toContain("slippageBps");
    expect(result.output).toContain("50");
    expect(result.output).toContain("1000");
    expect(result.output).toContain(UNISWAP_SLIPPAGE_REVERT);
    expect(result.output).toMatch(/priceImpact/i);
    expect(result.output).toMatch(/nothing was signed or broadcast/i);
    expect(result.output).not.toMatch(/once more is reasonable/i);
    // The approval was broadcast; the SWAP leg never was.
    expect(broadcastUniswapTransaction).toHaveBeenCalledTimes(1);
  });

  it("keeps the retries and the confirmed approval's block as evidence", async () => {
    approvalConfirmsThenEstimateExhausted(UNISWAP_SLIPPAGE_REVERT);

    const result = await execute(SWAP_ONLY_PARAMS, context);

    expect(result.output).toContain("900");
    expect(result.output).toContain("3");
  });

  it("an ALLOWANCE-shaped reason keeps today's retry-then-stop message, unchanged", async () => {
    approvalConfirmsThenEstimateExhausted("ERC20: transfer amount exceeds allowance");

    const result = await execute(SWAP_ONLY_PARAMS, context);

    expect((result.data as { status: string }).status).toBe("not_attempted");
    expect((result.data as { retryable?: boolean }).retryable).toBe(true);
    expect(result.output).toMatch(/once more is reasonable/i);
    expect(result.output).toMatch(/do not keep retrying/i);
    expect(result.output).not.toContain("slippageBps");
  });
});

describe("uniswap.swap.execute — a MINED revert is not a pre-sign refusal", () => {
  it("never claims nothing was signed, and never offers the safe-to-re-run framing", async () => {
    // The bytes were broadcast and mined; gas was spent. This branch shares
    // `{ kind: "failed" }` with the sign-time path and must NOT inherit its
    // words.
    waitForSuccessfulReceipt.mockRejectedValueOnce(new VexError(ErrorCodes.SWAP_FAILED, "reverted on-chain"));

    const result = await execute(SWAP_ONLY_PARAMS, context);

    expect(result.success).toBe(false);
    expect(result.output).not.toMatch(/nothing was signed/i);
    expect((result.data as { status: string }).status).not.toBe("not_attempted");
    expect(failActivityEvent).toHaveBeenCalledWith(
      100,
      expect.objectContaining({ failureCode: "mined_revert" }),
    );
  });
});

/**
 * The mined-revert `failure_reason` reaches the agent twice: on this call's
 * output and later through the transactions inspect view. `"mined revert
 * (synchronous receipt wait)"` named the code path that noticed, not what
 * happened or what to do — and the obvious remedy differs by leg. An ERC-20
 * `approve` has no minimum-output guard, so the swap leg's "raise slippageBps"
 * is not merely unhelpful there, it is false.
 */
describe("uniswap.swap.execute — the mined-revert reason is written per leg role", () => {
  /** The reason recorded on the row `failActivityEvent` was called for. */
  function recordedReason(eventId: number): string {
    const call = failActivityEvent.mock.calls.find((c) => c[0] === eventId);
    if (!call) throw new Error(`failActivityEvent was not called for event ${eventId}`);
    return (call[1] as { failureReason: string }).failureReason;
  }

  it("swap leg: gas spent, nothing swapped, and the price-guard remedy by parameter name", async () => {
    waitForSuccessfulReceipt.mockRejectedValueOnce(new VexError(ErrorCodes.SWAP_FAILED, "reverted on-chain"));

    const result = await execute(SWAP_ONLY_PARAMS, context);

    const reason = recordedReason(100);
    expect(reason).toContain("mined revert: the transaction was included on-chain and reverted");
    expect(reason).toContain("gas was spent and nothing was swapped");
    expect(reason).toContain("The node returned no decoded reason.");
    expect(reason).toContain("re-quote and retry with a higher slippageBps");
    // The same text is what the agent reads on this call — spliced into the
    // output sentence without doubling the reason's own final period.
    expect(result.output).toContain("re-quote and retry with a higher slippageBps");
    expect(result.output).toContain("unavailable. No further steps were attempted.");
    expect(result.output).not.toContain("..");
  });

  it("allowance leg: names the role, denies the price guard, and bounds the retry", async () => {
    // Zero allowance → a plan of [allowance, swap]; the approve reverts first.
    readUniswapAllowance.mockResolvedValueOnce(0n);
    createAgentActivityIntent.mockResolvedValueOnce({
      executionId: 1,
      events: [
        { id: 100, eventIndex: 0, eventRole: "allowance" },
        { id: 101, eventIndex: 1, eventRole: "swap" },
      ],
    });
    waitForSuccessfulReceipt.mockRejectedValueOnce(new VexError(ErrorCodes.SWAP_FAILED, "reverted on-chain"));

    await execute(SWAP_ONLY_PARAMS, context);

    const reason = recordedReason(100);
    expect(reason).toContain("mined revert: the allowance transaction was included on-chain and reverted");
    expect(reason).toContain("the approval did not take effect");
    expect(reason).toContain("This is not a price guard");
    expect(reason).toContain("re-estimate and retry once");
    expect(reason).toContain("treat the token's approval path as broken");
    expect(reason).not.toContain("re-quote and retry with a higher slippageBps");
    expect(reason).not.toContain("nothing was swapped");
  });
});

describe("uniswap.swap.execute — a broadcast of unknown outcome still says do not resubmit", () => {
  it("stays pending and keeps the do-not-retry instruction", async () => {
    broadcastUniswapTransaction.mockRejectedValueOnce(new Error("timeout"));

    const result = await execute(SWAP_ONLY_PARAMS, context);

    expect((result.data as { status: string }).status).toBe("pending");
    expect(result.output).toMatch(/do not retry/i);
    expect(result.output).not.toMatch(/nothing was signed/i);
    expect(failActivityEvent).not.toHaveBeenCalled();
  });
});
