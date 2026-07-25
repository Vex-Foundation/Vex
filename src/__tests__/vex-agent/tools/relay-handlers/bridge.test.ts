/**
 * relay.bridge / relay.quote.get — W-SPINE agent_activity staged contract (W3b).
 *
 * Adversarial staged suite: every PRE-SIGN gate failure records a HASHLESS
 * `definitively_failed` row and broadcasts NOTHING (C1); staging is per-leg
 * (planned → sign → CAS → broadcast → accepted, R4); a CAS miss aborts before an
 * untracked broadcast; a destination-chain step is rejected (origin-only, B3);
 * the pending output is TRUTHFUL (success:false, "tracked automatically", the
 * logical row stays pending for W4 — success-while-pending is FORBIDDEN, B5);
 * the in-flight guard (C2) surfaces a clear message; USD is nullable end-to-end.
 *
 * The W2 gate helpers (health / correlation / step-policy / quote adapter) and
 * the W-SPINE repo primitives are mocked so the HANDLER's orchestration is
 * isolated (the helpers have their own suites).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ProtocolExecutionContext } from "@vex-agent/tools/protocols/types.js";
import type { RelayQuoteResponse } from "@tools/relay/types.js";

const SEL_EVM = "0x1111111111111111111111111111111111111111";
const ZERO = "0x0000000000000000000000000000000000000000";
const ERC20 = "0xc6911796042b15d7Fa4F6CDe69e245DdCd3d9c31";

// ── Relay client (getQuote + getIntentStatus) + cached chains ──
const mockGetQuote = vi.fn();
const mockGetIntentStatus = vi.fn();
const mockGetCachedRelayChains = vi.fn();
vi.mock("@tools/relay/client.js", () => ({
  getRelayClient: () => ({
    getQuote: (...a: unknown[]) => mockGetQuote(...a),
    getIntentStatus: (...a: unknown[]) => mockGetIntentStatus(...a),
  }),
  getCachedRelayChains: (...a: unknown[]) => mockGetCachedRelayChains(...a),
}));

// ── Execution primitives (IO) — planRelayStepTx mocked to a fixed tx so staging
//    orchestration is decoupled from tx parsing (parsing is covered in execute.test.ts). ──
const mockResolveStepClients = vi.fn();
const mockPoll = vi.fn();
const mockPlanStepTx = vi.fn();
vi.mock("@tools/relay/execute.js", () => ({
  resolveRelayStepClients: (...a: unknown[]) => mockResolveStepClients(...a),
  pollRelayIntentStatus: (...a: unknown[]) => mockPoll(...a),
  planRelayStepTx: (...a: unknown[]) => mockPlanStepTx(...a),
}));

// ── Shared staged-broadcast primitive (drives the leg outcome + invokes hooks). ──
const mockSign = vi.fn();
vi.mock("@tools/kyberswap/evm/staged-broadcast.js", () => ({
  signStageBroadcast: (...a: unknown[]) => mockSign(...a),
}));

// ── W2 pre-sign gate helpers (control each gate outcome). ──
const mockHealth = vi.fn();
vi.mock("@tools/relay/health.js", () => ({ evaluateRelayRouteHealth: (...a: unknown[]) => mockHealth(...a) }));
const mockCorrelation = vi.fn();
vi.mock("@tools/relay/correlation.js", () => ({ assertRelayQuoteCorrelation: (...a: unknown[]) => mockCorrelation(...a) }));
const mockStepPolicy = vi.fn();
vi.mock("@tools/relay/step-policy.js", () => ({ classifyRelayBridgeSteps: (...a: unknown[]) => mockStepPolicy(...a) }));
const mockAdapt = vi.fn();
vi.mock("@tools/relay/quote.js", () => ({
  adaptRelayQuote: (...a: unknown[]) => mockAdapt(...a),
  RELAY_QUOTE_USD_SOURCE: "relay_quote_v2",
}));

// ── Wallet resolution ──
vi.mock("@vex-agent/tools/internal/wallet/resolve.js", () => ({
  resolveSelectedAddress: () => SEL_EVM,
  resolveSigningWallet: () => ({ family: "eip155", address: SEL_EVM, privateKey: ("0x" + "ab".repeat(32)) as `0x${string}` }),
  walletScopeErrorToResult: (err: unknown) => ({ success: false, output: err instanceof Error ? err.message : String(err) }),
}));

// ── Config + tracked tokens ──
vi.mock("@config/store.js", () => ({ loadConfig: () => ({ services: { relayApiUrl: "https://api.relay.link" } }) }));
const mockPin = vi.fn();
vi.mock("@vex-agent/db/repos/tracked-tokens.js", () => ({ pinTrackedToken: (...a: unknown[]) => mockPin(...a) }));

// ── W-SPINE agent_activity repo ──
const mockCreateIntent = vi.fn();
const mockPreFail = vi.fn();
const mockCheckInFlight = vi.fn();
const mockAttach = vi.fn();
const mockMarkBroadcast = vi.fn();
const mockMarkAccepted = vi.fn();
const mockConfirm = vi.fn();
const mockFail = vi.fn();
const mockAbort = vi.fn();
vi.mock("@vex-agent/db/repos/agent-activity.js", () => ({
  createBridgeActivityIntent: (...a: unknown[]) => mockCreateIntent(...a),
  createBridgePreBroadcastFailure: (...a: unknown[]) => mockPreFail(...a),
  checkBridgeInFlight: (...a: unknown[]) => mockCheckInFlight(...a),
  attachProviderOrderId: (...a: unknown[]) => mockAttach(...a),
  markActivityBroadcast: (...a: unknown[]) => mockMarkBroadcast(...a),
  markBroadcastAccepted: (...a: unknown[]) => mockMarkAccepted(...a),
  confirmActivityEvent: (...a: unknown[]) => mockConfirm(...a),
  failActivityEvent: (...a: unknown[]) => mockFail(...a),
  abortPlannedEvents: (...a: unknown[]) => mockAbort(...a),
}));

const { RELAY_BRIDGE_HANDLERS } = await import("@vex-agent/tools/protocols/relay/handlers/bridge.js");
const { DependentLegGasEstimateError, DEPENDENT_LEG_ESTIMATE_MARKER } =
  await import("@tools/evm-chains/dependent-leg-gas-estimate.js");

const CTX: ProtocolExecutionContext = {
  sessionPermission: "full",
  approved: true,
  walletResolution: { source: "session", evm: { id: "w-evm", address: SEL_EVM }, solana: null },
  walletPolicy: { kind: "none" },
  sessionId: "sess-1",
};

const CHAINS = [
  { id: 8453, name: "base", displayName: "Base", currency: { symbol: "ETH", decimals: 18 }, vmType: "evm", depositEnabled: true, disabled: false },
  { id: 4663, name: "robinhood", displayName: "Robinhood Chain", currency: { symbol: "ETH", decimals: 18 }, vmType: "evm", depositEnabled: true, disabled: false },
];

const PARAMS = { fromChain: "base", fromToken: "native", toChain: "robinhood", toToken: "native", amount: "1000000000000000" };

function txStep(id: string, chainId = 8453) {
  return { id, kind: "transaction", requestId: "0xreq", items: [{ data: { to: "0x2222222222222222222222222222222222222222", value: "1000000000000000", data: "0x", chainId } }] };
}
function quote(steps = [txStep("deposit")]): RelayQuoteResponse {
  return { steps, requestId: "0xreq" } as unknown as RelayQuoteResponse;
}

function adaptedOk(overrides: Record<string, unknown> = {}) {
  return {
    requestId: "0xreq",
    operation: "bridge",
    timeEstimateSeconds: 12,
    usdSource: "relay_quote_v2",
    currencyIn: { symbol: "ETH", decimals: 18, currencyAddress: ZERO, amountRaw: "1000000000000000", amountFormatted: "0.001", amountUsd: "2.94" },
    currencyOut: { symbol: "ETH", decimals: 18, currencyAddress: ZERO, amountRaw: "995000000000000", amountFormatted: "0.000995", amountUsd: "2.92" },
    feeUsdByBucket: { relayer: "0.02" },
    ...overrides,
  };
}

/** signStageBroadcast mock that invokes the staging hooks then returns `kind`. */
function signAs(kind: "confirmed" | "reverted" | "ambiguous", txHash: string) {
  return async (_p: unknown, _w: unknown, _tx: unknown, hooks: { onHashStaged: (h: unknown) => Promise<void>; onAccepted: () => Promise<void> }) => {
    await hooks.onHashStaged({ txHash, fromAddress: SEL_EVM, nonce: 1 });
    await hooks.onAccepted();
    return kind === "ambiguous" ? { kind, txHash, stage: "send" } : { kind, txHash, receipt: {} };
  };
}

