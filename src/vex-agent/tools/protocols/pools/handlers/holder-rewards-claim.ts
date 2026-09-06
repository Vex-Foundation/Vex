/**
 * `pools.holder_rewards_claim` - take the fees a pools.fun token streams to the
 * wallet that holds it.
 *
 * ONE TOOL, THREE MODES, and the difference between them is what touches a key:
 *   `dryRun: true`      SIMULATES and reports what a claim would pay. No signer
 *                       is opened, no durable row is written, and the runtime
 *                       treats the call as read-only, so no approval is raised.
 *   `simulateOnly: true` runs the WHOLE money path - fresh suite detection, the
 *                       deployer's event, the binding, the simulation, the
 *                       provider cross-check and a real `estimateGas` over the
 *                       exact bytes - and then STOPS, returning the request that
 *                       would have been signed with `executed: false`. Still no
 *                       signer, still no row.
 *   neither             claims for real behind the ordinary approval gate.
 *
 * `simulateOnly` is adapted from MetaMask's `SkippedViaBeforePublishHook`
 * (`transaction-controller/src/TransactionController.ts:3147-3155`), which
 * returns a distinct NON-ERROR outcome rather than throwing and does not mark
 * the transaction submitted. ADOPTED: a deliberate stop between "fully checked"
 * and "committed" is a first-class result. REJECTED: their hook runs AFTER
 * `#signTransaction`, so a skipped publish has still opened the key - on a
 * self-custodial agent path that is the wrong side of the line, and this leg
 * takes the read-only client instead, exactly as `launch/execute.ts` does.
 *
 * ── THE AUTHORITY TABLE (plan v3 A5), and where each row is enforced ──────
 *
 *   chain        Robinhood 4663 only, never a parameter.
 *   token, suite `bindPoolsHolderRewards` - exactly one suite, or a named refusal.
 *   distributor  the suite deployer's `DistributorDeployed` log. Bound to the
 *   and mode     suite by `token()`, `factory()` and `locker()`; the launchpad
 *                is an ECHO and cannot move the target.
 *   earned legs  `claim()` SIMULATED from this wallet at the pinned block is
 *                what a claim would pay; `earned`/`earnedPaired` are shown
 *                beside it as the accrual reads. A runtime with no paired return
 *                word has NO paired leg - never a zero.
 *   calldata     `claim()` from the verified ABI, never `claimFor`. The
 *                launchpad's own `prepare` answer is compared byte for byte and
 *                a disagreement REFUSES by name.
 *   Vex fee      NONE. A claim carries no fee role at all, and the tool has no
 *                fee parameter to supply one with.
 *   gas          `estimateGas` from this wallet with the repo's headroom, as a
 *                CEILING; `null` when the node will not price it, which refuses.
 *   nonce        the existing per-address durable reservation.
 *   proposal     the approval gate is over THIS call. The execute re-derives
 *                every row above at a FRESH block inside the approved call and
 *                refuses when the world no longer supports the claim - a
 *                distributor that changed, a binding that broke, a payout that
 *                fell to zero, a launchpad that now disagrees about the bytes.
 *
 * ONE ACTIVITY ROW, ITS OWN ROLE, NO INPUT LEG. `holder_reward_claim`
 * (migration 107) under `kind = 'claim'`: a claim spends nothing, so an input
 * leg is refused by the database and by the AgentScan contract alike. The second
 * output leg is declared ONLY when this runtime actually pays one, because
 * `roleLegsIncomplete` then requires its executed amount and a row that declared
 * a leg the chain will never fill waits forever.
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
import { POOLS_CHAIN_ID, POOLS_CHAIN_SLUG } from "@tools/pools-fun/constants.js";
import { decodePoolsHolderRewardClaim } from "@tools/pools-fun/holder-rewards/decode.js";
import {
  poolsHolderRewardsClaimCalldata,
  simulatePoolsHolderRewardsClaim,
  type PoolsHolderRewardsClaimSimulation,
} from "@tools/pools-fun/holder-rewards/mutations.js";
import { crossCheckPoolsHolderRewardsPrepare } from "@tools/pools-fun/holder-rewards/prepare-cross-check.js";
import { poolsRewardAmountHuman } from "@tools/pools-fun/holder-rewards/read.js";
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
import { isEvmAddress, readAddressParam } from "./project.js";
import {
  describeBoundDistributor,
  describeCrossCheck,
  noHolderRewardsResult,
  unsupportedSuiteResult,
  type PoolsRewardPayoutLeg,
} from "./holder-rewards-shared.js";

const TOOL_ID = "pools.holder_rewards_claim";

export async function poolsHolderRewardsClaimHandler(
  params: Record<string, unknown>,
  context: ProtocolExecutionContext,
): Promise<ToolResult> {
  const rawToken = params.tokenAddress ?? params.token;
  const tokenText = typeof rawToken === "string" ? rawToken.trim() : "";
  if (tokenText === "" || !isEvmAddress(tokenText)) {
    return fail(
      `${TOOL_ID} needs the ADDRESS of the pools.fun token whose holder rewards you want to claim `
        + `(0x followed by 40 hex characters, received "${tokenText}"). Symbols are not unique on this `
        + "launchpad, so an address is the only identity that means one token.",
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
      `${TOOL_ID}: dryRun and simulateOnly are two different stops and cannot both be asked for. dryRun answers `
        + "what a claim would pay; simulateOnly runs the whole path and returns the transaction that would have "
        + "been signed. Pick one.",
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

  // ── WHOSE REWARDS ARE BEING SIMULATED ─────────────────────────────
  //
  // `claim()` pays `msg.sender`, full stop, so on the SIGNING path the account
  // is the session wallet and nothing else may name it: a `walletAddress`
  // parameter on a signing leg would read like a destination and is exactly the
  // redirection shape rule 90 forbids, so it is refused BY NAME rather than
  // ignored. Under `dryRun` it is allowed, because simulating `claim()` from
  // another address is a public `eth_call` over public chain state that answers
  // "what is that holder owed" - the same question `pools__holder_rewards_get`
  // already answers for any address - and the result says loudly whose it is.
  const walletParam = readAddressParam(params, "walletAddress");
  if (!walletParam.ok) return fail(walletParam.reason);
  if (walletParam.value !== null && !dryRun) {
    return fail(
      `${TOOL_ID} refuses "walletAddress" outside dryRun: the distributor's claim() pays whoever signs the `
        + `transaction, which is always this session's wallet ${walletAddress}. There is no way to claim into `
        + "another address here, and Vex will not accept a parameter that reads as if there were. Use "
        + "dryRun: true with walletAddress to READ what another holder is owed.",
    );
  }
  const account = walletParam.value === null ? walletAddress : getAddress(walletParam.value);

  const chainConfig = getLocalChain(POOLS_CHAIN_ID);
  if (!chainConfig) {
    return fail(`Robinhood Chain (${POOLS_CHAIN_ID}) is not in the local chain registry.`);
  }

  // NO KEY IS TOUCHED unless this call is going to sign. Taking the read-only
  // client on both non-signing arms is what makes "no signer was opened" a
  // structural property rather than a promise in a comment.
  const signing = dryRun || simulateOnly ? null : openLaunchSigningClients(context, chainConfig);
  if (signing !== null && !signing.ok) return signing.result;
  const reader: PublicClient<Transport, Chain> = signing === null
    ? getLocalPublicClient(chainConfig)
    : signing.clients.publicClient;

  const prepared = await prepareClaim(reader, {
    token,
    account,
    signal: context.abortSignal,
  });
  if (prepared.kind !== "ready") return prepared.result;
  const { binding, simulation, gasLimit, crossCheck } = prepared;

  const legs = payoutLegs(binding, simulation);
  const base = {
    chain: POOLS_CHAIN_SLUG,
    chainId: POOLS_CHAIN_ID,
    tokenAddress: token,
    wallet: account,
    ...describeBoundDistributor(binding),
    wouldPay: legs.map(projectPayoutLeg),
    gasLimitBound: gasLimit === null ? null : gasLimit.toString(),
    vexFee: null,
    vexFeeNote:
      "Vex charges NOTHING on a holder-reward claim. The only cost is the network gas above, which is paid to "
      + "the chain and not to Vex.",
    crossCheck: describeCrossCheck(crossCheck),
  };

  if (dryRun) {
    return ok({
      ...base,
      dryRun: true,
      claimed: false,
      ...(account.toLowerCase() === walletAddress.toLowerCase()
        ? {}
        : {
          simulatedForAnotherHolder:
              `These amounts are what ${account} is owed. That is NOT this session's wallet `
              + `(${walletAddress}), and a real claim from this session would pay ${walletAddress} instead.`,
        }),
      note:
        "SIMULATED by calling the distributor's own claim() as this account at the block above - this is what a "
        + "claim would pay right now, and it grows continuously because the reward streams over 24 hours. The "
        + "earned figures beside each leg are the same distributor's accrual view at the same block. Nothing was "
        + "signed and no gas was spent.",
    });
  }

  if (gasLimit === null) {
    return fail(
      `${TOOL_ID}: the node would not price this claim, so the gas it needs is UNKNOWN and Vex will not sign a `
        + "transaction whose cost it cannot state. Nothing was signed. Retry, or check the wallet has enough ETH "
        + "for gas on Robinhood Chain.",
    );
  }

  if (simulateOnly) {
    return ok({
      ...base,
      simulateOnly: true,
      executed: false,
      claimed: false,
      wouldSign: {
        to: binding.distributor,
        data: poolsHolderRewardsClaimCalldata(),
        value: "0",
        gasLimit: gasLimit.toString(),
        from: walletAddress,
        chainId: POOLS_CHAIN_ID,
      },
      note:
        "SIMULATION. Every check a real claim runs was run - the suite was detected, the deployer's event named "
        + "the distributor and its mode, the distributor was bound to that suite, claim() was simulated as this "
        + "wallet, the launchpad's own calldata was compared against ours, and the node priced the exact bytes - "
        + "and then this stopped. NO SIGNER WAS OPENED, no durable row exists, and NOTHING WAS CLAIMED. The "
        + "rewards are still with the distributor.",
    });
  }

  return executeClaim({
    reader,
    signing: signing!,
    token,
    walletAddress,
    sessionId,
    params,
    binding,
    simulation,
    legs,
  });
}

// ── Preparation: everything both the preview and the execute must establish ──

type PreparedClaim =
  | {
      readonly kind: "ready";
      readonly binding: PoolsHolderRewardsBinding;
      readonly simulation: Extract<PoolsHolderRewardsClaimSimulation, { kind: "would_pay" }>;
      readonly gasLimit: bigint | null;
      readonly crossCheck: Awaited<ReturnType<typeof crossCheckPoolsHolderRewardsPrepare>>;
    }
  | { readonly kind: "stop"; readonly result: ToolResult };

/**
 * Bind the distributor, simulate the claim, price it, and cross-check the
 * launchpad - in that order, all against ONE freshly-read block.
 *
 * Every stop below returns a FINISHED tool result rather than a reason string,
 * because the stops are not all failures: "this token does not stream fees to
 * holders" and "you are owed nothing right now" are true answers that must not
 * be dressed as errors, while "the simulation could not run" must never be
 * dressed as either.
 */
