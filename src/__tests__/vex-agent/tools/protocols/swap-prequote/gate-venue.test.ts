import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

import { SOL_MINT } from "@tools/solana-ecosystem/shared/solana-constants.js";
import { NATIVE_TOKEN_ADDRESS } from "@tools/kyberswap/constants.js";
import { ErrorCodes, VexError } from "../../../../../errors.js";
import type { SwapPrequote, SafetyVerdict } from "@vex-agent/db/repos/swap-prequotes.js";
import type { ProtocolExecutionContext } from "@vex-agent/tools/protocols/types.js";

type CreateMock = Mock<(input: unknown) => Promise<void>>;
type ResolveMock = Mock<(...args: unknown[]) => string>;
type FindMock = Mock<(s: string, h: string, k: string) => Promise<SwapPrequote | null>>;
type ExistsMock = Mock<(s: string, h: string, k: string) => Promise<boolean>>;
type JupiterMock = Mock<(q: string) => Promise<{ address: string }>>;

const SESSION_ID = "00000000-0000-4000-8000-000000000001";
const GATE_TOKEN_IN = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const GATE_TOKEN_OUT = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const SOLANA_MINT_A = "FooMintCaseSensitiveABC123";
const EVM_PARAMS = {
  chain: "base",
  tokenIn: GATE_TOKEN_IN,
  tokenOut: GATE_TOKEN_OUT,
  amountIn: "1",
};
const SOL_PARAMS = { tokenIn: SOLANA_MINT_A, tokenOut: SOL_MINT, amountIn: "1" };

let mockCreate: CreateMock;
let mockResolveSelectedAddress: ResolveMock;
let mockFindLatest: FindMock;
let mockExistsFail: ExistsMock;
let mockRequireJupiter: JupiterMock;

function resetMocks(): void {
  mockCreate = vi.fn<(input: unknown) => Promise<void>>().mockResolvedValue(undefined);
  mockResolveSelectedAddress = vi.fn<(...args: unknown[]) => string>().mockReturnValue("0xWALLET");
  mockFindLatest = vi.fn<(s: string, h: string, k: string) => Promise<SwapPrequote | null>>().mockResolvedValue(null);
  mockExistsFail = vi.fn<(s: string, h: string, k: string) => Promise<boolean>>().mockResolvedValue(false);
  mockRequireJupiter = vi.fn<(q: string) => Promise<{ address: string }>>().mockImplementation(async (q) => ({ address: q }));
}
resetMocks();

vi.mock("@vex-agent/db/repos/swap-prequotes.js", () => ({
  create: (input: unknown) => mockCreate(input),
  findLatestFreshByMatch: (sessionId: string, matchHash: string, kind: string) => mockFindLatest(sessionId, matchHash, kind),
  existsFreshFailByMatch: (sessionId: string, matchHash: string, kind: string) => mockExistsFail(sessionId, matchHash, kind),
}));
vi.mock("@vex-agent/tools/internal/wallet/resolve.js", () => ({
  resolveSelectedAddress: (...args: unknown[]) => mockResolveSelectedAddress(...args),
}));
vi.mock("@tools/solana-ecosystem/jupiter/jupiter-tokens/service.js", () => ({
  requireJupiterResolvedToken: (query: string) => mockRequireJupiter(query),
}));

const mod = await import("@vex-agent/tools/protocols/swap-prequote.js");

function ctx(overrides: Partial<ProtocolExecutionContext> = {}): ProtocolExecutionContext {
  return {
    sessionPermission: "full",
    approved: true,
    walletResolution: { source: "default" },
    walletPolicy: { kind: "none" },
    sessionId: SESSION_ID,
    ...overrides,
  };
}

