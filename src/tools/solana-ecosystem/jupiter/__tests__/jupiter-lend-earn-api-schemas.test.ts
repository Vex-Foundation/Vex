/**
 * codex-002 financial gates for the Jupiter Lend Earn response schemas.
 *
 * The /deposit, /withdraw, /mint, /redeem endpoints return a base64
 * transaction blob that `service.ts` signs directly, and the *-instructions
 * endpoints return Solana instructions that get assembled and signed locally.
 * The schemas must:
 *  - accept valid shapes incl. forward-compatible unknown fields (services
 *    forward the raw upstream response downstream),
 *  - firmly reject malformed financial fields (non-base64 / empty tx blob, a
 *    bad instruction pubkey, non-base64 instruction data),
 *  - and — unlike the swaps /order endpoint — have NO 200-level error escape,
 *    so an empty transaction is rejected (HTTP_RESPONSE_INVALID) rather than
 *    handed to the signer.
 */

import { describe, expect, it } from "vitest";
import {
  jupiterLendEarnEarningsResponseSchema,
  jupiterLendEarnInstructionResponseSchema,
  jupiterLendEarnPositionsResponseSchema,
  jupiterLendEarnTokensResponseSchema,
  jupiterLendEarnTransactionResponseSchema,
} from "../jupiter-lend/earn-api/schemas.js";

const PUBKEY = "So11111111111111111111111111111111111111112";
const B64 = "AQIDBA=="; // base64 of [1,2,3,4]

const instruction = {
  programId: PUBKEY,
  accounts: [{ pubkey: PUBKEY, isWritable: true, isSigner: false }],
  data: B64,
};