async function prepareClaim(
  reader: PublicClient<Transport, Chain>,
  input: {
    readonly token: Address;
    readonly account: Address;
    readonly signal: AbortSignal | undefined;
  },
): Promise<PreparedClaim> {
  const bound = await bindPoolsHolderRewards(reader, {
    toolId: TOOL_ID,
    token: input.token,
    wallet: input.account,
  });
  if (bound.kind === "refused") return { kind: "stop", result: fail(bound.reason) };
  if (bound.kind === "unsupported_suite") {
    return { kind: "stop", result: unsupportedSuiteResult(input.token, bound.suiteVersion, "claim") };
  }
  if (bound.kind === "no_holder_rewards") {
    return {
      kind: "stop",
      result: noHolderRewardsResult(input.token, bound.suiteVersion, bound.deployer, "claim"),
    };
  }
  const binding = bound.binding;

  const simulation = await simulatePoolsHolderRewardsClaim(reader, {
    account: input.account,
    distributor: binding.distributor,
    blockNumber: binding.blockNumber,
  });

  if (simulation.kind === "unavailable") {
    // NOT "nothing to claim". The two are different facts and collapsing them is
    // how a tool starts telling a holder their rewards are gone.
    return {
      kind: "stop",
      result: fail(
        `${TOOL_ID} could not simulate this claim (${simulation.reason}), so what it would pay is UNKNOWN. `
          + "Nothing was signed - this is not a statement that there is nothing to claim.",
      ),
    };
  }
  if (simulation.kind === "excluded") {
    return {
      kind: "stop",
      result: ok({
        chain: POOLS_CHAIN_SLUG,
        tokenAddress: input.token,
        wallet: input.account,
        status: "wallet_excluded",
        ...describeBoundDistributor(binding),
        claimed: false,
        detail:
          `The distributor has EXCLUDED ${input.account} from this token's holder rewards (it reverted `
          + "ExcludedAccount), so there is nothing for this wallet to claim and there will not be. Contracts, "
          + "the pool itself and the locker are routinely excluded, which is why an excluded address is a "
          + "fact rather than an error. Nothing was signed.",
      }),
    };
  }
  if (simulation.kind === "nothing_to_claim") {
    return {
      kind: "stop",
      result: nothingToClaimResult(input.token, input.account, binding, simulation.revert),
    };
  }

  // ALL LEGS ZERO IS ALSO NOTHING TO CLAIM. The newer runtime does not revert
  // for a wallet holding none of the token; it returns zeroes. Signing that
  // would spend gas to move nothing.
  if (
    simulation.tokenAmountRaw === 0n
    && (simulation.pairedAmountRaw === null || simulation.pairedAmountRaw === 0n)
  ) {
    return {
      kind: "stop",
      result: nothingToClaimResult(input.token, input.account, binding, "zero on every leg"),
    };
  }

  const ours = { to: binding.distributor, data: poolsHolderRewardsClaimCalldata() };
  const [gasLimit, crossCheck] = await Promise.all([
    estimateClaimGas(reader, { account: input.account, distributor: binding.distributor }),
    crossCheckPoolsHolderRewardsPrepare({
      tokenAddress: input.token,
      walletAddress: input.account,
      action: "claim",
      ours,
      signal: input.signal,
    }),
  ]);

  if (crossCheck.status === "disagrees") {
    return {
      kind: "stop",
      result: fail(
        `${TOOL_ID} refuses this claim: the launchpad's own prepared calldata does not match the transaction Vex `
          + `built from the distributor's verified ABI. ${crossCheck.differences.join(" ")} Two honest accounts of `
          + "the same claim produce the same bytes, so one of these describes a different transaction and Vex "
          + "signs neither. Nothing was signed.",
      ),
    };
  }

  return { kind: "ready", binding, simulation, gasLimit, crossCheck };
}

