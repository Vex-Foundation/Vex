import { beforeEach, describe, expect, it, vi } from "vitest";

function callMock<T>(mock: unknown, args: unknown[]): T {
  return (mock as (...innerArgs: unknown[]) => T)(...args);
}

const mockTokens = vi.fn();
const mockPositions = vi.fn();
const mockEarnings = vi.fn();
const mockDepositTx = vi.fn();
const mockWithdrawTx = vi.fn();
const mockMintTx = vi.fn();
const mockRedeemTx = vi.fn();
const mockDepositIxs = vi.fn();
const mockWithdrawIxs = vi.fn();
const mockMintIxs = vi.fn();
const mockRedeemIxs = vi.fn();

vi.mock("@tools/solana-ecosystem/jupiter/jupiter-lend/earn-api/client.js", () => ({
  jupiterLendEarnTokens: (...args: unknown[]) => callMock(mockTokens, args),
  jupiterLendEarnPositions: (...args: unknown[]) => callMock(mockPositions, args),
  jupiterLendEarnEarnings: (...args: unknown[]) => callMock(mockEarnings, args),
  jupiterLendEarnDepositTransaction: (...args: unknown[]) => callMock(mockDepositTx, args),
  jupiterLendEarnWithdrawTransaction: (...args: unknown[]) => callMock(mockWithdrawTx, args),
  jupiterLendEarnMintTransaction: (...args: unknown[]) => callMock(mockMintTx, args),
  jupiterLendEarnRedeemTransaction: (...args: unknown[]) => callMock(mockRedeemTx, args),
  jupiterLendEarnDepositInstructions: (...args: unknown[]) => callMock(mockDepositIxs, args),
  jupiterLendEarnWithdrawInstructions: (...args: unknown[]) => callMock(mockWithdrawIxs, args),
  jupiterLendEarnMintInstructions: (...args: unknown[]) => callMock(mockMintIxs, args),
  jupiterLendEarnRedeemInstructions: (...args: unknown[]) => callMock(mockRedeemIxs, args),
}));

const mockSignAndSend = vi.fn();
vi.mock("@tools/solana-ecosystem/shared/solana-transaction.js", () => ({
  signAndSendVersionedTx: (...args: unknown[]) => callMock(mockSignAndSend, args),
}));

vi.mock("@config/store.js", () => ({
  loadConfig: () => ({
    solana: { explorerUrl: "https://explorer.solana.com", cluster: "mainnet-beta" },
  }),
}));

const {
  getJupiterLendEarnTokens,
  getJupiterLendEarnPositions,
  getJupiterLendEarnEarnings,
  requestJupiterLendEarnDepositInstructions,
  requestJupiterLendEarnMintInstructions,
  executeJupiterLendEarnMint,
  executeJupiterLendEarnRedeem,
} = await import("@tools/solana-ecosystem/jupiter/jupiter-lend/earn-api/service.js");

const { Keypair } = await import("@solana/web3.js");

const USER = Keypair.generate();
const USER_ADDRESS = USER.publicKey.toBase58();
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const WSOL = "So11111111111111111111111111111111111111112";

