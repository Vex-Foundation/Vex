import { describe, it, expect, vi, beforeEach } from "vitest";

import { ctx } from "./_solana-jupiter-handlers-context.js";
import type {
  JupiterPriceResponse,
  JupiterResolvedPriceBatch,
} from "@tools/solana-ecosystem/jupiter/jupiter-prices/types.js";

// Mock the Jupiter prices service so `solana.prices` behavior tests never hit
// the network (mirrors the `vi.hoisted` + `vi.mock` pattern used by the
// tokens-domain handler tests). Explicit return-type annotations keep the
// empty-default literals (`{}` / `resolved: []`) from inferring `never`, which
// would reject the real-shaped payloads `mockResolvedValueOnce` supplies below.
const { getJupiterPricesByMint, getJupiterPricesForTokenQueries } = vi.hoisted(() => ({
  getJupiterPricesByMint: vi.fn(async (): Promise<JupiterPriceResponse> => ({})),
  getJupiterPricesForTokenQueries: vi.fn(
    async (): Promise<JupiterResolvedPriceBatch> => ({ resolved: [], raw: {} }),
  ),
}));

vi.mock("@tools/solana-ecosystem/jupiter/jupiter-prices/service.js", () => ({
  getJupiterPricesByMint,
  getJupiterPricesForTokenQueries,
}));

import { SOLANA_JUPITER_HANDLERS } from "../../../vex-agent/tools/protocols/solana-jupiter/handlers.js";

const SOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const BOGUS_MINT = "1111111111111111111111111111111111111111bogus";

const SOL_ENTRY = {
  createdAt: "2024-06-05T08:55:25.527Z",
  liquidity: 657188571.13,
  usdPrice: 75.87987987,
  blockId: 434761452,
  decimals: 9,
  priceChange24h: -3.11,
};

const USDC_ENTRY = {
  createdAt: "2024-06-05T08:55:25.527Z",
  liquidity: 360328906.82,
  usdPrice: 0.9998882197,
  blockId: 434761448,
  decimals: 6,
  priceChange24h: 0.0083,
};

const SOL_TOKEN = {
  chain: "solana" as const,
  address: SOL_MINT,
  symbol: "SOL",
  name: "Solana",
  decimals: 9,
};

const DEAD_TOKEN = {
  chain: "solana" as const,
  address: BOGUS_MINT,
  symbol: "SOMEDEADCOIN",
  name: "Some Dead Coin",
  decimals: 6,
};

