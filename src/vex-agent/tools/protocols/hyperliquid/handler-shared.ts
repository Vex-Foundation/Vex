import { Decimal } from "decimal.js";
import type { Hex } from "viem";

import {
  ARBITRUM_NATIVE_USDC_ADDRESS,
  HYPERLIQUID_BRIDGE2_MAINNET_ADDRESS,
  resolveHyperliquidNetwork,
} from "@tools/hyperliquid/constants.js";
import type { HyperliquidExchangeClient } from "@tools/hyperliquid/exchange.js";
import { HyperliquidInfoClient } from "@tools/hyperliquid/info.js";
import type { HyperliquidMetaCache } from "@tools/hyperliquid/meta-cache.js";
import type {
  DecimalString,
  HyperliquidExchangeResult,
} from "@tools/hyperliquid/types.js";
import { normalizeProviderDecimal, parseDecimalString } from "@tools/hyperliquid/validation.js";
import type { ProtocolExecutionContext } from "../types.js";
import type { ToolResult } from "../../types.js";
import { buildPositionProtectionSnapshot } from "./protection-snapshot.js";
import { redact } from "../../../../lib/diagnostics/text-redaction.js";
import logger from "@utils/logger.js";

export function infoClient(): HyperliquidInfoClient {
  return new HyperliquidInfoClient({ network: resolveHyperliquidNetwork() });
}

export async function signingAddress(context: ProtocolExecutionContext): Promise<string> {
  const { resolveSelectedAddress } = await import("../../internal/wallet/resolve.js");
  return resolveSelectedAddress(context.walletResolution, context.walletPolicy, "eip155");
}

export async function signingClients(context: ProtocolExecutionContext): Promise<{
  readonly info: HyperliquidInfoClient;
  readonly meta: HyperliquidMetaCache;
  readonly exchange: HyperliquidExchangeClient;
}> {
  const [
    { HyperliquidExchangeClient },
    { HyperliquidMetaCache },
    { HyperliquidSigner },
    { hyperliquidRuntimeNonceAllocator },
    { resolveHyperliquidNetwork },
    { resolveSigningWallet },
  ] = await Promise.all([
    import("@tools/hyperliquid/exchange.js"),
    import("@tools/hyperliquid/meta-cache.js"),
    import("@tools/hyperliquid/signer.js"),
    import("@tools/hyperliquid/nonce.js"),
    import("@tools/hyperliquid/constants.js"),
    import("../../internal/wallet/resolve.js"),
  ]);
  const network = resolveHyperliquidNetwork();
  const info = new HyperliquidInfoClient({ network });
  const meta = new HyperliquidMetaCache(info);
  const signer = new HyperliquidSigner({
    network,
    nonceAllocator: hyperliquidRuntimeNonceAllocator,
    resolveWallet: () => {
      const wallet = resolveSigningWallet(context.walletResolution, context.walletPolicy, "eip155");
      if (wallet.family !== "eip155") throw new Error("Resolved wallet family mismatch.");
      return { address: wallet.address as `0x${string}`, privateKey: wallet.privateKey as Hex };
    },
  });
  return {
    info,
    meta,
    exchange: new HyperliquidExchangeClient({ signer, metaCache: meta, network, infoClient: info }),
  };
}

export async function withReadAddress(
  context: ProtocolExecutionContext,
  fn: (address: string) => Promise<ToolResult>,
): Promise<ToolResult> {
  const wallet = await import("../../internal/wallet/resolve.js");
  try {
    return await fn(wallet.resolveSelectedAddressForRead(context.walletResolution, context.walletPolicy, "eip155"));
  } catch (error) {
    return wallet.walletScopeErrorToResult(error);
  }
}

export function ok(data: Record<string, unknown>): ToolResult {
  return { success: true, output: JSON.stringify(data), data };
}

export function fail(output: string): ToolResult {
  return { success: false, output };
}

