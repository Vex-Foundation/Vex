/**
 * `activity-token-leg.ts` — the ONE owner of `agent_activity` token-leg shape
 * for Solana/Jupiter mutations.
 *
 * Pins the two properties a real-funds signing path depends on:
 *   1. EXACTNESS — `amountHuman` is BigInt string math, so a u64 amount above
 *      `Number.MAX_SAFE_INTEGER` round-trips digit-for-digit (a `Number`/
 *      `parseFloat` division would silently lose the tail).
 *   2. FAIL-SOFT — a metadata lookup that throws, hangs, or has no record of
 *      the mint degrades the leg to `tokenAddress` + `amountRaw` (exactly the
 *      pre-fix behaviour) instead of propagating into the mutation.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockResolveJupiterToken = vi.fn();
vi.mock("@tools/solana-ecosystem/jupiter/jupiter-tokens/service.js", () => ({
  resolveJupiterToken: (...args: unknown[]) => mockResolveJupiterToken(...args),
}));

const mockLoggerWarn = vi.fn();
vi.mock("@utils/logger.js", () => {
  const stub = { warn: mockLoggerWarn, info: vi.fn(), debug: vi.fn(), error: vi.fn() };
  return { default: stub, logger: stub };
});

const { buildActivityTokenLeg, resolveActivityTokenLeg } = await import(
  "@vex-agent/tools/protocols/solana-jupiter/activity-token-leg.js"
);

const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

describe("buildActivityTokenLeg — exact-decimal amountHuman (string math only)", () => {
  it("formats a raw atomic amount against the token's decimals (500000 @ 6 → 0.5)", () => {
    expect(
      buildActivityTokenLeg({
        tokenAddress: USDC_MINT, tokenSymbol: "USDC", tokenDecimals: 6, amountRaw: "500000",
      }),
    ).toEqual({
      tokenAddress: USDC_MINT, tokenSymbol: "USDC", tokenDecimals: 6,
      amountHuman: "0.5", amountRaw: "500000",
    });
  });

  it("keeps EVERY digit of a u64 amount beyond Number.MAX_SAFE_INTEGER (a float divide would lose the tail)", () => {
    // 18446744073709551615 = u64 max; > 2^53-1, so Number() cannot hold it.
    const u64Max = "18446744073709551615";
    expect(Number(u64Max)).toBeGreaterThan(Number.MAX_SAFE_INTEGER);

    const leg = buildActivityTokenLeg({
      tokenAddress: "So11111111111111111111111111111111111111112",
      tokenSymbol: "SOL", tokenDecimals: 9, amountRaw: u64Max,
    });

    expect(leg.amountHuman).toBe("18446744073.709551615");
    // Round-trip: the human string times 10^decimals is the raw sibling again.
    expect(leg.amountHuman!.replace(".", "")).toBe(u64Max);
    // The approximate path the money convention forbids would NOT match.
    expect(String(Number(u64Max) / 1e9)).not.toBe(leg.amountHuman);
  });

  it("emits a whole-number human amount for a zero-decimals token", () => {
    expect(
      buildActivityTokenLeg({ tokenAddress: "MintZero", tokenSymbol: "ZERO", tokenDecimals: 0, amountRaw: "42" }).amountHuman,
    ).toBe("42");
  });

  it("has no amountHuman when the magnitude is genuinely unknown (close-all sentinel) but keeps symbol/decimals", () => {
    const leg = buildActivityTokenLeg({ tokenAddress: USDC_MINT, tokenSymbol: "USDC", tokenDecimals: 6 });

    expect(leg).toEqual({ tokenAddress: USDC_MINT, tokenSymbol: "USDC", tokenDecimals: 6 });
    expect(leg.amountHuman).toBeUndefined();
    expect(leg.amountRaw).toBeUndefined();
  });

  it("keeps the raw sibling and drops only the human field when the provider amount is not an integer string", () => {
    const leg = buildActivityTokenLeg({
      tokenAddress: USDC_MINT, tokenSymbol: "USDC", tokenDecimals: 6, amountRaw: "not-a-number",
    });

    expect(leg.amountRaw).toBe("not-a-number");
    expect(leg.amountHuman).toBeUndefined();
  });

  it("drops only the human field when provider decimals are nonsense (negative / fractional)", () => {
    expect(
      buildActivityTokenLeg({ tokenAddress: USDC_MINT, tokenDecimals: -1, amountRaw: "500000" }).amountHuman,
    ).toBeUndefined();
    expect(
      buildActivityTokenLeg({ tokenAddress: USDC_MINT, tokenDecimals: 6.5, amountRaw: "500000" }).amountHuman,
    ).toBeUndefined();
  });

  it("degrades to today's shape when no metadata is known at all", () => {
    expect(buildActivityTokenLeg({ tokenAddress: USDC_MINT, amountRaw: "500000" })).toEqual({
      tokenAddress: USDC_MINT, amountRaw: "500000",
    });
  });
});

describe("resolveActivityTokenLeg — fail-soft mint resolution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("fills symbol/decimals/amountHuman from the resolved mint metadata", async () => {
    mockResolveJupiterToken.mockResolvedValue({
      chain: "solana", address: USDC_MINT, symbol: "USDC", name: "USD Coin", decimals: 6,
    });

    expect(await resolveActivityTokenLeg(USDC_MINT, "500000")).toEqual({
      tokenAddress: USDC_MINT, tokenSymbol: "USDC", tokenDecimals: 6,
      amountHuman: "0.5", amountRaw: "500000",
    });
  });

  it("a THROWING metadata lookup still returns a recordable leg — never rejects (the fail-soft guarantee)", async () => {
    mockResolveJupiterToken.mockRejectedValue(new Error("Jupiter Tokens API V2 key is not configured"));

    const leg = await resolveActivityTokenLeg(USDC_MINT, "500000");

    // Exactly the pre-fix row shape: nothing is lost, nothing propagates.
    expect(leg).toEqual({ tokenAddress: USDC_MINT, amountRaw: "500000" });
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      "activity_token_leg.metadata_unavailable",
      expect.objectContaining({ mint: USDC_MINT }),
    );
  });

  it("a SYNCHRONOUSLY throwing lookup surface is contained too", async () => {
    mockResolveJupiterToken.mockImplementation(() => {
      throw new Error("token service unavailable");
    });

    expect(await resolveActivityTokenLeg(USDC_MINT, "500000")).toEqual({
      tokenAddress: USDC_MINT, amountRaw: "500000",
    });
  });

  it("an unknown mint (no metadata record) keeps the raw facts", async () => {
    mockResolveJupiterToken.mockResolvedValue(undefined);

    expect(await resolveActivityTokenLeg("SomeUnlistedMint", "12345")).toEqual({
      tokenAddress: "SomeUnlistedMint", amountRaw: "12345",
    });
  });

  it("a lookup that never settles is abandoned at the deadline instead of holding the mutation", async () => {
    vi.useFakeTimers();
    try {
      mockResolveJupiterToken.mockReturnValue(new Promise(() => { /* never settles */ }));

      const pending = resolveActivityTokenLeg(USDC_MINT, "500000");
      await vi.advanceTimersByTimeAsync(2_000);

      expect(await pending).toEqual({ tokenAddress: USDC_MINT, amountRaw: "500000" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("resolves without an amount at all (metadata-only leg)", async () => {
    mockResolveJupiterToken.mockResolvedValue({
      chain: "solana", address: USDC_MINT, symbol: "USDC", name: "USD Coin", decimals: 6,
    });

    expect(await resolveActivityTokenLeg(USDC_MINT)).toEqual({
      tokenAddress: USDC_MINT, tokenSymbol: "USDC", tokenDecimals: 6,
    });
  });
});