describe("jupiterLendEarnTransactionResponseSchema (financial: tx blob is signed)", () => {
  it("accepts a base64 transaction, including unknown forward-compat fields", () => {
    const r = jupiterLendEarnTransactionResponseSchema.safeParse({
      transaction: B64,
      someFutureField: { x: 1 },
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.transaction).toBe(B64);
  });

  it("rejects a missing transaction", () => {
    expect(jupiterLendEarnTransactionResponseSchema.safeParse({}).success).toBe(false);
  });

  it("rejects an empty transaction (no 200-level error escape on this endpoint)", () => {
    expect(
      jupiterLendEarnTransactionResponseSchema.safeParse({ transaction: "" }).success,
    ).toBe(false);
  });

  it("rejects a non-base64 transaction blob", () => {
    expect(
      jupiterLendEarnTransactionResponseSchema.safeParse({ transaction: "!!not b64!!" })
        .success,
    ).toBe(false);
  });

  it("rejects a base64 string of impossible length", () => {
    // length 1 is not a valid base64 encoding
    expect(
      jupiterLendEarnTransactionResponseSchema.safeParse({ transaction: "A" }).success,
    ).toBe(false);
  });
});

describe("jupiterLendEarnInstructionResponseSchema (financial: instructions are signed)", () => {
  it("accepts a bare single instruction, with unknown forward-compat fields", () => {
    const r = jupiterLendEarnInstructionResponseSchema.safeParse({
      ...instruction,
      someFutureField: 1,
    });
    expect(r.success).toBe(true);
  });

  it("accepts the { instructions: [...] } envelope shape", () => {
    expect(
      jupiterLendEarnInstructionResponseSchema.safeParse({
        instructions: [instruction],
        someFutureField: 1,
      }).success,
    ).toBe(true);
  });

  it("rejects an instruction with non-base64 data", () => {
    expect(
      jupiterLendEarnInstructionResponseSchema.safeParse({ ...instruction, data: "@@@" })
        .success,
    ).toBe(false);
  });

  it("rejects an instruction account with a bad pubkey", () => {
    expect(
      jupiterLendEarnInstructionResponseSchema.safeParse({
        ...instruction,
        accounts: [{ pubkey: "0", isWritable: true, isSigner: false }],
      }).success,
    ).toBe(false);
  });

  it("rejects an instruction with a bad programId pubkey", () => {
    expect(
      jupiterLendEarnInstructionResponseSchema.safeParse({ ...instruction, programId: "0" })
        .success,
    ).toBe(false);
  });

  it("rejects an envelope whose instruction carries non-base64 data", () => {
    expect(
      jupiterLendEarnInstructionResponseSchema.safeParse({
        instructions: [{ ...instruction, data: "@@@" }],
      }).success,
    ).toBe(false);
  });
});

describe("jupiterLendEarn read schemas (non-financial display)", () => {
  function validToken(): Record<string, unknown> {
    return {
      id: 1,
      address: PUBKEY,
      name: "USD Coin",
      symbol: "USDC",
      decimals: 6,
      assetAddress: PUBKEY,
      asset: {
        address: PUBKEY,
        chain_id: "solana",
        name: "USD Coin",
        symbol: "USDC",
        decimals: 6,
        logo_url: "https://example.com/usdc.png",
        price: "1.0",
        coingecko_id: "usd-coin",
      },
      totalAssets: "1000",
      totalSupply: "1000",
      convertToShares: "1",
      convertToAssets: "1",
      rewardsRate: "0.01",
      supplyRate: 0.02,
      totalRate: "0.03",
      rebalanceDifference: "0",
      liquiditySupplyData: {
        modeWithInterest: true,
        supply: "1000",
        withdrawalLimit: "100",
        lastUpdateTimestamp: "1700000000",
        expandPercent: "10",
        expandDuration: "60",
        baseWithdrawalLimit: "50",
        withdrawableUntilLimit: "50",
        withdrawable: "50",
      },
    };
  }

  it("accepts a tokens array with forward-compat fields", () => {
    expect(
      jupiterLendEarnTokensResponseSchema.safeParse([
        { ...validToken(), someFutureField: true },
      ]).success,
    ).toBe(true);
  });

  it("LIVE-GATE FIX 1 regression: accepts the live-renamed camelCase asset shape (chain_id/logo_url/coingecko_id absent)", () => {
    // Confirmed live 2026-07-24 against GET /earn/tokens: the provider
    // renamed asset.{chain_id,logo_url,coingecko_id} to
    // asset.{chainId,logoUrl,coingeckoId} — the old keys never appear.
    const token = {
      ...validToken(),
      asset: {
        address: PUBKEY,
        chainId: "solana",
        name: "Jupiter USD",
        symbol: "JupUSD",
        uiSymbol: "JupUSD",
        decimals: 6,
        logoUrl: "https://example.com/jupusd.png",
        price: "0.999995389363",
        coingeckoId: "jupusd",
        updatedAt: "2026-07-24T16:39:06.000+00:00",
      },
    };
    const r = jupiterLendEarnTokensResponseSchema.safeParse([token]);
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data[0]!.asset.chain_id).toBeUndefined();
      expect(r.data[0]!.asset.price).toBe("0.999995389363");
    }
  });

  it("accepts a positions array", () => {
    expect(
      jupiterLendEarnPositionsResponseSchema.safeParse([
        {
          token: validToken(),
          ownerAddress: PUBKEY,
          shares: "100",
          underlyingAssets: "100",
          underlyingBalance: "100",
          allowance: "0",
        },
      ]).success,
    ).toBe(true);
  });

  it("accepts earnings as a single object and as an array (upstream inconsistency)", () => {
    const item = {
      address: PUBKEY,
      ownerAddress: PUBKEY,
      earnings: 12.5,
      slot: 123456,
    };
    expect(jupiterLendEarnEarningsResponseSchema.safeParse(item).success).toBe(true);
    expect(jupiterLendEarnEarningsResponseSchema.safeParse([item]).success).toBe(true);
  });

  it("LIVE-GATE FIX 2 regression: accepts the live-shaped numeric-STRING earnings value", () => {
    // Confirmed live 2026-07-24 against GET /earn/earnings: `earnings` is a
    // numeric string ("0") on every row, not a JSON number as the pre-fix
    // schema (z.number()) required — this is the actual root cause of the
    // `solana.lend.positions` `<root>: Invalid input` failure (the handler's
    // nested /earnings sub-call), not a drift on /earn/positions itself.
    const item = {
      address: PUBKEY,
      ownerAddress: PUBKEY,
      earnings: "0",
      slot: 0,
    };
    const r = jupiterLendEarnEarningsResponseSchema.safeParse([item]);
    expect(r.success).toBe(true);
    if (r.success) {
      const [parsed] = r.data as Extract<typeof r.data, unknown[]>;
      expect(parsed!.earnings).toBe("0");
    }
  });
});
