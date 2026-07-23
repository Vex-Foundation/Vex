import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ProtocolExecutionContext } from "@vex-agent/tools/protocols/types.js";

// ── Per-session wallet resolution mock (5D-protocols p1) ──────────
// Handlers now resolve the session wallet via resolve.js (NOT the zero-arg
// requireEvmWallet primary). Spy on the resolvers to assert the session wallet
// is used and that preview/dryRun never decrypts a signing key.

const SESSION_EVM = {
  family: "eip155" as const,
  address: "0x1234567890abcdef1234567890abcdef12345678",
  privateKey: ("0x" + "ab".repeat(32)) as `0x${string}`,
};
const mockResolveSigningWallet = vi.fn(() => SESSION_EVM);
const mockResolveSelectedAddress = vi.fn(() => SESSION_EVM.address);

vi.mock("@vex-agent/tools/internal/wallet/resolve.js", () => ({
  resolveSigningWallet: (...args: unknown[]) => mockResolveSigningWallet(...args),
  resolveSelectedAddress: (...args: unknown[]) => mockResolveSelectedAddress(...args),
  walletScopeErrorToResult: (err: unknown) => ({
    success: false,
    output: err instanceof Error ? err.message : String(err),
  }),
}));

/** Type-complete ProtocolExecutionContext for handler tests. */
function ctx(over: Partial<ProtocolExecutionContext> = {}): ProtocolExecutionContext {
  return {
    sessionPermission: "full",
    approved: true,
    walletResolution: { source: "default" },
    walletPolicy: { kind: "none" },
    ...over,
  };
}

// readErc20Metadata is used by resolveTokenMetadataStrict for address inputs
// (the quote path is now strict/address-only, matching execute).
// Default: return plain ERC-20 metadata so non-native token addresses resolve
// without an on-chain read. Tests override per-case where needed.
const mockReadErc20Metadata = vi.fn(async (_slug: string, address: string) => ({
  address,
  symbol: "TKN",
  name: "Token",
  decimals: 18,
  isNative: false as const,
}));

vi.mock("@tools/kyberswap/evm-utils.js", () => ({
  getKyberEvmClients: () => ({
    publicClient: {},
    walletClient: {},
  }),
  readErc20Metadata: (...args: [string, string]) => mockReadErc20Metadata(...args),
  verifyRouterAddress: vi.fn(),
  planKyberAllowance: vi.fn(),
  buildApproveCalldata: vi.fn(),
  signStageBroadcast: vi.fn(),
  decodeKyberSwapSettlement: vi.fn(),
}));

// Mock token API for safety gate + quote-time safety surfacing (Stage 6b).
// Shared spy so individual tests can drive honeypot/FoT/check-failed scenarios.
const mockGetHoneypotFotInfo = vi.fn().mockResolvedValue({ isHoneypot: false, isFOT: false, tax: 0 });

vi.mock("@tools/kyberswap/token-api/client.js", () => ({
  getKyberTokenApiClient: () => ({
    searchTokens: vi.fn().mockResolvedValue([]),
    getHoneypotFotInfo: (...args: [number, string]) => mockGetHoneypotFotInfo(...args),
  }),
}));

// Mock aggregator client so the read-only quote can fetch a route hermetically.
const mockGetRoute = vi.fn();

vi.mock("@tools/kyberswap/aggregator/client.js", () => ({
  getKyberAggregatorClient: () => ({
    getRoute: (...args: unknown[]) => mockGetRoute(...args),
  }),
}));

// Spy on logger.warn so the fail-soft safety leg's log payload can be asserted
// to contain NO raw provider/HTTP text (Stage 6b fix 1). Other methods are
// no-ops to keep tests hermetic and quiet.
const mockLoggerWarn = vi.fn();

vi.mock("@utils/logger.js", () => {
  const stub = {
    warn: (...args: unknown[]) => mockLoggerWarn(...args),
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  };
  return { default: stub, logger: stub };
});

import { KYBERSWAP_HANDLERS } from "../../../../vex-agent/tools/protocols/kyberswap/handlers.js";

