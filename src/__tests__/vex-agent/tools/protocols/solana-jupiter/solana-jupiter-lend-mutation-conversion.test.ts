/**
 * `solana.lend.deposit`/`solana.lend.withdraw` — W5 staged-Solana-seam
 * mutation conversion (design `w5-design.md` §3/R2b, migration 049, card K6).
 *
 * Drives the REAL handler (`LEND_HANDLERS["solana.lend.*"]`) with every
 * external boundary mocked: the Jupiter Lend Earn REST client (transaction-
 * only responses), the K2 staged-seam primitives (`prepareVersionedTx`,
 * `submitPreparedTx`), and the `agent_activity` repo façade. Pins the
 * write-protocol ORDER (request → intent → sign → persist → submit) and the
 * truthful-pending contract (never a fabricated confirm; a mismatch/throw at
 * any post-intent step never terminalizes the row) — mirrors the mocking
 * recipe in `kyberswap-swap-execute-adversarial.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Keypair } from "@solana/web3.js";
import type { ProtocolExecutionContext } from "@vex-agent/tools/protocols/types.js";

const SIGNER = Keypair.generate();
const WALLET_ADDRESS = SIGNER.publicKey.toBase58();

const mockResolveSigningWallet = vi.fn(() => ({
  family: "solana" as const, address: WALLET_ADDRESS, secretKey: SIGNER.secretKey,
}));
const mockResolveSelectedAddress = vi.fn(() => WALLET_ADDRESS);

vi.mock("@vex-agent/tools/internal/wallet/resolve.js", () => ({
  resolveSigningWallet: (...args: unknown[]) => mockResolveSigningWallet(...args),
  resolveSelectedAddress: (...args: unknown[]) => mockResolveSelectedAddress(...args),
  walletScopeErrorToResult: (err: unknown) => ({
    success: false,
    output: err instanceof Error ? err.message : String(err),
  }),
}));

const mockRequestDeposit = vi.fn();
const mockRequestWithdraw = vi.fn();
vi.mock("@tools/solana-ecosystem/jupiter/jupiter-lend/earn-api/service.js", () => ({
  getJupiterLendEarnTokens: vi.fn(),
  getJupiterLendEarnPositions: vi.fn(),
  getJupiterLendEarnEarnings: vi.fn(),
  requestJupiterLendEarnDepositTransaction: (...args: unknown[]) => mockRequestDeposit(...args),
  requestJupiterLendEarnWithdrawTransaction: (...args: unknown[]) => mockRequestWithdraw(...args),
}));

const mockPrepareVersionedTx = vi.fn();
const mockSubmitOverRpc = vi.fn();
vi.mock("@tools/solana-ecosystem/shared/solana-transaction.js", () => ({
  prepareVersionedTx: (...args: unknown[]) => mockPrepareVersionedTx(...args),
  submitPreparedTxOverRpc: (...args: unknown[]) => mockSubmitOverRpc(...args),
}));

// Present only so the test can PROVE it is never reached: a Lend transaction
// is built by the Lend API and carries no Jupiter tip, so `/tx/v1/submit`
// would silently drop it (the 2026-07-24 funded-gate defect).
const mockSubmitPreparedTx = vi.fn();
vi.mock("@tools/solana-ecosystem/jupiter/jupiter-swaps/submit-prepared-tx.js", () => ({
  submitPreparedTx: (...args: unknown[]) => mockSubmitPreparedTx(...args),
}));

// Only `solanaExplorerUrl` is stubbed (it reads local config); the REAL
// `atomicToExactDecimalString` stays, so the leg's `amountHuman` assertions
// below exercise production's own BigInt formatter rather than a test copy.
vi.mock("@tools/solana-ecosystem/shared/solana-validation.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tools/solana-ecosystem/shared/solana-validation.js")>();
  return { ...actual, solanaExplorerUrl: (sig: string) => `https://explorer.solana.com/tx/${sig}` };
});

// Lend Earn only ever holds the asset MINT, so the activity leg's
// symbol/decimals come from the Jupiter tokens service (mocked here — a unit
// test must never reach the network on a signing path).
const mockResolveJupiterToken = vi.fn();
vi.mock("@tools/solana-ecosystem/jupiter/jupiter-tokens/service.js", () => ({
  resolveJupiterToken: (...args: unknown[]) => mockResolveJupiterToken(...args),
}));

const mockCreateAgentActivityIntent = vi.fn();
const mockCreateAgentActivityPreBroadcastFailure = vi.fn();
const mockMarkActivitySolanaBroadcast = vi.fn();
const mockFailActivityEvent = vi.fn();
const mockMarkBroadcastAccepted = vi.fn();
vi.mock("@vex-agent/db/repos/agent-activity.js", () => ({
  createAgentActivityIntent: (...args: unknown[]) => mockCreateAgentActivityIntent(...args),
  createAgentActivityPreBroadcastFailure: (...args: unknown[]) => mockCreateAgentActivityPreBroadcastFailure(...args),
  markActivitySolanaBroadcast: (...args: unknown[]) => mockMarkActivitySolanaBroadcast(...args),
  failActivityEvent: (...args: unknown[]) => mockFailActivityEvent(...args),
  markBroadcastAccepted: (...args: unknown[]) => mockMarkBroadcastAccepted(...args),
}));

vi.mock("@utils/logger.js", () => {
  const stub = { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() };
  return { default: stub, logger: stub };
});

const { LEND_HANDLERS } = await import("@vex-agent/tools/protocols/solana-jupiter/handlers/lend.js");

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

const PREPARED = {
  serialized: new Uint8Array([1, 2, 3]),
  signature: "LocalSig111",
  recentBlockhash: "FreshBlockhash111",
  lastValidBlockHeight: 12345,
};

const USDC_METADATA = {
  chain: "solana", address: "USDC_MINT", symbol: "USDC", name: "USD Coin", decimals: 6,
};

describe("solana.lend.deposit / solana.lend.withdraw — staged Solana seam (K6)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveSigningWallet.mockReturnValue({ family: "solana", address: WALLET_ADDRESS, secretKey: SIGNER.secretKey });
    mockResolveSelectedAddress.mockReturnValue(WALLET_ADDRESS);
    mockRequestDeposit.mockResolvedValue({ transaction: "unsigned-deposit-tx-b64" });
    mockRequestWithdraw.mockResolvedValue({ transaction: "unsigned-withdraw-tx-b64" });
    mockPrepareVersionedTx.mockResolvedValue(PREPARED);
    mockSubmitOverRpc.mockResolvedValue({ kind: "accepted", signature: PREPARED.signature });
    mockMarkBroadcastAccepted.mockResolvedValue({ applied: true, row: {} });
    mockCreateAgentActivityIntent.mockResolvedValue({ executionId: 42, events: [{ id: 7 }] });
    mockCreateAgentActivityPreBroadcastFailure.mockResolvedValue({ executionId: 43, event: { id: 8 } });
    mockMarkActivitySolanaBroadcast.mockResolvedValue({ applied: true, row: {} });
    mockFailActivityEvent.mockResolvedValue({ applied: true, row: {} });
    mockResolveJupiterToken.mockResolvedValue(USDC_METADATA);
  });

  it("deposit: records the intent BEFORE signing (kind='lend', chainFamily='solana', tokenIn=asset), then signs/persists/submits in order", async () => {
    const result = await LEND_HANDLERS["solana.lend.deposit"]!(
      { asset: "USDC_MINT", amount: "1000000" },
      ctx(),
    );

    expect(mockRequestDeposit).toHaveBeenCalledWith({ asset: "USDC_MINT", amount: "1000000", signer: WALLET_ADDRESS });
    expect(mockCreateAgentActivityIntent).toHaveBeenCalledTimes(1);
    const intentArg = mockCreateAgentActivityIntent.mock.calls[0][0];
    expect(intentArg.events[0]).toMatchObject({
      eventIndex: 0, eventRole: "lend_deposit", kind: "lend", protocol: "jupiter",
      chainId: 20_011_000_000, chainFamily: "solana", walletAddress: WALLET_ADDRESS,
      sessionId: "session-1",
      // The agent reading its own feed must see WHAT it deposited, not a raw
      // mint plus a bare integer: symbol + decimals + the exact-decimal human
      // amount alongside its atomic sibling.
      tokenIn: {
        tokenAddress: "USDC_MINT", tokenSymbol: "USDC", tokenDecimals: 6,
        amountHuman: "1", amountRaw: "1000000",
      },
    });
    expect(intentArg.events[0].tokenOut).toBeUndefined();

    // Sign happens AFTER intent creation, with the raw provider tx + the resolved signer.
    expect(mockPrepareVersionedTx).toHaveBeenCalledWith("unsigned-deposit-tx-b64", expect.any(Keypair));

    // Persist BEFORE submit, with the derived signature + blockhash evidence.
    expect(mockMarkActivitySolanaBroadcast).toHaveBeenCalledWith(7, {
      txHash: PREPARED.signature, fromAddress: WALLET_ADDRESS,
      recentBlockhash: PREPARED.recentBlockhash, lastValidBlockHeight: PREPARED.lastValidBlockHeight,
    });
    // A Lend transaction is TIPLESS, so it must go out over RPC — Jupiter's
    // tip-gated `/tx/v1/submit` would drop it silently (funded-gate defect).
    expect(mockSubmitOverRpc).toHaveBeenCalledWith(PREPARED);
    expect(mockSubmitPreparedTx).not.toHaveBeenCalled();
    // A matching acceptance is recorded exactly once (design D5).
    expect(mockMarkBroadcastAccepted).toHaveBeenCalledTimes(1);
    expect(mockMarkBroadcastAccepted).toHaveBeenCalledWith(7);

    // Truthful-pending — never a fabricated confirm.
    expect(result.success).toBe(false);
    expect(result.output).toMatch(/pending/i);
    const data = result.data as Record<string, unknown>;
    expect(data._executionId).toBe(42);
    expect(data.status).toBe("pending");
    expect(data.signature).toBe(PREPARED.signature);
  });

  it("withdraw: records tokenOut (not tokenIn) with role lend_withdraw", async () => {
    await LEND_HANDLERS["solana.lend.withdraw"]!(
      { asset: "USDC_MINT", amount: "500000" },
      ctx(),
    );

    expect(mockRequestWithdraw).toHaveBeenCalledWith({ asset: "USDC_MINT", amount: "500000", signer: WALLET_ADDRESS });
    const intentArg = mockCreateAgentActivityIntent.mock.calls[0][0];
    expect(intentArg.events[0]).toMatchObject({ eventRole: "lend_withdraw", kind: "lend" });
    expect(intentArg.events[0].tokenIn).toBeUndefined();
    // The live defect: raw "500000" @ 6 decimals is 0.5 USDC — exact string
    // math, never a float divide.
    expect(intentArg.events[0].tokenOut).toEqual({
      tokenAddress: "USDC_MINT", tokenSymbol: "USDC", tokenDecimals: 6,
      amountHuman: "0.5", amountRaw: "500000",
    });
  });

  it("a u64 amount beyond Number.MAX_SAFE_INTEGER is recorded digit-exact (string math, not float division)", async () => {
    mockResolveJupiterToken.mockResolvedValue({ ...USDC_METADATA, symbol: "BONK", decimals: 5 });
    const hugeRaw = "18446744073709551615";
    expect(Number(hugeRaw)).toBeGreaterThan(Number.MAX_SAFE_INTEGER);

    await LEND_HANDLERS["solana.lend.deposit"]!({ asset: "USDC_MINT", amount: hugeRaw }, ctx());

    const intentArg = mockCreateAgentActivityIntent.mock.calls[0][0];
    expect(intentArg.events[0].tokenIn).toEqual({
      tokenAddress: "USDC_MINT", tokenSymbol: "BONK", tokenDecimals: 5,
      amountHuman: "184467440737095.51615", amountRaw: hugeRaw,
    });
  });

  it("token-metadata resolution THROWING never blocks the funded mutation — the row is still recorded with the raw facts", async () => {
    mockResolveJupiterToken.mockRejectedValue(new Error("Jupiter Tokens API V2 key is not configured"));

    const result = await LEND_HANDLERS["solana.lend.deposit"]!(
      { asset: "USDC_MINT", amount: "500000" },
      ctx(),
    );

    // Cosmetic metadata degrades; the mutation still runs end to end.
    const intentArg = mockCreateAgentActivityIntent.mock.calls[0][0];
    expect(intentArg.events[0].tokenIn).toEqual({ tokenAddress: "USDC_MINT", amountRaw: "500000" });
    expect(intentArg.events[0].failureCode).toBeUndefined();
    expect(mockPrepareVersionedTx).toHaveBeenCalledTimes(1);
    expect(mockMarkActivitySolanaBroadcast).toHaveBeenCalledTimes(1);
    expect(mockSubmitOverRpc).toHaveBeenCalledTimes(1);
    expect(mockFailActivityEvent).not.toHaveBeenCalled();
    expect(result.output).toMatch(/pending/i);
  });

  it("a pre-broadcast provider rejection still records the resolved leg metadata", async () => {
    mockRequestDeposit.mockRejectedValue(new Error("insufficient balance for deposit"));

    await LEND_HANDLERS["solana.lend.deposit"]!({ asset: "USDC_MINT", amount: "500000" }, ctx());

    const failArg = mockCreateAgentActivityPreBroadcastFailure.mock.calls[0][0];
    expect(failArg.event.tokenIn).toEqual({
      tokenAddress: "USDC_MINT", tokenSymbol: "USDC", tokenDecimals: 6,
      amountHuman: "0.5", amountRaw: "500000",
    });
  });

  it("a provider rejection of the unsigned-tx request is a PRE-broadcast failure — no intent row, no signing", async () => {
    mockRequestDeposit.mockRejectedValue(new Error("insufficient balance for deposit"));

    const result = await LEND_HANDLERS["solana.lend.deposit"]!(
      { asset: "USDC_MINT", amount: "1000000" },
      ctx(),
    );

    expect(mockCreateAgentActivityPreBroadcastFailure).toHaveBeenCalledTimes(1);
    const failArg = mockCreateAgentActivityPreBroadcastFailure.mock.calls[0][0];
    expect(failArg.event).toMatchObject({ failureCode: "route_not_found", kind: "lend", chainFamily: "solana" });
    expect(mockCreateAgentActivityIntent).not.toHaveBeenCalled();
    expect(mockPrepareVersionedTx).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.output).toContain("insufficient balance for deposit");
    expect((result.data as Record<string, unknown>)._executionId).toBe(43);
  });

  it("a sole-signer refusal (prepareVersionedTx throws) finalizes the EXISTING row via failActivityEvent — never a second intent", async () => {
    mockPrepareVersionedTx.mockRejectedValue(new Error("Refusing to sign: transaction requires 2 signers, expected exactly 1."));

    const result = await LEND_HANDLERS["solana.lend.deposit"]!(
      { asset: "USDC_MINT", amount: "1000000" },
      ctx(),
    );

    expect(mockFailActivityEvent).toHaveBeenCalledWith(7, expect.objectContaining({ failureCode: "unknown" }));
    expect(mockCreateAgentActivityPreBroadcastFailure).not.toHaveBeenCalled();
    expect(mockMarkActivitySolanaBroadcast).not.toHaveBeenCalled();
    expect(mockSubmitOverRpc).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect((result.data as Record<string, unknown>)._executionId).toBe(42);
  });

  it("a staging CAS miss refuses to submit untracked — no lane is ever entered", async () => {
    mockMarkActivitySolanaBroadcast.mockResolvedValue({ applied: false, row: {} });

    const result = await LEND_HANDLERS["solana.lend.deposit"]!(
      { asset: "USDC_MINT", amount: "1000000" },
      ctx(),
    );

    expect(mockSubmitOverRpc).not.toHaveBeenCalled();
    expect(mockSubmitPreparedTx).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.output).toMatch(/do not retry blindly/i);
  });

  it("a submit signature mismatch stays truthful-pending — never terminalizes, local signature stays canonical", async () => {
    mockSubmitOverRpc.mockResolvedValue({
      kind: "signature_mismatch", localSignature: PREPARED.signature, providerSignature: "OtherSig",
    });

    const result = await LEND_HANDLERS["solana.lend.deposit"]!(
      { asset: "USDC_MINT", amount: "1000000" },
      ctx(),
    );

    expect(mockFailActivityEvent).not.toHaveBeenCalled();
    expect(mockMarkBroadcastAccepted).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.output).toMatch(/pending/i);
    expect((result.data as Record<string, unknown>).signature).toBe(PREPARED.signature);
  });

  it("an AMBIGUOUS transport failure stays truthful-pending and never throws out of the handler", async () => {
    mockSubmitOverRpc.mockResolvedValue({ kind: "transport_uncertain", cause: new Error("fetch failed") });

    const result = await LEND_HANDLERS["solana.lend.deposit"]!(
      { asset: "USDC_MINT", amount: "1000000" },
      ctx(),
    );

    expect(mockFailActivityEvent).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.output).toMatch(/pending/i);
    expect((result.data as Record<string, unknown>).status).toBe("pending");
  });

  it("a DEFINITIVE rejection is reported as rejected, never as a pending broadcast, and still does not terminalize", async () => {
    mockSubmitOverRpc.mockResolvedValue({
      kind: "rejected_before_broadcast",
      cause: new Error("Simulation failed. Message: insufficient funds for rent."),
    });

    const result = await LEND_HANDLERS["solana.lend.deposit"]!(
      { asset: "USDC_MINT", amount: "1000000" },
      ctx(),
    );

    // The truthfulness fix: nothing went on-chain, so the agent must not be
    // told the transaction is in flight.
    expect(result.output).toMatch(/rejected before broadcast/i);
    expect(result.output).toMatch(/nothing went on-chain/i);
    expect(result.output).not.toMatch(/confirmation pending/i);
    expect(result.output).toContain("insufficient funds for rent");
    const data = result.data as Record<string, unknown>;
    expect(data.status).toBe("rejected_before_broadcast");
    // The row's lifecycle is UNCHANGED — the sweep stays the sole authority.
    expect(mockFailActivityEvent).not.toHaveBeenCalled();
    expect(mockMarkBroadcastAccepted).not.toHaveBeenCalled();
  });

  it("fails closed without an active session — no provider call, no recording", async () => {
    const result = await LEND_HANDLERS["solana.lend.deposit"]!(
      { asset: "USDC_MINT", amount: "1000000" },
      ctx({ sessionId: undefined }),
    );

    expect(result.success).toBe(false);
    expect(mockRequestDeposit).not.toHaveBeenCalled();
    expect(mockCreateAgentActivityIntent).not.toHaveBeenCalled();
  });
});
