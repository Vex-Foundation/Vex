/**
 * `solana-activity-repair` — pure orchestration over the injected
 * `SolanaActivitySweepDeps` port (W5 design §4/R3/R2b/R2c, K3). Mocked-DB
 * unit test mirroring `agent-activity-repair-error-scrubbing.test.ts`'s
 * pattern (mock the whole `@vex-agent/db/repos/agent-activity.js` module;
 * inject fake RPC deps directly).
 *
 * Pins: mined-error finalize, confirmed-and-decoded finalize, undecodable-
 * success stays pending, RPC-unavailable stays pending WITHOUT touching
 * `last_checked_at`, the getSignatureStatuses-miss → getTransaction
 * cross-check fallback, the expiry gate's literal AND (both RPC misses +
 * blockHeight > last_valid_block_height, only over a "found"/healthy
 * height lookup), a grandfathered (evidence-less) row can never expire, the
 * backoff-not-due skip, and the stale-hashless-intent recovery call.
 *
 * ALSO pins the two settlement-side contracts a live funded gate proved
 * missing (design `solana-settlement-profile-design.md`): a row carrying a
 * settlement profile is decoded by the protocol-aware decoder (so a native-SOL
 * swap confirms instead of staying pending forever), and every confirmed row
 * records the EXACT-decimal human sibling next to the raw magnitude.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

import { Keypair, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";

import type { AgentActivityEvent } from "@vex-agent/db/repos/agent-activity.js";
import type { SolanaActivitySweepDeps } from "@vex-agent/sync/solana-activity-repair.js";
import { buildSolanaSettlementRouteProvenance } from "@tools/solana-ecosystem/jupiter/jupiter-swaps/settlement-profile.js";
import { JUPITER_TIP_RECEIVER_ADDRESSES } from "@tools/solana-ecosystem/jupiter/jupiter-swaps/constants.js";
import { SOL_MINT } from "@tools/solana-ecosystem/shared/solana-constants.js";

const mockListSolanaStagedPending = vi.fn();
const mockConfirmActivityEvent = vi.fn();
const mockFailActivityEvent = vi.fn();
const mockTouchLastChecked = vi.fn();
const mockRecoverStaleHashlessIntents = vi.fn();

vi.mock("@vex-agent/db/repos/agent-activity.js", () => ({
  listSolanaStagedPending: (...args: unknown[]) => mockListSolanaStagedPending(...args),
  confirmActivityEvent: (...args: unknown[]) => mockConfirmActivityEvent(...args),
  failActivityEvent: (...args: unknown[]) => mockFailActivityEvent(...args),
  touchLastChecked: (...args: unknown[]) => mockTouchLastChecked(...args),
  recoverStaleHashlessIntents: (...args: unknown[]) => mockRecoverStaleHashlessIntents(...args),
  HASHLESS_INTENT_RECOVERY_LEASE_MS: 15 * 60 * 1000,
}));

const {
  repairPendingSolanaActivity,
  isSolanaSweepCandidateDue,
  solanaSweepBackoffIntervalMs,
  isSolanaSweepEscalated,
  SOLANA_HASHLESS_RECOVERY_BATCH_LIMIT,
  SOLANA_SWEEP_BATCH_LIMIT,
} = await import("@vex-agent/sync/solana-activity-repair.js");

function candidateEvent(overrides: Partial<AgentActivityEvent> = {}): AgentActivityEvent {
  return {
    id: 1,
    protocolExecutionId: 42,
    eventIndex: 0,
    eventRole: "swap",
    recordVersion: 1,
    kind: "swap",
    protocol: "jupiter",
    chainId: 20011000000,
    chainSlug: "solana",
    status: "pending",
    failureCode: null,
    failureReason: null,
    tokenInAddress: "USDCmint1111111111111111111111111111111111",
    tokenInSymbol: "USDC",
    tokenInDecimals: 6,
    amountInHuman: "10",
    amountInRaw: "10000000",
    tokenOutAddress: "So11111111111111111111111111111111111111112",
    tokenOutSymbol: "SOL",
    tokenOutDecimals: 9,
    amountOutHuman: null,
    amountOutRaw: null,
    executedAmountInHuman: null,
    executedAmountInRaw: null,
    executedAmountOutHuman: null,
    executedAmountOutRaw: null,
    usdInEst: null,
    usdOutEst: null,
    usdFeeEst: null,
    usdSource: null,
    txHash: "5SoLSigBase58aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    fromAddress: "SoLFromAddr1111111111111111111111111111111",
    nonce: null,
    walletAddress: "SoLFromAddr1111111111111111111111111111111",
    sessionId: "00000000-0000-4000-8000-000000000001",
    routeProvenance: null,
    fromChainId: null,
    fromChainSlug: null,
    toChainId: null,
    toChainSlug: null,
    chainFamily: "solana",
    providerOrderId: null,
    normalizedRoute: null,
    providerStatus: null,
    evidenceSource: null,
    observedAt: null,
    lastAttemptedAt: null,
    submitAttemptedAt: "2026-07-24T10:00:00.000Z",
    recentBlockhash: "11111111111111111111111111111112",
    lastValidBlockHeight: 100,
    broadcastAt: "2026-07-24T10:00:01.000Z",
    confirmedAt: null,
    lastCheckedAt: null,
    createdAt: "2026-07-24T09:59:00.000Z",
    updatedAt: "2026-07-24T10:00:01.000Z",
    ...overrides,
  };
}

function noopDeps(overrides: Partial<SolanaActivitySweepDeps> = {}): SolanaActivitySweepDeps {
  return {
    getSignatureStatus: vi.fn().mockResolvedValue({ outcome: "unavailable" }),
    getFinalizedTransaction: vi.fn().mockResolvedValue({ outcome: "unavailable" }),
    getCurrentBlockHeight: vi.fn().mockResolvedValue({ outcome: "unavailable" }),
    ...overrides,
  };
}

/** A landed SPL↔SPL swap the GENERIC decoder proves from token balances alone (no wallet-sourced transfers). */
function splSwapRawTransaction(
  event: AgentActivityEvent,
  options: { readonly amountOut?: string } = {},
): unknown {
  return {
    meta: {
      err: null,
      fee: 5000,
      preBalances: [1_000_000_000, 0],
      postBalances: [1_000_000_000, 0],
      preTokenBalances: [{ owner: event.walletAddress, mint: event.tokenInAddress, uiTokenAmount: { amount: "10000000" } }],
      postTokenBalances: [
        { owner: event.walletAddress, mint: event.tokenInAddress, uiTokenAmount: { amount: "0" } },
        { owner: event.walletAddress, mint: event.tokenOutAddress, uiTokenAmount: { amount: options.amountOut ?? "990000000" } },
      ],
      loadedAddresses: { writable: [], readonly: [] },
    },
    transaction: { message: { accountKeys: [{ pubkey: event.walletAddress }] } },
  };
}

