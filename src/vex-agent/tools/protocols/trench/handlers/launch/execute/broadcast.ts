/**
 * The launch BROADCAST and SETTLEMENT steps.
 *
 * One reason to change: what happens between "we are allowed to sign" and "we
 * know what happened". The three outcomes are deliberately not symmetric:
 *
 *   CONFIRMED  decode the identity, write `launched_tokens` (the PRIMARY path —
 *              the identity-repair sweep is crash recovery, not the normal
 *              route), then charge the Vex fee LAST.
 *   REVERTED   fail the row, abort the fee leg. A launch that did not happen is
 *              never charged for.
 *   AMBIGUOUS  do NOTHING terminal. The intent keeps its hash at
 *              `broadcast_pending` for the repair sweep, and the fee is never
 *              signed. A launch marked failed is one a user may retry — and this
 *              create may already have minted their token.
 */

import { formatEther, type Address, type Chain, type PublicClient, type Transport, type WalletClient } from "viem";

import { TRENCH_CHAIN_ID, TRENCH_DIAMOND_ADDRESS } from "@tools/trench-express/constants.js";
import { signStageBroadcast, type StagedBroadcastOutcome } from "@tools/evm-chains/staged-broadcast.js";
import { withTransaction } from "@vex-agent/db/client.js";
import { acquireSessionControlLock } from "@vex-agent/engine/runtime/lease-and-status.js";
import { confirmWith, markBroadcastPendingWith } from "@vex-agent/db/repos/token-launch-intents.js";
import * as launchedTokens from "@vex-agent/db/repos/launched-tokens.js";
import {
  createAgentActivityIntent,
  markActivityBroadcast,
  markBroadcastAccepted,
  confirmActivityEvent,
  failActivityEvent,
  abortPlannedEvents,
} from "@vex-agent/db/repos/agent-activity.js";
import logger from "@utils/logger.js";
import type { ToolResult } from "../../../../../types.js";
import { fail } from "../../../../handler-helpers.js";
import { trenchFailureDetail } from "../../failure.js";
import type { LaunchPlan } from "../plan.js";
import { priorLegAnchorFrom } from "@tools/evm-chains/dependent-leg-gas-estimate.js";
import type { LaunchExecuteDeps } from "../fee-seam.js";
import { decodeLaunchReceipt } from "../settlement.js";
import { settleLaunchFailure } from "./authorize.js";
import type { ValidatedLaunchRequest } from "../validate.js";

const DIAMOND = TRENCH_DIAMOND_ADDRESS as Address;
const TOOL_ID = "trench.launch_execute";
const PROTOCOL = "trench";
const CHAIN_SLUG = "robinhood";
const NATIVE_ADDRESS = "0x0000000000000000000000000000000000000000" as Address;
const PREBUY_DECIMALS = 18;

function safeDetail(err: unknown): string {
  return trenchFailureDetail(TOOL_ID, err);
}

export interface BroadcastLaunchInput {
  readonly intentId: string;
  readonly sessionId: string;
  readonly walletAddress: Address;
  readonly plan: LaunchPlan;
  readonly request: ValidatedLaunchRequest;
  readonly params: Record<string, unknown>;
  readonly publicClient: PublicClient<Transport, Chain>;
  readonly walletClient: WalletClient<Transport, Chain>;
  readonly deps: LaunchExecuteDeps;
}

