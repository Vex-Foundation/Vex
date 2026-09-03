/**
 * Khalani bridge per-session wallet scope — RE-PINNED for the Phase-2 W3a staged
 * rewrite. The bridge is cross-chain: the deposit signs with the SOURCE-family
 * wallet and funds land at the dest-family recipient. The old suite pinned these
 * safety behaviours against the removed `executeDepositPlan({ signer })` call;
 * the W3a handler now resolves the source signer via `resolveSigningWallet` and
 * hands it to the staged `signStageKhalaniLeg` primitive. The wallet-scope
 * SAFETY intents are unchanged and re-covered here (the owned green suite
 * `khalani-handlers/staged-execute-safety.test.ts` mocks wallet resolution to
 * fixed values, so it does NOT own these scope assertions):
 *   - dryRun resolves NO signer and never records/signs;
 *   - an explicit fromAddress mismatch under a session fails closed BEFORE the
 *     quote + signing;
 *   - the EVM source resolves an EVM-family signer and passes it to the executor;
 *   - the Solana source resolves a Solana-family signer and passes it to the
 *     executor;
 *   - the destination is DERIVED from the session's dest-family wallet, and a
 *     supplied `recipient` is rejected by name (bridge-destination policy in
 *     `@tools/khalani/request.js`: a destination a model can choose is a
 *     destination an injection can choose);
 *   - an unselected dest family fails closed, with or without the param.
 *
 * SOLANA scope IS re-pinned (not removed): the coordinator enabled Solana-origin
 * staging after W3a (`markActivitySolanaBroadcast`), so the Solana source is no
 * longer refused. The owned green suite's "Solana source stages ... via the
 * Solana CAS" test mocks `resolveSigningWallet` to a FIXED value, so it does NOT
 * cover the source-family SIGNER RESOLUTION (Solana source → Solana wallet); that
 * wallet-scope wiring lives here. Success is now `false` for every reached-
 * broadcast in-turn outcome (R2/Q2), so these assertions pin the wiring, not a
 * success verdict.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ProtocolExecutionContext } from "@vex-agent/tools/protocols/types.js";

import { classifyNativeValue } from "@tools/evm-chains/native-value-authorization/index.js";

/**
 * The native-value authorization a zero-value EVM leg carries. `signStageEvmLeg`
 * re-validates this before signing, so a mocked plan must supply one; a leg that
 * sends no native currency has nothing to attribute and authorizes trivially.
 */
function zeroValueAuthorization(to: string) {
  return classifyNativeValue({
    call: { chainId: 8453, to: to as `0x${string}`, data: undefined, valueWei: 0n },
  });
}

const SEL_EVM = "0x1111111111111111111111111111111111111111";
const SEL_SOL = "So1anaSe1ectedAddr1111111111111111111111111";
/** A destination the caller would like the funds to go to. It never can. */
const ATTACKER = "0xeFEfeFEfeFeFEFEFEfefeFeFefEfEfEfeFEFEFEf";

const mockResolveSelectedAddress = vi.fn((_r: unknown, _p: unknown, family: string) => (family === "solana" ? SEL_SOL : SEL_EVM));
const mockResolveSigningWallet = vi.fn((_r: unknown, _p: unknown, family: string) =>
  family === "solana"
    ? { family: "solana", address: SEL_SOL, secretKey: new Uint8Array(64) }
    : { family: "eip155", address: SEL_EVM, privateKey: ("0x" + "ab".repeat(32)) as `0x${string}` });
vi.mock("@vex-agent/tools/internal/wallet/resolve.js", () => ({
  resolveSelectedAddress: (...a: unknown[]) => mockResolveSelectedAddress(...(a as [unknown, unknown, string])),
  resolveSigningWallet: (...a: unknown[]) => mockResolveSigningWallet(...(a as [unknown, unknown, string])),
  walletScopeErrorToResult: (err: unknown) => ({ success: false, output: err instanceof Error ? err.message : String(err) }),
}));

