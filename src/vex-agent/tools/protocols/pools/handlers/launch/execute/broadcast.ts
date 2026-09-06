/**
 * The pools.fun launch BROADCAST and SETTLEMENT steps.
 *
 * One reason to change: what happens between "we are allowed to sign" and "we
 * know what happened". The outcomes are deliberately not symmetric:
 *
 *   CONFIRMED   decode the DUAL-EVENT settlement, write `launched_tokens`, then
 *               charge the Vex fee LAST.
 *   REVERTED    fail the row, abort the fee leg. A launch that did not happen is
 *               never charged for.
 *   AMBIGUOUS   do NOTHING terminal. The intent keeps its hash at
 *               `broadcast_pending` for the repair sweep, and the fee is never
 *               signed. A launch marked failed is one a user may retry - and this
 *               transaction may already have minted their token.
 *   UNDECODABLE confirmed on-chain but the identity could not be PROVEN: the
 *               intent stays pending with the decoder's own named reason, and no
 *               fee is charged for a launch we cannot prove.
 *
 * WHAT MAKES THE POOLS SETTLEMENT DIFFERENT. Identity binds through
 * `GatewayLaunch.launcher`, never through the factory: on the gateway path
 * `TokenLaunched.creator` and `.deployer` are the GATEWAY itself, so a decoder
 * reading only the factory event would attribute every launch to the launchpad.
 * The decoder therefore requires exactly ONE `GatewayLaunch` from the pinned
 * gateway AND exactly ONE `TokenLaunched` from the pinned factory, cross-checked
 * against each other and against the AUTHORIZED plan - not against the prepare
 * response, which is the thing being verified in the first place.
 *
 * THE BYTES SIGNED ARE THE BYTES AUTHORIZED. The staged broadcast is handed
 * `plan.call`, whose fingerprint is what the C0 record names; nothing here
 * rebuilds calldata, and no reprepare is possible after this point.
 */

import { formatEther, formatUnits, type Account, type Address, type Chain, type PublicClient, type Transport, type WalletClient } from "viem";

import { POOLS_CHAIN_ID } from "@tools/pools-fun/constants.js";
import { POOLS_FEE_VENUE } from "@tools/pools-fun/fee/venue.js";
import { readPoolsTokenDecimals } from "@tools/pools-fun/evm/token-registration.js";
import { signStageBroadcast, type StagedBroadcastOutcome } from "@tools/evm-chains/staged-broadcast.js";
import { priorLegAnchorFrom } from "@tools/evm-chains/dependent-leg-gas-estimate.js";
import { withTransaction } from "@vex-agent/db/client.js";
import { acquireSessionControlLock } from "@vex-agent/engine/runtime/lease-and-status.js";
import { confirmWith, markBroadcastPendingWith } from "@vex-agent/db/repos/token-launch-intents.js";
import * as launchedTokens from "@vex-agent/db/repos/launched-tokens.js";
import {
  createAgentActivityIntent,
  markActivityBroadcast,
  reserveActivityEvmNonce,
  markBroadcastAccepted,
  confirmLaunchWithOutputIdentity,
  fillLaunchOutputIdentityOnConfirmed,
  stampLaunchOutputIdentityByTxHash,
  failActivityEvent,
  abortPlannedEvents,
} from "@vex-agent/db/repos/agent-activity.js";
import { settlementDecodeProvenance } from "@vex-agent/db/repos/agent-activity/settlement-decode.js";
import { noteHandlerPendingReason } from "@vex-agent/tools/protocols/runtime/pending-provenance.js";
import { decodePoolsLaunchSettlement } from "@vex-agent/sync/pools-settlement-decoder.js";
import { runNativeFeeLeg, type NativeFeeCollection } from "../../../../shared/native-fee-leg/run.js";
import logger from "@utils/logger.js";
import type { ToolResult } from "../../../../../types.js";
import { fail } from "../../../../handler-helpers.js";
import { poolsFailureDetail } from "../../failure.js";
import { settlePoolsLaunchFailure } from "./authorize.js";
import {
  POOLS_LAUNCHPAD,
  postPoolsLaunchAttribution,
  signAndStoreAgentscanAttestation,
  signAndStorePoolsAttestation,
} from "./attribute.js";
import type { PoolsLaunchPlan } from "./plan.js";

const TOOL_ID = "pools.launch_execute";
const PROTOCOL = "pools";
const CHAIN_SLUG = "robinhood";
const NATIVE_ADDRESS = "0x0000000000000000000000000000000000000000" as Address;
const NATIVE_DECIMALS = 18;

