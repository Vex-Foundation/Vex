import type { Address } from "viem";

import type { HyperliquidExchangeClient } from "@tools/hyperliquid/exchange.js";
import type { HyperliquidInfoClient } from "@tools/hyperliquid/info.js";
import type { HyperliquidExchangeResult } from "@tools/hyperliquid/types.js";
import { hyperliquidBuilderConsentBus } from "@vex-agent/engine/events/hyperliquid-builder-bus.js";
import type { ProtocolExecutionContext, ProtocolHandler } from "../types.js";
import {
  auditCapture,
  exchangeOk,
  exchangeResult,
  fail,
  signingAddress,
  signingClients,
} from "./handler-shared.js";

export const HYPERLIQUID_BUILDER_FEE_HANDLERS: Record<string, ProtocolHandler> = {
  "hyperliquid.builder.approveFee": approveBuilderFee,
};

async function approveBuilderFee(_params: Record<string, unknown>, context: ProtocolExecutionContext) {
  const builder = configuredBuilderAddress();
  if (builder === null) return fail("Builder fee configuration is unavailable; orders will continue without a builder fee.");
  const { info, exchange } = await signingClients(context); const address = await signingAddress(context);
  // The prior submit may have reached HyperCore even if transport/response
  // parsing failed locally. Re-check the venue allowance before submitting a
  // second signed approval so a retry is idempotent whenever HL confirms it.
  try {
    const maximum = await info.maxBuilderFee(address, builder);
    if (isBuilderFeeAllowanceConfirmed(maximum)) {
      rememberBuilderFeeAllowance(context.sessionId, address, builder);
      hyperliquidBuilderConsentBus.emit("0.025%");
      const alreadyApproved: HyperliquidExchangeResult = {
        kind: "orders",
        statuses: [],
        raw: { status: "already_approved" },
      };
      return exchangeResult(alreadyApproved, {
        builder,
        maxFeeRate: "0.025%",
        alreadyApproved: true,
        _tradeCapture: auditCapture("account", alreadyApproved, address, {
          action: "approveBuilderFee",
          builder,
          maxFeeRate: "0.025%",
          alreadyApproved: true,
        }),
      });
    }
  } catch {
    // An unavailable read must not turn a user-requested ordinary mutation
    // into a false success. Submit once and let HyperCore decide.
  }
  const result = await exchange.approveBuilderFee({ builder, maxFeeRate: "0.025%" });
  if (exchangeOk(result)) {
    // An accepted user-signed response is not itself proof that the allowance
    // has become readable. Keep UI state and future builder attachment tied
    // to the venue's `maxBuilderFee` answer, never a local optimistic flag.
    try {
      if (isBuilderFeeAllowanceConfirmed(await info.maxBuilderFee(address, builder))) {
        rememberBuilderFeeAllowance(context.sessionId, address, builder);
        hyperliquidBuilderConsentBus.emit("0.025%");
      }
    } catch {
      // The signed action still has its truthful exchange result. A later
      // order's background check will learn the venue state without blocking.
    }
  }
  return exchangeResult(result, { builder, maxFeeRate: "0.025%", _tradeCapture: auditCapture("account", result, address, { action: "approveBuilderFee", builder, maxFeeRate: "0.025%" }) });
}

const BUILDER_ALLOWANCE_CACHE_LIMIT = 128;
const BUILDER_ALLOWANCE_CACHE_TTL_MS = 60_000;
const builderAllowanceByScope = new Map<string, number>();
const builderAllowanceInFlightByScope = new Map<string, Promise<void>>();

export function builderForOrders(
  info: HyperliquidInfoClient,
  exchange: Pick<HyperliquidExchangeClient, "approveBuilderFee">,
  user: string,
  context: Pick<ProtocolExecutionContext, "sessionId" | "hyperliquidPolicy">,
): { readonly b: Address; readonly f: 25 } | undefined {
  const builder = configuredBuilderAddress();
  // A Hyperliquid mutation can only reach this handler after the main-owned
  // first-entry acknowledgement gate. That acknowledgement is the user's
  // builder-fee disclosure/consent; a separate model-triggered confirmation
  // would contradict the product decision and leave otherwise-valid orders
  // unnecessarily untagged.
  if (builder === null || context.sessionId === undefined) return undefined;
  const scope = builderAllowanceScope(context.sessionId, user, builder);
  if (context.hyperliquidPolicy?.kind === "available" && context.hyperliquidPolicy.snapshot.policy.builderFeeConsent.kind === "approved") {
    rememberBuilderFeeAllowanceScope(scope);
    return { b: builder, f: 25 };
  }
  const confirmedAt = builderAllowanceByScope.get(scope);
  if (confirmedAt !== undefined && Date.now() - confirmedAt <= BUILDER_ALLOWANCE_CACHE_TTL_MS) {
    return { b: builder, f: 25 };
  }
  if (confirmedAt !== undefined) builderAllowanceByScope.delete(scope);
  scheduleBuilderFeeAllowanceCheck(info, exchange, user, builder, scope, context.sessionId);
  // Do not await a public-info read or a user-signed allowance action here.
  // The current order remains fully valid without a builder field; a later
  // order attaches it only after the venue confirms the allowance.
  return undefined;
}

