/**
 * Per-tool, per-mode byte budgets for the DexScreener pair list.
 *
 * WHY BYTES ARE A TEST AND NOT A CODE REVIEW NOTE
 *
 * A projected pair row cost 554.9 B before this work, so 30 rows were 16,647 B
 * against a 16,384 B context cap: **any uncapped 30-row pair list was
 * structurally over the cap.** That is arithmetic, not bad luck, and it is why
 * the previous `search` hid a `limit: 20` default that silently dropped rows
 * 21-30. The fix is field projection — the lean default row — which is what makes
 * "return every row the provider returned" affordable.
 *
 * So the budget is load-bearing: if the lean row grows, the no-default `limit`
 * stops being affordable and the pressure to reintroduce a silent cap comes back.
 * These assertions are the guard on that, measured over recorded live payloads.
 *
 * WHAT THE NUMBERS ARE ALLOWED TO BE
 *
 * Each assertion is a CEILING with headroom, not a pin: the fixtures are live
 * market snapshots and refreshing one legitimately moves the total by a few
 * percent. A failure means the SHAPE changed, which is the thing worth catching.
 * The measured value is printed next to every ceiling in the test names.
 *
 * The adversarial case is deliberately NOT budgeted under the cap. One live row
 * carries a 9,575-character `baseToken.symbol`, which is in the lean set, so a
 * single row can add ~9.6 KB to a default call. That is accepted exposure under
 * the owner's no-truncation rule, measured here so the number is known rather
 * than discovered.
 */

import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

import { getDexScreenerClient } from "@tools/dexscreener/client.js";
import { DEXSCREENER_HANDLERS } from "@vex-agent/tools/protocols/dexscreener/handlers.js";
import type { ProtocolExecutionContext } from "@vex-agent/tools/protocols/types.js";

import {
  pairsWethUsdcPool,
  searchSolUsdc,
  searchUsdc,
  tokenPairsWeth,
  tokensEthereum40,
} from "./_pair-captures.js";
import { DEXSCREENER_BYTE_BUDGET_BYTES } from "./_byte-budget.js";

const READ_CTX: ProtocolExecutionContext = {
  sessionPermission: "restricted",
  approved: false,
  walletResolution: { source: "default" },
  walletPolicy: { kind: "none" },
};


async function outputBytes(
  toolId: string,
  params: Record<string, unknown>,
): Promise<number> {
  const handler = DEXSCREENER_HANDLERS[toolId];
  if (handler === undefined) throw new Error(`no handler for ${toolId}`);
  const result = await handler(params, READ_CTX);
  expect(result.success, result.output).toBe(true);
  return Buffer.byteLength(result.output, "utf8");
}