function safeDetail(err: unknown): string {
  return poolsFailureDetail(TOOL_ID, err);
}

export interface BroadcastPoolsLaunchInput {
  readonly intentId: string;
  readonly sessionId: string;
  readonly walletAddress: Address;
  readonly plan: PoolsLaunchPlan;
  /** The tool call's own params, for the durable activity intent. */
  readonly params: Record<string, unknown>;
  readonly publicClient: PublicClient<Transport, Chain>;
  readonly walletClient: WalletClient<Transport, Chain, Account>;
}

export async function broadcastPoolsLaunch(x: BroadcastPoolsLaunchInput): Promise<ToolResult> {
  const feeLeg = x.plan.feeLeg;
  // `signStageBroadcast` signs BEFORE it calls `onHashStaged`, so a throw from
  // that hook is NOT a pre-sign refusal: a signed transaction exists, with a
  // consumed nonce, that was never sent. Telling the user "nothing was signed"
  // there would be false - and it is the one sentence they would act on.
  let signedLocally = false;

  // Durable activity BEFORE any broadcast - a crash mid-flight must leave a row,
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
    await settlePoolsLaunchFailure(x.intentId, x.sessionId, `IntentWrite:${safeDetail(err)}`);
    return fail(`${TOOL_ID} failed before broadcasting: ${safeDetail(err)}. Nothing was signed.`);
  }

  let outcome: StagedBroadcastOutcome;
  try {
    outcome = await signStageBroadcast(
      x.publicClient,
      x.walletClient,
      // THE AUTHORIZED BYTES, verbatim. Not rebuilt, not re-quoted, not
      // re-prepared: this is the exact call whose fingerprint the C0 record
      // names.
      { to: x.plan.call.to, data: x.plan.call.data, value: x.plan.call.valueWei },
      {
        onNonceReserved: (request) => reserveActivityEvmNonce(launchRowId, request),
        onHashStaged: async (handles) => {
          signedLocally = true;
          const res = await markActivityBroadcast(launchRowId, handles);
          if (!res.applied) {
            throw new Error(
              `agent_activity: markActivityBroadcast CAS miss for event ${launchRowId} - refusing to broadcast untracked`,
            );
          }
          // Persist the SIGNED hash on the intent too. `markBroadcastPendingWith`
          // has `tx_hash IS NULL` in its predicate, so a retry can never
          // overwrite an already-staged hash - losing the first would destroy the
          // only evidence of a launch that may already be mined.
          const staged = await withTransaction(async (client) => {
            await acquireSessionControlLock(client, x.sessionId);
            return markBroadcastPendingWith(client, x.intentId, x.sessionId, handles.txHash);
          });
          if (staged === null) {
            // A CAS MISS MEANS SOMEONE ELSE OWNS THIS INTENT. This hook runs
            // BEFORE `sendRawTransaction`, so throwing aborts with nothing sent;
            // continuing would sign a second launch for an intent whose first
            // may already be mined and spend the user's funds twice.
            //
            // The activity row already carries the staged hash, and
            // `abortPlannedEvents` only finalizes rows with `tx_hash IS NULL`, so
            // it must be terminalized here by name or it stays pending forever.
            await failActivityEvent(launchRowId, {
              failureCode: "broadcast_error",
              failureReason:
                "SignedNotBroadcast:cas_miss - signed locally but never broadcast; "
                + "another executor owns this launch intent",
            });
            throw new Error(
              `token_launch_intents: markBroadcastPendingWith CAS miss for intent ${x.intentId} `
                + "- another executor owns this launch; refusing to broadcast",
            );
          }
        },
        onAccepted: async () => {
          const res = await markBroadcastAccepted(launchRowId);
          if (!res.applied) {
            logger.warn("pools.launch_execute.broadcast_accept_miss", { id: launchRowId });
          }
        },
      },
    );
  } catch (err) {
    await abortRemaining(executionId, 0, safeDetail(err));
    await settlePoolsLaunchFailure(
      x.intentId,
      x.sessionId,
      `${signedLocally ? "SignedNotBroadcast" : "PreSign"}:${safeDetail(err)}`,
    );
    return fail(
      signedLocally
        ? `${TOOL_ID}: the launch transaction was signed locally but never broadcast - ${safeDetail(err)}. `
          + "Nothing was sent to the network and no funds moved."
        : `${TOOL_ID}: the launch was refused before signing - ${safeDetail(err)}. Nothing was signed.`,
    );
  }

  if (outcome.kind === "ambiguous") {
    logger.info("pools.launch_execute.ambiguous", { executionId, txHash: outcome.txHash });
    await noteHandlerPendingReason(TOOL_ID, launchRowId, "broadcast_ambiguous_confirm");
    await abortRemaining(executionId, 1, "launch ambiguous - a fee is never charged for an unproven launch");
    return {
      success: false,
      output:
        `${TOOL_ID}: the launch transaction (${outcome.txHash}) could not be confirmed yet - it may still `
        + "settle, and it may already have created your token. DO NOT retry; this attempt is recorded as "
        + "pending and will resolve automatically. Verify with ChainRead tx_receipt.",
      data: { _executionId: executionId, txHash: outcome.txHash, status: "pending" },
    };
  }

  if (outcome.kind === "reverted") {
    await failActivityEvent(launchRowId, {
      failureCode: "mined_revert",
      failureReason: "the launch transaction reverted on-chain",
    });
    await abortRemaining(executionId, 1, "launch reverted - the fee leg was never signed");
    await settlePoolsLaunchFailure(x.intentId, x.sessionId, "MinedRevert:launch");
    return {
      success: false,
      output:
        `${TOOL_ID}: the launch transaction (${outcome.txHash}) reverted on-chain. No token was created, `
        + "and no Vex fee was charged.",
      data: { _executionId: executionId, txHash: outcome.txHash, status: "reverted" },
    };
  }

  return finalizeConfirmedPoolsLaunch(x, executionId, launchRowId, feeRowId, outcome);
}