// Prices-domain slice of the original combined solana-jupiter-handlers.test.ts,
// extended for the mints-or-queries param shape + explicit `missing`
// diagnostics (W1-H — silent-vanish fix, query/symbol wiring).
describe("solana-jupiter handlers — prices", () => {
  beforeEach(() => {
    getJupiterPricesByMint.mockReset();
    getJupiterPricesForTokenQueries.mockReset();
  });

  const prices = (p: Record<string, unknown>) =>
    SOLANA_JUPITER_HANDLERS["solana.prices"]!(p, ctx());

  it("fails without mints or queries", async () => {
    const result = await prices({ mints: "" });
    expect(result.success).toBe(false);
    expect(result.output).toContain("mints");
    expect(getJupiterPricesByMint).not.toHaveBeenCalled();
    expect(getJupiterPricesForTokenQueries).not.toHaveBeenCalled();
  });

  it("rejects when both mints and queries are provided", async () => {
    const result = await prices({ mints: SOL_MINT, queries: "SOL" });
    expect(result.success).toBe(false);
    expect(result.output).toContain("either");
    expect(getJupiterPricesByMint).not.toHaveBeenCalled();
    expect(getJupiterPricesForTokenQueries).not.toHaveBeenCalled();
  });

  // ── mints path ────────────────────────────────────────────────

  it("returns prices for mints with an empty missing list when all are priced", async () => {
    getJupiterPricesByMint.mockResolvedValueOnce({
      [SOL_MINT]: SOL_ENTRY,
      [USDC_MINT]: USDC_ENTRY,
    });

    const result = await prices({ mints: `${SOL_MINT},${USDC_MINT}` });

    expect(getJupiterPricesByMint).toHaveBeenCalledWith([SOL_MINT, USDC_MINT]);
    expect(result.success).toBe(true);
    expect(result.data).toEqual({
      prices: { [SOL_MINT]: SOL_ENTRY, [USDC_MINT]: USDC_ENTRY },
      missing: [],
    });
  });

  // Silent-vanish fix (W1-H core bug): Jupiter's `/price/v3` returns 200 with
  // the unresolvable id simply absent — confirmed live against
  // agents_dm/agentscan-phase3/fixtures/price-v3-bogus-mint.json (`{}`). The
  // handler must diff the request against the response and report exactly
  // which requested mints came back unpriced instead of dropping them silently.
  it("reports missing mints when the requested mint is silently dropped from the response", async () => {
    getJupiterPricesByMint.mockResolvedValueOnce({ [SOL_MINT]: SOL_ENTRY });

    const result = await prices({ mints: `${SOL_MINT},${BOGUS_MINT}` });

    expect(result.success).toBe(true);
    expect(result.data).toEqual({
      prices: { [SOL_MINT]: SOL_ENTRY },
      missing: [BOGUS_MINT],
    });
  });

  it("trims whitespace around comma-separated mints before calling the service", async () => {
    getJupiterPricesByMint.mockResolvedValueOnce({ [SOL_MINT]: SOL_ENTRY });

    await prices({ mints: ` ${SOL_MINT} , ${USDC_MINT} ` });

    expect(getJupiterPricesByMint).toHaveBeenCalledWith([SOL_MINT, USDC_MINT]);
  });

  // ── queries path (symbol/name lookup wiring) ─────────────────

  it("resolves queries via getJupiterPricesForTokenQueries and passes the parsed list through", async () => {
    getJupiterPricesForTokenQueries.mockResolvedValueOnce({
      resolved: [
        { query: "SOL", mint: SOL_MINT, token: SOL_TOKEN, price: SOL_ENTRY, found: true },
      ],
      raw: { [SOL_MINT]: SOL_ENTRY },
    });

    const result = await prices({ queries: "SOL" });

    expect(getJupiterPricesForTokenQueries).toHaveBeenCalledWith(["SOL"]);
    expect(result.success).toBe(true);
    expect(result.data).toEqual({
      resolved: [
        { query: "SOL", mint: SOL_MINT, token: SOL_TOKEN, price: SOL_ENTRY, found: true },
      ],
      raw: { [SOL_MINT]: SOL_ENTRY },
      missing: [],
    });
  });

  it("reports unresolved-price queries by name in the missing list (found: false stays explicit, never silent)", async () => {
    getJupiterPricesForTokenQueries.mockResolvedValueOnce({
      resolved: [
        { query: "SOL", mint: SOL_MINT, token: SOL_TOKEN, price: SOL_ENTRY, found: true },
        { query: "SOMEDEADCOIN", mint: BOGUS_MINT, token: DEAD_TOKEN, price: undefined, found: false },
      ],
      raw: { [SOL_MINT]: SOL_ENTRY },
    });

    const result = await prices({ queries: "SOL,SOMEDEADCOIN" });

    expect(getJupiterPricesForTokenQueries).toHaveBeenCalledWith(["SOL", "SOMEDEADCOIN"]);
    expect(result.success).toBe(true);
    const data = result.data as { missing: string[] };
    expect(data.missing).toEqual(["SOMEDEADCOIN"]);
  });

  it("propagates SOLANA_TOKEN_NOT_FOUND when a query cannot be resolved to any token", async () => {
    getJupiterPricesForTokenQueries.mockRejectedValueOnce(
      new Error("Token not found: DOES_NOT_EXIST"),
    );

    await expect(prices({ queries: "DOES_NOT_EXIST" })).rejects.toThrow("Token not found");
  });
});
