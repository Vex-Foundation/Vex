/**
 * `uniswap.swap.execute` — the orchestrator.
 *
 * It owns the order in which authority is acquired and evidence is gathered:
 * preview guard → tolerance → session → chain → wallet ADDRESS (never decrypts)
 * → tokens + quote → signing wallet → balance/spender/allowance guards → the
 * events plan and the intent. Only then does the staged loop sign anything.
 *
 * Everything before the intent exists fails through `failPreBroadcast` — a
 * hashless `definitively_failed` row; everything after it fails through
 * `postIntentFailureResult`, which never opens a second execution (C18).
 */

import { parseUnits, formatUnits, getAddress, type Hex } from "viem";

import { getUniswapEvmClients } from "@tools/uniswap/evm-client.js";
import { validateUniswapSpender, readUniswapAllowance } from "@tools/uniswap/erc20.js";
import { ensureErc20Balance } from "@tools/evm-chains/erc20-balance-guard.js";
import { priorLegAnchorFrom, type ConfirmedPriorLeg } from "@tools/evm-chains/dependent-leg-gas-estimate.js";
import type { UniswapToken } from "@tools/uniswap/types.js";
import type { ChainWallet } from "@tools/wallet/multi-auth.js";
import {
  createAgentActivityIntent,
  confirmActivityEvent,
  type AgentActivityEvent,
} from "@vex-agent/db/repos/agent-activity.js";
import { resolveSelectedAddress, resolveSigningWallet, walletScopeErrorToResult } from "@vex-agent/tools/internal/wallet/resolve.js";
import logger from "@utils/logger.js";
import { noteHandlerPendingReason } from "@vex-agent/tools/protocols/runtime/pending-provenance.js";

import type { ToolResult } from "../../../../types.js";
import type { ProtocolExecutionContext } from "../../../types.js";
import { str, fail } from "../../../handler-helpers.js";
import { TOOL_ID, PROTOCOL } from "./protocol-id.js";
import { requireDeployment, routerFor } from "./deployment.js";
import { resolveUniswapToken } from "./token-resolution.js";
import { resolveUniswapSlippageBps } from "./slippage.js";
import { computeQuote, type QuotedRoute } from "./route-quote.js";
import { uniswapFailureMessage } from "./error-output.js";
import { failPreBroadcast, abortRemainingPlans } from "./activity-recording.js";
import { buildTxForEvent, describeEventRole, planSwapEvents } from "./execute-plan.js";
import { runStagedBroadcast } from "./execute-broadcast.js";
import { finalizeConfirmedSwap, type FinalizeConfirmedSwapOutcome } from "./finalize-confirmed.js";
import { checkForbiddenFeeParams } from "./forbidden-params.js";
import { resolveUniswapFeeCharge, type UniswapFeeCharge } from "@tools/uniswap/fee/index.js";
import {
  planUniswapFeeLeg,
  runUniswapFeeLeg,
  uniswapFeeNotAttempted,
  uniswapFeeNotCharged,
  withFeeDisclosure,
  type UniswapFeeCollection,
  type UniswapFeeLegPlan,
} from "./fee/index.js";
import { VexError, ErrorCodes } from "../../../../../../errors.js";
import { claimUniswapExecutionSnapshot } from "../../../prequote/claim.js";
import { canonicalWrapPairRefusal } from "../../../wrap-pair-refusal.js";
import {
  compareUniswapExecutionInputs,
  floorUnreachableRefusal,
} from "../../../quote-authority/uniswap.js";
import { executionInputsFrom } from "./execution-binding.js";
import {
  ambiguousBroadcastResult,
  preSignRefusalResult,
  minedRevertResult,
  postIntentFailureResult,
} from "./execute-failure.js";