const mockGetChainFamily = vi.fn((_id: number) => "eip155");
vi.mock("@tools/khalani/chains.js", () => ({
  getCachedKhalaniChains: vi.fn().mockResolvedValue([]),
  getChain: vi.fn((id: number) => ({ id, type: "eip155", name: `Chain-${id}` })),
  getChainFamily: (...a: unknown[]) => mockGetChainFamily(...(a as [number])),
  getChainExplorerUrl: vi.fn(() => undefined),
}));

vi.mock("@tools/wallet/inventory.js", () => ({
  walletAddressesEqual: (_fam: string, a: string, b: string) => a === b,
  familyToInventory: (f: string) => (f === "solana" ? "solana" : "evm"),
}));

const mockResolvePrequoteRoute = vi.fn();
vi.mock("@tools/khalani/prequote-route-guard.js", () => ({
  resolveKhalaniPrequoteRoute: (...a: unknown[]) => mockResolvePrequoteRoute(...a),
}));

const mockPrepareQuoteRequest = vi.fn(async (input: { fromAddress: string; recipient: string }) => ({
  chains: [],
  fromChainId: 1,
  toChainId: 1,
  fromFamily: "eip155",
  toFamily: "eip155",
  // `amount` is always present on a real prepared request — the Vex bridge fee
  // (`@tools/bridge-fee`) splits it before the quote, so the mock must carry it.
  request: { fromAddress: input.fromAddress, recipient: input.recipient, amount: "1000000" },
}));
// The bridge-fee eligibility check consults KyberSwap's honeypot/fee-on-transfer
// oracle before the quote. Stubbed clean so this suite stays offline and
// deterministic — FoT behaviour has its own coverage.
vi.mock("@tools/kyberswap/token-api/client.js", () => ({
  getKyberTokenApiClient: () => ({
    getHoneypotFotInfo: async () => ({ isHoneypot: false, isFOT: false, tax: 0 }),
  }),
}));

vi.mock("@tools/khalani/request.js", () => ({
  prepareQuoteRequest: (...a: unknown[]) => mockPrepareQuoteRequest(...(a as [{ fromAddress: string; recipient: string }])),
  // Kept faithful to the real guard so the handler's fee rejection stays live.
  findCallerSuppliedForbiddenParam: (params: Record<string, unknown>) => {
    for (const key of ["referrer", "referrerFeeBps"]) {
      const value = params[key];
      if (value === undefined || value === null) continue;
      if (typeof value === "string" && value.trim() === "") continue;
      return { param: key, reason: "Vex never takes fee parameters from tool input." };
    }
    return null;
  },
  findCallerSuppliedFeeParam: (params: Record<string, unknown>) => {
    for (const key of ["referrer", "referrerFeeBps"]) {
      const value = params[key];
      if (value === undefined || value === null) continue;
      if (typeof value === "string" && value.trim() === "") continue;
      return key;
    }
    return null;
  },
}));

vi.mock("@tools/khalani/helpers.js", () => ({ resolveRouteBestIndex: () => 0 }));

const mockGetQuotes = vi.fn();
const mockBuildDeposit = vi.fn();
const mockSubmitDeposit = vi.fn();
const mockSearchTokens = vi.fn();
const mockGetOrders = vi.fn();
vi.mock("@tools/khalani/client.js", () => ({
  getKhalaniClient: () => ({
    getQuotes: (...a: unknown[]) => mockGetQuotes(...a),
    buildDeposit: (...a: unknown[]) => mockBuildDeposit(...a),
    submitDeposit: (...a: unknown[]) => mockSubmitDeposit(...a),
    searchTokens: (...a: unknown[]) => mockSearchTokens(...a),
    getOrders: (...a: unknown[]) => mockGetOrders(...a),
  }),
}));

const mockPollOrderToTerminal = vi.fn();
vi.mock("@tools/khalani/order-status.js", () => ({ pollKhalaniOrderToTerminal: (...a: unknown[]) => mockPollOrderToTerminal(...a) }));

const mockPlanKhalaniDepositLegs = vi.fn();
const mockSignStageKhalaniLeg = vi.fn();
vi.mock("@tools/khalani/bridge-executor.js", () => ({
  planKhalaniDepositLegs: (...a: unknown[]) => mockPlanKhalaniDepositLegs(...a),
  signStageKhalaniLeg: (...a: unknown[]) => mockSignStageKhalaniLeg(...a),
}));