describe("jupiter lend earn api service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("passes through tokens and positions without reshaping the upstream payloads", async () => {
    const tokensPayload = [{ address: USDC, symbol: "jlUSDC", assetAddress: USDC }];
    const positionsPayload = [{ ownerAddress: USER_ADDRESS, shares: "123", underlyingAssets: "124", underlyingBalance: "1.0", allowance: "0", token: { address: USDC, symbol: "jlUSDC", assetAddress: USDC } }];

    mockTokens.mockResolvedValueOnce(tokensPayload);
    mockPositions.mockResolvedValueOnce(positionsPayload);

    const tokens = await getJupiterLendEarnTokens();
    const positions = await getJupiterLendEarnPositions(USER_ADDRESS);

    expect(tokens).toBe(tokensPayload);
    expect(positions).toBe(positionsPayload);
    expect(mockPositions).toHaveBeenCalledWith({ users: [USER_ADDRESS] });
  });

  it("normalizes single-object earnings responses while preserving raw", async () => {
    const earningsPayload = {
      address: USDC,
      ownerAddress: USER_ADDRESS,
      earnings: 42,
      slot: 123456,
    };
    mockEarnings.mockResolvedValueOnce(earningsPayload);

    const result = await getJupiterLendEarnEarnings(USER_ADDRESS, [USDC, WSOL]);

    expect(mockEarnings).toHaveBeenCalledWith({ user: USER_ADDRESS, positions: [USDC, WSOL] });
    expect(result.earnings).toEqual([earningsPayload]);
    expect(result.raw).toEqual(earningsPayload);
  });

  it("normalizes both single-instruction and instructions[] response shapes", async () => {
    const singleInstruction = { programId: "prog-1", accounts: [], data: "abc" };
    const instructionEnvelope = {
      instructions: [
        { programId: "prog-2", accounts: [], data: "def" },
        { programId: "prog-3", accounts: [], data: "ghi" },
      ],
    };

    mockDepositIxs.mockResolvedValueOnce(singleInstruction);
    mockMintIxs.mockResolvedValueOnce(instructionEnvelope);

    const deposit = await requestJupiterLendEarnDepositInstructions({
      asset: USDC,
      signer: USER_ADDRESS,
      amount: "1000000",
    });
    const mint = await requestJupiterLendEarnMintInstructions({
      asset: USDC,
      signer: USER_ADDRESS,
      shares: "1000000",
    });

    expect(deposit.instructions).toEqual([singleInstruction]);
    expect(deposit.raw).toEqual(singleInstruction);
    expect(mint.instructions).toEqual(instructionEnvelope.instructions);
    expect(mint.raw).toEqual(instructionEnvelope);
  });

  it("derives the signer correctly for the remaining transaction execution helpers (mint/redeem)", async () => {
    // Deposit/withdraw execution (executeJupiterLendEarnDeposit/Withdraw) was
    // deleted (B2, legacy cleanup): the K6 staged-seam conversion replaced them
    // with the request-only requestJupiterLendEarnDepositTransaction/
    // WithdrawTransaction + the K2 prepare/persist/submit pipeline in
    // handlers/lend.ts — covered there, not here. Mint/redeem still use this
    // monolithic sign-and-send path and keep full coverage.
    mockMintTx.mockResolvedValueOnce({ transaction: "mint-base64" });
    mockRedeemTx.mockResolvedValueOnce({ transaction: "redeem-base64" });
    mockSignAndSend
      .mockResolvedValueOnce("sig-mint")
      .mockResolvedValueOnce("sig-redeem");

    const mint = await executeJupiterLendEarnMint(USER.secretKey, USDC, "1000000");
    const redeem = await executeJupiterLendEarnRedeem(USER.secretKey, USDC, "500000");

    expect(mockMintTx).toHaveBeenCalledWith({
      asset: USDC,
      shares: "1000000",
      signer: USER_ADDRESS,
    });
    expect(mockRedeemTx).toHaveBeenCalledWith({
      asset: USDC,
      shares: "500000",
      signer: USER_ADDRESS,
    });

    expect(mockSignAndSend).toHaveBeenCalledTimes(2);
    expect(mockSignAndSend.mock.calls[0][0]).toBe("mint-base64");
    expect(mockSignAndSend.mock.calls[1][0]).toBe("redeem-base64");
    for (const call of mockSignAndSend.mock.calls) {
      expect(call[1][0].publicKey.toBase58()).toBe(USER_ADDRESS);
    }

    expect(mint.signature).toBe("sig-mint");
    expect(redeem.signature).toBe("sig-redeem");
    expect(redeem.raw.transaction).toBe("redeem-base64");
  });
});
