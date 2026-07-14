/**
 * Hyperliquid atomic-open testnet matrix.
 *
 * This is a release-gate runner, not a development fixture. It deliberately
 * forces Hyperliquid testnet and accepts a throwaway key only from
 * VEX_HL_TESTNET_PK. It never resolves a Vex wallet, never reads the vault,
 * and records only redacted request/result summaries in its evidence file.
 *
 * Usage:
 *   VEX_HL_TESTNET_PK=0x... pnpm hyperliquid:testnet-matrix
 *   VEX_HL_TESTNET_PK=0x... VEX_HL_MATRIX_EVIDENCE_PATH=/tmp/hl-matrix.json \
 *     pnpm hyperliquid:testnet-matrix
 */

import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { Decimal } from "decimal.js";
import { privateKeyToAccount } from "viem/accounts";
import type { Address, Hex } from "viem";

import { HyperliquidExchangeClient, classifyOrderStatusRecovery, parseExchangeResponse } from "@tools/hyperliquid/exchange.js";
import { HyperliquidInfoClient } from "@tools/hyperliquid/info.js";
import { HyperliquidMetaCache } from "@tools/hyperliquid/meta-cache.js";
import { hyperliquidRuntimeNonceAllocator } from "@tools/hyperliquid/nonce.js";
import { HyperliquidSigner } from "@tools/hyperliquid/signer.js";
import type { DecimalString, HyperliquidExchangeResult, HyperliquidLimitOrder, HyperliquidOrder, HyperliquidTriggerOrder } from "@tools/hyperliquid/types.js";
import { canonicalDecimal, parseDecimalString } from "@tools/hyperliquid/validation.js";
import { buildPositionProtectionSnapshot } from "@vex-agent/tools/protocols/hyperliquid/protection-snapshot.js";
import { compensateRejectedStop, consolidateConfirmedOpen } from "@vex-agent/tools/protocols/hyperliquid/handlers.js";

const NETWORK = "testnet" as const;
const DEFAULT_COIN = "BTC";
const DEFAULT_EVIDENCE_PATH = ".claude/plan/hl-matrix-evidence.json";
const TARGET_NOTIONAL_USD = new Decimal("12");

type MatrixStatus = "PASS" | "FAIL";

interface MatrixCaseEvidence {
  readonly id: string;
  readonly status: MatrixStatus;
  readonly detail: string;
  readonly request?: Record<string, unknown>;
  readonly response?: Record<string, unknown>;
  readonly cleanup: "clean" | "failed";
}

interface MatrixEvidence {
  readonly schemaVersion: 1;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly network: "testnet";
  readonly walletAddress: Address;
  readonly coin: string;
  readonly cases: readonly MatrixCaseEvidence[];
}

interface MatrixConfig {
  readonly privateKey: Hex;
  readonly evidencePath: string;
  readonly coin: string;
}

interface MatrixContext {
  readonly address: Address;
  readonly coin: string;
  readonly asset: { readonly asset: number; readonly szDecimals: number; readonly maxLeverage: number };
  readonly info: HyperliquidInfoClient;
  readonly exchange: HyperliquidExchangeClient;
  readonly signer: HyperliquidSigner;
  readonly metadata: HyperliquidMetaCache;
}

interface MatrixTrace {
  request?: Record<string, unknown>;
  response?: Record<string, unknown>;
}

export function readMatrixConfig(env: Readonly<Record<string, string | undefined>> = process.env): MatrixConfig {
  const privateKey = env.VEX_HL_TESTNET_PK?.trim();
  if (privateKey === undefined || !/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
    throw new Error("VEX_HL_TESTNET_PK must be a 0x-prefixed 32-byte throwaway TESTNET private key.");
  }
  const coin = (env.VEX_HL_TESTNET_COIN ?? DEFAULT_COIN).trim();
  if (!/^[A-Za-z0-9._-]{1,32}$/.test(coin)) {
    throw new Error("VEX_HL_TESTNET_COIN must be a simple Hyperliquid Core market symbol.");
  }
  const configuredPath = env.VEX_HL_MATRIX_EVIDENCE_PATH?.trim();
  return {
    privateKey: privateKey as Hex,
    coin,
    evidencePath: resolve(process.cwd(), configuredPath === undefined || configuredPath === "" ? DEFAULT_EVIDENCE_PATH : configuredPath),
  };
}