const depositStep = { stepId: "deposit", role: "bridge_deposit", chainId: 8453, step: txStep("deposit") };
const approveStep = { stepId: "approve", role: "allowance", chainId: 8453, step: txStep("approve") };

async function runBridge(params: Record<string, unknown> = PARAMS) {
  return RELAY_BRIDGE_HANDLERS["relay.bridge"]!(params, CTX);
}
function outputOf(result: { output: string }): Record<string, unknown> {
  return JSON.parse(result.output) as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetCachedRelayChains.mockResolvedValue(CHAINS);
  mockGetQuote.mockResolvedValue(quote());
  mockAdapt.mockReturnValue(adaptedOk());
  mockHealth.mockReturnValue({ serviceable: true, origin: CHAINS[0], destination: CHAINS[1] });
  mockCorrelation.mockReturnValue({ ok: true, requestId: "0xreq" });
  mockStepPolicy.mockReturnValue({ ok: true, steps: [depositStep] });
  mockCheckInFlight.mockResolvedValue({ inFlight: false, existing: null });
  mockResolveStepClients.mockResolvedValue({ publicClient: {}, walletClient: {} });
  mockPlanStepTx.mockReturnValue({ to: "0x2222222222222222222222222222222222222222", data: "0x", value: 0n });
  mockPoll.mockResolvedValue({ status: "submitted", observed: true, destinationTxHashes: [] });
  mockPreFail.mockResolvedValue({ executionId: 900, expectedFill: { id: 901 } });
  mockCreateIntent.mockImplementation(async (input: { legs: unknown[] }) => ({
    outcome: "created",
    executionId: 100,
    legs: input.legs.map((_l, i) => ({ id: 200 + i })),
    expectedFill: { id: 300 },
  }));
  mockAttach.mockResolvedValue({ outcome: "attached", row: { id: 300 } });
  mockMarkBroadcast.mockResolvedValue({ applied: true, row: { id: 0 } });
  mockMarkAccepted.mockResolvedValue({ applied: true, row: { id: 0 } });
  mockConfirm.mockResolvedValue({ applied: true, row: { id: 0 } });
  mockFail.mockResolvedValue({ applied: true, row: { id: 0 } });
  mockAbort.mockResolvedValue([]);
  mockSign.mockImplementation(signAs("confirmed", "0xdep"));
  mockPin.mockResolvedValue({ inserted: true });
});