function prequoteRow(verdict: SafetyVerdict, overrides: Partial<SwapPrequote> = {}): SwapPrequote {
  return {
    prequoteId: "prequote-row-1",
    sessionId: SESSION_ID,
    matchHash: "h".repeat(64),
    kind: "swap",
    family: "eip155",
    provider: "kyberswap",
    chainId: 8453,
    walletAddress: "0xWALLET",
    tokenIn: GATE_TOKEN_IN,
    tokenOut: GATE_TOKEN_OUT,
    amount: "1",
    slippageBps: 50,
    safetyVerdict: verdict,
    safetyDetail: {},
    routeRef: null,
    // Migration 095: a row that predates the claim lane reads as an
    // executable, unclaimed quote. It authorizes nothing on its own - the
    // claim additionally requires a stored route snapshot.
    eligibilityKind: "executable",
    claimedAt: null,
    claimedBy: null,
    createdAt: "2026-06-04T10:00:00.000Z",
    expiresAt: "2099-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function evmResult(
  tokenInLeg: Record<string, unknown>,
  tokenOutLeg: Record<string, unknown>,
): Record<string, unknown> {
  return {
    chain: "base",
    chainId: 8453,
    tokenIn: { address: GATE_TOKEN_IN, symbol: "AAA", decimals: 18 },
    tokenOut: { address: GATE_TOKEN_OUT, symbol: "BBB", decimals: 18 },
    routeSummary: { foo: "bar" },
    routerAddress: "0xROUTER",
    safety: { tokenIn: tokenInLeg, tokenOut: tokenOutLeg },
  };
}

beforeEach(() => {
  resetMocks();
});

// ── Wave-2c venue binding (LOCKED #4) — cross-venue quote→execute REJECTED ──

  it("VENUE: a kyberswap quote hash can never authorize a uniswap execute (same identity)", async () => {
    // The hash a kyber QUOTE would have recorded for this exact identity.
    const kyberHash = mod.computePrequoteMatchHash({
      kind: "swap",
      sessionId: SESSION_ID,
      family: "eip155",
      provider: "kyberswap",
      chainId: 8453,
      walletAddress: "0xWALLET",
      tokenIn: GATE_TOKEN_IN,
      tokenOut: GATE_TOKEN_OUT,
      amount: "1",
      recipient: "0xWALLET",
      approveExact: false,
      slippageBps: "",
    });
    // A UNISWAP execute for the SAME tokens/amount/chain/wallet looks up a
    // DIFFERENT hash — so the kyber prequote row can never match → no_quote.
    mockExistsFail.mockResolvedValue(false);
    mockFindLatest.mockResolvedValue(null);
    const d = await mod.evaluatePrequoteGate("uniswap.swap.execute", EVM_PARAMS, ctx());
    expect(d.kind).toBe("block");
    if (d.kind === "block") expect(d.reason).toBe("no_quote");
    expect(mockFindLatest.mock.calls[0]![1]).not.toBe(kyberHash);
    // And the uniswap gate hash equals the uniswap-provider hash (record-side
    // symmetry: the uniswap quote recorder pins provider "uniswap").
    const uniswapHash = mod.computePrequoteMatchHash({
      kind: "swap",
      sessionId: SESSION_ID,
      family: "eip155",
      provider: "uniswap",
      chainId: 8453,
      walletAddress: "0xWALLET",
      tokenIn: GATE_TOKEN_IN,
      tokenOut: GATE_TOKEN_OUT,
      amount: "1",
      recipient: "0xWALLET",
      approveExact: false,
      slippageBps: "",
    });
    expect(mockFindLatest.mock.calls[0]![1]).toBe(uniswapHash);
  });

  it("VENUE: uniswap execute on Robinhood Chain (4663) is gate-able (de-kyber-coupled chain resolution)", async () => {
    // "robinhood" is NOT a KyberSwap slug — pre-2c the EVM identity builder would
    // have thrown (gate_error). Now the uniswap provider branch resolves 4663 via
    // the local registry and the gate computes a real identity.
    mockExistsFail.mockResolvedValue(false);
    mockFindLatest.mockResolvedValue(prequoteRow("pass", { provider: "uniswap", chainId: 4663 }));
    const d = await mod.evaluatePrequoteGate(
      "uniswap.swap.execute",
      { ...EVM_PARAMS, chain: "robinhood" },
      ctx(),
    );
    expect(d.kind).toBe("allow");
    const expected = mod.computePrequoteMatchHash({
      kind: "swap",
      sessionId: SESSION_ID,
      family: "eip155",
      provider: "uniswap",
      chainId: 4663,
      walletAddress: "0xWALLET",
      tokenIn: GATE_TOKEN_IN,
      tokenOut: GATE_TOKEN_OUT,
      amount: "1",
      recipient: "0xWALLET",
      approveExact: false,
      slippageBps: "",
    });
    expect(mockFindLatest.mock.calls[0]![1]).toBe(expected);
  });

  // ── Uniswap native-leg identity — record→gate hash collision ────────────
  //
  // The uniswap quote echoes its routing WETH address for a native leg
  // (isNative: true) while the gate canonicalizes execute-time "native"/ETH
  // input to NATIVE_TOKEN_ADDRESS. The recorder must store the SAME sentinel
  // or a native-leg quote can never authorize its execute (live bug: every
  // ETH-leg uniswap swap on Robinhood 4663 blocked with no_quote).

  const ROBINHOOD_WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
  const UNISWAP_SAFETY_PASS = {
    factory: { checked: true, allowlisted: true },
    liquidity: { checked: true, usd: 50_000, aboveThreshold: true },
    fot: { suspected: false },
  };

  it("UNISWAP native IN: a WETH-echoed native-leg quote records the sentinel and authorizes a 'native' execute", async () => {
    await mod.recordPrequoteFromQuote(
      "uniswap.swap.quote",
      { chain: "robinhood", tokenIn: "native", tokenOut: GATE_TOKEN_OUT, amountIn: "0.001" },
      {
        chainId: 4663,
        tokenIn: { address: ROBINHOOD_WETH, isNative: true },
        tokenOut: { address: GATE_TOKEN_OUT, isNative: false },
        safety: UNISWAP_SAFETY_PASS,
      },
      ctx(),
    );
    expect(mockCreate).toHaveBeenCalledTimes(1);
    const row = mockCreate.mock.calls[0]![0] as Record<string, unknown>;
    expect(row.tokenIn).toBe(NATIVE_TOKEN_ADDRESS);
    expect(row.tokenOut).toBe(GATE_TOKEN_OUT);
    const recordedHash = String(row.matchHash);

    resetMocks();
    mockExistsFail.mockResolvedValue(false);
    mockFindLatest.mockResolvedValue(
      prequoteRow("pass", { provider: "uniswap", chainId: 4663, matchHash: recordedHash }),
    );
    const d = await mod.evaluatePrequoteGate(
      "uniswap.swap.execute",
      { chain: "robinhood", tokenIn: "native", tokenOut: GATE_TOKEN_OUT, amountIn: "0.001" },
      ctx(),
    );
    expect(d.kind).toBe("allow");
    expect(mockFindLatest.mock.calls[0]![1]).toBe(recordedHash);
  });

  it("UNISWAP native OUT: a token→ETH quote records the sentinel out-leg and matches an 'ETH' execute hash", async () => {
    await mod.recordPrequoteFromQuote(
      "uniswap.swap.quote",
      { chain: "robinhood", tokenIn: GATE_TOKEN_IN, tokenOut: "ETH", amountIn: "5" },
      {
        chainId: 4663,
        tokenIn: { address: GATE_TOKEN_IN, isNative: false },
        tokenOut: { address: ROBINHOOD_WETH, isNative: true },
        safety: UNISWAP_SAFETY_PASS,
      },
      ctx(),
    );
    expect(mockCreate).toHaveBeenCalledTimes(1);
    const row = mockCreate.mock.calls[0]![0] as Record<string, unknown>;
    expect(row.tokenOut).toBe(NATIVE_TOKEN_ADDRESS);
    const recordedHash = String(row.matchHash);

    resetMocks();
    mockExistsFail.mockResolvedValue(false);
    mockFindLatest.mockResolvedValue(
      prequoteRow("pass", { provider: "uniswap", chainId: 4663, matchHash: recordedHash }),
    );
    const d = await mod.evaluatePrequoteGate(
      "uniswap.swap.execute",
      { chain: "robinhood", tokenIn: GATE_TOKEN_IN, tokenOut: "ETH", amountIn: "5" },
      ctx(),
    );
    expect(d.kind).toBe("allow");
    expect(mockFindLatest.mock.calls[0]![1]).toBe(recordedHash);
  });

  it("VENUE: kyberswap flows are byte-identical — the kyber gate hash did not change shape", async () => {
    mockExistsFail.mockResolvedValue(false);
    mockFindLatest.mockResolvedValue(prequoteRow("pass"));
    await mod.evaluateSwapPrequoteGate("kyberswap.swap.execute", EVM_PARAMS, ctx());
    const kyberHash = mod.computePrequoteMatchHash({
      kind: "swap",
      sessionId: SESSION_ID,
      family: "eip155",
      provider: "kyberswap",
      chainId: 8453,
      walletAddress: "0xWALLET",
      tokenIn: GATE_TOKEN_IN,
      tokenOut: GATE_TOKEN_OUT,
      amount: "1",
      recipient: "0xWALLET",
      approveExact: false,
      slippageBps: "",
    });
});