async function createContext(config: MatrixConfig): Promise<MatrixContext> {
  const account = privateKeyToAccount(config.privateKey);
  const address = account.address;
  const info = new HyperliquidInfoClient({ network: NETWORK });
  const metadata = new HyperliquidMetaCache(info);
  const signer = new HyperliquidSigner({
    network: NETWORK,
    nonceAllocator: hyperliquidRuntimeNonceAllocator,
    // The closure is intentionally the only use of the throwaway env key.
    // It is never written to output, evidence, a log, or a Vex wallet store.
    resolveWallet: () => ({ address, privateKey: config.privateKey }),
  });
  const exchange = new HyperliquidExchangeClient({ signer, metaCache: metadata, network: NETWORK, infoClient: info });
  const asset = (await metadata.get()).perpsByCoin.get(config.coin);
  if (asset === undefined) throw new Error(`Hyperliquid testnet has no Core perp named "${config.coin}".`);
  return { address, coin: config.coin, asset, info, exchange, signer, metadata };
}

async function main(): Promise<void> {
  const config = readMatrixConfig();
  const context = await createContext(config);
  const startedAt = new Date().toISOString();
  const results: MatrixCaseEvidence[] = [];
  try {
    await assertCleanStart(context);
    results.push(await runCase("a.normalTpsl_both_accepted", context, caseBothAccepted));
    results.push(await runCase("b.entry_accepted_stop_rejected", context, caseRejectedChild));
    results.push(await runCase("c.invalid_tick_bundle_rejected", context, caseInvalidBundle));
    results.push(await runCase("d.timeout_cloid_recovery", context, caseTimeoutRecovery));
    results.push(await runCase("e.filled_open_consolidates", context, caseSynchronousConsolidation));
    results.push(await runCase("f.plain_open_opt_out_validation", context, casePlainOpenValidation));
  } finally {
    const evidence: MatrixEvidence = {
      schemaVersion: 1,
      startedAt,
      completedAt: new Date().toISOString(),
      network: NETWORK,
      walletAddress: context.address,
      coin: context.coin,
      cases: results,
    };
    await writeEvidence(config.evidencePath, evidence);
    printTable(results, config.evidencePath);
  }
  if (results.length !== 6 || results.some((result) => result.status === "FAIL")) process.exitCode = 1;
}

async function runCase(
  id: string,
  context: MatrixContext,
  run: (context: MatrixContext, trace: MatrixTrace) => Promise<Omit<MatrixCaseEvidence, "id" | "status" | "cleanup">>,
): Promise<MatrixCaseEvidence> {
  const trace: MatrixTrace = {};
  let evidence: Omit<MatrixCaseEvidence, "id" | "status" | "cleanup">;
  let status: MatrixStatus = "PASS";
  try {
    evidence = await run(context, trace);
  } catch (cause) {
    status = "FAIL";
    evidence = {
      detail: safeErrorMessage(cause),
      ...(trace.request === undefined ? {} : { request: trace.request }),
      ...(trace.response === undefined ? {} : { response: trace.response }),
    };
  }
  const cleanup = await cleanupCoin(context);
  if (cleanup !== "clean") {
    status = "FAIL";
    evidence = { ...evidence, detail: `${evidence.detail}; cleanup failed` };
  }
  return { id, status, cleanup, ...evidence };
}

async function caseBothAccepted(context: MatrixContext, trace: MatrixTrace): Promise<Omit<MatrixCaseEvidence, "id" | "status" | "cleanup">> {
  const orders = await farRestingBundle(context, "a");
  trace.request = orderRequestSummary("normalTpsl", [orders.entry, orders.stopLoss]);
  const result = await context.exchange.openWithStopLoss(orders);
  trace.response = exchangeResultSummary(result);
  requireOrderKinds(result, ["accepted_resting", "accepted_resting"], "normalTpsl bundle did not leave entry and stop resting");
  const visible = await orderRows(context);
  require(visible.some((order) => order.cloid === orders.entry.c), "resting entry was not visible in frontendOpenOrders");
  require(visible.some((order) => order.cloid === orders.stopLoss.c), "resting stop child was not visible in frontendOpenOrders");
  const cancellation = await context.exchange.cancelByCloid({ cancels: [{ asset: context.asset.asset, cloid: orders.entry.c! }, { asset: context.asset.asset, cloid: orders.stopLoss.c! }] });
  require(cancellation.kind === "orders", "accepted parent/child bundle could not be cancelled by CLOID");
  return {
    detail: "entry and reduce-only SL child were both accepted, visible, and cancelled",
    request: trace.request,
    response: trace.response,
  };
}

