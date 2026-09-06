/**
 * `virtuals.launch.execute` - the orchestrator of a Virtuals agent launch.
 *
 * It owns the order in which authority is acquired and evidence is gathered,
 * and the order IS the safety property:
 *
 *   forbidden params -> closed launch shapes -> chain -> wallet ADDRESS (never
 *   decrypts) -> the public image URL -> re-read the whole chain state at the
 *   head -> rebuild the exact calldata -> hold its FINGERPRINT against the one
 *   the preview sealed -> claim the preview and CAS-authorize the intent ->
 *   resolve the signing key -> plan the rows -> stage the allowance -> stage the
 *   preLaunch -> decode the receipt -> WATCH for the keeper -> only then the fee
 *   leg.
 *
 * ## The two-transaction shape, which no other launchpad here has
 *
 * `preLaunch` is ours. `launch(token)` is the VIRTUALS KEEPER'S, about a minute
 * later, and it is what makes the agent tradable and listed. Vex NEVER sends it:
 * on 2026-09-04 our own `launch()` on Robinhood beat the keeper for token
 * `0xd1eF7097` and `api.virtuals.io` never indexed the agent, while the Base
 * agent whose `launch()` the keeper ran (`0x9eca4cb5`) was indexed as id 139289.
 * Winning that race destroys the listing the user launched for.
 *
 * So after the receipt this handler WATCHES, bounded, and the two endings are
 * both correct:
 *
 *   Launched observed  -> `confirmed`, the identity is recorded, the AgentScan
 *                         attestation is signed while the signer still exists,
 *                         and Vex's fee is collected.
 *   not observed       -> `awaiting_keeper`, which is NOT a failure, and the fee
 *                         is WAIVED PERMANENTLY (owner F3).
 *
 * ## What `simulateOnly` is, and why it stops where it does
 *
 * `simulateOnly: true` proves the path to the EDGE OF SIGNING and no further:
 * no signing key is opened, no preview is claimed, no row is written and nothing
 * is broadcast. It still needs a real preview for the identical fields, because
 * it is inspecting a real plan rather than an imaginary one, and SELECTING a
 * preview is not CLAIMING one - the preview survives the simulation intact.
 *
 * ## What is NEVER retried
 *
 * Nothing. A `preLaunch` whose outcome is unknown stays pending and is
 * reconciled by the identity sweep; the fee leg is never re-sent; a reverted
 * launch needs a fresh preview and fresh authority.
 */

import { formatUnits, getAddress, type Address, type Hex } from "viem";

import {
  decodePreLaunched,
  keeperLogReaderFrom,
  waitForKeeperLaunch,
  KEEPER_WAIT_MS,
  type KeeperObservation,
} from "@tools/virtuals/launch/index.js";
import {
  getVirtualsCurveClients,
  getVirtualsCurvePublicClient,
} from "@tools/virtuals/curve/index.js";
import { priorLegAnchorFrom, type ConfirmedPriorLeg } from "@tools/evm-chains/dependent-leg-gas-estimate.js";
import type { ChainWallet } from "@tools/wallet/multi-auth.js";
import {
  confirmActivityEvent,
  confirmLaunchWithOutputIdentity,
  createAgentActivityIntent,
  type AgentActivityEvent,
} from "@vex-agent/db/repos/agent-activity.js";
import {
  resolveSelectedAddress,
  resolveSigningWallet,
  walletScopeErrorToResult,
} from "@vex-agent/tools/internal/wallet/resolve.js";
import logger from "@utils/logger.js";

