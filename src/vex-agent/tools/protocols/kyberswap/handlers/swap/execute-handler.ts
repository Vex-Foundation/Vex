/**
 * `kyberswap.swap.execute` — the orchestrator.
 *
 * It owns the order in which authority is acquired and evidence is gathered:
 * preview guard → wallet ADDRESS (never decrypts) → chain → tokens → signing
 * wallet → honeypot gate → tolerance → fresh route. Only then does Phase A
 * (`execute-plan.ts`) build and record the intent, and Phase B
 * (`execute-broadcast.ts`) sign and broadcast it.
 *
 * Everything before the intent exists fails through `failPreBroadcast` — a
 * hashless `definitively_failed` row; everything after it fails through the
 * post-intent handler, which never opens a second execution (C18).
 */

import { getKyberAggregatorClient } from "@tools/kyberswap/aggregator/client.js";
import { getKyberTokenApiClient } from "@tools/kyberswap/token-api/client.js";
import { resolveChainSlug, slugToChainId } from "@tools/kyberswap/chains.js";
import { getKyberEvmClients, verifyRouterAddress } from "@tools/kyberswap/evm-utils.js";
import { META_AGGREGATION_ROUTER_V2 } from "@tools/kyberswap/constants.js";
import { resolveTokenMetadataStrict, requireFeature, type ResolvedKyberTokenMetadata } from "@tools/kyberswap/helpers.js";
import { annotateNativeSymbol } from "@tools/evm-chains/native-currency.js";
import type { ChainWallet } from "@tools/wallet/multi-auth.js";
import type { KyberChainSlug } from "@tools/kyberswap/types.js";
import logger from "@utils/logger.js";
import { resolveSelectedAddress, resolveSigningWallet, walletScopeErrorToResult } from "@vex-agent/tools/internal/wallet/resolve.js";
import { parseUnits, getAddress, type Address } from "viem";
import { VexError, ErrorCodes } from "../../../../../../errors.js";
import type { ToolResult } from "../../../../types.js";
import type { ProtocolHandler } from "../../../types.js";
import { str, fail } from "../../../handler-helpers.js";
import { failPreBroadcast, legInput } from "./activity-recording.js";
import { kyberFailureMessage } from "./error-output.js";
import { runStagedSwapBroadcast } from "./execute-broadcast.js";
import { prepareSwapExecution } from "./execute-plan.js";
import { classifySafetyCheckFailure } from "./quote-safety.js";
import { revealOnEligibleFailure } from "./reveal-messaging.js";
import { resolveKyberSlippageBps } from "./slippage.js";
import { VEX_INTEGRATOR_FEE_ROUTE_PARAMS, type KyberGetRouteResponse } from "./route-request.js";

