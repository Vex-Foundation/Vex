/**
 * The wrap lane's own claim transaction and activity handle.
 *
 * Structurally the same shape as the generic transaction lane's writer - one
 * transaction under the session control lock that claims the intent and creates
 * both durable rows, committing BEFORE anything is signed - with two deliberate
 * differences:
 *
 *  1. THE ROWS CARRY LEGS. The transaction lane writes a legless row because it
 *     did not build the proposal and cannot prove what it moves. A wrap is the
 *     opposite: the conversion is exactly 1:1 by the contract's construction, so
 *     both legs are known at prepare time and the same single `amountRaw`
 *     describes each. `roleLegsIncomplete` puts wrap and unwrap on the
 *     both-legs arm, and `confirmActivityEvent` THROWS on a wrap row confirmed
 *     without both executed amounts, so writing them is not optional.
 *  2. THERE IS NO FEE EVENT, and no parameter through which one could be
 *     passed. Migration 088's kind/role binding admits exactly `wrap` and
 *     `unwrap` under `kind = 'wrap'` and no fee role, so a fee leg here is a
 *     database impossibility; this signature is the compile-time half of the
 *     same statement.
 *
 * LOCK ORDER, inherited and load-bearing: nonce owner -> session control lock.
 * Nothing here may acquire a nonce owner while holding the session control
 * lock, which is why the claim transaction commits before `signStageBroadcast`
 * runs and the nonce reservation happens inside that call's hooks.
 */

import type { PoolClient } from "pg";

import {
  createPendingActivityEvent,
  markActivityBroadcast,
  markBroadcastAccepted,
  reserveActivityEvmNonce,
  type AgentActivityLegInput,
} from "@vex-agent/db/repos/agent-activity.js";
import { createExecutionIntent } from "@vex-agent/db/repos/executions.js";
import { withSessionControlLock } from "@vex-agent/engine/runtime/lease-and-status/session-control-lock.js";
import * as wrapIntentsRepo from "@vex-agent/db/repos/wallet-wrap-intents.js";
import type { WalletWrapIntent } from "@vex-agent/db/repos/wallet-wrap-intents.js";
import logger from "@utils/logger.js";

import { summarizeWalletError } from "../send-types.js";
import type { WrapOutcome, WrapRefusal } from "./refusal.js";

const TOOL_ID = "wallet_wrap_confirm";
const NAMESPACE = "wallet";

/**
 * `agent_activity.protocol`, and the ROUTING KEY of the settlement fallback
 * sweep's venue dispatch. A wrap belongs to no venue: no aggregator, no router,
 * no counterparty. The value is deliberately not a chain or a venue name.
 */
export const WRAP_PROTOCOL = "wallet_wrap" as const;

/**
 * The address every EVM lane in this repository uses to mean "the chain's own
 * native currency". The AgentScan mapper normalizes this and the zero address
 * to this same sentinel on the way out.
 */
const EVM_NATIVE_SENTINEL = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

export interface WrapActivity {
  readonly executionId: number;
  readonly activityId: number;
  readonly startedAtMs: number;
  reserveEvmNonce(input: {
    readonly fromAddress: string;
    readonly chainId: number;
    readonly nodePendingNonce: number;
  }): Promise<number>;
  /** THROWS on a CAS miss: the caller must abort rather than broadcast untracked. */
  stageEvm(handles: {
    readonly txHash: string;
    readonly fromAddress: string;
    readonly nonce: number;
  }): Promise<void>;
  /** Best-effort `broadcast_at` bookkeeping once the RPC accepted the submission. */
  noteAccepted(): Promise<void>;
}

export type WrapClaim =
  | { readonly ok: true; readonly intent: WalletWrapIntent; readonly activity: WrapActivity }
  | { readonly ok: false; readonly reason: "race_lost" | "write_failed"; readonly detail: string }
  | { readonly ok: false; readonly reason: "fence_refused"; readonly refusal: WrapRefusal };

/** The chain's native currency, needed to label the native leg honestly. */
export interface WrapNativeCurrency {
  readonly symbol: string;
  readonly decimals: number;
}

/**
 * Both legs of the conversion, in the order the row records them.
 *
 * ONE amount describes both sides: the contract converts 1:1, and recording two
 * independently would create two sources of truth for a single quantity.
 */
function legsOf(
  intent: WalletWrapIntent,
  native: WrapNativeCurrency,
  amountHuman: string,
): { readonly tokenIn: AgentActivityLegInput; readonly tokenOut: AgentActivityLegInput } {
  const nativeLeg: AgentActivityLegInput = {
    tokenAddress: EVM_NATIVE_SENTINEL,
    tokenSymbol: native.symbol,
    tokenDecimals: native.decimals,
    amountRaw: intent.amountRaw,
    amountHuman,
  };
  const wrappedLeg: AgentActivityLegInput = {
    tokenAddress: intent.contract.address,
    tokenSymbol: intent.contract.symbol,
    tokenDecimals: intent.contract.decimals,
    amountRaw: intent.amountRaw,
    amountHuman,
  };
  return intent.direction === "wrap"
    ? { tokenIn: nativeLeg, tokenOut: wrappedLeg }
    : { tokenIn: wrappedLeg, tokenOut: nativeLeg };
}