async function caseRejectedChild(context: MatrixContext, trace: MatrixTrace): Promise<Omit<MatrixCaseEvidence, "id" | "status" | "cleanup">> {
  const { entry, stopLoss } = await farRestingBundle(context, "b");
  // Deliberately wrong side for a long entry. Production validation stays
  // enabled; this exercises the venue's child rejection semantics and then
  // the production compensation classifier.
  const invalidChild: HyperliquidTriggerOrder = { ...stopLoss, b: entry.b };
  trace.request = orderRequestSummary("normalTpsl", [entry, invalidChild]);
  const result = await context.exchange.openWithStopLoss({ entry, stopLoss: invalidChild });
  trace.response = exchangeResultSummary(result);
  requireOrderKinds(result, ["accepted_resting", "rejected"], "venue did not return accepted entry plus rejected stop child");
  const compensation = await compensateRejectedStop(result, context.exchange, context.info, context.address, context.asset.asset, context.coin, stopLoss.p);
  require(!compensation.unprotected, "rejected-child compensation escalated to UNPROTECTED");
  require(compensation.steps.some((step) => /cancelled|consolidat/i.test(step)), "rejected-child compensation did not record a safe action");
  return {
    detail: "entry/child split response was classified and compensation completed without unprotected exposure",
    request: trace.request,
    response: { ...trace.response, compensation: compensation.steps, unprotected: compensation.unprotected },
  };
}

async function caseInvalidBundle(context: MatrixContext, trace: MatrixTrace): Promise<Omit<MatrixCaseEvidence, "id" | "status" | "cleanup">> {
  const cloids = [matrixCloid("c-entry"), matrixCloid("c-stop")];
  const maxPriceDecimals = Math.max(0, 6 - context.asset.szDecimals);
  const invalidTick = parseDecimalString(`1.${"0".repeat(maxPriceDecimals)}1`);
  const entry: HyperliquidLimitOrder = {
    a: context.asset.asset, b: true, p: invalidTick, s: parseDecimalString("1"), r: false,
    t: { limit: { tif: "Gtc" } }, c: cloids[0],
  };
  const stop: HyperliquidTriggerOrder = {
    a: context.asset.asset, b: false, p: invalidTick, s: parseDecimalString("1"), r: true,
    t: { trigger: { isMarket: true, triggerPx: invalidTick, tpsl: "sl" } }, c: cloids[1],
  };
  // This case intentionally uses the low-level signer rather than the client
  // preflight: production code rejects this locally. The release matrix also
  // needs evidence that HyperCore rejects an invalid atomic bundle cleanly.
  trace.request = orderRequestSummary("normalTpsl", [entry, stop]);
  const raw = await submitRawOrder(context.signer, [entry, stop], "normalTpsl");
  const result = parseExchangeResponse(raw, [entry, stop]);
  trace.response = exchangeResultSummary(result);
  require(result.kind === "batch_error" || (result.kind === "orders" && result.statuses.every((status) => status.kind === "rejected")), "invalid-tick bundle was not entirely rejected");
  const visible = await orderRows(context);
  require(!visible.some((order) => order.cloid === cloids[0] || order.cloid === cloids[1]), "invalid bundle left a resting order");
  return {
    detail: "venue rejected invalid-tick normalTpsl bundle with no resting order",
    request: trace.request,
    response: trace.response,
  };
}