// ── Pre-sign gates: each failure records a HASHLESS row + broadcasts NOTHING ──
describe("relay.bridge — pre-sign gate failures (C1: hashless failed row, no broadcast)", () => {
  it("health gate unserviceable → chain_unsupported failure row, no intent, no sign", async () => {
    mockHealth.mockReturnValue({ serviceable: false, failedSide: "destination", chainId: 4663, reason: "deposit_not_enabled" });
    const result = await runBridge();
    expect(result.success).toBe(false);
    expect(mockPreFail).toHaveBeenCalledTimes(1);
    expect(mockPreFail.mock.calls[0]![0]).toMatchObject({ failureCode: "chain_unsupported", protocol: "relay", toolId: "relay.bridge" });
    expect(mockGetQuote).not.toHaveBeenCalled(); // health fails BEFORE the quote
    expect(mockCreateIntent).not.toHaveBeenCalled();
    expect(mockSign).not.toHaveBeenCalled();
    expect(outputOf(result).status).toBe("rejected");
  });

  it("correlation gate failure → bridge_failed failure row, no intent, no sign", async () => {
    mockCorrelation.mockReturnValue({ ok: false, reason: "missing_request_id", stepId: null, detail: "no requestId" });
    const result = await runBridge();
    expect(result.success).toBe(false);
    expect(mockPreFail.mock.calls[0]![0]).toMatchObject({ failureCode: "bridge_failed" });
    expect(mockCreateIntent).not.toHaveBeenCalled();
    expect(mockSign).not.toHaveBeenCalled();
  });

  it("step-policy rejection (origin-only, B3) → bridge_failed failure row, no sign", async () => {
    mockStepPolicy.mockReturnValue({ ok: false, reason: "step_chain_not_origin", stepId: "deposit", detail: "targets chain 4663, not the origin 8453" });
    const result = await runBridge();
    expect(result.success).toBe(false);
    expect(mockPreFail.mock.calls[0]![0]).toMatchObject({ failureCode: "bridge_failed" });
    expect(String(mockPreFail.mock.calls[0]![0].failureReason)).toContain("origin");
    expect(mockSign).not.toHaveBeenCalled();
  });

  it("no origin deposit as the final step → bridge_failed failure row, no sign", async () => {
    mockStepPolicy.mockReturnValue({ ok: true, steps: [approveStep] }); // approve only, no deposit
    const result = await runBridge();
    expect(result.success).toBe(false);
    expect(mockPreFail.mock.calls[0]![0]).toMatchObject({ failureCode: "bridge_failed" });
    expect(mockSign).not.toHaveBeenCalled();
  });

  it("empty quote steps → route_not_found failure row, no sign", async () => {
    mockGetQuote.mockResolvedValue(quote([]));
    const result = await runBridge();
    expect(result.success).toBe(false);
    expect(mockPreFail.mock.calls[0]![0]).toMatchObject({ failureCode: "route_not_found" });
    expect(mockSign).not.toHaveBeenCalled();
  });

  it("getQuote throws → bridge_failed failure row (scrubbed), no sign", async () => {
    mockGetQuote.mockRejectedValue(new Error("relay 500 https://api.relay.link/quote/v2 boom"));
    const result = await runBridge();
    expect(result.success).toBe(false);
    expect(mockPreFail.mock.calls[0]![0]).toMatchObject({ failureCode: "bridge_failed" });
    expect(mockSign).not.toHaveBeenCalled();
  });

  it("client resolution failure is PRE-intent → hashless failed row, no intent, no strand (blocker 3)", async () => {
    // Registry/RPC/client construction fails (e.g. a Relay-only origin with no
    // safe RPC). It must fail BEFORE the intent exists so no pending plan is
    // stranded and the in-flight guard is never taken.
    mockResolveStepClients.mockRejectedValue(new Error("relay chain 999 exposes no safe public HTTPS RPC"));
    const result = await runBridge();
    expect(result.success).toBe(false);
    expect(outputOf(result).status).toBe("rejected");
    expect(mockPreFail).toHaveBeenCalledTimes(1);
    expect(mockPreFail.mock.calls[0]![0]).toMatchObject({ failureCode: "bridge_failed" });
    expect(mockCreateIntent).not.toHaveBeenCalled();
    expect(mockSign).not.toHaveBeenCalled();
    expect(mockAbort).not.toHaveBeenCalled();
  });
});

