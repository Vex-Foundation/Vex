/**
 * Phase B of `kyberswap.swap.execute` (post-intent): the staged broadcast
 * loop. The intent + event rows ALREADY EXIST when this runs — C18 (Codex
 * final-review finding 3): a failure from here on must NEVER create a second
 * execution. It aborts the remaining never-signed rows instead and returns
 * with the SAME `_executionId` (see `execute-failure.ts`).
 */

import {
  signStageBroadcast,
  decodeKyberSwapSettlement,
  getKyberEvmClients,
  type StagedBroadcastOutcome,
} from "@tools/kyberswap/evm-utils.js";
import { priorLegAnchorFrom, type ConfirmedPriorLeg } from "@tools/evm-chains/dependent-leg-gas-estimate.js";
import { getLocalChain } from "@tools/evm-chains/registry.js";
import type { ResolvedKyberTokenMetadata } from "@tools/kyberswap/helpers.js";
import type { KyberChainSlug } from "@tools/kyberswap/types.js";
import logger from "@utils/logger.js";
import {
  markActivityBroadcast,
  markBroadcastAccepted,
  confirmActivityEvent,
  failActivityEvent,
} from "@vex-agent/db/repos/agent-activity.js";
import { pinTrackedToken } from "@vex-agent/db/repos/tracked-tokens.js";
import {
  MINED_REVERT_SWAP_LEG_REASON,
  minedRevertApprovalLegReason,
} from "@vex-agent/tools/protocols/runtime/mined-revert-reason.js";
import { formatUnits, type Address } from "viem";
import { sanitizeProviderNote } from "../../helpers.js";
import type { ToolResult } from "../../../../types.js";
import { abortRemainingPlans } from "./activity-recording.js";
import { tryGetWrappedNativeAddress } from "./chain-native.js";
import { kyberFailureMessage } from "./error-output.js";
import { buildPostIntentFailureResult } from "./execute-failure.js";
import type { PreparedSwapExecution } from "./execute-plan.js";
import { revealOnSwapMinedRevert } from "./reveal-messaging.js";

export interface SwapBroadcastInput {
  readonly toolId: string;
  readonly prepared: PreparedSwapExecution;
  readonly publicClient: ReturnType<typeof getKyberEvmClients>["publicClient"];
  readonly walletClient: ReturnType<typeof getKyberEvmClients>["walletClient"];
  readonly walletAddress: Address;
  readonly sessionId: string;
  readonly chainId: number;
  readonly slug: KyberChainSlug;
  readonly tokenIn: ResolvedKyberTokenMetadata;
  readonly tokenOut: ResolvedKyberTokenMetadata;
  readonly tokenInLabel: string;
  readonly tokenOutLabel: string;
  readonly slippage: number;
}