async function caseTimeoutRecovery(context: MatrixContext, trace: MatrixTrace): Promise<Omit<MatrixCaseEvidence, "id" | "status" | "cleanup">> {
  const { entry } = await farRestingBundle(context, "d");
  const responseLostFetch: typeof fetch = async (input, init) => {
    const { signal: _signal, ...request } = init ?? {};
    await fetch(input, request);
    if (init?.signal?.aborted) throw new DOMException("response intentionally lost after submit", "AbortError");
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("response intentionally lost after submit", "AbortError")), { once: true });
    });
  };
  const timedOutSigner = new HyperliquidSigner({
    network: NETWORK,
    nonceAllocator: hyperliquidRuntimeNonceAllocator,
    timeoutMs: 1,
    fetchFn: responseLostFetch,
    resolveWallet: () => ({ address: context.address, privateKey: readMatrixConfig().privateKey }),
  });
  const timedOutExchange = new HyperliquidExchangeClient({ signer: timedOutSigner, metaCache: context.metadata, network: NETWORK, infoClient: context.info });
  trace.request = orderRequestSummary("na", [entry]);
  const first = await timedOutExchange.openPosition({ entry });
  trace.response = { first: exchangeResultSummary(first) };
  require(first.kind === "transport_timeout", "forced response-loss submission did not return transport_timeout");
  const recovery = await recoverByCloid(context, entry.c!);
  require(recovery === "confirmed" || recovery === "not_found", "orderStatus did not prove confirmed or not-found after response loss");
  const second = await context.exchange.openPosition({ entry });
  const visible = await orderRows(context);
  require(visible.filter((order) => order.cloid === entry.c).length === 1, "same CLOID submission did not leave exactly one far-from-mark resting order");
  return {
    detail: `forced response loss recovered as ${recovery}; repeat CLOID submit did not duplicate exposure`,
    request: trace.request,
    response: { ...trace.response, recovery, second: exchangeResultSummary(second) },
  };
}

async function caseSynchronousConsolidation(context: MatrixContext, trace: MatrixTrace): Promise<Omit<MatrixCaseEvidence, "id" | "status" | "cleanup">> {
  const mark = await markPrice(context);
  const entryPrice = perpPrice(new Decimal(mark).mul("1.05"), context.asset.szDecimals, Decimal.ROUND_UP);
  const stopPrice = perpPrice(new Decimal(mark).mul("0.5"), context.asset.szDecimals, Decimal.ROUND_DOWN);
  const size = sizeForNotional(entryPrice, context.asset.szDecimals);
  const entry: HyperliquidLimitOrder = {
    a: context.asset.asset, b: true, p: entryPrice, s: size, r: false,
    t: { limit: { tif: "Ioc" } }, c: matrixCloid("e-entry"),
  };
  const stop: HyperliquidTriggerOrder = {
    a: context.asset.asset, b: false, p: stopPrice, s: size, r: true,
    t: { trigger: { isMarket: true, triggerPx: stopPrice, tpsl: "sl" } }, c: matrixCloid("e-stop"),
  };
  trace.request = orderRequestSummary("normalTpsl", [entry, stop]);
  const result = await context.exchange.openWithStopLoss({ entry, stopLoss: stop });
  trace.response = { open: exchangeResultSummary(result) };
  require(result.kind === "orders" && (result.statuses[0]?.kind === "accepted_filled" || result.statuses[0]?.kind === "partially_filled"), "marketable IOC entry did not fill on testnet");
  const consolidation = await consolidateConfirmedOpen(result, context.exchange, context.info, context.address, context.asset.asset, context.coin, stopPrice);
  require(consolidation.state === "complete", "synchronous positionTpsl consolidation did not complete");
  const [state, orders] = await Promise.all([context.info.clearinghouseState(context.address), context.info.frontendOpenOrders(context.address)]);
  require(buildPositionProtectionSnapshot(state, orders, context.coin).state === "PROTECTED", "post-consolidation protection snapshot was not PROTECTED");
  const signedSize = positionSize(state, context.coin);
  require(!new Decimal(signedSize).isZero(), "filled entry was absent before reduce-only cleanup close");
  const close = await context.exchange.closePosition({
    asset: context.asset.asset,
    side: new Decimal(signedSize).gt(0) ? "sell" : "buy",
    size: canonicalDecimal(new Decimal(signedSize).abs()),
    markPrice: await markPrice(context),
    slippageBps: 5_000,
  });
  require(close.kind === "orders", "reduce-only cleanup close was not accepted");
  return {
    detail: "filled entry consolidated to one full-position stop, verified PROTECTED, then submitted a reduce-only cleanup close",
    request: trace.request,
    response: { ...trace.response, consolidation: consolidation.steps, close: exchangeResultSummary(close) },
  };
}

async function casePlainOpenValidation(context: MatrixContext, trace: MatrixTrace): Promise<Omit<MatrixCaseEvidence, "id" | "status" | "cleanup">> {
  const { entry } = await farRestingBundle(context, "f");
  trace.request = orderRequestSummary("na", [entry]);
  await context.exchange.preflightPerpOpen({ entry, leverage: 1 });
  trace.response = { mode: "validation_only", policyFixture: { requireStopLoss: false }, validated: true };
  return {
    detail: "validation-only fixture: requireStopLoss=false path preflights a plain entry without signing or posting a live order",
    request: trace.request,
    response: trace.response,
  };
}