/** Gas the claim would sign, headroomed exactly as the broadcaster signs it. */
async function estimateClaimGas(
  client: PublicClient<Transport, Chain>,
  input: { readonly account: Address; readonly distributor: Address },
): Promise<bigint | null> {
  try {
    const estimate = await client.estimateGas({
      account: input.account,
      to: input.distributor,
      data: poolsHolderRewardsClaimCalldata(),
    });
    return gasLimitWithHeadroom(estimate);
  } catch {
    return null;
  }
}

/** The typed "you are owed nothing" answer. A fact about the wallet, not a failure. */
function nothingToClaimResult(
  token: Address,
  account: Address,
  binding: PoolsHolderRewardsBinding,
  cause: string,
): ToolResult {
  return ok({
    chain: POOLS_CHAIN_SLUG,
    tokenAddress: token,
    wallet: account,
    status: "nothing_to_claim",
    ...describeBoundDistributor(binding),
    claimed: false,
    detail:
      `The distributor owes ${account} nothing on this token right now (${cause}). Rewards accrue only while `
      + "the wallet HOLDS the token and the distributor is streaming, so this changes as the pool trades and as "
      + "the balance changes. Nothing was signed and no gas was spent.",
  });
}

// ── Legs ───────────────────────────────────────────────────────────