export function exchangeOk(result: HyperliquidExchangeResult): boolean {
  return result.kind === "orders" && result.statuses.every((status) => status.kind !== "rejected");
}

export function exchangeResult(
  result: HyperliquidExchangeResult,
  data: Record<string, unknown>,
  forceFailure = false,
): ToolResult {
  const success = exchangeOk(result) && !forceFailure;
  const coin = string(data, "coin") ?? string(data, "market");
  const side = string(data, "side");
  const capture = record(data["_tradeCapture"]);
  const captureMeta = record(capture?.["meta"]);
  const protectionState = string(captureMeta, "protectionState");
  const display = coin === undefined ? undefined : {
    namespace: "hyperliquid" as const,
    kind: "order_receipt" as const,
    coin,
    side: side === "long" || side === "short" || side === "buy" || side === "sell" ? side : null,
    status: forceFailure
      ? "unprotected" as const
      : success
        ? "accepted" as const
        : result.kind === "orders" && result.statuses.some((status) => status.kind === "partially_filled")
          ? "partial" as const
          : "rejected" as const,
    protectionState: protectionState === "FLAT"
      || protectionState === "OPENING"
      || protectionState === "CONSOLIDATING"
      || protectionState === "PROTECTED"
      || protectionState === "PARTIAL"
      || protectionState === "UNPROTECTED"
      || protectionState === "unprotected_by_user_choice"
      ? protectionState
      : null,
  };
  const venueError = venueErrorMessage(result);
  const response = {
    success,
    exchange: result.kind,
    ...data,
    // A bounded, redacted venue error so a failure is diagnosable: "batch_error"
    // alone is opaque and wastes agent calls (e.g. hl_leverage(cross) on an
    // isolated-only market returns "Cannot switch margin mode"). Placed AFTER
    // `data` so a handler-supplied field can never override the computed value.
    ...(venueError === undefined ? {} : { venueError }),
    ...(display === undefined ? {} : { _displayBlock: display }),
  };
  return { success, output: JSON.stringify(response), data: response };
}

/** First 120 chars of a venue-supplied error, redacted, when the result carries one. */
function venueErrorMessage(result: HyperliquidExchangeResult): string | undefined {
  if (result.kind === "batch_error") return boundVenueError(result.message);
  if (result.kind === "orders") {
    for (const status of result.statuses) {
      if (status.kind === "rejected") return boundVenueError(status.message);
    }
  }
  return undefined;
}

/**
 * The venue error is raw untrusted text: collapse control whitespace, run it
 * through the shared secret/address redaction pipeline, THEN cap at 120 chars
 * so keys, addresses, JWTs, and auth fragments never reach the transcript.
 */
function boundVenueError(message: string): string | undefined {
  const collapsed = message.replace(/\s+/g, " ").trim();
  if (collapsed.length === 0) return undefined;
  return redact(collapsed).text.slice(0, 120);
}

export function auditCapture(
  type: "account" | "transfer" | "lp" | "stake" | "reward",
  result: HyperliquidExchangeResult,
  walletAddress: string,
  meta: Record<string, unknown>,
): Record<string, unknown> {
  return {
    type,
    chain: "hyperliquid",
    status: exchangeOk(result) ? "executed" : "failed",
    walletAddress,
    valuationSource: "none",
    meta,
  };
}

/** Audit-only funding row: the on-chain Arbitrum transfer credits this sender's Hyperliquid account. */
export function hyperliquidDepositCapture(
  walletAddress: string,
  amountUsd: DecimalString,
  txHash: Hex,
): Record<string, unknown> {
  return {
    type: "transfer",
    chain: "arbitrum",
    status: "executed",
    walletAddress,
    inputTokenAddress: ARBITRUM_NATIVE_USDC_ADDRESS,
    inputAmount: amountUsd,
    outputTokenAddress: ARBITRUM_NATIVE_USDC_ADDRESS,
    outputAmount: amountUsd,
    signature: txHash,
    valuationSource: "none",
    meta: {
      action: "bridge2Deposit",
      bridgeAddress: HYPERLIQUID_BRIDGE2_MAINNET_ADDRESS,
      creditedTo: walletAddress,
    },
  };
}

