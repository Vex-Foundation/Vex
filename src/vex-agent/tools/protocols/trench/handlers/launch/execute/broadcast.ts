/**
 * The launch BROADCAST and SETTLEMENT steps.
 *
 * One reason to change: what happens between "we are allowed to sign" and "we
 * know what happened". The three outcomes are deliberately not symmetric:
 *
 *   CONFIRMED  decode the identity, write `launched_tokens` (the PRIMARY path -
 *              the identity-repair sweep is crash recovery, not the normal
 *              route), then charge the Vex fee LAST.
 *   REVERTED   fail the row, abort the fee leg. A launch that did not happen is
 *              never charged for.
 *   AMBIGUOUS  do NOTHING terminal. The intent keeps its hash at
 *              `broadcast_pending` for the repair sweep, and the fee is never
 *              signed. A launch marked failed is one a user may retry - and this
 *              create may already have minted their token.
 */

import { formatEther, formatUnits, type Account, type Address, type Chain, type PublicClient, type Transport, type WalletClient } from "viem";

import { TRENCH_CHAIN_ID, TRENCH_DIAMOND_ADDRESS } from "@tools/trench-express/constants.js";
import { readTokenDecimals } from "@tools/trench-express/evm/curve-reader.js";
import { signStageBroadcast, type StagedBroadcastOutcome } from "@tools/evm-chains/staged-broadcast.js";
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
import logger from "@utils/logger.js";
import { noteHandlerPendingReason } from "@vex-agent/tools/protocols/runtime/pending-provenance.js";
import type { ToolResult } from "../../../../../types.js";
import { fail } from "../../../../handler-helpers.js";
import { trenchFailureDetail } from "../../failure.js";
import type { LaunchPlan } from "../plan.js";
import { priorLegAnchorFrom } from "@tools/evm-chains/dependent-leg-gas-estimate.js";
import type { LaunchExecuteDeps } from "../fee-seam.js";
import { decodeLaunchReceipt } from "../settlement.js";
import { settleLaunchFailure } from "./authorize.js";
import { postLaunchAttribution, signAndStoreAttestation } from "./attribute.js";
import { pinLaunchedToken } from "./track.js";
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
  readonly walletClient: WalletClient<Transport, Chain, Account>;
  readonly deps: LaunchExecuteDeps;
}

