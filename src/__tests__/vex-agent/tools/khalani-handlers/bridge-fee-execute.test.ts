/**
 * `khalani.bridge` — the Vex integrator fee on the real-funds execute path.
 *
 * The properties money depends on:
 *   - the VENUE is quoted for `amountIn − fee`, never for `amountIn`, so the
 *     `amountOut` the agent sees is what the user actually receives;
 *   - the deposit is signed BEFORE the treasury transfer, and a deposit that
 *     does not confirm results in NO treasury transfer being signed or sent;
 *   - the fee transfer runs AFTER the deposit is registered with the provider,
 *     so it can neither delay nor alter the bridge's own fill tracking;
 *   - a FAILED fee transfer is a partial plan success: the bridge went through
 *     and is never reported as failed, and the user is never told their funds
 *     are at risk;
 *   - an AMBIGUOUS fee broadcast is left for the sweep, never re-sent;
 *   - a dust amount whose fee floors to 0 charges nothing and bridges in full;
 *   - a caller-supplied fee param is still rejected BY NAME;
 *   - the fee this execute would take still MATCHES the statement the approval
 *     was granted on, and a divergence refuses before anything is signed.
 *
 * The deposit PLANNER is deliberately NOT mocked — leg ordering is the thing
 * under test, so it must come from the real `planKhalaniDepositLegs`.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { encodeFunctionData, getAddress } from "viem";
import type { ProtocolExecutionContext } from "@vex-agent/tools/protocols/types.js";

const SESSION_EVM = {
  family: "eip155" as const,
  address: "0x1234567890AbcdEF1234567890aBcdef12345678",
  privateKey: ("0x" + "ab".repeat(32)) as `0x${string}`,
};

const FROM_TOKEN = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const TO_TOKEN = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
const ROUTER = "0x1111111111111111111111111111111111111111";

const APPROVE_ABI = [{
  type: "function", name: "approve", stateMutability: "nonpayable",
  inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }],
  outputs: [{ name: "", type: "bool" }],
}] as const;

function approveCalldata(spender: string, allowance: bigint): string {
  return encodeFunctionData({ abi: APPROVE_ABI, functionName: "approve", args: [getAddress(spender), allowance] });
}
const FUTURE = Math.floor(Date.now() / 1000) + 3600;

vi.mock("@vex-agent/tools/internal/wallet/resolve.js", () => ({
  resolveSelectedAddress: () => SESSION_EVM.address,
  resolveSigningWallet: () => SESSION_EVM,
  walletScopeErrorToResult: (err: unknown) => ({ success: false, output: String(err) }),
}));

vi.mock("@tools/wallet/inventory.js", () => ({
  familyToInventory: () => "evm",
  walletAddressesEqual: () => true,
}));

const mockChains = [
  { id: 8453, name: "Base", type: "eip155", blockExplorers: { default: { url: "https://basescan.org" } } },
  { id: 42161, name: "Arbitrum One", type: "eip155", blockExplorers: { default: { url: "https://arbiscan.io" } } },
];

vi.mock("@tools/khalani/chains.js", () => ({
  getCachedKhalaniChains: async () => mockChains,
  getChain: (id: number) => mockChains.find((c) => c.id === id),
  getChainFamily: () => "eip155" as const,
  getChainExplorerUrl: (id: number) => mockChains.find((c) => c.id === id)?.blockExplorers.default.url,
}));

vi.mock("@tools/khalani/prequote-route-guard.js", () => ({
  resolveKhalaniPrequoteRoute: async () => ({ outcome: "khalani", fromChainId: 8453, toChainId: 42161 }),
}));

const mockPrepareQuoteRequest = vi.fn();
vi.mock("@tools/khalani/request.js", () => ({
  prepareQuoteRequest: (...a: unknown[]) => mockPrepareQuoteRequest(...a),
  // Faithful to the real guard (not a permissive stub): the caller-supplied
  // fee-param rejection must stay LIVE in this suite, so a regression that
  // starts accepting a model-supplied fee cannot hide behind the mock.
  findCallerSuppliedForbiddenParam: (params: Record<string, unknown>) => {
    for (const key of ["referrer", "referrerFeeBps"]) {
      const value = params[key];
      if (value === undefined || value === null) continue;
      if (typeof value === "string" && value.trim() === "") continue;
      return { param: key, reason: "Vex never takes fee parameters from tool input." };
    }
    return null;
  },
}));

vi.mock("@tools/khalani/helpers.js", () => ({ resolveRouteBestIndex: () => 0 }));

const mockGetQuotes = vi.fn();
const mockBuildDeposit = vi.fn();
const mockSubmitDeposit = vi.fn();
const mockSearchTokens = vi.fn();
vi.mock("@tools/khalani/client.js", () => ({
  getKhalaniClient: () => ({
    getQuotes: (...a: unknown[]) => mockGetQuotes(...a),
    buildDeposit: (...a: unknown[]) => mockBuildDeposit(...a),
    submitDeposit: (...a: unknown[]) => mockSubmitDeposit(...a),
    searchTokens: (...a: unknown[]) => mockSearchTokens(...a),
    getOrders: async () => ({ data: [] }),
  }),
}));

vi.mock("@tools/khalani/order-status.js", () => ({
  pollKhalaniOrderToTerminal: async () => {
    callLog.push("poll");
    return { kind: "pending", status: "published" };
  },
}));

// The fee-on-transfer oracle is a network call — stubbed clean by default so
// the fee path runs; one test flips it to prove the skip.
const mockHoneypotFot = vi.fn(async () => ({ isHoneypot: false, isFOT: false, tax: 0 }));
vi.mock("@tools/kyberswap/token-api/client.js", () => ({
  getKyberTokenApiClient: () => ({ getHoneypotFotInfo: (...a: unknown[]) => mockHoneypotFot(...(a as [])) }),
}));

/** Ordered record of every money-path action, so ordering is asserted on facts. */
let callLog: string[] = [];

