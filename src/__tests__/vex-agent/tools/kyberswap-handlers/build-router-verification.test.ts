/**
 * FIX 1 — the BUILD-response router address must be verified before broadcast.
 *
 * `verifyRouterAddress` was only applied to the GET/route response's
 * routerAddress, which guards the approval step. But the transaction actually
 * broadcast uses the POST/build response's routerAddress, which was never
 * verified — an attacker-controlled build routerAddress is a direct theft
 * vector (approvals + the tx target both flow to that address).
 *
 * These tests pin the fail-closed contract: when the build response's
 * routerAddress differs from the allowlisted constant, the handler MUST refuse
 * BEFORE any broadcast, even though the route response's routerAddress
 * matched.
 *
 * The zap.in build-router-verification half of this file was deleted with the
 * rest of the zap surface (Agent Scan plan §4.2) — `sendKyberTransaction` is
 * also gone (the execute handler now uses the staged sign→persist→broadcast
 * primitive, `signStageBroadcast`).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ProtocolExecutionContext } from "@vex-agent/tools/protocols/types.js";
import { META_AGGREGATION_ROUTER_V2 } from "@tools/kyberswap/constants.js";

const ATTACKER_ROUTER = "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";

// ── Hoisted spies (available inside vi.mock factories) ────────────────
const h = vi.hoisted(() => ({
  verifyRouterAddress: vi.fn((actual: string, expected: string) => {
    if (actual.toLowerCase() !== expected.toLowerCase()) {
      throw new Error(`Router address mismatch: ${actual} != ${expected}`);
    }
  }),
  signStageBroadcast: vi.fn(),
  planKyberAllowance: vi.fn().mockResolvedValue({ needsReset: false, needsApprove: false }),
  ensureErc20Balance: vi.fn().mockResolvedValue(undefined),
  getRoute: vi.fn(),
  buildRoute: vi.fn(),
  getHoneypotFotInfo: vi.fn().mockResolvedValue({ isHoneypot: false, isFOT: false, tax: 0 }),
  createAgentActivityPreBroadcastFailure: vi.fn().mockResolvedValue({ executionId: 1, event: { id: 1 } }),
  createAgentActivityIntent: vi.fn().mockResolvedValue({ executionId: 1, events: [{ id: 1 }] }),
  findFreshMatchedSwapPrequote: vi.fn(),
}));

const SESSION_EVM = {
  family: "eip155" as const,
  address: "0x1234567890abcdef1234567890abcdef12345678",
  privateKey: ("0x" + "ab".repeat(32)) as `0x${string}`,
};

vi.mock("@vex-agent/tools/internal/wallet/resolve.js", () => ({
  resolveSigningWallet: () => SESSION_EVM,
  resolveSelectedAddress: () => SESSION_EVM.address,
  walletScopeErrorToResult: (err: unknown) => ({
    success: false,
    output: err instanceof Error ? err.message : String(err),
  }),
}));

vi.mock("@tools/kyberswap/evm-utils.js", () => ({
  getKyberEvmClients: () => ({ publicClient: {}, walletClient: {} }),
  readErc20Metadata: vi.fn(async (_slug: string, address: string) => ({
    address, symbol: "TKN", name: "Token", decimals: 18, isNative: false as const,
  })),
  verifyRouterAddress: (...a: [string, string]) => h.verifyRouterAddress(...a),
  planKyberAllowance: (...a: unknown[]) => h.planKyberAllowance(...a),
  buildApproveCalldata: vi.fn(() => "0xapprove"),
  signStageBroadcast: (...a: unknown[]) => h.signStageBroadcast(...a),
  decodeKyberSwapSettlement: vi.fn(() => null),
}));

vi.mock("@tools/evm-chains/erc20-balance-guard.js", () => ({
  ensureErc20Balance: (...a: unknown[]) => h.ensureErc20Balance(...a),
}));

vi.mock("@tools/kyberswap/token-api/client.js", () => ({
  getKyberTokenApiClient: () => ({
    searchTokens: vi.fn().mockResolvedValue([]),
    getHoneypotFotInfo: (...a: [number, string]) => h.getHoneypotFotInfo(...a),
  }),
}));

vi.mock("@tools/kyberswap/aggregator/client.js", () => ({
  getKyberAggregatorClient: () => ({
    getRoute: (...a: unknown[]) => h.getRoute(...a),
    buildRoute: (...a: unknown[]) => h.buildRoute(...a),
  }),
}));

vi.mock("@vex-agent/db/repos/agent-activity.js", () => ({
  createAgentActivityIntent: (...a: unknown[]) => h.createAgentActivityIntent(...a),
  createAgentActivityPreBroadcastFailure: (...a: unknown[]) => h.createAgentActivityPreBroadcastFailure(...a),
  markActivityBroadcast: vi.fn().mockResolvedValue({ applied: true, row: {} }),
  markBroadcastAccepted: vi.fn().mockResolvedValue({ applied: true, row: {} }),
  confirmActivityEvent: vi.fn().mockResolvedValue({ applied: true, row: {} }),
  failActivityEvent: vi.fn().mockResolvedValue({ applied: true, row: {} }),
}));

vi.mock("@vex-agent/db/repos/tracked-tokens.js", () => ({
  pinTrackedToken: vi.fn().mockResolvedValue({ inserted: true }),
}));

// `kyberswap.swap.execute` re-reads its persisted quote-time price floor
// (`swap-price-floor.ts`) BEFORE the route call. This file is about the BUILD
// response's router address, not about the floor, so the floor is supplied as
// satisfied — without it both cases refuse with "no approved price floor is on
// record" and never reach `buildRoute` at all.
vi.mock("@vex-agent/tools/protocols/swap-prequote.js", () => ({
  findFreshMatchedSwapPrequote: (...a: unknown[]) => h.findFreshMatchedSwapPrequote(...a),
}));

vi.mock("@utils/logger.js", () => {
  const stub = { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() };
  return { default: stub, logger: stub };
});

import { compliantSwapCalldata, matchedPrequoteWithFloor } from "../../../kyberswap/fixtures/route-build/compliant-swap-build.js";
import { KYBERSWAP_HANDLERS } from "../../../../vex-agent/tools/protocols/kyberswap/handlers.js";

function ctx(): ProtocolExecutionContext {
  return {
    sessionPermission: "full",
    approved: true,
    walletResolution: { source: "default" },
    walletPolicy: { kind: "none" },
    sessionId: "session-1",
  };
}

describe("FIX 1 — swap build-response router verification", () => {
  const TOKEN_A = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
  const TOKEN_B = "0xdAC17F958D2ee523a2206206994597C13D831ec7";

  /**
   * Real captured router calldata, identity fields matching the handler call
   * below (TOKEN_A→TOKEN_B, 18-decimal `amountIn: "1"`, output to the session
   * wallet) and the route mock's quoted 999000 out at the venue-default 50 bps.
   * Both cases use it so the ONLY difference between them is the build's
   * `routerAddress` — a `"0xcalldata"` placeholder would make the positive
   * control refuse at the pre-sign calldata decode instead of broadcasting.
   */
  const COMPLIANT_BUILD_CALLDATA = compliantSwapCalldata({
    srcToken: TOKEN_A, dstToken: TOKEN_B, dstReceiver: SESSION_EVM.address,
    amountIn: 10n ** 18n, quotedNetOutRaw: "999000", slippageBps: 50,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    // The persisted quote-time floor the execute re-reads before the route
    // call — consistent with the route mock below. See the mock's note above.
    h.findFreshMatchedSwapPrequote.mockResolvedValue(matchedPrequoteWithFloor("999000", 50));
    h.verifyRouterAddress.mockImplementation((actual: string, expected: string) => {
      if (actual.toLowerCase() !== expected.toLowerCase()) {
        throw new Error(`Router address mismatch: ${actual} != ${expected}`);
      }
    });
    h.planKyberAllowance.mockResolvedValue({ needsReset: false, needsApprove: false });
    h.createAgentActivityIntent.mockResolvedValue({ executionId: 1, events: [{ id: 1 }] });
    h.getHoneypotFotInfo.mockResolvedValue({ isHoneypot: false, isFOT: false, tax: 0 });
    // Route response's router matches — guards approval — but the build
    // response's router is attacker-controlled.
    h.getRoute.mockResolvedValue({
      data: {
        routeSummary: { amountIn: "1000000", amountOut: "999000", gasUsd: "0.5", routeID: "r1", checksum: "c1" },
        routerAddress: META_AGGREGATION_ROUTER_V2,
      },
    });
  });

  it("fails closed BEFORE broadcast when the build router differs from the allowlist", async () => {
    h.buildRoute.mockResolvedValue({
      data: {
        routerAddress: ATTACKER_ROUTER,
        data: COMPLIANT_BUILD_CALLDATA,
        transactionValue: "0",
        amountIn: "1000000", amountOut: "999000",
        amountInUsd: "1", amountOutUsd: "1", gasUsd: "0.1",
      },
    });

    const result = await KYBERSWAP_HANDLERS["kyberswap.swap.execute"]!(
      { chain: "ethereum", tokenIn: TOKEN_A, tokenOut: TOKEN_B, amountIn: "1" },
      ctx(),
    );

    expect(result.success).toBe(false);
    expect(result.output).toMatch(/mismatch/i);
    expect(h.verifyRouterAddress).toHaveBeenCalledWith(ATTACKER_ROUTER, META_AGGREGATION_ROUTER_V2);
    expect(h.signStageBroadcast).not.toHaveBeenCalled();
  });

  it("broadcasts when the build router matches the allowlist (positive control)", async () => {
    h.buildRoute.mockResolvedValue({
      data: {
        routerAddress: META_AGGREGATION_ROUTER_V2,
        data: COMPLIANT_BUILD_CALLDATA,
        transactionValue: "0",
        amountIn: "1000000", amountOut: "999000",
        amountInUsd: "1", amountOutUsd: "1", gasUsd: "0.1",
      },
    });
    h.signStageBroadcast.mockResolvedValue({
      kind: "confirmed",
      txHash: "0xswaphash",
      receipt: { logs: [] },
    });

    const result = await KYBERSWAP_HANDLERS["kyberswap.swap.execute"]!(
      { chain: "ethereum", tokenIn: TOKEN_A, tokenOut: TOKEN_B, amountIn: "1" },
      ctx(),
    );

    expect(result.success).toBe(true);
    expect(h.verifyRouterAddress).toHaveBeenCalledWith(META_AGGREGATION_ROUTER_V2, META_AGGREGATION_ROUTER_V2);
    expect(h.signStageBroadcast).toHaveBeenCalledTimes(1);
  });
});