export async function runStagedSwapBroadcast(input: SwapBroadcastInput): Promise<ToolResult> {
  const {
    toolId, prepared, publicClient, walletClient, walletAddress, sessionId,
    chainId, slug, tokenIn, tokenOut, tokenInLabel, tokenOutLabel, slippage,
  } = input;
  const { executionId, events, plans, buildResp } = prepared;

  let currentIndex = 0;
  // Read-after-write anchor for the NEXT leg: an allowance this loop just
  // confirmed is state the swap leg's pre-sign estimate depends on, and the
  // estimating node does not always have it yet (see
  // `dependent-leg-gas-estimate.ts`).
  let priorLeg: ConfirmedPriorLeg | undefined;
  // Per-leg, reset every iteration. The discriminator the failure handler
  // needs — "did we submit anything for THIS step", never "was there an
  // allowance leg" — so a post-broadcast failure can never inherit the
  // pre-sign refusal's "nothing was signed" wording.
  let legBroadcastAttempted = false;
  try {
    for (let i = 0; i < plans.length; i++) {
      currentIndex = i;
      legBroadcastAttempted = false;
      const plan = plans[i]!;
      const eventRow = events[i]!;
      const outcome: StagedBroadcastOutcome = await signStageBroadcast(
        publicClient, walletClient, plan.txParams,
        {
          onHashStaged: async (handles) => {
            // Reached only AFTER this leg is signed and immediately before
            // `sendRawTransaction` — past this point the leg can no longer
            // claim pre-sign safety.
            legBroadcastAttempted = true;
            const res = await markActivityBroadcast(eventRow.id, handles);
            if (!res.applied) {
              // C14 (Codex final-review finding 1): a CAS miss means this
              // row is no longer in the state we expect — refuse to
              // broadcast an UNTRACKED transaction. Throwing here aborts
              // `signStageBroadcast` BEFORE `sendRawTransaction` runs.
              throw new Error(`agent_activity: markActivityBroadcast CAS miss for event ${eventRow.id} — refusing to broadcast untracked`);
            }
          },
          onAccepted: async () => {
            const res = await markBroadcastAccepted(eventRow.id);
            if (!res.applied) logger.warn("kyberswap.swap.execute.broadcast_accept_miss", { id: eventRow.id });
          },
        },
        priorLeg,
      );

      if (outcome.kind === "ambiguous") {
        logger.info("kyberswap.swap.execute.ambiguous", { id: eventRow.id, stage: outcome.stage, txHash: outcome.txHash });
        await abortRemainingPlans(executionId, i + 1, `earlier ${plan.eventRole} ambiguous`);
        return {
          success: false,
          // "Do not retry" is the safety-critical half and never moves. The
          // second half gives the agent a READ it can perform itself instead
          // of waiting on the sweep — the alternative to waiting must never
          // be a re-broadcast.
          output: `${toolId}: broadcast of the ${plan.eventRole} transaction (${outcome.txHash}) could not be confirmed yet — it may still settle on-chain. Do not retry; this attempt is recorded as pending and will resolve automatically. You can verify it now yourself with chain_read (action tx_receipt, chainId=${chainId}, txHash=${outcome.txHash}).`,
          data: { _executionId: executionId, txHash: outcome.txHash, status: "pending" },
        };
      }

      if (outcome.kind === "reverted") {
        await failActivityEvent(eventRow.id, {
          failureCode: "mined_revert",
          // Per-role: the price-guard remedy is TRUE for the swap leg and
          // FALSE for an approve (no minimum-output guard exists on one).
          // Owner: `runtime/mined-revert-reason.ts`. The tx hash is not
          // repeated — the row's own `tx_hash` column carries it, and the
          // repo boundary masks hash-shaped text anyway.
          failureReason: plan.eventRole === "swap"
            ? MINED_REVERT_SWAP_LEG_REASON
            : minedRevertApprovalLegReason(plan.eventRole),
        });
        await abortRemainingPlans(executionId, i + 1, `earlier ${plan.eventRole} reverted`);
        // REVISION 1 R1: reveal ONLY for the swap leg (never allowance/allowance_reset).
        const revealSuffix = revealOnSwapMinedRevert(plan.eventRole, sessionId);
        return {
          success: false,
          output: `${toolId}: the ${plan.eventRole} transaction (${outcome.txHash}) reverted on-chain. No further steps were attempted.${revealSuffix}`,
          data: { _executionId: executionId, txHash: outcome.txHash, status: "reverted" },
        };
      }

      // confirmed on-chain — from here on, a DB hiccup while RECORDING the
      // outcome must never be mistaken for the swap itself failing (funds
      // already moved). `confirmActivityEvent` throws only forwarded via
      // this bounded try/catch — logged, not propagated to the outer
      // post-intent failure handler.
      priorLeg = priorLegAnchorFrom(outcome.receipt.blockNumber);
      if (plan.eventRole !== "swap") {
        try {
          await confirmActivityEvent(eventRow.id, {});
        } catch (err) {
          logger.warn("kyberswap.swap.execute.confirm_failed", { id: eventRow.id, role: plan.eventRole, error: kyberFailureMessage(toolId, err) });
        }
        continue;
      }

      // Auto-pin (fail-soft) — Codex final-review round 4, finding 3: runs
      // IMMEDIATELY after on-chain confirmation, BEFORE decoding, so a
      // confirmed-but-undecodable settlement can never skip it (the acquired
      // ERC-20 must join tracked_tokens or balance scans miss it forever).
      // Token-in (spent) is deliberately NOT pinned. Never fails the swap.
      if (!tokenOut.isNative && getLocalChain(chainId)) {
        try {
          await pinTrackedToken({ walletAddress, chainId, tokenAddress: tokenOut.address, source: "swap" });
        } catch (err) {
          logger.warn("kyberswap.swap.execute.auto_pin_failed", { chain: slug, error: err instanceof Error ? err.name : "unknown" });
        }
      }

      // Bounded (Codex final-review round 2, finding 4 / C32): the receipt
      // is ALREADY confirmed on-chain at this point, so a throw from the
      // decoder itself must never escape to the post-intent failure handler —
      // that branch returns a generic result WITHOUT `outcome.txHash`
      // (`execute-failure.ts`), which would silently lose the known hash for
      // a swap that genuinely succeeded. `swap-settlement.ts` already guards
      // its own malformed-log parsing (C32), so this catch is
      // defense-in-depth for any other unexpected decode failure; either
      // way, a caught throw here is treated exactly like a `null` decode —
      // it falls through to the SAME "confirmed_pending_amounts" branch,
      // which already preserves the tx hash.
      let decoded: ReturnType<typeof decodeKyberSwapSettlement>;
      try {
        decoded = decodeKyberSwapSettlement({
          logs: outcome.receipt.logs.map((l) => ({ address: l.address, topics: l.topics as string[], data: l.data })),
          walletAddress,
          tokenIn: { isNative: tokenIn.isNative, address: tokenIn.address },
          tokenOut: { isNative: tokenOut.isNative, address: tokenOut.address },
          // C21: the SIGNED transaction's own declared value — never a
          // locally re-derived amount.
          nativeAmountInRaw: tokenIn.isNative ? buildResp.data.transactionValue : undefined,
          // Defensive: a lookup failure here must DECLINE the decode (→ the
          // "confirmed_pending_amounts" branch below), never throw — the swap
          // already broadcast and confirmed on-chain by this point, so an
          // uncaught throw would wrongly route to the post-intent failure
          // handler while this real row sits pending forever.
          wrappedNativeAddress: tokenOut.isNative ? tryGetWrappedNativeAddress(slug) : undefined,
          // C21: bind the WETH Withdrawal event to the VERIFIED router this
          // specific transaction used (never an unbound sum).
          wrappedNativeWithdrawalSource: tokenOut.isNative ? buildResp.data.routerAddress : undefined,
        });
      } catch (err) {
        logger.warn("kyberswap.swap.execute.settlement_decode_threw", {
          id: eventRow.id,
          txHash: outcome.txHash,
          error: kyberFailureMessage(toolId, err),
        });
        decoded = null;
      }

      if (!decoded) {
        logger.warn("kyberswap.swap.execute.settlement_undecodable", { id: eventRow.id, txHash: outcome.txHash });
        return {
          success: true,
          output: `${toolId}: swap confirmed on-chain (tx ${outcome.txHash}) but the executed amounts could not be decoded yet — check the transaction hash for the exact amounts. The record will finalize automatically.`,
          data: { _executionId: executionId, txHash: outcome.txHash, status: "confirmed_pending_amounts" },
        };
      }

      // C33 (Codex final-review round 2, finding 5): a failed WRITE here
      // must never be reported to the agent as an ordinary "confirmed"
      // swap — the chain-side settlement is real, but Vex's own record of
      // it did not persist. Tracked so the returned `status` can say so
      // (mirrors Uniswap's `confirmed_unrecorded` distinction).
      let confirmWriteFailed = false;
      try {
        const confirmResult = await confirmActivityEvent(eventRow.id, {
          executedAmountInHuman: formatUnits(BigInt(decoded.amountInRaw), tokenIn.decimals),
          executedAmountInRaw: decoded.amountInRaw,
          executedAmountOutHuman: formatUnits(BigInt(decoded.amountOutRaw), tokenOut.decimals),
          executedAmountOutRaw: decoded.amountOutRaw,
        });
        // C41 (Codex final-review round 3, finding 6): `.applied` was
        // previously ignored — a CAS miss (the row was no longer `pending`
        // when the UPDATE ran) still fell through as an ordinary
        // "confirmed" result. Recorded confirmation now requires EITHER a
        // fresh CAS-applied write, OR the row already being `confirmed`
        // with the SAME executed amounts we just tried to write (a benign
        // race — e.g. a concurrent repair-sweep pass already recorded this
        // exact outcome). Any other terminal state, or a confirmed row
        // with DIFFERENT amounts (a genuine conflict), is never reported
        // as recorded.
        if (!confirmResult.applied) {
          const alreadyMatches =
            confirmResult.row.status === "confirmed"
            && confirmResult.row.executedAmountInRaw === decoded.amountInRaw
            && confirmResult.row.executedAmountOutRaw === decoded.amountOutRaw;
          if (!alreadyMatches) {
            confirmWriteFailed = true;
            logger.warn("kyberswap.swap.execute.confirm_cas_miss", {
              id: eventRow.id,
              rowStatus: confirmResult.row.status,
            });
          }
        }
      } catch (err) {
        confirmWriteFailed = true;
        logger.warn("kyberswap.swap.execute.confirm_failed", { id: eventRow.id, error: kyberFailureMessage(toolId, err) });
      }

      // C34 (Codex final-review round 2, finding 6): the SUCCESS message's
      // input amount must be the DECODED executed amount, not the
      // requested `amountIn` echoed back — the whole point of net-delta
      // decoding is that the executed amount can differ from the request
      // (fee-on-transfer legs, dust, partial fills upstream); reporting the
      // request would contradict the persisted truth.
      const amountInHuman = formatUnits(BigInt(decoded.amountInRaw), tokenIn.decimals);
      const amountOutHuman = formatUnits(BigInt(decoded.amountOutRaw), tokenOut.decimals);
      // Output-polish (plan §4.2): compact human summary FIRST, machine
      // fields after — one JSON key ordering (see the quote handler's same
      // convention note).
      const summary =
        `Swapped ${amountInHuman} ${tokenInLabel} → ${amountOutHuman} ${tokenOutLabel} on ${slug}. `
        + `Tx: ${outcome.txHash}` + (buildResp.data.amountInUsd ? ` (~$${buildResp.data.amountInUsd} in / ~$${buildResp.data.amountOutUsd} out, estimated).` : ".");

      // The build response's own cost disclosure was validated and then
      // dropped: `additionalCostUsd` is a real charge on this settlement
      // (gaslessness/positive-slippage handling), and the provider's
      // message explains it. Both are provider-authored, so the prose goes
      // through `sanitizeProviderNote` (control chars only — never
      // truncated) before it reaches model context.
      const additionalCostMessage = sanitizeProviderNote(buildResp.data.additionalCostMessage);
      const successData = {
        summary,
        chain: slug, chainId,
        txHash: outcome.txHash,
        tokenIn: tokenInLabel,
        tokenOut: tokenOutLabel,
        amountIn: amountInHuman,
        amountOut: amountOutHuman,
        ...(buildResp.data.additionalCostUsd
          ? { additionalCostUsd: buildResp.data.additionalCostUsd }
          : {}),
        ...(additionalCostMessage ? { additionalCostMessage } : {}),
        // C33: a failed confirm-write means Vex's own record of the
        // (real, on-chain) settlement did not persist — never claim
        // ordinary "confirmed".
        status: confirmWriteFailed ? "confirmed_unrecorded" : "confirmed",
        _executionId: executionId,
        _explorerRefs: [{ chain: slug, txRef: outcome.txHash }],
      };
      return { success: true, output: JSON.stringify(successData), data: successData };
    }

    // Unreachable — `plans` always has at least the swap entry, and the loop
    // above returns on every branch. Kept for exhaustiveness/type-safety.
    throw new Error("kyberswap.swap.execute: staged broadcast loop exited without a result");
  } catch (err) {
    return buildPostIntentFailureResult({
      err,
      toolId,
      sessionId,
      executionId,
      currentIndex,
      legBroadcastAttempted,
      plans,
      events,
      slippage,
    });
  }
}