// ── In-flight guard (C2) ──
describe("relay.bridge — in-flight guard (C2)", () => {
  it("friendly pre-check inFlight → clear message, no intent, no sign", async () => {
    mockCheckInFlight.mockResolvedValue({ inFlight: true, existing: { id: 5 } });
    const result = await runBridge();
    expect(result.success).toBe(false);
    expect(String(outputOf(result).message)).toMatch(/already in flight for this route/i);
    expect(mockCreateIntent).not.toHaveBeenCalled();
    expect(mockSign).not.toHaveBeenCalled();
  });

  it("authoritative DB conflict (unique violation) → clear message, no sign", async () => {
    mockCreateIntent.mockResolvedValue({ outcome: "in_flight_conflict", existing: null });
    const result = await runBridge();
    expect(result.success).toBe(false);
    expect(String(outputOf(result).message)).toMatch(/already in flight for this route/i);
    expect(mockSign).not.toHaveBeenCalled();
  });
});

// ── Staged broadcast + truthful pending output ──
describe("relay.bridge — staged broadcast (R4) + truthful pending (B5/C3)", () => {
  it("confirmed deposit → success:false pending, logical NOT confirmed, requestId attached, tracked-automatically", async () => {
    const result = await runBridge();
    // success-while-pending is FORBIDDEN: a broadcast bridge is NOT final.
    expect(result.success).toBe(false);
    const out = outputOf(result);
    expect(out.status).toBe("pending");
    expect(out.requestId).toBe("0xreq");
    // TWO origin broadcasts now: the deposit, then Vex's own 25 bps treasury
    // transfer (`@tools/bridge-fee`). The fee leg is a real movement of user
    // funds, so it is surfaced here rather than hidden. `mockSign` returns the
    // same stub hash for both.
    expect(out.inTxHashes).toEqual(["0xdep", "0xdep"]);
    expect(String(out.message)).toMatch(/track(?:ed|ing)(?: it)? automatically/i);

    // Full staging discipline ran for the deposit leg AND the fee leg.
    expect(mockMarkBroadcast).toHaveBeenCalledTimes(2);
    expect(mockMarkAccepted).toHaveBeenCalledTimes(2);
    expect(mockConfirm).toHaveBeenCalledWith(200, {});
    // The fee is disclosed on the execute output, never silent.
    const vexFee = out.vexFee as Record<string, unknown>;
    expect(vexFee.charged).toBe(true);
    expect(vexFee.bps).toBe(25);
    expect(vexFee.feeAmountRaw).toBe("2500000000000"); // 25 bps of 1e15 wei
    expect(vexFee.collection).toBe("confirmed");
    // requestId attached AFTER submission (R5).
    expect(mockAttach).toHaveBeenCalledWith({ executionId: 100, providerOrderId: "0xreq" });
    // The logical fill row is NEVER confirmed in-turn (W4 owns verified confirm).
    expect(mockConfirm).not.toHaveBeenCalledWith(300, expect.anything());
    expect(mockPoll).toHaveBeenCalledWith("0xreq");
    expect(mockFail).not.toHaveBeenCalled();
  });

  it("_executionId is threaded so post-handler capture reuses the intent row", async () => {
    const result = await runBridge();
    expect((result.data as { _executionId?: number })._executionId).toBe(100);
  });

  it("a confirm CAS miss to a non-confirmed state marks the leg confirmed_unrecorded, never ordinary (m5-relay / C41)", async () => {
    mockConfirm.mockResolvedValue({ applied: false, row: { id: 200, status: "definitively_failed" } });
    const result = await runBridge();
    const legs = outputOf(result).legs as Array<{ role: string; status: string }>;
    const deposit = legs.find((l) => l.role === "bridge_deposit");
    expect(deposit?.status).toBe("confirmed_unrecorded");
  });

  it("a confirm CAS miss where the row is ALREADY confirmed is a benign race → ordinary confirmed", async () => {
    mockConfirm.mockResolvedValue({ applied: false, row: { id: 200, status: "confirmed" } });
    const result = await runBridge();
    const legs = outputOf(result).legs as Array<{ role: string; status: string }>;
    const deposit = legs.find((l) => l.role === "bridge_deposit");
    expect(deposit?.status).toBe("confirmed");
  });

  it("in-turn provider 'success' still returns NOT-final (verified confirm left to W4)", async () => {
    mockPoll.mockResolvedValue({ status: "success", observed: true, destinationTxHashes: ["0xfill"] });
    const result = await runBridge();
    expect(result.success).toBe(false);
    const out = outputOf(result);
    expect(out.status).toBe("pending");
    expect(out.txHashes).toEqual(["0xfill"]);
    expect(String(out.message)).toMatch(/verify|in progress/i);
    expect(mockConfirm).not.toHaveBeenCalledWith(300, expect.anything());
  });

  it("in-turn provider 'refund' surfaces the money-back-≠-success distinction, row stays pending for W4", async () => {
    mockPoll.mockResolvedValue({ status: "refund", observed: true, destinationTxHashes: [] });
    const result = await runBridge();
    expect(result.success).toBe(false);
    expect(String(outputOf(result).message)).toMatch(/refund/i);
    // Never terminalized in-turn (W4's verified sweep owns refund terminalization).
    expect(mockFail).not.toHaveBeenCalled();
  });

  it("ERC-20 onto a local chain is auto-pinned (fail-soft)", async () => {
    await runBridge({ ...PARAMS, toToken: ERC20 });
    expect(mockPin).toHaveBeenCalledWith({ walletAddress: SEL_EVM, chainId: 4663, tokenAddress: ERC20, source: "bridge" });
  });

  it("a NATIVE destination is not pinned (native is always read)", async () => {
    await runBridge({ ...PARAMS, toToken: "native" });
    expect(mockPin).not.toHaveBeenCalled();
  });
});

