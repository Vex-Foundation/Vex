/**
 * `pools.holder_rewards_distribute` - the PERMISSIONLESS push that moves a
 * token's accrued fees into its holder-reward stream.
 *
 * THIS IS NOT A CLAIM, AND THE VOCABULARY SAYS SO. `distribute()` may be called
 * by anybody; it pulls the fees the locker has collected, converts them where
 * the distributor is configured to, and notifies the stream so every HOLDER's
 * `earned` starts growing. The caller is not a party to that: the money goes to
 * the holders. So the durable role is `reward_distribution` (migration 107) and
 * NOT a claim role, its readiness arm requires no leg, and the AgentScan server
 * caps its verification at basic - there is no leg of the caller's to match a
 * receipt against.
 *
 * ── THE CALLER BOUNTY, MEASURED, AND WHY IT IS NOT A LEG ─────────────────
 *
 * The plan's premise for this role was "the caller of distribute() is paid
 * nothing". On the 13962-byte distributor runtime that is exactly true. On the
 * 22171-byte runtime IT IS NOT: `CALLER_BOUNTY_BPS()` reads 50, and on the live
 * distribute `0x8022a2e0...` the caller `0x491a5b36...` received
 * 1468600694080745304774 of the LAUNCHED TOKEN - precisely 0.5 percent of the
 * 293720138816149060954828 the distributor moved - declared by a
 * `CallerBounty(address,uint256)` event (measured 2026-09-04,
 * `agents-colab/agents_dm/pools-holder-rewards-2026-09-04/`). The launchpad's
 * own `paysCallerBounty` reads `false` on distributors carrying that constant,
 * so it is not a usable signal either.
 *
 * The row therefore carries NO LEG, per the vocabulary this repository and the
 * AgentScan contract already ship, and the bounty is recorded as PROVENANCE and
 * stated in words in every preview and every result. Writing an output leg under
 * a role whose server-side binding says the caller is paid nothing would be a
 * unilateral contract change on a money path. The contradiction is reported to
 * the coordinator rather than resolved here.
 *
 * ── THE MODES, AND WHY THIS TOOL IS STILL HONEST ABOUT THEM ──────────────
 *
 * The bounty comes out of the BUYBACK, so a distribute on a distributor whose
 * `conversion` is none, or whose buyback bought nothing, pays the caller
 * nothing at all - and the constant existing says nothing about whether this
 * call will pay. Only the receipt's own `CallerBounty` event proves what was
 * paid, and that is what the result reports.
 *
 * ── STOPS ────────────────────────────────────────────────────────────────
 *
 *   `dryRun: true`       simulate and report; no signer, no row, no approval.
 *   `simulateOnly: true` the whole path including the real gas estimate over the
 *                        exact bytes, then a full stop with `executed: false`.
 *   neither              distribute for real behind the ordinary approval gate.
 */

import {
  getAddress,
  type Address,
  type Chain,
  type PublicClient,
  type Transport,
} from "viem";

import { getLocalChain } from "@tools/evm-chains/registry.js";
import { getLocalPublicClient } from "@tools/evm-chains/evm-client.js";
import { gasLimitWithHeadroom } from "@tools/evm-chains/gas-limit-headroom.js";
import { signStageBroadcast, type StagedBroadcastOutcome } from "@tools/evm-chains/staged-broadcast.js";
import { getPoolsFunClient } from "@tools/pools-fun/client.js";
import { POOLS_CHAIN_ID, POOLS_CHAIN_SLUG } from "@tools/pools-fun/constants.js";
import { decodePoolsRewardDistribution } from "@tools/pools-fun/holder-rewards/decode.js";
import {
  poolsHolderRewardsDistributeCalldata,
  simulatePoolsRewardDistribute,
  type PoolsRewardDistributeSimulation,
} from "@tools/pools-fun/holder-rewards/mutations.js";
import { crossCheckPoolsHolderRewardsPrepare } from "@tools/pools-fun/holder-rewards/prepare-cross-check.js";
import type { PoolsHolderRewards } from "@tools/pools-fun/types.js";
import {
  createAgentActivityIntent,
  markActivityBroadcast,
  reserveActivityEvmNonce,
  markBroadcastAccepted,
  confirmActivityEvent,
  failActivityEvent,
} from "@vex-agent/db/repos/agent-activity.js";
import { noteHandlerPendingReason } from "@vex-agent/tools/protocols/runtime/pending-provenance.js";
import logger from "@utils/logger.js";