export async function executeUniswapSwap(
  p: Record<string, unknown>,
  context: ProtocolExecutionContext,
): Promise<ToolResult> {
  // C24 (Codex final-review round 1, finding 8): the manifest declares no
  // `dryRun` param (five-field contract is final) — a caller that still
  // passes it must NEVER reach a real broadcast just because the runtime's
  // spine-inherited `previewSupport:true` matrix row treated the call as a
  // preview (`RESERVED_RUNTIME_PARAM_KEYS` always accepts `dryRun` regardless
  // of manifest declaration, so the boundary check alone is not sufficient).
  if (p.dryRun === true) {
    return fail(`${TOOL_ID} does not support dryRun preview - call uniswap__swap_quote instead.`);
  }

  // Vex's fee rate and receiver are product constants — a caller-supplied one
  // is surfaced by name, never dropped, and never reaches a durable row.
  const forbidden = checkForbiddenFeeParams(p);
  if (forbidden) return fail(forbidden);

  const chain = str(p, "chain"), tokenInRaw = str(p, "tokenIn"), tokenOutRaw = str(p, "tokenOut"), amountInRaw = str(p, "amountIn");
  if (!chain || !tokenInRaw || !tokenOutRaw || !amountInRaw) return fail("Missing required: chain, tokenIn, tokenOut, amountIn");

  // Vex's slippage ceiling — pure, and BEFORE the session/chain/wallet steps so
  // an out-of-range tolerance never reaches a durable row or a signing key.
  const slippage = resolveUniswapSlippageBps(TOOL_ID, p);
  if (!slippage.ok) return fail(slippage.reason);
  const slippageBps = slippage.bps;

  // The prequote gate (executeProtocolTool) already blocks this tool without a
  // session — sessionId is guaranteed present here.
  const sessionId = context.sessionId;
  if (!sessionId) return fail(`${TOOL_ID} requires an active session.`);

  // Step 1 — resolve the chain. No wallet/chain known yet on failure, so no
  // durable row is written (same treatment as a param-validation failure).
  const deployment = requireDeployment(chain);

  // Step 2 (C22-equivalent for Uniswap) — address-only wallet resolution
  // (NEVER decrypts) so a failure from here on CAN be durably recorded with
  // a real walletAddress. The signing key itself is resolved later.
  let walletAddress: string;
  try {
    walletAddress = resolveSelectedAddress(context.walletResolution, context.walletPolicy, "eip155");
  } catch (err) {
    return walletScopeErrorToResult(err);
  }

  let tokenIn: UniswapToken;
  let tokenOut: UniswapToken;
  try {
    tokenIn = await resolveUniswapToken(deployment, tokenInRaw);
    tokenOut = await resolveUniswapToken(deployment, tokenOutRaw);
  } catch (err) {
    return failPreBroadcast(p, { chainId: deployment.chainId, chainSlug: deployment.key, walletAddress, sessionId }, err);
  }

  // Structurally unroutable, and refused before anything durable is written:
  // both legs of this pair resolve to the same asset as far as the router is
  // concerned. Named, with the tool that does build the conversion.
  const wrapPair = canonicalWrapPairRefusal(deployment.chainId, tokenIn, tokenOut, TOOL_ID);
  if (wrapPair) return fail(wrapPair);

  // ── THE APPROVED QUOTE, claimed for exactly one execute ──
  //
  // Claimed BEFORE this handler quotes anything, so two concurrent executes of
  // one quote resolve to a single winner before either prices a route. Fresh
  // pathing below is allowed and expected - Uniswap's pools move - but the
  // router input, the fee and the floor come from THIS snapshot, never from the
  // fresh route. Deriving the floor from a fresh route is what let the sibling
  // venue fill a 313,879.7 quote at 1,190.145 on 2026-08-27 without reverting.
  const claimed = await claimUniswapExecutionSnapshot(TOOL_ID, sessionId, p, context, `${TOOL_ID}:${sessionId}`);
  if (!claimed.ok) {
    return failPreBroadcast(
      p,
      { chainId: deployment.chainId, chainSlug: deployment.key, walletAddress, sessionId, tokenIn, tokenOut },
      new VexError(ErrorCodes.KYBER_PRICE_FLOOR_VIOLATED, claimed.refusal.message),
    );
  }
  const approved = claimed.snapshot;

  let amountIn: bigint;
  let feeCharge: UniswapFeeCharge;
  let quoted: QuotedRoute;
  try {
    amountIn = parseUnits(amountInRaw, tokenIn.decimals);
    // BEFORE the quote, and deliberately: the route is priced for the amount
    // the router actually receives (`amountIn − fee`), and whether a fee
    // applies at all depends on a token fact the eligibility check owns.
    feeCharge = await resolveUniswapFeeCharge({ chainId: deployment.chainId, tokenIn, amountInRaw: amountIn });
    quoted = await computeQuote(deployment, tokenIn, tokenOut, feeCharge.swapAmountRaw, slippageBps);
  } catch (err) {
    return failPreBroadcast(
      p,
      { chainId: deployment.chainId, chainSlug: deployment.key, walletAddress, sessionId, tokenIn, tokenOut },
      err,
    );
  }

  // What the human approved, held against what this execute just resolved. A
  // fee that appeared, a fee that vanished, or a router input that moved is a
  // DIFFERENT trade, and the answer is to say which one moved - never to
  // quietly re-cut the amount or the fee so the swap fits.
  const drift = compareUniswapExecutionInputs(
    approved,
    executionInputsFrom({ chainId: deployment.chainId, tokenIn, tokenOut, charge: feeCharge }),
  );
  if (drift) {
    return failPreBroadcast(
      p,
      { chainId: deployment.chainId, chainSlug: deployment.key, walletAddress, sessionId, tokenIn, tokenOut },
      new VexError(ErrorCodes.KYBER_PRICE_FLOOR_VIOLATED, drift.message, drift.hint),
    );
  }

  // The APPROVED floor, written into the calldata below. The fresh route only
  // decides the PATH; if its own output cannot even reach the approved floor
  // the swap would revert on-chain for gas, so it is refused here instead.
  // This is not a zero-tolerance comparison: the floor already carries the full
  // slippage the human authorized, so ordinary movement inside it passes.
  const approvedMinOut = BigInt(approved.approvedMinOutRaw);
  if (quoted.amountOut < approvedMinOut) {
    const refusal = floorUnreachableRefusal(approved, quoted.amountOut);
    return failPreBroadcast(
      p,
      { chainId: deployment.chainId, chainSlug: deployment.key, walletAddress, sessionId, tokenIn, tokenOut },
      new VexError(ErrorCodes.KYBER_PRICE_FLOOR_VIOLATED, refusal.message, refusal.hint),
    );
  }
  quoted = { ...quoted, minAmountOut: approvedMinOut };

  // Per-session signing wallet — resolved only now that dryRun is rejected
  // and the quote succeeded, so a rejected/failed call never decrypts a key.
  let signer: ChainWallet;
  try {
    signer = resolveSigningWallet(context.walletResolution, context.walletPolicy, "eip155");
  } catch (err) {
    return walletScopeErrorToResult(err);
  }
  if (signer.family !== "eip155") return fail("Resolved wallet family mismatch.");

  const clients = getUniswapEvmClients(deployment, signer.privateKey as Hex);
  const router = routerFor(deployment, quoted.route);

  let currentAllowance = 0n;
  try {
    if (!tokenIn.isNative) {
      // The FULL requested amount, not the net: the user is debited the swap
      // leg AND the fee leg, and a balance that covers only the swap would
      // leave the fee to fail after the swap already spent the rest.
      await ensureErc20Balance(clients.publicClient, {
        token: tokenIn.address,
        owner: getAddress(signer.address),
        required: amountIn,
        decimals: tokenIn.decimals,
        label: tokenIn.symbol,
      });
      validateUniswapSpender(router);
      currentAllowance = await readUniswapAllowance(clients.publicClient, tokenIn.address, getAddress(signer.address), router);
    }
  } catch (err) {
    return failPreBroadcast(
      p,
      { chainId: deployment.chainId, chainSlug: deployment.key, walletAddress: signer.address, sessionId, tokenIn, tokenOut },
      err,
    );
  }

  // The swap legs are planned for the NET amount — that is what the router
  // pulls and what the approval must cover. The fee leg carries the remainder,
  // so the two rows sum to exactly what the user asked to spend.
  const swapAmount = feeCharge.swapAmountRaw;
  const events = planSwapEvents({
    deployment,
    walletAddress: signer.address,
    sessionId,
    tokenIn,
    tokenOut,
    amountIn: swapAmount,
    amountInHuman: formatUnits(swapAmount, tokenIn.decimals),
    quoted,
    currentAllowance,
    approvedMinOutRaw: approved.approvedMinOutRaw,
  });
  const swapLegCount = events.length;

  // LAST index, always — the fee is signed only after the swap confirms, and
  // an abort of "everything after leg i" must be able to reach it.
  const feePlan: UniswapFeeLegPlan | null = planUniswapFeeLeg({
    charge: feeCharge, deployment, tokenIn, walletAddress: signer.address, sessionId,
  });
  if (feePlan) events.push({ ...feePlan.event, eventIndex: swapLegCount });

  const { executionId, events: createdEvents } = await createAgentActivityIntent({
    toolId: TOOL_ID, namespace: PROTOCOL, intentParams: p, events,
  });
  const swapEvents = createdEvents.slice(0, swapLegCount);
  const feeRowId = feePlan ? createdEvents[swapLegCount]?.id ?? null : null;

  // Read-after-write anchor for the NEXT event: an allowance this loop just
  // confirmed is state the swap leg's pre-sign estimate depends on, and the
  // estimating node does not always have it yet (`dependent-leg-gas-estimate.ts`).
  let priorLeg: ConfirmedPriorLeg | undefined;
  let refusedRole: AgentActivityEvent["eventRole"] = "swap";
  try {
    // ONLY the swap's own legs. The fee row sits at `swapLegCount` and is
    // driven outside this loop — a revert or an abort in here must not be able
    // to reach it.
    for (let i = 0; i < swapEvents.length; i++) {
      const event = swapEvents[i]!;
      refusedRole = event.eventRole;
      const tx = buildTxForEvent(event, { deployment, router, tokenIn, tokenOut, amountIn: swapAmount, quoted, recipient: getAddress(signer.address) });
      // The swap leg alone carries an approved floor and an approved native
      // input, so the swap leg alone is fenced. Every value comes from the
      // CLAIMED snapshot and this deployment's own router - never from the
      // built transaction, which is the object being judged.
      const outcome = await runStagedBroadcast(
        event, tx, clients, describeEventRole(event.eventRole), priorLeg,
        event.eventRole === "swap"
          ? {
              expectedRouter: router,
              approvedMinOutRaw: approved.approvedMinOutRaw,
              expectedValueRaw: tokenIn.isNative ? approved.swapAmountRaw : "0",
            }
          : undefined,
      );

      if (outcome.kind === "ambiguous") {
        // C17: the events STRICTLY AFTER this one were NEVER signed — finalize
        // them (this event itself stays pending; ambiguity never terminalizes).
        const next = createdEvents[i + 1];
        if (next) {
          await abortRemainingPlans(executionId, next.eventIndex, `earlier ${event.eventRole} ambiguous`);
        }
        logger.info("uniswap.swap.execute.ambiguous", { id: event.id, txHash: outcome.txHash });
        // Migration 067: this outcome is unconditionally "we could not prove
        // inclusion" (see `execute-broadcast.ts`'s ambiguity mapping), so the
        // named reason is the confirm-side one, never the send-side one.
        await noteHandlerPendingReason(TOOL_ID, event.id, "broadcast_ambiguous_confirm");
        return ambiguousBroadcastResult({
          eventRole: event.eventRole, txHash: outcome.txHash, executionId, chainId: deployment.chainId,
        });
      }

      if (outcome.kind === "failed") {
        const next = createdEvents[i + 1];
        if (next) {
          await abortRemainingPlans(
            executionId, next.eventIndex,
            `earlier ${event.eventRole} reverted (${outcome.classification.failureCode})`,
          );
        }
        return outcome.stage === "pre_broadcast"
          ? preSignRefusalResult({
              eventRole: event.eventRole, classification: outcome.classification, slippageBps, executionId,
            })
          : minedRevertResult({ eventRole: event.eventRole, classification: outcome.classification, executionId });
      }

      // confirmed on-chain
      priorLeg = priorLegAnchorFrom(outcome.settledAtBlock);
      if (event.eventRole !== "swap") {
        try {
          await confirmActivityEvent(event.id, {});
        } catch (err) {
          // C16: bookkeeping-only — never propagated (the approval already succeeded).
          logger.warn("uniswap.swap.execute.confirm_failed", {
            id: event.id, role: event.eventRole,
            error: uniswapFailureMessage(err),
          });
        }
        continue;
      }

      const finalized = await finalizeConfirmedSwap({
        eventId: event.id,
        executionId,
        sessionId,
        deployment,
        walletAddress: signer.address,
        tokenIn,
        tokenOut,
        quoted,
        approvedMinOutRaw: approved.approvedMinOutRaw,
        receipt: outcome.receipt,
        txHash: outcome.txHash,
        publicClient: clients.publicClient,
      });

      // ── The fee leg, LAST, and only now that the swap is CONFIRMED ──
      return await attachVexFee({
        finalized, feeCharge, feePlan, feeRowId, executionId, swapLegCount,
        chainId: deployment.chainId, tokenDecimals: tokenIn.decimals, clients,
        priorLeg,
      });
    }

    // Unreachable — `createdEvents` always has at least the swap entry, and
    // the loop above returns on every branch. Kept for exhaustiveness.
    throw new Error("uniswap__swap_execute: staged broadcast loop exited without a result");
  } catch (err) {
    return postIntentFailureResult({ executionId, refusedRole, slippageBps, error: err });
  }
}

