/**
 * `kyberswap.swap.execute` — handler-level ADVERSARIAL tests (FIX2-W0,
 * Codex final-review round 1, bound in `agents_dm/agent-scan-factory.md`
 * "Coordinator addendum 2" as C14/C15/C16/C24).
 *
 * These drive the REAL handler (`KYBERSWAP_HANDLERS["kyberswap.swap.execute"]`)
 * with the REAL `signStageBroadcast` primitive (kept real via `importActual`
 * on `@tools/kyberswap/evm-utils.js` — mocking it away, as the sibling
 * `execute-safety-gate.test.ts` does for its own unrelated concern, would
 * hide exactly the bug this file exists to catch). Only the viem clients
 * (`getKyberEvmClients`) are faked, so the sign→stage→broadcast sequence
 * really runs, with a controllable `sendRawTransaction`/`waitForTransactionReceipt`.
 *
 * Mock recipe otherwise mirrors `kyberswap-handlers/execute-safety-gate.test.ts`
 * (same fixture shapes for the aggregator/token-api responses) — read-only
 * reuse of an established, working pattern; that file is untouched.
 *
 * (a) C14 — a CAS miss on `markActivityBroadcast` (`onHashStaged`'s hook) must
 *     ABORT before any network send. EXPECTED RED today: `swap.ts` only warns
 *     on `!res.applied` and returns normally, so `signStageBroadcast` proceeds
 *     to `sendRawTransaction` regardless.
 * (b) C15 — an ambiguous submission (`sendRawTransaction` throws) must leave
 *     the row pending (never call `failActivityEvent`) and the result must
 *     carry the staged `txHash`. Kyber's `ambiguous` branch already does
 *     both — pinned here as a regression guard (EXPECTED GREEN today).
 * (c) C16 — a post-broadcast bookkeeping failure (`confirmActivityEvent`
 *     throwing on the CONFIRMED swap event) must be a bounded catch: the
 *     result still carries the txHash and is never a raw/generic failure.
 *     Kyber already wraps this in try/catch — pinned as a regression guard
 *     (EXPECTED GREEN today).
 * (f) C24 (mirrors C8's finding for Uniswap) — `dryRun` is hard-rejected,
 *     never reaches signing. Kyber already does this — pinned as a
 *     regression guard (EXPECTED GREEN today).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProtocolExecutionContext } from "@vex-agent/tools/protocols/types.js";

type WalletResolveModule = typeof import("@vex-agent/tools/internal/wallet/resolve.js");
import { ErrorCodes, VexError } from "../../../errors.js";

const SESSION_EVM = {
  family: "eip155" as const,
  address: "0x1234567890abcdef1234567890abcdef12345678" as const,
  privateKey: ("0x" + "ab".repeat(32)) as `0x${string}`,
};
const mockResolveSigningWallet = vi.fn<WalletResolveModule["resolveSigningWallet"]>(() => SESSION_EVM);
const mockResolveSelectedAddress = vi.fn<WalletResolveModule["resolveSelectedAddress"]>(() => SESSION_EVM.address);

vi.mock("@vex-agent/tools/internal/wallet/resolve.js", () => ({
  resolveSigningWallet: (...args: Parameters<WalletResolveModule["resolveSigningWallet"]>) => mockResolveSigningWallet(...args),
  resolveSelectedAddress: (...args: Parameters<WalletResolveModule["resolveSelectedAddress"]>) => mockResolveSelectedAddress(...args),
  walletScopeErrorToResult: (err: unknown) => ({
    success: false,
    output: err instanceof Error ? err.message : String(err),
  }),
}));

function ctx(over: Partial<ProtocolExecutionContext> = {}): ProtocolExecutionContext {
  return {
    sessionPermission: "full",
    approved: true,
    walletResolution: { source: "default" },
    walletPolicy: { kind: "none" },
    sessionId: "session-1",
    ...over,
  };
}

const mockPlanKyberAllowance = vi.fn();
const mockEnsureErc20Balance = vi.fn();
const mockDecodeKyberSwapSettlement = vi.fn();
const mockReadErc20Metadata = vi.fn(async (_slug: string, address: string) => ({
  address, symbol: "TKN", name: "Token", decimals: 18, isNative: false as const,
}));

// The controllable "network" — these three calls stand in for the wire.
// `estimateGas` is required because the REAL `signStageBroadcast` estimates
// explicitly and signs `gasLimitWithHeadroom(estimate)` (the fix for the Base
// out-of-gas losses); without it these adversarial cases would throw at
// estimation and never reach the broadcast behaviour they exist to pin.
const sendRawTransaction = vi.fn();
const waitForTransactionReceipt = vi.fn();
const estimateGas = vi.fn();
const prepareTransactionRequest = vi.fn().mockResolvedValue({ nonce: 1 });
const signTransaction = vi.fn().mockResolvedValue("0x1234");
const fakeWalletClient = {
  account: { address: SESSION_EVM.address },
  chain: {},
  prepareTransactionRequest: (...a: unknown[]) => prepareTransactionRequest(...a),
  signTransaction: (...a: unknown[]) => signTransaction(...a),
};
const fakePublicClient = {
  sendRawTransaction: (...a: unknown[]) => sendRawTransaction(...a),
  waitForTransactionReceipt: (...a: unknown[]) => waitForTransactionReceipt(...a),
  estimateGas: (...a: unknown[]) => estimateGas(...a),
};

// `signStageBroadcast` stays REAL (importActual) — only the client factory
// and the surrounding preflight/decode helpers are faked.
vi.mock("@tools/kyberswap/evm-utils.js", async (importActual) => {
  const actual = await importActual<typeof import("@tools/kyberswap/evm-utils.js")>();
  return {
    ...actual,
    getKyberEvmClients: () => ({ publicClient: fakePublicClient, walletClient: fakeWalletClient }),
    planKyberAllowance: (...args: unknown[]) => mockPlanKyberAllowance(...args),
    buildApproveCalldata: vi.fn(() => "0xapprove"),
    decodeKyberSwapSettlement: (...args: unknown[]) => mockDecodeKyberSwapSettlement(...args),
    readErc20Metadata: (...args: [string, string]) => mockReadErc20Metadata(...args),
    verifyRouterAddress: vi.fn(),
  };
});

vi.mock("@tools/evm-chains/erc20-balance-guard.js", () => ({
  ensureErc20Balance: (...args: unknown[]) => mockEnsureErc20Balance(...args),
}));

const mockGetHoneypotFotInfo = vi.fn().mockResolvedValue({ isHoneypot: false, isFOT: false, tax: 0 });
vi.mock("@tools/kyberswap/token-api/client.js", () => ({
  getKyberTokenApiClient: () => ({
    searchTokens: vi.fn().mockResolvedValue([]),
    getHoneypotFotInfo: (...args: [number, string]) => mockGetHoneypotFotInfo(...args),
  }),
}));

const mockGetRoute = vi.fn();
const mockBuildRoute = vi.fn();
vi.mock("@tools/kyberswap/aggregator/client.js", () => ({
  getKyberAggregatorClient: () => ({
    getRoute: (...args: unknown[]) => mockGetRoute(...args),
    buildRoute: (...args: unknown[]) => mockBuildRoute(...args),
  }),
}));

const mockCreateAgentActivityIntent = vi.fn();
const mockCreateAgentActivityPreBroadcastFailure = vi.fn().mockResolvedValue({ executionId: 1, event: { id: 1 } });
const mockMarkActivityBroadcast = vi.fn();
const mockMarkBroadcastAccepted = vi.fn().mockResolvedValue({ applied: true, row: {} });
const mockConfirmActivityEvent = vi.fn().mockResolvedValue({ applied: true, row: {} });
const mockFailActivityEvent = vi.fn().mockResolvedValue({ applied: true, row: {} });

vi.mock("@vex-agent/db/repos/agent-activity.js", () => ({
  createAgentActivityIntent: (...args: unknown[]) => mockCreateAgentActivityIntent(...args),
  createAgentActivityPreBroadcastFailure: (...args: unknown[]) => mockCreateAgentActivityPreBroadcastFailure(...args),
  markActivityBroadcast: (...args: unknown[]) => mockMarkActivityBroadcast(...args),
  markBroadcastAccepted: (...args: unknown[]) => mockMarkBroadcastAccepted(...args),
  confirmActivityEvent: (...args: unknown[]) => mockConfirmActivityEvent(...args),
  failActivityEvent: (...args: unknown[]) => mockFailActivityEvent(...args),
}));

vi.mock("@vex-agent/db/repos/tracked-tokens.js", () => ({
  pinTrackedToken: vi.fn().mockResolvedValue({ inserted: true }),
}));

vi.mock("@utils/logger.js", () => {
  const stub = { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() };
  return { default: stub, logger: stub };
});

const {
  compliantSwapCalldata,
  compliantRoutePaths,
} = await import("../../kyberswap/fixtures/route-build/compliant-swap-build.js");

const { KYBERSWAP_HANDLERS } = await import("../../../vex-agent/tools/protocols/kyberswap/handlers.js");

describe("kyberswap.swap.execute — adversarial (FIX2-W0)", () => {
  const TOKEN_A = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
  const TOKEN_B = "0xdAC17F958D2ee523a2206206994597C13D831ec7";
  const EXEC_CTX = ctx({ sessionPermission: "full", approved: true });

  function executeCall(extra: Record<string, unknown> = {}) {
    return KYBERSWAP_HANDLERS["kyberswap.swap.execute"]!(
      { chain: "ethereum", tokenIn: TOKEN_A, tokenOut: TOKEN_B, amountIn: "1", ...extra },
      EXEC_CTX,
    );
  }

  beforeEach(() => {
    mockGetHoneypotFotInfo.mockReset().mockResolvedValue({ isHoneypot: false, isFOT: false, tax: 0 });
    mockGetRoute.mockReset().mockResolvedValue({
      data: {
        routeSummary: {
          amountIn: "1000000", amountOut: "999000", gasUsd: "0.5", routeID: "r1", checksum: "c1",
          // A route summary ALWAYS carries its paths, and the pre-sign guard
          // reads them to decide which pools the build may fund.
          route: compliantRoutePaths({
            srcToken: TOKEN_A, dstToken: TOKEN_B, amountIn: 10n ** 18n, quotedNetOutRaw: "999000",
          }),
        },
        routerAddress: "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5",
      },
    });
    // REAL router calldata (re-encoded from a captured build) — the handler
    // decodes and asserts it before signing, so a placeholder string would be
    // refused at the pre-sign gate and never reach the behaviour under test.
    mockBuildRoute.mockReset().mockResolvedValue({
      data: {
        routerAddress: "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5",
        data: compliantSwapCalldata({
          srcToken: TOKEN_A, dstToken: TOKEN_B, dstReceiver: SESSION_EVM.address,
          amountIn: 10n ** 18n, quotedNetOutRaw: "999000", slippageBps: 50,
        }),
        transactionValue: "0",
        amountIn: "1000000", amountOut: "999000",
        amountInUsd: "1", amountOutUsd: "1", gasUsd: "0.1",
      },
    });
    mockReadErc20Metadata.mockReset().mockImplementation(async (_slug: string, address: string) => ({
      address, symbol: "TKN", name: "Token", decimals: 18, isNative: false as const,
    }));
    mockPlanKyberAllowance.mockReset().mockResolvedValue({ needsReset: false, needsApprove: false });
    mockEnsureErc20Balance.mockReset().mockResolvedValue(undefined);
    mockCreateAgentActivityIntent.mockReset().mockResolvedValue({ executionId: 1, events: [{ id: 1 }] });
    mockDecodeKyberSwapSettlement.mockReset().mockReturnValue(null);
    mockMarkActivityBroadcast.mockReset().mockResolvedValue({ applied: true, row: {} });
    mockMarkBroadcastAccepted.mockReset().mockResolvedValue({ applied: true, row: {} });
    mockConfirmActivityEvent.mockReset().mockResolvedValue({ applied: true, row: {} });
    mockFailActivityEvent.mockReset().mockResolvedValue({ applied: true, row: {} });

    prepareTransactionRequest.mockReset().mockResolvedValue({ nonce: 1 });
    signTransaction.mockReset().mockResolvedValue("0x1234");
    sendRawTransaction.mockReset().mockResolvedValue(undefined);
    waitForTransactionReceipt.mockReset().mockResolvedValue({ status: "success", logs: [] });
    // A router-call-sized estimate; the signer doubles it (headroom policy).
    estimateGas.mockReset().mockResolvedValue(1_026_236n);
  });

  it("(a) C14 — a CAS miss on markActivityBroadcast ABORTS before any network send", async () => {
    mockMarkActivityBroadcast.mockResolvedValue({ applied: false, row: {} });

    const result = await executeCall();

    // The whole point of the hook: nothing may be sent once the durable stage
    // write missed its CAS. EXPECTED RED today (swap.ts only warns + proceeds).
    expect(sendRawTransaction).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
  });

  it("(b) C15 — an ambiguous submission (sendRawTransaction throws) never calls failActivityEvent and carries txHash", async () => {
    sendRawTransaction.mockRejectedValue(new Error("timeout waiting for node"));

    const result = await executeCall();

    expect(mockFailActivityEvent).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect((result.data as { txHash?: string } | undefined)?.txHash).toBeDefined();
    expect((result.data as { status?: string } | undefined)?.status).toBe("pending");
    // Characterization of the FULL agent-facing sentence: the safety-critical
    // "Do not retry" AND the self-serve verification path that replaces it.
    const txHash = (result.data as { txHash: string }).txHash;
    expect(result.output).toContain(
      `Do not retry; this attempt is recorded as pending and will resolve automatically. `
      + `You can verify it now yourself with chain_read (action tx_receipt, chain=1, txHash=${txHash}).`,
    );
  });

  it("(c) C16 — confirmActivityEvent throwing on a confirmed swap preserves txHash, never a raw/generic failure", async () => {
    // A non-null decode so the handler reaches the confirmActivityEvent call
    // for the swap-role event (a null decode short-circuits to
    // "confirmed_pending_amounts" before ever calling confirm).
    mockDecodeKyberSwapSettlement.mockReturnValue({ amountInRaw: "1000000000000000000", amountOutRaw: "999000" });
    mockConfirmActivityEvent.mockRejectedValue(new Error("db down"));

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
    expect(data?.txHash).toBeDefined();
  });

  it("(f) C24 — dryRun is hard-rejected, never reaches signing", async () => {
    const result = await executeCall({ dryRun: true });

    expect(result.success).toBe(false);
    expect(result.output).toMatch(/dryRun/i);
    expect(prepareTransactionRequest).not.toHaveBeenCalled();
    expect(sendRawTransaction).not.toHaveBeenCalled();
  });
});
