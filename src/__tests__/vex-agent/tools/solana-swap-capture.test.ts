import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProtocolExecutionContext } from "../../../vex-agent/tools/protocols/types.js";
import { JupiterSubmitTipProof } from "@tools/solana-ecosystem/jupiter/jupiter-swaps/submit-tip-proof.js";
import {
  JUPITER_SUBMIT_MIN_TIP_LAMPORTS,
  JUPITER_TIP_RECEIVER_ADDRESSES,
} from "@tools/solana-ecosystem/jupiter/jupiter-swaps/constants.js";

const mockRequestLendDeposit = vi.fn();
const mockLendPositions = vi.fn();
const mockRequireJupiterResolvedTokenWithSafety = vi.fn();
const mockPrepareFeeBearingJupiterSwap = vi.fn();
const mockGetSolanaConnection = vi.fn();
const mockPrepareVersionedTx = vi.fn();
const mockSubmitPreparedTx = vi.fn();
const mockSubmitOverRpc = vi.fn();
const mockCreateAgentActivityIntent = vi.fn();
const mockCreateAgentActivityPreBroadcastFailure = vi.fn();
const mockMarkActivitySolanaBroadcast = vi.fn();
const mockFailActivityEvent = vi.fn();
const mockMarkBroadcastAccepted = vi.fn();
const mockFindFreshMatchedSwapPrequote = vi.fn();

vi.mock("@tools/solana-ecosystem/jupiter/jupiter-tokens/service.js", () => ({
  searchJupiterTokens: vi.fn(),
  getJupiterTokensByCategory: vi.fn(),
  getJupiterTokensByTag: vi.fn(),
  getJupiterRecentTokens: vi.fn(),
  requireJupiterResolvedTokenWithSafety: (...args: unknown[]) => mockRequireJupiterResolvedTokenWithSafety(...args),
  // Reached only by `activity-token-leg.ts`'s mint-only path (Lend Earn); the
  // swap path below already holds resolved metadata and never calls it.
  resolveJupiterToken: vi.fn(),
}));

// W5 (design §6/R4): fee-swap.ts's `prepareFeeBearingJupiterSwap`/
// `buildJupiterFeePreview` are mocked at the module boundary — they are
// independently unit-tested in `jupiter-fee-swap.test.ts`. `resolveJupiterFeeSwapKnobs`
// and `jupiterFeePreviewSchema` stay REAL (pure, no IO) so param parsing and
// the persisted-quote Zod re-validation behave exactly like production.
vi.mock("@tools/solana-ecosystem/jupiter/jupiter-swaps/fee-swap.js", async () => {
  const actual = await vi.importActual<typeof import("@tools/solana-ecosystem/jupiter/jupiter-swaps/fee-swap.js")>(
    "@tools/solana-ecosystem/jupiter/jupiter-swaps/fee-swap.js",
  );
  return {
    ...actual,
    prepareFeeBearingJupiterSwap: (...args: unknown[]) => mockPrepareFeeBearingJupiterSwap(...args),
    buildJupiterFeePreview: () => ({ feeBps: 25, landingMode: "self_managed_submit" }),
  };
});

vi.mock("@tools/solana-ecosystem/shared/solana-transaction.js", () => ({
  getSolanaConnection: (...args: unknown[]) => mockGetSolanaConnection(...args),
  prepareVersionedTx: (...args: unknown[]) => mockPrepareVersionedTx(...args),
  submitPreparedTxOverRpc: (...args: unknown[]) => mockSubmitOverRpc(...args),
}));

vi.mock("@tools/solana-ecosystem/jupiter/jupiter-swaps/submit-prepared-tx.js", () => ({
  submitPreparedTx: (...args: unknown[]) => mockSubmitPreparedTx(...args),
}));

vi.mock("@vex-agent/tools/protocols/swap-prequote.js", () => ({
  findFreshMatchedSwapPrequote: (...args: unknown[]) => mockFindFreshMatchedSwapPrequote(...args),
}));