const mockSignStageKhalaniLeg = vi.fn();
vi.mock("@tools/khalani/bridge-executor.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tools/khalani/bridge-executor.js")>();
  return {
    ...actual,
    // The REAL planner is kept — leg ordering is the property under test.
    signStageKhalaniLeg: (...a: unknown[]) => mockSignStageKhalaniLeg(...a),
  };
});

const mockCreateBridgeActivityIntent = vi.fn();
const mockMarkActivityBroadcast = vi.fn();
const mockConfirmActivityEvent = vi.fn();
const mockFailActivityEvent = vi.fn();
const mockAbortPlannedEvents = vi.fn();
vi.mock("@vex-agent/db/repos/agent-activity.js", () => ({
  createBridgeActivityIntent: (...a: unknown[]) => mockCreateBridgeActivityIntent(...a),
  createBridgePreBroadcastFailure: async () => ({ executionId: 7, expectedFill: { id: 9 } }),
  attachProviderOrderId: async () => ({ outcome: "attached", row: { id: 200 } }),
  checkBridgeInFlight: async () => ({ inFlight: false, existing: null }),
  markActivityBroadcast: (...a: unknown[]) => mockMarkActivityBroadcast(...a),
  markActivitySolanaBroadcast: async () => ({ applied: true, row: {} }),
  markBroadcastAccepted: async () => ({ applied: true, row: {} }),
  confirmActivityEvent: (...a: unknown[]) => mockConfirmActivityEvent(...a),
  failActivityEvent: (...a: unknown[]) => mockFailActivityEvent(...a),
  abortPlannedEvents: (...a: unknown[]) => mockAbortPlannedEvents(...a),
}));


// The bound quote the execute revalidates its fee against. The gate itself has
// its own suites; what this one drives is the HANDLER's response to each answer.
const mockFindFreshMatchedPrequote = vi.fn();
vi.mock("@vex-agent/tools/protocols/prequote/gate.js", () => ({
  findFreshMatchedPrequote: (...a: unknown[]) => mockFindFreshMatchedPrequote(...a),
}));

vi.mock("@utils/logger.js", () => {
  const stub = { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() };
  return { default: stub, logger: stub };
});