import type { ToolResult } from "../../../types.js";
import type { ProtocolExecutionContext } from "../../types.js";
import { ok, fail } from "../../handler-helpers.js";
import { summarizeProtocolError } from "../../runtime/errors.js";
import { readLaunchFields, type LaunchFields } from "./launch/params.js";
import { resolveLaunchImage } from "./launch/image.js";
import { buildLaunchPlan, describeLaunchPlan, simulateLaunchPlan, type LaunchPlan } from "./launch/plan.js";
import { abortRemainingLaunchPlans, planLaunchEvents } from "./launch/activity.js";
import { runLaunchLeg, type LaunchLegOutcome } from "./launch/broadcast.js";
import { runLaunchFeeLeg, type LaunchFeeCollection } from "./launch/fee-leg.js";
import {
  claimPreviewAndAuthorize,
  readLaunchIntent,
  recordLaunchBroadcast,
  settleLaunchFailure,
  settleLaunchOutcome,
} from "./launch/intent.js";
import { readVirtualsIntentBlock } from "./launch/intent-block.js";
import type { VirtualsLaunchIntentFields } from "@vex-agent/db/repos/token-launch-intents.js";
import { recordLaunchIdentity } from "./launch/identity.js";
import {
  LAUNCH_EXECUTE_TOOL_ID,
  LAUNCH_PREVIEW_PUBLIC_NAME,
  LAUNCH_STATUS_PUBLIC_NAME,
} from "./launch/tool-ids.js";

