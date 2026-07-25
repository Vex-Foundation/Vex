/**
 * Fixture-boundary tests for `jupiter-lend/earn-api/` — LIVE-GATE FIX 2
 * regression. Parses recorded live fixtures in `./fixtures/lend-earn/` (see
 * that directory's README for full provenance) through the REAL exported
 * zod response schemas — mirrors `jupiter-lend-borrow-fixture-boundaries.
 * test.ts` / `jupiter-prediction-fixture-boundaries.test.ts`'s pattern.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  jupiterLendEarnEarningsResponseSchema,
  jupiterLendEarnPositionsResponseSchema,
} from "@tools/solana-ecosystem/jupiter/jupiter-lend/earn-api/schemas.js";
import type {
  JupiterLendEarnEarningsResponse,
  JupiterLendEarnPositionsResponse,
} from "@tools/solana-ecosystem/jupiter/jupiter-lend/earn-api/types.js";

function loadFixture(name: string): unknown {
  const path = resolve(import.meta.dirname, "fixtures", "lend-earn", name);
  return JSON.parse(readFileSync(path, "utf8"));
}

describe("lend-earn fixture boundaries — GET /earn/positions (negative finding: root shape unaffected)", () => {
  const raw = loadFixture("positions.json");
  const parsed: JupiterLendEarnPositionsResponse = jupiterLendEarnPositionsResponseSchema.parse(raw);

  it("parses all 7 recorded market rows for a never-funded wallet", () => {
    expect(parsed).toHaveLength(7);
    for (const position of parsed) expect(position.shares).toBe("0");
  });

  it("confirms the endpoint returns the full market catalog, not a holdings filter", () => {
    // Every row's underlying token differs — this is one row per KNOWN Earn
    // market, not a per-holding filter, which is why `posAddresses.length`
    // in handlers/lend.ts is never 0 in practice.
    const tokenAddresses = new Set(parsed.map((p) => p.token.address));
    expect(tokenAddresses.size).toBe(7);
  });
});

describe("lend-earn fixture boundaries — GET /earn/earnings — LIVE-GATE FIX 2 regression (root drift)", () => {
  const raw = loadFixture("earnings.json");
  const parsed: JupiterLendEarnEarningsResponse = jupiterLendEarnEarningsResponseSchema.parse(raw);

  it("parses a live earnings array where every `earnings` value is a numeric STRING, not a number", () => {
    expect(Array.isArray(parsed)).toBe(true);
    const items = parsed as Extract<JupiterLendEarnEarningsResponse, unknown[]>;
    expect(items).toHaveLength(7);
    for (const item of items) {
      expect(item.earnings).toBe("0");
      expect(typeof item.earnings).toBe("string");
    }
  });

  it("still accepts a number (the pre-drift shape, upstream may revert or vary)", () => {
    const r = jupiterLendEarnEarningsResponseSchema.safeParse([
      { address: "addr", ownerAddress: "owner", earnings: 12.5, slot: 1 },
    ]);
    expect(r.success).toBe(true);
  });
});