import { BRIDGE_HANDLERS } from "@vex-agent/tools/protocols/khalani/handlers/bridge.js";
import {
  boundChargedVexFee,
  boundSkippedVexFee,
  matchedPrequoteWithVexFee,
} from "../../../tools/bridge-fee/bound-vex-fee.js";
import type { KhalaniStagedLeg } from "@tools/khalani/bridge-executor.js";

function evmSend(to: string, data: string, deposit: boolean) {
  return {
    type: "eip1193_request",
    deposit,
    request: { method: "eth_sendTransaction", params: [{ from: SESSION_EVM.address, to, data }] },
  };
}

function ctx(): ProtocolExecutionContext {
  return {
    sessionPermission: "full",
    approved: true,
    walletResolution: { source: "default" },
    walletPolicy: { kind: "none" },
    sessionId: "session-1",
    bridgeTokenPreview: {
      source: {
        family: "eip155", kind: "erc20", chainId: 8453, tokenAddress: FROM_TOKEN,
        symbol: "USDC", decimals: 6, metadataSource: "rpc_contract", symbolSanitized: false,
      },
      destination: {
        family: "eip155", kind: "erc20", chainId: 42161, tokenAddress: TO_TOKEN,
        symbol: "USDC.e", decimals: 6, metadataSource: "rpc_contract", symbolSanitized: false,
      },
      amountRaw: "1500000",
      amountHuman: "1.5",
    },
  } as ProtocolExecutionContext;
}

function execute(over: Record<string, unknown> = {}) {
  const handler = BRIDGE_HANDLERS["khalani.bridge"];
  if (!handler) throw new Error("khalani.bridge handler missing");
  return handler(
    { fromChain: "base", toChain: "arbitrum", fromToken: FROM_TOKEN, toToken: TO_TOKEN, amountRaw: "1500000", ...over },
    ctx(),
  );
}

function parse(out: string): Record<string, unknown> {
  return JSON.parse(out) as Record<string, unknown>;
}

/** The legs `signStageKhalaniLeg` was actually asked to sign, in order. */
function signedLegs(): KhalaniStagedLeg[] {
  return mockSignStageKhalaniLeg.mock.calls.map((call) => call[0] as KhalaniStagedLeg);
}

beforeEach(() => {
  vi.clearAllMocks();
  callLog = [];
  mockHoneypotFot.mockResolvedValue({ isHoneypot: false, isFOT: false, tax: 0 });
  // The approved quote for these exact params stated the same 25 bps of
  // 1_500_000 the default arrangement derives.
  mockFindFreshMatchedPrequote.mockResolvedValue(matchedPrequoteWithVexFee(boundChargedVexFee({
    feeAmountRaw: "3750", netAmountRaw: "1496250", totalDebitedRaw: "1500000",
    tokenAddress: FROM_TOKEN, tokenSymbol: "USDC", tokenDecimals: 6, feeAmountDecimal: "0.00375",
  })));
  mockPrepareQuoteRequest.mockImplementation(async (input: { amount: string }) => ({
    chains: mockChains, fromChainId: 8453, toChainId: 42161, fromFamily: "eip155", toFamily: "eip155",
    request: {
      tradeType: "EXACT_INPUT", fromChainId: 8453, fromToken: FROM_TOKEN, toChainId: 42161,
      toToken: TO_TOKEN, amount: input.amount, fromAddress: SESSION_EVM.address,
    },
  }));
  mockGetQuotes.mockImplementation(async (req: { amount: string }) => ({
    quoteId: "q1",
    routes: [{
      routeId: "r1", type: "Across", depositMethods: ["CONTRACT_CALL"],
      quote: { amountIn: req.amount, amountOut: "1495000", expectedDurationSeconds: 5, quoteExpiresAt: FUTURE },
    }],
  }));
  mockBuildDeposit.mockResolvedValue({
    kind: "CONTRACT_CALL",
    // A REAL `approve(router, netAmount)`: the planner refuses an approval it
    // cannot bind to the deposit call it precedes
    // (`@tools/evm-chains/erc20-approve-step-guard.ts`), so the bare selector
    // this fixture used to carry is no longer a plannable approval.
    approvals: [evmSend(FROM_TOKEN, approveCalldata(ROUTER, 1_496_250n), false), evmSend(ROUTER, "0xdeadbeef", true)],
  });
  mockSearchTokens.mockImplementation(async (address: string) => ({
    data: [{ address, chainId: address === FROM_TOKEN ? 8453 : 42161, symbol: "USDC", decimals: 6, extensions: { price: { usd: "1" } } }],
  }));
  mockCreateBridgeActivityIntent.mockResolvedValue({
    outcome: "created", executionId: 42,
    legs: [{ id: 100 }, { id: 101 }, { id: 102 }],
    expectedFill: { id: 200 },
  });
  mockMarkActivityBroadcast.mockResolvedValue({ applied: true, row: {} });
  mockConfirmActivityEvent.mockResolvedValue({ applied: true, row: {} });
  mockFailActivityEvent.mockResolvedValue({ applied: true, row: {} });
  mockAbortPlannedEvents.mockResolvedValue([]);
  mockSubmitDeposit.mockImplementation(async () => {
    callLog.push("submitDeposit");
    return { orderId: "o1" };
  });
  mockSignStageKhalaniLeg.mockImplementation(async (leg: KhalaniStagedLeg, _c, _ch, _s, hooks) => {
    callLog.push(`sign:${leg.purpose}:${leg.role}`);
    await hooks.onHashStaged({ txHash: `0x${leg.purpose}`, fromAddress: SESSION_EVM.address, nonce: 1 });
    await hooks.onAccepted();
    return { kind: "confirmed", txHash: `0x${leg.purpose}`, settledAtBlock: null };
  });
});

