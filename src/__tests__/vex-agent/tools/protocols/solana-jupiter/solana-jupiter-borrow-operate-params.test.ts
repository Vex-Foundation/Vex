import { describe, expect, it } from "vitest";
import {
  resolveBorrowOperateRequest,
  buildBorrowOperateIntentParams,
  BORROW_OPERATE_EFFECTS_VERSION,
} from "@vex-agent/tools/protocols/solana-jupiter/borrow-operate-params.js";
import { JUPITER_LEND_BORROW_CLOSE_ALL_SENTINEL } from "@tools/solana-ecosystem/jupiter/jupiter-lend/borrow-api/types.js";

describe("resolveBorrowOperateRequest", () => {
  it("resolves a deposit-only request (create + deposit): colAmount > 0, debtAmount = 0", () => {
    const result = resolveBorrowOperateRequest({ vaultId: 1, depositAmount: "30000000" });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.request).toMatchObject({
      vaultId: 1, positionId: 0, market: "main", colAmount: "30000000", debtAmount: "0",
    });
    expect(result.request.collateralLeg).toEqual({ direction: "in", amountRaw: "30000000", closeAll: false });
    expect(result.request.debtLeg).toBeNull();
  });

  it("resolves a borrow-only request: colAmount = 0, debtAmount > 0", () => {
    const result = resolveBorrowOperateRequest({ vaultId: 1, positionId: 5, borrowAmount: "5000000" });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.request.colAmount).toBe("0");
    expect(result.request.debtAmount).toBe("5000000");
    expect(result.request.debtLeg).toEqual({ direction: "out", amountRaw: "5000000", closeAll: false });
  });

  it("resolves a withdraw-only request: colAmount < 0 (negated)", () => {
    const result = resolveBorrowOperateRequest({ vaultId: 1, positionId: 5, withdrawAmount: "1000" });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.request.colAmount).toBe("-1000");
    expect(result.request.collateralLeg).toEqual({ direction: "out", amountRaw: "1000", closeAll: false });
  });

  it("resolves a repay-only request: debtAmount < 0 (negated)", () => {
    const result = resolveBorrowOperateRequest({ vaultId: 1, positionId: 5, repayAmount: "2000" });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.request.debtAmount).toBe("-2000");
    expect(result.request.debtLeg).toEqual({ direction: "in", amountRaw: "2000", closeAll: false });
  });

  it("resolves deposit + borrow in one call (the documented two-leg combo)", () => {
    const result = resolveBorrowOperateRequest({ vaultId: 1, depositAmount: "30000000", borrowAmount: "5000000" });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.request.colAmount).toBe("30000000");
    expect(result.request.debtAmount).toBe("5000000");
  });

  it("resolves withdrawAll to the MIN_I128 sentinel with direction out and no amountRaw", () => {
    const result = resolveBorrowOperateRequest({ vaultId: 1, positionId: 5, withdrawAll: true });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.request.colAmount).toBe(JUPITER_LEND_BORROW_CLOSE_ALL_SENTINEL);
    expect(result.request.collateralLeg).toEqual({ direction: "out", amountRaw: null, closeAll: true });
  });

  it("resolves repayAll to the MIN_I128 sentinel with direction in and no amountRaw", () => {
    const result = resolveBorrowOperateRequest({ vaultId: 1, positionId: 5, repayAll: true });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.request.debtAmount).toBe(JUPITER_LEND_BORROW_CLOSE_ALL_SENTINEL);
    expect(result.request.debtLeg).toEqual({ direction: "in", amountRaw: null, closeAll: true });
  });

  it("defaults market to main and positionId to 0 when omitted", () => {
    const result = resolveBorrowOperateRequest({ vaultId: 1, depositAmount: "1" });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.request.market).toBe("main");
    expect(result.request.positionId).toBe(0);
  });

  it("honors an explicit ethena market", () => {
    const result = resolveBorrowOperateRequest({ vaultId: 1, market: "ethena", depositAmount: "1" });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.request.market).toBe("ethena");
  });

  it("rejects a missing vaultId", () => {
    const result = resolveBorrowOperateRequest({ depositAmount: "1" });
    expect(result.ok).toBe(false);
  });

  it("rejects an unknown market (reject-not-clamp)", () => {
    const result = resolveBorrowOperateRequest({ vaultId: 1, market: "unknown", depositAmount: "1" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.result.output).toMatch(/Unknown market/);
  });

  it("rejects providing more than one of depositAmount/withdrawAmount/withdrawAll", () => {
    const result = resolveBorrowOperateRequest({ vaultId: 1, depositAmount: "1", withdrawAmount: "1" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.result.output).toMatch(/at most one of depositAmount, withdrawAmount, withdrawAll/);
  });

  it("rejects providing more than one of borrowAmount/repayAmount/repayAll", () => {
    const result = resolveBorrowOperateRequest({ vaultId: 1, borrowAmount: "1", repayAll: true });
    expect(result.ok).toBe(false);
  });

  it("rejects a non-positive-integer amount string", () => {
    expect(resolveBorrowOperateRequest({ vaultId: 1, depositAmount: "0" }).ok).toBe(false);
    expect(resolveBorrowOperateRequest({ vaultId: 1, depositAmount: "-5" }).ok).toBe(false);
    expect(resolveBorrowOperateRequest({ vaultId: 1, depositAmount: "abc" }).ok).toBe(false);
  });

  it("rejects a call with nothing to do", () => {
    const result = resolveBorrowOperateRequest({ vaultId: 1 });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.result.output).toMatch(/Nothing to do/);
  });

  it("REJECTS combining a collateral deposit with a debt repay (both 'in' — the ledger cannot record two incoming legs)", () => {
    const result = resolveBorrowOperateRequest({ vaultId: 1, positionId: 5, depositAmount: "1", repayAmount: "1" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.result.output).toMatch(/Cannot combine/);
  });

  it("REJECTS combining a collateral withdraw with a debt borrow (both 'out')", () => {
    const result = resolveBorrowOperateRequest({ vaultId: 1, positionId: 5, withdrawAmount: "1", borrowAmount: "1" });
    expect(result.ok).toBe(false);
  });
});