/**
 * The legs a claim would pay, from the SIMULATION - never from `earned`.
 *
 * `earned(wallet)` is the distributor's accrual view and the simulation is the
 * transaction; they differ by the seconds between two reads of a continuous
 * stream, and only one of them is what the transaction returns. Both are shown,
 * under their own names.
 */
function payoutLegs(
  binding: PoolsHolderRewardsBinding,
  simulation: Extract<PoolsHolderRewardsClaimSimulation, { kind: "would_pay" }>,
): readonly PoolsRewardPayoutLeg[] {
  const legs: PoolsRewardPayoutLeg[] = [
    {
      side: "token",
      asset: getAddress(binding.tokenLeg.asset),
      symbol: binding.tokenLeg.symbol,
      decimals: binding.tokenLeg.decimals,
      amountRaw: simulation.tokenAmountRaw,
      earnedRaw: binding.tokenLeg.earnedRaw,
    },
  ];
  // The paired leg exists ONLY when this runtime's claim() returned a second
  // word AND the distributor named a paired asset with a scale. A leg without
  // its scale is unreadable, and a leg the runtime never returns is absent
  // rather than zero.
  if (simulation.pairedAmountRaw !== null && binding.pairedLeg !== null) {
    legs.push({
      side: "paired",
      asset: getAddress(binding.pairedLeg.asset),
      symbol: binding.pairedLeg.symbol,
      decimals: binding.pairedLeg.decimals,
      amountRaw: simulation.pairedAmountRaw,
      earnedRaw: binding.pairedLeg.earnedRaw,
    });
  }
  return legs;
}