/**
 * Run the Vex fee leg after a CONFIRMED swap and attach its disclosure.
 * Nothing here can change whether the swap succeeded.
 *
 * TOTAL BY CONSTRUCTION — this function NEVER throws, and that is what keeps
 * the guarantee true rather than merely intended: the swap is already confirmed
 * on-chain by the time it is called, so an escape into the orchestrator's outer
 * catch would report a settled swap as failed. Both of its awaits are
 * non-throwing by contract (`abortRemainingPlans` is best-effort and returns
 * whether it applied; `runUniswapFeeLeg` documents "Never throws. Every path
 * returns a report."). Do not add a throwing call here.
 *
 * The fee base is the amount the user ASKED to spend — known exactly before the
 * swap ran and unaffected by what the settlement decoded — so a swap whose
 * amounts could not be decoded is still charged correctly.
 */
async function attachVexFee(x: {
  readonly finalized: FinalizeConfirmedSwapOutcome;
  readonly feeCharge: UniswapFeeCharge;
  readonly feePlan: UniswapFeeLegPlan | null;
  readonly feeRowId: number | null;
  readonly executionId: number;
  readonly swapLegCount: number;
  readonly chainId: number;
  readonly tokenDecimals: number;
  readonly clients: ReturnType<typeof getUniswapEvmClients>;
  readonly priorLeg: ConfirmedPriorLeg | undefined;
}): Promise<ToolResult> {
  const disclosure = x.feeCharge.disclosure;
  const attach = (collection: UniswapFeeCollection): ToolResult =>
    withFeeDisclosure({
      result: x.finalized.result,
      outputPayload: x.finalized.outputPayload,
      collection,
      disclosure,
    });

  // No fee applied at all — dust, or a token Vex declines to skim. There is no
  // row to finalize either, because none was ever planned.
  if (x.feePlan === null) {
    return attach(uniswapFeeNotCharged(disclosure.charged ? "no fee applies" : disclosure.reason));
  }
  // A fee DID apply but has no row to record it under. A different truth from
  // the line above, and the audit surface must tell them apart.
  if (x.feeRowId === null) {
    // Post-confirmation audit cleanup is BEST-EFFORT and never throws: the swap
    // is already confirmed on-chain, so a repository failure here is a
    // bookkeeping gap to DISCLOSE, never a reason to report it as failed.
    const cleanedUp = await abortRemainingPlans(x.executionId, x.swapLegCount, "the fee leg had no recorded row");
    return attach(
      uniswapFeeNotAttempted(
        cleanedUp
          ? "the fee leg had no recorded row, so nothing was signed"
          : "the fee leg had no recorded row, so nothing was signed; its audit rows could not be finalized either",
      ),
    );
  }

  const collection = await runUniswapFeeLeg({
    plan: x.feePlan,
    feeRowId: x.feeRowId,
    chainId: x.chainId,
    tokenDecimals: x.tokenDecimals,
    publicClient: x.clients.publicClient,
    walletClient: x.clients.walletClient,
    priorLeg: x.priorLeg,
  });
  return attach(collection);
}
