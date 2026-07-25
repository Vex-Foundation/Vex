/**
 * Batch 5 card B4 financial gates for the Jupiter Lend BORROW response
 * schemas (Codex batch-5 blocker: every FINANCIALLY CONSUMED field must be
 * validated for real, not merely typed).
 *
 * - `supplyToken`/`borrowToken.address` and `position.ownerAddress` feed a
 *   wallet-identity match (`borrow-risk-preview.ts`), a price lookup, ATA
 *   derivation, and the WSOL pre-funding check — a bad address must never
 *   reach any of those as a plain, unvalidated string.
 * - `collateralFactor`/`liquidationThreshold`/`borrowable`/`withdrawable`/
 *   `minimumBorrowing`/`supply`/`borrow`/`dustBorrow` feed `BigInt()`
 *   arithmetic or percent-string math — a signed or decimal-point value must
 *   be rejected at the boundary, not thrown as an uncaught `SyntaxError` (or
 *   silently misread as risk) deep inside the evaluator.
 * - `id`/`vaultId`/`nftId` are non-negative integers (`nftId` becomes a
 *   subsequent `positionId` agent param).
 * - `decimals` is bounded to the valid SPL range.
 */

import { describe, expect, it } from "vitest";
import {
  jupiterLendBorrowOperateResponseSchema,
  jupiterLendBorrowPositionsResponseSchema,
  jupiterLendBorrowVaultsResponseSchema,
} from "../jupiter-lend/borrow-api/schemas.js";

const SOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const OWNER = "GkwFnmMDvn3HGMpJpWBg8tgJxr3NxNvg3AXxvXVPbRGJ";

function validToken(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    address: SOL,
    chainId: "solana",
    name: "Wrapped SOL",
    symbol: "WSOL",
    uiSymbol: "SOL",
    decimals: 9,
    price: "73.95",
    ...overrides,
  };
}

function validVault(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 1,
    address: "nMzVs8GiXMVUENEwkev7JZfDcCENmz18ScheeVRdnb1",
    supplyToken: validToken(),
    borrowToken: validToken({ address: USDC, symbol: "USDC", uiSymbol: "USDC", decimals: 6, price: "1" }),
    collateralFactor: "800",
    liquidationThreshold: "850",
    borrowable: "1000000",
    withdrawable: "1000000",
    minimumBorrowing: "1000",
    ...overrides,
  };
}

function validPosition(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 5,
    vaultId: 1,
    ownerAddress: OWNER,
    supply: "1000000",
    borrow: "500000",
    dustBorrow: "0",
    ...overrides,
  };
}

describe("jupiterLendBorrowVaultsResponseSchema (financial: feeds BigInt math + a price/ATA lookup)", () => {
  it("accepts a well-formed vault, incl. unknown forward-compat fields", () => {
    const r = jupiterLendBorrowVaultsResponseSchema.safeParse([{ ...validVault(), someFutureField: 1 }]);
    expect(r.success).toBe(true);
  });

  it("rejects a bad supplyToken.address (not a real base58 Solana address, 32-byte decode)", () => {
    const r = jupiterLendBorrowVaultsResponseSchema.safeParse([
      validVault({ supplyToken: validToken({ address: "not-a-solana-address" }) }),
    ]);
    expect(r.success).toBe(false);
  });

  it("rejects a NEGATIVE vault id", () => {
    const r = jupiterLendBorrowVaultsResponseSchema.safeParse([validVault({ id: -1 })]);
    expect(r.success).toBe(false);
  });

  it("rejects a SIGNED collateralFactor (must be an unsigned digit string)", () => {
    const r = jupiterLendBorrowVaultsResponseSchema.safeParse([validVault({ collateralFactor: "-800" })]);
    expect(r.success).toBe(false);
  });

  it("rejects a DECIMAL-POINT collateralFactor (must be an integer digit string)", () => {
    const r = jupiterLendBorrowVaultsResponseSchema.safeParse([validVault({ collateralFactor: "80.0" })]);
    expect(r.success).toBe(false);
  });

  it("rejects a signed/decimal-point liquidationThreshold the same way", () => {
    expect(jupiterLendBorrowVaultsResponseSchema.safeParse([validVault({ liquidationThreshold: "-850" })]).success).toBe(false);
    expect(jupiterLendBorrowVaultsResponseSchema.safeParse([validVault({ liquidationThreshold: "85.0" })]).success).toBe(false);
  });

  it("rejects an ABSURD decimals value (beyond the valid SPL range)", () => {
    const r = jupiterLendBorrowVaultsResponseSchema.safeParse([
      validVault({ supplyToken: validToken({ decimals: 255 }) }),
    ]);
    expect(r.success).toBe(false);
  });

  it("rejects a negative decimals value", () => {
    const r = jupiterLendBorrowVaultsResponseSchema.safeParse([
      validVault({ supplyToken: validToken({ decimals: -1 }) }),
    ]);
    expect(r.success).toBe(false);
  });
});

describe("jupiterLendBorrowPositionsResponseSchema (financial: ownerAddress feeds a wallet-identity match)", () => {
  it("accepts a well-formed position, incl. unknown forward-compat fields", () => {
    const r = jupiterLendBorrowPositionsResponseSchema.safeParse([{ ...validPosition(), someFutureField: 1 }]);
    expect(r.success).toBe(true);
  });

  it("rejects a bad ownerAddress (never silently compared as 'this wallet's position')", () => {
    const r = jupiterLendBorrowPositionsResponseSchema.safeParse([
      validPosition({ ownerAddress: "not-a-solana-address" }),
    ]);
    expect(r.success).toBe(false);
  });

  it("rejects a NEGATIVE position id", () => {
    const r = jupiterLendBorrowPositionsResponseSchema.safeParse([validPosition({ id: -5 })]);
    expect(r.success).toBe(false);
  });

  it("rejects a NEGATIVE vaultId", () => {
    const r = jupiterLendBorrowPositionsResponseSchema.safeParse([validPosition({ vaultId: -1 })]);
    expect(r.success).toBe(false);
  });

  it("rejects a SIGNED supply/borrow/dustBorrow amount", () => {
    expect(jupiterLendBorrowPositionsResponseSchema.safeParse([validPosition({ supply: "-1" })]).success).toBe(false);
    expect(jupiterLendBorrowPositionsResponseSchema.safeParse([validPosition({ borrow: "-1" })]).success).toBe(false);
    expect(jupiterLendBorrowPositionsResponseSchema.safeParse([validPosition({ dustBorrow: "-1" })]).success).toBe(false);
  });

  it("rejects a DECIMAL-POINT amount", () => {
    const r = jupiterLendBorrowPositionsResponseSchema.safeParse([validPosition({ supply: "1.5" })]);
    expect(r.success).toBe(false);
  });
});

describe("jupiterLendBorrowOperateResponseSchema (financial: transaction is signed; nftId becomes a positionId)", () => {
  it("accepts a well-formed operate response, incl. unknown forward-compat fields", () => {
    const r = jupiterLendBorrowOperateResponseSchema.safeParse({
      nftId: 9062, transaction: "dGVzdA==", someFutureField: 1,
    });
    expect(r.success).toBe(true);
  });

  it("rejects a NEGATIVE nftId", () => {
    const r = jupiterLendBorrowOperateResponseSchema.safeParse({ nftId: -1, transaction: "dGVzdA==" });
    expect(r.success).toBe(false);
  });

  it("rejects a non-base64 transaction blob", () => {
    const r = jupiterLendBorrowOperateResponseSchema.safeParse({ nftId: 1, transaction: "!!not b64!!" });
    expect(r.success).toBe(false);
  });
});
