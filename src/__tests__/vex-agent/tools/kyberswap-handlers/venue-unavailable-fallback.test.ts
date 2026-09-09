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

vi.mock("@tools/kyberswap/evm-utils.js", async () => ({
  ...(await import("./evm-client.test-fixtures.js")).kyberEvmClientMocks(),
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

// The execute CLAIMS the approved quote instead of fetching a route (the
// 2026-08-27 quote-binding change). The claim's own behaviour is covered by
// `quote-bound-execute.test.ts` and the Postgres claim suite; here it hands
// back a real snapshot of this file's own route so the handler reaches the
// behaviour under test.
const mockClaim = vi.fn();
vi.mock("@vex-agent/tools/protocols/prequote/claim.js", () => ({
  commitPrequoteClaim: vi.fn(async () => ({ ok: true })),
  readSwapExecutionSnapshot: (...args: unknown[]) => mockClaim(...args),
}));

vi.mock("@utils/logger.js", () => {
  const stub = { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() };
  return { default: stub, logger: stub };
});

import { approvedClaim } from "../../../kyberswap/fixtures/route-build/approved-quote.js";
import { VEX_DEFAULT_SLIPPAGE_BPS } from "@vex-agent/tools/protocols/slippage-policy.js";
import { KYBERSWAP_HANDLERS } from "../../../../vex-agent/tools/protocols/kyberswap/handlers.js";
import { mapAggregatorError } from "@tools/kyberswap/aggregator/errors.js";
import { VexError, ErrorCodes } from "../../../../errors.js";
import { SWAP_VENUE_PEER_NUDGE_SUFFIX } from "@vex-agent/tools/registry/swap-venue-guidance.js";

const TOKEN_A = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const TOKEN_B = "0xdAC17F958D2ee523a2206206994597C13D831ec7";

/**
 * Read off the owner module rather than retyped: the sentence is the swap-venue
 * standing's (`registry/swap-venue-guidance.ts`), and a copy here would let the
 * failure message and the tool descriptions describe the two venues
 * differently, which is the drift that module exists to prevent. `.trim()`
 * drops its leading space - it is authored as an appendable suffix.
 */
const FALLBACK_SENTENCE = SWAP_VENUE_PEER_NUDGE_SUFFIX.trim();
const TERMINAL_LEAD = "KyberSwap did not price the route at all";
const RETRY_FIRST_LEAD = "retry the same KyberSwap request once after a short backoff";
const COVERAGE_CAVEAT = "Uniswap covers seven EVM chains with verified Vex deployments";

function expectRegionalRemedy(output: string): void {
  expect(output).toContain("KyberSwap is not reachable from this network or region");
  expect(output).toContain("uniswap__swap_quote` then `uniswap__swap_execute` on the same chain");
  expect(output).toContain("Uniswap V2, V3 and v4 pools directly on seven chains");
  expect(output).toContain("liquidity only on other DEXes may be unavailable there");
  expect(output).toContain("explain the coverage limit instead of retrying blocked KyberSwap");
  expect(output).toContain("do not repeat it unchanged on this venue");
  expect(output).not.toContain(RETRY_FIRST_LEAD);
}

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

/** A real snapshot of a minimal route, so the execute reaches the build call. */
const APPROVED_CLAIM = approvedClaim(
  {
    amountIn: "1000000", amountOut: "999000", amountInUsd: "1", amountOutUsd: "0.99",
    gasUsd: "0.5", routeID: "r1", checksum: "c1", tokenIn: TOKEN_A, tokenOut: TOKEN_B,
    route: [[{ pool: "0xpool1" }]],
  },
  VEX_DEFAULT_SLIPPAGE_BPS,
);

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

  it.each([401, 403, 451])("an HTTP %i edge refusal names the same-chain remedy and v4 gap", async (status) => {
    mockGetRoute.mockRejectedValueOnce(mapAggregatorError(status, null, `HTTP ${status}: (html)`));

    const result = await quote();

    expectRegionalRemedy(result.output);
    expect(result.output).toContain(TERMINAL_LEAD);
    // An edge refusal is terminal for this client: telling the agent to retry
    // it would be false advice.
    expect(result.output).not.toContain(RETRY_FIRST_LEAD);
    expect(result.output).toContain(COVERAGE_CAVEAT);
    // The original failure text survives - the suffix is appended, never a
    // replacement for what the venue actually said.
    expect(result.output).toContain(`refused the request (HTTP ${status})`);
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

    expectRegionalRemedy(result.output);
    expect(result.output).toContain("refused the request (HTTP 403)");
  });
});

describe("kyberswap.swap.execute - a venue-availability failure names the alternative AND is recorded", () => {
  beforeEach(resetScaffold);

  it.each([401, 403, 451])("records HTTP %i as venue_unavailable and names the regional remedy", async (status) => {
    // The execute reaches the venue at `/route/build` only: it claims the
    // quote it was given rather than fetching a route, so the geo-block
    // arrives from the build call.
    mockClaim.mockResolvedValue(APPROVED_CLAIM);
    mockBuildRoute.mockRejectedValueOnce(mapAggregatorError(status, null, `HTTP ${status}: (html)`));

    const result = await KYBERSWAP_HANDLERS["kyberswap.swap.execute"]!(
      { chain: "ethereum", tokenIn: TOKEN_A, tokenOut: TOKEN_B, amountIn: "1" },
      ctx(),
    );

    expectRegionalRemedy(result.output);
    expect(mockCreateAgentActivityPreBroadcastFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({ failureCode: "venue_unavailable" }),
      }),
    );
  });
});