/**
 * A landed fee-bearing SOL → USDC swap in the REAL `/build` shape (wrap
 * transfer into the wallet's own WSOL ATA, allowlisted tip, network fee,
 * temporary WSOL ATA created+closed, persistent output ATA) together with the
 * row that carries its settlement profile.
 */
function nativeSolSwapCandidate(options: { readonly profileTipLamports?: number } = {}) {
  const wallet = Keypair.generate().publicKey;
  const walletAddress = wallet.toBase58();
  const usdcMint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const wsolAta = getAssociatedTokenAddressSync(new PublicKey(SOL_MINT), wallet).toBase58();
  const usdcAta = getAssociatedTokenAddressSync(new PublicKey(usdcMint), wallet).toBase58();
  const tipReceiver = JUPITER_TIP_RECEIVER_ADDRESSES[0]!;
  const fee = 5_000, tip = 1_000_000, rent = 2_039_280, solIn = 10_000_000;
  const walletPre = 2_000_000_000;

  const routeProvenance = buildSolanaSettlementRouteProvenance({
    inputMint: SOL_MINT,
    outputMint: usdcMint,
    inputAmountRaw: String(solIn),
    approvedTipLamports: options.profileTipLamports ?? tip,
    certifiedTip: { tipLamports: options.profileTipLamports ?? tip, tipReceiver },
    wrapAndUnwrapSol: true,
  })!;

  const event = candidateEvent({
    submitAttemptedAt: new Date(Date.now() - 120_000).toISOString(),
    walletAddress,
    fromAddress: walletAddress,
    tokenInAddress: SOL_MINT,
    tokenInSymbol: "SOL",
    tokenInDecimals: 9,
    tokenOutAddress: usdcMint,
    tokenOutSymbol: "USDC",
    tokenOutDecimals: 6,
    routeProvenance,
  });

  const systemTransfer = (destination: string, lamports: number) => ({
    program: "system",
    parsed: { type: "transfer", info: { source: walletAddress, destination, lamports } },
  });
  const systemCreateAccount = (newAccount: string) => ({
    program: "system",
    parsed: { type: "createAccount", info: { source: walletAddress, newAccount, lamports: rent } },
  });

  const rawTx = {
    meta: {
      err: null,
      fee,
      preBalances: [walletPre, 0, 0, 0],
      postBalances: [walletPre - fee - tip - solIn - rent, 0, rent, tip],
      preTokenBalances: [],
      postTokenBalances: [{ owner: walletAddress, mint: usdcMint, uiTokenAmount: { amount: "758696" } }],
      loadedAddresses: { writable: [], readonly: [] },
      innerInstructions: [
        { index: 0, instructions: [systemCreateAccount(wsolAta)] },
        { index: 3, instructions: [systemCreateAccount(usdcAta)] },
      ],
    },
    transaction: {
      message: {
        accountKeys: [walletAddress, wsolAta, usdcAta, tipReceiver].map((pubkey) => ({ pubkey })),
        instructions: [systemTransfer(wsolAta, solIn), systemTransfer(tipReceiver, tip)],
      },
    },
  };

  return { event, rawTx };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRecoverStaleHashlessIntents.mockResolvedValue([]);
  mockConfirmActivityEvent.mockResolvedValue({ applied: true, row: candidateEvent({ status: "confirmed" }) });
  mockFailActivityEvent.mockResolvedValue({ applied: true, row: candidateEvent({ status: "definitively_failed" }) });
});

