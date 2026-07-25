/**
 * `evaluateLendBorrowRiskPreview` — B1 pre-approval LTV/health disclosure,
 * hardened in card B3 (Codex batch-5 blocker): existing-position fetch/match
 * FAILURE must BLOCK (never assume zero collateral/debt), matched by owner +
 * vault + position identity (not `positionId` alone), and `dustBorrow` is
 * ADDITIONAL debt on top of `borrow`. The evaluator now returns a 3-way
 * `LendBorrowRiskPreviewOutcome` (`"not_applicable"` | `"confirmed"` |
 * `"unverifiable"`) instead of `LendBorrowRiskPreview | undefined`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProtocolExecutionContext } from "@vex-agent/tools/protocols/types.js";

const mockGetVaults = vi.fn();
const mockGetPositions = vi.fn();
vi.mock("@tools/solana-ecosystem/jupiter/jupiter-lend/borrow-api/service.js", () => ({
  getJupiterLendBorrowVaults: (...args: unknown[]) => mockGetVaults(...args),
  getJupiterLendBorrowPositions: (...args: unknown[]) => mockGetPositions(...args),
}));

const mockGetPricesByMint = vi.fn();
vi.mock("@tools/solana-ecosystem/jupiter/jupiter-prices/service.js", () => ({
  getJupiterPricesByMint: (...args: unknown[]) => mockGetPricesByMint(...args),
}));

const mockWalletAddress = vi.fn();
vi.mock("@vex-agent/tools/protocols/solana-jupiter/handlers/core.js", () => ({
  walletAddress: (...args: unknown[]) => mockWalletAddress(...args),
  walletSecret: vi.fn(),
}));

const { evaluateLendBorrowRiskPreview } = await import(
  "@vex-agent/tools/protocols/solana-jupiter/borrow-risk-preview.js"
);

const SOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const WALLET = "WalletAddr111";
const OTHER_WALLET = "SomeoneElseWallet222";

const VAULT = {
  id: 1,
  address: "VaultAddr1",
  supplyToken: { address: SOL, chainId: "solana", name: "Wrapped SOL", symbol: "WSOL", uiSymbol: "SOL", decimals: 9, price: "100" },
  borrowToken: { address: USDC, chainId: "solana", name: "USD Coin", symbol: "USDC", uiSymbol: "USDC", decimals: 6, price: "1" },
  collateralFactor: "800", liquidationThreshold: "850",
  borrowable: "1", withdrawable: "1", minimumBorrowing: "1",
};

function ctx(): ProtocolExecutionContext {
  return {
    sessionPermission: "restricted",
    approved: false,
    walletResolution: { source: "default" },
    walletPolicy: { kind: "none" },
    sessionId: "session-1",
  };
}

describe("evaluateLendBorrowRiskPreview", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWalletAddress.mockReturnValue(WALLET);
    mockGetVaults.mockResolvedValue([VAULT]);
  });

  it("computes a CONFIRMED projected-from-deltas preview for a NEW position with confirmed thresholds + an estimated LTV", async () => {
    mockGetPricesByMint.mockResolvedValue({
      [SOL]: { usdPrice: 100, decimals: 9, createdAt: "", liquidity: 0, blockId: null, priceChange24h: null },
      [USDC]: { usdPrice: 1, decimals: 6, createdAt: "", liquidity: 0, blockId: null, priceChange24h: null },
    });

    const outcome = await evaluateLendBorrowRiskPreview(
      { vaultId: 1, depositAmount: "1000000000" }, // 1 SOL
      ctx(),
    );

    expect(outcome.kind).toBe("confirmed");
    if (outcome.kind !== "confirmed") throw new Error("unreachable");
    expect(outcome.preview.maxLtvPercent).toBe("80.0%");
    expect(outcome.preview.liquidationThresholdPercent).toBe("85.0%");
    expect(outcome.preview.existingSupplyRaw).toBe("0");
    expect(outcome.preview.projectedSupplyRaw).toBe("1000000000");
    expect(outcome.preview.projectedBorrowRaw).toBe("0");
    expect(outcome.preview.estimatedLtvPercent).toBe("0.00%");
    expect(mockGetPositions).not.toHaveBeenCalled(); // positionId 0 — no existing position to read
  });

  // 2026-07-25 restoration: the preview showed raw amounts against bare mint
  // addresses, so the human approving could not tell 1047061 from 1.047061.
  // Both legs' symbol + decimals are mirrored from the same vault read.
  it("mirrors BOTH legs' symbol and decimals so the raw amounts in the disclosure are readable", async () => {
    mockGetPricesByMint.mockResolvedValue(null);

    const outcome = await evaluateLendBorrowRiskPreview({ vaultId: 1, depositAmount: "1000000000" }, ctx());

    expect(outcome.kind).toBe("confirmed");
    if (outcome.kind !== "confirmed") throw new Error("unreachable");
    expect(outcome.preview.supplyTokenSymbol).toBe("WSOL");
    expect(outcome.preview.supplyTokenDecimals).toBe(9);
    expect(outcome.preview.borrowTokenSymbol).toBe("USDC");
    expect(outcome.preview.borrowTokenDecimals).toBe(6);
    // Identity/decimals survive even when the price lookup degrades.
    expect(outcome.preview.estimatedLtvPercent).toBeNull();
  });

  it("reads the existing position when positionId > 0 and projects existing + delta, INCLUDING dustBorrow as additional debt", async () => {
    mockGetPositions.mockResolvedValue([
      { id: 5, vaultId: 1, ownerAddress: WALLET, supply: "1000000000", borrow: "50000000", dustBorrow: "1000000" },
    ]);
    mockGetPricesByMint.mockResolvedValue({
      [SOL]: { usdPrice: 100, decimals: 9, createdAt: "", liquidity: 0, blockId: null, priceChange24h: null },
      [USDC]: { usdPrice: 1, decimals: 6, createdAt: "", liquidity: 0, blockId: null, priceChange24h: null },
    });

    const outcome = await evaluateLendBorrowRiskPreview(
      { vaultId: 1, positionId: 5, borrowAmount: "20000000" },
      ctx(),
    );

    expect(outcome.kind).toBe("confirmed");
    if (outcome.kind !== "confirmed") throw new Error("unreachable");
    // existing debt = borrow (50M) + dustBorrow (1M) = 51M — dustBorrow is
    // ADDITIONAL debt, not already folded into `borrow` (B3 citation).
    expect(outcome.preview.existingSupplyRaw).toBe("1000000000");
    expect(outcome.preview.existingBorrowRaw).toBe("51000000");
    expect(outcome.preview.projectedSupplyRaw).toBe("1000000000");
    expect(outcome.preview.projectedBorrowRaw).toBe("71000000"); // 51M + 20M
    // collateral 1 SOL @ $100 = $100; debt 71 USDC @ $1 = $71 -> 71%
    expect(outcome.preview.estimatedLtvPercent).toBe("71.00%");
  });

  it("degrades to a null estimate (CONFIRMED, never blocked) when price data is unavailable — identity/balances/thresholds still show", async () => {
    mockGetPricesByMint.mockRejectedValue(new Error("network down"));

    const outcome = await evaluateLendBorrowRiskPreview({ vaultId: 1, depositAmount: "1" }, ctx());

    expect(outcome.kind).toBe("confirmed");
    if (outcome.kind !== "confirmed") throw new Error("unreachable");
    expect(outcome.preview.estimatedLtvPercent).toBeNull();
    expect(outcome.preview.riskNote).toMatch(/unavailable/i);
    // Confirmed vault thresholds + identity are STILL shown even when the estimate fails.
    expect(outcome.preview.maxLtvPercent).toBe("80.0%");
    expect(outcome.preview.vaultId).toBe(1);
    expect(outcome.preview.projectedSupplyRaw).toBe("1");
  });

  // ── B4 headline fixes ─────────────────────────────────────────────────

  it("degrades to a null estimate (CONFIRMED, never blocked) when the Price API's decimals disagree with the vault's OWN token decimals", async () => {
    // Vault says supplyToken (SOL) has 9 decimals; the Price API disagrees (6) — a
    // real bug/stale-cache signal, not something safe to silently compute an LTV under.
    mockGetPricesByMint.mockResolvedValue({
      [SOL]: { usdPrice: 100, decimals: 6, createdAt: "", liquidity: 0, blockId: null, priceChange24h: null },
      [USDC]: { usdPrice: 1, decimals: 6, createdAt: "", liquidity: 0, blockId: null, priceChange24h: null },
    });

    const outcome = await evaluateLendBorrowRiskPreview({ vaultId: 1, depositAmount: "1000000000" }, ctx());

    expect(outcome.kind).toBe("confirmed");
    if (outcome.kind !== "confirmed") throw new Error("unreachable");
    expect(outcome.preview.estimatedLtvPercent).toBeNull();
    expect(outcome.preview.riskNote).toMatch(/decimals/i);
    // Identity/balances/thresholds still show even though the estimate degraded.
    expect(outcome.preview.maxLtvPercent).toBe("80.0%");
    expect(outcome.preview.projectedSupplyRaw).toBe("1000000000");
  });

  it("never claims the liquidation threshold is protocol-confirmed in the successful-estimate riskNote (would contradict the disclosure's own 'scale unconfirmed' label)", async () => {
    mockGetPricesByMint.mockResolvedValue({
      [SOL]: { usdPrice: 100, decimals: 9, createdAt: "", liquidity: 0, blockId: null, priceChange24h: null },
      [USDC]: { usdPrice: 1, decimals: 6, createdAt: "", liquidity: 0, blockId: null, priceChange24h: null },
    });

    const outcome = await evaluateLendBorrowRiskPreview({ vaultId: 1, depositAmount: "1000000000" }, ctx());

    expect(outcome.kind).toBe("confirmed");
    if (outcome.kind !== "confirmed") throw new Error("unreachable");
    expect(outcome.preview.estimatedLtvPercent).not.toBeNull();
    expect(outcome.preview.riskNote.toLowerCase()).not.toContain("protocol-confirmed");
  });

  it("returns not_applicable (no preview, no block) when the params do not resolve — the handler's own validation surfaces the error", async () => {
    const outcome = await evaluateLendBorrowRiskPreview({ vaultId: 1 }, ctx()); // nothing to do
    expect(outcome).toEqual({ kind: "not_applicable" });
    expect(mockGetVaults).not.toHaveBeenCalled();
  });

  it("returns UNVERIFIABLE (never a fabricated preview) when the vault cannot be found", async () => {
    mockGetVaults.mockResolvedValue([]);
    const outcome = await evaluateLendBorrowRiskPreview({ vaultId: 999, depositAmount: "1" }, ctx());
    expect(outcome.kind).toBe("unverifiable");
  });

  it("returns UNVERIFIABLE when the vault fetch itself throws", async () => {
    mockGetVaults.mockRejectedValue(new Error("rpc down"));
    const outcome = await evaluateLendBorrowRiskPreview({ vaultId: 1, depositAmount: "1" }, ctx());
    expect(outcome.kind).toBe("unverifiable");
  });

  it("returns UNVERIFIABLE when wallet resolution throws (session scope mismatch) — never surfaces a partial preview", async () => {
    mockWalletAddress.mockImplementation(() => { throw new Error("scope mismatch"); });
    const outcome = await evaluateLendBorrowRiskPreview({ vaultId: 1, depositAmount: "1" }, ctx());
    expect(outcome.kind).toBe("unverifiable");
  });

  // ── B3 headline fix: existing-position fetch/match failure MUST block ────

  it("returns UNVERIFIABLE (never assumes zero collateral/debt) when the existing-position fetch throws", async () => {
    mockGetPositions.mockRejectedValue(new Error("rpc timeout"));

    const outcome = await evaluateLendBorrowRiskPreview(
      { vaultId: 1, positionId: 5, borrowAmount: "20000000" },
      ctx(),
    );

    expect(outcome.kind).toBe("unverifiable");
    if (outcome.kind !== "unverifiable") throw new Error("unreachable");
    expect(outcome.reason).toMatch(/position #5/i);
  });

  it("returns UNVERIFIABLE when no position matches this positionId for this wallet (empty result)", async () => {
    mockGetPositions.mockResolvedValue([]);

    const outcome = await evaluateLendBorrowRiskPreview(
      { vaultId: 1, positionId: 5, borrowAmount: "1" },
      ctx(),
    );

    expect(outcome.kind).toBe("unverifiable");
  });

  it("returns UNVERIFIABLE when a position with this id exists but on a DIFFERENT vaultId (cross-vault mismatch, never matched by id alone)", async () => {
    mockGetPositions.mockResolvedValue([
      { id: 5, vaultId: 999, ownerAddress: WALLET, supply: "1", borrow: "1", dustBorrow: "0" },
    ]);

    const outcome = await evaluateLendBorrowRiskPreview(
      { vaultId: 1, positionId: 5, borrowAmount: "1" },
      ctx(),
    );

    expect(outcome.kind).toBe("unverifiable");
  });

  it("returns UNVERIFIABLE when a position with this id+vault exists but belongs to a DIFFERENT owner (cross-wallet mismatch)", async () => {
    mockGetPositions.mockResolvedValue([
      { id: 5, vaultId: 1, ownerAddress: OTHER_WALLET, supply: "999", borrow: "999", dustBorrow: "0" },
    ]);

    const outcome = await evaluateLendBorrowRiskPreview(
      { vaultId: 1, positionId: 5, borrowAmount: "1" },
      ctx(),
    );

    expect(outcome.kind).toBe("unverifiable");
  });
});