// ── Staging failure modes ──
describe("relay.bridge — staging failure modes", () => {
  it("CAS miss on markActivityBroadcast aborts BEFORE an untracked broadcast", async () => {
    mockMarkBroadcast.mockResolvedValue({ applied: false, row: { id: 0 } });
    const result = await runBridge();
    expect(result.success).toBe(false);
    expect(outputOf(result).status).toBe("interrupted");
    // Never confirmed; the never-signed rows are aborted.
    expect(mockConfirm).not.toHaveBeenCalled();
    expect(mockAbort).toHaveBeenCalledWith(100, 0, expect.any(String));
  });

  it("origin deposit reverted → leg + logical failed bridge_failed, remaining aborted", async () => {
    mockSign.mockImplementation(signAs("reverted", "0xrev"));
    const result = await runBridge();
    expect(result.success).toBe(false);
    expect(outputOf(result).status).toBe("failed");
    expect(mockFail).toHaveBeenCalledWith(200, expect.objectContaining({ failureCode: "bridge_failed" }));
    expect(mockFail).toHaveBeenCalledWith(300, expect.objectContaining({ failureCode: "bridge_failed" }));
    expect(mockAttach).not.toHaveBeenCalled();
  });

  it("ambiguous deposit → pending (unconfirmed), requestId attached, NO in-turn poll", async () => {
    mockSign.mockImplementation(signAs("ambiguous", "0xamb"));
    const result = await runBridge();
    expect(result.success).toBe(false);
    expect(outputOf(result).status).toBe("pending");
    expect(String(outputOf(result).message)).toMatch(/could not yet confirm/i);
    expect(mockAttach).toHaveBeenCalledWith({ executionId: 100, providerOrderId: "0xreq" });
    expect(mockPoll).not.toHaveBeenCalled();
    expect(mockFail).not.toHaveBeenCalled();
  });

  it("ambiguous APPROVE → deposit never signed, deposit + logical aborted, one broadcast only", async () => {
    mockStepPolicy.mockReturnValue({ ok: true, steps: [approveStep, depositStep] });
    mockSign.mockImplementation(signAs("ambiguous", "0xapprove")); // the FIRST (approve) leg is ambiguous
    const result = await runBridge();
    expect(result.success).toBe(false);
    expect(outputOf(result).status).toBe("unconfirmed");
    expect(mockSign).toHaveBeenCalledTimes(1); // deposit was never signed
    expect(mockAbort).toHaveBeenCalledWith(100, 1, expect.any(String)); // aborts deposit + logical
  });

  it("attach anomaly (conflict_different_id) is best-effort — the bridge still returns pending", async () => {
    mockAttach.mockResolvedValue({ outcome: "conflict_different_id", row: { id: 300 } });
    const result = await runBridge();
    expect(result.success).toBe(false);
    expect(outputOf(result).status).toBe("pending");
  });
});