describe("backoff pure helpers", () => {
  it("is due once the first-check floor (60s) has passed for a fresh, never-checked row", () => {
    const due = Date.parse("2026-07-24T10:01:05.000Z"); // 65s after submit
    const notYetDue = Date.parse("2026-07-24T10:00:30.000Z"); // 30s after submit
    const submitAttemptedAt = "2026-07-24T10:00:00.000Z";
    expect(isSolanaSweepCandidateDue({ submitAttemptedAt, lastCheckedAt: null }, due)).toBe(true);
    expect(isSolanaSweepCandidateDue({ submitAttemptedAt, lastCheckedAt: null }, notYetDue)).toBe(false);
  });

  it("is NOT due again immediately after a fresh check (same tick)", () => {
    const now = Date.parse("2026-07-24T10:00:10.000Z");
    expect(
      isSolanaSweepCandidateDue({ submitAttemptedAt: "2026-07-24T10:00:00.000Z", lastCheckedAt: "2026-07-24T10:00:05.000Z" }, now),
    ).toBe(false);
  });

  it("backoff interval grows with age (60s -> 5min -> 30min -> 2h)", () => {
    expect(solanaSweepBackoffIntervalMs(60_000)).toBe(60_000);
    expect(solanaSweepBackoffIntervalMs(20 * 60_000)).toBe(5 * 60_000);
    expect(solanaSweepBackoffIntervalMs(2 * 3_600_000)).toBe(30 * 60_000);
    expect(solanaSweepBackoffIntervalMs(10 * 3_600_000)).toBe(2 * 3_600_000);
  });

  it("escalates only past the escalation age threshold", () => {
    const submittedAt = "2026-07-24T06:00:00.000Z";
    expect(isSolanaSweepEscalated({ submitAttemptedAt: submittedAt }, Date.parse("2026-07-24T08:00:00.000Z"))).toBe(false);
    expect(isSolanaSweepEscalated({ submitAttemptedAt: submittedAt }, Date.parse("2026-07-24T10:30:00.000Z"))).toBe(true);
  });
});

