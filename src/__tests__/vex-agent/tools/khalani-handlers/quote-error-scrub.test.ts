/**
 * `khalani.quote.get` — every failure reason reaches the agent through the
 * scrub boundary (FIX5).
 *
 * Two catches in `khalani/handlers/read.ts` returned raw `err.message`,
 * bypassing `summarizeProtocolError` entirely:
 *
 *  - the pre-quote route guard, which reads Khalani's LIVE registry, so its
 *    throw can carry PROVIDER-controlled text (`mapKhalaniError` builds its
 *    message straight from the response body) — a confirmed leak;
 *  - chain-family resolution, whose text is locally authored but echoes the
 *    MODEL-SUPPLIED `fromChain`/`toChain` verbatim, so model-injected content
 *    was emitted unredacted.
 *
 * Only the two collaborators these paths use are mocked; the handler's own
 * control flow is real.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";

const mockResolvePrequoteRoute = vi.fn();
vi.mock("@tools/khalani/prequote-route-guard.js", () => ({
  resolveKhalaniPrequoteRoute: (...a: unknown[]) => mockResolvePrequoteRoute(...a),
}));

const mockGetCachedKhalaniChains = vi.fn();
const mockResolveChainId = vi.fn();
const mockGetChainFamily = vi.fn();
vi.mock("@tools/khalani/chains.js", () => ({
  getCachedKhalaniChains: (...a: unknown[]) => mockGetCachedKhalaniChains(...a),
  resolveChainId: (...a: unknown[]) => mockResolveChainId(...a),
  getChainFamily: (...a: unknown[]) => mockGetChainFamily(...a),
}));

const { READ_HANDLERS } = await import(
  "@vex-agent/tools/protocols/khalani/handlers/read.js"
);
const { VexError, ErrorCodes } = await import("../../../../errors.js");

const CTX = {
  sessionPermission: "restricted" as const,
  approved: false,
  walletResolution: { source: "default" as const, evm: null, solana: null },
  walletPolicy: { kind: "none" as const },
};

const PARAMS = {
  fromChain: "1",
  toChain: "8453",
  fromToken: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  toToken: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  amountRaw: "1000000",
};

async function quoteGet(params: Record<string, unknown> = PARAMS) {
  return READ_HANDLERS["khalani.quote.get"]!(params, CTX);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetCachedKhalaniChains.mockResolvedValue([]);
  mockResolvePrequoteRoute.mockResolvedValue({ outcome: "routable" });
  mockResolveChainId.mockImplementation((input: string) => Number(input));
  mockGetChainFamily.mockReturnValue("eip155");
});

describe("khalani.quote.get — route-guard failures pass the scrub boundary", () => {
  it("redacts PROVIDER-controlled text carried by a mapped Khalani error", async () => {
    // `mapKhalaniError` copies `body.message` verbatim, so anything the
    // provider writes lands in this throw.
    mockResolvePrequoteRoute.mockRejectedValue(
      new VexError(
        ErrorCodes.KHALANI_API_ERROR,
        'registry unavailable https://khalani.internal/admin?token=PROVIDERSECRET1 {"trace":"deep"}',
      ),
    );

    const result = await quoteGet();

    expect(result.success).toBe(false);
    expect(result.output).toContain("khalani.quote.get failed:");
    expect(result.output).toContain("registry unavailable");
    expect(result.output).not.toContain("PROVIDERSECRET1");
    expect(result.output).not.toContain("khalani.internal");
    expect(result.output).not.toContain('"trace"');
  });

  it("bounds an unbounded provider message at the scrub cap", async () => {
    mockResolvePrequoteRoute.mockRejectedValue(
      new VexError(ErrorCodes.KHALANI_API_ERROR, "x".repeat(5000)),
    );

    const result = await quoteGet();

    expect(result.output.length).toBeLessThan(420);
    expect(result.output).toContain("…");
  });

  it("still surfaces an ordinary provider reason unchanged", async () => {
    mockResolvePrequoteRoute.mockRejectedValue(
      new VexError(ErrorCodes.KHALANI_UNSUPPORTED_CHAIN, "Unsupported chain: narnia"),
    );

    const result = await quoteGet();

    expect(result.output).toBe("khalani.quote.get failed: Unsupported chain: narnia");
  });
});

describe("khalani.quote.get — chain-family failures pass the scrub boundary", () => {
  it("redacts a URL injected through the model-supplied fromChain", async () => {
    mockResolveChainId.mockImplementation((input: string) => {
      throw new VexError(
        ErrorCodes.KHALANI_UNSUPPORTED_CHAIN,
        `Unsupported chain: ${input}`,
        "Run `vex khalani chains --json` to inspect supported chains.",
      );
    });

    const result = await quoteGet({
      ...PARAMS,
      fromChain: "https://evil.example.com/x?key=LEAKEDKEY123",
    });

    expect(result.success).toBe(false);
    expect(result.output).toContain("Unsupported chain:");
    expect(result.output).not.toContain("LEAKEDKEY123");
    expect(result.output).not.toContain("evil.example.com");
    expect(result.output).toContain("[url]");
  });

  it("redacts a key-shaped string injected through the model-supplied toChain", async () => {
    mockGetChainFamily.mockImplementation(() => {
      throw new VexError(
        ErrorCodes.KHALANI_UNSUPPORTED_CHAIN,
        "Chain apiKey=sk-or-v1-abcdef0123456789 is not in the current Khalani registry.",
      );
    });

    const result = await quoteGet();

    expect(result.success).toBe(false);
    expect(result.output).not.toContain("sk-or-v1-abcdef0123456789");
  });
});