import { ok, fail } from "../../handler-helpers.js";
import { openLaunchSigningClients } from "../../shared/launch-signing-clients.js";
import { resolveSelectedAddress, walletScopeErrorToResult } from "../../../internal/wallet/resolve.js";
import type { ProtocolExecutionContext } from "../../types.js";
import type { ToolResult } from "../../../types.js";
import { poolsFailureDetail } from "./failure.js";
import {
  bindPoolsHolderRewards,
  type PoolsHolderRewardsBinding,
} from "./holder-rewards-binding.js";
import { isEvmAddress } from "./project.js";
import {
  describeBoundDistributor,
  describeCrossCheck,
  noHolderRewardsResult,
  unsupportedSuiteResult,
} from "./holder-rewards-shared.js";

const TOOL_ID = "pools.holder_rewards_distribute";

/** The bounty rule, stated the same way everywhere this tool speaks. */
function bountyDisclosure(bountyBps: number | null): string {
  if (bountyBps === null) {
    return "This distributor's runtime has no CALLER_BOUNTY_BPS() at all, so calling distribute() pays the caller "
      + "NOTHING. The gas is a donation to the token's holders.";
  }
  if (bountyBps === 0) {
    return "This distributor's CALLER_BOUNTY_BPS() is 0, so calling distribute() pays the caller nothing. The gas "
      + "is a donation to the token's holders.";
  }
  return `This distributor's CALLER_BOUNTY_BPS() is ${bountyBps} (${bountyBps / 100} percent), taken out of the `
    + "BUYBACK and paid to whoever calls distribute(). It is NOT a fee anyone owes you: a distribute whose "
    + "buyback bought nothing pays nothing, and only the receipt's own CallerBounty event proves what was "
    + "actually paid. Vex takes no fee here either way, so the gas can exceed the bounty.";
}

