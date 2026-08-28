/**
 * A quote that authorizes nothing still records what it LEARNED about the token.
 *
 * ## The defect this file pins
 *
 * Eligibility and safety are different questions. `kyberswap.swap.quote` stamped
 * `safetyVerdict: "unknown"` on the identity it hands the recorder whenever the
 * quote was ineligible (unpriceable output, excessive impact, oversize
 * snapshot), and the recorder preferred that handoff over the safety block the
 * quote itself returned. So a CONFIRMED honeypot discovered on an unpriceable
 * pair was persisted as unaudited: the gate's fresh-`fail` guardrail had nothing
 * to dominate with, and the same token could be quoted again into a `pass`.
 *
 * The path here is real end to end - the actual quote handler produces the
 * result, the actual recorder consumes it - and only the provider, the wallet
 * and the row write are mocked.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

import type { ProtocolExecutionContext } from "@vex-agent/tools/protocols/types.js";

const mockReadErc20Metadata = vi.fn(async (_slug: string, address: string) => ({
  address, symbol: "TKN", name: "Token", decimals: 18, isNative: false as const,
}));

vi.mock("@tools/kyberswap/evm-utils.js", () => ({
  getKyberEvmClients: () => ({ publicClient: {}, walletClient: {} }),
  readErc20Metadata: (...args: [string, string]) => mockReadErc20Metadata(...args),
  verifyRouterAddress: vi.fn(),
  planKyberAllowance: vi.fn(),
  buildApproveCalldata: vi.fn(),
  signStageBroadcast: vi.fn(),
  decodeKyberSwapSettlement: vi.fn(),
}));

const mockHoneypotInfo = vi.fn();
vi.mock("@tools/kyberswap/token-api/client.js", () => ({
  getKyberTokenApiClient: () => ({
    searchTokens: vi.fn().mockResolvedValue([]),
    getHoneypotFotInfo: (...args: unknown[]) => mockHoneypotInfo(...args),
  }),
}));

const mockGetRoute = vi.fn();
vi.mock("@tools/kyberswap/aggregator/client.js", () => ({
  getKyberAggregatorClient: () => ({ getRoute: (...a: unknown[]) => mockGetRoute(...a), buildRoute: vi.fn() }),
}));

const mockCreate = vi.fn(async (_input: unknown) => {});
vi.mock("@vex-agent/db/repos/swap-prequotes.js", () => ({
  create: (input: unknown) => mockCreate(input),
  findLatestFreshByMatch: vi.fn().mockResolvedValue(null),
  existsFreshFailByMatch: vi.fn().mockResolvedValue(false),
}));

vi.mock("@vex-agent/tools/internal/wallet/resolve.js", () => ({
  resolveSelectedAddress: () => "0xWALLET",
}));

vi.mock("@utils/logger.js", () => {
  const stub = { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() };
  return { default: stub, logger: stub };
});

import { KYBERSWAP_HANDLERS } from "@vex-agent/tools/protocols/kyberswap/handlers.js";
import { recordPrequoteFromQuote } from "@vex-agent/tools/protocols/prequote/record.js";

const TOKEN_IN = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const TOKEN_OUT = "0x17f31d221a86c091a32d398653f5306fc4d93c0d";
const QUOTE_PARAMS = { chain: "base", tokenIn: TOKEN_IN, tokenOut: TOKEN_OUT, amountIn: "10" };

function ctx(): ProtocolExecutionContext {
  return {
    sessionPermission: "full", approved: true,
    walletResolution: { source: "default" }, walletPolicy: { kind: "none" },
    sessionId: "session-1",
  };
}

/**
 * KyberSwap's MEASURED answer for a pair it cannot price on the output leg:
 * `amountInUsd` is a real number and `amountOutUsd` is "0" (2026-08-27). That is
 * the `unpriceable_output` eligibility, and it is the case in which the verdict
 * used to be discarded.
 */
function unpriceableRoute() {
  return {
    data: {
      routeSummary: {
        tokenIn: TOKEN_IN, tokenOut: TOKEN_OUT,
        amountIn: "10000000", amountOut: "21335790672285165158400",
        amountInUsd: "100", amountOutUsd: "0",
        gasUsd: "0.01", routeID: "r1", checksum: "c1", route: [],
      },
      routerAddress: "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5",
    },
  };
}

const QUOTE_HANDLER = KYBERSWAP_HANDLERS["kyberswap.swap.quote"];
if (QUOTE_HANDLER === undefined) throw new Error("kyberswap.swap.quote is not registered");

/** Run the real quote, then hand its result to the real recorder. */
async function quoteAndRecord() {
  const result = await QUOTE_HANDLER(QUOTE_PARAMS, ctx());
  await recordPrequoteFromQuote(
    "kyberswap.swap.quote",
    QUOTE_PARAMS,
    (result.data ?? {}) as Record<string, unknown>,
    ctx(),
    result.quoteAuthority,
  );
  return result;
}

function recordedRow(): Record<string, unknown> {
  const call = mockCreate.mock.calls[0];
  if (call === undefined) throw new Error("no prequote row was written");
  return call[0] as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockReadErc20Metadata.mockImplementation(async (_slug: string, address: string) => ({
    address, symbol: "TKN", name: "Token", decimals: 18, isNative: false as const,
  }));
  mockGetRoute.mockResolvedValue(unpriceableRoute());
});

describe("a confirmed honeypot on an INELIGIBLE quote", () => {
  beforeEach(() => {
    // The output token is a confirmed honeypot; the input token is clean.
    mockHoneypotInfo.mockImplementation(async (_chainId: number, address: string) => (
      address.toLowerCase() === TOKEN_OUT.toLowerCase()
        ? { isHoneypot: true, isFOT: false, tax: 0 }
        : { isHoneypot: false, isFOT: false, tax: 0 }
    ));
  });

  it("is persisted as `fail`, not as `unknown`", async () => {
    const result = await quoteAndRecord();

    expect(result.quoteAuthority?.eligibilityKind).toBe("unpriceable_output");
    // The quote authorizes nothing...
    expect(recordedRow().eligibilityKind).toBe("unpriceable_output");
    // ...and the token is still known to be a scam.
    expect(recordedRow().safetyVerdict).toBe("fail");
  });

  it("the stored detail keeps the honeypot disclosure AND the eligibility", async () => {
    await quoteAndRecord();
    const detail = recordedRow().safetyDetail as Record<string, unknown>;

    expect(detail.tokenOut).toEqual({ isHoneypot: true, isFOT: false, tax: 0 });
    expect(detail.tokenIn).toEqual({ isHoneypot: false, isFOT: false, tax: 0 });
  });

  it("the handoff identity itself carries the real verdict, not a placeholder", async () => {
    const result = await QUOTE_HANDLER(QUOTE_PARAMS, ctx());
    expect(result.quoteAuthority?.ineligibleIdentity?.safetyVerdict).toBe("fail");
  });
});

describe("the verdict still follows the token, not the eligibility", () => {
  it("a clean token on the same ineligible quote records `pass`", async () => {
    mockHoneypotInfo.mockResolvedValue({ isHoneypot: false, isFOT: false, tax: 0 });

    await quoteAndRecord();

    expect(recordedRow().eligibilityKind).toBe("unpriceable_output");
    expect(recordedRow().safetyVerdict).toBe("pass");
  });

  it("an unavailable safety check on an ineligible quote records `unknown`", async () => {
    mockHoneypotInfo.mockRejectedValue(new Error("provider down"));

    await quoteAndRecord();

    expect(recordedRow().safetyVerdict).toBe("unknown");
  });
});