function intentParamsOf(intent: WalletWrapIntent): Record<string, unknown> {
  return {
    intentId: intent.intentId,
    chain: intent.chainAlias,
    chainId: intent.chainId,
    direction: intent.direction,
    wrappedNativeAddress: intent.contract.address,
    amountRaw: intent.amountRaw,
  };
}

/**
 * Claim the intent and create both durable rows in ONE transaction that commits
 * before anything is signed.
 *
 * `fence` runs as the FIRST statement inside that transaction so the authority
 * recheck and the claim commit or roll back together: there is no instant in
 * which the fence passed and the claim then committed under an authority the
 * user had already replaced.
 */
export async function claimWrapIntent(
  intent: WalletWrapIntent,
  approvedProposalDigest: string,
  native: WrapNativeCurrency,
  amountHuman: string,
  fence: (client: PoolClient) => Promise<WrapOutcome<void>>,
): Promise<WrapClaim> {
  const startedAtMs = Date.now();

  try {
    return await withSessionControlLock(intent.sessionId, async (client: PoolClient) => {
      const fenced = await fence(client);
      if (!fenced.ok) {
        return { ok: false as const, reason: "fence_refused" as const, refusal: fenced.refusal };
      }

      const claimed = await wrapIntentsRepo.claimIfPendingWith(
        client,
        intent.intentId,
        intent.sessionId,
        approvedProposalDigest,
      );
      if (claimed === null) {
        return {
          ok: false as const,
          reason: "race_lost" as const,
          detail:
            "the intent was not pending, not owned by this session, already expired, or its "
            + "proposal digest is not the one that was approved",
        };
      }

      const executionId = await createExecutionIntent(
        TOOL_ID,
        NAMESPACE,
        claimed.sessionId,
        intentParamsOf(claimed),
        client,
      );
      if (executionId <= 0) {
        throw new Error("wallet_wrap: execution intent insert returned no id");
      }

      const legs = legsOf(claimed, native, amountHuman);
      const event = await createPendingActivityEvent(
        {
          protocolExecutionId: executionId,
          eventIndex: 0,
          eventRole: claimed.direction,
          kind: "wrap",
          protocol: WRAP_PROTOCOL,
          chainId: claimed.chainId,
          chainSlug: claimed.chainAlias,
          chainFamily: "eip155",
          walletAddress: claimed.walletAddress,
          sessionId: claimed.sessionId,
          tokenIn: legs.tokenIn,
          tokenOut: legs.tokenOut,
        },
        client,
      );

      const stamped = await wrapIntentsRepo.stampActivityWith(
        client,
        claimed.intentId,
        claimed.sessionId,
        String(event.id),
      );
      if (stamped === null) {
        // Unreachable in a sound system: this row moved to `consuming` inside
        // this same transaction and nothing else can see it yet. A hard abort
        // rather than a warning, because an unlinked claim is precisely the
        // state crash recovery cannot resolve.
        throw new Error("wallet_wrap: activity stamp missed inside the claim transaction");
      }

      return {
        ok: true as const,
        intent: stamped,
        activity: makeHandle(executionId, event.id, startedAtMs),
      };
    });
  } catch (cause) {
    const sum = summarizeWalletError(cause);
    logger.warn("wallet.wrap.claim_failed", {
      intentId: intent.intentId,
      sessionId: intent.sessionId,
      ...sum,
    });
    return { ok: false, reason: "write_failed", detail: `${sum.errorKind}:${sum.errorHash}` };
  }
}

function makeHandle(executionId: number, activityId: number, startedAtMs: number): WrapActivity {
  return {
    executionId,
    activityId,
    startedAtMs,

    reserveEvmNonce: (input) => reserveActivityEvmNonce(activityId, input),

    async stageEvm(handles) {
      const res = await markActivityBroadcast(activityId, {
        txHash: handles.txHash,
        fromAddress: handles.fromAddress,
        nonce: handles.nonce,
      });
      if (!res.applied) {
        throw new Error(
          `agent_activity: markActivityBroadcast CAS miss for event ${activityId} - refusing to broadcast untracked`,
        );
      }
    },

    async noteAccepted() {
      try {
        const res = await markBroadcastAccepted(activityId);
        if (!res.applied) logger.warn("wallet.wrap.activity_accept_miss", { activityId });
      } catch (err) {
        logger.warn("wallet.wrap.activity_accept_failed", {
          activityId,
          ...summarizeWalletError(err),
        });
      }
    },
  };
}