export async function poolsHolderRewardsDistributeHandler(
  params: Record<string, unknown>,
  context: ProtocolExecutionContext,
): Promise<ToolResult> {
  const rawToken = params.tokenAddress ?? params.token;
  const tokenText = typeof rawToken === "string" ? rawToken.trim() : "";
  if (tokenText === "" || !isEvmAddress(tokenText)) {
    return fail(
      `${TOOL_ID} needs the ADDRESS of the pools.fun token whose holder-reward distributor you want to push `
        + `(0x followed by 40 hex characters, received "${tokenText}").`,
    );
  }
  const token = getAddress(tokenText);

  const dryRun = params.dryRun === true;
  if (params.dryRun !== undefined && typeof params.dryRun !== "boolean") {
    return fail(`"dryRun" must be true or false, received ${typeof params.dryRun}.`);
  }
  const simulateOnly = params.simulateOnly === true;
  if (params.simulateOnly !== undefined && typeof params.simulateOnly !== "boolean") {
    return fail(`"simulateOnly" must be true or false, received ${typeof params.simulateOnly}.`);
  }
  if (dryRun && simulateOnly) {
    return fail(
      `${TOOL_ID}: dryRun and simulateOnly are two different stops and cannot both be asked for. Pick one.`,
    );
  }

  const sessionId = context.sessionId;
  if (!sessionId) return fail(`${TOOL_ID} requires an active session.`);

  let walletAddress: Address;
  try {
    walletAddress = getAddress(
      resolveSelectedAddress(context.walletResolution, context.walletPolicy, "eip155"),
    );
  } catch (err) {
    return walletScopeErrorToResult(err);
  }

  const chainConfig = getLocalChain(POOLS_CHAIN_ID);
  if (!chainConfig) {
    return fail(`Robinhood Chain (${POOLS_CHAIN_ID}) is not in the local chain registry.`);
  }

  const signing = dryRun || simulateOnly ? null : openLaunchSigningClients(context, chainConfig);
  if (signing !== null && !signing.ok) return signing.result;
  const reader: PublicClient<Transport, Chain> = signing === null
    ? getLocalPublicClient(chainConfig)
    : signing.clients.publicClient;

  const bound = await bindPoolsHolderRewards(reader, {
    toolId: TOOL_ID,
    token,
    wallet: walletAddress,
  });
  if (bound.kind === "refused") return fail(bound.reason);
  if (bound.kind === "unsupported_suite") {
    return unsupportedSuiteResult(token, bound.suiteVersion, "distribute");
  }
  if (bound.kind === "no_holder_rewards") {
    return noHolderRewardsResult(token, bound.suiteVersion, bound.deployer, "distribute");
  }
  const binding = bound.binding;

  const simulation = await simulatePoolsRewardDistribute(reader, {
    account: walletAddress,
    distributor: binding.distributor,
    blockNumber: binding.blockNumber,
  });

  if (simulation.kind === "unavailable") {
    return fail(
      `${TOOL_ID} could not simulate this distribute (${simulation.reason}), so whether it has anything to do is `
        + "UNKNOWN. Nothing was signed - this is not a statement that there is nothing to distribute.",
    );
  }

  // The launchpad's pool-level context, fetched AFTER the chain read and never
  // gating it: `pendingFees` and `hasWorkToDistribute` are figures the contracts
  // do not expose in one call, and a provider outage costs the context, not the
  // answer.
  let api: PoolsHolderRewards | null = null;
  let apiDetail: string | null = null;
  try {
    api = await getPoolsFunClient().holderRewards(
      { tokenAddress: token, walletAddress },
      context.abortSignal === undefined ? {} : { signal: context.abortSignal },
    );
  } catch (err) {
    apiDetail = poolsFailureDetail(TOOL_ID, err);
  }

  if (simulation.kind === "nothing_to_distribute") {
    return ok({
      chain: POOLS_CHAIN_SLUG,
      tokenAddress: token,
      wallet: walletAddress,
      status: "nothing_to_distribute",
      ...describeBoundDistributor(binding),
      distributed: false,
      ...projectApiContext(api, apiDetail),
      detail:
        `The distributor itself says it has nothing to push right now (it answered ${simulation.revert}()). Fees `
        + "accrue as the pool trades and a buyback has its own interval, so this changes on its own. Nothing was "
        + "signed and no gas was spent.",
      bountyRule: bountyDisclosure(binding.bountyBps),
    });
  }

  const ours = { to: binding.distributor, data: poolsHolderRewardsDistributeCalldata() };
  const [gasLimit, crossCheck] = await Promise.all([
    estimateDistributeGas(reader, { account: walletAddress, distributor: binding.distributor }),
    crossCheckPoolsHolderRewardsPrepare({
      tokenAddress: token,
      walletAddress,
      action: "distribute",
      ours,
      signal: context.abortSignal,
    }),
  ]);

  if (crossCheck.status === "disagrees") {
    return fail(
      `${TOOL_ID} refuses this distribute: the launchpad's own prepared calldata does not match the transaction `
        + `Vex built from the distributor's verified ABI. ${crossCheck.differences.join(" ")} Two honest accounts `
        + "of the same call produce the same bytes, so one of these describes a different transaction and Vex "
        + "signs neither. Nothing was signed.",
    );
  }

  const base = {
    chain: POOLS_CHAIN_SLUG,
    chainId: POOLS_CHAIN_ID,
    tokenAddress: token,
    wallet: walletAddress,
    ...describeBoundDistributor(binding),
    wouldDistribute: projectSimulation(simulation),
    gasLimitBound: gasLimit === null ? null : gasLimit.toString(),
    bountyRule: bountyDisclosure(binding.bountyBps),
    vexFee: null,
    vexFeeNote:
      "Vex charges NOTHING on a distribute. The only cost is the network gas above, which is paid to the chain "
      + "and not to Vex.",
    crossCheck: describeCrossCheck(crossCheck),
    ...projectApiContext(api, apiDetail),
  };

  if (dryRun) {
    return ok({
      ...base,
      dryRun: true,
      distributed: false,
      note:
        "SIMULATED by calling the distributor's own distribute() as this wallet at the block above. Nothing was "
        + "signed and no gas was spent. This call moves the token's accrued fees to its HOLDERS; the wallet that "
        + "signs it pays gas and receives only whatever bounty the rule above describes.",
    });
  }

  if (gasLimit === null) {
    return fail(
      `${TOOL_ID}: the node would not price this distribute, so the gas it needs is UNKNOWN and Vex will not sign `
        + "a transaction whose cost it cannot state. Nothing was signed.",
    );
  }

  if (simulateOnly) {
    return ok({
      ...base,
      simulateOnly: true,
      executed: false,
      distributed: false,
      wouldSign: {
        to: binding.distributor,
        data: poolsHolderRewardsDistributeCalldata(),
        value: "0",
        gasLimit: gasLimit.toString(),
        from: walletAddress,
        chainId: POOLS_CHAIN_ID,
      },
      note:
        "SIMULATION. Every check a real distribute runs was run - the suite was detected, the deployer's event "
        + "named the distributor, the distributor was bound to that suite, distribute() was simulated as this "
        + "wallet, the launchpad's calldata was compared against ours, and the node priced the exact bytes - and "
        + "then this stopped. NO SIGNER WAS OPENED, no durable row exists, and NOTHING WAS DISTRIBUTED.",
    });
  }

  return executeDistribute({
    signing: signing!,
    token,
    walletAddress,
    sessionId,
    params,
    binding,
    simulation,
  });
}