vi.mock("@vex-agent/db/repos/agent-activity.js", () => ({
  createAgentActivityIntent: (...args: unknown[]) => mockCreateAgentActivityIntent(...args),
  createAgentActivityPreBroadcastFailure: (...args: unknown[]) => mockCreateAgentActivityPreBroadcastFailure(...args),
  markActivitySolanaBroadcast: (...args: unknown[]) => mockMarkActivitySolanaBroadcast(...args),
  failActivityEvent: (...args: unknown[]) => mockFailActivityEvent(...args),
  markBroadcastAccepted: (...args: unknown[]) => mockMarkBroadcastAccepted(...args),
}));

vi.mock("@tools/solana-ecosystem/jupiter/jupiter-prices/service.js", () => ({
  getJupiterPricesByMint: vi.fn(),
}));

// B2 deleted `executeJupiterLendEarnDeposit`/`executeJupiterLendEarnWithdraw`
// (unreachable since K6's staged-seam conversion); the real handler
// (`handlers/lend.ts`) calls `requestJupiterLendEarnDepositTransaction`
// (request-only builder) instead — mocked here so the wallet-mismatch test
// below asserts against the function the handler ACTUALLY calls (B3, item 5:
// repairs a vacuous "not called" assertion pinned to a deleted function).
vi.mock("@tools/solana-ecosystem/jupiter/jupiter-lend/earn-api/service.js", () => ({
  getJupiterLendEarnTokens: vi.fn(),
  getJupiterLendEarnPositions: (...args: unknown[]) => mockLendPositions(...args),
  getJupiterLendEarnEarnings: vi.fn(),
  requestJupiterLendEarnDepositTransaction: (...args: unknown[]) => mockRequestLendDeposit(...args),
  requestJupiterLendEarnWithdrawTransaction: vi.fn(),
}));

// 5D-protocols p2: jupiter handlers resolve the session wallet via resolve.js
// (not the zero-arg requireSolanaWallet primary). `SignerWallet` is the session
// "selected" Solana address for these tests.
// A REAL ed25519 secret key (solana.swap.execute constructs a real Keypair to
// sign with — unlike the legacy path this replaces, which only forwarded the
// bytes to a mocked SDK call).
const FAKE_SIGNER_SECRET_KEY = new (await import("@solana/web3.js")).Keypair().secretKey;

vi.mock("@vex-agent/tools/internal/wallet/resolve.js", () => ({
  resolveSelectedAddress: () => "SignerWallet",
  resolveSigningWallet: () => ({ family: "solana", address: "SignerWallet", secretKey: FAKE_SIGNER_SECRET_KEY }),
  walletScopeErrorToResult: (err: unknown) => ({ success: false, output: err instanceof Error ? err.message : String(err) }),
}));

// Deterministic address comparison for the mismatch path (avoids base58 deps).
vi.mock("@tools/wallet/inventory.js", () => ({
  walletAddressesEqual: (_family: string, a: string, b: string) => a === b,
}));

const { CORE_HANDLERS } = await import(
  "../../../vex-agent/tools/protocols/solana-jupiter/handlers/core.js"
);
const { LEND_HANDLERS } = await import(
  "../../../vex-agent/tools/protocols/solana-jupiter/handlers/lend.js"
);

const DEFAULT_CTX: ProtocolExecutionContext = {
  approved: true,
  sessionPermission: "restricted",
  walletResolution: { source: "default" },
  walletPolicy: { kind: "none" },
};
const SESSION_CTX: ProtocolExecutionContext = {
  approved: true,
  sessionPermission: "full",
  walletResolution: { source: "session", evm: null, solana: { id: "w-sol-1", address: "SignerWallet" } },
  walletPolicy: { kind: "none" },
};

beforeEach(() => {
  vi.clearAllMocks();
  mockLendPositions.mockResolvedValue([]);
});