async function farRestingBundle(context: MatrixContext, label: string): Promise<{ readonly entry: HyperliquidLimitOrder; readonly stopLoss: HyperliquidTriggerOrder }> {
  const mark = await markPrice(context);
  const entryPrice = perpPrice(new Decimal(mark).mul("0.4"), context.asset.szDecimals, Decimal.ROUND_DOWN);
  const stopPrice = perpPrice(new Decimal(entryPrice).mul("0.8"), context.asset.szDecimals, Decimal.ROUND_DOWN);
  const size = sizeForNotional(entryPrice, context.asset.szDecimals);
  return {
    entry: { a: context.asset.asset, b: true, p: entryPrice, s: size, r: false, t: { limit: { tif: "Gtc" } }, c: matrixCloid(`${label}-entry`) },
    stopLoss: { a: context.asset.asset, b: false, p: stopPrice, s: size, r: true, t: { trigger: { isMarket: true, triggerPx: stopPrice, tpsl: "sl" } }, c: matrixCloid(`${label}-stop`) },
  };
}

async function submitRawOrder(
  signer: HyperliquidSigner,
  orders: readonly HyperliquidOrder[],
  grouping: "normalTpsl",
): Promise<unknown> {
  const signed = await signer.signL1({ action: { type: "order", orders, grouping }, cloids: orders.flatMap((order) => order.c === undefined ? [] : [order.c]) });
  return signer.post(signed);
}

async function assertCleanStart(context: MatrixContext): Promise<void> {
  const [orders, state] = await Promise.all([orderRows(context), context.info.clearinghouseState(context.address)]);
  require(orders.filter((order) => order.coin === context.coin).length === 0, `Refusing to run: throwaway wallet already has ${context.coin} open orders.`);
  require(new Decimal(positionSize(state, context.coin)).isZero(), `Refusing to run: throwaway wallet already has a ${context.coin} position.`);
}

async function cleanupCoin(context: MatrixContext): Promise<"clean" | "failed"> {
  try {
    const initialState = await context.info.clearinghouseState(context.address);
    const signedSize = positionSize(initialState, context.coin);
    if (!new Decimal(signedSize).isZero()) {
      const result = await context.exchange.closePosition({
        asset: context.asset.asset,
        side: new Decimal(signedSize).gt(0) ? "sell" : "buy",
        size: canonicalDecimal(new Decimal(signedSize).abs()),
        markPrice: await markPrice(context),
        slippageBps: 5_000,
      });
      if (result.kind !== "orders") return "failed";
    }
    const orders = (await orderRows(context)).filter((order) => order.coin === context.coin && order.oid !== undefined);
    if (orders.length > 0) {
      const cancellation = await context.exchange.cancel({ cancels: orders.map((order) => ({ a: context.asset.asset, o: order.oid! })) });
      if (cancellation.kind !== "orders") return "failed";
    }
    const [remainingOrders, finalState] = await Promise.all([orderRows(context), context.info.clearinghouseState(context.address)]);
    return remainingOrders.filter((order) => order.coin === context.coin).length === 0 && new Decimal(positionSize(finalState, context.coin)).isZero()
      ? "clean"
      : "failed";
  } catch {
    return "failed";
  }
}

async function recoverByCloid(context: MatrixContext, cloid: `0x${string}`): Promise<"confirmed" | "not_found" | "unknown"> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const recovery = classifyOrderStatusRecovery(cloid, await context.info.orderStatus(context.address, cloid));
    if (recovery.kind !== "unknown") return recovery.kind;
    await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 250));
  }
  return "unknown";
}

async function markPrice(context: MatrixContext): Promise<DecimalString> {
  const mids = await context.info.allMids();
  const value = isRecord(mids) ? mids[context.coin] : undefined;
  if (typeof value !== "string") throw new Error(`allMids did not return a price for ${context.coin}.`);
  return canonicalDecimal(value);
}

function perpPrice(value: Decimal.Value, szDecimals: number, rounding: Decimal.Rounding): DecimalString {
  const constrained = new Decimal(value)
    .toSignificantDigits(5, rounding)
    .toDecimalPlaces(Math.max(0, 6 - szDecimals), rounding);
  if (constrained.lte(0)) throw new Error("Computed testnet price was non-positive.");
  return canonicalDecimal(constrained);
}