/** The launchpad's pool-level context, always labelled as the echo it is. */
function projectApiContext(
  api: PoolsHolderRewards | null,
  apiDetail: string | null,
): Record<string, unknown> {
  if (api === null) {
    return apiDetail === null
      ? {}
      : {
        apiUnavailable:
            `The launchpad's holder-rewards read failed (${apiDetail}), so its pendingFees and `
            + "hasWorkToDistribute are missing. The distributor's own simulation above is unaffected.",
      };
  }
  return {
    api: {
      source: "api",
      hasWorkToDistribute: api.hasWorkToDistribute,
      pendingFees: api.pendingFees,
      buybackBacklogRaw: api.buybackBacklog,
      lastBuybackAt: api.lastBuybackAt,
      conversion: api.conversion,
      paysCallerBounty: api.paysCallerBounty,
      note:
        "The launchpad's own view, shown for context. hasWorkToDistribute and pendingFees are figures the "
        + "contracts do not expose in one call. paysCallerBounty is an ECHO and has been measured to read false "
        + "on a distributor whose CALLER_BOUNTY_BPS() is 50 - the on-chain constant above is the authority.",
    },
  };
}

/** The distributor's own accounting words, named only where a verified ABI names them. */
function projectSimulation(
  simulation: Extract<PoolsRewardDistributeSimulation, { kind: "would_distribute" }>,
): Record<string, unknown> {
  const words = simulation.words.map((w) => w.toString());
  if (simulation.named) {
    return {
      feesTokenRaw: words[0],
      feesPairedRaw: words[1],
      boughtRaw: words[2],
      notifiedRaw: words[3],
      note:
        "Named from the distributor's Sourcify-verified ABI (feesToken, feesPaired, bought, notified), in base "
        + "units. They describe what the DISTRIBUTOR would move to the holders, not what the caller receives.",
    };
  }
  return {
    wordsUnnamed: words,
    note:
      `This distributor runtime returns ${words.length} values from distribute() and is not verified anywhere `
      + "this repository can read, so their meanings are NOT established and Vex will not label them. They are "
      + "reported in order, in base units. What matters for a decision is that the call succeeds, which it did.",
  };
}

async function estimateDistributeGas(
  client: PublicClient<Transport, Chain>,
  input: { readonly account: Address; readonly distributor: Address },
): Promise<bigint | null> {
  try {
    const estimate = await client.estimateGas({
      account: input.account,
      to: input.distributor,
      data: poolsHolderRewardsDistributeCalldata(),
    });
    return gasLimitWithHeadroom(estimate);
  } catch {
    return null;
  }
}

