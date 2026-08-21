/**
 * A KyberSwap failure that means THE VENUE COULD NOT SERVE US AT ALL must
 * unlock the hidden Uniswap fallback pair.
 *
 * WHY THIS FILE EXISTS - live 2026-08-10: a user in Vietnam was answered
 * HTTP 403 by KyberSwap's edge on the aggregator quote call. The status was
 * stamped into the KyberSwap BODY-code namespace, so the reveal classifier
 * read it as "Kyber code 403", the closed set rejected it, and the agent was
 * stranded with no swap venue while the mission prompt promised a backup one.
 * The failure is not a refusal of the trade: no fresh quote and no corrected
 * amount can clear it, and a second venue is the only remedy Vex has.
 *
 * Scaffold mirrors `pre-sign-revert-refusal.test.ts` (read-only template).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ProtocolExecutionContext } from "@vex-agent/tools/protocols/types.js";

type WalletResolveModule = typeof import("@vex-agent/tools/internal/wallet/resolve.js");

const SESSION_EVM = {
  family: "eip155" as const,
  address: "0x1234567890AbcdEF1234567890aBcdef12345678" as `0x${string}`,
  privateKey: ("0x" + "ab".repeat(32)) as `0x${string}`,
};

const mockResolveSelectedAddress = vi.fn<WalletResolveModule["resolveSelectedAddress"]>(() => SESSION_EVM.address);
const mockResolveSigningWallet = vi.fn<WalletResolveModule["resolveSigningWallet"]>(() => SESSION_EVM);

vi.mock("@vex-agent/tools/internal/wallet/resolve.js", () => ({
  resolveSelectedAddress: (...args: Parameters<WalletResolveModule["resolveSelectedAddress"]>) => mockResolveSelectedAddress(...args),
  resolveSigningWallet: (...args: Parameters<WalletResolveModule["resolveSigningWallet"]>) => mockResolveSigningWallet(...args),
  walletScopeErrorToResult: (err: unknown) => ({
    success: false,
    output: err instanceof Error ? err.message : String(err),
  }),
}));

const mockReadErc20Metadata = vi.fn(async (_slug: string, address: string) => ({
  address, symbol: "TKN", name: "Token", decimals: 18, isNative: false as const,
}));

vi.mock("@tools/kyberswap/evm-utils.js", () => ({
  getKyberEvmClients: () => ({ publicClient: {}, walletClient: {} }),
  readErc20Metadata: (...args: [string, string]) => mockReadErc20Metadata(...args),
  verifyRouterAddress: vi.fn(),
  planKyberAllowance: vi.fn().mockResolvedValue({ needsReset: false, needsApprove: false }),
  buildApproveCalldata: vi.fn(() => "0xapprove"),
  signStageBroadcast: vi.fn(),
  decodeKyberSwapSettlement: vi.fn(() => null),
}));

vi.mock("@tools/evm-chains/erc20-balance-guard.js", () => ({
  ensureErc20Balance: vi.fn().mockResolvedValue(undefined),
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

vi.mock("@vex-agent/db/repos/agent-activity.js", () => ({
  createAgentActivityIntent: (...args: unknown[]) => mockCreateAgentActivityIntent(...args),
  createAgentActivityPreBroadcastFailure: (...args: unknown[]) => mockCreateAgentActivityPreBroadcastFailure(...args),
  markActivityBroadcast: vi.fn().mockResolvedValue({ applied: true, row: {} }),
  markBroadcastAccepted: vi.fn().mockResolvedValue({ applied: true, row: {} }),
  confirmActivityEvent: vi.fn().mockResolvedValue({ applied: true, row: {} }),
  failActivityEvent: vi.fn().mockResolvedValue({ applied: true, row: {} }),
  abortPlannedEvents: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@vex-agent/db/repos/tracked-tokens.js", () => ({
  pinTrackedToken: vi.fn().mockResolvedValue({ inserted: true }),
}));

vi.mock("@utils/logger.js", () => {
  const stub = { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() };
  return { default: stub, logger: stub };
});

import { KYBERSWAP_HANDLERS } from "../../../../vex-agent/tools/protocols/kyberswap/handlers.js";
import { mapAggregatorError } from "@tools/kyberswap/aggregator/errors.js";
import { VexError, ErrorCodes } from "../../../../errors.js";

const TOKEN_A = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const TOKEN_B = "0xdAC17F958D2ee523a2206206994597C13D831ec7";

const FALLBACK_SENTENCE = "Uniswap is an alternative venue for this trade: quote it with SwapQuoteUniswap, then execute with SwapExecuteUniswap.";
const TERMINAL_LEAD = "KyberSwap did not price the route at all";
const RETRY_FIRST_LEAD = "retry the same KyberSwap request once after a short backoff";
const COVERAGE_CAVEAT = "Uniswap covers only the EVM chains with a verified Vex deployment";

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

function quote(over: Partial<ProtocolExecutionContext> = {}) {
  return KYBERSWAP_HANDLERS["kyberswap.swap.quote"]!(
    { chain: "ethereum", tokenIn: TOKEN_A, tokenOut: TOKEN_B, amountIn: "1" },
    ctx(over),
  );
}

function resetScaffold(): void {
  vi.clearAllMocks();
  mockResolveSelectedAddress.mockReturnValue(SESSION_EVM.address);
  mockResolveSigningWallet.mockReturnValue(SESSION_EVM);
  mockReadErc20Metadata.mockImplementation(async (_slug: string, address: string) => ({
    address, symbol: "TKN", name: "Token", decimals: 18, isNative: false as const,
  }));
  mockGetHoneypotFotInfo.mockResolvedValue({ isHoneypot: false, isFOT: false, tax: 0 });
  mockCreateAgentActivityPreBroadcastFailure.mockResolvedValue({ executionId: 1, event: { id: 1 } });
}

describe("kyberswap.swap.quote - a venue-availability failure names the alternative venue", () => {
  beforeEach(resetScaffold);

  it("the EXACT live shape - a geo-block 403 from the edge - names Uniswap and says why", async () => {
    mockGetRoute.mockRejectedValueOnce(mapAggregatorError(403, null, "HTTP 403: (html)"));

    const result = await quote();

    expect(result.output).toContain(FALLBACK_SENTENCE);
    expect(result.output).toContain(TERMINAL_LEAD);
    // An edge refusal is terminal for this client: telling the agent to retry
    // it would be false advice.
    expect(result.output).not.toContain(RETRY_FIRST_LEAD);
    expect(result.output).toContain(COVERAGE_CAVEAT);
    // The original failure text survives - the suffix is appended, never a
    // replacement for what the venue actually said.
    expect(result.output).toContain("refused the request (HTTP 403)");
  });

  it("a transport failure that never reached the venue names Uniswap, and says to retry Kyber once first", async () => {
    mockGetRoute.mockRejectedValueOnce(new VexError(ErrorCodes.KYBER_UNREACHABLE, "fetch failed"));

    const result = await quote();

    expect(result.output).toContain(FALLBACK_SENTENCE);
    expect(result.output).toContain(RETRY_FIRST_LEAD);
  });

  it("a 429 names Uniswap, and is also worth one backed-off retry on KyberSwap first", async () => {
    mockGetRoute.mockRejectedValueOnce(mapAggregatorError(429, null, "Rate limited"));

    const result = await quote();

    expect(result.output).toContain(RETRY_FIRST_LEAD);
  });

  it("a malformed-params failure does NOT name a second venue - that is our parameter, not the venue", async () => {
    mockGetRoute.mockRejectedValueOnce(mapAggregatorError(400, 4001, "bad params"));

    const result = await quote();

    expect(result.output).not.toContain(FALLBACK_SENTENCE);
  });

  it("a price-floor violation does NOT name a second venue - a fresh quote can clear it", async () => {
    mockGetRoute.mockRejectedValueOnce(new VexError(ErrorCodes.KYBER_PRICE_FLOOR_VIOLATED, "floor"));

    const result = await quote();

    expect(result.output).not.toContain(FALLBACK_SENTENCE);
  });

  // Also the shape of `verifyRouterAddress`'s build-integrity abort and of the
  // response-schema validators - neither is evidence about availability.
  it("a KYBER_API_ERROR carrying NO http status does NOT name a second venue", async () => {
    mockGetRoute.mockRejectedValueOnce(new VexError(ErrorCodes.KYBER_API_ERROR, "unusable response"));

    const result = await quote();

    expect(result.output).not.toContain(FALLBACK_SENTENCE);
  });

  // BEHAVIOUR CHANGE (owner decision D4). This used to assert the fail-closed
  // half of the reveal: no session meant no reveal, so no sentence. There is no
  // reveal any more and the venue is always callable, so the advice is correct
  // regardless of session — and withholding it would be the bug. The base
  // message still survives, which is the half that always mattered.
  it("still names the alternative without a session, base message intact", async () => {
    mockGetRoute.mockRejectedValueOnce(mapAggregatorError(403, null, "HTTP 403: (html)"));

    const result = await quote({ sessionId: undefined });

    expect(result.output).toContain(FALLBACK_SENTENCE);
    expect(result.output).toContain("refused the request (HTTP 403)");
  });
});

describe("kyberswap.swap.execute - a venue-availability failure names the alternative AND is recorded", () => {
  beforeEach(resetScaffold);

  it("records failure_code venue_unavailable instead of hiding a geo-block as unknown", async () => {
    mockGetRoute.mockRejectedValueOnce(mapAggregatorError(403, null, "HTTP 403: (html)"));

    const result = await KYBERSWAP_HANDLERS["kyberswap.swap.execute"]!(
      { chain: "ethereum", tokenIn: TOKEN_A, tokenOut: TOKEN_B, amountIn: "1" },
      ctx(),
    );

    expect(result.output).toContain(FALLBACK_SENTENCE);
    expect(mockCreateAgentActivityPreBroadcastFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({ failureCode: "venue_unavailable" }),
      }),
    );
  });
});
