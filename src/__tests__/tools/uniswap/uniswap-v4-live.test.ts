/** Explicitly gated real provider verification. Execute is coordinator-only. */
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { executeProtocolTool } from "@vex-agent/tools/protocols/runtime.js";
import type { ProtocolExecutionContext } from "@vex-agent/tools/protocols/types.js";
import { v4RouteBindingSchema } from "@tools/uniswap/v4-types.js";
import * as v4Quotes from "@tools/uniswap/v4-quote.js";
import { v4PoolId } from "@tools/uniswap/v4-pool.js";
import { execute, query, closePool } from "@vex-agent/db/client.js";
import { runMigrations } from "@vex-agent/db/migrate.js";
import { approvedQuoteAuthorityFrom } from "@vex-agent/tools/protocols/quote-authority/approved-authority.js";
import { mapActivityToEvent } from "@vex-agent/agentscan/mapper.js";

const live = process.env.VEX_UNISWAP_V4_LIVE === "1";
const executeLive = live && process.env.VEX_UNISWAP_V4_LIVE_EXECUTE === "1";
const d = live ? describe : describe.skip;
const dx = executeLive ? describe : describe.skip;
const context: ProtocolExecutionContext = { sessionPermission: "restricted", approved: false, walletResolution: { source: "session", evm: null, solana: null }, walletPolicy: { kind: "none" } };
// Pinned honest cases: tokens whose only native-quoted liquidity is a v4 pool,
// so the handler's own ranking selects v4 and the strict schema below is never
// relaxed. Provenance (DexScreener token-pairs plus on-chain PoolKey binding)
// is recorded in `src/tools/uniswap/V4.md`. Base 2026-09-10: 1F916, twelve
// pools, all v4; WETH pool 0x24ecedb2...c7fccb, dynamic fee (lpFee 7000),
// DopplerHookInitializer hook with after-swap return delta, 539k USD liquidity.
// Chains 137 and 56 (recon 2026-09-10, `v4-chain-candidates.md`): DexScreener
// indexes no v4 native pools there, so every reachable v4 route is a canonical
// hookless key (fee 100, tick spacing 1); the handler selected v4 for these
// pairs on gross output and net of gas alike.
const cases = [
  { chain: "4663", tokenOut: "0x008Df4b3E857D06c4603Aeb11F267ccD32ce2005", amountIn: "0.0001" },
  { chain: "8453", tokenOut: "0x9E00FC92493451EBA1c63DD3880D68b622037bA3", amountIn: "0.0001" },
  { chain: "137", tokenOut: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619", amountIn: "1" },
  { chain: "56", tokenOut: "0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c", amountIn: "0.0005" },
];
// Wallet-ranked cases: native -> wstETH on Optimism and Arbitrum. Without a
// wallet the gross ranking picks V3 (measured 2026-09-10: 80238070295931 V3
// vs a lower v4 gross output on chain 10); with a wallet the net-of-gas
// ranking may prefer the 100-fee v4 pool (42646 vs 84146 gas). The execute
// stage records an honest non-v4 selection and stops; it never relaxes the
// v4 schema for a route that did execute.
const walletRankedCases = [
  { chain: "10", tokenOut: "0x1F32b1c2345538c0c6f582fCB022739c4A194Ebb", amountIn: "0.0001" },
  { chain: "42161", tokenOut: "0x5979D7b546E38E414F7E9822514be443A4800529", amountIn: "0.0001" },
];
const canonicalChains = [
  { chain: "1", symbol: "ETH", tokenOut: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", poolId: "0x21c67e77068de97969ba93d4aab21826d33ca12bb9f565d8496e8fda8a82ca27" },
  { chain: "42161", symbol: "ETH", tokenOut: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", poolId: "0x864abca0a6202dba5b8868772308da953ff125b0f95015adbf89aaf579e903a8" },
  { chain: "10", symbol: "ETH", tokenOut: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85", poolId: "0x51bf4cc5b8d9f7f759e41f572fe2a25bc2aeb42432bf12544a350595e5c8bb43" },
  { chain: "137", symbol: "POL", tokenOut: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", poolId: "0x37f372fc7c59fb54a7797addeb6c03670537eacd62d4bed81dfffa61876cd775" },
  { chain: "56", symbol: "BNB", tokenOut: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d", poolId: "0x963f416c93cc57e6a5711a22ac976c4990165d3f99b8fa3ee26c4ef7b53ed752" },
] as const;
const nativeQuoteSchema = z.object({ selectionBasis: z.string(), chainId: z.number(), tokenIn: z.object({ symbol: z.string(), isNative: z.literal(true), decimals: z.literal(18) }), route: z.object({ version: z.enum(["v2", "v3", "v4"]), poolId: z.string().optional() }), amountOutRaw: z.string(), swapAmountRaw: z.string(), v4Discovery: z.object({ indexed: z.number(), matching: z.number(), considered: z.number(), refused: z.number(), canonical: z.object({ probed: z.number(), initialized: z.number(), failed: z.number() }) }) });
const quoteSchema = z.object({ chainId: z.number(), route: v4RouteBindingSchema.extend({ version: z.literal("v4"), path: z.array(z.string()), description: z.string(), quoteWarning: z.string() }).passthrough(), amountOutRaw: z.string(), minAmountOutRaw: z.string(), gasEstimate: z.string(), eligibility: z.object({ balanceChecked: z.boolean() }) });

d("Uniswap v4 live quotes through the real protocol runtime", () => {
  for (const c of cases) it(`binds and quotes chain ${c.chain}`, { timeout: 120000 }, async () => {
    const params = { ...c, tokenIn: "native", slippageBps: 100 };
    const result = await executeProtocolTool({ toolId: "uniswap.swap.quote", params }, context);
    expect(result.success, result.output).toBe(true);
    const quote = quoteSchema.parse(JSON.parse(result.output));
    expect(v4PoolId(quote.route.poolKey)).toBe(quote.route.poolId);
    expect(BigInt(quote.amountOutRaw)).toBeGreaterThan(0n);
    expect(BigInt(quote.minAmountOutRaw)).toBeGreaterThan(0n);
    expect(quote.eligibility.balanceChecked).toBe(false);
    const selection = nativeQuoteSchema.parse(JSON.parse(result.output));
    process.stdout.write(JSON.stringify({ event: "uniswap.v4.live_quote", chainId: quote.chainId, poolId: quote.route.poolId, poolKey: quote.route.poolKey,
      handlerSelectedVersion: quote.route.version, selectionBasis: selection.selectionBasis, v4Discovery: selection.v4Discovery,
      amountIn: c.amountIn, amountOutRaw: quote.amountOutRaw, minAmountOutRaw: quote.minAmountOutRaw, gasEstimate: quote.gasEstimate }) + "\n");
  });
});

d("Uniswap canonical native/USDC discovery through the real handler", () => {
  for (const c of canonicalChains) it(`discovers and quotes ${c.symbol}/USDC on chain ${c.chain}`, { timeout: 120000 }, async () => {
    // Observe the real candidate return without replacing discovery or RPC data.
    const observation = vi.spyOn(v4Quotes, "quoteV4Candidates");
    const amountIn = c.chain === "137" ? "0.01" : "0.0001";
    try {
      const result = await executeProtocolTool({ toolId: "uniswap.swap.quote", params: { chain: c.chain, tokenIn: "native", tokenOut: c.tokenOut, amountIn, slippageBps: 100 } }, context);
      expect(result.success, result.output).toBe(true);
      const handlerQuote = nativeQuoteSchema.parse(JSON.parse(result.output));
      expect(handlerQuote.tokenIn.symbol).toBe(c.symbol);
      expect(BigInt(handlerQuote.amountOutRaw)).toBeGreaterThan(0n);
      expect(observation.mock.results).toHaveLength(1);
      const call = required(observation.mock.results[0]);
      if (call.type !== "return") throw new Error("The real v4 candidate discovery did not return");
      const candidates = await call.value;
      const sample = candidates.routes.find(route => route.version === "v4" && route.v4.poolId.toLowerCase() === c.poolId.toLowerCase());
      if (!sample || sample.version !== "v4") throw new Error(`The handler did not quote sample ${c.poolId}`);
      expect(v4PoolId(sample.v4.poolKey)).toBe(c.poolId);
      expect(sample.amountOut).toBeGreaterThan(0n);
      expect(handlerQuote.v4Discovery.canonical.initialized).toBeGreaterThan(0);
      if (handlerQuote.selectionBasis === "gross_output_gas_comparison_unavailable") {
        for (const candidate of candidates.routes) expect(BigInt(handlerQuote.amountOutRaw)).toBeGreaterThanOrEqual(candidate.amountOut);
      }
      process.stdout.write(JSON.stringify({ event: "uniswap.v4.live_canonical_chain", chainId: Number(c.chain), nativeSymbol: c.symbol,
        handlerSelectedVersion: handlerQuote.route.version, selectedPoolId: handlerQuote.route.poolId, selectionBasis: handlerQuote.selectionBasis,
        handlerAmountOutRaw: handlerQuote.amountOutRaw, v4Discovery: handlerQuote.v4Discovery, sampleProbeSource: "real_handler_candidate",
        poolId: sample.v4.poolId, poolKey: sample.v4.poolKey, amountInRaw: handlerQuote.swapAmountRaw,
        sampleAmountOutRaw: sample.amountOut.toString(), gasEstimate: sample.gasEstimate?.toString(),
        v4Candidates: candidates.routes.map(route => ({ poolId: route.version === "v4" ? route.v4.poolId : null,
          fee: route.version === "v4" ? route.v4.poolKey.fee : null, amountOutRaw: route.amountOut.toString(), gasEstimate: route.gasEstimate?.toString() })),
      }) + "\n");
    } finally { observation.mockRestore(); }
  });
});

dx("Uniswap v4 live execution with owner credentials", () => {
  afterAll(async () => { await closePool(); });
  for (const c of [...cases, ...walletRankedCases]) it(`settles a tiny chain ${c.chain} swap once`, { timeout: 240000 }, async () => {
    // Inventory's loadEvmKey uses requireKeystorePassword, which reads this env.
    // Never capture, print, interpolate, persist or assert on the secret itself.
    if (!process.env.VEX_KEYSTORE_PASSWORD) throw new Error("VEX_KEYSTORE_PASSWORD is required for coordinator execution");
    await runMigrations();
    const sessionId = `uniswap-v4-live-${randomUUID()}`;
    await execute("INSERT INTO sessions (id, permission) VALUES ($1, 'restricted')", [sessionId]);
    const ctx: ProtocolExecutionContext = { ...context, sessionId, walletResolution: { source: "default" }, walletPolicy: { kind: "none" } };
    const params = { ...c, tokenIn: "native", slippageBps: 100 };
    const quoted = await executeProtocolTool({ toolId: "uniswap.swap.quote", params }, ctx);
    expect(quoted.success, quoted.output).toBe(true);
    const selected = nativeQuoteSchema.parse(JSON.parse(quoted.output));
    if (selected.route.version !== "v4") {
      if (!walletRankedCases.some(w => w.chain === c.chain)) throw new Error(`chain ${c.chain}: the handler selected ${selected.route.version} for a deterministic v4 case`);
      process.stdout.write(JSON.stringify({ event: "uniswap.v4.live_wallet_ranked_non_v4", chainId: selected.chainId, handlerSelectedVersion: selected.route.version,
        selectionBasis: selected.selectionBasis, amountOutRaw: selected.amountOutRaw, liveExecutionVerified: false }) + "\n");
      return;
    }
    quoteSchema.parse(JSON.parse(quoted.output));
    const approval = await executeProtocolTool({ toolId: "uniswap.swap.execute", params }, ctx);
    expect(approval.pendingApproval, approval.output).toBe(true);
    if (!approval.prequote?.quoteBinding || !approval.prequoteAuthority) throw new Error("Live quote has no bound approval");
    const result = await executeProtocolTool({ toolId: "uniswap.swap.execute", params }, { ...ctx, approved: true,
      approvedQuoteAuthority: approvedQuoteAuthorityFrom(approval.prequote.quoteBinding), approvedPrequoteAuthority: approval.prequoteAuthority });
    expect(result.success, result.output).toBe(true);
    expect(result.data?.status, result.output).toBe("confirmed");
    const rows = await query<Record<string, unknown>>("SELECT * FROM agent_activity WHERE session_id = $1 AND event_role = 'swap'", [sessionId]);
    expect(rows).toHaveLength(1);
    const row = required(rows[0]);
    expect(row.status).toBe("confirmed");
    expect(BigInt(String(row.executed_amount_out_raw))).toBeGreaterThan(0n);
    const payload = z.object({ vexFee: z.object({ disclosure: z.object({ charged: z.boolean() }) }) }).parse(JSON.parse(result.output));
    const event = mapActivityToEvent(row, { status: "confirmed" });
    expect(event.protocol).toBe("uniswap");
    expect(event.route?.version).toBe("v4");
    const fees = await query<Record<string, unknown>>("SELECT status FROM agent_activity WHERE session_id = $1 AND event_role = 'swap_fee'", [sessionId]);
    expect(fees).toHaveLength(payload.vexFee.disclosure.charged ? 1 : 0);
    if (payload.vexFee.disclosure.charged) expect(fees).toEqual([expect.objectContaining({ status: "confirmed" })]);
    // Retain money-path activity and session evidence for coordinator review.
  });
});

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Required test fixture or result is missing");
  return value;
}