describe("khalani.bridge — the venue is quoted for amountIn − fee", () => {
  it("requests 1_496_250 for a 1_500_000 bridge (25 bps = 3_750), never the full amount", async () => {
    await execute();
    const request = mockGetQuotes.mock.calls[0]![0] as { amount: string };
    expect(request.amount).toBe("1496250");
    expect(request.amount).not.toBe("1500000");
  });

  it("discloses the fee on the execute output: raw, exact decimal, symbol, decimals, USD estimate", async () => {
    const result = await execute();
    const fee = parse(result.output).vexFee as Record<string, unknown>;
    expect(fee.charged).toBe(true);
    expect(fee.bps).toBe(25);
    expect(fee.chargedOn).toBe("currency_in");
    expect(fee.feeAmountRaw).toBe("3750");
    expect(fee.feeAmountDecimal).toBe("0.00375"); // exact, from the token's own 6 decimals
    expect(fee.tokenSymbol).toBe("USDC");
    expect(fee.tokenDecimals).toBe(6);
    expect(fee.feeUsdEstimate).toBe("0.00375");
    expect(fee.totalDebitedRaw).toBe("1500000");
    expect(fee.bridgedAmountRaw).toBe("1496250");
    expect(String(fee.note)).toMatch(/estimate/i);
  });

  it("the dryRun preview discloses the SAME fee the execute charges", async () => {
    const result = await execute({ dryRun: true });
    const fee = parse(result.output).vexFee as Record<string, unknown>;
    expect(fee.charged).toBe(true);
    expect(fee.feeAmountRaw).toBe("3750");
    expect((mockGetQuotes.mock.calls[0]![0] as { amount: string }).amount).toBe("1496250");
  });
});