// W5 (design §6/R4): `solana.swap.execute` writes durable truth DIRECTLY to
// `agent_activity` via the K2 staged Solana seam (capture:"none") instead of
// the legacy `_tradeCapture` pipeline — these tests pin the staged write
// order + the R4b economic-floor revalidation, not the (separately unit-
// tested) fee-bearing engine itself.
const SWAP_SESSION_CTX: ProtocolExecutionContext = { ...SESSION_CTX, sessionId: "sess-1" };

const VALID_FEE_PREVIEW = {
  inAmountRaw: "1000000000",
  outAmountRaw: "100000000",
  otherAmountThresholdRaw: "99000000",
  feeBps: 25,
  feeAmountRaw: "2500000",
  feeAmountDecimal: "2.5",
  feeMint: "BonkMint",
  feeAccount: "TreasuryAta",
  feeAccountExists: true,
  ataRentLamports: null,
  tipLamports: 1_000_000,
  priorityFeeStrategy: "high",
  priorityFeeLamportsEstimate: 200,
  priorityFeeIsUpperBound: false,
  landingMode: "self_managed_submit",
};

function matchedPrequote(feePreview: Record<string, unknown> = VALID_FEE_PREVIEW) {
  return {
    prequoteId: "prequote-1", sessionId: "sess-1", matchHash: "h".repeat(64),
    kind: "swap", family: "solana", provider: "jupiter", chainId: null,
    walletAddress: "SignerWallet", tokenIn: "BonkMint", tokenOut: "SolMint", amount: "1000",
    slippageBps: null, safetyVerdict: "pass", safetyDetail: { feePreview }, routeRef: null,
    createdAt: "2026-01-01T00:00:00.000Z", expiresAt: "2099-01-01T00:00:00.000Z",
  };
}

function preparedFeeBearingSwap(overrides: Record<string, unknown> = {}) {
  return {
    raw: { inAmount: "1000000000", outAmount: "100000000", otherAmountThreshold: "99000000", swapMode: "ExactIn" },
    unsignedTx: { serialize: () => new Uint8Array([9, 9, 9]) },
    feeMint: "BonkMint",
    feeAccount: "TreasuryAta",
    feeAccountExists: true,
    ataRentLamports: null,
    knobs: {},
    recentBlockhash: "freshBlockhash",
    lastValidBlockHeight: 555,
    // Honestly minted: only a tip on Jupiter's published receiver allowlist,
    // at/above the documented minimum, can certify — this is what unlocks the
    // `/tx/v1/submit` lane for the fee-bearing `/build` swap.
    submitTipProof: JupiterSubmitTipProof.certify({
      recipient: JUPITER_TIP_RECEIVER_ADDRESSES[0]!,
      lamports: BigInt(JUPITER_SUBMIT_MIN_TIP_LAMPORTS),
    }),
    ...overrides,
  };
}