function buildLaunchEvent(x: BroadcastPoolsLaunchInput) {
  const binding = x.plan.binding;
  return {
    // The venue-neutral launch role (migration 062). A pools.fun launch is the
    // same shape of event: native value in, one new token out, no allowance leg
    // (the deployment fee and any ETH prebuy are both `msg.value`).
    eventRole: "token_launch" as const,
    kind: "launch" as const,
    protocol: PROTOCOL,
    chainId: POOLS_CHAIN_ID,
    chainSlug: CHAIN_SLUG,
    walletAddress: x.walletAddress,
    sessionId: x.sessionId,
    tokenIn: {
      tokenAddress: NATIVE_ADDRESS,
      tokenSymbol: "ETH",
      tokenDecimals: NATIVE_DECIMALS,
      amountHuman: formatEther(x.plan.call.valueWei),
      amountRaw: x.plan.call.valueWei.toString(),
    },
    routeProvenance: {
      // Names the decoder that will read this receipt, and claims nothing more:
      // the token does not exist yet when this row is written.
      ...settlementDecodeProvenance({ decoder: "pools_launch", chainId: POOLS_CHAIN_ID }),
      deploymentFeeWei: binding.deploymentFeeWei,
      prebuyRaw: binding.prebuyWei,
      prebuyDecimals: NATIVE_DECIMALS,
      anchorBlockNumber: binding.anchorBlockNumber,
      pairedAsset: binding.pairedAsset,
      pairedAssetAddress: binding.pairedAssetAddress,
      feeRecipient: binding.feeRecipient,
      // The sentinel INTENT, recorded before the receipt exists. The row is
      // written pre-broadcast, so the resolved distributor is not knowable here
      // and is deliberately absent rather than null-filled.
      ...(binding.holderRewards == null
        ? {}
        : {
          holderRewardsMode: binding.holderRewards.mode,
          holderRewardsSentinel: binding.holderRewards.sentinel,
        }),
      metadataUri: binding.metadataUri,
      predictedTokenAddress: binding.predictedTokenAddress,
      userSalt: binding.userSalt,
      callFingerprint: binding.callFingerprint,
    },
  };
}