describe("khalani.bridge — leg ordering: deposit first, fee last", () => {
  it("signs allowance → deposit → fee, and the fee runs only after the provider submit", async () => {
    await execute();
    expect(signedLegs().map((l) => l.purpose)).toEqual(["bridge", "bridge", "vex_fee"]);
    // The fee never delays the provider registration (separate lifecycles).
    expect(callLog).toEqual([
      "sign:bridge:allowance",
      "sign:bridge:bridge_deposit",
      "submitDeposit",
      // Migration 050: the fee leg carries its own `bridge_fee` role now, so
      // purpose and role finally agree. It was `sign:vex_fee:allowance` before.
      "sign:vex_fee:bridge_fee",
      "poll",
    ]);
  });

  it("a REVERTED deposit means the treasury transfer is NEVER signed or broadcast", async () => {
    mockSignStageKhalaniLeg.mockImplementation(async (leg: KhalaniStagedLeg, _c, _ch, _s, hooks) => {
      callLog.push(`sign:${leg.purpose}`);
      await hooks.onHashStaged({ txHash: "0xh", fromAddress: SESSION_EVM.address, nonce: 1 });
      await hooks.onAccepted();
      return leg.isDeposit
        ? { kind: "reverted", txHash: "0xdeposit" }
        : { kind: "confirmed", txHash: "0xallow", settledAtBlock: null };
    });

    const result = await execute();
    expect(result.success).toBe(false);
    expect(parse(result.output).status).toBe("reverted");

    // Nothing with `vex_fee` purpose ever reached the signer…
    expect(signedLegs().some((l) => l.purpose === "vex_fee")).toBe(false);
    // …and the fee row was never staged for broadcast (id 102 is the fee leg).
    const stagedRowIds = mockMarkActivityBroadcast.mock.calls.map((c) => c[0]);
    expect(stagedRowIds).not.toContain(102);
    expect(mockSubmitDeposit).not.toHaveBeenCalled();
  });

  it("an AMBIGUOUS deposit means no treasury transfer, and the fee row is aborted below the logical row", async () => {
    mockSignStageKhalaniLeg.mockImplementation(async (leg: KhalaniStagedLeg, _c, _ch, _s, hooks) => {
      await hooks.onHashStaged({ txHash: "0xh", fromAddress: SESSION_EVM.address, nonce: 1 });
      await hooks.onAccepted();
      return leg.isDeposit
        ? { kind: "ambiguous", txHash: "0xdeposit", stage: "confirm" }
        : { kind: "confirmed", txHash: "0xallow", settledAtBlock: null };
    });

    await execute();
    expect(signedLegs().some((l) => l.purpose === "vex_fee")).toBe(false);
    // Bounded abort: the fee row is finalized, the logical fill row (index 3)
    // stays pending so the in-flight guard survives for the W4 sweep.
    const abort = mockAbortPlannedEvents.mock.calls.at(-1)!;
    expect(abort[3]).toBe(3);
  });
});