describe("repairPendingSolanaActivity", () => {
  it("always runs the stale hashless-intent recovery with the shared lease + its own batch limit", async () => {
    mockListSolanaStagedPending.mockResolvedValueOnce([]);
    await repairPendingSolanaActivity(noopDeps());
    expect(mockRecoverStaleHashlessIntents).toHaveBeenCalledWith(15 * 60 * 1000, SOLANA_HASHLESS_RECOVERY_BATCH_LIMIT);
    expect(mockListSolanaStagedPending).toHaveBeenCalledWith(SOLANA_SWEEP_BATCH_LIMIT);
  });

  it("skips a not-yet-due candidate without spending an RPC call", async () => {
    const recentlyChecked = candidateEvent({ lastCheckedAt: new Date().toISOString() });
    mockListSolanaStagedPending.mockResolvedValueOnce([recentlyChecked]);
    const deps = noopDeps();

    const result = await repairPendingSolanaActivity(deps);

    expect(deps.getSignatureStatus).not.toHaveBeenCalled();
    expect(result.checked).toBe(0);
    expect(result.stillPending).toBe(1);
  });

  it("finalizes mined_revert when getSignatureStatuses reports an on-chain error", async () => {
    const event = candidateEvent({ submitAttemptedAt: new Date(Date.now() - 120_000).toISOString() });
    mockListSolanaStagedPending.mockResolvedValueOnce([event]);
    const deps = noopDeps({
      getSignatureStatus: vi.fn().mockResolvedValue({ outcome: "found", value: { err: { InstructionError: [0, "Custom"] }, confirmationStatus: "confirmed" } }),
    });

    const result = await repairPendingSolanaActivity(deps);

    expect(mockFailActivityEvent).toHaveBeenCalledWith(event.id, expect.objectContaining({ failureCode: "mined_revert" }));
    expect(result.failed).toBe(1);
  });

  it("confirms via decoded settlement once landed + fetched", async () => {
    const event = candidateEvent({ submitAttemptedAt: new Date(Date.now() - 120_000).toISOString() });
    mockListSolanaStagedPending.mockResolvedValueOnce([event]);
    const deps = noopDeps({
      getSignatureStatus: vi.fn().mockResolvedValue({ outcome: "found", value: { err: null, confirmationStatus: "finalized" } }),
      getFinalizedTransaction: vi.fn().mockResolvedValue({ outcome: "found", value: splSwapRawTransaction(event) }),
    });

    const result = await repairPendingSolanaActivity(deps);

    expect(mockConfirmActivityEvent).toHaveBeenCalledWith(event.id, {
      executedAmountInRaw: "10000000",
      // The row's own persisted decimals (6 in / 9 out) turn each proven
      // magnitude into the exact decimal an agent can actually read — no extra
      // lookup, no float division.
      executedAmountInHuman: "10",
      executedAmountOutRaw: "990000000",
      executedAmountOutHuman: "0.99",
    });
    expect(result.confirmed).toBe(1);
  });

  it("confirms with RAW ONLY when the row never persisted its decimals (degrade, never fail)", async () => {
    const event = candidateEvent({
      submitAttemptedAt: new Date(Date.now() - 120_000).toISOString(),
      tokenInDecimals: null,
      tokenOutDecimals: null,
    });
    mockListSolanaStagedPending.mockResolvedValueOnce([event]);
    const deps = noopDeps({
      getSignatureStatus: vi.fn().mockResolvedValue({ outcome: "found", value: { err: null, confirmationStatus: "finalized" } }),
      getFinalizedTransaction: vi.fn().mockResolvedValue({ outcome: "found", value: splSwapRawTransaction(event) }),
    });

    await repairPendingSolanaActivity(deps);

    expect(mockConfirmActivityEvent).toHaveBeenCalledWith(event.id, {
      executedAmountInRaw: "10000000",
      executedAmountOutRaw: "990000000",
    });
  });

  it("formats an amount beyond Number.MAX_SAFE_INTEGER digit-exact (string math, never float division)", async () => {
    const hugeRaw = "123456789012345678901"; // 1.2e20 atomic units — far past 2^53
    const event = candidateEvent({ submitAttemptedAt: new Date(Date.now() - 120_000).toISOString() });
    mockListSolanaStagedPending.mockResolvedValueOnce([event]);
    const deps = noopDeps({
      getSignatureStatus: vi.fn().mockResolvedValue({ outcome: "found", value: { err: null, confirmationStatus: "finalized" } }),
      getFinalizedTransaction: vi.fn().mockResolvedValue({
        outcome: "found",
        value: splSwapRawTransaction(event, { amountOut: hugeRaw }),
      }),
    });

    await repairPendingSolanaActivity(deps);

    expect(mockConfirmActivityEvent).toHaveBeenCalledWith(
      event.id,
      // 9 decimals on the out leg.
      expect.objectContaining({ executedAmountOutRaw: hugeRaw, executedAmountOutHuman: "123456789012.345678901" }),
    );
  });

  it("stays pending (touched) when landed but the decoder cannot prove the legs", async () => {
    const event = candidateEvent({ submitAttemptedAt: new Date(Date.now() - 120_000).toISOString() });
    mockListSolanaStagedPending.mockResolvedValueOnce([event]);
    const rawTx = {
      meta: {
        err: null, fee: 5000,
        preBalances: [1_000_000_000], postBalances: [1_000_000_000],
        preTokenBalances: [], postTokenBalances: [],
        loadedAddresses: { writable: [], readonly: [] },
      },
      transaction: { message: { accountKeys: [{ pubkey: event.walletAddress }] } },
    };
    const deps = noopDeps({
      getSignatureStatus: vi.fn().mockResolvedValue({ outcome: "found", value: { err: null, confirmationStatus: "confirmed" } }),
      getFinalizedTransaction: vi.fn().mockResolvedValue({ outcome: "found", value: rawTx }),
    });

    const result = await repairPendingSolanaActivity(deps);

    expect(mockConfirmActivityEvent).not.toHaveBeenCalled();
    expect(mockTouchLastChecked).toHaveBeenCalledWith(event.id);
    expect(result.stillPending).toBe(1);
  });

  it("stays pending WITHOUT touching last_checked_at when the RPC is unavailable", async () => {
    const event = candidateEvent({ submitAttemptedAt: new Date(Date.now() - 120_000).toISOString() });
    mockListSolanaStagedPending.mockResolvedValueOnce([event]);
    const deps = noopDeps(); // everything "unavailable"

    const result = await repairPendingSolanaActivity(deps);

    expect(mockTouchLastChecked).not.toHaveBeenCalled();
    expect(mockFailActivityEvent).not.toHaveBeenCalled();
    expect(result.stillPending).toBe(1);
  });

  it("falls back to getFinalizedTransaction when getSignatureStatuses misses (R3: cross-check before expiry)", async () => {
    const event = candidateEvent({ submitAttemptedAt: new Date(Date.now() - 120_000).toISOString() });
    mockListSolanaStagedPending.mockResolvedValueOnce([event]);
    const rawTx = { meta: { err: { some: "error" }, fee: 5000, preBalances: [1], postBalances: [1], preTokenBalances: [], postTokenBalances: [], loadedAddresses: {} }, transaction: { message: { accountKeys: [] } } };
    const getFinalizedTransaction = vi.fn().mockResolvedValue({ outcome: "found", value: rawTx });
    const deps = noopDeps({
      getSignatureStatus: vi.fn().mockResolvedValue({ outcome: "not_found" }),
      getFinalizedTransaction,
    });

    const result = await repairPendingSolanaActivity(deps);

    expect(getFinalizedTransaction).toHaveBeenCalledWith(event.txHash);
    expect(mockFailActivityEvent).toHaveBeenCalledWith(event.id, expect.objectContaining({ failureCode: "mined_revert" }));
    expect(result.failed).toBe(1);
  });

  it("expiry gate: BOTH miss + blockHeight > last_valid_block_height -> solana_signature_expired", async () => {
    const event = candidateEvent({ submitAttemptedAt: new Date(Date.now() - 120_000).toISOString(), lastValidBlockHeight: 100 });
    mockListSolanaStagedPending.mockResolvedValueOnce([event]);
    const deps = noopDeps({
      getSignatureStatus: vi.fn().mockResolvedValue({ outcome: "not_found" }),
      getFinalizedTransaction: vi.fn().mockResolvedValue({ outcome: "not_found" }),
      getCurrentBlockHeight: vi.fn().mockResolvedValue({ outcome: "found", value: 101 }),
    });

    const result = await repairPendingSolanaActivity(deps);

    expect(mockFailActivityEvent).toHaveBeenCalledWith(event.id, expect.objectContaining({ failureCode: "solana_signature_expired" }));
    expect(result.failed).toBe(1);
  });

  it("expiry gate: BOTH miss but blockHeight has NOT passed last_valid_block_height -> stays pending", async () => {
    const event = candidateEvent({ submitAttemptedAt: new Date(Date.now() - 120_000).toISOString(), lastValidBlockHeight: 100 });
    mockListSolanaStagedPending.mockResolvedValueOnce([event]);
    const deps = noopDeps({
      getSignatureStatus: vi.fn().mockResolvedValue({ outcome: "not_found" }),
      getFinalizedTransaction: vi.fn().mockResolvedValue({ outcome: "not_found" }),
      getCurrentBlockHeight: vi.fn().mockResolvedValue({ outcome: "found", value: 99 }),
    });

    const result = await repairPendingSolanaActivity(deps);

    expect(mockFailActivityEvent).not.toHaveBeenCalled();
    expect(mockTouchLastChecked).toHaveBeenCalledWith(event.id);
    expect(result.stillPending).toBe(1);
  });

  it("a grandfathered row with no persisted evidence (last_valid_block_height null) can NEVER expire", async () => {
    const event = candidateEvent({ submitAttemptedAt: new Date(Date.now() - 120_000).toISOString(), lastValidBlockHeight: null });
    mockListSolanaStagedPending.mockResolvedValueOnce([event]);
    const getCurrentBlockHeight = vi.fn().mockResolvedValue({ outcome: "found", value: 999_999 });
    const deps = noopDeps({
      getSignatureStatus: vi.fn().mockResolvedValue({ outcome: "not_found" }),
      getFinalizedTransaction: vi.fn().mockResolvedValue({ outcome: "not_found" }),
      getCurrentBlockHeight,
    });

    const result = await repairPendingSolanaActivity(deps);

    expect(getCurrentBlockHeight).not.toHaveBeenCalled();
    expect(mockFailActivityEvent).not.toHaveBeenCalled();
    expect(result.stillPending).toBe(1);
  });

  it("confirms a NATIVE-SOL swap through the row's own settlement profile (the live defect: previously pending forever)", async () => {
    const { event, rawTx } = nativeSolSwapCandidate();
    mockListSolanaStagedPending.mockResolvedValueOnce([event]);
    const deps = noopDeps({
      getSignatureStatus: vi.fn().mockResolvedValue({ outcome: "found", value: { err: null, confirmationStatus: "finalized" } }),
      getFinalizedTransaction: vi.fn().mockResolvedValue({ outcome: "found", value: rawTx }),
    });

    const result = await repairPendingSolanaActivity(deps);

    expect(mockConfirmActivityEvent).toHaveBeenCalledWith(event.id, {
      executedAmountInRaw: "10000000",
      executedAmountInHuman: "0.01",
      executedAmountOutRaw: "758696",
      executedAmountOutHuman: "0.758696",
    });
    expect(result.confirmed).toBe(1);
  });

  it("leaves the row PENDING when the profile decoder declines — never a fallback guess", async () => {
    // Same landed transaction, but the profile's tip does not match what the
    // transaction actually paid, so nothing about it is proven.
    const { event, rawTx } = nativeSolSwapCandidate({ profileTipLamports: 2_000_000 });
    mockListSolanaStagedPending.mockResolvedValueOnce([event]);
    const deps = noopDeps({
      getSignatureStatus: vi.fn().mockResolvedValue({ outcome: "found", value: { err: null, confirmationStatus: "finalized" } }),
      getFinalizedTransaction: vi.fn().mockResolvedValue({ outcome: "found", value: rawTx }),
    });

    const result = await repairPendingSolanaActivity(deps);

    expect(mockConfirmActivityEvent).not.toHaveBeenCalled();
    expect(mockFailActivityEvent).not.toHaveBeenCalled();
    expect(mockTouchLastChecked).toHaveBeenCalledWith(event.id);
    expect(result.stillPending).toBe(1);
  });

  it("leaves a PROFILE-LESS native-SOL swap pending (the generic decoder still declines — row 20's grandfathered state)", async () => {
    const { event, rawTx } = nativeSolSwapCandidate();
    mockListSolanaStagedPending.mockResolvedValueOnce([{ ...event, routeProvenance: null }]);
    const deps = noopDeps({
      getSignatureStatus: vi.fn().mockResolvedValue({ outcome: "found", value: { err: null, confirmationStatus: "finalized" } }),
      getFinalizedTransaction: vi.fn().mockResolvedValue({ outcome: "found", value: rawTx }),
    });

    const result = await repairPendingSolanaActivity(deps);

    expect(mockConfirmActivityEvent).not.toHaveBeenCalled();
    expect(result.stillPending).toBe(1);
  });

  it("treats a duplicate-CAS-miss confirm as neither confirmed, failed, nor pending when the row is no longer pending (never double-counted)", async () => {
    const event = candidateEvent({ submitAttemptedAt: new Date(Date.now() - 120_000).toISOString() });
    mockListSolanaStagedPending.mockResolvedValueOnce([event]);
    mockConfirmActivityEvent.mockResolvedValueOnce({ applied: false, row: candidateEvent({ status: "confirmed" }) });
    const rawTx = {
      meta: {
        err: null, fee: 5000, preBalances: [1_000_000_000], postBalances: [1_000_000_000],
        preTokenBalances: [
          { owner: event.walletAddress, mint: event.tokenInAddress, uiTokenAmount: { amount: "10000000" } },
        ],
        postTokenBalances: [
          { owner: event.walletAddress, mint: event.tokenInAddress, uiTokenAmount: { amount: "0" } },
          { owner: event.walletAddress, mint: event.tokenOutAddress, uiTokenAmount: { amount: "990000000" } },
        ],
        loadedAddresses: { writable: [], readonly: [] },
      },
      transaction: { message: { accountKeys: [{ pubkey: event.walletAddress }] } },
    };
    const deps = noopDeps({
      getSignatureStatus: vi.fn().mockResolvedValue({ outcome: "found", value: { err: null, confirmationStatus: "finalized" } }),
      getFinalizedTransaction: vi.fn().mockResolvedValue({ outcome: "found", value: rawTx }),
    });

    const result = await repairPendingSolanaActivity(deps);

    expect(result.confirmed).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.stillPending).toBe(0);
  });
});