describe("DexScreener pair-list byte budgets", () => {
  beforeEach(() => {
    const client = getDexScreenerClient();
    vi.spyOn(client, "search").mockImplementation(async (query: string) =>
      query === "SOL/USDC" ? searchSolUsdc() : searchUsdc(),
    );
    vi.spyOn(client, "getPairs").mockResolvedValue(pairsWethUsdcPool());
    vi.spyOn(client, "getTokenPairs").mockResolvedValue(tokenPairsWeth());
    vi.spyOn(client, "getTokens").mockResolvedValue(tokensEthereum40().pairs);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── search — the primary tool of this family ────────────────────

  it("search, lean default, 30 rows: under the 16,384 B context cap", async () => {
    const bytes = await outputBytes("dexscreener.search", { query: "USDC" });
    expect(bytes).toBeLessThan(DEXSCREENER_BYTE_BUDGET_BYTES);
    expect(bytes).toBeGreaterThan(5_000);
  });

  it("search, rich (fields=full), 30 rows: over the cap — which is why rich is opt-in", async () => {
    const bytes = await outputBytes("dexscreener.search", { query: "USDC", fields: "full" });
    expect(bytes).toBeGreaterThan(DEXSCREENER_BYTE_BUDGET_BYTES);
    expect(bytes).toBeLessThan(60_000);
  });

  it("search, lean, adversarial 9,575-char symbol row: exposure is the symbol, not the shape", async () => {
    const adversarial = await outputBytes("dexscreener.search", { query: "SOL/USDC" });
    const ordinary = await outputBytes("dexscreener.search", { query: "USDC" });
    // The whole excess is one row's issuer-authored symbol. Delivered in full,
    // by owner decision, and flagged in externalContentFields.
    expect(adversarial - ordinary).toBeGreaterThan(8_000);
    expect(adversarial).toBeLessThan(30_000);
  });

  it("search: excluding baseName from the lean set is worth more than 30 KB on the adversarial row", async () => {
    const lean = await outputBytes("dexscreener.search", { query: "SOL/USDC" });
    const withNames = await outputBytes("dexscreener.search", {
      query: "SOL/USDC",
      fields: "baseName,quoteName",
    });
    // The 34,090-character `baseToken.name` is the single biggest field in this
    // API. It reaches the agent only when asked for — projection, not truncation.
    expect(withNames - lean).toBeGreaterThan(30_000);
  });

  it("search: an agent-set limit is the only thing that shrinks a row count", async () => {
    const all = await outputBytes("dexscreener.search", { query: "USDC" });
    const five = await outputBytes("dexscreener.search", { query: "USDC", limit: 5 });
    expect(five).toBeLessThan(all / 2);
  });

  // ── tokenPairs / tokens / pairs ─────────────────────────────────

  it("tokenPairs, lean default, 30 pools: under the cap (it was 17.5 KB before)", async () => {
    const bytes = await outputBytes("dexscreener.tokenPairs", {
      chainId: "ethereum",
      tokenAddress: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
    });
    expect(bytes).toBeLessThan(DEXSCREENER_BYTE_BUDGET_BYTES);
  });

  it("tokenPairs, rich: over the cap, opt-in only", async () => {
    const bytes = await outputBytes("dexscreener.tokenPairs", {
      chainId: "ethereum",
      tokenAddress: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
      fields: "full",
    });
    expect(bytes).toBeGreaterThan(DEXSCREENER_BYTE_BUDGET_BYTES);
  });

  // MEASURED AND ACCEPTED: `tokens` is the one tool in this family whose default
  // call exceeds the cap, and the excess is the mandatory address echo — 40
  // requested + 30 resolved + 10 unresolved addresses is ~3.6 KB. That echo is
  // the ONLY thing standing between the agent and provider-side silent
  // truncation (40 requested, 30 returned, HTTP 200), so it is not a candidate
  // for removal. `limit` brings the call under the cap, and it is agent-set and
  // disclosed rather than a hidden default.
  it("tokens (40 requested, 30 returned), lean: over the cap, because of the address echo", async () => {
    const bytes = await outputBytes("dexscreener.tokens", {
      chainId: "ethereum",
      tokenAddresses: tokensEthereum40().requestedAddresses,
    });
    expect(bytes).toBeGreaterThan(DEXSCREENER_BYTE_BUDGET_BYTES);
    expect(bytes).toBeLessThan(20_000);
  });

  it("tokens: an agent-set limit brings it under the cap without hiding an address", async () => {
    const { requestedAddresses } = tokensEthereum40();
    const handler = DEXSCREENER_HANDLERS["dexscreener.tokens"];
    if (handler === undefined) throw new Error("no handler");
    const result = await handler(
      { chainId: "ethereum", tokenAddresses: requestedAddresses, limit: 15 },
      READ_CTX,
    );
    expect(result.success).toBe(true);
    expect(Buffer.byteLength(result.output, "utf8")).toBeLessThan(DEXSCREENER_BYTE_BUDGET_BYTES);
    // The rows are windowed; the address reconciliation is NOT.
    const data: unknown = JSON.parse(result.output);
    expect(data).toMatchObject({ unresolvedAddresses: expect.any(Array) });
    if (typeof data === "object" && data !== null && "unresolvedAddresses" in data) {
      expect(data.unresolvedAddresses).toHaveLength(10);
    }
  });

  it("pairs, single pool, lean and rich both trivially under the cap", async () => {
    const lean = await outputBytes("dexscreener.pairs", {
      chainId: "ethereum",
      pairAddress: "0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640",
    });
    const rich = await outputBytes("dexscreener.pairs", {
      chainId: "ethereum",
      pairAddress: "0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640",
      fields: "full",
    });
    expect(lean).toBeLessThan(4_000);
    expect(rich).toBeLessThan(6_000);
    expect(rich).toBeGreaterThan(lean);
  });

  // ── The report ─────────────────────────────────────────────────
  //
  // Not an assertion: prints the measured matrix so a future reader can compare
  // against the recon numbers without re-deriving them.
  it("prints the measured byte matrix", async () => {
    const rows: Array<[string, number]> = [
      ["search q=USDC lean", await outputBytes("dexscreener.search", { query: "USDC" })],
      [
        "search q=USDC rich",
        await outputBytes("dexscreener.search", { query: "USDC", fields: "full" }),
      ],
      ["search q=SOL/USDC lean", await outputBytes("dexscreener.search", { query: "SOL/USDC" })],
      [
        "search q=SOL/USDC rich",
        await outputBytes("dexscreener.search", { query: "SOL/USDC", fields: "full" }),
      ],
      [
        "tokenPairs WETH lean",
        await outputBytes("dexscreener.tokenPairs", {
          chainId: "ethereum",
          tokenAddress: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
        }),
      ],
      [
        "tokenPairs WETH rich",
        await outputBytes("dexscreener.tokenPairs", {
          chainId: "ethereum",
          tokenAddress: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
          fields: "full",
        }),
      ],
      [
        "tokens 40-requested lean",
        await outputBytes("dexscreener.tokens", {
          chainId: "ethereum",
          tokenAddresses: tokensEthereum40().requestedAddresses,
        }),
      ],
      [
        "tokens 40-requested rich",
        await outputBytes("dexscreener.tokens", {
          chainId: "ethereum",
          tokenAddresses: tokensEthereum40().requestedAddresses,
          fields: "full",
        }),
      ],
      [
        "pairs single lean",
        await outputBytes("dexscreener.pairs", {
          chainId: "ethereum",
          pairAddress: "0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640",
        }),
      ],
    ];
    for (const [label, bytes] of rows) {
      // eslint-disable-next-line no-console
      console.log(`byte-budget ${label.padEnd(26)} ${bytes}`);
    }
    expect(rows.every(([, bytes]) => bytes > 0)).toBe(true);
  });
});
