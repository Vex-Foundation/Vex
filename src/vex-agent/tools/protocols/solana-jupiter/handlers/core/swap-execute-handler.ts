/**
 * `solana.swap.execute` — the staged sign→persist→broadcast swap.
 *
 * Extracted verbatim from `../core.ts` as part of a façade-preserving
 * structural split. Execute writes durable truth DIRECTLY to `agent_activity`
 * via the K2 staged Solana seam (capture:"none" in mutation-matrix.ts) instead
 * of the legacy `_tradeCapture` pipeline.
 */

import { Keypair } from "@solana/web3.js";
import { requireJupiterResolvedTokenWithSafety } from "@tools/solana-ecosystem/jupiter/jupiter-tokens/service.js";
import { solanaExplorerUrl } from "@tools/solana-ecosystem/shared/solana-validation.js";
import {
  prepareFeeBearingJupiterSwap,
  buildJupiterFeePreview,
  jupiterFeePreviewSchema,
  type JupiterFeeSwapKnobs,
} from "@tools/solana-ecosystem/jupiter/jupiter-swaps/fee-swap.js";
import { assertExactInSwapMode, assertFeePolicyUnchanged } from "@tools/solana-ecosystem/jupiter/jupiter-swaps/fee-swap-revalidate.js";
import {
  appliedSlippageBps,
  classifyJupiterPreBroadcastRejection,
  jupiterPreBroadcastRefusalGuidance,
  observedPriceImpactFraction,
} from "@tools/solana-ecosystem/jupiter/jupiter-swaps/pre-broadcast-rejection-refusal.js";
import { buildSolanaSettlementRouteProvenance } from "@tools/solana-ecosystem/jupiter/jupiter-swaps/settlement-profile.js";
import {
  getSolanaConnection,
  prepareVersionedTx,
  type PreparedSolanaTx,
} from "@tools/solana-ecosystem/shared/solana-transaction.js";
import { walletScopeErrorToResult } from "@vex-agent/tools/internal/wallet/resolve.js";
import { findFreshMatchedSwapPrequote } from "@vex-agent/tools/protocols/swap-prequote.js";
import {
  createAgentActivityIntent,
  createAgentActivityPreBroadcastFailure,
  markActivitySolanaBroadcast,
  failActivityEvent,
  type AgentActivityFailureCode,
} from "@vex-agent/db/repos/agent-activity.js";
import { effectiveMaxSlippageBps } from "@vex-agent/tools/protocols/slippage-policy.js";
import { formatLamportsAsSol } from "@vex-agent/tools/protocols/amount-display.js";
import logger from "@utils/logger.js";

import { SOLANA_SYNTHETIC_CHAIN_ID } from "../../../../../../constants/solana-chain.js";
import type { ProtocolHandler } from "../../../types.js";
import type { ToolResult } from "../../../../types.js";
import { str, fail } from "../../../handler-helpers.js";
import { buildActivityTokenLeg } from "../../activity-token-leg.js";
import { broadcastStagedSolanaTx } from "../../staged-broadcast.js";
import { humanAmountToAtomic } from "./swap-amount.js";
import {
  SWAP_NAMESPACE,
  SWAP_PROTOCOL,
  jupiterSlippageViolation,
  resolveJupiterSwapKnobs,
  swapFailureMessage,
} from "./swap-policy.js";
import { walletAddress, walletSecret } from "./wallet-scope.js";