function sizeForNotional(price: DecimalString, szDecimals: number): DecimalString {
  const unit = new Decimal(10).pow(-szDecimals);
  let size = TARGET_NOTIONAL_USD.div(price).toDecimalPlaces(szDecimals, Decimal.ROUND_UP);
  if (size.mul(price).lt(10)) size = size.add(unit);
  return canonicalDecimal(size);
}

function matrixCloid(label: string): `0x${string}` {
  const entropy = randomBytes(12).toString("hex");
  const tag = Buffer.from(label).toString("hex").slice(0, 8).padEnd(8, "0");
  return `0x${tag}${entropy}`;
}

function requireOrderKinds(result: HyperliquidExchangeResult, expected: readonly string[], message: string): void {
  require(result.kind === "orders", message);
  if (result.kind !== "orders") return;
  require(result.statuses.map((status) => status.kind).join(",") === expected.join(","), message);
}

function exchangeResultSummary(result: HyperliquidExchangeResult): Record<string, unknown> {
  if (result.kind === "orders") {
    return {
      kind: result.kind,
      statuses: result.statuses.map((status) => ({
        kind: status.kind,
        ...("oid" in status && status.oid !== undefined ? { oid: status.oid } : {}),
        ...(status.cloid === undefined ? {} : { cloid: status.cloid }),
      })),
    };
  }
  if (result.kind === "batch_error") return { kind: result.kind, message: result.message };
  return { kind: result.kind, cloids: result.cloids, recovery: result.recovery };
}

function orderRequestSummary(grouping: string, orders: readonly HyperliquidOrder[]): Record<string, unknown> {
  return {
    grouping,
    orders: orders.map((order) => ({ asset: order.a, buy: order.b, price: order.p, ...(order.s === undefined ? {} : { size: order.s }), reduceOnly: order.r, cloid: order.c })),
  };
}

interface FrontendOrderRow { readonly coin: string; readonly oid?: number; readonly cloid?: `0x${string}` }

async function orderRows(context: MatrixContext): Promise<readonly FrontendOrderRow[]> {
  const raw = await context.info.frontendOpenOrders(context.address);
  if (!Array.isArray(raw)) throw new Error("frontendOpenOrders returned a non-array response.");
  return raw.flatMap((value): FrontendOrderRow[] => {
    if (!isRecord(value) || typeof value.coin !== "string") return [];
    return [{ coin: value.coin, ...(typeof value.oid === "number" ? { oid: value.oid } : {}), ...(isCloid(value.cloid) ? { cloid: value.cloid } : {}) }];
  });
}

function positionSize(raw: unknown, coin: string): DecimalString {
  if (!isRecord(raw) || !Array.isArray(raw.assetPositions)) return parseDecimalString("0");
  for (const item of raw.assetPositions) {
    if (!isRecord(item) || !isRecord(item.position) || item.position.coin !== coin || typeof item.position.szi !== "string") continue;
    return canonicalDecimal(item.position.szi);
  }
  return parseDecimalString("0");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCloid(value: unknown): value is `0x${string}` {
  return typeof value === "string" && /^0x[0-9a-f]{32}$/i.test(value);
}

function require(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function safeErrorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : "Unknown matrix failure.";
}

async function writeEvidence(path: string, evidence: MatrixEvidence): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(evidence, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
}

function printTable(results: readonly MatrixCaseEvidence[], evidencePath: string): void {
  process.stdout.write("\nHyperliquid testnet atomicity matrix\n");
  process.stdout.write("CASE                                  STATUS  CLEANUP  DETAIL\n");
  for (const result of results) {
    process.stdout.write(`${result.id.padEnd(37)} ${result.status.padEnd(7)} ${result.cleanup.padEnd(7)} ${result.detail}\n`);
  }
  process.stdout.write(`Evidence: ${evidencePath}\n`);
}

if (isDirectInvocation()) {
  void main().catch((cause: unknown) => {
    process.stderr.write(`hyperliquid:testnet-matrix failed: ${safeErrorMessage(cause)}\n`);
    process.exitCode = 1;
  });
}

function isDirectInvocation(): boolean {
  const invokedPath = process.argv[1];
  return invokedPath !== undefined && import.meta.url === pathToFileURL(resolve(invokedPath)).href;
}