const mockCreateBridgeActivityIntent = vi.fn();
const mockCreateBridgePreBroadcastFailure = vi.fn();
const mockAttachProviderOrderId = vi.fn();
const mockCheckBridgeInFlight = vi.fn();
const mockMarkActivityBroadcast = vi.fn();
const mockMarkActivitySolanaBroadcast = vi.fn();
const mockMarkBroadcastAccepted = vi.fn();
const mockConfirmActivityEvent = vi.fn();
const mockFailActivityEvent = vi.fn();
const mockAbortPlannedEvents = vi.fn();
vi.mock("@vex-agent/db/repos/agent-activity.js", () => ({
  createBridgeActivityIntent: (...a: unknown[]) => mockCreateBridgeActivityIntent(...a),
  createBridgePreBroadcastFailure: (...a: unknown[]) => mockCreateBridgePreBroadcastFailure(...a),
  attachProviderOrderId: (...a: unknown[]) => mockAttachProviderOrderId(...a),
  checkBridgeInFlight: (...a: unknown[]) => mockCheckBridgeInFlight(...a),
  markActivityBroadcast: (...a: unknown[]) => mockMarkActivityBroadcast(...a),
  markActivitySolanaBroadcast: (...a: unknown[]) => mockMarkActivitySolanaBroadcast(...a),
  markBroadcastAccepted: (...a: unknown[]) => mockMarkBroadcastAccepted(...a),
  confirmActivityEvent: (...a: unknown[]) => mockConfirmActivityEvent(...a),
  failActivityEvent: (...a: unknown[]) => mockFailActivityEvent(...a),
  abortPlannedEvents: (...a: unknown[]) => mockAbortPlannedEvents(...a),
}));


vi.mock("@utils/logger.js", () => {
  const stub = { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() };
  return { default: stub, logger: stub };
});

const { BRIDGE_HANDLERS } = await import("@vex-agent/tools/protocols/khalani/handlers/bridge.js");

const SESSION_CTX: ProtocolExecutionContext = {
  sessionPermission: "full",
  approved: true,
  walletResolution: { source: "session", evm: { id: "w-evm", address: SEL_EVM }, solana: { id: "w-sol", address: SEL_SOL } },
  walletPolicy: { kind: "none" },
  sessionId: "session-1",
};

const baseParams = { fromChain: "ethereum", toChain: "ethereum", fromToken: "USDC", toToken: "USDC", amountRaw: "1000000" };