describe("khalani.bridge — a failed fee is a PARTIAL PLAN SUCCESS, never a bridge failure", () => {
  it("a REVERTED fee transfer leaves the bridge pending and says the fee was not collected", async () => {
    mockSignStageKhalaniLeg.mockImplementation(async (leg: KhalaniStagedLeg, _c, _ch, _s, hooks) => {
      await hooks.onHashStaged({ txHash: "0xh", fromAddress: SESSION_EVM.address, nonce: 1 });
      await hooks.onAccepted();
      return leg.purpose === "vex_fee"
        ? { kind: "reverted", txHash: "0xfee" }
        : { kind: "confirmed", txHash: "0xdeposit", settledAtBlock: null };
    });

    const result = await execute();
    const data = parse(result.output);
    // The bridge is reported on its OWN terms — the fee did not touch it.
    expect(data.status).toBe("pending");
    expect(data.depositTxHash).toBe("0xdeposit");
    const fee = data.vexFee as Record<string, unknown>;
    expect(fee.collection).toBe("reverted");
    expect(String(fee.collectionNote)).toMatch(/bridge went through/i);
    expect(String(fee.collectionNote)).toMatch(/unaffected/i);
    // The failure is recorded against the FEE row (102), not the bridge.
    expect(mockFailActivityEvent).toHaveBeenCalledTimes(1);
    expect(mockFailActivityEvent.mock.calls[0]![0]).toBe(102);
  });

  it("an AMBIGUOUS fee broadcast is left for the sweep and NEVER re-sent", async () => {
    mockSignStageKhalaniLeg.mockImplementation(async (leg: KhalaniStagedLeg, _c, _ch, _s, hooks) => {
      await hooks.onHashStaged({ txHash: "0xh", fromAddress: SESSION_EVM.address, nonce: 1 });
      await hooks.onAccepted();
      return leg.purpose === "vex_fee"
        ? { kind: "ambiguous", txHash: "0xfee", stage: "send" }
        : { kind: "confirmed", txHash: "0xdeposit", settledAtBlock: null };
    });

    const result = await execute();
    const fee = parse(result.output).vexFee as Record<string, unknown>;
    expect(fee.collection).toBe("unconfirmed");
    expect(String(fee.collectionNote)).toMatch(/never re-sent/i);
    // Exactly one fee attempt — a blind retry could charge the user twice.
    expect(signedLegs().filter((l) => l.purpose === "vex_fee")).toHaveLength(1);
    // Its row stays PENDING: not failed, not aborted.
    expect(mockFailActivityEvent).not.toHaveBeenCalled();
    expect(parse(result.output).status).toBe("pending");
  });

  it("a fee leg that throws before signing does not fail or abort the bridge", async () => {
    mockSignStageKhalaniLeg.mockImplementation(async (leg: KhalaniStagedLeg, _c, _ch, _s, hooks) => {
      if (leg.purpose === "vex_fee") throw new Error("gas estimate failed");
      await hooks.onHashStaged({ txHash: "0xh", fromAddress: SESSION_EVM.address, nonce: 1 });
      await hooks.onAccepted();
      return { kind: "confirmed", txHash: "0xdeposit", settledAtBlock: null };
    });

    const result = await execute();
    const data = parse(result.output);
    expect(data.status).toBe("pending");
    expect(data.depositTxHash).toBe("0xdeposit");
    expect((data.vexFee as Record<string, unknown>).collection).toBe("not_attempted");
    // The logical fill row is never aborted by a fee failure.
    for (const call of mockAbortPlannedEvents.mock.calls) {
      expect(call[3]).toBe(3);
    }
  });
});

describe("khalani.bridge — no fee is taken when it cannot be taken honestly", () => {
  it("DUST: a fee that floors to 0 charges nothing and bridges the full amount", async () => {
    mockFindFreshMatchedPrequote.mockResolvedValue(
      matchedPrequoteWithVexFee(boundSkippedVexFee({ totalDebitedRaw: "300" })),
    );
    const result = await execute({ amountRaw: "300" });
    expect((mockGetQuotes.mock.calls[0]![0] as { amount: string }).amount).toBe("300");
    expect(signedLegs().some((l) => l.purpose === "vex_fee")).toBe(false);

    const fee = parse(result.output).vexFee as Record<string, unknown>;
    expect(fee.charged).toBe(false);
    expect(fee.bps).toBe(0);
    expect(String(fee.reason)).toMatch(/floors to 0/i);
    expect(fee.bridgedAmountRaw).toBe("300");
  });

  it("FEE-ON-TRANSFER token: no fee leg, full amount quoted, reason disclosed", async () => {
    mockHoneypotFot.mockResolvedValue({ isHoneypot: false, isFOT: true, tax: 5 });
    // The quote that authorized this execute saw the same flagged token.
    mockFindFreshMatchedPrequote.mockResolvedValue(matchedPrequoteWithVexFee(boundSkippedVexFee({
      totalDebitedRaw: "1500000",
      reason: "the origin token is fee-on-transfer (5% tax), so a treasury transfer would not deliver the stated amount",
    })));

    const result = await execute();
    expect((mockGetQuotes.mock.calls[0]![0] as { amount: string }).amount).toBe("1500000");
    expect(signedLegs().some((l) => l.purpose === "vex_fee")).toBe(false);

    const fee = parse(result.output).vexFee as Record<string, unknown>;
    expect(fee.charged).toBe(false);
    expect(String(fee.reason)).toMatch(/fee-on-transfer/i);
  });

  it("a failing FoT oracle does not block the bridge (fail-soft)", async () => {
    mockHoneypotFot.mockRejectedValue(new Error("token api down"));
    const result = await execute();
    expect((parse(result.output).vexFee as Record<string, unknown>).charged).toBe(true);
  });
});

