/**
 * Phase A of `kyberswap.swap.execute` (pre-intent): balance guard, allowance
 * read, `/route/build`, the pre-sign calldata assertion, the durable cost
 * breakdown, the per-leg event plan, and the atomic intent creation.
 *
 * NOTHING here has been signed. Every failure THROWS, and the caller's single
 * catch records it with `failPreBroadcast` (C18: pre-intent only) — which is
 * exactly why the intent creation is the LAST statement of this phase.
 */

import { getKyberAggregatorClient } from "@tools/kyberswap/aggregator/client.js";
import {
  getKyberEvmClients,
  verifyRouterAddress,
  planKyberAllowance,
  buildApproveCalldata,
} from "@tools/kyberswap/evm-utils.js";
import { META_AGGREGATION_ROUTER_V2 } from "@tools/kyberswap/constants.js";
import { verifyBuiltKyberSwap } from "@tools/kyberswap/evm/swap-calldata-guard.js";
import { deriveRouteFirstHops } from "@tools/kyberswap/evm/swap-source-transfer-binding.js";
import {
  computeApprovedMinOut,
  KYBER_BUILD_REDERIVATION_ALLOWANCE_RAW,
} from "@tools/kyberswap/swap-price-floor.js";
import { computeKyberVexFeeRaw } from "@tools/kyberswap/swap-vex-fee.js";
import { ensureErc20Balance } from "@tools/evm-chains/erc20-balance-guard.js";
import type { ResolvedKyberTokenMetadata } from "@tools/kyberswap/helpers.js";
import type { KyberChainSlug } from "@tools/kyberswap/types.js";
import {
  createAgentActivityIntent,
  type AgentActivityEvent,
  type AgentActivityEventRole,
  type CreatePendingActivityEventInput,
} from "@vex-agent/db/repos/agent-activity.js";
import { formatUnits, getAddress, type Address, type Hex } from "viem";
import { VexError, ErrorCodes } from "../../../../../../errors.js";
import { estimateKyberSwapCostsUsd } from "../../swap-cost-estimate.js";
import { settlementDecodeProvenance } from "@vex-agent/db/repos/agent-activity/settlement-decode.js";
import { PROTOCOL } from "./protocol-id.js";
import type { KyberBuildRouteResponse, KyberGetRouteResponse } from "./route-request.js";
import type { SafetyCheckUnavailable } from "./safety-disclosure.js";

export interface SwapEventPlan {
  readonly eventRole: AgentActivityEventRole;
  readonly txParams: { readonly to: Address; readonly data: Hex; readonly value?: bigint };
  readonly event: Omit<CreatePendingActivityEventInput, "protocolExecutionId" | "eventIndex">;
}

export interface PreparedSwapExecution {
  readonly executionId: number;
  readonly events: readonly AgentActivityEvent[];
  readonly plans: readonly SwapEventPlan[];
  readonly buildResp: KyberBuildRouteResponse;
}

export interface PrepareSwapExecutionInput {
  readonly toolId: string;
  readonly intentParams: Record<string, unknown>;
  readonly sessionId: string;
  readonly publicClient: ReturnType<typeof getKyberEvmClients>["publicClient"];
  readonly walletAddress: Address;
  readonly chainId: number;
  readonly slug: KyberChainSlug;
  readonly tokenIn: ResolvedKyberTokenMetadata;
  readonly tokenOut: ResolvedKyberTokenMetadata;
  readonly amountIn: bigint;
  readonly amountInRaw: string;
  readonly slippage: number;
  readonly routerAddress: Address;
  readonly routeSummaryRaw: KyberGetRouteResponse["data"]["routeSummary"];
  /**
   * Legs whose honeypot/FoT check could not run (W2b). Persisted onto the
   * activity row's `intent_params` under a Vex-authored `_`-prefixed key —
   * same established pattern as the Jupiter lend `/operate` delta shape — so
   * the record itself says the swap ran without that protection. No schema
   * change: `intent_params` is already a sanitized, capped JSON blob.
   */
  readonly safetyCheckUnavailable: readonly SafetyCheckUnavailable[];
}