export const swapExecuteHandler: ProtocolHandler = async (p, ctx): Promise<ToolResult> => {
  const toolId = "solana.swap.execute";
  const inputRaw = str(p, "tokenIn"), outputRaw = str(p, "tokenOut");
  const amountInRaw = str(p, "amountIn");
  if (!inputRaw || !outputRaw || !amountInRaw) return fail("Missing required: tokenIn, tokenOut, amountIn");

  const slippageViolation = jupiterSlippageViolation(toolId, p);
  if (slippageViolation) return fail(slippageViolation);

  const sessionId = ctx.sessionId;
  if (!sessionId) return fail(`${toolId} requires an active session.`);

  // Resolve owner + signer BEFORE any provider call (5D-protocols p2) so a
  // session scope mismatch fails closed without an on-chain side effect.
  let addr: string, secret: Uint8Array;
  try {
    addr = walletAddress(p, ctx);
    secret = walletSecret(ctx);
  } catch (err) {
    return walletScopeErrorToResult(err);
  }

  let knobs: JupiterFeeSwapKnobs;
  try {
    knobs = resolveJupiterSwapKnobs(p);
  } catch (err) {
    return fail(`${toolId} failed: ${swapFailureMessage(err)}`);
  }

  const [{ token: inputToken }, { token: outputToken }] = await Promise.all([
    requireJupiterResolvedTokenWithSafety(inputRaw),
    requireJupiterResolvedTokenWithSafety(outputRaw),
  ]);
  const converted = humanAmountToAtomic("amountIn", amountInRaw, inputToken.decimals, inputToken.symbol);
  if (!converted.ok) return fail(`${toolId} failed: ${converted.reason}`);
  const amountRaw = converted.amountRaw;

  // R4: re-fetch the SAME fresh matched quote the prequote gate
  // (executeProtocolTool, BEFORE this handler runs) already proved exists.
  // The gate's hash match already proves every REQUEST param (mints,
  // amount, fee/tip/CU-strategy/DEX-filter/maxAccounts/wrap knobs) is
  // identical to the quote; what it CANNOT prove is that this fresh fee
  // derivation still lands on the same treasury ATA — that check runs
  // explicitly below, against the persisted preview read here.
  const matched = await findFreshMatchedSwapPrequote(toolId, sessionId, p, ctx);
  const persistedFeePreview = matched
    ? jupiterFeePreviewSchema.safeParse((matched.safetyDetail as Record<string, unknown>).feePreview)
    : undefined;
  if (!matched || !persistedFeePreview?.success) {
    return fail(`${toolId} failed: no matching fee-bearing quote found. Call solana.swap.quote first with the exact same params, then retry.`);
  }

  const connection = getSolanaConnection();
  const sharedEventFields = {
    eventRole: "swap" as const,
    protocol: SWAP_PROTOCOL,
    chainId: SOLANA_SYNTHETIC_CHAIN_ID,
    chainSlug: "solana",
    chainFamily: "solana" as const,
    walletAddress: addr,
    sessionId,
    // `buildActivityTokenLeg` (../../activity-token-leg.ts) owns the leg shape:
    // it adds the exact-decimal `amountHuman` sibling the activity feed
    // shows the agent as its primary human amount. The repo stores that
    // field verbatim and derives nothing, so omitting it leaves the row's
    // human amount null forever.
    tokenIn: buildActivityTokenLeg({
      tokenAddress: inputToken.address, tokenSymbol: inputToken.symbol,
      tokenDecimals: inputToken.decimals, amountRaw,
    }),
  };

  // Phase A (pre-intent): fresh /build + R4 shape revalidation. ANY failure
  // here is pre-broadcast — nothing has been signed or recorded yet. Per
  // K1's stage/error mapping table (validation.ts) every rejection at this
  // stage is `route_not_found`, the generic build-rejection bucket: what
  // remains are trade-SHAPE divergences (swap mode, fee destination), and
  // none of them is a slippage event the agent could answer by widening its
  // tolerance. The quote-to-quote price floor that used to file `slippage`
  // here was removed by owner decision — see `fee-swap-revalidate.ts`.
  const preBroadcastFail = async (failureCode: AgentActivityFailureCode, err: unknown): Promise<ToolResult> => {
    const reason = swapFailureMessage(err);
    const { executionId } = await createAgentActivityPreBroadcastFailure({
      toolId, namespace: SWAP_NAMESPACE, intentParams: p,
      event: {
        ...sharedEventFields,
        kind: "swap",
        eventIndex: 0,
        failureCode,
        failureReason: reason,
        // No output amount exists yet on a pre-broadcast failure — only the
        // token identity is known, so the leg carries no human amount.
        tokenOut: buildActivityTokenLeg({
          tokenAddress: outputToken.address, tokenSymbol: outputToken.symbol,
          tokenDecimals: outputToken.decimals,
        }),
      },
    });
    return { success: false, output: `${toolId} failed: ${reason}`, data: { _executionId: executionId } };
  };

  let prepared: Awaited<ReturnType<typeof prepareFeeBearingJupiterSwap>>;
  try {
    prepared = await prepareFeeBearingJupiterSwap({
      connection, inputMint: inputToken.address, outputMint: outputToken.address, amountRaw, taker: addr, knobs,
      inputDecimals: inputToken.decimals,
    });
  } catch (err) {
    return preBroadcastFail("route_not_found", err);
  }
  try {
    assertExactInSwapMode(prepared.raw);
  } catch (err) {
    return preBroadcastFail("route_not_found", err);
  }
  try {
    assertFeePolicyUnchanged(persistedFeePreview.data, prepared.feeMint, prepared.feeAccount);
  } catch (err) {
    return preBroadcastFail("route_not_found", err);
  }

  // Record the intent BEFORE signing. The settlement profile
  // (`jupiter-swaps/settlement-profile.ts`) is the row's OWN evidence of the
  // economics Vex approved — the tip the build-response guard certified, the
  // exact-in amount, the wrap knob — and is what later lets the K3 sweep
  // decode a native-SOL swap instead of leaving it pending forever. It is
  // omitted (never faked) when those facts cannot be stated honestly; the
  // sweep then falls back to the generic decoder.
  const routeProvenance = buildSolanaSettlementRouteProvenance({
    inputMint: inputToken.address,
    outputMint: outputToken.address,
    inputAmountRaw: amountRaw,
    approvedTipLamports: prepared.knobs.tipLamports,
    certifiedTip: prepared.submitTipProof?.describe() ?? null,
    wrapAndUnwrapSol: prepared.knobs.wrapAndUnwrapSol,
  });
  const { executionId, events } = await createAgentActivityIntent({
    toolId, namespace: SWAP_NAMESPACE, intentParams: p,
    events: [{
      ...sharedEventFields,
      kind: "swap",
      eventIndex: 0,
      tokenOut: buildActivityTokenLeg({
        tokenAddress: outputToken.address, tokenSymbol: outputToken.symbol,
        tokenDecimals: outputToken.decimals, amountRaw: prepared.raw.outAmount,
      }),
      // Vex's 25 bps, recorded as the exact token amount (migration 050
      // Part 2). This path fetches NO USD price, so `usd_vex_fee_est` is
      // NULL on every Jupiter swap row and would read as "Vex charged
      // nothing" if the amount were not here. Both figures come from
      // `fee-swap.ts`'s single exact bigint derivation — the same numbers
      // `assertFeePolicyUnchanged` re-checked and the approval preview
      // disclosed — so the fee shown, the fee charged and the fee recorded
      // are one value. `feeMint` IS the input mint by construction (the fee
      // is charged on the input side), which is why the input token's
      // symbol/decimals describe it.
      vexFee: {
        tokenAddress: prepared.feeMint,
        tokenSymbol: inputToken.symbol,
        tokenDecimals: inputToken.decimals,
        amountRaw: prepared.feeAmountRaw,
        amountHuman: prepared.feeAmountDecimal,
      },
      ...(routeProvenance ? { routeProvenance } : {}),
    }],
  });
  const eventRow = events[0]!;

  // Sign-only, VERIFY mode — the fresh `/build` response's OWN
  // `blockhashWithMetadata` is evidence tied to these exact bytes. A throw
  // here is a POST-INTENT failure: finalize the EXISTING row, never a
  // second intent (design R2).
  let signedTx: PreparedSolanaTx;
  try {
    const keypair = Keypair.fromSecretKey(secret);
    signedTx = await prepareVersionedTx(prepared.unsignedTx.serialize(), keypair, {
      knownBlockhash: { blockhash: prepared.recentBlockhash, lastValidBlockHeight: prepared.lastValidBlockHeight },
      connection,
    });
  } catch (err) {
    const reason = swapFailureMessage(err);
    await failActivityEvent(eventRow.id, { failureCode: "unknown", failureReason: reason });
    return {
      success: false,
      output: `${toolId} failed: ${reason} — recorded (execution ${executionId}); nothing was broadcast.`,
      data: { _executionId: executionId },
    };
  }

  // Persist signature + blockhash evidence BEFORE the submit call (CAS).
  const staged = await markActivitySolanaBroadcast(eventRow.id, {
    txHash: signedTx.signature,
    fromAddress: addr,
    recentBlockhash: signedTx.recentBlockhash,
    lastValidBlockHeight: signedTx.lastValidBlockHeight,
  });
  if (!staged.applied) {
    logger.warn(`${toolId}.staging_cas_miss`, { executionId, eventId: eventRow.id });
    return {
      success: false,
      output: `${toolId}: an internal error left this swap unrecorded before broadcast — refusing to submit untracked. Check execution ${executionId}; do not retry blindly.`,
      data: { _executionId: executionId },
    };
  }

  // Broadcast. The fee-bearing `/build` response is the ONE Solana path that
  // can carry a qualifying Jupiter tip, and `assertBuildResponseSafeToSign`
  // has already PROVEN it (recipient on the published allowlist, exact
  // approved amount) — that proof is what unlocks `/tx/v1/submit`. An
  // agent-approved zero tip yields no proof and lands over RPC instead of
  // being silently dropped. A signature mismatch or an ambiguous transport
  // failure NEVER terminalizes the row; the canonical local signature stays
  // and the Solana sweep (K3) resolves the row later.
  const broadcast = await broadcastStagedSolanaTx({
    toolId,
    rowId: eventRow.id,
    prepared: signedTx,
    lane: prepared.submitTipProof
      ? { kind: "jupiter_submit", tipProof: prepared.submitTipProof }
      : { kind: "rpc" },
  });
  if (broadcast.kind === "rejected_before_broadcast") {
    // The landing service ANSWERED and refused: nothing went on-chain.
    // Reporting this as "pending confirmation" would be a lie. The row still
    // stays pending — the sweep owns terminality (design D4).
    //
    // When the node named a program error we can PLACE (`pre-broadcast-
    // rejection-refusal.ts`), the agent gets the remedy instead of a stop
    // order: a refusal an autonomous agent cannot act on strands the mission
    // (plan rule 8). Anything we cannot identify keeps the conservative
    // wording below — an invented remedy is the failure being fixed here.
    const rejection = classifyJupiterPreBroadcastRejection(
      broadcast.cause,
      prepared.raw.swapInstruction.programId,
    );
    return {
      success: false,
      output: rejection
        ? `${toolId}: ${jupiterPreBroadcastRefusalGuidance({
          rejectionReason: broadcast.reason,
          rejection,
          slippage: {
            appliedBps: appliedSlippageBps({
              providerEchoedBps: prepared.raw.slippageBps,
              requestedBps: knobs.slippageBps,
            }),
            maxBps: effectiveMaxSlippageBps(),
            // From the `/build` response this exact attempt signed, so the
            // impact quoted is the one the refused transaction carried.
            observedPriceImpactFraction: observedPriceImpactFraction(prepared.raw.priceImpactPct),
          },
        })} Recorded (execution ${executionId}).`
        : `${toolId}: this swap was rejected before broadcast — nothing went on-chain: ${broadcast.reason}. Recorded (execution ${executionId}); do not retry until the cause is fixed.`,
      data: {
        _executionId: executionId,
        status: "rejected_before_broadcast",
        reason: broadcast.reason,
      },
    };
  }

  const feePreview = buildJupiterFeePreview(prepared);
  return {
    success: false,
    output: `Swap broadcast (signature ${signedTx.signature}) — confirmation pending, tracked automatically. Do not retry.`,
    data: {
      _executionId: executionId,
      status: "pending",
      signature: signedTx.signature,
      explorerUrl: solanaExplorerUrl(signedTx.signature),
      inputToken: inputToken.symbol,
      outputToken: outputToken.symbol,
      // The lamport figures the AGENT reads this swap's cost from, each with
      // its SOL twin (rule 90). The twins are added HERE and not inside
      // `buildJupiterFeePreview`, because that builder lives under `src/tools`
      // and the twin owner (`protocols/amount-display.ts`) is under
      // `src/vex-agent` — `src/tools` must never import it (`check:boundaries`).
      // Raw lamports stay verbatim; SOL travels alongside, never instead.
      feePreview: {
        ...feePreview,
        approvedTipSol: formatLamportsAsSol(feePreview.tipLamports),
        priorityFeeSolEstimate: formatLamportsAsSol(feePreview.priorityFeeLamportsEstimate),
        ataRentSol: formatLamportsAsSol(feePreview.ataRentLamports),
      },
    },
  };
};