describe("kyberswap.swap.quote token safety (Stage 6b)", () => {
  const TOKEN_A = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"; // USDC-like
  const TOKEN_B = "0xdAC17F958D2ee523a2206206994597C13D831ec7"; // USDT-like
  const NATIVE = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
  const READ_CTX = ctx({ sessionPermission: "restricted", approved: false });

  beforeEach(() => {
    mockGetHoneypotFotInfo.mockReset();
    mockGetHoneypotFotInfo.mockResolvedValue({ isHoneypot: false, isFOT: false, tax: 0 });
    mockGetRoute.mockReset();
    mockGetRoute.mockResolvedValue({
      data: {
        routeSummary: {
          amountIn: "1000000",
          amountInUsd: "1.00",
          amountOut: "999000",
          amountOutUsd: "0.99",
          gasUsd: "0.5",
          // Two non-null hops across one path — drives routeHops projection.
          route: [[{ pool: "0xpool1" }, { pool: "0xpool2" }]],
        },
        routerAddress: "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5",
      },
    });
    mockReadErc20Metadata.mockReset();
    mockReadErc20Metadata.mockImplementation(async (_slug: string, address: string) => ({
      address,
      symbol: "TKN",
      name: "Token",
      decimals: 18,
      isNative: false as const,
    }));
    mockLoggerWarn.mockClear();
  });

  it("surfaces a clean safety block for both non-native legs (isHoneypot false)", async () => {
    const result = await KYBERSWAP_HANDLERS["kyberswap.swap.quote"]!(
      { chain: "ethereum", tokenIn: TOKEN_A, tokenOut: TOKEN_B, amountIn: "1" },
      READ_CTX,
    );

    expect(result.success).toBe(true);
    const out = JSON.parse(result.output);
    expect(out.safety).toEqual({
      tokenIn: { isHoneypot: false, isFOT: false, tax: 0 },
      tokenOut: { isHoneypot: false, isFOT: false, tax: 0 },
    });
    // Both non-native legs were checked, in parallel.
    expect(mockGetHoneypotFotInfo).toHaveBeenCalledTimes(2);
    // routeSummary is the compact formatRouteSummary projection: amounts +
    // USD legs + gasUsd + derived priceImpact + routeHops; route/poolExtra/
    // extra/routeID/checksum/tokenIn/tokenOut/l1FeeUsd/extraFee/gas/gasPrice
    // are dropped. priceImpact is a derived float, asserted approximately.
    expect(out.routeSummary).toMatchObject({
      amountIn: "1000000",
      amountInUsd: "1.00",
      amountOut: "999000",
      amountOutUsd: "0.99",
      gasUsd: "0.5",
      routeHops: 2,
    });
    expect(out.routeSummary.priceImpact).toBeCloseTo(0.01, 10);
    expect(Object.keys(out.routeSummary).sort()).toEqual(
      ["amountIn", "amountInUsd", "amountOut", "amountOutUsd", "gasUsd", "priceImpact", "routeHops"].sort(),
    );
    expect(out.routerAddress).toBe("0x6131B5fae19EA4f9D964eAc0408E4408b66337b5");
  });

  it("surfaces a honeypot tokenOut WITHOUT aborting the quote", async () => {
    mockGetHoneypotFotInfo.mockImplementation(async (_chainId: number, address: string) => {
      if (address.toLowerCase() === TOKEN_B.toLowerCase()) {
        return { isHoneypot: true, isFOT: false, tax: 0 };
      }
      return { isHoneypot: false, isFOT: false, tax: 0 };
    });

    const result = await KYBERSWAP_HANDLERS["kyberswap.swap.quote"]!(
      { chain: "ethereum", tokenIn: TOKEN_A, tokenOut: TOKEN_B, amountIn: "1" },
      READ_CTX,
    );

    // Quote STILL returns — read-only, no gate.
    expect(result.success).toBe(true);
    const out = JSON.parse(result.output);
    expect(out.safety.tokenOut).toEqual({ isHoneypot: true, isFOT: false, tax: 0 });
    expect(out.safety.tokenIn).toEqual({ isHoneypot: false, isFOT: false, tax: 0 });
    // Route is still present — execution path untouched.
    expect(out.routeSummary).toBeDefined();
  });

  it("surfaces a fee-on-transfer / tax token in the safety block", async () => {
    mockGetHoneypotFotInfo.mockImplementation(async (_chainId: number, address: string) => {
      if (address.toLowerCase() === TOKEN_A.toLowerCase()) {
        return { isHoneypot: false, isFOT: true, tax: 12 };
      }
      return { isHoneypot: false, isFOT: false, tax: 0 };
    });

    const result = await KYBERSWAP_HANDLERS["kyberswap.swap.quote"]!(
      { chain: "ethereum", tokenIn: TOKEN_A, tokenOut: TOKEN_B, amountIn: "1" },
      READ_CTX,
    );

    expect(result.success).toBe(true);
    const out = JSON.parse(result.output);
    expect(out.safety.tokenIn).toEqual({ isHoneypot: false, isFOT: true, tax: 12 });
  });

  it("fail-soft: a thrown honeypot check yields a bounded marker, quote still returns, no raw text", async () => {
    mockGetHoneypotFotInfo.mockImplementation(async (_chainId: number, address: string) => {
      if (address.toLowerCase() === TOKEN_B.toLowerCase()) {
        // Raw provider text that MUST NOT leak into the output.
        throw new Error("Honeypot check failed: 503 https://token-api.kyberswap.com/secret?key=ABC <html>boom</html>");
      }
      return { isHoneypot: false, isFOT: false, tax: 0 };
    });

    const result = await KYBERSWAP_HANDLERS["kyberswap.swap.quote"]!(
      { chain: "ethereum", tokenIn: TOKEN_A, tokenOut: TOKEN_B, amountIn: "1" },
      READ_CTX,
    );

    // Quote still returns despite the failed check.
    expect(result.success).toBe(true);
    const out = JSON.parse(result.output);
    // Bounded marker — checkFailed plus a bounded reason class (no raw text).
    expect(out.safety.tokenOut.checkFailed).toBe(true);
    expect(["timeout", "rate_limited", "kyber_error", "unavailable"]).toContain(out.safety.tokenOut.reason);
    expect(out.safety.tokenIn).toEqual({ isHoneypot: false, isFOT: false, tax: 0 });
    // No raw provider/HTTP text anywhere in the serialized output.
    expect(result.output).not.toContain("kyberswap.com");
    expect(result.output).not.toContain("<html>");
    expect(result.output).not.toContain("key=ABC");
    expect(result.output).not.toContain("503");
  });

  it("fix 1: the safety_check_failed LOG payload carries a bounded reason class only (no raw text)", async () => {
    // Raw provider text with every forbidden token class: URL, doctype/html,
    // apiKey/sk_live secret, and a numeric HTTP status.
    const RAW =
      "Honeypot check failed: 503 https://token-api.kyberswap.com/x?apiKey=sk_live_ABC <!DOCTYPE html><html>boom</html>";
    mockGetHoneypotFotInfo.mockImplementation(async (_chainId: number, address: string) => {
      if (address.toLowerCase() === TOKEN_B.toLowerCase()) throw new Error(RAW);
      return { isHoneypot: false, isFOT: false, tax: 0 };
    });

    const result = await KYBERSWAP_HANDLERS["kyberswap.swap.quote"]!(
      { chain: "ethereum", tokenIn: TOKEN_A, tokenOut: TOKEN_B, amountIn: "1" },
      READ_CTX,
    );
    expect(result.success).toBe(true);

    // logger.warn was invoked for the failed leg; its payload must be bounded.
    expect(mockLoggerWarn).toHaveBeenCalled();
    const warnCall = mockLoggerWarn.mock.calls.find(
      (c) => c[0] === "kyberswap.swap.quote.safety_check_failed",
    );
    expect(warnCall).toBeDefined();
    const payload = warnCall![1] as Record<string, unknown>;
    // reason is one of the four bounded literals.
    expect(["timeout", "rate_limited", "kyber_error", "unavailable"]).toContain(payload.reason);

    // The serialized payload contains NONE of the forbidden raw-text classes.
    const serialized = JSON.stringify(payload).toLowerCase();
    expect(serialized).not.toContain("http://");
    expect(serialized).not.toContain("https://");
    expect(serialized).not.toContain("kyberswap.com");
    expect(serialized).not.toContain("<!doctype");
    expect(serialized).not.toContain("html");
    expect(serialized).not.toContain("apikey=");
    expect(serialized).not.toContain("sk_live");
    expect(serialized).not.toContain("503");
  });

  it("fix 2: the native SENTINEL ADDRESS leg is marked { native: true } and is never honeypot-checked", async () => {
    // Pass the sentinel ADDRESS (not the "ETH" keyword) as tokenIn.
    const result = await KYBERSWAP_HANDLERS["kyberswap.swap.quote"]!(
      { chain: "ethereum", tokenIn: NATIVE, tokenOut: TOKEN_B, amountIn: "1" },
      READ_CTX,
    );

    expect(result.success).toBe(true);
    const out = JSON.parse(result.output);
    // Sentinel resolved as native — safety leg is the native marker.
    expect(out.safety.tokenIn).toEqual({ native: true });
    expect(out.tokenIn.address).toBe(NATIVE);
    expect(out.safety.tokenOut).toEqual({ isHoneypot: false, isFOT: false, tax: 0 });
    // Only the non-native (tokenOut) leg was honeypot-checked.
    expect(mockGetHoneypotFotInfo).toHaveBeenCalledTimes(1);
    expect(mockGetHoneypotFotInfo).toHaveBeenCalledWith(1, TOKEN_B);
    // Sentinel never went through the ERC-20 metadata read path.
    expect(mockReadErc20Metadata).not.toHaveBeenCalledWith(expect.anything(), NATIVE);
    // Route still returns.
    expect(out.routeSummary).toBeDefined();
  });

  it("skips native legs — marks { native: true } and does not call the honeypot check for them", async () => {
    const result = await KYBERSWAP_HANDLERS["kyberswap.swap.quote"]!(
      { chain: "ethereum", tokenIn: "ETH", tokenOut: TOKEN_B, amountIn: "1" },
      READ_CTX,
    );

    expect(result.success).toBe(true);
    const out = JSON.parse(result.output);
    expect(out.safety.tokenIn).toEqual({ native: true });
    expect(out.safety.tokenOut).toEqual({ isHoneypot: false, isFOT: false, tax: 0 });
    // Only the non-native (tokenOut) leg was checked.
    expect(mockGetHoneypotFotInfo).toHaveBeenCalledTimes(1);
    expect(mockGetHoneypotFotInfo).toHaveBeenCalledWith(1, TOKEN_B);
  });
});
