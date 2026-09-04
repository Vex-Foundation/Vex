/**
 * `kyberswap.swap.execute` - the orchestrator.
 *
 * It owns the order in which authority is acquired and evidence is gathered:
 * preview guard → wallet ADDRESS (never decrypts) → chain → tokens → signing
 * wallet → honeypot gate → tolerance → the CLAIM of the approved quote. Only
 * then does Phase A (`execute-plan.ts`) build and record the intent, and Phase
 * B (`execute-broadcast.ts`) sign and broadcast it.
 *
 * Everything before the intent exists fails through `failPreBroadcast` - a
 * hashless `definitively_failed` row; everything after it fails through the
 * post-intent handler, which never opens a second execution (C18).
 */

import { getKyberTokenApiClient } from "@tools/kyberswap/token-api/client.js";
import { resolveChainSlug, slugToChainId } from "@tools/kyberswap/chains.js";
import { getKyberEvmClients } from "@tools/kyberswap/evm-utils.js";
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
import { describeUnavailableSafetyCheck, type SafetyCheckUnavailable } from "./safety-disclosure.js";
import { venueFallbackNoteOnFailure } from "./fallback-messaging.js";
import { resolveKyberSlippageBps } from "./slippage.js";
import type { KyberGetRouteResponse } from "./route-request.js";
import { claimSwapExecutionSnapshot } from "../../../prequote/claim.js";

export const executeHandler: ProtocolHandler = async (p, context): Promise<ToolResult> => {
  const toolId = "kyberswap.swap.execute";

  // Defensive guard against the spine-inherited `previewSupport:true`
  // matrix row (this manifest declares no `dryRun` param) - a caller that
  // still passes `dryRun` must NEVER reach a real broadcast just because
  // the runtime treated the call as a preview.
  if (p.dryRun === true) {
    return fail(`${toolId} does not support dryRun preview - call kyberswap__swap_quote instead.`);
  }

  const chain = str(p, "chain"), tokenInRaw = str(p, "tokenIn"), tokenOutRaw = str(p, "tokenOut"), amountInRaw = str(p, "amountIn");
  if (!chain || !tokenInRaw || !tokenOutRaw || !amountInRaw) return fail("Missing required: chain, tokenIn, tokenOut, amountIn");

  // The prequote gate (executeProtocolTool) already blocks this tool
  // without a session - sessionId is guaranteed present here.
  const sessionId = context.sessionId;
  if (!sessionId) return fail(`${toolId} requires an active session.`);

  // C22 (Codex final-review finding 7): resolve the signer's ADDRESS ONLY
  // (never decrypts) BEFORE token resolution, so a token-resolution failure
  // - or anything after it - records the REAL wallet_address, never an
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
    const fallbackNote = venueFallbackNoteOnFailure(err, sessionId, false);
    return fail(`${toolId} failed: ${kyberFailureMessage(toolId, err)}.${fallbackNote}`);
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
  // Agent-facing labels only - see the quote handler's note. The persisted
  // leg symbols (`legInput`, the activity event plan) keep the canonical
  // `NATIVE` sentinel.
  const tokenInLabel = annotateNativeSymbol(tokenIn.symbol, chainId);
  const tokenOutLabel = annotateNativeSymbol(tokenOut.symbol, chainId);

  // Full signing wallet (decrypts) - resolved only now that the call may
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

  // Token safety gate - the ONLY hard block here is a CONFIRMED honeypot
  // (owner doctrine, UNCHANGED). FoT/high-tax is warn-only. A THROW from the
  // check itself means the safety check is UNAVAILABLE: still fail-soft, but
  // NO LONGER SILENT (W2b) - every unavailable leg is disclosed in the result
  // and persisted on the activity row, because a swap that ran without
  // honeypot protection and never said so is the failure mode this fixes.
  const safetyCheckUnavailable: SafetyCheckUnavailable[] = [];
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
      const unavailable = describeUnavailableSafetyCheck(leg, err);
      safetyCheckUnavailable.push(unavailable);
      logger.warn("kyberswap.swap.safety_check_failed", {
        address: leg.address,
        reason: unavailable.reason,
        cause: unavailable.cause,
      });
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

  // ── THE APPROVED QUOTE, claimed for exactly one execute ──
  //
  // There is NO execute-time re-quote. Until 2026-08-27 this handler fetched a
  // fresh route here and `execute-plan.ts` derived the price floor from THAT
  // route, which made the floor track the market instead of bounding it: a
  // quote of 313,879.7 CCF filled at 1,190.145 CCF, 263x worse, without a
  // revert, because the floor had moved with the price. No reference wallet
  // re-quotes at submit either (MetaMask ships calldata inside the quote,
  // Uniswap reads min-out off the accepted trade, Rabby carries `quote.tx`
  // unchanged).
  //
  // The claim is single-use and atomic, so a second execute of the same quote
  // is a typed refusal rather than a second fill, and a later quote for the
  // same trade supersedes this one even when it is unexpired and unclaimed.
  const claimed = await claimSwapExecutionSnapshot(toolId, sessionId, p, context, `${toolId}:${sessionId}`);
  if (!claimed.ok) {
    return failPreBroadcast(
      toolId, p, sessionId, walletAddress, chainId, slug,
      legInput(tokenIn), legInput(tokenOut),
      new VexError(ErrorCodes.KYBER_PRICE_FLOOR_VIOLATED, claimed.refusal.message),
      true,
    );
  }
  // Strict equality against the ONE known router, unchanged: the address is a
  // constant on all 19 aggregator chains, so nothing about dropping the route
  // fetch weakens what the allowance is granted to. The build response's own
  // router is re-verified in `execute-plan.ts` before anything is signed.
  const routerAddress: Address = META_AGGREGATION_ROUTER_V2;
  const approvedSummary = claimed.routeSummary as KyberGetRouteResponse["data"]["routeSummary"];

  // ── Phase A (pre-intent): balance/allowance-read/build + plan
  // construction + the atomic intent creation. ANY failure in this phase
  // uses `failPreBroadcast` - nothing has been signed yet, so a fresh
  // pre-broadcast-failure row is correct (C18: failPreBroadcast is
  // pre-intent ONLY).
  let prepared;
  try {
    prepared = await prepareSwapExecution({
      toolId, intentParams: p, sessionId, publicClient, walletAddress, chainId, slug,
      tokenIn, tokenOut, amountIn, amountInRaw, slippage, routerAddress,
      approvedSummary, approvedSnapshot: claimed.snapshot,
      safetyCheckUnavailable,
      // The claimed row's own Vex fee statement, carried into Phase A so the
      // fee this build will sign can be held to the one the card stated.
      approvedVexFee: claimed.vexFee,
    });
  } catch (err) {
    return failPreBroadcast(toolId, p, sessionId, walletAddress, chainId, slug, legInput(tokenIn), legInput(tokenOut), err, true);
  }

  // ── Phase B (post-intent): staged broadcast loop.
  return runStagedSwapBroadcast({
    toolId, prepared, publicClient, walletClient, walletAddress, sessionId,
    chainId, slug, tokenIn, tokenOut, tokenInLabel, tokenOutLabel, slippage,
    safetyCheckUnavailable,
  });
};