function projectPayoutLeg(leg: PoolsRewardPayoutLeg): Record<string, unknown> {
  const human = poolsRewardAmountHuman(leg.amountRaw.toString(), leg.decimals);
  return {
    side: leg.side,
    assetAddress: leg.asset,
    assetSymbol: leg.symbol,
    decimals: leg.decimals,
    amountRaw: leg.amountRaw.toString(),
    ...(human !== null
      ? { amount: human }
      : {
        amountUnavailable:
            "The asset's decimals() did not answer, so the raw amount above cannot be scaled. Do not assume 18.",
      }),
    earnedRaw: leg.earnedRaw,
    earnedNote:
      "earnedRaw is the distributor's accrual view at the same block. It differs from the simulated payout by "
      + "the time between the two reads, because the reward streams continuously.",
  };
}

// ── Execution ──────────────────────────────────────────────────────

interface ExecuteClaimInput {
  readonly reader: PublicClient<Transport, Chain>;
  readonly signing: Extract<ReturnType<typeof openLaunchSigningClients>, { ok: true }>;
  readonly token: Address;
  readonly walletAddress: Address;
  readonly sessionId: string;
  readonly params: Record<string, unknown>;
  readonly binding: PoolsHolderRewardsBinding;
  readonly simulation: Extract<PoolsHolderRewardsClaimSimulation, { kind: "would_pay" }>;
  readonly legs: readonly PoolsRewardPayoutLeg[];
}

