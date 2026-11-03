/**
 * The portfolio HISTORY contract: the input reuses the read's own strict scope
 * union (so a malformed scope cannot widen to the inventory), and the answer is
 * bounded, strict and carries no address.
 */

import { describe, expect, it } from "vitest";

import {
  PORTFOLIO_HISTORY_MAX_POINTS,
  PORTFOLIO_HISTORY_RANGES,
  portfolioHistoryDtoSchema,
  portfolioHistoryInputSchema,
  portfolioHistoryPointDtoSchema,
  type PortfolioHistoryDto,
} from "../portfolio-history.js";

const SESSION = "00000000-0000-4000-8000-000000000003";
const PROJECT = "00000000-0000-4000-8000-000000000004";
const AT = "2026-11-01T10:00:00.000Z";

const POINT = {
  at: AT,
  totalUsd: 260,
  settledUsd: 70,
  inTransitUsd: 190,
  partial: false,
};

function dto(fields: Partial<PortfolioHistoryDto> = {}): PortfolioHistoryDto {
  return {
    scope: "global",
    range: "7d",
    walletCount: 2,
    groupCount: 1,
    sampled: false,
    points: [POINT],
    ...fields,
  };
}

describe("portfolio history input", () => {
  it.each(PORTFOLIO_HISTORY_RANGES)("accepts the %s range with every scope arm of the read", (range) => {
    for (const wallets of [
      { scope: "global" },
      { scope: "global", walletAddress: "0xAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaa" },
      { scope: "session", sessionId: SESSION },
      { scope: "project", projectId: PROJECT },
    ]) {
      expect(portfolioHistoryInputSchema.safeParse({ range, wallets }).success).toBe(true);
    }
  });

  it("rejects a range the snapshot history does not offer", () => {
    expect(
      portfolioHistoryInputSchema.safeParse({ range: "90d", wallets: { scope: "global" } }).success,
    ).toBe(false);
  });

  it("requires the wallets: no implicit scope", () => {
    expect(portfolioHistoryInputSchema.safeParse({ range: "7d" }).success).toBe(false);
  });

  it("refuses a malformed scope rather than widening it to the inventory", () => {
    for (const wallets of [
      { scope: "session" },
      { scope: "session", sessionId: "nope" },
      { scope: "global", sessionId: SESSION },
      { scope: "global", walletAddress: "" },
      { scope: "all" },
    ]) {
      expect(portfolioHistoryInputSchema.safeParse({ range: "7d", wallets }).success).toBe(false);
    }
  });

  it("rejects a stray key (strict)", () => {
    expect(
      portfolioHistoryInputSchema.safeParse({
        range: "7d",
        wallets: { scope: "global" },
        addresses: ["0xAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaa"],
      }).success,
    ).toBe(false);
  });
});

describe("portfolio history answer", () => {
  it("round-trips a populated answer unchanged", () => {
    const parsed = portfolioHistoryDtoSchema.parse(dto());
    expect(parsed).toEqual(dto());
  });

  it("accepts the empty answer (no wallet, no cycle)", () => {
    expect(
      portfolioHistoryDtoSchema.safeParse(
        dto({ walletCount: 0, groupCount: 0, points: [] }),
      ).success,
    ).toBe(true);
  });

  it("accepts exactly the bound and rejects one point more", () => {
    const at = (index: number) => new Date(Date.UTC(2026, 9, 1) + index * 60_000).toISOString();
    const points = (count: number) =>
      Array.from({ length: count }, (_, index) => ({ ...POINT, at: at(index) }));
    expect(
      portfolioHistoryDtoSchema.safeParse(
        dto({ points: points(PORTFOLIO_HISTORY_MAX_POINTS), groupCount: 9_000, sampled: true }),
      ).success,
    ).toBe(true);
    expect(
      portfolioHistoryDtoSchema.safeParse(
        dto({ points: points(PORTFOLIO_HISTORY_MAX_POINTS + 1), groupCount: 9_000, sampled: true }),
      ).success,
    ).toBe(false);
  });

  it("rejects an unknown key on the answer and on a point (strict: no address can ride along)", () => {
    expect(portfolioHistoryDtoSchema.safeParse({ ...dto(), addresses: [] }).success).toBe(false);
    expect(
      portfolioHistoryPointDtoSchema.safeParse({
        ...POINT,
        walletAddress: "0xAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaa",
      }).success,
    ).toBe(false);
  });

  it("rejects a negative in-transit figure, a time without an offset and a non-finite total", () => {
    expect(portfolioHistoryPointDtoSchema.safeParse({ ...POINT, inTransitUsd: -1 }).success).toBe(false);
    expect(portfolioHistoryPointDtoSchema.safeParse({ ...POINT, at: "2026-11-01 10:00" }).success).toBe(false);
    expect(
      portfolioHistoryPointDtoSchema.safeParse({ ...POINT, totalUsd: Number.POSITIVE_INFINITY }).success,
    ).toBe(false);
  });

  it("rejects a negative count and an unknown scope", () => {
    expect(portfolioHistoryDtoSchema.safeParse(dto({ groupCount: -1 })).success).toBe(false);
    expect(
      portfolioHistoryDtoSchema.safeParse({ ...dto(), scope: "wallet" }).success,
    ).toBe(false);
  });
});