/**
 * Live 2026-07-25 regression: the origin approve
 * `0x68dec753bc925c2d255104e22a27cc0c62ea9b5c85160fd99661a0009f378548`
 * CONFIRMED, then the deposit leg was refused pre-sign with `Execution
 * reverted for an unknown reason`; an immediate retry of the unchanged
 * transaction landed (`0xc96bfee1…`). The refusal was reported as an
 * unexplained interruption, which is what makes a transient RPC lag permanent
 * for an autonomous agent.
 */
describe("relay.bridge — deposit refused because its estimate never succeeded after a confirmed approve", () => {
  const APPROVE_BLOCK = 34_567_890n;
  const LIVE_DEPOSIT_REVERT = "Execution reverted for an unknown reason.";

  /** approve confirms (carrying its receipt block), then the deposit leg throws `err`. */
  function approveThenDepositThrows(err: Error) {
    let leg = 0;
    return async (
      _p: unknown, _w: unknown, _tx: unknown,
      hooks: { onHashStaged: (h: unknown) => Promise<void>; onAccepted: () => Promise<void> },
    ) => {
      if (leg++ === 0) {
        await hooks.onHashStaged({ txHash: "0xapprove", fromAddress: SEL_EVM, nonce: 1 });
        await hooks.onAccepted();
        return { kind: "confirmed", txHash: "0xapprove", receipt: { blockNumber: APPROVE_BLOCK } };
      }
      throw err;
    };
  }

  beforeEach(() => {
    mockStepPolicy.mockReturnValue({ ok: true, steps: [approveStep, depositStep] });
  });

  it("threads the confirmed approve's receipt block into the deposit leg's estimate", async () => {
    mockSign.mockImplementation(approveThenDepositThrows(new Error(LIVE_DEPOSIT_REVERT)));

    await runBridge();

    expect(mockSign).toHaveBeenCalledTimes(2);
    expect(mockSign.mock.calls[0]![4]).toBeUndefined(); // the approve has nothing before it
    expect(mockSign.mock.calls[1]![4]).toEqual({ blockNumber: APPROVE_BLOCK });
  });

  it("reports a stale-estimate refusal as not_attempted + safe to re-run, and records the marker", async () => {
    mockSign.mockImplementation(approveThenDepositThrows(new DependentLegGasEstimateError({
      attempts: 3,
      priorLegBlockNumber: APPROVE_BLOCK,
      observedHeadBlock: APPROVE_BLOCK,
      cause: new Error(LIVE_DEPOSIT_REVERT),
    })));

    const result = await runBridge();
    const body = outputOf(result);

    expect(result.success).toBe(false);
    expect(body.status).toBe("not_attempted");
    expect(String(body.message)).toContain("Nothing was signed or broadcast");
    expect(String(body.message)).toContain("reasonable");
    // The durable reason (via abortPlannedEvents) carries the same discriminator.
    expect(mockAbort).toHaveBeenCalledWith(100, 1, expect.stringContaining(DEPENDENT_LEG_ESTIMATE_MARKER));
    // Aborting from the deposit index onward finalizes the logical fill row too,
    // which is what releases the in-flight guard so re-running is actually possible.
    expect(mockFail).not.toHaveBeenCalled();
  });

  it("a genuine failure at the same point still reads as an interruption — the two are NOT the same message", async () => {
    mockSign.mockImplementation(approveThenDepositThrows(new Error(LIVE_DEPOSIT_REVERT)));
    const genuine = outputOf(await runBridge());

    vi.clearAllMocks();
    mockGetCachedRelayChains.mockResolvedValue(CHAINS);
    mockGetQuote.mockResolvedValue(quote());
    mockAdapt.mockReturnValue(adaptedOk());
    mockHealth.mockReturnValue({ serviceable: true, origin: CHAINS[0], destination: CHAINS[1] });
    mockCorrelation.mockReturnValue({ ok: true, requestId: "0xreq" });
    mockStepPolicy.mockReturnValue({ ok: true, steps: [approveStep, depositStep] });
    mockCheckInFlight.mockResolvedValue({ inFlight: false, existing: null });
    mockResolveStepClients.mockResolvedValue({ publicClient: {}, walletClient: {} });
    mockPlanStepTx.mockReturnValue({ to: "0x2222222222222222222222222222222222222222", data: "0x", value: 0n });
    mockCreateIntent.mockImplementation(async (input: { legs: unknown[] }) => ({
      outcome: "created", executionId: 100,
      legs: input.legs.map((_l, i) => ({ id: 200 + i })), expectedFill: { id: 300 },
    }));
    mockMarkBroadcast.mockResolvedValue({ applied: true, row: { id: 0 } });
    mockMarkAccepted.mockResolvedValue({ applied: true, row: { id: 0 } });
    mockConfirm.mockResolvedValue({ applied: true, row: { id: 0 } });
    mockAbort.mockResolvedValue([]);
    mockSign.mockImplementation(approveThenDepositThrows(new DependentLegGasEstimateError({
      attempts: 3,
      priorLegBlockNumber: APPROVE_BLOCK,
      observedHeadBlock: APPROVE_BLOCK,
      cause: new Error(LIVE_DEPOSIT_REVERT),
    })));
    const stale = outputOf(await runBridge());

    expect(genuine.status).toBe("interrupted");
    expect(String(genuine.message)).toContain("An internal error interrupted the bridge");
    expect(String(genuine.message)).not.toContain("Nothing was signed or broadcast");
    expect(String(stale.message)).not.toEqual(String(genuine.message));
  });
});