function scheduleBuilderFeeAllowanceCheck(
  info: Pick<HyperliquidInfoClient, "maxBuilderFee">,
  exchange: Pick<HyperliquidExchangeClient, "approveBuilderFee">,
  user: string,
  builder: Address,
  scope: string,
  sessionId: string,
): void {
  if (builderAllowanceInFlightByScope.has(scope)) return;
  const attempt = (async () => {
    if (isBuilderFeeAllowanceConfirmed(await info.maxBuilderFee(user, builder))) {
      rememberBuilderFeeAllowanceScope(scope);
      hyperliquidBuilderConsentBus.emit("0.025%");
      return;
    }
    const { createExecutionIntent, completeExecutionIntent } = await import("@vex-agent/db/repos/executions.js");
    const intentId = await createExecutionIntent(
      "hyperliquid.builder.approveFee", "hyperliquid", sessionId,
      { builder, maxFeeRate: "0.025%", source: "background_builder_allowance" },
    );
    if (intentId <= 0) throw new Error("builder fee durable intent insert returned no execution id");
    const approval = await exchange.approveBuilderFee({ builder, maxFeeRate: "0.025%" });
    await completeExecutionIntent(
      intentId,
      { builder, maxFeeRate: "0.025%", exchange: approval.kind },
      exchangeOk(approval),
      auditCapture("account", approval, user, { action: "approveBuilderFee", builder, maxFeeRate: "0.025%", source: "background_builder_allowance" }),
      {},
      0,
    );
    if (!exchangeOk(approval)) return;
    // Approval submission can race venue indexing; only the follow-up read is
    // authority to attach `{ b, f:25 }` to a future order.
    if (isBuilderFeeAllowanceConfirmed(await info.maxBuilderFee(user, builder))) {
      rememberBuilderFeeAllowanceScope(scope);
      hyperliquidBuilderConsentBus.emit("0.025%");
    }
  })()
    .catch(() => undefined)
    .finally(() => {
      builderAllowanceInFlightByScope.delete(scope);
    });
  builderAllowanceInFlightByScope.set(scope, attempt);
}

function isBuilderFeeAllowanceConfirmed(maximum: unknown): maximum is number {
  return typeof maximum === "number" && Number.isSafeInteger(maximum) && maximum >= 25;
}

function builderAllowanceScope(sessionId: string, user: string, builder: Address): string {
  return `${sessionId}:${user.toLowerCase()}:${builder.toLowerCase()}`;
}

function rememberBuilderFeeAllowance(
  sessionId: string | undefined,
  user: string,
  builder: Address,
): void {
  if (sessionId === undefined) return;
  rememberBuilderFeeAllowanceScope(builderAllowanceScope(sessionId, user, builder));
}

function rememberBuilderFeeAllowanceScope(scope: string): void {
  if (!builderAllowanceByScope.has(scope) && builderAllowanceByScope.size >= BUILDER_ALLOWANCE_CACHE_LIMIT) {
    const oldest = builderAllowanceByScope.keys().next().value;
    if (oldest !== undefined) builderAllowanceByScope.delete(oldest);
  }
  builderAllowanceByScope.set(scope, Date.now());
}

/** Isolate global allowance memo state across unit tests. */
export function resetBuilderFeeAllowanceMemoForTests(): void {
  builderAllowanceByScope.clear();
  builderAllowanceInFlightByScope.clear();
}

function configuredBuilderAddress(): Address | null {
  const raw = process.env["VEX_HYPERLIQUID_BUILDER_ADDRESS"]?.trim();
  return raw !== undefined && /^0x[a-fA-F0-9]{40}$/.test(raw) ? raw as Address : null;
}