export async function capturePerp(
  info: HyperliquidInfoClient,
  address: string,
  coin: string,
  context: ProtocolExecutionContext,
  closedWhenFlat: boolean,
  forceUnprotected = false,
  extraMeta: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const [state, orders] = await Promise.all([
    info.clearinghouseState(address),
    info.frontendOpenOrders(address),
  ]);
  const snapshot = buildPositionProtectionSnapshot(state, orders, coin);
  const position = positions(state).find((candidate) => string(candidate, "coin") === coin);
  const active = !new Decimal(snapshot.positionSize).isZero();
  const value = positive(string(position, "positionValue"));
  const entry = positive(string(position, "entryPx"));
  return {
    type: "perps",
    chain: "hyperliquid",
    status: active ? "open" : closedWhenFlat ? "closed" : "pending",
    walletAddress: address,
    positionKey: `hyperliquid:perp:${coin}:${address}`,
    instrumentKey: `hyperliquid:perp:${coin}`,
    ...(value ? { inputValueUsd: value } : {}),
    ...(entry ? { unitPriceUsd: entry } : {}),
    valuationSource: value ? "hyperliquid_clearinghouse" : "none",
    settlementAssetKey: "USDC",
    meta: {
      coin,
      contracts: new Decimal(snapshot.positionSize).abs().toFixed(),
      entryPx: snapshot.entryPx,
      liquidationPx: snapshot.liquidationPx,
      protectionState: forceUnprotected ? "unprotected_by_user_choice" : snapshot.state,
      ...(context.hyperliquidPolicy?.kind === "available" ? {
        policyVersion: context.hyperliquidPolicy.snapshot.version,
        policyProvenance: context.hyperliquidPolicy.snapshot.provenance,
      } : {}),
      ...extraMeta,
    },
  };
}

export async function capturePerpSafely(
  info: HyperliquidInfoClient,
  address: string,
  coin: string,
  context: ProtocolExecutionContext,
  closedWhenFlat: boolean,
  forceUnprotected = false,
  extraMeta: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  try {
    return await capturePerp(info, address, coin, context, closedWhenFlat, forceUnprotected, extraMeta);
  } catch (cause) {
    logger.warn("hyperliquid.post_submit_containment_failed", { step: "perp_capture", cause });
    return {
      type: "perps",
      chain: "hyperliquid",
      status: "pending",
      walletAddress: address,
      positionKey: `hyperliquid:perp:${coin}:${address}`,
      instrumentKey: `hyperliquid:perp:${coin}`,
      valuationSource: "none",
      settlementAssetKey: "USDC",
      meta: {
        coin,
        contracts: "0",
        protectionState: extraMeta["protectionState"] ?? (forceUnprotected ? "unprotected" : "unknown"),
        captureState: "live_state_unavailable",
        ...extraMeta,
      },
    };
  }
}

export async function consolidationFailureMeta(positionKey: string): Promise<Record<string, unknown>> {
  const { getByPositionKey } = await import("@vex-agent/db/repos/open-positions.js");
  const position = await getByPositionKey(positionKey);
  const previous = typeof position?.data.consolidationFailureCount === "number"
    ? position.data.consolidationFailureCount
    : 0;
  const consolidationFailureCount = previous + 1;
  return {
    consolidationFailureCount,
    ...(consolidationFailureCount >= 2 ? { protectionEscalation: "UNPROTECTED" } : {}),
  };
}

export function requiredString(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  if (typeof value !== "string" || value === "") throw new Error(`Missing ${key}`);
  return value;
}

export function string(
  params: Record<string, unknown> | null | undefined,
  key: string,
): string | undefined {
  const value = params?.[key];
  return typeof value === "string" ? value : undefined;
}