describe("solana.swap.execute capture", () => {
  beforeEach(() => {
    mockRequireJupiterResolvedTokenWithSafety.mockImplementation(async (q: string) => ({
      token: { address: q, symbol: q, decimals: 6 },
    }));
    mockGetSolanaConnection.mockReturnValue({ __fake: "connection" });
    mockFindFreshMatchedSwapPrequote.mockResolvedValue(matchedPrequote());
    mockPrepareFeeBearingJupiterSwap.mockResolvedValue(preparedFeeBearingSwap());
    mockCreateAgentActivityIntent.mockResolvedValue({ executionId: 42, events: [{ id: 7 }] });
    mockPrepareVersionedTx.mockResolvedValue({
      serialized: new Uint8Array([1, 2, 3]),
      signature: "realSig123",
      recentBlockhash: "freshBlockhash",
      lastValidBlockHeight: 555,
    });
    mockMarkActivitySolanaBroadcast.mockResolvedValue({ applied: true, row: {} });
    mockSubmitPreparedTx.mockResolvedValue({ kind: "accepted", signature: "realSig123" });
    mockSubmitOverRpc.mockResolvedValue({ kind: "accepted", signature: "realSig123" });
    mockMarkBroadcastAccepted.mockResolvedValue({ applied: true, row: {} });
  });

  it("stages the write (intent -> sign -> persist -> submit) and returns truthful-pending, never _tradeCapture", async () => {
    const result = await CORE_HANDLERS["solana.swap.execute"]!(
      { inputToken: "BonkMint", outputToken: "SolMint", amount: 1000 },
      SWAP_SESSION_CTX,
    );

    expect(result.success).toBe(false); // truthful-pending — never fabricates a confirm
    expect(result.data?._tradeCapture).toBeUndefined();
    expect(result.data?.status).toBe("pending");
    expect(result.data?.signature).toBe("realSig123");

    // The input mint's decimals are threaded through for the fee-swap
    // engine's exact-decimal fee disclosure (Codex batch-4 closure blocker C2).
    expect(mockPrepareFeeBearingJupiterSwap).toHaveBeenCalledWith(
      expect.objectContaining({ inputDecimals: 6 }),
    );

    // Intent created BEFORE signing, chain-family bound so
    // markActivitySolanaBroadcast's CAS predicate actually matches.
    const intentInput = mockCreateAgentActivityIntent.mock.calls[0]![0];
    expect(intentInput.events[0]).toMatchObject({
      kind: "swap", eventRole: "swap", chainFamily: "solana", walletAddress: "SignerWallet",
    });

    // BOTH legs carry the exact-decimal human amount next to its atomic
    // sibling — the activity feed's primary human field is `amountHuman`, and
    // the repo stores it verbatim (an omitted one stays null forever).
    expect(intentInput.events[0].tokenIn).toEqual({
      tokenAddress: "BonkMint", tokenSymbol: "BonkMint", tokenDecimals: 6,
      amountHuman: "1000", amountRaw: "1000000000",
    });
    expect(intentInput.events[0].tokenOut).toEqual({
      tokenAddress: "SolMint", tokenSymbol: "SolMint", tokenDecimals: 6,
      amountHuman: "100", amountRaw: "100000000",
    });

    // Sign uses VERIFY mode with the fresh /build's OWN blockhash evidence.
    expect(mockPrepareVersionedTx.mock.calls[0]![2]).toMatchObject({
      knownBlockhash: { blockhash: "freshBlockhash", lastValidBlockHeight: 555 },
    });

    // Signature + evidence persisted BEFORE submit.
    expect(mockMarkActivitySolanaBroadcast).toHaveBeenCalledWith(7, {
      txHash: "realSig123", fromAddress: "SignerWallet",
      recentBlockhash: "freshBlockhash", lastValidBlockHeight: 555,
    });
    // REGRESSION: the fee-bearing `/build` swap is the ONE Solana path that
    // carries a qualifying Jupiter tip, so it keeps the `/tx/v1/submit` lane
    // — and it is handed the PROOF, not a flag.
    expect(mockSubmitPreparedTx).toHaveBeenCalledWith(
      expect.objectContaining({ signature: "realSig123" }),
      expect.any(JupiterSubmitTipProof),
    );
    expect(mockSubmitOverRpc).not.toHaveBeenCalled();
    // A matching acceptance is recorded exactly once (design D5).
    expect(mockMarkBroadcastAccepted).toHaveBeenCalledTimes(1);
    expect(mockMarkBroadcastAccepted).toHaveBeenCalledWith(7);
  });

  it("a swap whose /build carries NO qualifying tip falls back to RPC — never /tx/v1/submit, which would silently drop it", async () => {
    mockPrepareFeeBearingJupiterSwap.mockResolvedValue(
      preparedFeeBearingSwap({ submitTipProof: null }),
    );

    const result = await CORE_HANDLERS["solana.swap.execute"]!(
      { inputToken: "BonkMint", outputToken: "SolMint", amount: 1000 },
      SWAP_SESSION_CTX,
    );

    expect(mockSubmitOverRpc).toHaveBeenCalledTimes(1);
    expect(mockSubmitPreparedTx).not.toHaveBeenCalled();
    expect(result.data?.status).toBe("pending");
  });

  it("a DEFINITIVE /submit rejection is reported as rejected, never as a pending broadcast, and never terminalizes", async () => {
    mockSubmitPreparedTx.mockResolvedValueOnce({
      kind: "rejected_before_broadcast",
      cause: new Error("missing or insufficient tip"),
    });

    const result = await CORE_HANDLERS["solana.swap.execute"]!(
      { inputToken: "BonkMint", outputToken: "SolMint", amount: 1000 },
      SWAP_SESSION_CTX,
    );

    expect(result.success).toBe(false);
    expect(result.output).toMatch(/rejected before broadcast/i);
    expect(result.output).toMatch(/nothing went on-chain/i);
    expect(result.output).not.toMatch(/confirmation pending/i);
    expect(result.output).toContain("missing or insufficient tip");
    expect(result.data?.status).toBe("rejected_before_broadcast");
    // Lifecycle unchanged — the sweep stays the sole terminality authority.
    expect(mockFailActivityEvent).not.toHaveBeenCalled();
    expect(mockMarkBroadcastAccepted).not.toHaveBeenCalled();
  });

  it("R4b: a fresh /build whose floor is BELOW the persisted quote's floor blocks pre-broadcast with failureCode:slippage (K1's stage/error mapping table), never signs", async () => {
    mockPrepareFeeBearingJupiterSwap.mockResolvedValue(
      preparedFeeBearingSwap({ raw: { inAmount: "1000000000", outAmount: "100000000", otherAmountThreshold: "1", swapMode: "ExactIn" } }),
    );
    mockCreateAgentActivityPreBroadcastFailure.mockResolvedValue({ executionId: 99, event: {} });

    const result = await CORE_HANDLERS["solana.swap.execute"]!(
      { inputToken: "BonkMint", outputToken: "SolMint", amount: 1000 },
      SWAP_SESSION_CTX,
    );

    expect(result.success).toBe(false);
    expect(mockCreateAgentActivityPreBroadcastFailure).toHaveBeenCalled();
    // The economic floor has its OWN dedicated failure_code per K1's stage/
    // error mapping table (validation.ts) — never the generic build-rejection
    // bucket (`route_not_found`).
    const call = mockCreateAgentActivityPreBroadcastFailure.mock.calls[0]![0] as { event: { failureCode: string } };
    expect(call.event.failureCode).toBe("slippage");
    expect(mockCreateAgentActivityIntent).not.toHaveBeenCalled();
    expect(mockPrepareVersionedTx).not.toHaveBeenCalled();
    expect(mockMarkActivitySolanaBroadcast).not.toHaveBeenCalled();
  });

  it("R4: a fresh fee-account/mint divergence blocks pre-broadcast with failureCode:route_not_found (generic build-rejection bucket)", async () => {
    mockPrepareFeeBearingJupiterSwap.mockResolvedValue(
      preparedFeeBearingSwap({ feeMint: "DifferentMint", feeAccount: "DifferentAta" }),
    );
    mockCreateAgentActivityPreBroadcastFailure.mockResolvedValue({ executionId: 97, event: {} });

    const result = await CORE_HANDLERS["solana.swap.execute"]!(
      { inputToken: "BonkMint", outputToken: "SolMint", amount: 1000 },
      SWAP_SESSION_CTX,
    );

    expect(result.success).toBe(false);
    const call = mockCreateAgentActivityPreBroadcastFailure.mock.calls[0]![0] as { event: { failureCode: string } };
    expect(call.event.failureCode).toBe("route_not_found");
    expect(mockCreateAgentActivityIntent).not.toHaveBeenCalled();
    expect(mockPrepareVersionedTx).not.toHaveBeenCalled();
  });

  it("blocks with a clear message when no matching fee-bearing quote is found (no broadcast, no intent)", async () => {
    mockFindFreshMatchedSwapPrequote.mockResolvedValue(null);

    const result = await CORE_HANDLERS["solana.swap.execute"]!(
      { inputToken: "BonkMint", outputToken: "SolMint", amount: 1000 },
      SWAP_SESSION_CTX,
    );

    expect(result.success).toBe(false);
    expect(result.output).toContain("solana.swap.quote first");
    expect(mockCreateAgentActivityIntent).not.toHaveBeenCalled();
    expect(mockCreateAgentActivityPreBroadcastFailure).not.toHaveBeenCalled();
  });

  it("rejects an explicit address that differs from the session's selected Solana wallet (no broadcast)", async () => {
    const result = await CORE_HANDLERS["solana.swap.execute"]!(
      { inputToken: "BonkMint", outputToken: "SolMint", amount: 1000, address: "SpoofedWallet" },
      SWAP_SESSION_CTX,
    );

    expect(result.success).toBe(false);
    expect(mockCreateAgentActivityIntent).not.toHaveBeenCalled();
    expect(mockPrepareFeeBearingJupiterSwap).not.toHaveBeenCalled();
  });

  it("a post-intent signing failure finalizes the EXISTING row via failActivityEvent, never a second intent (design R2)", async () => {
    mockPrepareVersionedTx.mockRejectedValueOnce(new Error("sole-signer violation"));

    const result = await CORE_HANDLERS["solana.swap.execute"]!(
      { inputToken: "BonkMint", outputToken: "SolMint", amount: 1000 },
      SWAP_SESSION_CTX,
    );

    expect(result.success).toBe(false);
    expect(result.output).toContain("nothing was broadcast");
    expect(mockFailActivityEvent).toHaveBeenCalledWith(7, expect.objectContaining({ failureCode: "unknown" }));
    expect(mockCreateAgentActivityPreBroadcastFailure).not.toHaveBeenCalled();
    expect(mockCreateAgentActivityIntent).toHaveBeenCalledTimes(1);
    expect(mockMarkActivitySolanaBroadcast).not.toHaveBeenCalled();
    expect(mockSubmitPreparedTx).not.toHaveBeenCalled();
  });

  it("a staging CAS-miss refuses to submit untracked (never calls submitPreparedTx, never retries blindly)", async () => {
    mockMarkActivitySolanaBroadcast.mockResolvedValueOnce({ applied: false });

    const result = await CORE_HANDLERS["solana.swap.execute"]!(
      { inputToken: "BonkMint", outputToken: "SolMint", amount: 1000 },
      SWAP_SESSION_CTX,
    );

    expect(result.success).toBe(false);
    expect(result.output).toContain("do not retry blindly");
    expect(mockSubmitPreparedTx).not.toHaveBeenCalled();
    expect(mockFailActivityEvent).not.toHaveBeenCalled();
  });

  it("a submit signature mismatch stays truthful-pending — never terminalizes the locally-signed row", async () => {
    mockSubmitPreparedTx.mockResolvedValueOnce({
      kind: "signature_mismatch", localSignature: "realSig123", providerSignature: "attackerSig",
    });

    const result = await CORE_HANDLERS["solana.swap.execute"]!(
      { inputToken: "BonkMint", outputToken: "SolMint", amount: 1000 },
      SWAP_SESSION_CTX,
    );

    expect(result.success).toBe(false);
    expect(result.data?.status).toBe("pending");
    expect(result.data?.signature).toBe("realSig123"); // the LOCAL signature stays canonical
    expect(mockFailActivityEvent).not.toHaveBeenCalled();
  });

  it("a submit network failure stays truthful-pending — never terminalizes the locally-signed row", async () => {
    mockSubmitPreparedTx.mockResolvedValueOnce({ kind: "transport_uncertain", cause: new Error("ECONNRESET") });

    const result = await CORE_HANDLERS["solana.swap.execute"]!(
      { inputToken: "BonkMint", outputToken: "SolMint", amount: 1000 },
      SWAP_SESSION_CTX,
    );

    expect(result.success).toBe(false);
    expect(result.data?.status).toBe("pending");
    expect(mockFailActivityEvent).not.toHaveBeenCalled();
  });
});

