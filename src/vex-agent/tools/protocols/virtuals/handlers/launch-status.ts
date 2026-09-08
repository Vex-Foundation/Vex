/**
 * `virtuals.launch.status` - where one launch actually stands, on chain and in
 * the platform's index.
 *
 * READ-ONLY, and the one place in this lane that answers the question the
 * two-transaction shape creates: "my pre-launch confirmed, so is my agent
 * live?". That question has three different answers with three different
 * remedies, and nothing else in the tool surface can tell them apart:
 *
 *   awaiting_keeper  the pre-launch is on chain and the keeper has not run
 *                    `launch()`. Not a failure. Cancellable.
 *   launched         the keeper ran it: the agent trades on its curve, the
 *                    anti-sniper window is running, and the platform will index
 *                    it. Not cancellable - `cancelLaunch` reverts.
 *   cancelled        the creator took the initial purchase back.
 *
 * ## It OBSERVES and it never acts - including on Vex's own records
 *
 * It does not call `launch()`. It does not sign. It does not take a fee - the
 * fee was waived permanently the moment the launch was recorded
 * `awaiting_keeper` (owner F3), and observing the keeper later does not revive
 * it. AND IT WRITES NOTHING, which is the reason its manifest can honestly say
 * `mutating: false`.
 *
 * That last point was a deliberate choice against a tempting shortcut. This
 * read makes exactly the observation the keeper sweep makes, so it could settle
 * the row itself and save a tick. It does not, because `mutating: false` is
 * what decides whether a call needs an approval, and a read tool that quietly
 * transitions durable launch state would make that flag a lie about a money
 * path (rules 01 and 09: policy may express intent, the authorized owner
 * performs the effect). The sweep owns the transition and runs every 30 s.
 *
 * So a launch the keeper has just executed can be reported here as
 * `launched: true` while `recordedStatus` still says `awaiting_keeper`. That is
 * not a contradiction and the reply says so: the chain is the authority and the
 * record catches up.
 *
 * ## The API check is a SECOND question, not a confirmation
 *
 * `Launched` on chain and "indexed by api.virtuals.io" are different facts, and
 * the incident that shaped this lane is precisely a token that had the first
 * and never got the second (`0xd1eF7097`, whose `launch()` Vex itself sent).
 * So the API row is reported separately, labelled, and never used to contradict
 * the chain.
 */

import { formatUnits, getAddress, isAddress, type Address } from "viem";

import {
  keeperLogReaderFrom,
  readKeeperOutcome,
  type DecodedLaunched,
} from "@tools/virtuals/launch/index.js";
import {
  getVirtualsCurvePublicClient,
  virtualsCurveDeployment,
  virtualsCurveDeploymentByChainId,
  type VirtualsCurveDeployment,
} from "@tools/virtuals/curve/index.js";
import { getVirtualsClient } from "@tools/virtuals/client.js";
import {
  resolveSelectedAddress,
  walletScopeErrorToResult,
} from "@vex-agent/tools/internal/wallet/resolve.js";
import type { ToolResult } from "../../../types.js";
import type { ProtocolExecutionContext } from "../../types.js";
import { ok, fail } from "../../handler-helpers.js";
import { summarizeProtocolError } from "../../runtime/errors.js";
import { readLaunchIntent } from "./launch/intent.js";
import { readVirtualsIntentBlock } from "./launch/intent-block.js";
import { resolveVirtualsChain } from "../chain-param.js";
import { resolveLaunchChain } from "./launch/params.js";
import { LAUNCH_CANCEL_PUBLIC_NAME, LAUNCH_STATUS_TOOL_ID } from "./launch/tool-ids.js";