// ── Execution ──────────────────────────────────────────────────────

interface ExecuteDistributeInput {
  readonly signing: Extract<ReturnType<typeof openLaunchSigningClients>, { ok: true }>;
  readonly token: Address;
  readonly walletAddress: Address;
  readonly sessionId: string;
  readonly params: Record<string, unknown>;
  readonly binding: PoolsHolderRewardsBinding;
  readonly simulation: Extract<PoolsRewardDistributeSimulation, { kind: "would_distribute" }>;
}

async function executeDistribute(x: ExecuteDistributeInput): Promise<ToolResult> {
  const calldata = poolsHolderRewardsDistributeCalldata();
  const distributor = x.binding.distributor;

  let executionId: number;
  let rowId: number;
  try {
    const created = await createAgentActivityIntent({
      toolId: TOOL_ID,
      namespace: "pools",
      intentParams: x.params,
      events: [
        {
          eventIndex: 0,
          // NO LEGS AT ALL, on either side. `reward_distribution` is outside
          // `AMOUNT_BEARING_ROLES`, so `roleLegsIncomplete` never holds this row
          // waiting for an amount, and migration 107 forbids an input leg on it
          // outright. What the caller may receive is provenance, below.
          eventRole: "reward_distribution",
          kind: "claim",
          protocol: "pools",
          chainId: POOLS_CHAIN_ID,
          chainSlug: POOLS_CHAIN_SLUG,
          walletAddress: x.walletAddress,
          sessionId: x.sessionId,
          routeProvenance: {
            distributor,
            deployer: x.binding.deployer,
            suiteVersion: x.binding.suite.version,
            rewardMode: x.binding.rewardMode,
            rewardModeWire: x.binding.rewardModeWire,
            callerBountyBps: x.binding.bountyBps,
            simulatedAtBlock: x.binding.blockNumber.toString(),
            simulatedWords: x.simulation.words.map((w) => w.toString()),
          },
        },
      ],
    });
    executionId = created.executionId;
    rowId = created.events[0]!.id;
  } catch (err) {
    return fail(
      `${TOOL_ID} failed before broadcasting: ${poolsFailureDetail(TOOL_ID, err)}. Nothing was signed.`,
    );
  }

  let signedLocally = false;
  let outcome: StagedBroadcastOutcome;
  try {
    outcome = await signStageBroadcast(
      x.signing.clients.publicClient,
      x.signing.clients.walletClient,
      { to: distributor, data: calldata, value: 0n },
      {
        onNonceReserved: (request) => reserveActivityEvmNonce(rowId, request),
        onBeforeSign: async (request) => {
          if (request.to === null || request.to === undefined
            || getAddress(request.to) !== getAddress(distributor)) {
            throw new Error(
              `pre-sign: the request targets ${String(request.to)} but the distributor this distribute was `
                + `verified against is ${distributor}`,
            );
          }
          if ((request.data ?? "0x").toLowerCase() !== (calldata as string).toLowerCase()) {
            throw new Error(
              "pre-sign: the request's calldata is not the distribute() the distributor's verified ABI encodes",
            );
          }
          if (request.value !== 0n) {
            throw new Error(
              `pre-sign: the request would attach ${request.value} wei to a distribute, which takes none`,
            );
          }
        },
        onHashStaged: async (handles) => {
          signedLocally = true;
          const res = await markActivityBroadcast(rowId, handles);
          if (!res.applied) {
            throw new Error(
              `agent_activity: markActivityBroadcast CAS miss for event ${rowId} - refusing to broadcast untracked`,
            );
          }
        },
        onAccepted: async () => {
          const res = await markBroadcastAccepted(rowId);
          if (!res.applied) {
            logger.warn("pools.holder_rewards_distribute.broadcast_accept_miss", { id: rowId });
          }
        },
      },
    );
  } catch (err) {
    const detail = poolsFailureDetail(TOOL_ID, err);
    await failActivityEvent(rowId, {
      failureCode: "broadcast_error",
      failureReason: `${signedLocally ? "SignedNotBroadcast" : "PreSign"}:${detail}`,
    });
    return fail(
      signedLocally
        ? `${TOOL_ID}: the distribute was signed locally but never broadcast - ${detail}. Nothing was sent to the `
          + "network."
        : `${TOOL_ID}: the distribute was refused before signing - ${detail}. Nothing was signed.`,
    );
  }

  if (outcome.kind === "ambiguous") {
    await noteHandlerPendingReason(TOOL_ID, rowId, "broadcast_ambiguous_confirm");
    return {
      success: false,
      output:
        `${TOOL_ID}: the distribute transaction (${outcome.txHash}) could not be confirmed yet - it may still `
        + "settle, and it may already have run. DO NOT retry; a second distribute would spend gas on a "
        + "distributor that has nothing left to push. This attempt is recorded as pending and resolves "
        + "automatically.",
      data: { _executionId: executionId, txHash: outcome.txHash, status: "pending" },
    };
  }

  if (outcome.kind === "reverted") {
    await failActivityEvent(rowId, {
      failureCode: "mined_revert",
      failureReason: "the distribute transaction reverted on-chain",
    });
    return {
      success: false,
      output:
        `${TOOL_ID}: the distribute transaction (${outcome.txHash}) reverted on-chain. Nothing was distributed, `
        + "and the gas for the failed transaction was spent. Another caller most likely distributed first, which "
        + "is the ordinary outcome of a permissionless race.",
      data: { _executionId: executionId, txHash: outcome.txHash, status: "reverted" },
    };
  }

  // A DISTRIBUTE HAS NO LEG TO PROVE, so this decode is not a gate: it reads
  // what the distributor declared it paid THIS caller and reports it. Absence is
  // the ordinary case and is reported as absence, never as zero.
  const decoded = decodePoolsRewardDistribution(
    outcome.receipt.logs.map((l) => ({ address: l.address, topics: l.topics as string[], data: l.data })),
    { caller: x.walletAddress, distributor },
  );
  const bountyRaw = decoded.ok ? decoded.value.bountyAmountRaw : null;

  try {
    // NO EXECUTED AMOUNTS. The role bears none, and writing the bounty into one
    // would put the caller's incentive where a reader expects the money the row
    // is about - which for this role is the holders' stream, not the caller's.
    await confirmActivityEvent(rowId, {});
  } catch (err) {
    logger.warn("pools.holder_rewards_distribute.confirm_failed", {
      executionId,
      error: poolsFailureDetail(TOOL_ID, err),
    });
  }

  const data = {
    summary:
      `Distributed ${x.token}'s accrued fees to its holders. Tx: ${outcome.txHash}`
      + (bountyRaw === null ? "" : ` Caller bounty declared: ${bountyRaw} base units.`),
    chain: POOLS_CHAIN_SLUG,
    chainId: POOLS_CHAIN_ID,
    txHash: outcome.txHash,
    tokenAddress: x.token,
    wallet: x.walletAddress,
    ...describeBoundDistributor(x.binding),
    distributed: true,
    status: "confirmed",
    role: "reward_distribution",
    roleNote:
      "Recorded as a reward_distribution, not a claim: this transaction moved the token's fees to its HOLDERS. "
      + "The row carries no payout leg because the caller is owed none.",
    callerBounty: bountyRaw === null
      ? {
        amountRaw: null,
        detail:
            "The distributor declared no CallerBounty for this wallet in this receipt. That is the ordinary "
            + "outcome: the bounty comes out of the buyback, so a distribute that bought nothing back pays "
            + "nothing.",
      }
      : {
        amountRaw: bountyRaw.toString(),
        detail:
            "The distributor's own CallerBounty event declared this amount for this wallet. The event names NO "
            + "asset, so neither does Vex; in the one live distribute measured on this chain the bounty was paid "
            + "in the launched token. It is NOT recorded as a payout leg on this row.",
      },
    ...(decoded.ok
      ? {}
      : {
        bountyUndecodable: decoded.reason,
      }),
    vexFee: null,
    _executionId: executionId,
  };
  return { success: true, output: JSON.stringify(data), data };
}