async function finalizeConfirmedPoolsLaunch(
  x: BroadcastPoolsLaunchInput,
  executionId: number,
  launchRowId: number,
  feeRowId: number | null,
  outcome: Extract<StagedBroadcastOutcome, { kind: "confirmed" }>,
): Promise<ToolResult> {
  const txHash = outcome.txHash;
  const binding = x.plan.binding;

  // The dual-event decode, against the AUTHORIZED plan.
  const decoded = decodePoolsLaunchSettlement(
    outcome.receipt.logs.map((l) => ({
      address: l.address,
      topics: l.topics as string[],
      data: l.data,
    })),
    {
      launcher: x.walletAddress,
      feeRecipient: binding.feeRecipient,
      pairedAsset: binding.pairedAssetAddress,
      userSalt: binding.userSalt,
      predictedTokenAddress: binding.predictedTokenAddress,
      // THE SENTINEL INTENT, not the address to compare against. Under holder
      // rewards the gateway resolved the sentinel to the distributor it deployed
      // before emitting `GatewayLaunch`, so `binding.feeRecipient` (the sentinel
      // that was SIGNED) is deliberately not what the receipt must equal. The
      // decoder proves the emitted recipient is the distributor this very
      // transaction's `DistributorDeployed` named, for this token, in this mode.
      holderRewards: binding.holderRewards,
    },
    { gateway: binding.gateway },
  );

  if (!decoded.ok) {
    // DECLINE rather than guess, WITH the decoder's own reason. The row stays
    // pending for the repair sweep; the planned fee row is settled here because
    // the fee will never be signed for this attempt, and a planned row with no
    // outcome would misreport an intended charge as in-flight.
    logger.info("pools.launch_execute.identity_pending", { executionId, txHash, reason: decoded.reason });
    await noteHandlerPendingReason(TOOL_ID, launchRowId, "settlement_undecodable");
    await abortRemaining(
      executionId,
      1,
      "launch identity unproven - the Vex fee is never charged for a launch we cannot prove",
    );
    return {
      success: true,
      output:
        `${TOOL_ID}: the launch transaction confirmed on-chain (tx ${txHash}), but which token it created `
        + `could not be PROVEN from the receipt: ${decoded.reason}. Nothing was charged, this attempt is `
        + "recorded as pending, and it resolves automatically. DO NOT launch again.",
      data: { _executionId: executionId, txHash, status: "confirmed_pending_identity", reason: decoded.reason },
    };
  }

  const launch = decoded.value;
  let intentMayConfirm = true;
  // The VEX badge's proof. Signable ONLY here, while the launch's signing
  // clients are open - see `./attribute.ts`. Never fails a launch, and stays
  // `null` whenever the lane is disabled.
  let attestSignature: string | null = null;

  // Read ONCE, before the bookkeeping, so the activity row and the reply quote
  // the same proven scale - or both say the scale is unknown.
  const tokenOut = await readTokenOutDisplay(x, launch.tokenAddress, launch.devBuyOut);

  try {
    // ORDER: the durable identity index FIRST. It is idempotent and it is the
    // record the user's launch history is built from; confirming the intent
    // first and crashing would leave a confirmed launch with no
    // `launched_tokens` row and nothing able to recover it - the repair sweep
    // only sees `broadcast_pending`.
    const hasPrebuy = BigInt(binding.prebuyWei) > 0n;
    await launchedTokens.record({
      walletAddress: x.walletAddress,
      chainId: POOLS_CHAIN_ID,
      launchpad: POOLS_LAUNCHPAD,
      tokenAddress: launch.tokenAddress,
      name: binding.name,
      symbol: binding.symbol,
      imageRef: binding.imageId,
      createTxHash: txHash,
      // Raw amounts travel WITH their decimals and their token; with no prebuy
      // all three stay null rather than pairing a null amount with decimals that
      // imply one exists.
      initialBuyRaw: hasPrebuy ? binding.prebuyWei : null,
      initialBuyDecimals: hasPrebuy ? NATIVE_DECIMALS : null,
      initialBuyTokenAddress: hasPrebuy ? NATIVE_ADDRESS : null,
      sessionId: x.sessionId,
      protocolExecutionId: executionId,
    });

    // IMMEDIATELY after the identity record, and inside the same try: the
    // signature is stamped onto the row that was just written, so the sweep can
    // retry the POST later from durable state. A store failure still returns
    // the signature (see `./attribute.ts`) so the POST below can proceed.
    attestSignature = await signAndStorePoolsAttestation(x.walletClient, launch.tokenAddress);

    // THE THIRD SIGNATURE, over AgentScan's canonical message rather than the
    // venue's. Same moment and same reason: this is the last point at which a
    // signer exists for this token, and the AgentScan sweep holds none. It is a
    // separate call because it is a separate proof with a separate destination
    // and a separate operator gate; folding the two would send one of them to a
    // verifier that recovers a different address from it.
    await signAndStoreAgentscanAttestation(x.walletClient, launch.tokenAddress);

    // `event_role='token_launch'` requires BOTH executed legs: the native value
    // spent, and the token the launch produced. `devBuyOut` is PROVEN by
    // `GatewayLaunch` itself, so there is no
    // "amount unknown" branch - a launch with no prebuy proves zero.
    const identity = {
      executedAmountInHuman: formatEther(x.plan.call.valueWei),
      executedAmountInRaw: x.plan.call.valueWei.toString(),
      executedAmountOutHuman: tokenOut.human,
      executedAmountOutRaw: launch.devBuyOut.toString(),
      tokenOutAddress: launch.tokenAddress,
      tokenOutSymbol: binding.symbol,
      tokenOutDecimals: tokenOut.decimals,
    };
    const finalized = await confirmLaunchWithOutputIdentity(launchRowId, identity);
    // A CAS miss here is the status-only sweep having won the race: it confirms
    // a pending row from its hash and writes no amounts, leaving a confirmed row
    // with a NULL token. Benign, but only if repaired NOW - nothing revisits a
    // confirmed row.
    const landed = finalized.applied
      || await fillLaunchOutputIdentityOnConfirmed(launchRowId, identity);
    if (!landed) {
      logger.warn("pools.launch_execute.identity_write_lost", { executionId, txHash });
      await stampLaunchOutputIdentityByTxHash(txHash, launch.tokenAddress);
      intentMayConfirm = false;
    }

    // THE INTENT IS CONFIRMED LAST: the repair sweep claims only
    // `broadcast_pending` intents, so once this lands nothing can redo any write
    // above it. A crash before here leaves the intent for the next tick, where
    // every write above is idempotent.
    if (intentMayConfirm) {
      await withTransaction(async (client) => {
        await acquireSessionControlLock(client, x.sessionId);
        await confirmWith(
          client,
          x.intentId,
          x.sessionId,
          launch.tokenAddress,
          // The resolved distributor, proven by the decoder from this very
          // receipt's `DistributorDeployed`. `null` on an ordinary launch, where
          // the sentinel columns are null too and there is nothing to resolve.
          launch.holderRewards?.distributor ?? null,
        );
      });
    }
  } catch (err) {
    // The launch DID happen. A bookkeeping failure must not be reported as a
    // failed launch; the repair sweep reconciles it.
    logger.warn("pools.launch_execute.record_failed", { executionId, error: safeDetail(err) });
  }

  const vexFee = await chargePoolsVexFee(x, executionId, feeRowId, outcome);

  // LAST, after the money is settled: claiming the badge is cosmetic and must
  // never sit in front of the fee leg or the launch's own result. Awaited, not
  // floated - a rejection after this handler returns would be an unhandled
  // rejection in the agent process.
  //
  // The leg promises never to throw; the launch must not depend on that promise
  // being kept - same rule as the fee runner below. A badge that could throw
  // here would turn a confirmed, charged launch into a failed tool call.
  try {
    await postPoolsLaunchAttribution(launch.tokenAddress, attestSignature, txHash);
  } catch (err) {
    logger.warn("pools.launch_execute.attribution_threw", { executionId, error: safeDetail(err) });
  }

  const data = {
    summary:
      `Launched ${binding.symbol} on pools.fun (Robinhood Chain): ${launch.tokenAddress}, trading in pool `
      + `${launch.poolAddress} against ${binding.pairedAsset.toUpperCase()}. `
      + `Sent ${formatEther(x.plan.call.valueWei)} ETH (deployment fee + any prebuy). Tx: ${txHash}`,
    chain: CHAIN_SLUG,
    chainId: POOLS_CHAIN_ID,
    txHash,
    tokenAddress: launch.tokenAddress,
    poolAddress: launch.poolAddress,
    name: binding.name,
    symbol: binding.symbol,
    pairedAsset: binding.pairedAsset,
    pairedAssetAddress: launch.pairedAsset,
    feeRecipient: launch.feeRecipient,
    // WHERE THE FEE STREAM WENT, when it went to the holders: the distributor
    // proven from this launch's own DistributorDeployed event, and the mode that
    // event declared. Absent on an ordinary launch, where `feeRecipient` above
    // already is the whole answer.
    ...(launch.holderRewards == null
      ? {}
      : {
        holderRewards: {
          distributor: launch.holderRewards.distributor,
          mode: launch.holderRewards.mode,
          sentinelSigned: binding.holderRewards?.sentinel ?? null,
        },
      }),
    metadataUri: launch.metadataUri,
    msgValueWei: x.plan.call.valueWei.toString(),
    deploymentFeePaidWei: launch.feePaidWei.toString(),
    prebuyWei: binding.prebuyWei,
    prebuyDecimals: NATIVE_DECIMALS,
    prebuyTokensOutRaw: launch.devBuyOut.toString(),
    // `null` means the new token's decimals could not be read - NEVER an assumed
    // 18. A raw amount whose scale is unknown must say so (rule 90).
    prebuyTokensOutDecimals: tokenOut.decimals,
    prebuyTokensOut: tokenOut.human ?? null,
    vexFee,
    /**
     * Grounding, not a reading: a pools.fun token has NO bonding curve and no
     * graduation - it opens directly into a live SushiSwap V3 pool at 1% fee.
     * Saying so stops the agent inferring a curve state that does not exist.
     */
    poolState: "live_v3_pool",
    poolNote:
      "pools.fun has no bonding curve and no graduation: this token trades in a real SushiSwap V3 pool "
      + "(1% fee) from its first block. Quote and trade it with kyberswap, which routes these pools.",
    feeStreamNote:
      launch.holderRewards == null
        ? `The creator fee stream is directed to ${launch.feeRecipient}. Claim accrued fees with `
          + "pools.claim_fees."
        : `The creator fee stream goes to this token's HOLDERS, paid in ${launch.holderRewards.mode === "both" ? "both the token and the paired asset" : `the ${launch.holderRewards.mode}`}, `
          + `through the rewards distributor ${launch.holderRewards.distributor} that this launch deployed. `
          + "The launching wallet receives nothing from trading fees and pools.claim_fees has nothing to claim "
          + "on this token; holders read and claim their share with pools__holder_rewards_get and "
          + "pools__holder_rewards_claim. This was locked at launch and cannot be undone.",
    status: "confirmed",
    _executionId: executionId,
  };
  return { success: true, output: JSON.stringify(data), data };
}