// ── USD nullable propagation ──
describe("relay.bridge — USD nullable end-to-end (Q2)", () => {
  it("null quote USD → expectedFill usd*Est undefined + output usd null (never fabricated)", async () => {
    mockAdapt.mockReturnValue(adaptedOk({
      currencyIn: { symbol: "ETH", decimals: 18, currencyAddress: ZERO, amountRaw: "1000000000000000", amountFormatted: "0.001", amountUsd: null },
      currencyOut: { symbol: "ETH", decimals: 18, currencyAddress: ZERO, amountRaw: "995000000000000", amountFormatted: "0.000995", amountUsd: null },
    }));
    const result = await runBridge();
    const intentInput = mockCreateIntent.mock.calls[0]![0] as { expectedFill: Record<string, unknown> };
    expect(intentInput.expectedFill.usdInEst).toBeUndefined();
    expect(intentInput.expectedFill.usdOutEst).toBeUndefined();
    const amounts = outputOf(result).amounts as { in: { usd: unknown }; out: { usd: unknown } };
    expect(amounts.in.usd).toBeNull();
    expect(amounts.out.usd).toBeNull();
  });

  it("route endpoints use the canonical toRelayCurrency tuples (W5 key-consistency)", async () => {
    await runBridge();
    const intentInput = mockCreateIntent.mock.calls[0]![0] as { route: Record<string, unknown> };
    expect(intentInput.route).toMatchObject({
      fromChainId: 8453, fromChainFamily: "eip155", fromToken: ZERO,
      toChainId: 4663, toChainFamily: "eip155", toToken: ZERO,
    });
  });
});