export async function virtualsLaunchExecute(
  p: Record<string, unknown>,
  context: ProtocolExecutionContext,
): Promise<ToolResult> {
  // The manifest declares no `dryRun`. A caller that still passes it must never
  // reach a real broadcast just because the runtime's preview matrix treated
  // the call as a preview - `simulateOnly` is this tool's own, declared,
  // no-signing mode and it is the only one.
  if (p.dryRun === true) {
    return fail(
      `${LAUNCH_EXECUTE_TOOL_ID} does not support dryRun - pass simulateOnly: true for a no-signing plan, or call `
      + `${LAUNCH_PREVIEW_PUBLIC_NAME}.`,
    );
  }

  const read = readLaunchFields(p);
  if (!read.ok) {
    if (read.handoff) {
      return ok({
        launched: false,
        supported: false,
        chain: read.handoff.chain,
        reason: read.handoff.reason,
        useInstead: read.handoff.useInstead,
      });
    }
    if (read.unsupported) {
      return ok({
        launched: false,
        supported: false,
        feature: read.unsupported.feature,
        reason: read.unsupported.reason,
      });
    }
    return fail(read.reason);
  }
  const fields = read.fields;

  const sessionId = context.sessionId;
  if (!sessionId) return fail(`${LAUNCH_EXECUTE_TOOL_ID} requires an active session.`);

  // Address-only wallet resolution - NEVER decrypts. A failure from here on can
  // be durably recorded with a real wallet address; the signing key is resolved
  // much later, and only once nothing is left that could refuse.
  let walletRaw: string;
  try {
    walletRaw = resolveSelectedAddress(context.walletResolution, context.walletPolicy, "eip155");
  } catch (err) {
    return walletScopeErrorToResult(err);
  }
  const wallet = getAddress(walletRaw);

  const simulateOnly = p.simulateOnly === true;

  // THE PREVIEW THE CALLER NAMED, checked for PRESENCE before anything is
  // claimed. The manifest cannot mark it required, because `simulateOnly` must
  // work without claiming one; so this handler owns the conditional rule. A
  // caller who simply forgot the parameter must not have their preview retired
  // by the mistake.
  const previewId = typeof p.previewId === "string" ? p.previewId.trim() : "";
  if (previewId === "" && !simulateOnly) {
    return fail(
      `${LAUNCH_EXECUTE_TOOL_ID} requires the previewId from the plan it launches. Call `
      + `${LAUNCH_PREVIEW_PUBLIC_NAME} with the same chain, name, ticker, description, cores, image, amountIn and `
      + "anti-sniper type, read the plan it returns, then pass its previewId. Nothing was claimed or signed. "
      + "(Pass simulateOnly: true instead to inspect the plan without claiming one.)",
    );
  }

  const image = await resolveLaunchImage({ params: p, context });
  if (!image.ok) return fail(image.reason);

  const client = getVirtualsCurvePublicClient(fields.deployment);
  let built;
  try {
    built = await buildLaunchPlan({ client, fields, image: image.image, wallet });
  } catch (err) {
    return fail(`Virtuals launch state unavailable (${summarizeProtocolError(err).message}). Nothing was signed.`);
  }
  if (!built.ok) return fail(built.reason);
  const plan = built.plan;

  // ── SIMULATE ONLY: the whole path to the edge of signing, and nothing past it ──
  //
  // Deliberately BEFORE the claim. A simulation that retired the preview would
  // leave the real execute with nothing to claim, which would turn an
  // inspection into a denial of the launch it was inspecting.
  if (simulateOnly) {
    const simulations = await simulateLaunchPlan({
      client,
      plan,
      wallet,
      describeError: (err) => summarizeProtocolError(err).message,
    });
    return ok({
      ...describeLaunchPlan({ plan, fields, wallet }),
      launched: false,
      simulateOnly: true,
      simulateNote:
        "No signer was opened, no preview was claimed, no activity row was written and nothing was broadcast. The "
        + "transactions below are exactly what the signing path would carry, each eth_call'd from the session wallet "
        + `address at block ${plan.state.blockNumber}. The preLaunch leg reverts here by construction whenever the `
        + "allowance leg above it has not run yet, and that is reported rather than hidden.",
      wouldSend: simulations,
    });
  }

  // ── THE SEALED PLAN, held against the freshly rebuilt one ──
  //
  // The fingerprint covers the chain id, the target, the value and every byte
  // of the calldata, so this proves the launch about to be signed is the launch
  // that was shown. It is compared BEFORE the claim, so a caller whose fields
  // drifted keeps their preview and can simply retry with the right ones.
  const preview = await readLaunchIntent(previewId, sessionId);
  if (preview === null || preview.protocol !== "virtuals") {
    return fail(
      "Refused before signing: no Virtuals launch preview with that previewId belongs to this session. Take a fresh "
      + `${LAUNCH_PREVIEW_PUBLIC_NAME} and launch against the previewId it returns. Nothing was signed.`,
    );
  }
  const sealed = readVirtualsIntentBlock(preview.virtuals);
  if (!sealed.ok) return fail(`Refused before signing: ${sealed.reason} Nothing was signed.`);
  if (sealed.block.calldataFingerprint !== plan.fingerprint) {
    return fail(
      "Refused before signing: the launch these parameters build is not the launch that preview described. The "
      + `calldata fingerprint is ${plan.fingerprint} and the preview sealed ${sealed.block.calldataFingerprint}. `
      + "Something differs - a field, the picture, the amount, or the chain state the amount was split against. "
      + `Nothing was signed and the preview was NOT consumed. Take a fresh ${LAUNCH_PREVIEW_PUBLIC_NAME} and launch `
      + "against that.",
    );
  }

  // ── THE PREVIEW, CLAIMED, AND THE AUTHORIZED INTENT, CONSUMED - one transaction ──
  const authorized = await claimPreviewAndAuthorize({
    sessionId,
    previewIntentId: previewId,
    walletAddress: wallet,
    chainId: fields.deployment.chainId,
    name: fields.name,
    symbol: fields.ticker,
    description: fields.description,
    imageId: image.image.imageId,
    committedRaw: plan.fee.committedRaw,
    decimals: plan.state.virtualDecimals,
    missionRunId: context.missionRunId ?? null,
    authorization: {
      tool: LAUNCH_EXECUTE_TOOL_ID,
      previewId,
      wallet,
      chainId: fields.deployment.chainId,
      bondingV5: fields.deployment.bondingV5,
      onChainName: plan.onChainName,
      ticker: fields.ticker,
      imageUrl: plan.image.url,
      committedRaw: plan.fee.committedRaw.toString(),
      venueReceivesRaw: plan.fee.launchAmountRaw.toString(),
      protocolFeeRaw: plan.state.protocolLaunchFeeRaw.toString(),
      vexFeeRaw: (plan.fee.feeRaw ?? 0n).toString(),
      antiSniperTaxType: fields.antiSniperTaxType,
      calldataFingerprint: plan.fingerprint,
      blockNumber: plan.state.blockNumber.toString(),
    },
    block: sealed.block,
  });
  if (!authorized.ok) return fail(authorized.reason);
  const intentId = authorized.intentId;

  // The signing key, resolved only now that every refusal above has passed.
  let signer: ChainWallet;
  try {
    signer = resolveSigningWallet(context.walletResolution, context.walletPolicy, "eip155");
  } catch (err) {
    await settleLaunchFailure(intentId, sessionId, "wallet_scope_refused");
    return walletScopeErrorToResult(err);
  }
  if (signer.family !== "eip155") {
    await settleLaunchFailure(intentId, sessionId, "wallet_family_mismatch");
    return fail("Resolved wallet family mismatch.");
  }
  if (getAddress(signer.address) !== wallet) {
    await settleLaunchFailure(intentId, sessionId, "signer_wallet_mismatch");
    return fail("Refused before signing: the signing wallet is not the wallet this launch was previewed for.");
  }

  // ── THE ROWS, before anything is signed ──
  const activityPlan = planLaunchEvents({ plan, walletAddress: wallet, sessionId, intentId });
  const { executionId, events: createdEvents } = await createAgentActivityIntent({
    toolId: LAUNCH_EXECUTE_TOOL_ID,
    namespace: "virtuals",
    intentParams: p,
    events: [...activityPlan.events],
  });
  const launchEvents = createdEvents.slice(0, activityPlan.launchLegCount);
  const feeRowId = activityPlan.hasFeeRow ? createdEvents[activityPlan.launchLegCount]?.id ?? null : null;

  const clients = getVirtualsCurveClients(fields.deployment, signer.privateKey as Hex);
  let priorLeg: ConfirmedPriorLeg | undefined;

  try {
    for (let i = 0; i < launchEvents.length; i++) {
      const event = launchEvents[i];
      if (event === undefined) break;
      const tx = event.eventRole === "allowance_reset"
        ? plan.approveResetTx
        : event.eventRole === "allowance"
          ? plan.approveTx
          : plan.preLaunchTx;

      const outcome: LaunchLegOutcome = await runLaunchLeg({
        toolId: LAUNCH_EXECUTE_TOOL_ID,
        event,
        tx,
        clients,
        priorLeg,
        label: describeRole(event.eventRole),
        // THE INTENT'S HASH IS PERSISTED BEFORE THE BYTES REACH THE NETWORK,
        // and only for the launch itself - an allowance leg is replaceable, a
        // `preLaunch` is not. A CAS miss here means another executor owns this
        // intent, and the throw aborts with nothing sent rather than minting a
        // second agent for a user whose first may already be mined.
        ...(event.eventRole === "token_launch"
          ? {
              onHashStaged: async (txHash: Hex) => {
                const staged = await recordLaunchBroadcast(intentId, sessionId, txHash);
                if (staged === null) {
                  throw new Error(
                    `token_launch_intents: markBroadcastPendingWith CAS miss for intent ${intentId} `
                    + "- another executor owns this launch; refusing to broadcast",
                  );
                }
              },
            }
          : {}),
      });

      if (outcome.kind === "ambiguous") {
        const next = createdEvents[i + 1];
        if (next) await abortRemainingLaunchPlans(executionId, next.eventIndex, `earlier ${event.eventRole} ambiguous`);
        if (event.eventRole !== "token_launch") {
          await settleLaunchFailure(intentId, sessionId, `${event.eventRole}_ambiguous`);
        }
        // A `token_launch` leg already persisted its hash in `onHashStaged`,
        // before the broadcast, so the intent is `broadcast_pending` with the
        // evidence the identity sweep needs. It is deliberately NOT terminalized
        // here: a launch marked failed is a launch a user may try again, while
        // the first preLaunch may already have minted their agent.
        return {
          success: true,
          output:
            `${LAUNCH_EXECUTE_TOOL_ID}: the ${describeRole(event.eventRole)} was broadcast (tx ${outcome.txHash}) but `
            + "Vex could not prove inclusion this turn. It is tracked automatically and is NEVER re-sent. Nothing "
            + "after it was signed.",
          data: {
            txHash: outcome.txHash,
            _executionId: executionId,
            intentId,
            status: "pending_unknown",
            launched: false,
          },
        };
      }

      if (outcome.kind === "failed") {
        const next = createdEvents[i + 1];
        if (next) await abortRemainingLaunchPlans(executionId, next.eventIndex, `earlier ${event.eventRole} failed`);
        await settleLaunchFailure(
          intentId,
          sessionId,
          `${event.eventRole}_${outcome.stage === "pre_broadcast" ? "refused" : "reverted"}`,
        );
        return {
          success: false,
          output:
            `${LAUNCH_EXECUTE_TOOL_ID}: the ${describeRole(event.eventRole)} `
            + `${outcome.stage === "pre_broadcast" ? "was refused before signing" : "reverted on-chain"} - `
            + outcome.reason,
          data: {
            _executionId: executionId,
            intentId,
            ...(outcome.txHash ? { txHash: outcome.txHash } : {}),
            launched: false,
          },
        };
      }

      priorLeg = priorLegAnchorFrom(outcome.settledAtBlock);
      if (event.eventRole !== "token_launch") {
        try {
          await confirmActivityEvent(event.id, {});
        } catch (err) {
          // Bookkeeping only - the allowance already confirmed on chain.
          logger.warn("virtuals.launch.execute.confirm_failed", {
            id: event.id, role: event.eventRole, error: summarizeProtocolError(err).message,
          });
        }
        continue;
      }

      return await finalizeConfirmedLaunch({
        p, event, outcome, executionId, intentId, sessionId, fields, plan, wallet,
        clients, priorLeg, feeRowId, launchLegCount: activityPlan.launchLegCount,
        sealed: sealed.block,
      });
    }
    throw new Error(`${LAUNCH_EXECUTE_TOOL_ID}: staged loop exited without a result`);
  } catch (err) {
    logger.warn("virtuals.launch.execute.post_intent_failure", {
      executionId, error: summarizeProtocolError(err).message,
    });
    return {
      success: false,
      output: `${LAUNCH_EXECUTE_TOOL_ID} failed after the execution was recorded: ${summarizeProtocolError(err).message}`,
      data: { _executionId: executionId, intentId, launched: false },
    };
  }
}