/**
 * The tokens-out display pair.
 *
 * A raw amount without its decimals is unreadable, and a token minted moments
 * ago has no decimals anyone can know in advance - so they are read from the
 * token. A failed read degrades the DISPLAY only; the raw amount is unaffected
 * and no decimals value is guessed.
 */
async function readTokenOutDisplay(
  x: BroadcastPoolsLaunchInput,
  token: Address,
  rawOut: bigint,
): Promise<{ human: string | undefined; decimals: number | null }> {
  try {
    const decimals = await readPoolsTokenDecimals(x.publicClient, token);
    return { human: formatUnits(rawOut, decimals), decimals };
  } catch {
    return { human: undefined, decimals: null };
  }
}

/**
 * Charge the Vex fee, AFTER the launch confirmed and never before.
 *
 * Never throws and never fails the launch: a failed fee is missed Vex revenue,
 * not a failed launch, and an ambiguous fee is NEVER retried, because a blind
 * retry could charge the user twice.
 */
async function chargePoolsVexFee(
  x: BroadcastPoolsLaunchInput,
  executionId: number,
  feeRowId: number | null,
  outcome: Extract<StagedBroadcastOutcome, { kind: "confirmed" }>,
): Promise<NativeFeeCollection> {
  const plan = x.plan.feeLeg;
  if (plan === null) {
    return {
      collection: "not_charged",
      collectionNote: POOLS_FEE_VENUE.notes.skipped,
      txHash: null,
    };
  }
  if (feeRowId === null) {
    return {
      collection: "not_attempted",
      collectionNote: "No Vex fee was taken: its activity row could not be created, so it was never signed.",
      txHash: null,
    };
  }
  try {
    return await runNativeFeeLeg(POOLS_FEE_VENUE, {
      plan,
      feeRowId,
      chainId: POOLS_CHAIN_ID,
      publicClient: x.publicClient,
      signer: x.walletClient,
      // Anchor the fee's gas estimate on the block the launch confirmed in.
      priorLeg: priorLegAnchorFrom(outcome.receipt.blockNumber),
    });
  } catch (err) {
    // The shared runner promises never to throw; the launch must not depend on
    // that promise being kept.
    logger.warn("pools.launch_execute.fee_leg_threw", { executionId, error: safeDetail(err) });
    return {
      collection: "not_attempted",
      collectionNote: "The Vex fee transfer failed; your launch is unaffected.",
      txHash: null,
    };
  }
}

async function abortRemaining(executionId: number, fromIndex: number, reason: string): Promise<void> {
  try {
    await abortPlannedEvents(executionId, fromIndex, reason);
  } catch (err) {
    logger.warn("pools.launch_execute.abort_failed", { executionId, fromIndex, error: safeDetail(err) });
  }
}
