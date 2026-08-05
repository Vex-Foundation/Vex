/**
 * Phase A — what will be broadcast, decided BEFORE anything is signed.
 *
 * The events plan (plan §11.1) is one `agent_activity` row per planned
 * broadcast: `allowance_reset`/`allowance` only when the current allowance is
 * short (USDT-style reset-before-non-zero-approve), `swap` always. The tx
 * builder turns each created row back into the calldata for its own role.
 */

import { formatUnits, type Address } from "viem";

import { buildSwapTx, buildApproveTx, type BuiltSwapTx } from "@tools/uniswap/execute.js";
import type { UniswapDeployment } from "@tools/uniswap/deployments.js";
import type { UniswapToken } from "@tools/uniswap/types.js";
import type { AgentActivityEvent } from "@vex-agent/db/repos/agent-activity.js";

import { settlementDecodeProvenance } from "@vex-agent/db/repos/agent-activity/settlement-decode.js";

import { routerFor } from "./deployment.js";
import { PROTOCOL } from "./protocol-id.js";
import { legFor, type PlannedEvent } from "./activity-recording.js";
import type { QuotedRoute } from "./route-quote.js";

const DEFAULT_DEADLINE_SECONDS = 600; // ~10 min

export interface TxBuildContext {
  readonly deployment: UniswapDeployment;
  readonly router: Address;
  readonly tokenIn: UniswapToken;
  readonly tokenOut: UniswapToken;
  readonly amountIn: bigint;
  readonly quoted: QuotedRoute;
  readonly recipient: Address;
}

export function buildTxForEvent(event: AgentActivityEvent, ctx: TxBuildContext): BuiltSwapTx {
  if (event.eventRole === "allowance_reset") return buildApproveTx(ctx.tokenIn.address, ctx.router, 0n);
  if (event.eventRole === "allowance") return buildApproveTx(ctx.tokenIn.address, ctx.router, ctx.amountIn);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + DEFAULT_DEADLINE_SECONDS);
  return buildSwapTx({
    deployment: ctx.deployment,
    route: ctx.quoted.route,
    amountIn: ctx.amountIn,
    minAmountOut: ctx.quoted.minAmountOut,
    recipient: ctx.recipient,
    deadline,
    tokenInIsNative: ctx.tokenIn.isNative,
    tokenOutIsNative: ctx.tokenOut.isNative,
  });
}

export function describeEventRole(role: AgentActivityEvent["eventRole"]): string {
  if (role === "allowance_reset") return "Allowance-reset transaction";
  if (role === "allowance") return "Approval transaction";
  return "Swap transaction";
}

export interface PlanSwapEventsInput {
  readonly deployment: UniswapDeployment;
  readonly walletAddress: string;
  readonly sessionId: string;
  readonly tokenIn: UniswapToken;
  readonly tokenOut: UniswapToken;
  /** The amount the swap calldata is built for. */
  readonly amountIn: bigint;
  /** The caller's own decimal string for `amountIn`, echoed on the swap row. */
  readonly amountInHuman: string;
  readonly quoted: QuotedRoute;
  readonly currentAllowance: bigint;
}

export function planSwapEvents(input: PlanSwapEventsInput): PlannedEvent[] {
  const { deployment, tokenIn, tokenOut, amountIn, quoted } = input;
  const needsAllowance = !tokenIn.isNative && input.currentAllowance < amountIn;
  const needsReset = needsAllowance && input.currentAllowance > 0n;
  const common = {
    kind: "swap",
    protocol: PROTOCOL,
    chainId: deployment.chainId,
    chainSlug: deployment.key,
    walletAddress: input.walletAddress,
    sessionId: input.sessionId,
  } as const;

  const events: PlannedEvent[] = [];
  let eventIndex = 0;
  if (needsReset) {
    events.push({ eventIndex: eventIndex++, eventRole: "allowance_reset", ...common, tokenIn: legFor(tokenIn) });
  }
  if (needsAllowance) {
    events.push({
      eventIndex: eventIndex++, eventRole: "allowance", ...common,
      tokenIn: { ...legFor(tokenIn), amountHuman: formatUnits(amountIn, tokenIn.decimals), amountRaw: amountIn.toString() },
    });
  }
  events.push({
    eventIndex, eventRole: "swap", ...common,
    tokenIn: { ...legFor(tokenIn), amountHuman: input.amountInHuman, amountRaw: amountIn.toString() },
    tokenOut: { ...legFor(tokenOut), amountHuman: formatUnits(quoted.amountOut, tokenOut.decimals), amountRaw: quoted.amountOut.toString() },
    routeProvenance: {
      version: quoted.route.version, path: quoted.route.path, fees: quoted.route.fees ?? null,
      // R1 Step 5a — the decode inputs, persisted at INTENT time. The router is
      // the deployment's own verified `router02`, never a provider-supplied
      // address; `declaredValueRaw` is written only for a native input, and the
      // wrapped-native contract only when the OUT leg is native, because those
      // are the only cases where a decoder needs either.
      ...settlementDecodeProvenance({
        decoder: "uniswap",
        chainId: deployment.chainId,
        routerAddress: routerFor(deployment, quoted.route),
        ...(tokenIn.isNative ? { declaredValueRaw: amountIn.toString() } : {}),
        ...(tokenOut.isNative ? { wrappedNativeAddress: deployment.weth } : {}),
      }),
    },
  });
  return events;
}