async function executeClaim(x: ExecuteClaimInput): Promise<ToolResult> {
  const calldata = poolsHolderRewardsClaimCalldata();
  const distributor = x.binding.distributor;
  const tokenLeg = x.legs[0]!;
  const pairedLeg = x.legs[1] ?? null;

  // The durable row BEFORE anything is broadcast: a crash mid-flight must leave
  // a record, not an invisible transaction. ONE row, its own role, NO input leg.
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
          eventRole: "holder_reward_claim",
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
            claimReturnWordCount: x.simulation.returnWordCount,
            simulatedAtBlock: x.binding.blockNumber.toString(),
          },
          tokenOut: {
            tokenAddress: tokenLeg.asset,
            tokenSymbol: tokenLeg.symbol ?? "",
            tokenDecimals: tokenLeg.decimals ?? 0,
            amountHuman: poolsRewardAmountHuman(tokenLeg.amountRaw.toString(), tokenLeg.decimals) ?? "0",
            amountRaw: tokenLeg.amountRaw.toString(),
          },
          // DECLARED ONLY WHEN THIS RUNTIME PAYS ONE. `roleLegsIncomplete`
          // requires an executed second amount for every row that names a second
          // token, so declaring a leg the chain will never fill would hold the
          // row incomplete forever and re-sweep it for an amount that was never
          // coming.
          ...(pairedLeg === null
            ? {}
            : {
              tokenOut2: {
                tokenAddress: pairedLeg.asset,
                tokenSymbol: pairedLeg.symbol ?? "",
                tokenDecimals: pairedLeg.decimals ?? 0,
                amountHuman:
                    poolsRewardAmountHuman(pairedLeg.amountRaw.toString(), pairedLeg.decimals) ?? "0",
                amountRaw: pairedLeg.amountRaw.toString(),
              },
            }),
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
        // THE LAST GATE BEFORE THE KEY, asserted against the request that will
        // actually be serialized rather than against the values handed in.
        // MetaMask re-reads live state at submit for the same reason; Rabby's
        // provider controller refuses a `from` or `chainId` that is not the
        // current one (`background/controller/provider/controller.ts:613-646`)
        // and this is that check, moved to the bytes.
        onBeforeSign: async (request) => {
          if (request.to === null || request.to === undefined
            || getAddress(request.to) !== getAddress(distributor)) {
            throw new Error(
              `pre-sign: the request targets ${String(request.to)} but the distributor this claim was verified `
                + `against is ${distributor}`,
            );
          }
          if ((request.data ?? "0x").toLowerCase() !== (calldata as string).toLowerCase()) {
            throw new Error(
              "pre-sign: the request's calldata is not the claim() the distributor's verified ABI encodes",
            );
          }
          if (request.value !== 0n) {
            throw new Error(
              `pre-sign: the request would attach ${request.value} wei to a claim, which takes none`,
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
          if (!res.applied) logger.warn("pools.holder_rewards_claim.broadcast_accept_miss", { id: rowId });
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
        ? `${TOOL_ID}: the claim was signed locally but never broadcast - ${detail}. Nothing was sent to the `
          + "network and no rewards moved."
        : `${TOOL_ID}: the claim was refused before signing - ${detail}. Nothing was signed.`,
    );
  }

  if (outcome.kind === "ambiguous") {
    // NOTHING TERMINAL. A claim that may already have paid must not look failed:
    // a failed-looking claim invites a retry that spends gas to move nothing,
    // and a signing path never retries itself. Rabby's watcher takes the same
    // position - it marks a transaction failed only on a receipt that says so
    // (`service/transactionHistory.ts:1032-1120` keeps re-reading instead) -
    // while MetaMask's PendingTransactionTracker guesses `failed` on a
    // not-found timeout, which the wallet-reference audit records as REJECTED.
    await noteHandlerPendingReason(TOOL_ID, rowId, "broadcast_ambiguous_confirm");
    return {
      success: false,
      output:
        `${TOOL_ID}: the claim transaction (${outcome.txHash}) could not be confirmed yet - it may still settle, `
        + "and it may already have paid. DO NOT retry; this attempt is recorded as pending and resolves "
        + "automatically.",
      data: { _executionId: executionId, txHash: outcome.txHash, status: "pending" },
    };
  }

  if (outcome.kind === "reverted") {
    // WHY it reverted, when the distributor will say so. Re-simulating at the
    // block it landed in costs one `eth_call` and turns "it reverted" into an
    // answer the holder can act on.
    const reason = await revertReason(x.reader, {
      account: x.walletAddress,
      distributor,
      blockNumber: outcome.receipt.blockNumber,
    });
    await failActivityEvent(rowId, {
      failureCode: "mined_revert",
      failureReason: reason === null ? "the claim transaction reverted on-chain" : `mined_revert:${reason}`,
    });
    return {
      success: false,
      output:
        `${TOOL_ID}: the claim transaction (${outcome.txHash}) reverted on-chain`
        + `${reason === null ? "" : ` - the distributor answered ${reason}()`}. Nothing was paid out, and the gas `
        + "for the failed transaction was spent.",
      data: { _executionId: executionId, txHash: outcome.txHash, status: "reverted", revert: reason },
    };
  }

  const decoded = decodePoolsHolderRewardClaim(
    outcome.receipt.logs.map((l) => ({ address: l.address, topics: l.topics as string[], data: l.data })),
    { account: x.walletAddress, distributor },
  );

  if (!decoded.ok) {
    // The transaction confirmed but WHAT IT PAID is unproven. The row stays
    // pending with the decoder's reason rather than recording the simulation as
    // though it were a settlement.
    await noteHandlerPendingReason(TOOL_ID, rowId, "settlement_undecodable");
    return {
      success: true,
      output:
        `${TOOL_ID}: the claim confirmed on-chain (tx ${outcome.txHash}), but the amounts it paid could not be `
        + `PROVEN from the receipt: ${decoded.reason}. The amounts will be filled in automatically. DO NOT claim `
        + "again.",
      data: { _executionId: executionId, txHash: outcome.txHash, status: "confirmed_pending_amounts" },
    };
  }

  const paid = decoded.value;
  try {
    await confirmActivityEvent(rowId, {
      executedAmountOutRaw: paid.tokenAmountRaw.toString(),
      executedAmountOutHuman:
        poolsRewardAmountHuman(paid.tokenAmountRaw.toString(), tokenLeg.decimals) ?? "0",
      ...(pairedLeg === null || paid.pairedAmountRaw === null
        ? {}
        : {
          executedAmountOut2Raw: paid.pairedAmountRaw.toString(),
          executedAmountOut2Human:
              poolsRewardAmountHuman(paid.pairedAmountRaw.toString(), pairedLeg.decimals) ?? "0",
        }),
    });
  } catch (err) {
    // The claim DID happen; a bookkeeping failure must not be reported as a
    // failed claim. The repair lane reconciles the row.
    logger.warn("pools.holder_rewards_claim.confirm_failed", {
      executionId,
      error: poolsFailureDetail(TOOL_ID, err),
    });
  }

  // A leg the preview promised and the receipt paid zero on is a SETTLEMENT
  // DISCREPANCY, reported as one. It is not a failure - the transaction did what
  // the contract decided - but a user told they would receive something and then
  // paid nothing must be told that in words rather than left to compare numbers.
  const discrepancies: string[] = [];
  if (tokenLeg.amountRaw > 0n && paid.tokenAmountRaw === 0n) {
    discrepancies.push(
      `the simulation said this claim would pay ${tokenLeg.amountRaw} of ${tokenLeg.asset} and the receipt shows 0`,
    );
  }
  if (pairedLeg !== null && pairedLeg.amountRaw > 0n && (paid.pairedAmountRaw ?? 0n) === 0n) {
    discrepancies.push(
      `the simulation said this claim would pay ${pairedLeg.amountRaw} of ${pairedLeg.asset} and the receipt `
        + "shows 0",
    );
  }
  if (pairedLeg !== null && paid.pairedAmountRaw === null) {
    discrepancies.push(
      "the simulation returned a paired leg while the receipt's RewardClaimed event carries only one amount",
    );
  }

  const data = {
    summary:
      `Claimed holder rewards on ${x.token}: `
      + x.legs
        .map((leg, index) => {
          const raw = index === 0 ? paid.tokenAmountRaw : (paid.pairedAmountRaw ?? 0n);
          const human = poolsRewardAmountHuman(raw.toString(), leg.decimals);
          return `${human ?? `${raw} raw`} ${leg.symbol ?? leg.asset}`;
        })
        .join(" and ")
      + `. Tx: ${outcome.txHash}`,
    chain: POOLS_CHAIN_SLUG,
    chainId: POOLS_CHAIN_ID,
    txHash: outcome.txHash,
    tokenAddress: x.token,
    wallet: x.walletAddress,
    ...describeBoundDistributor(x.binding),
    claimed: true,
    paid: x.legs.map((leg, index) => {
      const raw = index === 0 ? paid.tokenAmountRaw : paid.pairedAmountRaw;
      return {
        side: leg.side,
        assetAddress: leg.asset,
        assetSymbol: leg.symbol,
        decimals: leg.decimals,
        amountRaw: raw === null ? null : raw.toString(),
        amount: raw === null ? null : poolsRewardAmountHuman(raw.toString(), leg.decimals),
      };
    }),
    /**
     * A claim that paid zero on every leg is a SUCCESS the receipt proved, not a
     * broken tool. Saying so stops the agent reading an honest zero as a failure
     * and claiming again.
     */
    paidNothing: paid.tokenAmountRaw === 0n && (paid.pairedAmountRaw ?? 0n) === 0n,
    vexFee: null,
    status: "confirmed",
    ...(discrepancies.length > 0
      ? {
        settlementDiscrepancy: discrepancies,
        settlementDiscrepancyNote:
            "The receipt is the truth about what moved. The preview was a simulation at an earlier block and the "
            + "distributor's state changed between them; nothing here was adjusted to make the two agree.",
      }
      : {}),
    _executionId: executionId,
  };
  return { success: true, output: JSON.stringify(data), data };
}

/** The distributor's own name for a mined revert, or `null` when it will not say. */
async function revertReason(
  client: PublicClient<Transport, Chain>,
  input: { readonly account: Address; readonly distributor: Address; readonly blockNumber: bigint },
): Promise<string | null> {
  const simulation = await simulatePoolsHolderRewardsClaim(client, {
    account: input.account,
    distributor: input.distributor,
    blockNumber: input.blockNumber,
  });
  if (simulation.kind === "nothing_to_claim" || simulation.kind === "excluded") return simulation.revert;
  return null;
}