export async function virtualsLaunchStatus(
  p: Record<string, unknown>,
  context: ProtocolExecutionContext,
): Promise<ToolResult> {
  const sessionId = context.sessionId;
  if (!sessionId) return fail(`${LAUNCH_STATUS_TOOL_ID} requires an active session.`);

  const intentId = typeof p.intentId === "string" ? p.intentId.trim() : "";
  const tokenParam = typeof p.token === "string" ? p.token.trim() : "";
  if (intentId === "" && tokenParam === "") {
    return fail(
      "Pass either intentId (the id virtuals__agent_launch_execute returned) or token (the agent's contract "
      + "address) with its chain.",
    );
  }

  // Address only - a status read NEVER decrypts.
  try {
    resolveSelectedAddress(context.walletResolution, context.walletPolicy, "eip155");
  } catch (err) {
    return walletScopeErrorToResult(err);
  }

  if (intentId !== "") return await statusFromIntent(intentId, sessionId);
  return await statusFromToken(p, tokenParam);
}

/** The rich answer: everything Vex durably knows plus a fresh chain observation. */
async function statusFromIntent(intentId: string, sessionId: string): Promise<ToolResult> {
  const intent = await readLaunchIntent(intentId, sessionId);
  if (intent === null || intent.protocol !== "virtuals") {
    return fail(
      "No Virtuals launch with that intentId belongs to this session. The id is the `intentId` "
      + "virtuals__agent_launch_execute returned.",
    );
  }
  const block = readVirtualsIntentBlock(intent.virtuals);
  if (!block.ok) return fail(block.reason);

  const deployment = virtualsCurveDeployment(block.block.chainKey);
  if (deployment === undefined) {
    return fail(`This launch names chain "${block.block.chainKey}", which Vex has no Virtuals contract table for.`);
  }

  const base = {
    intentId,
    chain: deployment.key,
    chainId: deployment.chainId,
    recordedStatus: intent.status,
    txHash: intent.txHash,
    token: intent.tokenAddress,
    onChainName: block.block.onChainName,
    ticker: intent.symbol,
    pair: block.block.pairAddress ?? null,
    virtualId: block.block.virtualId ?? null,
    imageUrl: block.block.imageUrl,
    vexFeeWaived: block.block.vexFeeWaived === true,
  };

  // Nothing to observe yet: the launch never reached the chain.
  if (intent.tokenAddress === null) {
    return ok({
      ...base,
      launched: false,
      keeper: { observed: false, note: describeRecordedStatus(intent.status) },
      note: describeRecordedStatus(intent.status),
    });
  }

  const token = getAddress(intent.tokenAddress);
  const fromBlock = block.block.preLaunchBlock === null || block.block.preLaunchBlock === undefined
    ? 0n
    : BigInt(block.block.preLaunchBlock);

  let observation;
  try {
    observation = await readKeeperOutcome({
      client: keeperLogReaderFrom(getVirtualsCurvePublicClient(deployment)),
      deployment,
      token,
      fromBlock,
    });
  } catch (err) {
    // An unreadable chain is UNKNOWN, never a verdict. The recorded status is
    // still reported, labelled as the last thing Vex actually proved.
    return ok({
      ...base,
      launched: intent.status === "confirmed",
      keeper: {
        observed: false,
        unknown: true,
        note:
          `Vex could not read ${deployment.name} to check whether the keeper has launched this agent `
          + `(${summarizeProtocolError(err).message}). The status above is the last thing Vex proved, not a fresh `
          + "observation.",
      },
    });
  }

  if (observation.kind === "cancelled") {
    return ok({
      ...base,
      launched: false,
      cancelled: true,
      keeper: { observed: false, note: "This launch was cancelled before the keeper ran it." },
      refund: {
        amountRaw: observation.cancelled.refundedRaw.toString(),
        amount: formatUnits(observation.cancelled.refundedRaw, deployment.virtualDecimals),
        symbol: "VIRTUAL",
        txHash: observation.txHash,
      },
    });
  }

  if (observation.kind === "none") {
    return ok({
      ...base,
      launched: false,
      keeper: {
        observed: false,
        note:
          "The Virtuals keeper has not run launch() for this agent yet. The pre-launch is on chain and your VIRTUAL "
          + "is held by BondingV5. Vex never calls launch() itself: doing so pre-empts the keeper and the platform "
          + "then never indexes the agent. Check again shortly, or take the initial purchase back with "
          + `${LAUNCH_CANCEL_PUBLIC_NAME}.`,
      },
      cancellable: true,
    });
  }

  // OBSERVED. NOTHING IS WRITTEN - see the module header. The reconciliation
  // sweep owns the transition and will make it within its own tick.
  const indexed = await readIndexStatus(token, deployment);
  return ok({
    ...base,
    launched: true,
    ...(intent.status === "awaiting_keeper"
      ? {
          recordCatchingUp:
            "The chain says this agent is live. Vex's own record still says awaiting_keeper and will catch up on its "
            + "next reconciliation pass - this read deliberately changes no stored state, so that checking a launch "
            + "can never be mistaken for acting on one.",
        }
      : {}),
    keeper: describeLaunched(observation.launched, observation.txHash, deployment),
    indexing: indexed,
    vexFee: {
      collection: block.block.vexFeeWaived === true ? "waived" : "as_recorded_at_launch",
      note: block.block.vexFeeWaived === true
        ? "Vex's fee on this launch was waived permanently when the keeper had not acted inside the launch call's "
          + "wait. Observing the launch now does not revive it and you will never be charged for it."
        : "Vex's fee was settled by the launch call itself; this read changes nothing about it.",
    },
    cancellable: false,
  });
}

