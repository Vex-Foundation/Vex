/**
 * Swap prequote — reverse cross-venue negative (W0 gap-fill).
 *
 * `gate.test.ts` already pins "VENUE: a kyberswap quote hash can never
 * authorize a uniswap execute". Plan §4.2 requires the guarantee in BOTH
 * directions ("kyber prequote must not satisfy uniswap execute and vice
 * versa"). This file pins the missing reverse direction against the CURRENT
 * implementation: a uniswap-recorded prequote must never satisfy a kyberswap
 * execute. The underlying mechanism (the `provider` field folded into
 * `computePrequoteMatchHash`) is unchanged by the Agent Scan plan — this
 * characterization is expected to keep passing after the teardown and
 * doubles as the "negative cross-venue prequote" target-contract evidence.
 */
import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

import type { SwapPrequote, SafetyVerdict } from "@vex-agent/db/repos/swap-prequotes.js";
import type { ProtocolExecutionContext } from "@vex-agent/tools/protocols/types.js";

type CreateMock = Mock<(input: unknown) => Promise<void>>;
type ResolveMock = Mock<(...args: unknown[]) => string>;
type FindMock = Mock<(s: string, h: string, k: string) => Promise<SwapPrequote | null>>;
type ExistsMock = Mock<(s: string, h: string, k: string) => Promise<boolean>>;

let mockCreate: CreateMock;
let mockResolveSelectedAddress: ResolveMock;
let mockFindLatest: FindMock;
let mockExistsFail: ExistsMock;

function resetMocks() {
  mockCreate = vi.fn<(input: unknown) => Promise<void>>().mockResolvedValue(undefined);
  mockResolveSelectedAddress = vi.fn<(...args: unknown[]) => string>().mockReturnValue("0xWALLET");
  mockFindLatest = vi.fn<(s: string, h: string, k: string) => Promise<SwapPrequote | null>>().mockResolvedValue(null);
  mockExistsFail = vi.fn<(s: string, h: string, k: string) => Promise<boolean>>().mockResolvedValue(false);
}
resetMocks();

vi.mock("@vex-agent/db/repos/swap-prequotes.js", () => ({
  create: (input: unknown) => mockCreate(input),
  findLatestFreshByMatch: (s: string, h: string, k: string) => mockFindLatest(s, h, k),
  existsFreshFailByMatch: (s: string, h: string, k: string) => mockExistsFail(s, h, k),
}));

vi.mock("@vex-agent/tools/internal/wallet/resolve.js", () => ({
  resolveSelectedAddress: (...args: unknown[]) => mockResolveSelectedAddress(...args),
}));

const mod = await import("@vex-agent/tools/protocols/swap-prequote.js");

const SESSION_ID = "00000000-0000-4000-8000-000000000002";
const TOKEN_IN = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const TOKEN_OUT = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function ctx(): ProtocolExecutionContext {
  return {
    sessionPermission: "full",
    approved: true,
    walletResolution: { source: "default" },
    walletPolicy: { kind: "none" },
    sessionId: SESSION_ID,
  };
}

/** Matches `UniswapQuoteResultSchema` (prequote/safety/extract.ts) — the
 * uniswap quote's safety block is `{factory, liquidity, fot}`, NOT the
 * kyber-shaped `{tokenIn, tokenOut}` honeypot block. */
function uniswapQuoteResult(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    chainId: 8453,
    tokenIn: { address: TOKEN_IN, isNative: false },
    tokenOut: { address: TOKEN_OUT, isNative: false },
    safety: {
      factory: { checked: true, allowlisted: true },
      liquidity: { checked: true, usd: 50_000, aboveThreshold: true },
      fot: { suspected: false },
    },
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
    provider: "uniswap",
    chainId: 8453,
    walletAddress: "0xWALLET",
    tokenIn: TOKEN_IN,
    tokenOut: TOKEN_OUT,
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
    createdAt: "2026-07-22T10:00:00.000Z",
    expiresAt: "2099-01-01T00:00:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  resetMocks();
});

describe("VENUE (reverse): a uniswap quote hash can never authorize a kyberswap execute", () => {
  it("records provider 'uniswap', then a kyberswap.swap.execute for the same identity misses (no_quote)", async () => {
    await mod.recordPrequoteFromQuote(
      "uniswap.swap.quote",
      { chain: "base", tokenIn: TOKEN_IN, tokenOut: TOKEN_OUT, amountIn: "1" },
      uniswapQuoteResult(),
      ctx(),
    );
    expect(mockCreate).toHaveBeenCalledTimes(1);
    const recordedHash = (mockCreate.mock.calls[0]![0] as Record<string, unknown>).matchHash as string;
    expect((mockCreate.mock.calls[0]![0] as Record<string, unknown>).provider).toBe("uniswap");

    // The kyberswap execute gate looks up its OWN provider-bound hash — the DB
    // mock only returns a fresh row when the hash matches, so a lookup miss
    // proves the two hashes never collide.
    mockExistsFail.mockResolvedValue(false);
    mockFindLatest.mockImplementation(async (_s, h) =>
      h === recordedHash ? prequoteRow("pass", { matchHash: h }) : null,
    );
    const decision = await mod.evaluatePrequoteGate(
      "kyberswap.swap.execute",
      { chain: "base", tokenIn: TOKEN_IN, tokenOut: TOKEN_OUT, amountIn: "1" },
      ctx(),
    );
    expect(decision.kind).toBe("block");
    if (decision.kind === "block") expect(decision.reason).toBe("no_quote");
    expect(mockFindLatest.mock.calls[0]![1]).not.toBe(recordedHash);
  });

  it("the kyberswap gate hash for the identical identity equals the kyberswap-provider hash (record-side symmetry)", async () => {
    const uniswapHash = mod.computePrequoteMatchHash({
      kind: "swap",
      sessionId: SESSION_ID,
      family: "eip155",
      provider: "uniswap",
      chainId: 8453,
      walletAddress: "0xWALLET",
      tokenIn: TOKEN_IN,
      tokenOut: TOKEN_OUT,
      amount: "1",
      recipient: "0xWALLET",
      approveExact: false,
      slippageBps: "",
    });
    mockExistsFail.mockResolvedValue(false);
    mockFindLatest.mockResolvedValue(null);
    const decision = await mod.evaluatePrequoteGate(
      "kyberswap.swap.execute",
      { chain: "base", tokenIn: TOKEN_IN, tokenOut: TOKEN_OUT, amountIn: "1" },
      ctx(),
    );
    expect(decision.kind).toBe("block");
    expect(mockFindLatest.mock.calls[0]![1]).not.toBe(uniswapHash);
    const kyberHash = mod.computePrequoteMatchHash({
      kind: "swap",
      sessionId: SESSION_ID,
      family: "eip155",
      provider: "kyberswap",
      chainId: 8453,
      walletAddress: "0xWALLET",
      tokenIn: TOKEN_IN,
      tokenOut: TOKEN_OUT,
      amount: "1",
      recipient: "0xWALLET",
      approveExact: false,
      slippageBps: "",
    });
    expect(mockFindLatest.mock.calls[0]![1]).toBe(kyberHash);
  });
});