export async function broadcastLaunch(x: BroadcastLaunchInput): Promise<ToolResult> {
  const feeLeg = x.plan.feeLeg;

  // Durable activity BEFORE any broadcast — a crash mid-flight must leave a row,
  // not an invisible spend. The fee event is appended LAST so its row order
  // matches its broadcast order.
  let executionId: number;
  let launchRowId: number;
  let feeRowId: number | null = null;
  try {
    const created = await createAgentActivityIntent({
      toolId: TOOL_ID,
      namespace: PROTOCOL,
      intentParams: x.params,
      events: feeLeg
        ? [{ ...buildLaunchEvent(x), eventIndex: 0 }, { ...feeLeg.event, eventIndex: 1 }]
        : [{ ...buildLaunchEvent(x), eventIndex: 0 }],
    });
    executionId = created.executionId;
    launchRowId = created.events[0]!.id;
    feeRowId = feeLeg ? (created.events[1]?.id ?? null) : null;
  } catch (err) {
    await settleLaunchFailure(x.intentId, x.sessionId, `IntentWrite:${safeDetail(err)}`);
    return fail(`${TOOL_ID} failed before broadcasting: ${safeDetail(err)}. Nothing was signed.`);
  }

  let outcome: StagedBroadcastOutcome;
  try {
    outcome = await signStageBroadcast(x.publicClient, x.walletClient, x.plan.txParams, {
      onHashStaged: async (handles) => {
        const res = await markActivityBroadcast(launchRowId, handles);
        if (!res.applied) {
          throw new Error(
            `agent_activity: markActivityBroadcast CAS miss for event ${launchRowId} — refusing to broadcast untracked`,
          );
        }
        // Persist the SIGNED hash on the intent too. `markBroadcastPendingWith`
        // has `tx_hash IS NULL` in its predicate, so a retry can never overwrite
        // an already-staged hash — losing the first would destroy the only
        // evidence of a create that may already be mined.
        await withTransaction(async (client) => {
          await acquireSessionControlLock(client, x.sessionId);
          await markBroadcastPendingWith(client, x.intentId, x.sessionId, handles.txHash);
        });
      },
      onAccepted: async () => {
        const res = await markBroadcastAccepted(launchRowId);
        if (!res.applied) {
          logger.warn("trench.launch_execute.broadcast_accept_miss", { id: launchRowId });
        }
      },
    });
  } catch (err) {
    await abortRemaining(executionId, 0, safeDetail(err));
    await settleLaunchFailure(x.intentId, x.sessionId, `PreSign:${safeDetail(err)}`);
    return fail(
      `${TOOL_ID}: the launch was refused before signing — ${safeDetail(err)}. Nothing was signed.`,
    );
  }

  if (outcome.kind === "ambiguous") {
    logger.info("trench.launch_execute.ambiguous", { executionId, txHash: outcome.txHash });
    await abortRemaining(executionId, 1, "launch ambiguous — a fee is never charged for an unproven launch");
    return {
      success: false,
      output:
        `${TOOL_ID}: the launch transaction (${outcome.txHash}) could not be confirmed yet — it may still `
        + "settle, and it may already have created your token. DO NOT retry; this attempt is recorded as "
        + "pending and will resolve automatically. Verify with chain_read tx_receipt.",
      data: { _executionId: executionId, txHash: outcome.txHash, status: "pending" },
    };
  }

  if (outcome.kind === "reverted") {
    await failActivityEvent(launchRowId, {
      failureCode: "mined_revert",
      failureReason: "the launch transaction reverted on-chain",
    });
    await abortRemaining(executionId, 1, "launch reverted — the fee leg was never signed");
    await settleLaunchFailure(x.intentId, x.sessionId, "MinedRevert:create");
    return {
      success: false,
      output:
        `${TOOL_ID}: the launch transaction (${outcome.txHash}) reverted on-chain. No token was created, `
        + "and no Vex fee was charged.",
      data: { _executionId: executionId, txHash: outcome.txHash, status: "reverted" },
    };
  }

  return finalizeConfirmedLaunch(x, executionId, launchRowId, feeRowId, outcome);
}

function buildLaunchEvent(x: BroadcastLaunchInput) {
  return {
    eventRole: "token_launch" as const,
    kind: "launch" as const,
    protocol: PROTOCOL,
    chainId: TRENCH_CHAIN_ID,
    chainSlug: CHAIN_SLUG,
    walletAddress: x.walletAddress,
    sessionId: x.sessionId,
    tokenIn: {
      tokenAddress: NATIVE_ADDRESS,
      tokenSymbol: "ETH",
      tokenDecimals: PREBUY_DECIMALS,
      amountHuman: formatEther(x.plan.txParams.value),
      amountRaw: x.plan.txParams.value.toString(),
    },
    // The prebuy is a LEG WITHIN this launch, never a second `swap` row for the
    // same tx hash — one create emits both `TokenCreated` and `Bought`.
    routeProvenance: {
      creationFeeWei: x.plan.binding.creationFeeWei,
      prebuyRaw: x.plan.binding.prebuyWei,
      prebuyDecimals: PREBUY_DECIMALS,
      anchorBlockNumber: x.plan.binding.anchorBlockNumber,
      imageId: x.plan.binding.imageId,
      imageDigest: x.plan.binding.imageDigest,
      callFingerprint: x.plan.binding.callFingerprint,
    },
  };
}