/** The thin answer for a token Vex has no intent for: chain plus index, nothing claimed. */
async function statusFromToken(p: Record<string, unknown>, tokenParam: string): Promise<ToolResult> {
  if (!isAddress(tokenParam)) return fail(`"${tokenParam}" is not a 20-byte contract address.`);
  const token = getAddress(tokenParam);

  const chainRaw = typeof p.chain === "string" ? p.chain : "";
  let deployment: VirtualsCurveDeployment | undefined;
  if (chainRaw.trim() !== "") {
    const resolved = resolveLaunchChain(chainRaw);
    if (resolved.kind === "invalid") return fail(resolved.reason);
    if (resolved.kind === "handoff") return ok({ supported: false, chain: resolved.chain, reason: resolved.reason });
    deployment = resolved.deployment;
  } else if (typeof p.chainId === "number") {
    deployment = virtualsCurveDeploymentByChainId(p.chainId);
  }
  if (deployment === undefined) {
    return fail("chain is required when you ask by token: Vex must know which BondingV5 to read.");
  }

  // NO `fromBlock` IS KNOWN HERE, so the scan is bounded by the node's own
  // range rather than by a launch Vex recorded. A node that refuses the range
  // is reported as unknown rather than as "not launched".
  let observation;
  try {
    observation = await readKeeperOutcome({
      client: keeperLogReaderFrom(getVirtualsCurvePublicClient(deployment)),
      deployment,
      token,
      fromBlock: 0n,
    });
  } catch (err) {
    return ok({
      chain: deployment.key,
      chainId: deployment.chainId,
      token,
      launched: null,
      note:
        `Vex could not scan ${deployment.name} for this agent's Launched event `
        + `(${summarizeProtocolError(err).message}), so its launch state is UNKNOWN - not "not launched". Ask again `
        + "with the intentId if you have one, which narrows the scan to the block the pre-launch landed in.",
    });
  }

  const indexed = await readIndexStatus(token, deployment);
  if (observation.kind === "observed") {
    return ok({
      chain: deployment.key,
      chainId: deployment.chainId,
      token,
      launched: true,
      keeper: describeLaunched(observation.launched, observation.txHash, deployment),
      indexing: indexed,
    });
  }
  if (observation.kind === "cancelled") {
    return ok({
      chain: deployment.key,
      chainId: deployment.chainId,
      token,
      launched: false,
      cancelled: true,
      refund: {
        amountRaw: observation.cancelled.refundedRaw.toString(),
        amount: formatUnits(observation.cancelled.refundedRaw, deployment.virtualDecimals),
        symbol: "VIRTUAL",
        txHash: observation.txHash,
      },
      indexing: indexed,
    });
  }
  return ok({
    chain: deployment.key,
    chainId: deployment.chainId,
    token,
    launched: false,
    note:
      "No Launched event for this agent was found in the range the node served. Either the keeper has not run "
      + "launch() yet, or the pre-launch is older than the range. This is not proof that it was never launched.",
    indexing: indexed,
  });
}