function run(over: Record<string, unknown> = {}) {
  return BRIDGE_HANDLERS["khalani.bridge"]!({ ...baseParams, ...over }, SESSION_CTX);
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default: both endpoints EVM + Khalani-serviceable, happy staged pipeline.
  mockResolveSelectedAddress.mockImplementation((_r, _p, family) => (family === "solana" ? SEL_SOL : SEL_EVM));
  mockResolveSigningWallet.mockImplementation((_r, _p, family) =>
    family === "solana"
      ? { family: "solana", address: SEL_SOL, secretKey: new Uint8Array(64) }
      : { family: "eip155", address: SEL_EVM, privateKey: ("0x" + "ab".repeat(32)) as `0x${string}` });
  mockGetChainFamily.mockImplementation(() => "eip155");
  mockResolvePrequoteRoute.mockResolvedValue({ outcome: "khalani", fromChainId: 1, toChainId: 1 });
  mockGetQuotes.mockResolvedValue({
    quoteId: "q1",
    routes: [{ routeId: "r1", type: "fast", quote: { amountIn: "1", amountOut: "1", expectedDurationSeconds: 10, quoteExpiresAt: 0, validBefore: 0 } }],
  });
  mockBuildDeposit.mockResolvedValue({ kind: "CONTRACT_CALL", approvals: [] });
  mockSearchTokens.mockResolvedValue({ data: [] });
  mockPlanKhalaniDepositLegs.mockReturnValue([
    {
      role: "bridge_deposit", family: "eip155", isDeposit: true, kind: "evm",
      tx: { to: SEL_EVM },
      // Every EVM leg carries a native-value authorization; this one sends no
      // value, so it authorizes with no components at all.
      nativeValue: zeroValueAuthorization(SEL_EVM),
    },
  ]);
  mockCheckBridgeInFlight.mockResolvedValue({ inFlight: false, existing: null });
  mockCreateBridgeActivityIntent.mockResolvedValue({ outcome: "created", executionId: 42, legs: [{ id: 100 }], expectedFill: { id: 200 } });
  mockMarkActivityBroadcast.mockResolvedValue({ applied: true, row: { id: 100 } });
  mockMarkActivitySolanaBroadcast.mockResolvedValue({ applied: true, row: { id: 100 } });
  mockMarkBroadcastAccepted.mockResolvedValue({ applied: true, row: {} });
  mockConfirmActivityEvent.mockResolvedValue({ applied: true, row: {} });
  mockAbortPlannedEvents.mockResolvedValue([]);
  mockSignStageKhalaniLeg.mockImplementation(async (_leg, _sc, _ch, _signer, hooks) => {
    await hooks.onHashStaged({ txHash: "0xhash", fromAddress: SEL_EVM, nonce: 7 });
    await hooks.onAccepted();
    return { kind: "confirmed", txHash: "0xhash" };
  });
  mockSubmitDeposit.mockResolvedValue({ orderId: "o1", txHash: "0xhash" });
  mockAttachProviderOrderId.mockResolvedValue({ outcome: "attached", row: { id: 200 } });
  mockPollOrderToTerminal.mockResolvedValue({ kind: "pending", status: "published" });
});

