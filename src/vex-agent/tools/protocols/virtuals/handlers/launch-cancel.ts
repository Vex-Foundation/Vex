/**
 * `virtuals.launch.cancel` - take the initial purchase back from a launch the
 * keeper has not run yet.
 *
 * ## THE DISCLOSURE THIS TOOL EXISTS TO MAKE (owner L2)
 *
 * `cancelLaunch` refunds `tokenRef.initialPurchase` AND NOTHING ELSE
 * (`BondingV5.sol:559-565`). Any protocol launch fee the venue charged at
 * `preLaunch` was transferred to `bondingConfig.feeTo()` inside that
 * transaction (`:375-379`) and is NOT part of the refund. For the only launch
 * shape Vex signs - normal, immediate, no ACF - that fee is 0, measured live on
 * both chains, so today the refund IS the whole venue-side amount. The approval
 * still states the number rather than the reassurance, because the contract
 * will happily charge one for other shapes and a disclosure that is true only
 * by accident is not a disclosure.
 *
 * Vex's own fee is a separate matter and is stated too: it is charged only when
 * a keeper launch was observed, so a launch that reached the point of being
 * cancellable was never charged one.
 *
 * ## When the contract will and will not accept this
 *
 * `cancelLaunch` requires the caller to be `tokenRef.creator` and refuses once
 * `launchExecuted` is set - which the keeper's `launch()` does (`:546-557`). So
 * a live agent CANNOT be cancelled: it is sold on its curve instead. That is a
 * typed refusal here rather than a wasted transaction, and it is why this tool
 * simulates before it signs.
 *
 * ## What it never does
 *
 * It does not call `launch()`. It does not race the keeper. It does not retry:
 * a cancel whose outcome is unknown stays pending and is reconciled.
 */

import { formatUnits, getAddress, isAddress, type Hex } from "viem";