export async function prepareSwapExecution(input: PrepareSwapExecutionInput): Promise<PreparedSwapExecution> {
  const {
    toolId, intentParams: p, sessionId, publicClient, walletAddress, chainId, slug,
    tokenIn, tokenOut, amountIn, amountInRaw, slippage, routerAddress, routeSummaryRaw,
    safetyCheckUnavailable,
  } = input;

  if (!tokenIn.isNative) {
    await ensureErc20Balance(publicClient, {
      token: tokenIn.address,
      owner: walletAddress,
      required: amountIn,
      decimals: tokenIn.decimals,
      label: tokenIn.symbol,
    });
  }

  let allowancePlan: { needsReset: boolean; needsApprove: boolean } = { needsReset: false, needsApprove: false };
  if (!tokenIn.isNative) {
    allowancePlan = await planKyberAllowance(publicClient, tokenIn.address, walletAddress, routerAddress, amountIn);
  }

  const buildResp = await getKyberAggregatorClient().buildRoute(slug, {
    routeSummary: routeSummaryRaw,
    sender: walletAddress,
    recipient: walletAddress,
    slippageTolerance: slippage,
  });
  verifyRouterAddress(buildResp.data.routerAddress, META_AGGREGATION_ROUTER_V2);

  // ── Pre-sign calldata assertion (the ONE gate on the opaque blob) ──
  // KyberSwap embeds the price protection inside calldata WE did not
  // build, so it is decoded and held to the floor THIS fresh route implies
  // at the caller's own slippage — plus the fee line, the flags, the
  // target, the spender and the native value. Runs BEFORE the intent is
  // created, so a refusal is a clean pre-broadcast failure with nothing
  // signed and nothing broadcast. It bounds what the BUILD may do to the
  // trade; it does not second-guess where the market moved since the
  // quote — `slippageBps` owns that.
  const verdict = verifyBuiltKyberSwap(
    {
      calldata: buildResp.data.data as Hex,
      routerAddress: buildResp.data.routerAddress,
      transactionValue: buildResp.data.transactionValue,
    },
    {
      expectedRouter: META_AGGREGATION_ROUTER_V2,
      recipient: walletAddress,
      srcToken: getAddress(tokenIn.address),
      dstToken: getAddress(tokenOut.address),
      amountIn,
      srcIsNative: tokenIn.isNative,
      freshMinOutRaw: computeApprovedMinOut(routeSummaryRaw.amountOut, slippage),
      floorAllowanceRaw: KYBER_BUILD_REDERIVATION_ALLOWANCE_RAW,
      // The pools of the very route summary posted to `/route/build`
      // above — never a second, fresher route, which would let the guard
      // bless a build against a route the agent never approved.
      routeFirstHops: deriveRouteFirstHops(routeSummaryRaw.route),
    },
  );
  if (!verdict.ok) {
    throw new VexError(
      verdict.kind === "price_floor"
        ? ErrorCodes.KYBER_PRICE_FLOOR_VIOLATED
        : ErrorCodes.KYBER_UNSAFE_BUILD,
      // Kept SHORT on purpose: `summarizeProtocolError` joins message +
      // hint and caps the pair at 200 chars, so a verbose reason silently
      // truncates away the actionable tail — the one part of a refusal the
      // agent must always receive.
      `Refused before signing: ${verdict.reason}.`,
      verdict.kind === "price_floor"
        ? "Nothing was signed. Get a fresh kyberswap__swap_quote."
        : "Nothing was signed. Re-quote; do not retry this build.",
    );
  }

  // C21 (Codex final-review finding 6): the native-in "requested" leg
  // recorded on the swap event is the SIGNED transaction's own declared
  // value (`transactionValue`), never a locally re-derived `amountIn` —
  // this is also what the settlement decoder treats as the EXECUTED
  // truth for a native leg (Kyber is exact-input, so the two coincide by
  // construction, but the build response is the authoritative source).
  const tokenInAmountRaw = tokenIn.isNative ? buildResp.data.transactionValue : amountIn.toString();
  const tokenInAmountHuman = tokenIn.isNative
    ? formatUnits(BigInt(buildResp.data.transactionValue), tokenIn.decimals)
    : amountInRaw;

  // The durable cost breakdown (migration 050). Derived here — AFTER the
  // calldata guard above accepted the build — so "25 bps of the input, on
  // the source token" is a proven property of the payload about to be
  // signed rather than an assumption.
  const swapCosts = estimateKyberSwapCostsUsd({
    gasUsd: buildResp.data.gasUsd,
    l1FeeUsd: routeSummaryRaw.l1FeeUsd,
    amountInUsd: buildResp.data.amountInUsd,
  });
  // The same fee as a FACT rather than a USD estimate (migration 050
  // Part 2). `amountIn` is the very bigint the guard just pinned to
  // `desc.amount`, and the guard also pinned the rate, the source-side
  // charge and the no-partial-fill flag — so this is the router's own
  // arithmetic over proven inputs, not a re-derivation of a provider hint.
  // It is recorded even when `usdVexFeeEst` is undefined, which is what
  // makes an absent USD read as "price unknown" instead of "no fee".
  const vexFeeRaw = computeKyberVexFeeRaw(amountIn);

  // ── Build the events plan BEFORE anything is signed (plan §11.1 step 1) ──
  const builtPlans: SwapEventPlan[] = [];
  if (allowancePlan.needsReset) {
    builtPlans.push({
      eventRole: "allowance_reset",
      txParams: { to: tokenIn.address, data: buildApproveCalldata(routerAddress, 0n) },
      event: {
        eventRole: "allowance_reset", kind: "swap", protocol: PROTOCOL,
        chainId, chainSlug: slug, walletAddress, sessionId,
        tokenIn: { tokenAddress: tokenIn.address, tokenSymbol: tokenIn.symbol, tokenDecimals: tokenIn.decimals, amountHuman: "0", amountRaw: "0" },
      },
    });
  }
  if (allowancePlan.needsApprove) {
    builtPlans.push({
      eventRole: "allowance",
      txParams: { to: tokenIn.address, data: buildApproveCalldata(routerAddress, amountIn) },
      event: {
        eventRole: "allowance", kind: "swap", protocol: PROTOCOL,
        chainId, chainSlug: slug, walletAddress, sessionId,
        tokenIn: { tokenAddress: tokenIn.address, tokenSymbol: tokenIn.symbol, tokenDecimals: tokenIn.decimals, amountHuman: formatUnits(amountIn, tokenIn.decimals), amountRaw: amountIn.toString() },
      },
    });
  }
  builtPlans.push({
    eventRole: "swap",
    txParams: {
      to: getAddress(buildResp.data.routerAddress),
      data: buildResp.data.data as Hex,
      value: BigInt(buildResp.data.transactionValue),
    },
    event: {
      eventRole: "swap", kind: "swap", protocol: PROTOCOL,
      chainId, chainSlug: slug, walletAddress, sessionId,
      tokenIn: { tokenAddress: tokenIn.address, tokenSymbol: tokenIn.symbol, tokenDecimals: tokenIn.decimals, amountHuman: tokenInAmountHuman, amountRaw: tokenInAmountRaw },
      tokenOut: { tokenAddress: tokenOut.address, tokenSymbol: tokenOut.symbol, tokenDecimals: tokenOut.decimals, amountHuman: formatUnits(BigInt(buildResp.data.amountOut), tokenOut.decimals), amountRaw: buildResp.data.amountOut },
      usdInEst: buildResp.data.amountInUsd,
      usdOutEst: buildResp.data.amountOutUsd,
      // `usd_fee_est` is FROZEN for the migration-050 dual-write window:
      // it keeps receiving `gasUsd` alone, byte-identical to its
      // pre-050 behavior, so old readers are unaffected. The honest gas —
      // L2 execution PLUS the L1 data fee, which on an OP-stack chain can
      // rival or exceed it — goes to `usd_network_gas_est`, so the two
      // legitimately differ on those chains. A later contract migration
      // drops `usd_fee_est`.
      usdFeeEst: buildResp.data.gasUsd,
      usdNetworkGasEst: swapCosts.usdNetworkGasEst,
      // Vex's own 25 bps, recorded for the first time. It rides the SWAP
      // leg deliberately: this row's status is what says whether the fee
      // was actually collected, so summing confirmed rows is honest revenue.
      usdVexFeeEst: swapCosts.usdVexFeeEst,
      // Charged on the SOURCE token and taken OUT of the input, so this is
      // a component of `tokenIn.amountRaw` above — never an extra debit.
      vexFee: {
        tokenAddress: tokenIn.address,
        tokenSymbol: tokenIn.symbol,
        tokenDecimals: tokenIn.decimals,
        amountRaw: vexFeeRaw.toString(),
        amountHuman: formatUnits(vexFeeRaw, tokenIn.decimals),
      },
      usdSource: "kyberswap_quote",
      routeProvenance: {
        routeID: routeSummaryRaw.routeID, checksum: routeSummaryRaw.checksum,
        // R1 Step 5a — the decode inputs, persisted at INTENT time. The router
        // is the one `verifyRouterAddress` accepted above, not a value echoed
        // back from the build; the declared value is the signed transaction's
        // own, and it is recorded only when the input really is native, because
        // on an ERC-20 route it is zero and would tell a decoder nothing.
        ...settlementDecodeProvenance({
          decoder: "kyberswap",
          chainId,
          routerAddress: getAddress(buildResp.data.routerAddress),
          ...(tokenIn.isNative ? { declaredValueRaw: buildResp.data.transactionValue } : {}),
        }),
      },
    },
  });

  const created = await createAgentActivityIntent({
    toolId,
    namespace: PROTOCOL,
    intentParams: safetyCheckUnavailable.length > 0
      ? { ...p, _safetyCheckUnavailable: safetyCheckUnavailable }
      : p,
    events: builtPlans.map((plan, i) => ({ ...plan.event, eventIndex: i })),
  });
  return {
    executionId: created.executionId,
    events: created.events,
    plans: builtPlans,
    buildResp,
  };
}
