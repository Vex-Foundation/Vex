import { beforeEach, describe, expect, it, vi } from "vitest";
import assert from "node:assert/strict";
import { SendTransactionError } from "@solana/web3.js";
import type { ProtocolExecutionContext } from "../../../vex-agent/tools/protocols/types.js";
import { JupiterSubmitTipProof } from "@tools/solana-ecosystem/jupiter/jupiter-swaps/submit-tip-proof.js";
import {
  JUPITER_SUBMIT_MIN_TIP_LAMPORTS,
  JUPITER_TIP_RECEIVER_ADDRESSES,
} from "@tools/solana-ecosystem/jupiter/jupiter-swaps/constants.js";
import { VEX_DEFAULT_SLIPPAGE_BPS } from "@vex-agent/tools/protocols/slippage-policy.js";

const mockRequestLendDeposit = vi.fn();
const mockLendPositions = vi.fn();
const mockRequireJupiterResolvedTokenWithSafety = vi.fn();
const mockPrepareFeeBearingJupiterSwap = vi.fn();

/** The swap-preparation argument at `index` (negative counts from the end). */
function swapPreparation(index: number): { amountRaw?: string; knobs: { slippageBps?: number } } {
  const call = mockPrepareFeeBearingJupiterSwap.mock.calls.at(index);
  assert.ok(call, `no swap preparation at call index ${index}`);
  return call[0] as { amountRaw?: string; knobs: { slippageBps?: number } };
}
const mockGetSolanaConnection = vi.fn();
const mockPrepareVersionedTx = vi.fn();
const mockSubmitPreparedTx = vi.fn();
const mockSubmitOverRpc = vi.fn();
const mockCreateAgentActivityIntent = vi.fn();
const mockCreateAgentActivityPreBroadcastFailure = vi.fn();
const mockMarkActivitySolanaBroadcast = vi.fn();
const mockFailActivityEvent = vi.fn();
const mockMarkBroadcastAccepted = vi.fn();
const mockFindFreshMatchedPrequote = vi.fn();

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
  findFreshMatchedPrequote: (...args: unknown[]) => mockFindFreshMatchedPrequote(...args),
}));