function describeRole(role: AgentActivityEvent["eventRole"]): string {
  if (role === "allowance_reset") return "allowance-reset transaction";
  if (role === "allowance") return "approval transaction";
  return "agent pre-launch";
}

/**
 * `preLaunch` CONFIRMED. Decode what it created, record it, WATCH for the
 * keeper, and only then take the fee.
 *
 * NOTHING in here may turn a confirmed pre-launch into a failure. The agent
 * exists; a decoder throw, a bookkeeping write that did not land, or a keeper
 * that has not acted are all reported through `status`, never through `success`.
 */
async function finalizeConfirmedLaunch(x: {
  readonly p: Record<string, unknown>;
  readonly event: AgentActivityEvent;
  readonly outcome: Extract<LaunchLegOutcome, { kind: "confirmed" }>;
  readonly executionId: number;
  readonly intentId: string;
  readonly sessionId: string;
  readonly fields: LaunchFields;
  readonly plan: LaunchPlan;
  readonly wallet: Address;
  readonly clients: ReturnType<typeof getVirtualsCurveClients>;
  readonly priorLeg: ConfirmedPriorLeg | undefined;
  readonly feeRowId: number | null;
  readonly launchLegCount: number;
  readonly sealed: VirtualsLaunchIntentFields;
}): Promise<ToolResult> {
  const { fields, plan, outcome } = x;
  const decimals = plan.state.virtualDecimals;

  // The hash is already on the intent: `runLaunchLeg`'s `onHashStaged` wrote it
  // BEFORE the broadcast, which is the only ordering under which a crash here
  // leaves a mined `preLaunch` the identity sweep can still find.
  const preLaunched = decodePreLaunched({
    logs: outcome.receipt.logs.map((log) => ({ address: log.address, topics: log.topics, data: log.data })),
    bondingV5: fields.deployment.bondingV5,
  });

  if (preLaunched === null) {
    // The transaction succeeded and its own event could not be read. The agent
    // very probably exists; Vex declines to say WHICH one, leaves the intent
    // `broadcast_pending` for the identity sweep, and takes NO FEE - it has no
    // proof of a launch to charge for.
    logger.warn("virtuals.launch.execute.prelaunch_undecoded", { id: x.event.id, txHash: outcome.txHash });
    await abortRemainingLaunchPlans(
      x.executionId,
      x.launchLegCount,
      "the PreLaunched event could not be decoded, so no launch is proven to charge for",
    );
    return ok({
      launched: true,
      status: "confirmed_pending_identity",
      txHash: outcome.txHash,
      intentId: x.intentId,
      chain: fields.deployment.key,
      chainId: fields.deployment.chainId,
      _executionId: x.executionId,
      note:
        "The pre-launch transaction confirmed, but its PreLaunched event could not be read from the receipt, so Vex "
        + "will not name the agent token it created. The launch is tracked and reconciles automatically. NO VEX FEE "
        + "was taken: Vex does not charge for a launch it cannot prove.",
      vexFee: { collection: "not_charged", reason: "the launch could not be proven from its own receipt" },
    });
  }

  const token = preLaunched.token;
  const blockOnChain = {
    ...x.sealed,
    pairAddress: preLaunched.pair,
    virtualId: preLaunched.virtualId.toString(),
    initialPurchaseRaw: preLaunched.initialPurchaseRaw.toString(),
    preLaunchBlock: outcome.receipt.blockNumber.toString(),
  };

  // ── WATCH for the keeper. Never call `launch()`. ──
  let observation: KeeperObservation;
  try {
    observation = await waitForKeeperLaunch({
      client: keeperLogReaderFrom(x.clients.publicClient),
      deployment: fields.deployment,
      token,
      fromBlock: outcome.receipt.blockNumber,
    });
  } catch (err) {
    // A throw from the watcher is a statement about our RPC, not about the
    // chain. It is treated exactly as "not observed": the launch is real, the
    // fee is waived, and the sweep will look again.
    logger.warn("virtuals.launch.execute.keeper_wait_threw", {
      id: x.event.id, error: summarizeProtocolError(err).message,
    });
    observation = { kind: "not_observed", waitedMs: 0, lastReadError: "keeper_wait_threw" };
  }

  const launched = observation.kind === "observed";

  // THE OUTPUT LEG RECORDS WHAT THIS LAUNCH HAS DELIVERED AT THE MOMENT OF THE
  // WRITE, and that is one rule with two answers rather than two rules.
  //
  // `preLaunch` itself buys NOTHING: it mints the token, creates the pair and
  // parks the creator's VIRTUAL inside BondingV5. The agent tokens are bought by
  // the keeper's `launch()` (`BondingV5.sol:619-641`, `_buy(initialPurchase,
  // token, creator)`), in a different transaction. So when the keeper acted
  // inside this call's wait, the proven `initialPurchasedAmount` is what this
  // launch delivered and is recorded; when it did not, the honest figure is
  // zero, and the keeper sweep writes the real one when it observes the launch.
  // Writing an expected amount in the second case would put an amount nobody
  // observed into an audit row.
  const deliveredRaw = observation.kind === "observed"
    ? observation.launched.initialPurchasedAmountRaw
    : 0n;
  try {
    await confirmLaunchWithOutputIdentity(x.event.id, {
      executedAmountInRaw: plan.fee.launchAmountRaw.toString(),
      executedAmountInHuman: formatUnits(plan.fee.launchAmountRaw, decimals),
      executedAmountOutRaw: deliveredRaw.toString(),
      tokenOutAddress: token,
      tokenOutSymbol: fields.ticker,
    });
  } catch (err) {
    logger.warn("virtuals.launch.execute.confirm_failed", {
      id: x.event.id, error: summarizeProtocolError(err).message,
    });
  }

  // The identity row and the AgentScan attestation, written while the signer
  // still exists. Best-effort by contract: neither may unsay a confirmed launch.
  const identity = await recordLaunchIdentity({
    deployment: fields.deployment,
    wallet: x.wallet,
    token,
    name: plan.onChainName,
    symbol: fields.ticker,
    imageRef: plan.image.url,
    createTxHash: outcome.txHash,
    sessionId: x.sessionId,
    protocolExecutionId: x.executionId,
    initialPurchaseRaw: preLaunched.initialPurchaseRaw,
    decimals,
    walletClient: x.clients.walletClient,
  });

  const settled = await settleLaunchOutcome({
    intentId: x.intentId,
    sessionId: x.sessionId,
    txHash: outcome.txHash,
    tokenAddress: token,
    outcome: launched ? "confirmed" : "awaiting_keeper",
    block: {
      ...blockOnChain,
      ...(observation.kind === "observed" ? { keeperLaunchTxHash: observation.txHash } : {}),
      vexFeeWaived: !launched,
    },
  });

  // ── The fee leg, LAST, and only when the keeper's launch was OBSERVED ──
  const fee: LaunchFeeCollection = await runLaunchFeeLeg({
    deployment: fields.deployment,
    feeRowId: x.feeRowId,
    executionId: x.executionId,
    launchLegCount: x.launchLegCount,
    feeRaw: plan.fee.feeRaw,
    keeperLaunchObserved: launched,
    clients: x.clients,
    priorLeg: x.priorLeg,
  });

  const payload = {
    launched: true,
    status: launched ? "launched" : "awaiting_keeper",
    txHash: outcome.txHash,
    intentId: x.intentId,
    chain: fields.deployment.key,
    chainId: fields.deployment.chainId,
    agent: {
      token,
      pair: preLaunched.pair,
      virtualId: preLaunched.virtualId.toString(),
      onChainName: plan.onChainName,
      ticker: fields.ticker,
      imageUrl: plan.image.url,
    },
    money: {
      committedRaw: plan.fee.committedRaw.toString(),
      committed: formatUnits(plan.fee.committedRaw, decimals),
      initialPurchaseRaw: preLaunched.initialPurchaseRaw.toString(),
      initialPurchase: formatUnits(preLaunched.initialPurchaseRaw, decimals),
      symbol: "VIRTUAL",
      decimals,
      refundableOnCancelRaw: preLaunched.initialPurchaseRaw.toString(),
      refundableOnCancelNote:
        "This is exactly what virtuals__agent_launch_cancel would return - the initial purchase and nothing else.",
    },
    keeper: launched
      ? {
          observed: true,
          launchTxHash: observation.kind === "observed" ? observation.txHash : null,
          initialPurchasedAmountRaw:
            observation.kind === "observed" ? observation.launched.initialPurchasedAmountRaw.toString() : null,
          note:
            "The Virtuals keeper executed launch() and Vex saw the Launched event. The agent is live on its bonding "
            + "curve and the anti-sniper window has started.",
        }
      : {
          observed: false,
          waitedSeconds: Math.round((observation.kind === "not_observed" ? observation.waitedMs : 0) / 1000),
          note:
            "THIS IS NOT A FAILURE. Your agent exists on chain and your VIRTUAL is held by BondingV5, but the "
            + `Virtuals keeper had not run launch() within the ${Math.round(KEEPER_WAIT_MS / 1000)} s Vex waited. `
            + "Vex never calls launch() itself - doing so pre-empts the keeper and the agent is then never listed by "
            + "the platform. The launch reconciles automatically; check it with "
            + `${LAUNCH_STATUS_PUBLIC_NAME}. Until the keeper acts you may still cancel and get the initial purchase `
            + "back.",
        },
    attestation: identity.attestation,
    ...(settled ? {} : {
      recordNote:
        "The launch is real and its transaction is on chain, but Vex's own record of it could not be updated this "
        + "turn. Nothing was signed twice; the record reconciles automatically.",
    }),
    vexFee: fee,
    _executionId: x.executionId,
  };

  return { success: true, output: JSON.stringify(payload, null, 2), data: payload };
}