// ── dryRun preview ──
describe("relay.bridge — dryRun preview signs and records nothing", () => {
  it("returns a preview (serviceable/correlated/stepsValid) without signing or recording", async () => {
    const result = await runBridge({ ...PARAMS, dryRun: true });
    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.dryRun).toBe(true);
    expect(data.serviceable).toBe(true);
    expect(data.stepsValid).toBe(true);
    expect(mockCreateIntent).not.toHaveBeenCalled();
    expect(mockPreFail).not.toHaveBeenCalled();
    expect(mockSign).not.toHaveBeenCalled();
  });
});

// ── Read handler ──
describe("relay.quote.get — read preview keeps the prequote structural shape + records nothing", () => {
  it("returns provider/origin/destination/steps + agent-grade amounts, no recording", async () => {
    const result = await RELAY_BRIDGE_HANDLERS["relay.quote.get"]!(PARAMS, CTX);
    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.provider).toBe("relay");
    expect(data.originChainId).toBe(8453);
    expect(data.destinationChainId).toBe(4663);
    expect(Array.isArray(data.steps)).toBe(true);
    expect(data.serviceable).toBe(true);
    expect((data.amounts as { in: { usd: unknown } }).in.usd).toBe("2.94");
    expect(mockCreateIntent).not.toHaveBeenCalled();
    expect(mockPreFail).not.toHaveBeenCalled();
    expect(mockSign).not.toHaveBeenCalled();
  });
});

// ── Scrub boundary on the leg-resolution path (FIX5) ──
//
// `resolveLegs` throws locally-authored text, but `resolveRelayChainId` echoes
// the MODEL-SUPPLIED chain value verbatim (`Relay does not support chain
// "<input>".`). Both handlers returned that raw `err.message`, so a
// model-injected URL or key-shaped string reached tool output without ever
// passing the sanitisation boundary. Chain resolution is real here (only the
// Relay client/gates are mocked), so these exercise the true throw.
describe("relay leg resolution — model-supplied params reach output only through the scrub boundary", () => {
  const INJECTED_URL = "https://evil.example.com/x?key=LEAKEDKEY123";

  it("relay.quote.get redacts a URL injected through fromChain", async () => {
    const result = await RELAY_BRIDGE_HANDLERS["relay.quote.get"]!(
      { ...PARAMS, fromChain: INJECTED_URL },
      CTX,
    );
    expect(result.success).toBe(false);
    expect(result.output).not.toContain("LEAKEDKEY123");
    expect(result.output).not.toContain("evil.example.com");
    expect(result.output).toContain("[url]");
    // The honest part of the message still reaches the agent.
    expect(result.output).toMatch(/does not support chain/i);
  });

  it("relay.bridge redacts a URL injected through toChain — before any quote or signing", async () => {
    const result = await RELAY_BRIDGE_HANDLERS["relay.bridge"]!(
      { ...PARAMS, toChain: INJECTED_URL },
      CTX,
    );
    expect(result.success).toBe(false);
    expect(result.output).not.toContain("LEAKEDKEY123");
    expect(result.output).not.toContain("evil.example.com");
    expect(result.output).toContain("[url]");
    expect(mockGetQuote).not.toHaveBeenCalled();
    expect(mockCreateIntent).not.toHaveBeenCalled();
    expect(mockSign).not.toHaveBeenCalled();
  });

  it("redacts a key-shaped string injected through a chain param", async () => {
    const result = await RELAY_BRIDGE_HANDLERS["relay.quote.get"]!(
      { ...PARAMS, fromChain: "apiKey=sk-or-v1-abcdef0123456789" },
      CTX,
    );
    expect(result.success).toBe(false);
    expect(result.output).not.toContain("sk-or-v1-abcdef0123456789");
  });
});