export const executeHandler: ProtocolHandler = async (p, context): Promise<ToolResult> => {
  const toolId = "kyberswap.swap.execute";

  // Defensive guard against the spine-inherited `previewSupport:true`
  // matrix row (this manifest declares no `dryRun` param) — a caller that
  // still passes `dryRun` must NEVER reach a real broadcast just because
  // the runtime treated the call as a preview.
  if (p.dryRun === true) {
    return fail(`${toolId} does not support dryRun preview — call kyberswap.swap.quote instead.`);
  }

  const chain = str(p, "chain"), tokenInRaw = str(p, "tokenIn"), tokenOutRaw = str(p, "tokenOut"), amountInRaw = str(p, "amountIn");
  if (!chain || !tokenInRaw || !tokenOutRaw || !amountInRaw) return fail("Missing required: chain, tokenIn, tokenOut, amountIn");

  // The prequote gate (executeProtocolTool) already blocks this tool
  // without a session — sessionId is guaranteed present here.
  const sessionId = context.sessionId;
  if (!sessionId) return fail(`${toolId} requires an active session.`);

  // C22 (Codex final-review finding 7): resolve the signer's ADDRESS ONLY
  // (never decrypts) BEFORE token resolution, so a token-resolution failure
  // — or anything after it — records the REAL wallet_address, never an
  // empty string. The full (decrypting) signing wallet is resolved later,
  // only once we know the call may actually broadcast.
  let walletAddress: Address;
  try {
    walletAddress = getAddress(resolveSelectedAddress(context.walletResolution, context.walletPolicy, "eip155"));
  } catch (err) {
    return walletScopeErrorToResult(err);
  }

  let slug: KyberChainSlug;
  let chainId: number;
  try {
    slug = resolveChainSlug(chain);
    requireFeature(slug, "aggregator");
    chainId = slugToChainId(slug);
  } catch (err) {
    const revealSuffix = revealOnEligibleFailure(err, sessionId, false);
    return fail(`${toolId} failed: ${kyberFailureMessage(toolId, err)}.${revealSuffix}`);
  }

  let tokenIn: ResolvedKyberTokenMetadata;
  let tokenOut: ResolvedKyberTokenMetadata;
  try {
    tokenIn = await resolveTokenMetadataStrict(tokenInRaw, chainId);
    tokenOut = await resolveTokenMetadataStrict(tokenOutRaw, chainId);
  } catch (err) {
    // The REAL wallet_address (resolved above) is already known even
    // though the tokens never resolved.
    return failPreBroadcast(toolId, p, sessionId, walletAddress, chainId, slug, undefined, undefined, err, false);
  }
  // Agent-facing labels only — see the quote handler's note. The persisted
  // leg symbols (`legInput`, the activity event plan) keep the canonical
  // `NATIVE` sentinel.
  const tokenInLabel = annotateNativeSymbol(tokenIn.symbol, chainId);
  const tokenOutLabel = annotateNativeSymbol(tokenOut.symbol, chainId);

  // Full signing wallet (decrypts) — resolved only now that the call may
  // actually need to sign. Re-validates the SAME session/policy scope the
  // address-only resolution above already checked.
  let signer: ChainWallet;
  try {
    signer = resolveSigningWallet(context.walletResolution, context.walletPolicy, "eip155");
  } catch (err) {
    return walletScopeErrorToResult(err);
  }
  if (signer.family !== "eip155") return fail("Resolved wallet family mismatch.");

  const { publicClient, walletClient } = getKyberEvmClients(slug, signer.privateKey);

  // Token safety gate — the ONLY hard block here is a CONFIRMED honeypot
  // (owner doctrine). FoT/high-tax is warn-only. A THROW from the check
  // itself means the safety check is UNAVAILABLE (fail-soft — proceed).
  for (const leg of [tokenIn, tokenOut]) {
    if (leg.isNative) continue;
    try {
      const check = await getKyberTokenApiClient().getHoneypotFotInfo(chainId, leg.address);
      if (check.isHoneypot) {
        return failPreBroadcast(
          toolId, p, sessionId, walletAddress, chainId, slug,
          legInput(tokenIn), legInput(tokenOut),
          new Error(`Token ${leg.symbol} (${leg.address}) flagged as honeypot. Aborting swap.`),
          true,
        );
      }
      if (check.isFOT && check.tax > 0) logger.warn("kyberswap.swap.fot_warning", { token: leg.symbol, address: leg.address, tax: check.tax });
    } catch (err) {
      logger.warn("kyberswap.swap.safety_check_failed", { address: leg.address, reason: classifySafetyCheckFailure(err) });
    }
  }

  const amountIn = parseUnits(amountInRaw, tokenIn.decimals);
  const resolvedSlippage = resolveKyberSlippageBps(toolId, p);
  if (!resolvedSlippage.ok) {
    return failPreBroadcast(
      toolId, p, sessionId, walletAddress, chainId, slug,
      legInput(tokenIn), legInput(tokenOut),
      new VexError(ErrorCodes.KYBER_MALFORMED_PARAMS, resolvedSlippage.reason),
      true,
    );
  }
  const slippage = resolvedSlippage.bps;

  let routerAddress: Address;
  let routeSummaryRaw: KyberGetRouteResponse["data"]["routeSummary"];
  try {
    const routeResp = await getKyberAggregatorClient().getRoute(slug, {
      tokenIn: tokenIn.address,
      tokenOut: tokenOut.address,
      amountIn: amountIn.toString(),
      ...VEX_INTEGRATOR_FEE_ROUTE_PARAMS,
    });
    verifyRouterAddress(routeResp.data.routerAddress, META_AGGREGATION_ROUTER_V2);
    routerAddress = routeResp.data.routerAddress;
    routeSummaryRaw = routeResp.data.routeSummary;
  } catch (err) {
    return failPreBroadcast(toolId, p, sessionId, walletAddress, chainId, slug, legInput(tokenIn), legInput(tokenOut), err, true);
  }

  // ── Phase A (pre-intent): balance/allowance-read/build + plan
  // construction + the atomic intent creation. ANY failure in this phase
  // uses `failPreBroadcast` — nothing has been signed yet, so a fresh
  // pre-broadcast-failure row is correct (C18: failPreBroadcast is
  // pre-intent ONLY).
  let prepared;
  try {
    prepared = await prepareSwapExecution({
      toolId, intentParams: p, sessionId, publicClient, walletAddress, chainId, slug,
      tokenIn, tokenOut, amountIn, amountInRaw, slippage, routerAddress, routeSummaryRaw,
    });
  } catch (err) {
    return failPreBroadcast(toolId, p, sessionId, walletAddress, chainId, slug, legInput(tokenIn), legInput(tokenOut), err, true);
  }

  // ── Phase B (post-intent): staged broadcast loop.
  return runStagedSwapBroadcast({
    toolId, prepared, publicClient, walletClient, walletAddress, sessionId,
    chainId, slug, tokenIn, tokenOut, tokenInLabel, tokenOutLabel, slippage,
  });
};