describe("khalani.bridge - the fee must still match the statement the approval was granted on", () => {
  /** Nothing may have been signed, broadcast, planned or recorded. */
  function assertNothingHappened(): void {
    expect(mockSignStageKhalaniLeg).not.toHaveBeenCalled();
    expect(mockCreateBridgeActivityIntent).not.toHaveBeenCalled();
    expect(mockSubmitDeposit).not.toHaveBeenCalled();
  }

  it("REFUSES before any signing when the card said a fee is taken and the token is now fee-on-transfer", async () => {
    // The row still states the charged fee (default arrangement); the fresh
    // eligibility read declines it. Consuming the row would hand a treasury
    // transfer to a taxing token; re-deriving alone would bridge an amount the
    // card never stated. Both are refused here.
    mockHoneypotFot.mockResolvedValue({ isHoneypot: false, isFOT: true, tax: 3 });

    const result = await execute();

    expect(result.success).toBe(false);
    expect(result.output).toContain("khalani.bridge failed:");
    expect(result.output).toContain("The Vex fee statement this approval was granted on no longer holds");
    expect(result.output).toContain("would no longer be taken");
    expect(result.output).toContain("Nothing was signed and nothing was broadcast");
    expect(result.output).toContain("khalani__bridge_quote_get");
    assertNothingHappened();
  });

  it("REFUSES when the card stated no fee and this execute would take one", async () => {
    mockFindFreshMatchedPrequote.mockResolvedValue(
      matchedPrequoteWithVexFee(boundSkippedVexFee({ totalDebitedRaw: "1500000" })),
    );

    const result = await execute();

    expect(result.success).toBe(false);
    expect(result.output).toContain("NO Vex fee would be taken");
    assertNothingHappened();
  });

  it("REFUSES and names the moved amount when the bound fee is not the fee this bridge would take", async () => {
    mockFindFreshMatchedPrequote.mockResolvedValue(matchedPrequoteWithVexFee(boundChargedVexFee({
      feeAmountRaw: "3000", netAmountRaw: "1497000", totalDebitedRaw: "1500000",
    })));

    const result = await execute();

    expect(result.success).toBe(false);
    expect(result.output).toContain("3000 raw units");
    expect(result.output).toContain("3750 raw units");
    assertNothingHappened();
  });

  it("FAILS CLOSED when the bound row carries no readable fee statement at all", async () => {
    mockFindFreshMatchedPrequote.mockResolvedValue(matchedPrequoteWithVexFee(undefined));

    const result = await execute();

    expect(result.success).toBe(false);
    expect(result.output).toContain("no readable Vex fee statement");
    assertNothingHappened();
  });

  it("REFUSES when the approved row was superseded while the approval waited", async () => {
    mockFindFreshMatchedPrequote.mockResolvedValue({ ok: false, reason: "approval_row_superseded" });

    const result = await execute();

    expect(result.success).toBe(false);
    expect(result.output).toContain("no longer the current one");
    assertNothingHappened();
  });

  it("still signs the whole plan when the statement holds", async () => {
    const result = await execute();

    expect(parse(result.output).status).toBe("pending");
    expect(signedLegs().map((l) => l.purpose)).toEqual(["bridge", "bridge", "vex_fee"]);
  });

  it("a dryRun never reads the bound row: it is a preview, it signs nothing", async () => {
    await execute({ dryRun: true });
    expect(mockFindFreshMatchedPrequote).not.toHaveBeenCalled();
  });
});

describe("khalani.bridge — caller-supplied fee params are still rejected by name", () => {
  it.each(["referrer", "referrerFeeBps"])("%s is refused before any quote or signing", async (key) => {
    const result = await execute({ [key]: "0x" + "ef".repeat(20) });
    expect(result.success).toBe(false);
    expect(result.output).toContain(key);
    expect(result.output).toContain("not an accepted parameter");
    expect(result.output).toMatch(/never takes fee parameters from tool input/);
    expect(mockGetQuotes).not.toHaveBeenCalled();
    expect(mockSignStageKhalaniLeg).not.toHaveBeenCalled();
  });
});