describe("solana.swap.quote", () => {
  beforeEach(() => {
    mockRequireJupiterResolvedTokenWithSafety.mockImplementation(async (q: string) => ({
      token: { address: q, symbol: q, decimals: 6 },
    }));
    mockGetSolanaConnection.mockReturnValue({ __fake: "connection" });
    mockPrepareFeeBearingJupiterSwap.mockResolvedValue(preparedFeeBearingSwap());
  });

  it("builds a wallet-scoped fee-bearing quote and discloses fee/tip/landing (never executes)", async () => {
    const result = await CORE_HANDLERS["solana.swap.quote"]!(
      { inputToken: "BonkMint", outputToken: "SolMint", amount: 1000 },
      SWAP_SESSION_CTX,
    );

    expect(result.success).toBe(true);
    expect(mockPrepareFeeBearingJupiterSwap).toHaveBeenCalledWith(
      expect.objectContaining({ taker: "SignerWallet", inputMint: "BonkMint", outputMint: "SolMint", inputDecimals: 6 }),
    );
    expect(result.data?.feePreview).toMatchObject({ feeBps: 25, landingMode: "self_managed_submit" });
    expect(mockCreateAgentActivityIntent).not.toHaveBeenCalled();
    expect(mockPrepareVersionedTx).not.toHaveBeenCalled();
  });

  it("rejects an explicit address that differs from the session's selected Solana wallet (wallet-scoped, no quote built)", async () => {
    const result = await CORE_HANDLERS["solana.swap.quote"]!(
      { inputToken: "BonkMint", outputToken: "SolMint", amount: 1000, address: "SpoofedWallet" },
      SWAP_SESSION_CTX,
    );

    expect(result.success).toBe(false);
    expect(mockPrepareFeeBearingJupiterSwap).not.toHaveBeenCalled();
  });

  it("rejects an out-of-range tipLamports without silently clamping (owner reject-not-clamp rule)", async () => {
    const result = await CORE_HANDLERS["solana.swap.quote"]!(
      { inputToken: "BonkMint", outputToken: "SolMint", amount: 1000, tipLamports: 10_000_001 },
      SWAP_SESSION_CTX,
    );

    expect(result.success).toBe(false);
    expect(result.output).toContain("tipLamports");
    expect(mockPrepareFeeBearingJupiterSwap).not.toHaveBeenCalled();
  });
});

// ── Per-session wallet scope (5D-protocols p2) ───────────────────

describe("jupiter session wallet scope", () => {
  it("lend.deposit fails closed when explicit address != session wallet (NO broadcast)", async () => {
    const result = await LEND_HANDLERS["solana.lend.deposit"]!(
      { asset: "USDC", amount: "100", address: "DifferentWallet" },
      SESSION_CTX,
    );

    expect(result.success).toBe(false);
    // The mismatch must be caught BEFORE the on-chain deposit — the unsigned-tx
    // request is never reached, and no capture/audit produced. This is the
    // exact bug guarded against.
    expect(mockRequestLendDeposit).not.toHaveBeenCalled();
    expect(result.data).toBeUndefined();
  });

  it("lend.positions scopes the read to the session selected wallet", async () => {
    await LEND_HANDLERS["solana.lend.positions"]!({}, SESSION_CTX);
    expect(mockLendPositions).toHaveBeenCalledWith("SignerWallet");
  });

  it("lend.positions under source:default preserves the explicit-address override", async () => {
    await LEND_HANDLERS["solana.lend.positions"]!({ address: "ExplicitWallet" }, DEFAULT_CTX);
    expect(mockLendPositions).toHaveBeenCalledWith("ExplicitWallet");
  });
});