async function finalizeConfirmedLaunch(
  x: BroadcastLaunchInput,
  executionId: number,
  launchRowId: number,
  feeRowId: number | null,
  outcome: Extract<StagedBroadcastOutcome, { kind: "confirmed" }>,
): Promise<ToolResult> {
  const txHash = outcome.txHash;
  const decoded = decodeLaunchReceipt({
    logs: outcome.receipt.logs.map((l) => ({
      address: l.address,
      topics: l.topics as string[],
      data: l.data,
    })),
    diamond: DIAMOND,
    wallet: x.walletAddress,
    expectPrebuy: x.request.prebuyWei > 0n,
  });

  if (decoded === null) {
    // DECLINE rather than guess. `confirmWith` REQUIRES an address precisely so
    // "a token exists but we do not know which" cannot be recorded as success.
    logger.info("trench.launch_execute.identity_pending", { executionId, txHash });
    return {
      success: true,
      output:
        `${TOOL_ID}: the launch confirmed on-chain (tx ${txHash}), but the new token's address could not `
        + "be decoded from the receipt yet. It will be filled in automatically — check the transaction "
        + "for the address in the meantime.",
      data: { _executionId: executionId, txHash, status: "confirmed_pending_identity" },
    };
  }

  try {
    await withTransaction(async (client) => {
      await acquireSessionControlLock(client, x.sessionId);
      await confirmWith(client, x.intentId, x.sessionId, decoded.tokenAddress);
    });
    // The PRIMARY write. Idempotent upsert, so the repair sweep re-running it is
    // harmless.
    await launchedTokens.record({
      walletAddress: x.walletAddress,
      chainId: TRENCH_CHAIN_ID,
      tokenAddress: decoded.tokenAddress,
      name: x.request.name,
      symbol: x.request.symbol,
      imageRef: x.request.imageId,
      createTxHash: txHash,
      // Raw amounts travel WITH their decimals, always — and when the amount is
      // unproven, BOTH stay null rather than pairing a null with a decimals
      // value that implies one exists.
      initialBuyRaw: decoded.prebuyTokensOutRaw?.toString() ?? null,
      initialBuyDecimals: decoded.prebuyTokensOutRaw === null ? null : PREBUY_DECIMALS,
      initialBuyTokenAddress: decoded.prebuyTokensOutRaw === null ? null : decoded.tokenAddress,
      sessionId: x.sessionId,
      protocolExecutionId: executionId,
    });
    await confirmActivityEvent(launchRowId, {
      executedAmountInHuman: formatEther(x.plan.txParams.value),
      executedAmountInRaw: x.plan.txParams.value.toString(),
    });
  } catch (err) {
    // The launch DID happen. A bookkeeping failure must not be reported as a
    // failed launch; the repair sweep reconciles it.
    logger.warn("trench.launch_execute.record_failed", { executionId, error: safeDetail(err) });
  }

  const vexFee = await chargeVexFee(x, executionId, feeRowId, outcome);

  const data = {
    summary:
      `Launched ${x.request.symbol} on Robinhood Chain: ${decoded.tokenAddress}. `
      + `Sent ${formatEther(x.plan.txParams.value)} ETH (creation fee + prebuy). Tx: ${txHash}`,
    chain: CHAIN_SLUG,
    chainId: TRENCH_CHAIN_ID,
    txHash,
    tokenAddress: decoded.tokenAddress,
    name: x.request.name,
    symbol: x.request.symbol,
    msgValueWei: x.plan.txParams.value.toString(),
    creationFeeWei: x.plan.binding.creationFeeWei,
    prebuyWei: x.plan.binding.prebuyWei,
    prebuyDecimals: PREBUY_DECIMALS,
    prebuyTokensOutRaw: decoded.prebuyTokensOutRaw?.toString() ?? null,
    vexFee,
    status: "confirmed",
    _executionId: executionId,
  };
  return { success: true, output: JSON.stringify(data), data };
}

/**
 * Charge the Vex fee, AFTER the launch confirmed and never before.
 *
 * Never throws and never fails the launch: a failed fee is missed Vex revenue,
 * not a failed launch, and an ambiguous fee is NEVER retried because a blind
 * retry could charge the user twice.
 */
async function chargeVexFee(
  x: BroadcastLaunchInput,
  executionId: number,
  feeRowId: number | null,
  outcome: Extract<StagedBroadcastOutcome, { kind: "confirmed" }>,
): Promise<Record<string, unknown>> {
  const plan = x.plan.feeLeg;
  if (plan === null) return { charged: false, reason: "dust" };
  if (feeRowId === null || x.deps.runFeeLeg === null) {
    return { charged: false, reason: "fee_leg_not_wired" };
  }
  try {
    const collection = await x.deps.runFeeLeg({
      plan,
      feeRowId,
      publicClient: x.publicClient,
      walletClient: x.walletClient,
      // Anchor the fee's gas estimate on the block the launch confirmed in —
      // the same dependent-leg discipline the approve→sell path uses.
      priorLeg: priorLegAnchorFrom(outcome.receipt.blockNumber),
    });
    return { charged: collection.collection === "confirmed", ...collection };
  } catch (err) {
    // The seam promises never to throw; the launch must not depend on that
    // promise being kept.
    logger.warn("trench.launch_execute.fee_leg_threw", { executionId, error: safeDetail(err) });
    return { charged: false, reason: "fee_failed" };
  }
}

async function abortRemaining(executionId: number, fromIndex: number, reason: string): Promise<void> {
  try {
    await abortPlannedEvents(executionId, fromIndex, reason);
  } catch (err) {
    logger.warn("trench.launch_execute.abort_failed", {
      executionId,
      fromIndex,
      error: safeDetail(err),
    });
  }
}