describe("khalani.bridge session wallet scope", () => {
  it("dryRun does NOT resolve a signer, record, or sign", async () => {
    const r = await run({ dryRun: true });
    expect(r.success).toBe(true); // dryRun stays a read-only preview
    expect(mockResolveSigningWallet).not.toHaveBeenCalled();
    expect(mockCreateBridgeActivityIntent).not.toHaveBeenCalled();
    expect(mockSignStageKhalaniLeg).not.toHaveBeenCalled();
  });

  it("explicit fromAddress mismatch under session fails closed BEFORE quote + signing", async () => {
    const r = await run({ fromAddress: "0x9999999999999999999999999999999999999999" });
    expect(r.success).toBe(false);
    expect(mockPrepareQuoteRequest).not.toHaveBeenCalled();
    expect(mockGetQuotes).not.toHaveBeenCalled();
    expect(mockSignStageKhalaniLeg).not.toHaveBeenCalled();
    expect(mockCreateBridgeActivityIntent).not.toHaveBeenCalled();
  });

  it("EVM source resolves an EVM signer and passes it to the staged executor", async () => {
    await run();
    // The source-family signer is resolved for the origin family...
    expect(mockResolveSigningWallet).toHaveBeenCalledTimes(1);
    expect(mockResolveSigningWallet.mock.calls[0]![2]).toBe("eip155");
    // ...and handed to the staged per-leg signer (never a primary-wallet fallback).
    expect(mockSignStageKhalaniLeg).toHaveBeenCalledTimes(1);
    expect(mockSignStageKhalaniLeg.mock.calls[0]![3]).toMatchObject({ family: "eip155", address: SEL_EVM });
  });

  it("Solana source resolves a Solana signer and passes it to the staged executor", async () => {
    // Solana on both endpoints; the deposit stages nonce-less via the Solana CAS.
    mockGetChainFamily.mockImplementation(() => "solana");
    mockResolvePrequoteRoute.mockResolvedValue({ outcome: "khalani", fromChainId: 20011000000, toChainId: 20011000000 });
    mockPlanKhalaniDepositLegs.mockReturnValue([
      { role: "bridge_deposit", family: "solana", isDeposit: true, kind: "solana", base64Tx: "b64tx" },
    ]);
    mockSignStageKhalaniLeg.mockImplementation(async (_leg, _sc, _ch, _signer, hooks) => {
      await hooks.onHashStaged({ txHash: "5SoLSigBase58", fromAddress: SEL_SOL, nonce: null });
      await hooks.onAccepted();
      return { kind: "confirmed", txHash: "5SoLSigBase58" };
    });
    await run();
    // The source-family signer is resolved for the SOLANA origin family...
    expect(mockResolveSigningWallet).toHaveBeenCalledTimes(1);
    expect(mockResolveSigningWallet.mock.calls[0]![2]).toBe("solana");
    // ...and handed to the staged per-leg signer (never a primary/EVM fallback).
    expect(mockSignStageKhalaniLeg).toHaveBeenCalledTimes(1);
    expect(mockSignStageKhalaniLeg.mock.calls[0]![3]).toMatchObject({ family: "solana", address: SEL_SOL });
  });

  it("the destination is DERIVED: the session's dest-family wallet reaches the provider request", async () => {
    await run();
    expect(mockPrepareQuoteRequest.mock.calls[0]![0]).toMatchObject({ fromAddress: SEL_EVM, recipient: SEL_EVM });
  });

  it("a supplied recipient is REJECTED BY NAME with the address the bridge delivers to", async () => {
    const r = await run({ recipient: ATTACKER });

    expect(r.success).toBe(false);
    // Names the parameter, the real destination, and the tool that CAN send
    // somewhere else - a refusal that does not say where to go next is a
    // refusal the agent works around.
    expect(r.output).toContain("recipient is not a parameter");
    expect(r.output).toContain(SEL_EVM);
    expect(r.output).toContain("WalletSendPrepare");
    expect(r.output).not.toContain(ATTACKER);
    // Nothing was quoted, nothing was recorded, nothing was signed.
    expect(mockPrepareQuoteRequest).not.toHaveBeenCalled();
    expect(mockGetQuotes).not.toHaveBeenCalled();
    expect(mockCreateBridgeActivityIntent).not.toHaveBeenCalled();
    expect(mockCreateBridgePreBroadcastFailure).not.toHaveBeenCalled();
    expect(mockSignStageKhalaniLeg).not.toHaveBeenCalled();
  });

  it("a supplied recipient on a dest family with NO selected wallet still fails closed", async () => {
    // The refusal needs the derived address; when there is none the ordinary
    // wallet-scope refusal answers instead. Never an invented address, and
    // never the caller's.
    mockGetChainFamily.mockImplementation((id: number) => (id === 42 ? "solana" : "eip155"));
    mockResolvePrequoteRoute.mockResolvedValue({ outcome: "khalani", fromChainId: 1, toChainId: 42 });
    mockResolveSelectedAddress.mockImplementation((_r, _p, family) => {
      if (family === "solana") throw new Error("WALLET_NOT_SELECTED");
      return SEL_EVM;
    });

    const r = await run({ recipient: ATTACKER });

    expect(r.success).toBe(false);
    expect(r.output).not.toContain(ATTACKER);
    expect(mockGetQuotes).not.toHaveBeenCalled();
    expect(mockSignStageKhalaniLeg).not.toHaveBeenCalled();
    expect(mockCreateBridgeActivityIntent).not.toHaveBeenCalled();
  });

  it("no explicit recipient + unselected dest family fails closed BEFORE quote + signing", async () => {
    // Source eip155 resolves; dest solana has no selected wallet → throws.
    mockGetChainFamily.mockImplementation((id: number) => (id === 42 ? "solana" : "eip155"));
    mockResolvePrequoteRoute.mockResolvedValue({ outcome: "khalani", fromChainId: 1, toChainId: 42 });
    mockResolveSelectedAddress.mockImplementation((_r, _p, family) => {
      if (family === "solana") throw new Error("WALLET_NOT_SELECTED");
      return SEL_EVM;
    });
    const r = await run();
    expect(r.success).toBe(false);
    expect(mockGetQuotes).not.toHaveBeenCalled();
    expect(mockSignStageKhalaniLeg).not.toHaveBeenCalled();
    expect(mockCreateBridgeActivityIntent).not.toHaveBeenCalled();
  });
});