import {
  buildCancelLaunchTx,
  decodeCancelledLaunch,
} from "@tools/virtuals/launch/index.js";
import { classifyLaunchRevert } from "@tools/virtuals/launch/revert-mapping.js";
import { BONDING_V5_TOKEN_INFO_ABI } from "@tools/virtuals/curve/abi.js";
import {
  getVirtualsCurveClients,
  getVirtualsCurvePublicClient,
  virtualsCurveDeployment,
  type VirtualsCurveDeployment,
} from "@tools/virtuals/curve/index.js";
import type { ChainWallet } from "@tools/wallet/multi-auth.js";
import {
  confirmActivityEvent,
  createAgentActivityIntent,
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
import { failLaunchPreBroadcast, planCancelEvent } from "./launch/activity.js";
import { runLaunchLeg } from "./launch/broadcast.js";
import { readLaunchIntent, recordLaunchCancelled } from "./launch/intent.js";
import { readVirtualsIntentBlock } from "./launch/intent-block.js";
import { resolveLaunchChain } from "./launch/params.js";
import {
  LAUNCH_CANCEL_TOOL_ID,
  LAUNCH_STATUS_PUBLIC_NAME,
  PROTOCOL,
} from "./launch/tool-ids.js";

/** What BondingV5 itself says about a token, at one pinned block. */
interface CancelTarget {
  readonly deployment: VirtualsCurveDeployment;
  readonly token: `0x${string}`;
  readonly creator: string;
  readonly pair: string;
  readonly launchExecuted: boolean;
  readonly initialPurchaseRaw: bigint;
  readonly blockNumber: bigint;
  /** The intent this cancel belongs to, when the caller named one. */
  readonly intentId: string | null;
}

export async function virtualsLaunchCancel(
  p: Record<string, unknown>,
  context: ProtocolExecutionContext,
): Promise<ToolResult> {
  if (p.dryRun === true) {
    return fail(`${LAUNCH_CANCEL_TOOL_ID} does not support dryRun - pass simulateOnly: true for a no-signing plan.`);
  }

  const sessionId = context.sessionId;
  if (!sessionId) return fail(`${LAUNCH_CANCEL_TOOL_ID} requires an active session.`);

  let walletRaw: string;
  try {
    walletRaw = resolveSelectedAddress(context.walletResolution, context.walletPolicy, "eip155");
  } catch (err) {
    return walletScopeErrorToResult(err);
  }
  const wallet = getAddress(walletRaw);

  const resolved = await resolveCancelTarget(p, sessionId);
  if (!resolved.ok) return resolved.result;
  const target = resolved.target;
  const { deployment } = target;
  const decimals = deployment.virtualDecimals;

  // ── The contract's own authority, held before anything is signed ──
  if (target.launchExecuted) {
    return ok({
      cancelled: false,
      supported: false,
      chain: deployment.key,
      chainId: deployment.chainId,
      token: target.token,
      reason:
        "This launch can no longer be cancelled: BondingV5 records it as already executed, which means the Virtuals "
        + "keeper ran launch() (the agent is live on its bonding curve) or the launch was cancelled before. "
        + "cancelLaunch reverts with InvalidTokenStatus in both cases. To exit a live agent, sell it with "
        + "virtuals__agent_trade_execute instead.",
      useInstead: "virtuals__agent_trade_quote / virtuals__agent_trade_execute",
    });
  }
  if (getAddress(target.creator) !== wallet) {
    return fail(
      "Refused before signing: BondingV5 records this agent's creator as "
      + `${getAddress(target.creator)}, and the selected wallet is ${wallet}. cancelLaunch only accepts the creator, `
      + "so this would revert. Nothing was signed.",
    );
  }

  const tx = buildCancelLaunchTx({ deployment, token: target.token });
  const client = getVirtualsCurvePublicClient(deployment);

  const refund = {
    amountRaw: target.initialPurchaseRaw.toString(),
    amount: formatUnits(target.initialPurchaseRaw, decimals),
    symbol: "VIRTUAL",
    decimals,
    // The disclosure, stated as data rather than only as prose, so a card
    // renderer cannot drop it while keeping the number.
    protocolFeeRefunded: false,
    note:
      "cancelLaunch returns the INITIAL PURCHASE only (BondingV5.sol:559). Any protocol launch fee the venue took "
      + "when the agent was pre-launched went to its fee recipient inside that transaction and is NOT refunded. For "
      + "the normal immediate launches Vex signs, that fee is 0, so the refund above is the whole amount the venue "
      + "holds. Gas for this cancel is yours either way. Vex charges nothing for a cancel, and it never charged a "
      + "launch fee for an agent the keeper had not launched.",
  };

  const preview = {
    chain: deployment.key,
    chainId: deployment.chainId,
    token: target.token,
    pair: target.pair,
    creator: getAddress(target.creator),
    wallet,
    bondingV5: deployment.bondingV5,
    blockNumber: target.blockNumber.toString(),
    refund,
    ...(target.intentId === null ? {} : { intentId: target.intentId }),
  };

  // ── SIMULATE: always, and it is the last gate before the key is opened ──
  let simulationOk = true;
  let simulationReason: string | undefined;
  try {
    await client.call({ account: wallet, to: tx.to, data: tx.data, value: tx.value });
  } catch (err) {
    simulationOk = false;
    simulationReason = classifyLaunchRevert(err).reason;
  }

  if (p.simulateOnly === true) {
    return ok({
      ...preview,
      cancelled: false,
      simulateOnly: true,
      wouldSend: {
        to: tx.to,
        data: tx.data,
        value: tx.value.toString(),
        ok: simulationOk,
        ...(simulationReason === undefined ? {} : { revertReason: simulationReason }),
      },
      simulateNote:
        "No signer was opened, no activity row was written and nothing was broadcast. The transaction above is "
        + "exactly what the signing path would carry, eth_call'd from the session wallet address.",
    });
  }

  if (!simulationOk) {
    return fail(`Refused before signing: ${simulationReason ?? "the cancel would revert."} Nothing was signed.`);
  }

  // The signing key, resolved only now that every refusal above has passed.
  let signer: ChainWallet;
  try {
    signer = resolveSigningWallet(context.walletResolution, context.walletPolicy, "eip155");
  } catch (err) {
    return walletScopeErrorToResult(err);
  }
  if (signer.family !== "eip155") return fail("Resolved wallet family mismatch.");
  if (getAddress(signer.address) !== wallet) {
    return fail("Refused before signing: the signing wallet is not the wallet this cancel was checked for.");
  }

  const { executionId, events } = await createAgentActivityIntent({
    toolId: LAUNCH_CANCEL_TOOL_ID,
    namespace: PROTOCOL,
    intentParams: p,
    events: [
      planCancelEvent({
        deployment,
        walletAddress: wallet,
        sessionId,
        tokenAddress: target.token,
        expectedRefundRaw: target.initialPurchaseRaw,
      }),
    ],
  });
  const event = events[0];
  if (event === undefined) {
    return fail(`${LAUNCH_CANCEL_TOOL_ID}: the cancel could not be recorded, so nothing was signed.`);
  }

  const clients = getVirtualsCurveClients(deployment, signer.privateKey as Hex);
  const outcome = await runLaunchLeg({
    toolId: LAUNCH_CANCEL_TOOL_ID,
    event,
    tx,
    clients,
    priorLeg: undefined,
    label: "launch cancel",
  });

  if (outcome.kind === "ambiguous") {
    return {
      success: true,
      output:
        `${LAUNCH_CANCEL_TOOL_ID}: the cancel was broadcast (tx ${outcome.txHash}) but Vex could not prove inclusion `
        + "this turn. It is tracked automatically and is NEVER re-sent. Check again with "
        + `${LAUNCH_STATUS_PUBLIC_NAME}.`,
      data: { ...preview, cancelled: false, status: "pending_unknown", txHash: outcome.txHash, _executionId: executionId },
    };
  }
  if (outcome.kind === "failed") {
    return {
      success: false,
      output:
        `${LAUNCH_CANCEL_TOOL_ID}: the cancel `
        + `${outcome.stage === "pre_broadcast" ? "was refused before signing" : "reverted on-chain"} - ${outcome.reason}`,
      data: {
        ...preview,
        cancelled: false,
        ...(outcome.txHash ? { txHash: outcome.txHash } : {}),
        _executionId: executionId,
      },
    };
  }

  // CONFIRMED. Nothing below may turn a settled refund into a failure.
  const decoded = decodeCancelledLaunch({
    logs: outcome.receipt.logs.map((log) => ({ address: log.address, topics: log.topics, data: log.data })),
    bondingV5: deployment.bondingV5,
  });
  const refundedRaw = decoded === null ? target.initialPurchaseRaw : decoded.refundedRaw;

  try {
    await confirmActivityEvent(event.id, {
      executedAmountOutRaw: refundedRaw.toString(),
      executedAmountOutHuman: formatUnits(refundedRaw, decimals),
    });
  } catch (err) {
    logger.warn("virtuals.launch.cancel.confirm_failed", {
      id: event.id, error: summarizeProtocolError(err).message,
    });
  }

  let recorded = false;
  if (target.intentId !== null) {
    try {
      recorded = await recordLaunchCancelled({
        intentId: target.intentId,
        sessionId,
        tokenAddress: target.token,
      });
    } catch (err) {
      logger.warn("virtuals.launch.cancel.intent_settle_failed", {
        intentId: target.intentId, error: summarizeProtocolError(err).message,
      });
    }
  }

  const payload = {
    ...preview,
    cancelled: true,
    txHash: outcome.txHash,
    settlement: decoded === null
      ? {
          decoded: false,
          note:
            "The cancel confirmed on chain but its CancelledLaunch event could not be read from the receipt, so the "
            + "refund below is the amount the contract owed rather than the amount the event proved. The exact "
            + "figures are on the transaction.",
          refundedRaw: refundedRaw.toString(),
          refunded: formatUnits(refundedRaw, decimals),
        }
      : {
          decoded: true,
          refundedRaw: decoded.refundedRaw.toString(),
          refunded: formatUnits(decoded.refundedRaw, decimals),
          virtualId: decoded.virtualId.toString(),
        },
    ...(target.intentId !== null && !recorded
      ? {
          recordNote:
            "The cancel is on chain, but Vex's own record of the launch could not be updated this turn. Nothing was "
            + "signed twice; the record reconciles automatically.",
        }
      : {}),
    _executionId: executionId,
  };
  return { success: true, output: JSON.stringify(payload, null, 2), data: payload };
}

type ResolveTargetResult =
  | { readonly ok: true; readonly target: CancelTarget }
  | { readonly ok: false; readonly result: ToolResult };

/**
 * Find the token and read BondingV5's own record of it.
 *
 * TWO WAYS IN, one authority. A caller may name the `intentId` Vex returned (the
 * ordinary path) or the token directly with its chain (a launch Vex did not
 * record, or one from another session). Either way the CONTRACT decides who the
 * creator is, whether the launch is still open and what would be refunded - the
 * stored intent is never the authority for any of those.
 */
async function resolveCancelTarget(
  p: Record<string, unknown>,
  sessionId: string,
): Promise<ResolveTargetResult> {
  const intentId = typeof p.intentId === "string" ? p.intentId.trim() : "";
  const tokenParam = typeof p.token === "string" ? p.token.trim() : "";

  let deployment: VirtualsCurveDeployment | undefined;
  let token: `0x${string}` | null = null;
  let boundIntentId: string | null = null;

  if (intentId !== "") {
    const intent = await readLaunchIntent(intentId, sessionId);
    if (intent === null || intent.protocol !== "virtuals") {
      return {
        ok: false,
        result: fail(
          "No Virtuals launch with that intentId belongs to this session. Pass the `intentId` "
          + "virtuals__agent_launch_execute returned, or name the token and its chain directly.",
        ),
      };
    }
    if (intent.tokenAddress === null) {
      return {
        ok: false,
        result: fail(
          "That launch has no agent token on chain, so there is nothing to cancel. Check it with "
          + `${LAUNCH_STATUS_PUBLIC_NAME}.`,
        ),
      };
    }
    const block = readVirtualsIntentBlock(intent.virtuals);
    if (!block.ok) return { ok: false, result: fail(block.reason) };
    deployment = virtualsCurveDeployment(block.block.chainKey);
    token = getAddress(intent.tokenAddress);
    boundIntentId = intentId;
  } else if (tokenParam !== "") {
    if (!isAddress(tokenParam)) {
      return { ok: false, result: fail(`"${tokenParam}" is not a 20-byte contract address.`) };
    }
    const chainRaw = typeof p.chain === "string" ? p.chain : "";
    if (chainRaw.trim() === "") {
      return {
        ok: false,
        result: fail("chain is required when you cancel by token: Vex must know which BondingV5 to call."),
      };
    }
    const chain = resolveLaunchChain(chainRaw);
    if (chain.kind === "invalid") return { ok: false, result: fail(chain.reason) };
    if (chain.kind === "handoff") {
      return {
        ok: false,
        result: ok({ cancelled: false, supported: false, chain: chain.chain, reason: chain.reason }),
      };
    }
    deployment = chain.deployment;
    token = getAddress(tokenParam);
  } else {
    return {
      ok: false,
      result: fail("Pass either intentId (the id virtuals__agent_launch_execute returned) or token with its chain."),
    };
  }

  if (deployment === undefined || token === null) {
    return { ok: false, result: fail("Vex has no Virtuals contract table for that chain.") };
  }

  const client = getVirtualsCurvePublicClient(deployment);
  try {
    const blockNumber = await client.getBlockNumber();
    const info = await client.readContract({
      address: deployment.bondingV5,
      abi: BONDING_V5_TOKEN_INFO_ABI,
      functionName: "tokenInfo",
      args: [token],
      blockNumber,
    });
    // THE AUTO-GETTER'S MEMBER ORDER IS THE CONTRACT (`curve/abi.ts`), and
    // `cores` is absent because Solidity auto getters omit array members - which
    // is exactly what makes an off-by-one here silent rather than loud. The
    // seventeen members are: 0 creator, 1 token, 2 pair, 3 agentToken, 4 data,
    // 5 description, 6 image, 7-10 the four urls, 11 trading,
    // 12 tradingOnUniswap, 13 applicationId, 14 initialPurchase, 15 virtualId,
    // 16 launchExecuted.
    const creator = info[0];
    const pair = info[2];
    const initialPurchaseRaw = info[14];
    const launchExecuted = info[16];
    if (creator === "0x0000000000000000000000000000000000000000" || pair === "0x0000000000000000000000000000000000000000") {
      return {
        ok: false,
        result: fail(
          `BondingV5 on ${deployment.name} has no record of ${token}, so there is no launch to cancel. `
          + "cancelLaunch reverts with InvalidInput on a token that was never pre-launched.",
        ),
      };
    }
    return {
      ok: true,
      target: {
        deployment,
        token,
        creator,
        pair,
        launchExecuted,
        initialPurchaseRaw,
        blockNumber,
        intentId: boundIntentId,
      },
    };
  } catch (err) {
    return {
      ok: false,
      result: await failLaunchPreBroadcast(
        LAUNCH_CANCEL_TOOL_ID,
        p,
        { deployment, walletAddress: "", sessionId, eventRole: "launch_cancel" },
        {
          code: "simulation_reverted",
          reason:
            `Vex could not read BondingV5 on ${deployment.name} for this agent `
            + `(${summarizeProtocolError(err).message}), so it cannot say who may cancel it or what would be `
            + "refunded. Nothing was signed.",
        },
      ),
    };
  }
}
