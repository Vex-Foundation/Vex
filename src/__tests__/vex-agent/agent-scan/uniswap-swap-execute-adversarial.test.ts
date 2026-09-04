/**
 * `uniswap.swap.execute` — handler-level ADVERSARIAL tests (FIX2-W0,
 * Codex final-review round 1, bound in `agents_dm/agent-scan-factory.md`
 * "Coordinator addendum 2" as C14/C15/C16/C24).
 *
 * Mock recipe reuses the EXACT shapes already proven in the sibling
 * `uniswap-balance-preflight-handler.test.ts` (read-only reuse, that file is
 * untouched) — `signUniswapTransaction`/`broadcastUniswapTransaction` are
 * spied directly (Uniswap has no shared "staged helper" abstraction like
 * Kyber's `signStageBroadcast`; the staging sequence is inline in the
 * handler's own `runStagedBroadcast`, which is not exported), so these tests
 * drive the REAL exported handler end to end.
 *
 * (a) C14 — a CAS miss on `markActivityBroadcast` must ABORT before any
 *     network broadcast. Uniswap's `runStagedBroadcast` already returns
 *     early on `!staged.applied` before calling `broadcastUniswapTransaction`
 *     — pinned here as a regression guard (EXPECTED GREEN today).
 * (b) C15 — an ambiguous broadcast error must leave the row pending (never
 *     call `failActivityEvent`) and the result must carry the staged
 *     `txHash`. EXPECTED RED today: `swap.ts` classifies EVERY
 *     `broadcastUniswapTransaction` rejection as terminal via
 *     `failActivityEvent`, and the ambiguous/failed result path
 *     (`failedResult`) never includes `txHash` at all.
 * (c) C16 — a post-broadcast bookkeeping failure (`markBroadcastAccepted`
 *     throwing after a successful broadcast) must be a bounded catch: the
 *     result still carries the txHash and is never a raw/generic failure.
 *     EXPECTED RED today: there is no try/catch around that call, so it
 *     propagates as an uncaught rejection out of the handler entirely.
 * (f) C24 — `dryRun` must be hard-rejected, mirroring Kyber. EXPECTED RED
 *     today: the handler still returns a successful preview for `dryRun:true`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { uniswapSpendabilityFake } from "../tools/_uniswap-spendability-fake.js";
import { claimStandingInForTheParams } from "../tools/_uniswap-approved-snapshot.js";
import { VexError, ErrorCodes } from "../../../errors.js";
import type { ProtocolExecutionContext } from "@vex-agent/tools/protocols/types.js";

const TOKEN_IN = "0x8Ff92566f2e81BDd68EDfAa8cde73942A723796b";
const TOKEN_OUT = "0xc6911796042b15d7Fa4F6CDe69e245DdCd3d9c31";
const WALLET = "0x1111111111111111111111111111111111111111";
const SIGNED_TX_HASH = "0xSIGNEDHASH";

const ensureErc20Balance = vi.fn();
const validateUniswapSpender = vi.fn();
const readUniswapAllowance = vi.fn();
const signUniswapTransaction = vi.fn();
const broadcastUniswapTransaction = vi.fn();
const waitForSuccessfulReceipt = vi.fn();
const decodeUniswapExecutedLegs = vi.fn();
const createAgentActivityIntent = vi.fn();
const createAgentActivityPreBroadcastFailure = vi.fn();
const markActivityBroadcast = vi.fn();
const markBroadcastAccepted = vi.fn();
const confirmActivityEvent = vi.fn();
const failActivityEvent = vi.fn();

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
    weth: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
    v2: { router02: "0x89e5db8b5aa49aa85ac63f691524311aeb649eba" },
  })),
}));
vi.mock("@tools/uniswap/evm-client.js", () => ({
  // WP2-U: the quote and every leg's pre-sign gate read balances and price the
  // leg plan through this client. A SOLVENT default keeps each suite's own
  // subject the thing that decides its outcome.
  getUniswapPublicClient: vi.fn(() => uniswapSpendabilityFake()),
  getUniswapEvmClients: vi.fn(() => ({ publicClient: uniswapSpendabilityFake(), walletClient: {} })),
}));
vi.mock("@tools/uniswap/erc20.js", () => ({
  readUniswapErc20Metadata: vi.fn(async (_client: unknown, address: string) => ({
    address, symbol: "TKN", decimals: 18, isNative: false,
  })),
  validateUniswapSpender: (...args: unknown[]) => validateUniswapSpender(...args),
  readUniswapAllowance: (...args: unknown[]) => readUniswapAllowance(...args),
}));
vi.mock("@tools/uniswap/quote.js", () => ({
  quoteBestRoute: vi.fn(async () => ({ route: { version: "v2", path: [TOKEN_IN, TOKEN_OUT], amountOut: 10n } })),
  applySlippage: vi.fn((amount: bigint) => amount),
}));
// Spread over the REAL module so the refusal classes this venue throws
// (`UniswapFeeCapExceededError`, and the final-request refusal the loop
// re-throws by identity) are the real ones; the overrides below stay this
// suite's own seams.
vi.mock("@tools/uniswap/execute.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tools/uniswap/execute.js")>()),
  NATIVE_TOKEN_ADDRESS: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE",
  buildSwapTx: vi.fn(() => ({ to: TOKEN_OUT, data: "0x", value: 0n })),
  buildApproveTx: vi.fn(),
  signUniswapTransaction: (...args: unknown[]) => signUniswapTransaction(...args),
  broadcastUniswapTransaction: (...args: unknown[]) => broadcastUniswapTransaction(...args),
}));
vi.mock("@tools/uniswap/safety.js", () => ({ checkRouteFactories: vi.fn(), probeFotSignal: vi.fn(), UNISWAP_MIN_LIQUIDITY_USD: 5000 }));
vi.mock("@tools/uniswap/receipt-decoder.js", () => ({
  decodeUniswapExecutedLegs: (...args: unknown[]) => decodeUniswapExecutedLegs(...args),
}));
vi.mock("@tools/uniswap/revert-mapping.js", () => ({
  classifyUniswapRevertError: vi.fn(() => ({ failureCode: "broadcast_error", failureReason: "ambiguous or unknown submission outcome" })),
  classifyPreBroadcastFailure: vi.fn((err: unknown) =>
    err instanceof VexError && err.code === ErrorCodes.INSUFFICIENT_BALANCE
      ? { failureCode: "allowance_or_balance", failureReason: err.message }
      : { failureCode: "unknown", failureReason: "unused" },
  ),
}));
// S11a: the quote-safety liquidity check reads through the `price-read`
// seam. An empty pool list keeps this suite's prior behaviour: the check
// finds no liquidity and the suite's subject is elsewhere.
vi.mock("@tools/dexscreener/price-read.js", () => ({
  readTokensPairs: vi.fn(async () => []),
}));
vi.mock("@tools/evm-chains/registry.js", () => ({ getLocalChain: vi.fn(() => undefined) }));
vi.mock("@tools/evm-chains/erc20-balance-guard.js", () => ({
  ensureErc20Balance: (...args: unknown[]) => ensureErc20Balance(...args),
}));
vi.mock("@tools/evm-chains/receipt-guard.js", () => ({
  waitForSuccessfulReceipt: (...args: unknown[]) => waitForSuccessfulReceipt(...args),
}));
vi.mock("@vex-agent/db/repos/tracked-tokens.js", () => ({ pinTrackedToken: vi.fn().mockResolvedValue({ inserted: true }) }));
vi.mock("@vex-agent/db/repos/agent-activity.js", () => ({
  createAgentActivityIntent: (...args: unknown[]) => createAgentActivityIntent(...args),
  createAgentActivityPreBroadcastFailure: (...args: unknown[]) => createAgentActivityPreBroadcastFailure(...args),
  markActivityBroadcast: (...args: unknown[]) => markActivityBroadcast(...args),
  markBroadcastAccepted: (...args: unknown[]) => markBroadcastAccepted(...args),
  confirmActivityEvent: (...args: unknown[]) => confirmActivityEvent(...args),
  failActivityEvent: (...args: unknown[]) => failActivityEvent(...args),
}));
vi.mock("@vex-agent/tools/internal/wallet/resolve.js", () => ({
  resolveSelectedAddress: vi.fn(() => WALLET),
  resolveSigningWallet: vi.fn(() => ({ family: "eip155", address: WALLET, privateKey: `0x${"ab".repeat(32)}` })),
  walletScopeErrorToResult: vi.fn(),
}));
// The execute is bound to an APPROVED quote (2026-08-27 incident): it claims one
// before it prices anything. This suite's subject is elsewhere, so the claim
// stands in with the quote this very call would have produced.
const claimUniswapExecutionSnapshot = vi.fn();
vi.mock("@vex-agent/tools/protocols/prequote/claim.js", () => ({
  claimSwapExecutionSnapshot: vi.fn(),
  claimUniswapExecutionSnapshot: (...args: unknown[]) => claimUniswapExecutionSnapshot(...args),
}));

vi.mock("@utils/logger.js", () => ({ default: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));

const { UNISWAP_SWAP_HANDLERS } = await import("@vex-agent/tools/protocols/uniswap/handlers/swap.js");

const context = {
  sessionPermission: "full",
  approved: true,
  sessionId: "session-1",
  walletResolution: { source: "default" },
  walletPolicy: { kind: "none" },
} as unknown as ProtocolExecutionContext;

function executeCall(extra: Record<string, unknown> = {}) {
  return UNISWAP_SWAP_HANDLERS["uniswap.swap.execute"]!(
    { chain: "robinhood", tokenIn: TOKEN_IN, tokenOut: TOKEN_OUT, amountIn: "1", ...extra },
    context,
  );
}

describe("uniswap.swap.execute — adversarial (FIX2-W0)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    claimUniswapExecutionSnapshot.mockImplementation(
      claimStandingInForTheParams({ chainId: 4663, weth: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73" }),
    );
    ensureErc20Balance.mockResolvedValue(undefined);
    validateUniswapSpender.mockReturnValue(undefined);
    // Large enough to skip the allowance_reset/allowance planning branches —
    // a single "swap" event is all these tests need.
    readUniswapAllowance.mockResolvedValue(10n ** 30n);
    signUniswapTransaction.mockResolvedValue({
      txHash: SIGNED_TX_HASH, fromAddress: WALLET, nonce: 1, serializedTransaction: "0xSERIALIZED",
    });
    broadcastUniswapTransaction.mockResolvedValue(SIGNED_TX_HASH);
    waitForSuccessfulReceipt.mockResolvedValue({ logs: [] });
    decodeUniswapExecutedLegs.mockReturnValue({ executedAmountInRaw: 1_000_000_000_000_000_000n, executedAmountOutRaw: 999_000n });
    createAgentActivityIntent.mockResolvedValue({ executionId: 1, events: [{ id: 1, eventRole: "swap" }] });
    createAgentActivityPreBroadcastFailure.mockResolvedValue({ executionId: 1, event: {} });
    markActivityBroadcast.mockResolvedValue({ applied: true, row: {} });
    markBroadcastAccepted.mockResolvedValue({ applied: true, row: {} });
    confirmActivityEvent.mockResolvedValue({ applied: true, row: {} });
    failActivityEvent.mockResolvedValue({ applied: true, row: {} });
  });

  it("(a) C14 — a CAS miss on markActivityBroadcast ABORTS before any network broadcast", async () => {
    markActivityBroadcast.mockResolvedValue({ applied: false, row: {} });

    const result = await executeCall();

    expect(broadcastUniswapTransaction).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
  });

  it("(b) C15 — an ambiguous broadcast error never calls failActivityEvent and the result carries txHash", async () => {
    broadcastUniswapTransaction.mockRejectedValue(new Error("timeout waiting for node"));

    const result = await executeCall();

    expect(failActivityEvent).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect((result.data as { txHash?: string } | undefined)?.txHash).toBe(SIGNED_TX_HASH);
    // Characterization of the FULL agent-facing sentence: the safety-critical
    // "Do not retry" AND the self-serve verification path that replaces it.
    expect(result.output).toContain(
      `Do not retry; this attempt is recorded as pending and will resolve automatically. `
      + `You can verify it now yourself with ChainRead (action tx_receipt, chain=4663, txHash=${SIGNED_TX_HASH}).`,
    );
  });

  it("(c) C16 — markBroadcastAccepted throwing after a successful broadcast preserves txHash, never a raw/generic failure", async () => {
    markBroadcastAccepted.mockRejectedValue(new Error("db down"));

    let result: Awaited<ReturnType<typeof executeCall>>;
    try {
      result = await executeCall();
    } catch (err) {
      throw new Error(
        `Expected a bounded ToolResult carrying txHash, got an uncaught throw instead: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    const data = result.data as { txHash?: string } | undefined;
    expect(data?.txHash).toBe(SIGNED_TX_HASH);
  });

  it("(f) C24 — dryRun is hard-rejected, never reaches signing", async () => {
    const result = await executeCall({ dryRun: true });

    expect(result.success).toBe(false);
    expect(result.output).toMatch(/dryRun/i);
    expect(signUniswapTransaction).not.toHaveBeenCalled();
    expect(broadcastUniswapTransaction).not.toHaveBeenCalled();
  });
});