export function number(params: Record<string, unknown>, key: string): number | undefined {
  return typeof params[key] === "number" ? params[key] : undefined;
}

export function requiredNumber(params: Record<string, unknown>, key: string): number {
  const value = number(params, key);
  if (value === undefined) throw new Error(`Missing ${key}`);
  return value;
}

export function requiredBoolean(params: Record<string, unknown>, key: string): boolean {
  const value = params[key];
  if (typeof value !== "boolean") throw new Error(`Missing ${key}`);
  return value;
}

export function decimal(params: Record<string, unknown>, key: string): DecimalString {
  return parseDecimalString(requiredString(params, key));
}

export function optionalDecimal(params: Record<string, unknown>, key: string): DecimalString | undefined {
  const value = string(params, key);
  return value === undefined ? undefined : parseDecimalString(value);
}

export function buySell(params: Record<string, unknown>): "buy" | "sell" {
  const value = requiredString(params, "side");
  if (value !== "buy" && value !== "sell") throw new Error("side must be buy or sell");
  return value;
}

export function longShort(params: Record<string, unknown>): "long" | "short" {
  const value = requiredString(params, "side");
  if (value !== "long" && value !== "short") throw new Error("side must be long or short");
  return value;
}

export function cloid(params: Record<string, unknown>): `0x${string}` | undefined {
  const value = string(params, "cloid");
  return value && /^0x[0-9a-fA-F]{32}$/.test(value) ? value as `0x${string}` : undefined;
}

export function addressParam(params: Record<string, unknown>, key: string): `0x${string}` {
  const value = requiredString(params, key);
  if (!/^0x[a-fA-F0-9]{40}$/.test(value)) throw new Error(`${key} must be an EVM address`);
  return value as `0x${string}`;
}

export function usdMicros(amount: DecimalString): number {
  const micros = new Decimal(amount).mul(1_000_000);
  if (!micros.isInteger() || micros.lte(0)) {
    throw new Error("amount must have no more than six decimal places.");
  }
  return safeWireInteger(micros.toFixed(0));
}

export function safeWireInteger(value: string): number {
  if (!/^[1-9]\d*$/.test(value)) throw new Error("Expected a canonical positive integer amount.");
  const parsed = BigInt(value);
  if (parsed > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("Amount exceeds Hyperliquid's safe integer wire limit.");
  }
  return Number(parsed);
}

export function absolutePositionSize(positionSize: string): DecimalString {
  return parseDecimalString(new Decimal(positionSize).abs().toFixed());
}

export function positions(state: unknown): Record<string, unknown>[] {
  const root = record(state);
  const values = Array.isArray(root?.assetPositions) ? root.assetPositions : [];
  return values
    .map((item) => record(record(item)?.position) ?? record(item))
    .filter((item): item is Record<string, unknown> => item !== null);
}

export function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function markForCoin(response: unknown, coin: string): DecimalString | undefined {
  if (!Array.isArray(response) || response.length < 2) return undefined;
  const meta = record(response[0]);
  const contexts = Array.isArray(response[1]) ? response[1] : [];
  const universe = Array.isArray(meta?.["universe"]) ? meta["universe"] : [];
  const index = universe.findIndex((entry) => string(record(entry), "name") === coin);
  if (index < 0) return undefined;
  const context = record(contexts[index]);
  const value = string(context, "markPx");
  if (value === undefined) return undefined;
  // markPx is OPTIONAL display data: the venue returns non-canonical decimals
  // (e.g. a trailing-zero "62026.0"), so parse leniently and drop a malformed
  // value rather than throwing — a bad mark must never fail the positions read.
  try {
    return normalizeProviderDecimal(value, `Hyperliquid mark price for ${coin}`);
  } catch {
    return undefined;
  }
}

export function positive(value: string | undefined): string | undefined {
  return value && /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value) ? value : undefined;
}