function describeLaunched(
  launched: DecodedLaunched,
  txHash: string,
  deployment: VirtualsCurveDeployment,
): Record<string, unknown> {
  return {
    observed: true,
    launchTxHash: txHash,
    pair: launched.pair,
    virtualId: launched.virtualId.toString(),
    initialPurchaseRaw: launched.initialPurchaseRaw.toString(),
    initialPurchase: formatUnits(launched.initialPurchaseRaw, deployment.virtualDecimals),
    initialPurchasedAmountRaw: launched.initialPurchasedAmountRaw.toString(),
    antiSniperTaxType: launched.launchParams.antiSniperTaxType,
    note:
      "The Virtuals keeper ran launch(): the agent trades on its bonding curve, the initial purchase executed, and "
      + "the anti-sniper window started at that transaction. A launch cannot be cancelled after this.",
  };
}

/**
 * Has `api.virtuals.io` indexed the agent?
 *
 * A SEPARATE question from the chain's, never a confirmation of it, and never
 * an error: an unindexed agent that IS launched on chain is a real, measured
 * state (token `0xd1eF7097`, 2026-09-04). A provider failure answers `null`.
 */
async function readIndexStatus(
  token: Address,
  deployment: VirtualsCurveDeployment,
): Promise<Record<string, unknown>> {
  const chain = resolveVirtualsChain(deployment.key);
  if (chain === null) {
    return { indexed: null, note: "Vex has no Virtuals API chain value for this deployment." };
  }
  try {
    const client = getVirtualsClient();
    // `filters.tokenAddress` matches EITHER `tokenAddress` or `preToken`
    // case-insensitively, which is what a pre-graduation agent needs: on the
    // curve the API carries the token under `preToken` and leaves
    // `tokenAddress` null.
    const page = await client.listVirtuals({
      chain,
      filters: { tokenAddress: token },
      pageSize: 3,
    });
    const found = page.agents[0] ?? null;
    if (found === undefined || found === null) {
      return {
        indexed: false,
        note:
          "api.virtuals.io does not list this agent yet. Indexing follows the keeper's launch by a short delay, so a "
          + "freshly launched agent is normally absent for a few minutes. An agent whose launch() was NOT run by the "
          + "keeper may never be indexed at all.",
      };
    }
    return {
      indexed: true,
      virtualsId: found.id,
      name: found.name,
      note: "api.virtuals.io lists this agent, so the platform's own pipeline picked the launch up.",
    };
  } catch (err) {
    return {
      indexed: null,
      note:
        `Vex could not reach api.virtuals.io to check the listing (${summarizeProtocolError(err).message}). This says `
        + "nothing about the chain state above.",
    };
  }
}

function describeRecordedStatus(status: string): string {
  switch (status) {
    case "previewed":
      return "This is a launch PREVIEW that was never executed. Nothing was signed and nothing is on chain.";
    case "authorized":
    case "consuming":
      return "This launch was authorized but no transaction was proven; nothing is on chain that Vex can point at.";
    case "broadcast_pending":
      return (
        "This launch was broadcast and Vex has not proven its receipt. It is tracked automatically and is NEVER "
        + "re-sent."
      );
    case "terminal_failure":
      return "This launch failed before it created an agent. Nothing is on chain.";
    case "cancelled":
      return "This launch was cancelled.";
    case "expired":
      return "This launch's authorization window lapsed before anything was signed.";
    default:
      return `Vex records this launch as ${status}.`;
  }
}
