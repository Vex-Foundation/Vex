/**
 * `solana.lend.borrowVaults`/`.borrowPositions`/`.borrowOperate` — Agent Scan
 * Phase 3 Batch 5, card B1; wire shape + WSOL pre-check hardened in card B3.
 * `borrowOperate` mirrors K6's staged-Solana-seam mutation-conversion test
 * recipe exactly (`solana-jupiter-lend-mutation-conversion.test.ts`) with the
 * ADDED vault-fetch step (Borrow's `/operate` carries no token identity of
 * its own — only `vaultId`), the ADDED native-SOL/WSOL funding pre-check, and
 * the `nftId` surfaced in the pending output.
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

// B3: wire-accurate fixture — nested Token objects, digit-string factors.
// `supplyToken` is deliberately NOT the WSOL mint (mSOL here) so the
// pre-existing deposit/withdraw/borrow tests below never trip the new WSOL
// funding pre-check; that behavior gets its OWN dedicated fixture/tests.
const SUPPLY_MINT = "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So"; // mSOL — real mint, NOT WSOL
const BORROW_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"; // USDC
const WSOL_MINT = "So11111111111111111111111111111111111111112";

const VAULT = {
  id: 1,
  address: "VaultAddr1",
  supplyToken: { address: SUPPLY_MINT, chainId: "solana", name: "Marinade staked SOL", symbol: "mSOL", uiSymbol: "mSOL", decimals: 9, price: "80" },
  borrowToken: { address: BORROW_MINT, chainId: "solana", name: "USD Coin", symbol: "USDC", uiSymbol: "USDC", decimals: 6, price: "1" },
  collateralFactor: "800",
  liquidationThreshold: "850",
  borrowable: "1000000000",
  withdrawable: "900000000",
  minimumBorrowing: "100000",
};

const WSOL_VAULT = {
  ...VAULT,
  id: 2,
  supplyToken: { address: WSOL_MINT, chainId: "solana", name: "Wrapped SOL", symbol: "WSOL", uiSymbol: "SOL", decimals: 9, price: "150" },
};

const mockGetVaults = vi.fn();
const mockGetPositions = vi.fn();
const mockRequestOperate = vi.fn();
vi.mock("@tools/solana-ecosystem/jupiter/jupiter-lend/borrow-api/service.js", () => ({
  getJupiterLendBorrowVaults: (...args: unknown[]) => mockGetVaults(...args),
  getJupiterLendBorrowPositions: (...args: unknown[]) => mockGetPositions(...args),
  requestJupiterLendBorrowOperateTransaction: (...args: unknown[]) => mockRequestOperate(...args),
}));

const mockPrepareVersionedTx = vi.fn();
const mockGetSolanaConnection = vi.fn(() => ({}));
const mockSubmitOverRpc = vi.fn();
vi.mock("@tools/solana-ecosystem/shared/solana-transaction.js", () => ({
  prepareVersionedTx: (...args: unknown[]) => mockPrepareVersionedTx(...args),
  getSolanaConnection: (...args: unknown[]) => mockGetSolanaConnection(...args),
  submitPreparedTxOverRpc: (...args: unknown[]) => mockSubmitOverRpc(...args),
}));

// B3: native-SOL/WSOL pre-broadcast funding check. `resolveMintTokenProgramId`
// short-circuits to `TOKEN_PROGRAM_ID` for WSOL without a network call in
// production; mocked here as a pure passthrough so only `getAccount`'s
// balance drives the test outcomes.
const mockResolveMintTokenProgramId = vi.fn(() => "TokenProgram111");
const mockDeriveAta = vi.fn(() => "AtaAddress111");
vi.mock("@tools/solana-ecosystem/shared/solana-token-program.js", () => ({
  resolveMintTokenProgramId: (...args: unknown[]) => mockResolveMintTokenProgramId(...args),
  deriveAssociatedTokenAccount: (...args: unknown[]) => mockDeriveAta(...args),
}));

const mockGetAccount = vi.fn();
vi.mock("@solana/spl-token", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@solana/spl-token")>();
  return { ...actual, getAccount: (...args: unknown[]) => mockGetAccount(...args) };
});

// Present only so the test can PROVE it is never reached: Borrow `/operate`
// returns a TIPLESS provider transaction, which `/tx/v1/submit` would drop.
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

const { LEND_BORROW_HANDLERS } = await import("@vex-agent/tools/protocols/solana-jupiter/handlers/lend-borrow.js");

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

describe("solana.lend.borrowVaults / .borrowPositions (reads)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveSelectedAddress.mockReturnValue(WALLET_ADDRESS);
  });

  it("borrowVaults defaults market to main and projects the vault list", async () => {
    mockGetVaults.mockResolvedValue([VAULT]);
    const result = await LEND_BORROW_HANDLERS["solana.lend.borrowVaults"]!({}, ctx());
    expect(mockGetVaults).toHaveBeenCalledWith("main");
    expect(result.success).toBe(true);
    const [projected] = (result.data as unknown as unknown[]);
    expect((projected as Record<string, unknown>).maxLtvPercent).toBe("80.0%");
  });

  it("borrowVaults rejects an unknown market", async () => {
    const result = await LEND_BORROW_HANDLERS["solana.lend.borrowVaults"]!({ market: "bogus" }, ctx());
    expect(result.success).toBe(false);
    expect(mockGetVaults).not.toHaveBeenCalled();
  });

  it("borrowPositions resolves the wallet and projects positions", async () => {
    mockGetPositions.mockResolvedValue([
      { id: 42, vaultId: 1, ownerAddress: WALLET_ADDRESS, supply: "30000000", borrow: "5000000", dustBorrow: "1" },
    ]);
    const result = await LEND_BORROW_HANDLERS["solana.lend.borrowPositions"]!({}, ctx());
    expect(mockGetPositions).toHaveBeenCalledWith(WALLET_ADDRESS, "main");
    expect(result.success).toBe(true);
  });
});

describe("solana.lend.borrowOperate — staged Solana seam (B1)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveSigningWallet.mockReturnValue({ family: "solana", address: WALLET_ADDRESS, secretKey: SIGNER.secretKey });
    mockResolveSelectedAddress.mockReturnValue(WALLET_ADDRESS);
    mockGetVaults.mockResolvedValue([VAULT]);
    mockRequestOperate.mockResolvedValue({ nftId: 9062, transaction: "unsigned-operate-tx-b64" });
    mockPrepareVersionedTx.mockResolvedValue(PREPARED);
    mockSubmitOverRpc.mockResolvedValue({ kind: "accepted", signature: PREPARED.signature });
    mockMarkBroadcastAccepted.mockResolvedValue({ applied: true, row: {} });
    mockCreateAgentActivityIntent.mockResolvedValue({ executionId: 42, events: [{ id: 7 }] });
    mockCreateAgentActivityPreBroadcastFailure.mockResolvedValue({ executionId: 43, event: { id: 8 } });
    mockMarkActivitySolanaBroadcast.mockResolvedValue({ applied: true, row: {} });
    mockFailActivityEvent.mockResolvedValue({ applied: true, row: {} });
  });

  it("deposit-only (create position): fetches the vault, records intent with tokenIn=supplyToken.address, signs/persists/submits, surfaces nftId", async () => {
    const result = await LEND_BORROW_HANDLERS["solana.lend.borrowOperate"]!(
      { vaultId: 1, depositAmount: "30000000" },
      ctx(),
    );

    // Non-WSOL vault (mSOL/USDC) — the funding pre-check must be a no-op.
    expect(mockGetAccount).not.toHaveBeenCalled();

    expect(mockGetVaults).toHaveBeenCalledWith("main");
    expect(mockRequestOperate).toHaveBeenCalledWith(
      { vaultId: 1, positionId: 0, signer: WALLET_ADDRESS, colAmount: "30000000", debtAmount: "0" },
      "main",
    );
    expect(mockCreateAgentActivityIntent).toHaveBeenCalledTimes(1);
    const intentArg = mockCreateAgentActivityIntent.mock.calls[0][0];
    expect(intentArg.events[0]).toMatchObject({
      eventIndex: 0, eventRole: "lend_borrow_operate", kind: "lend", protocol: "jupiter",
      chainId: 20_011_000_000, chainFamily: "solana", walletAddress: WALLET_ADDRESS,
      sessionId: "session-1",
      // The vault descriptor already in hand labels the leg — symbol +
      // decimals + the exact-decimal human amount (30000000 @ 9 = 0.03 mSOL),
      // so the activity feed never shows a bare mint and a bare integer.
      tokenIn: {
        tokenAddress: SUPPLY_MINT, tokenSymbol: "mSOL", tokenDecimals: 9,
        amountHuman: "0.03", amountRaw: "30000000",
      },
    });
    expect(intentArg.events[0].tokenOut).toBeUndefined();

    // w5-design.md §1: intent_params carries a STRICT, VERSIONED, normalized
    // "effects" record of the delta shape (not the raw agent params).
    expect(intentArg.intentParams).toEqual({
      effectsVersion: 1,
      vaultId: 1,
      positionId: 0,
      market: "main",
      effects: [{ leg: "collateral", direction: "in", amountRaw: "30000000", closeAll: false }],
    });

    expect(mockPrepareVersionedTx).toHaveBeenCalledWith("unsigned-operate-tx-b64", expect.any(Keypair));
    expect(mockMarkActivitySolanaBroadcast).toHaveBeenCalledWith(7, {
      txHash: PREPARED.signature, fromAddress: WALLET_ADDRESS,
      recentBlockhash: PREPARED.recentBlockhash, lastValidBlockHeight: PREPARED.lastValidBlockHeight,
    });
    // TIPLESS provider blob -> RPC lane, never Jupiter's tip-gated /submit.
    expect(mockSubmitOverRpc).toHaveBeenCalledWith(PREPARED);
    expect(mockSubmitPreparedTx).not.toHaveBeenCalled();
    expect(mockMarkBroadcastAccepted).toHaveBeenCalledTimes(1);
    expect(mockMarkBroadcastAccepted).toHaveBeenCalledWith(7);

    expect(result.success).toBe(false);
    expect(result.output).toMatch(/pending/i);
    const data = result.data as Record<string, unknown>;
    expect(data._executionId).toBe(42);
    expect(data.positionId).toBe(9062);
    expect(data.vaultId).toBe(1);
  });

  it("deposit + borrow (documented combo): tokenIn=supply leg AND tokenOut=debt leg on the SAME row", async () => {
    await LEND_BORROW_HANDLERS["solana.lend.borrowOperate"]!(
      { vaultId: 1, depositAmount: "30000000", borrowAmount: "5000000" },
      ctx(),
    );

    expect(mockRequestOperate).toHaveBeenCalledWith(
      { vaultId: 1, positionId: 0, signer: WALLET_ADDRESS, colAmount: "30000000", debtAmount: "5000000" },
      "main",
    );
    const intentArg = mockCreateAgentActivityIntent.mock.calls[0][0];
    expect(intentArg.events[0].tokenIn).toEqual({
      tokenAddress: SUPPLY_MINT, tokenSymbol: "mSOL", tokenDecimals: 9,
      amountHuman: "0.03", amountRaw: "30000000",
    });
    expect(intentArg.events[0].tokenOut).toEqual({
      tokenAddress: BORROW_MINT, tokenSymbol: "USDC", tokenDecimals: 6,
      amountHuman: "5", amountRaw: "5000000",
    });
  });

  it("withdrawAll: tokenOut has no amountRaw (magnitude is provider-computed, unknown to us in advance)", async () => {
    await LEND_BORROW_HANDLERS["solana.lend.borrowOperate"]!(
      { vaultId: 1, positionId: 5, withdrawAll: true },
      ctx(),
    );

    expect(mockRequestOperate).toHaveBeenCalledWith(
      expect.objectContaining({ colAmount: "-170141183460469231731687303715884105728" }),
      "main",
    );
    // No magnitude means no human amount either — but the leg is still
    // LABELLED, so the feed shows which token is leaving the position.
    const intentArg = mockCreateAgentActivityIntent.mock.calls[0][0];
    expect(intentArg.events[0].tokenOut).toEqual({
      tokenAddress: SUPPLY_MINT, tokenSymbol: "mSOL", tokenDecimals: 9,
    });
    expect(intentArg.events[0].tokenOut.amountHuman).toBeUndefined();
    expect(intentArg.events[0].tokenOut.amountRaw).toBeUndefined();
  });

  it("an invalid param combination (both legs same direction) never calls the vault or provider", async () => {
    const result = await LEND_BORROW_HANDLERS["solana.lend.borrowOperate"]!(
      { vaultId: 1, positionId: 5, depositAmount: "1", repayAmount: "1" },
      ctx(),
    );
    expect(result.success).toBe(false);
    expect(mockGetVaults).not.toHaveBeenCalled();
    expect(mockRequestOperate).not.toHaveBeenCalled();
  });

  it("an unknown vaultId is a plain client-side failure — no activity row, no provider call", async () => {
    mockGetVaults.mockResolvedValue([VAULT]);
    const result = await LEND_BORROW_HANDLERS["solana.lend.borrowOperate"]!(
      { vaultId: 999, depositAmount: "1" },
      ctx(),
    );
    expect(result.success).toBe(false);
    expect(result.output).toMatch(/vault 999 not found/i);
    expect(mockRequestOperate).not.toHaveBeenCalled();
    expect(mockCreateAgentActivityIntent).not.toHaveBeenCalled();
    expect(mockCreateAgentActivityPreBroadcastFailure).not.toHaveBeenCalled();
  });

  it("a provider rejection of the unsigned-tx request is a PRE-broadcast failure — no intent row, no signing", async () => {
    mockRequestOperate.mockRejectedValue(new Error("insufficient collateral"));

    const result = await LEND_BORROW_HANDLERS["solana.lend.borrowOperate"]!(
      { vaultId: 1, depositAmount: "30000000" },
      ctx(),
    );

    expect(mockCreateAgentActivityPreBroadcastFailure).toHaveBeenCalledTimes(1);
    const failArg = mockCreateAgentActivityPreBroadcastFailure.mock.calls[0][0];
    expect(failArg.event).toMatchObject({ failureCode: "route_not_found", kind: "lend", chainFamily: "solana" });
    // The rejected call's audit trail carries the SAME normalized effects
    // shape a succeeded one would (w5-design.md §1).
    expect(failArg.intentParams).toEqual({
      effectsVersion: 1,
      vaultId: 1,
      positionId: 0,
      market: "main",
      effects: [{ leg: "collateral", direction: "in", amountRaw: "30000000", closeAll: false }],
    });
    expect(mockCreateAgentActivityIntent).not.toHaveBeenCalled();
    expect(mockPrepareVersionedTx).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.output).toContain("insufficient collateral");
    expect((result.data as Record<string, unknown>)._executionId).toBe(43);
  });

  it("a sole-signer refusal finalizes the EXISTING row via failActivityEvent — never a second intent", async () => {
    mockPrepareVersionedTx.mockRejectedValue(new Error("Refusing to sign: transaction requires 2 signers, expected exactly 1."));

    const result = await LEND_BORROW_HANDLERS["solana.lend.borrowOperate"]!(
      { vaultId: 1, depositAmount: "30000000" },
      ctx(),
    );

    expect(mockFailActivityEvent).toHaveBeenCalledWith(7, expect.objectContaining({ failureCode: "unknown" }));
    expect(mockCreateAgentActivityPreBroadcastFailure).not.toHaveBeenCalled();
    expect(mockMarkActivitySolanaBroadcast).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect((result.data as Record<string, unknown>)._executionId).toBe(42);
  });

  it("a staging CAS miss refuses to submit untracked", async () => {
    mockMarkActivitySolanaBroadcast.mockResolvedValue({ applied: false, row: {} });

    const result = await LEND_BORROW_HANDLERS["solana.lend.borrowOperate"]!(
      { vaultId: 1, depositAmount: "30000000" },
      ctx(),
    );

    expect(mockSubmitOverRpc).not.toHaveBeenCalled();
    expect(mockSubmitPreparedTx).not.toHaveBeenCalled();
    expect(result.output).toMatch(/do not retry blindly/i);
  });

  it("a submit signature mismatch stays truthful-pending — never terminalizes", async () => {
    mockSubmitOverRpc.mockResolvedValue({
      kind: "signature_mismatch", localSignature: PREPARED.signature, providerSignature: "OtherSig",
    });

    const result = await LEND_BORROW_HANDLERS["solana.lend.borrowOperate"]!(
      { vaultId: 1, depositAmount: "30000000" },
      ctx(),
    );

    expect(mockFailActivityEvent).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.output).toMatch(/pending/i);
  });

  it("fails closed without an active session — no vault fetch, no provider call, no recording", async () => {
    const result = await LEND_BORROW_HANDLERS["solana.lend.borrowOperate"]!(
      { vaultId: 1, depositAmount: "30000000" },
      ctx({ sessionId: undefined }),
    );

    expect(result.success).toBe(false);
    expect(mockGetVaults).not.toHaveBeenCalled();
    expect(mockCreateAgentActivityIntent).not.toHaveBeenCalled();
  });
});

describe("solana.lend.borrowOperate — native-SOL/WSOL pre-broadcast funding check (B3)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveSigningWallet.mockReturnValue({ family: "solana", address: WALLET_ADDRESS, secretKey: SIGNER.secretKey });
    mockResolveSelectedAddress.mockReturnValue(WALLET_ADDRESS);
    mockGetVaults.mockResolvedValue([WSOL_VAULT]);
    mockRequestOperate.mockResolvedValue({ nftId: 1, transaction: "unsigned-operate-tx-b64" });
    mockPrepareVersionedTx.mockResolvedValue(PREPARED);
    mockSubmitOverRpc.mockResolvedValue({ kind: "accepted", signature: PREPARED.signature });
    mockMarkBroadcastAccepted.mockResolvedValue({ applied: true, row: {} });
    mockCreateAgentActivityIntent.mockResolvedValue({ executionId: 42, events: [{ id: 7 }] });
    mockMarkActivitySolanaBroadcast.mockResolvedValue({ applied: true, row: {} });
  });

  it("proceeds when the wallet's WSOL account already holds enough wrapped SOL", async () => {
    mockGetAccount.mockResolvedValue({ amount: 50_000_000n });

    const result = await LEND_BORROW_HANDLERS["solana.lend.borrowOperate"]!(
      { vaultId: 2, depositAmount: "30000000" },
      ctx(),
    );

    expect(mockGetAccount).toHaveBeenCalled();
    expect(mockRequestOperate).toHaveBeenCalled();
    expect(result.output).toMatch(/pending/i);
  });

  it("fails CLEARLY, before any provider call, when the WSOL balance is insufficient — no activity row", async () => {
    mockGetAccount.mockResolvedValue({ amount: 1_000n });

    const result = await LEND_BORROW_HANDLERS["solana.lend.borrowOperate"]!(
      { vaultId: 2, depositAmount: "30000000" },
      ctx(),
    );

    expect(result.success).toBe(false);
    expect(result.output).toMatch(/wrapped sol/i);
    expect(result.output).toMatch(/30000000/);
    expect(mockRequestOperate).not.toHaveBeenCalled();
    expect(mockCreateAgentActivityIntent).not.toHaveBeenCalled();
    expect(mockCreateAgentActivityPreBroadcastFailure).not.toHaveBeenCalled();
  });

  it("fails CLEARLY when no WSOL token account exists at all (getAccount throws)", async () => {
    mockGetAccount.mockRejectedValue(new Error("TokenAccountNotFoundError"));

    const result = await LEND_BORROW_HANDLERS["solana.lend.borrowOperate"]!(
      { vaultId: 2, depositAmount: "30000000" },
      ctx(),
    );

    expect(result.success).toBe(false);
    expect(result.output).toMatch(/wrapped sol/i);
    expect(mockRequestOperate).not.toHaveBeenCalled();
  });

  it("does NOT check WSOL funding for an 'out' direction leg (withdraw/borrow) even on a WSOL vault", async () => {
    const result = await LEND_BORROW_HANDLERS["solana.lend.borrowOperate"]!(
      { vaultId: 2, positionId: 3, withdrawAll: true },
      ctx(),
    );

    expect(mockGetAccount).not.toHaveBeenCalled();
    expect(mockRequestOperate).toHaveBeenCalled();
    expect(result.output).toMatch(/pending/i);
  });
});
