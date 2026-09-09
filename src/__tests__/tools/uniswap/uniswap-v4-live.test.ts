/** Explicitly gated real provider verification. Execute is coordinator-only. */
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { executeProtocolTool } from "@vex-agent/tools/protocols/runtime.js";
import type { ProtocolExecutionContext } from "@vex-agent/tools/protocols/types.js";
import { v4RouteBindingSchema } from "@tools/uniswap/v4-types.js";
import { getUniswapDeployment } from "@tools/uniswap/deployments.js";
import { getUniswapPublicClient } from "@tools/uniswap/evm-client.js";
import { bindV4Pool } from "@tools/uniswap/v4-pool.js";
import { quoteBoundV4Pool } from "@tools/uniswap/v4-quote.js";
import { zeroAddress, type Hex } from "viem";
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
const cases = [
  { chain: "4663", tokenOut: "0x008Df4b3E857D06c4603Aeb11F267ccD32ce2005", amountIn: "0.0001" },
  { chain: "8453", tokenOut: "0xC9750053FE947E0961eab0f3E29325F0311DCb07", amountIn: "0.0001" },
];
const addedChains = [
  { chain: "42161", symbol: "ETH", tokenOut: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", poolId: "0x864abca0a6202dba5b8868772308da953ff125b0f95015adbf89aaf579e903a8" },
  { chain: "10", symbol: "ETH", tokenOut: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85", poolId: "0x51bf4cc5b8d9f7f759e41f572fe2a25bc2aeb42432bf12544a350595e5c8bb43" },
  { chain: "137", symbol: "POL", tokenOut: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", poolId: "0x37f372fc7c59fb54a7797addeb6c03670537eacd62d4bed81dfffa61876cd775" },
  { chain: "56", symbol: "BNB", tokenOut: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d", poolId: "0x963f416c93cc57e6a5711a22ac976c4990165d3f99b8fa3ee26c4ef7b53ed752" },
] as const;
const nativeQuoteSchema = z.object({ chainId: z.number(), tokenIn: z.object({ symbol: z.string(), isNative: z.literal(true), decimals: z.literal(18) }), route: z.object({ version: z.enum(["v2", "v3", "v4"]) }), amountOutRaw: z.string(), swapAmountRaw: z.string(), v4Discovery: z.object({ indexed: z.number(), matching: z.number(), considered: z.number(), refused: z.number() }) });
const quoteSchema = z.object({ chainId: z.number(), route: v4RouteBindingSchema.extend({ version: z.literal("v4"), path: z.array(z.string()), description: z.string(), quoteWarning: z.string() }).passthrough(), amountOutRaw: z.string(), minAmountOutRaw: z.string(), gasEstimate: z.string(), eligibility: z.object({ balanceChecked: z.boolean() }) });

d("Uniswap v4 live quotes through the real protocol runtime", () => {
  for (const c of cases) it(`binds and quotes chain ${c.chain}`, { timeout: 120000 }, async () => {
    const params = { ...c, tokenIn: "ETH", slippageBps: 100 };
    const result = await executeProtocolTool({ toolId: "uniswap.swap.quote", params }, context);
    expect(result.success, result.output).toBe(true);
    const quote = quoteSchema.parse(JSON.parse(result.output));
    expect(v4PoolId(quote.route.poolKey)).toBe(quote.route.poolId);
    expect(BigInt(quote.amountOutRaw)).toBeGreaterThan(0n);
    expect(BigInt(quote.minAmountOutRaw)).toBeGreaterThan(0n);
    expect(quote.eligibility.balanceChecked).toBe(false);
    process.stdout.write(JSON.stringify({ event: "uniswap.v4.live_quote", chainId: quote.chainId, poolId: quote.route.poolId, poolKey: quote.route.poolKey, amountIn: c.amountIn, amountOutRaw: quote.amountOutRaw, minAmountOutRaw: quote.minAmountOutRaw, gasEstimate: quote.gasEstimate }) + "\n");
  });
});

d("Uniswap native/USDC on the four added v4 chains", () => {
  for (const c of addedChains) it(`quotes ${c.symbol}/USDC on chain ${c.chain} and checks the supplied sample`, { timeout: 120000 }, async () => {
    const result = await executeProtocolTool({ toolId: "uniswap.swap.quote", params: { chain: c.chain, tokenIn: "native", tokenOut: c.tokenOut, amountIn: "0.0001", slippageBps: 100 } }, context);
    expect(result.success, result.output).toBe(true);
    const handlerQuote = nativeQuoteSchema.parse(JSON.parse(result.output));
    expect(handlerQuote.tokenIn.symbol).toBe(c.symbol);
    expect(BigInt(handlerQuote.amountOutRaw)).toBeGreaterThan(0n);
    const deployment = required(getUniswapDeployment(Number(c.chain)));
    const client = getUniswapPublicClient(deployment);
    // This is deliberately a distinct probe. The live token-pairs response
    // omits these samples, so a direct quoter result must not be presented as
    // a sample discovered or selected by the production handler.
    const binding = await bindV4Pool(client, deployment, c.poolId as Hex, zeroAddress, c.tokenOut);
    const sample = await quoteBoundV4Pool(client, deployment, binding, BigInt(handlerQuote.swapAmountRaw));
    expect(v4PoolId(sample.v4.poolKey)).toBe(c.poolId);
    expect(sample.amountOut).toBeGreaterThan(0n);
    process.stdout.write(JSON.stringify({ event: "uniswap.v4.live_added_chain", chainId: Number(c.chain), nativeSymbol: c.symbol, handlerSelectedVersion: handlerQuote.route.version, handlerAmountOutRaw: handlerQuote.amountOutRaw, v4Discovery: handlerQuote.v4Discovery, sampleProbeSource: "owner_supplied_pool_id_direct_quoter", poolId: sample.v4.poolId, poolKey: sample.v4.poolKey, amountInRaw: handlerQuote.swapAmountRaw, sampleAmountOutRaw: sample.amountOut.toString(), gasEstimate: sample.gasEstimate?.toString() }) + "\n");
  });
});

dx("Uniswap v4 live execution with owner credentials", () => {
  afterAll(async () => { await closePool(); });
  for (const c of cases) it(`settles a tiny chain ${c.chain} swap once`, { timeout: 240000 }, async () => {
    // Inventory's loadEvmKey uses requireKeystorePassword, which reads this env.
    // Never capture, print, interpolate, persist or assert on the secret itself.
    if (!process.env.VEX_KEYSTORE_PASSWORD) throw new Error("VEX_KEYSTORE_PASSWORD is required for coordinator execution");
    await runMigrations();
    const sessionId = `uniswap-v4-live-${randomUUID()}`;
    await execute("INSERT INTO sessions (id, permission) VALUES ($1, 'restricted')", [sessionId]);
    const ctx: ProtocolExecutionContext = { ...context, sessionId, walletResolution: { source: "default" }, walletPolicy: { kind: "none" } };
    const params = { ...c, tokenIn: "ETH", slippageBps: 100 };
    const quoted = await executeProtocolTool({ toolId: "uniswap.swap.quote", params }, ctx);
    expect(quoted.success, quoted.output).toBe(true);
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