vi.mock("@vex-agent/db/repos/agent-activity.js", () => ({
  createAgentActivityIntent: (...args: unknown[]) => mockCreateAgentActivityIntent(...args),
  createAgentActivityPreBroadcastFailure: (...args: unknown[]) => mockCreateAgentActivityPreBroadcastFailure(...args),
  markActivitySolanaBroadcast: (...args: unknown[]) => mockMarkActivitySolanaBroadcast(...args),
  failActivityEvent: (...args: unknown[]) => mockFailActivityEvent(...args),
  markBroadcastAccepted: (...args: unknown[]) => mockMarkBroadcastAccepted(...args),
  // Real export since migration 067. Without it the handler's best-effort
  // `noteHandlerPendingReason` throws inside its own catch and the pending-reason
  // path is silently skipped instead of exercised.
  notePendingReason: vi.fn(async () => ({ applied: true })),
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
// order + the R4 trade-SHAPE revalidation, not the (separately unit-tested)
// fee-bearing engine itself. There is no quote-to-quote price revalidation
// left to pin: it was removed by owner decision (2026-07-25) because it
// refused any build that repriced at all, which no re-quote could fix.
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

/**
 * The gate-guarded re-read of the authorizing row, as the handler now receives
 * it: the row itself plus the quote-time spendability statement whose native
 * `required` figure execution is bound to. An `executable` row always carries
 * one, so a fixture without it would not be a real row.
 */
function matchedPrequote(feePreview: Record<string, unknown> = VALID_FEE_PREVIEW) {
  return {
    ok: true,
    prequote: {
      prequoteId: "prequote-1", sessionId: "sess-1", matchHash: "h".repeat(64),
      kind: "swap", family: "solana", provider: "jupiter", chainId: null,
      walletAddress: "SignerWallet", tokenIn: "BonkMint", tokenOut: "SolMint", amount: "1000",
      slippageBps: null, safetyVerdict: "pass", safetyDetail: { feePreview }, routeRef: null, eligibilityKind: "executable", claimedAt: null, claimedBy: null,
      createdAt: "2026-01-01T00:00:00.000Z", expiresAt: "2099-01-01T00:00:00.000Z",
    },
    spendability: {
      cardVersion: "spendability-v2",
      source: {
        asset: { chainId: 101, address: "BonkMint", symbol: "BONK" },
        wallet: "SignerWallet", blockTag: "pending", observedAt: "2026-01-01T00:00:00.000Z",
        required: { raw: "1000", human: null, decimals: 6, symbol: "BONK" },
        current: { raw: "1000", human: null, decimals: 6, symbol: "BONK" },
      },
      native: {
        asset: { chainId: 101, address: "11111111111111111111111111111111", symbol: "SOL" },
        wallet: "SignerWallet", blockTag: "pending", observedAt: "2026-01-01T00:00:00.000Z",
        required: { raw: "10000000", human: null, decimals: 9, symbol: "SOL" },
        current: { raw: "10000000", human: null, decimals: 9, symbol: "SOL" },
      },
    },
  };
}

/**
 * The program a `/build` response declares for its swap instruction. The
 * schema makes `swapInstruction` REQUIRED (`jupiter-swaps/schemas.ts`), and the
 * pre-broadcast classifier binds the failing program in the node's logs to this
 * exact value — so a fixture without it would let that binding go untested.
 */
const BUILD_SWAP_PROGRAM_ID = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";

function preparedFeeBearingSwap(overrides: Record<string, unknown> = {}) {
  return {
    raw: {
      inAmount: "1000000000", outAmount: "100000000", otherAmountThreshold: "99000000", swapMode: "ExactIn",
      slippageBps: 50,
      swapInstruction: { programId: BUILD_SWAP_PROGRAM_ID },
    },
    unsignedTx: { serialize: () => new Uint8Array([9, 9, 9]) },
    feeMint: "BonkMint",
    feeAccount: "TreasuryAta",
    feeAccountExists: true,
    ataRentLamports: null,
    knobs: {},
    recentBlockhash: "freshBlockhash",
    lastValidBlockHeight: 555,
    // 25 bps of `raw.inAmount`, exactly as the real `prepareFeeBearingJupiterSwap`
    // returns it (and matching VALID_FEE_PREVIEW above). Present because the row
    // records the fee in TOKEN units (migration 050 Part 2) — a mock missing
    // these would let a writer regression pass unnoticed.
    feeAmountRaw: "2500000",
    feeAmountDecimal: "2.5",
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
    mockFindFreshMatchedPrequote.mockResolvedValue(matchedPrequote());
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
    const result = await CORE_HANDLERS["solana.swap.execute"](
      { tokenIn: "BonkMint", tokenOut: "SolMint", amountIn: "1000" },
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

    const result = await CORE_HANDLERS["solana.swap.execute"](
      { tokenIn: "BonkMint", tokenOut: "SolMint", amountIn: "1000" },
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

    const result = await CORE_HANDLERS["solana.swap.execute"](
      { tokenIn: "BonkMint", tokenOut: "SolMint", amountIn: "1000" },
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

  // ── Pre-broadcast refusals the agent can act on (phase-3 plan rule 8) ──────
  //
  // The defect: a rejection that PROVED nothing went on-chain still told the
  // agent "do not retry until the cause is fixed", naming no cause and no
  // parameter. On a thin pair — the common case — an autonomous agent stops
  // permanently on a fully recoverable condition. Same defect shape as the EVM
  // one fixed in `tools/evm-chains/pre-sign-revert-refusal.ts`.

  /** A node preflight refusal (`skipPreflight:false`) carrying the swap program's own failure line. */
  function preflightRejectionCause(programId: string, hexErrorCode: string): SendTransactionError {
    return new SendTransactionError({
      action: "simulate",
      signature: "",
      transactionMessage: `Transaction simulation failed: Error processing Instruction 4: custom program error: ${hexErrorCode}`,
      logs: [
        `Program ${programId} invoke [1]`,
        "Program log: Instruction: SharedAccountsRoute",
        "Program log: AnchorError occurred. Error Code: SlippageToleranceExceeded. Error Number: 6001. Error Message: Slippage tolerance exceeded.",
        `Program ${programId} failed: custom program error: ${hexErrorCode}`,
      ],
    });
  }

  /** The tipless swap takes the RPC lane, which is where a node refusal (and therefore program logs) can reach us. */
  function rpcLaneSwap() {
    mockPrepareFeeBearingJupiterSwap.mockResolvedValue(preparedFeeBearingSwap({ submitTipProof: null }));
  }

  it("a pre-broadcast SLIPPAGE refusal tells the agent what to change, not to stop", async () => {
    rpcLaneSwap();
    mockSubmitOverRpc.mockResolvedValueOnce({
      kind: "rejected_before_broadcast",
      cause: preflightRejectionCause(BUILD_SWAP_PROGRAM_ID, "0x1771"),
    });

    const result = await CORE_HANDLERS["solana.swap.execute"](
      { tokenIn: "BonkMint", tokenOut: "SolMint", amountIn: "1000", slippageBps: 50 },
      SWAP_SESSION_CTX,
    );

    // Still truthful about what happened, and still not a broadcast.
    expect(result.success).toBe(false);
    expect(result.output).toMatch(/rejected before broadcast/i);
    expect(result.output).toMatch(/nothing went on-chain/i);
    expect(result.output).not.toMatch(/confirmation pending/i);
    expect(result.data?.status).toBe("rejected_before_broadcast");

    // The remedy: the parameter BY NAME, the value used, and the ceiling.
    expect(result.output).toContain("slippageBps");
    expect(result.output).toContain("50");
    expect(result.output).toContain("1000");
    expect(result.output).toMatch(/re-quote/i);
    // The stranding sentence is gone on a cause we can actually name.
    expect(result.output).not.toMatch(/do not retry until the cause is fixed/i);
    // The hex is decoded to the upstream name, and no placeholder ever ships.
    expect(result.output).toContain("SlippageToleranceExceeded");
    expect(result.output).not.toMatch(/\bundefined\b/);

    // Lifecycle unchanged — the sweep stays the sole terminality authority.
    expect(mockFailActivityEvent).not.toHaveBeenCalled();
    expect(mockMarkBroadcastAccepted).not.toHaveBeenCalled();
  });

  it("an UNRECOGNISED pre-broadcast rejection keeps the conservative wording and invents no remedy", async () => {
    rpcLaneSwap();
    // A real node refusal, but an error number this repo has no row for. A
    // family resemblance must not produce confident wrong advice.
    mockSubmitOverRpc.mockResolvedValueOnce({
      kind: "rejected_before_broadcast",
      cause: preflightRejectionCause(BUILD_SWAP_PROGRAM_ID, "0x1780"),
    });

    const result = await CORE_HANDLERS["solana.swap.execute"](
      { tokenIn: "BonkMint", tokenOut: "SolMint", amountIn: "1000", slippageBps: 50 },
      SWAP_SESSION_CTX,
    );

    expect(result.output).toMatch(/rejected before broadcast/i);
    expect(result.output).toMatch(/nothing went on-chain/i);
    expect(result.output).toMatch(/do not retry until the cause is fixed/i);
    expect(result.output).not.toContain("slippageBps");
  });

  it("a refusal from a DIFFERENT program than the one /build declared is not read as slippage", async () => {
    rpcLaneSwap();
    // The same error ordinal means something else in every other Anchor
    // program. Without the program binding this would send the agent to change
    // a tolerance that had nothing to do with the failure.
    mockSubmitOverRpc.mockResolvedValueOnce({
      kind: "rejected_before_broadcast",
      cause: preflightRejectionCause("ComputeBudget111111111111111111111111111111", "0x1771"),
    });

    const result = await CORE_HANDLERS["solana.swap.execute"](
      { tokenIn: "BonkMint", tokenOut: "SolMint", amountIn: "1000", slippageBps: 50 },
      SWAP_SESSION_CTX,
    );

    expect(result.output).toMatch(/do not retry until the cause is fixed/i);
    expect(result.output).not.toContain("slippageBps");
  });

  it("a BROADCAST with an unknown outcome still says do not resubmit, and never claims nothing happened", async () => {
    rpcLaneSwap();
    // `transport_uncertain`: the bytes may already be in flight. Collapsing
    // this into the rejected-before-broadcast framing is the lie that cost the
    // 2026-07-25 live gate hours (live-gate-findings DEFECT 3).
    mockSubmitOverRpc.mockResolvedValueOnce({
      kind: "transport_uncertain",
      cause: new Error("ECONNRESET"),
    });

    const result = await CORE_HANDLERS["solana.swap.execute"](
      { tokenIn: "BonkMint", tokenOut: "SolMint", amountIn: "1000", slippageBps: 50 },
      SWAP_SESSION_CTX,
    );

    expect(result.data?.status).toBe("pending");
    expect(result.output).toMatch(/do not retry/i);
    expect(result.output).not.toMatch(/nothing went on-chain/i);
    expect(result.output).not.toMatch(/nothing was signed/i);
    expect(result.output).not.toMatch(/rejected before broadcast/i);
    // No remedy is offered for an outcome we cannot place.
    expect(result.output).not.toContain("slippageBps");
    expect(mockMarkBroadcastAccepted).not.toHaveBeenCalled();
  });

  it("a fresh /build whose floor is far BELOW the persisted quote's floor now PROCEEDS — the price moved, and slippageBps is what bounds that", async () => {
    // The inverse of the deleted R4b assertion. That gate compared
    // `freshOut × (1−s)` against `quotedOut × (1−s)`, i.e. demanded
    // `freshOut >= quotedOut`: a zero tolerance for price movement stacked on
    // top of the caller's own, which strands an autonomous agent on any pair
    // that reprices between quote and build. Owner decision 2026-07-25.
    mockPrepareFeeBearingJupiterSwap.mockResolvedValue(
      preparedFeeBearingSwap({ raw: { inAmount: "1000000000", outAmount: "100000000", otherAmountThreshold: "1", swapMode: "ExactIn" } }),
    );

    const result = await CORE_HANDLERS["solana.swap.execute"](
      { tokenIn: "BonkMint", tokenOut: "SolMint", amountIn: "1000" },
      SWAP_SESSION_CTX,
    );

    expect(mockCreateAgentActivityPreBroadcastFailure).not.toHaveBeenCalled();
    expect(mockCreateAgentActivityIntent).toHaveBeenCalledTimes(1);
    expect(mockPrepareVersionedTx).toHaveBeenCalledTimes(1);
    expect(result.data?.status).toBe("pending");
  });

  it("R4: a fresh /build that came back ExactOut blocks pre-broadcast with failureCode:route_not_found — a trade-shape surprise, never a slippage event", async () => {
    // Retained from the deleted floor suite: the swap-mode check is a genuine
    // build-integrity surprise (an exact-output build spends an amount Vex
    // never approved), and it is NOT answerable by widening the tolerance —
    // so it must not be filed as `slippage`, which would invite exactly that
    // retry.
    mockPrepareFeeBearingJupiterSwap.mockResolvedValue(
      preparedFeeBearingSwap({ raw: { inAmount: "1000000000", outAmount: "100000000", otherAmountThreshold: "99000000", swapMode: "ExactOut" } }),
    );
    mockCreateAgentActivityPreBroadcastFailure.mockResolvedValue({ executionId: 99, event: {} });

    const result = await CORE_HANDLERS["solana.swap.execute"](
      { tokenIn: "BonkMint", tokenOut: "SolMint", amountIn: "1000" },
      SWAP_SESSION_CTX,
    );

    expect(result.success).toBe(false);
    const call = mockCreateAgentActivityPreBroadcastFailure.mock.calls[0]![0] as { event: { failureCode: string } };
    expect(call.event.failureCode).toBe("route_not_found");
    expect(mockCreateAgentActivityIntent).not.toHaveBeenCalled();
    expect(mockPrepareVersionedTx).not.toHaveBeenCalled();
    expect(mockMarkActivitySolanaBroadcast).not.toHaveBeenCalled();
  });

  it("R4: a fresh fee-account/mint divergence blocks pre-broadcast with failureCode:route_not_found (generic build-rejection bucket)", async () => {
    mockPrepareFeeBearingJupiterSwap.mockResolvedValue(
      preparedFeeBearingSwap({ feeMint: "DifferentMint", feeAccount: "DifferentAta" }),
    );
    mockCreateAgentActivityPreBroadcastFailure.mockResolvedValue({ executionId: 97, event: {} });

    const result = await CORE_HANDLERS["solana.swap.execute"](
      { tokenIn: "BonkMint", tokenOut: "SolMint", amountIn: "1000" },
      SWAP_SESSION_CTX,
    );

    expect(result.success).toBe(false);
    const call = mockCreateAgentActivityPreBroadcastFailure.mock.calls[0]![0] as { event: { failureCode: string } };
    expect(call.event.failureCode).toBe("route_not_found");
    expect(mockCreateAgentActivityIntent).not.toHaveBeenCalled();
    expect(mockPrepareVersionedTx).not.toHaveBeenCalled();
  });

  it("blocks with a clear message when no matching fee-bearing quote is found (no broadcast, no intent)", async () => {
    mockFindFreshMatchedPrequote.mockResolvedValue({ ok: false, reason: "no_quote" });

    const result = await CORE_HANDLERS["solana.swap.execute"](
      { tokenIn: "BonkMint", tokenOut: "SolMint", amountIn: "1000" },
      SWAP_SESSION_CTX,
    );

    expect(result.success).toBe(false);
    expect(result.output).toContain("solana__swap_quote first");
    expect(mockCreateAgentActivityIntent).not.toHaveBeenCalled();
    expect(mockCreateAgentActivityPreBroadcastFailure).not.toHaveBeenCalled();
  });

  it("rejects an explicit address that differs from the session's selected Solana wallet (no broadcast)", async () => {
    const result = await CORE_HANDLERS["solana.swap.execute"](
      { tokenIn: "BonkMint", tokenOut: "SolMint", amountIn: "1000", walletAddress: "SpoofedWallet" },
      SWAP_SESSION_CTX,
    );

    expect(result.success).toBe(false);
    expect(mockCreateAgentActivityIntent).not.toHaveBeenCalled();
    expect(mockPrepareFeeBearingJupiterSwap).not.toHaveBeenCalled();
  });

  it("a post-intent signing failure finalizes the EXISTING row via failActivityEvent, never a second intent (design R2)", async () => {
    mockPrepareVersionedTx.mockRejectedValueOnce(new Error("sole-signer violation"));

    const result = await CORE_HANDLERS["solana.swap.execute"](
      { tokenIn: "BonkMint", tokenOut: "SolMint", amountIn: "1000" },
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

    const result = await CORE_HANDLERS["solana.swap.execute"](
      { tokenIn: "BonkMint", tokenOut: "SolMint", amountIn: "1000" },
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

    const result = await CORE_HANDLERS["solana.swap.execute"](
      { tokenIn: "BonkMint", tokenOut: "SolMint", amountIn: "1000" },
      SWAP_SESSION_CTX,
    );

    expect(result.success).toBe(false);
    expect(result.data?.status).toBe("pending");
    expect(result.data?.signature).toBe("realSig123"); // the LOCAL signature stays canonical
    expect(mockFailActivityEvent).not.toHaveBeenCalled();
  });

  it("a submit network failure stays truthful-pending — never terminalizes the locally-signed row", async () => {
    mockSubmitPreparedTx.mockResolvedValueOnce({ kind: "transport_uncertain", cause: new Error("ECONNRESET") });

    const result = await CORE_HANDLERS["solana.swap.execute"](
      { tokenIn: "BonkMint", tokenOut: "SolMint", amountIn: "1000" },
      SWAP_SESSION_CTX,
    );

    expect(result.success).toBe(false);
    expect(result.data?.status).toBe("pending");
    expect(mockFailActivityEvent).not.toHaveBeenCalled();
  });

  // ── Vex's own 25 bps, recorded as a token amount (migration 050 Part 2) ──
  //
  // This path fetches NO USD price, so `usdVexFeeEst` is NULL on every Jupiter
  // swap row. Before these columns the row was therefore indistinguishable
  // from one where Vex charged nothing.

  it("records the Vex fee in TOKEN units even though no USD value exists for it", async () => {
    await CORE_HANDLERS["solana.swap.execute"](
      { tokenIn: "BonkMint", tokenOut: "SolMint", amountIn: "1000" },
      SWAP_SESSION_CTX,
    );

    const intent = mockCreateAgentActivityIntent.mock.calls[0]![0] as {
      events: Array<{
        usdVexFeeEst?: string;
        vexFee?: { tokenAddress: string; tokenSymbol?: string; tokenDecimals: number; amountRaw: string; amountHuman: string };
      }>;
    };
    const event = intent.events[0];

    // The USD column stays empty — deliberately, and that is a finished answer.
    expect(event.usdVexFeeEst).toBeUndefined();
    // The fee itself is a recorded fact: the input mint, its decimals, and the
    // exact atomic amount `fee-swap.ts` derived and the approval disclosed.
    expect(event.vexFee).toEqual({
      tokenAddress: "BonkMint",
      tokenSymbol: "BonkMint",
      tokenDecimals: 6,
      amountRaw: "2500000",
      amountHuman: "2.5",
    });
  });

  it("keeps a u64-scale fee digit-exact — never routed through a float", async () => {
    // Beyond Number.MAX_SAFE_INTEGER: a fee that survived a `number` hop would
    // come back with a corrupted tail.
    const hugeFeeRaw = "18446744073709551615";
    mockPrepareFeeBearingJupiterSwap.mockResolvedValue(
      preparedFeeBearingSwap({ feeAmountRaw: hugeFeeRaw, feeAmountDecimal: "18446744073709.551615" }),
    );

    await CORE_HANDLERS["solana.swap.execute"](
      { tokenIn: "BonkMint", tokenOut: "SolMint", amountIn: "1000" },
      SWAP_SESSION_CTX,
    );

    const intent = mockCreateAgentActivityIntent.mock.calls[0]![0] as {
      events: Array<{ vexFee?: { amountRaw: string; amountHuman: string } }>;
    };
    expect(intent.events[0]!.vexFee?.amountRaw).toBe(hugeFeeRaw);
    expect(intent.events[0]!.vexFee?.amountHuman).toBe("18446744073709.551615");
    // Digits preserved, not merely "close enough".
    expect(String(Number(hugeFeeRaw))).not.toBe(hugeFeeRaw);
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
    const result = await CORE_HANDLERS["solana.swap.quote"](
      { tokenIn: "BonkMint", tokenOut: "SolMint", amountIn: "1000" },
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

  // Summary parity with `kyberswap.swap.quote` (2026-07-30). A live session
  // showed a weaker model lifting a raw base-unit figure out of a quote into
  // its user-facing reply, so the human layer spells token units — while the
  // machine fields keep the provider's raw strings byte-for-byte.
  // W4a — Jupiter live-substitutes its own 50 bps when `slippageBps` is
  // omitted, which would make the PROVIDER the owner of Vex's only price
  // protection. Quote and execute adopt Vex's value at the SAME code point
  // (`resolveJupiterSwapKnobs`), so a quote and its execute still bind the
  // identical economics.
  it("quote and execute both send Vex's slippage default EXPLICITLY when the caller omits it", async () => {
    await CORE_HANDLERS["solana.swap.quote"](
      { tokenIn: "BonkMint", tokenOut: "SolMint", amountIn: "1000" },
      SWAP_SESSION_CTX,
    );
    const quoted = swapPreparation(0);
    expect(quoted.knobs.slippageBps).toBe(VEX_DEFAULT_SLIPPAGE_BPS);

    mockFindFreshMatchedPrequote.mockResolvedValue(matchedPrequote());
    mockCreateAgentActivityIntent.mockResolvedValue({ executionId: 42, events: [{ id: 7 }] });
    mockPrepareVersionedTx.mockResolvedValue({
      serialized: new Uint8Array([1, 2, 3]),
      signature: "realSig123",
      recentBlockhash: "freshBlockhash",
      lastValidBlockHeight: 555,
    });
    mockMarkActivitySolanaBroadcast.mockResolvedValue({ applied: true, row: {} });
    mockSubmitPreparedTx.mockResolvedValue({ kind: "accepted", signature: "realSig123" });
    mockMarkBroadcastAccepted.mockResolvedValue({ applied: true, row: {} });

    await CORE_HANDLERS["solana.swap.execute"](
      { tokenIn: "BonkMint", tokenOut: "SolMint", amountIn: "1000" },
      SWAP_SESSION_CTX,
    );
    const executed = swapPreparation(-1);
    expect(executed.knobs.slippageBps).toBe(quoted.knobs.slippageBps);
  });

  // W5a — the raw atomic amount reaching the provider comes from integer
  // string math, and a fractional tail the mint cannot hold is REFUSED rather
  // than rounded into the signed transaction.
  it("converts amountIn exactly and refuses more precision than the mint holds", async () => {
    await CORE_HANDLERS["solana.swap.quote"](
      { tokenIn: "BonkMint", tokenOut: "SolMint", amountIn: "1.000001" },
      SWAP_SESSION_CTX,
    );
    expect(swapPreparation(-1)).toMatchObject({ amountRaw: "1000001" });

    const refused = await CORE_HANDLERS["solana.swap.quote"](
      { tokenIn: "BonkMint", tokenOut: "SolMint", amountIn: "1.0000001" },
      SWAP_SESSION_CTX,
    );
    expect(refused.success).toBe(false);
    expect(refused.output).toContain("amountIn");
    expect(mockPrepareFeeBearingJupiterSwap).toHaveBeenCalledTimes(1);
  });

  it("adds a HUMAN summary while leaving every raw machine field untouched", async () => {
    const result = await CORE_HANDLERS["solana.swap.quote"](
      { tokenIn: "BonkMint", tokenOut: "SolMint", amountIn: "1000" },
      SWAP_SESSION_CTX,
    );

    // 6 decimals on both legs (the resolver mock above).
    //
    // The eligibility sentence is part of the summary from WP2-J on. This
    // fixture's wallet and mints are readable NAMES, not base58 keys, so the
    // spendability read cannot even be attempted and the quote takes the
    // fail-closed `balance_unavailable` branch - which is the correct outcome
    // for an unreadable wallet and is what this line pins. The eligibility
    // verdicts themselves are owned by
    // `protocols/solana-jupiter/solana-jupiter-swap-quote-eligibility.test.ts`,
    // which drives the same handler over a scripted chain.
    expect(result.data?.summary).toBe(
      "Quote: 1000 BonkMint → ~100 SolMint on Solana."
      + " NOT EXECUTABLE: the wallet's balance for this swap could not be read (quote_spendability_read_failed),"
      + " so Vex refuses to treat it as funded. This quote authorizes nothing.",
    );
    expect(result.data?.eligibility).toEqual({ kind: "balance_unavailable", executable: false });
    expect(result.data?.inputAmountRaw).toBe("1000000000");
    expect(result.data?.outputAmountRaw).toBe("100000000");
    expect(result.data?.otherAmountThreshold).toBe("99000000");
  });

  it("renders price impact as a PERCENT from the provider's decimal fraction", async () => {
    mockPrepareFeeBearingJupiterSwap.mockResolvedValue(
      preparedFeeBearingSwap({
        raw: {
          inAmount: "1000000000", outAmount: "100000000", otherAmountThreshold: "99000000",
          swapMode: "ExactIn", slippageBps: 50,
          swapInstruction: { programId: BUILD_SWAP_PROGRAM_ID },
          // FRACTION, not a percent — the unit trap named in swap-route-projector.ts.
          priceImpactPct: "-0.00015864212550172836",
        },
      }),
    );

    const result = await CORE_HANDLERS["solana.swap.quote"](
      { tokenIn: "BonkMint", tokenOut: "SolMint", amountIn: "1000" },
      SWAP_SESSION_CTX,
    );

    expect(result.data?.summary).toContain("Price impact -0.02%.");
    // The fraction itself stays on the machine field, verbatim.
    expect(result.data?.priceImpactFraction).toBe("-0.00015864212550172836");
  });

  // Unknown is not zero: a missing price impact is omitted, never rendered
  // as a reassuring "0.00%".
  it("omits price impact entirely when the provider gave none", async () => {
    const result = await CORE_HANDLERS["solana.swap.quote"](
      { tokenIn: "BonkMint", tokenOut: "SolMint", amountIn: "1000" },
      SWAP_SESSION_CTX,
    );

    expect(result.data?.summary).not.toContain("Price impact");
  });

  it("rejects an explicit address that differs from the session's selected Solana wallet (wallet-scoped, no quote built)", async () => {
    const result = await CORE_HANDLERS["solana.swap.quote"](
      { tokenIn: "BonkMint", tokenOut: "SolMint", amountIn: "1000", walletAddress: "SpoofedWallet" },
      SWAP_SESSION_CTX,
    );

    expect(result.success).toBe(false);
    expect(mockPrepareFeeBearingJupiterSwap).not.toHaveBeenCalled();
  });

  it("rejects an out-of-range tipLamports without silently clamping (owner reject-not-clamp rule)", async () => {
    const result = await CORE_HANDLERS["solana.swap.quote"](
      { tokenIn: "BonkMint", tokenOut: "SolMint", amountIn: "1000", tipLamports: 10_000_001 },
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
    const result = await LEND_HANDLERS["solana.lend.deposit"](
      { asset: "USDC", amountRaw: "100", walletAddress: "DifferentWallet" },
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
    await LEND_HANDLERS["solana.lend.positions"]({}, SESSION_CTX);
    expect(mockLendPositions).toHaveBeenCalledWith("SignerWallet");
  });

  it("lend.positions under source:default preserves the explicit-address override", async () => {
    await LEND_HANDLERS["solana.lend.positions"]({ walletAddress: "ExplicitWallet" }, DEFAULT_CTX);
    expect(mockLendPositions).toHaveBeenCalledWith("ExplicitWallet");
  });
});