export async function broadcastLaunch(x: BroadcastLaunchInput): Promise<ToolResult> {
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
    await settleLaunchFailure(x.intentId, x.sessionId, `IntentWrite:${safeDetail(err)}`);
    return fail(`${TOOL_ID} failed before broadcasting: ${safeDetail(err)}. Nothing was signed.`);
  }

  let outcome: StagedBroadcastOutcome;
  try {
    outcome = await signStageBroadcast(x.publicClient, x.walletClient, x.plan.txParams, {
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
        // has `tx_hash IS NULL` in its predicate, so a retry can never overwrite
        // an already-staged hash - losing the first would destroy the only
        // evidence of a create that may already be mined.
        const staged = await withTransaction(async (client) => {
          await acquireSessionControlLock(client, x.sessionId);
          return markBroadcastPendingWith(client, x.intentId, x.sessionId, handles.txHash);
        });
        // A CAS MISS MEANS SOMEONE ELSE OWNS THIS INTENT - a concurrent
        // executor already staged a hash, or the row is no longer `consuming`.
        // Throwing here aborts the broadcast with nothing sent (this hook runs
        // BEFORE `sendRawTransaction`); continuing would sign a second create
        // for an intent whose first create may already be mined, and spend the
        // user's funds twice.
        if (staged === null) {
          // The activity row ALREADY carries the staged hash (the
          // `markActivityBroadcast` above), and `abortPlannedEvents` only
          // finalizes rows with `tx_hash IS NULL` - so the generic abort below
          // cannot reach this row and it would stay `pending` forever, with the
          // repair sweep chasing a hash that was never sent. Terminalize it
          // here, by name, as the one thing it actually is.
          //
          // `failure_code` is a CLOSED enum mirrored by a SQL CHECK
          // (`agent-activity/validation.ts` + the lockstep test), so the
          // specific name lives in the reason rather than inventing a code that
          // the database would reject.
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
          logger.warn("trench.launch_execute.broadcast_accept_miss", { id: launchRowId });
        }
      },
    });
  } catch (err) {
    await abortRemaining(executionId, 0, safeDetail(err));
    await settleLaunchFailure(
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
    logger.info("trench.launch_execute.ambiguous", { executionId, txHash: outcome.txHash });
    // Migration 067: the launch row stays pending - say why, in the closed
    // vocabulary, so the fallback knows it is chasing INCLUSION here, not a
    // decode.
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
    // same tx hash - one create emits both `TokenCreated` and `Bought`.
    routeProvenance: {
      // R1 Step 5a - a launch has NO router to match and no input token to
      // value: the token does not exist yet when this row is written. Its
      // decoder works from the receipt's own logs, so the hint names the
      // decoder and the chain and deliberately claims nothing more.
      ...settlementDecodeProvenance({ decoder: "trench_launch", chainId: TRENCH_CHAIN_ID }),
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
    //
    // The planned fee row is SETTLED here rather than left pending forever: the
    // fee leg will never be signed for this attempt (the repair sweep holds no
    // signer), so a planned row with no outcome would misreport an intended
    // charge as in-flight. Nothing is charged.
    logger.info("trench.launch_execute.identity_pending", { executionId, txHash });
    await abortRemaining(
      executionId,
      1,
      "launch identity undecodable - the Vex fee is never charged for a launch we cannot prove",
    );
    return {
      success: true,
      output:
        `${TOOL_ID}: the launch confirmed on-chain (tx ${txHash}), but the new token's address could not `
        + "be decoded from the receipt yet. It will be filled in automatically - check the transaction "
        + "for the address in the meantime.",
      data: { _executionId: executionId, txHash, status: "confirmed_pending_identity" },
    };
  }

  // The prebuy is denominated in what was SPENT - native ETH, at 18 decimals -
  // and that number is the AUTHORIZED one, known before the broadcast. The
  // tokens the prebuy acquired are a different quantity in a different unit;
  // they belong on the activity row's executed OUTPUT leg, never here.
  // Cleared only when the activity identity could NOT be written by either
  // writer: the intent must then stay claimable for the repair sweep.
  let intentMayConfirm = true;
  // The VEX badge's proof. Signable ONLY here, while the launch's signing
  // clients are open - see `./attribute.ts`. Never fails a launch.
  let attestSignature: string | null = null;
  const prebuyWei = x.request.prebuyWei;
  const hasPrebuy = prebuyWei > 0n;
  // No prebuy means zero tokens were acquired - a proven amount, not a missing
  // one. `null` means a prebuy happened whose `Bought` event did not decode.
  const tokensOutRaw = hasPrebuy ? decoded.prebuyTokensOutRaw : 0n;

  try {
    // ORDER: the durable identity index FIRST. It is idempotent, and it is the
    // record the user's launch history is built from; confirming the intent
    // first and crashing would leave a `confirmed` launch with no
    // `launched_tokens` row and nothing to recover it - the repair sweep's
    // candidate query only sees `broadcast_pending`
    // (`sync/launch-identity-repair.ts`).
    await launchedTokens.record({
      walletAddress: x.walletAddress,
      chainId: TRENCH_CHAIN_ID,
      tokenAddress: decoded.tokenAddress,
      name: x.request.name,
      symbol: x.request.symbol,
      imageRef: x.request.imageId,
      createTxHash: txHash,
      // Raw amounts travel WITH their decimals and their token, always - and
      // with no prebuy all three stay null rather than pairing a null amount
      // with a decimals value that implies one exists.
      initialBuyRaw: hasPrebuy ? prebuyWei.toString() : null,
      initialBuyDecimals: hasPrebuy ? PREBUY_DECIMALS : null,
      initialBuyTokenAddress: hasPrebuy ? NATIVE_ADDRESS : null,
      sessionId: x.sessionId,
      protocolExecutionId: executionId,
    });
    attestSignature = await signAndStoreAttestation(x.walletClient, decoded.tokenAddress);
    // `event_role='token_launch'` REQUIRES both executed legs (see
    // `agent-activity/swap-lifecycle.ts`): the native value spent AND the
    // tokens the launch produced. Confirming with the input leg alone threw
    // into this catch on EVERY launch, which left Agent Scan pending forever.
    // When the prebuy's amount is unproven the row STAYS pending on purpose -
    // the status-only repair sweep finalizes it - because inventing an output
    // amount is the one thing worse than a late row.
    if (tokensOutRaw === null) {
      // The amount is unproven, but WHICH TOKEN was created is not - so the
      // identity is written even though the row stays pending. Without it the
      // launch is missing from its own token's history for as long as the
      // amount stays unknown, which may be forever.
      logger.info("trench.launch_execute.prebuy_amount_pending", { executionId, txHash });
      // The launch MINED and its token exists; only the prebuy leg is unread.
      // Its own named reason, because the fallback's job here is a decode of a
      // known-successful receipt, not a hunt for inclusion.
      await noteHandlerPendingReason(TOOL_ID, launchRowId, "launch_prebuy_undecodable");
      await stampLaunchOutputIdentityByTxHash(txHash, decoded.tokenAddress);
    } else {
      const tokenOut = await readTokensOutDisplay(x, decoded.tokenAddress, tokensOutRaw);
      const identity = {
        executedAmountInHuman: formatEther(x.plan.txParams.value),
        executedAmountInRaw: x.plan.txParams.value.toString(),
        executedAmountOutHuman: tokenOut.human,
        executedAmountOutRaw: tokensOutRaw.toString(),
        // The OUTPUT IDENTITY, written in the same statement as the amounts:
        // the app's token history matches on `token_out_address`, so a launch
        // confirmed without it never appears in its own token's history.
        tokenOutAddress: decoded.tokenAddress,
        tokenOutSymbol: x.request.symbol,
        tokenOutDecimals: tokenOut.decimals,
      };
      const finalized = await confirmLaunchWithOutputIdentity(launchRowId, identity);
      // A CAS MISS HERE IS THE STATUS-ONLY SWEEP HAVING WON THE RACE: it
      // confirms a pending row from its hash after ~90s and writes no amounts,
      // so the row is `confirmed` with a NULL token. Benign, but only if it is
      // repaired NOW - nothing revisits a confirmed row.
      const landed = finalized.applied
        || await fillLaunchOutputIdentityOnConfirmed(launchRowId, identity);
      if (!landed) {
        // Neither writer could land the identity. Confirming the intent would
        // remove it from the sweep's claimable set with the token still
        // unwritten and nothing left able to repair it, so the intent STAYS
        // pending. The launch itself is unaffected - it happened.
        logger.warn("trench.launch_execute.identity_write_lost", { executionId, txHash });
        intentMayConfirm = false;
      }
    }
    // THE INTENT IS CONFIRMED LAST, and that order is the whole point: the
    // repair sweep claims only `broadcast_pending` intents, so once this
    // transition lands the row is no longer a candidate and nothing can redo
    // any write above it. A crash before here merely leaves the intent for the
    // next tick, where every write above is idempotent.
    if (intentMayConfirm) {
      await withTransaction(async (client) => {
        await acquireSessionControlLock(client, x.sessionId);
        await confirmWith(client, x.intentId, x.sessionId, decoded.tokenAddress);
      });
    }
  } catch (err) {
    // The launch DID happen. A bookkeeping failure must not be reported as a
    // failed launch; the repair sweep reconciles it.
    logger.warn("trench.launch_execute.record_failed", { executionId, error: safeDetail(err) });
  }

  const vexFee = await chargeVexFee(x, executionId, feeRowId, outcome);

  // After the money is settled: make the new token visible to `WalletBalances`
  // without the agent having to pin it by hand. A local DB write that can never
  // fail, delay or reorder the launch - see `./track.js`.
  await pinLaunchedToken(x.walletAddress, decoded.tokenAddress);

  // LAST, after the money is settled: claiming the badge is cosmetic and must
  // never sit in front of the fee leg or the launch's own result.
  await postLaunchAttribution(decoded.tokenAddress, attestSignature);

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
    /**
     * Grounding (U6), not a reading: a token that `create()` just minted is on
     * its bonding curve BY DEFINITION - graduation is a later, separate event.
     * Stating it here stops the agent inferring curve state from the absence of
     * a field and calling a fresh token "graduated" or "unknown".
     */
    curveState: "bonding_curve",
    curveNote:
      "Freshly created, so this token trades on its Trench bonding curve. It has not graduated to a DEX; "
      + "graduation happens later, once the curve fills.",
    status: "confirmed",
    _executionId: executionId,
  };
  return { success: true, output: JSON.stringify(data), data };
}

/**
 * The tokens-out display pair: the human string and the decimals it was
 * rendered with, or `undefined`/`null` when the token's decimals cannot be
 * read.
 *
 * A raw amount without its decimals is unreadable (rule 90), and a freshly
 * created token's decimals are not knowable before it exists - so they are read
 * from the token itself. A failed read degrades the DISPLAY string only; the
 * raw amount and its provenance are unaffected, and no decimals value is
 * guessed.
 */
async function readTokensOutDisplay(
  x: BroadcastLaunchInput,
  token: Address,
  tokensOutRaw: bigint,
): Promise<{ human: string | undefined; decimals: number | null }> {
  try {
    const decimals = await readTokenDecimals(x.publicClient, token);
    return { human: formatUnits(tokensOutRaw, decimals), decimals };
  } catch {
    return { human: undefined, decimals: null };
  }
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
      signer: x.walletClient,
      // Anchor the fee's gas estimate on the block the launch confirmed in -
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