describe("buildBorrowOperateIntentParams", () => {
  it("builds a strict, versioned, normalized effects[] payload for a single leg", () => {
    const result = resolveBorrowOperateRequest({ vaultId: 1, depositAmount: "30000000" });
    if (!result.ok) throw new Error("unreachable");
    expect(buildBorrowOperateIntentParams(result.request)).toEqual({
      effectsVersion: BORROW_OPERATE_EFFECTS_VERSION,
      vaultId: 1,
      positionId: 0,
      market: "main",
      effects: [{ leg: "collateral", direction: "in", amountRaw: "30000000", closeAll: false }],
    });
  });

  it("includes BOTH legs for the deposit+borrow combo, in collateral-then-debt order", () => {
    const result = resolveBorrowOperateRequest({ vaultId: 1, depositAmount: "30000000", borrowAmount: "5000000" });
    if (!result.ok) throw new Error("unreachable");
    expect(buildBorrowOperateIntentParams(result.request).effects).toEqual([
      { leg: "collateral", direction: "in", amountRaw: "30000000", closeAll: false },
      { leg: "debt", direction: "out", amountRaw: "5000000", closeAll: false },
    ]);
  });

  it("records closeAll with a null amountRaw (magnitude is provider-computed)", () => {
    const result = resolveBorrowOperateRequest({ vaultId: 1, positionId: 5, withdrawAll: true });
    if (!result.ok) throw new Error("unreachable");
    expect(buildBorrowOperateIntentParams(result.request).effects).toEqual([
      { leg: "collateral", direction: "out", amountRaw: null, closeAll: true },
    ]);
  });

  it("an untouched leg contributes NO effect entry (never a zero-amount placeholder)", () => {
    const result = resolveBorrowOperateRequest({ vaultId: 1, borrowAmount: "5000000" });
    if (!result.ok) throw new Error("unreachable");
    expect(buildBorrowOperateIntentParams(result.request).effects).toHaveLength(1);
  });
});
