/**
 * Fixture-boundary tests for `jupiter-lend/borrow-api/` (Batch 5 card B4 —
 * closes a Codex batch-5 blocker: a wire-shape regression must never hide
 * behind hand-built test objects). Parses EVERY recorded live fixture in
 * `./fixtures/lend-borrow/` (see that directory's README for full
 * provenance) through the REAL exported zod response schemas — mirrors
 * `jupiter-prediction-fixture-boundaries.test.ts`'s pattern exactly.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  jupiterLendBorrowOperateResponseSchema,
  jupiterLendBorrowPositionsResponseSchema,
  jupiterLendBorrowVaultsResponseSchema,
} from "@tools/solana-ecosystem/jupiter/jupiter-lend/borrow-api/schemas.js";
import type {
  JupiterLendBorrowOperateResponse,
  JupiterLendBorrowPositionsResponse,
  JupiterLendBorrowVaultsResponse,
} from "@tools/solana-ecosystem/jupiter/jupiter-lend/borrow-api/types.js";

function loadFixture(name: string): unknown {
  const path = resolve(import.meta.dirname, "fixtures", "lend-borrow", name);
  return JSON.parse(readFileSync(path, "utf8"));
}

describe("lend-borrow fixture boundaries — GET /borrow/vaults (main market)", () => {
  const raw = loadFixture("vaults-main.json");
  const parsed: JupiterLendBorrowVaultsResponse = jupiterLendBorrowVaultsResponseSchema.parse(raw);

  it("parses both recorded vaults without throwing", () => {
    expect(parsed).toHaveLength(2);
  });

  it("pins the nested supplyToken/borrowToken shape + digit-string factors (B3/B4 wire contract)", () => {
    const vault1 = parsed.find((v) => v.id === 1);
    expect(vault1).toBeDefined();
    expect(vault1!.supplyToken.address).toBe("So11111111111111111111111111111111111111112");
    expect(vault1!.supplyToken.decimals).toBe(9);
    expect(vault1!.borrowToken.address).toBe("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
    expect(vault1!.borrowToken.decimals).toBe(6);
    expect(vault1!.collateralFactor).toBe("800");
    expect(vault1!.liquidationThreshold).toBe("850");
    expect(typeof vault1!.collateralFactor).toBe("string");
  });

  it("pins a SECOND collateralFactor/liquidationThreshold pair (vault 40 — a wider gap, proving no fixed offset)", () => {
    const vault40 = parsed.find((v) => v.id === 40);
    expect(vault40).toBeDefined();
    expect(vault40!.collateralFactor).toBe("500");
    expect(vault40!.liquidationThreshold).toBe("700");
  });
});

describe("lend-borrow fixture boundaries — GET /borrow/vaults (ethena market)", () => {
  const raw = loadFixture("vaults-ethena.json");
  const parsed: JupiterLendBorrowVaultsResponse = jupiterLendBorrowVaultsResponseSchema.parse(raw);

  it("parses the market-scoped vault id (a DIFFERENT vault 5 exists per market)", () => {
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.id).toBe(5);
    expect(parsed[0]!.collateralFactor).toBe("920");
    expect(parsed[0]!.liquidationThreshold).toBe("940");
  });
});

describe("lend-borrow fixture boundaries — GET /borrow/positions (empty wallet)", () => {
  const raw = loadFixture("positions-empty.json");
  const parsed: JupiterLendBorrowPositionsResponse = jupiterLendBorrowPositionsResponseSchema.parse(raw);

  it("parses the empty-array shape for a wallet with no Borrow positions", () => {
    expect(parsed).toEqual([]);
  });
});

describe("lend-borrow fixture boundaries — POST /borrow/operate (doc example response)", () => {
  const fixture = loadFixture("operate-doc-example.json") as { response: unknown };
  const parsed: JupiterLendBorrowOperateResponse = jupiterLendBorrowOperateResponseSchema.parse(fixture.response);

  it("parses nftId as a non-negative integer and transaction as base64", () => {
    expect(parsed.nftId).toBe(9062);
    expect(typeof parsed.transaction).toBe("string");
    expect(parsed.transaction.length).toBeGreaterThan(0);
  });
});
