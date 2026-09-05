/**
 * `pools.claim_fees` - collect and claim a pools.fun token's creator fees.
 *
 * ONE TOOL, TWO MODES. `dryRun: true` SIMULATES the claim and reports both legs;
 * without it the tool signs `PartyLocker.collectAndClaim(token)` behind the
 * ordinary approval gate, exactly like every other mutating protocol tool here.
 * The runtime treats a `dryRun` call as read-only (`isPreviewExecution`), so the
 * preview never raises an approval and the execution always does.
 *
 * THE SIMULATION IS THE ONLY HONEST PREVIEW. `claimableToken` /
 * `claimablePaired` are ALREADY-COLLECTED balances, not a claimable total:
 * measured live, both read 0 while an `eth_call` of `collectAndClaim` returned
 * 0 / 599999999999. They are surfaced under that label and never presented as
 * what a claim would pay.
 *
 * BOTH LEGS TRAVEL WITH THEIR ASSET AND DECIMALS. A claim pays the launched
 * token (18) and the paired asset (USDG is 6). A bare pair of numbers is
 * unreadable and a swapped pair is a millionfold error, so every amount here is
 * `{assetAddress, amountRaw, decimals}` and the decimals are READ from the
 * contracts.
 *
 * ONE ACTIVITY ROW, TWO OUTPUT LEGS, ITS OWN KIND (migration 082). A claim is
 * one transaction that pays two assets - not two rows, and not one row that
 * forgets an asset. It carries NO input leg, because a claim spends nothing, and
 * it rides `kind = 'claim'` rather than `launch`: a payout filed under launches
 * would land inside every launch feed, filter and count.
 *
 * DECLINE OVER GUESS, on the way in and on the way back. A pool with nothing to
 * pay is told so and nothing is signed; a simulation that cannot run is
 * `unavailable` and is never reported as "nothing to claim"; and a confirmed
 * receipt whose `Claimed` event cannot be proven leaves the row pending with the
 * decoder's own reason rather than inventing amounts.
 */

import { formatUnits, getAddress, type Address, type Chain, type PublicClient, type Transport } from "viem";

import { getLocalChain } from "@tools/evm-chains/registry.js";
import { getLocalPublicClient } from "@tools/evm-chains/evm-client.js";
import { gasLimitWithHeadroom } from "@tools/evm-chains/gas-limit-headroom.js";
import { signStageBroadcast, type StagedBroadcastOutcome } from "@tools/evm-chains/staged-broadcast.js";
import { PARTY_LOCKER_CLAIM_ABI } from "@tools/pools-fun/abi.js";
import { POOLS_CHAIN_ID, POOLS_CHAIN_SLUG } from "@tools/pools-fun/constants.js";
import {
  POOLS_UNREGISTERED_SENTENCE,
  readPoolsOnChainSnapshot,
} from "@tools/pools-fun/evm/token-registration.js";
import {
  readPoolsClaimContext,
  simulatePoolsClaim,
  type PoolsClaimContext,
} from "@tools/pools-fun/claim/read-claim.js";
import {
  createAgentActivityIntent,
  markActivityBroadcast,
  reserveActivityEvmNonce,
  markBroadcastAccepted,
  confirmActivityEvent,
  failActivityEvent,
} from "@vex-agent/db/repos/agent-activity.js";
import { decodePoolsClaimSettlement } from "@vex-agent/sync/pools-settlement-decoder.js";
import { noteHandlerPendingReason } from "@vex-agent/tools/protocols/runtime/pending-provenance.js";
import logger from "@utils/logger.js";
import { encodeFunctionData } from "viem";

import { ok, fail } from "../../handler-helpers.js";
import { openLaunchSigningClients } from "../../shared/launch-signing-clients.js";
import { resolveSelectedAddress, walletScopeErrorToResult } from "../../../internal/wallet/resolve.js";
import type { ProtocolExecutionContext } from "../../types.js";
import type { ToolResult } from "../../../types.js";
import { poolsFailureDetail } from "./failure.js";

const TOOL_ID = "pools.claim_fees";

/** One payout leg, as the agent reads it: raw amount, its scale, and its asset. */
function leg(assetAddress: Address, amountRaw: bigint, decimals: number, symbol?: string) {
  return {
    assetAddress,
    amountRaw: amountRaw.toString(),
    decimals,
    human: formatUnits(amountRaw, decimals),
    ...(symbol === undefined ? {} : { assetSymbol: symbol }),
  };
}

export async function poolsClaimFeesHandler(
  params: Record<string, unknown>,
  context: ProtocolExecutionContext,
): Promise<ToolResult> {
  const rawToken = params.token ?? params.tokenAddress;
  let token: Address;
  try {
    token = getAddress(String(rawToken));
  } catch {
    return fail(
      `${TOOL_ID} needs the ADDRESS of the pools.fun token whose creator fees you want to claim. Symbols are `
        + "not unique on this launchpad, so an address is the only identity that means one token.",
    );
  }
  const dryRun = params.dryRun === true;

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

  // A dry run never needs a key. Only the signing path decrypts one.
  const publicClient = dryRun ? getLocalPublicClient(chainConfig) : null;
  const signing = dryRun ? null : openLaunchSigningClients(context, chainConfig);
  if (signing !== null && !signing.ok) return signing.result;
  const reader: PublicClient<Transport, Chain> = publicClient ?? signing!.clients.publicClient;

  // ── WHICH SUITE HOLDS THIS TOKEN ──────────────────────────────────
  //
  // Before this, the locker was one pinned V1 address, so every V2/V3 token was
  // refused with "not registered with the pools.fun locker ... older sushi
  // launchpad" - a sentence that was wrong about the token AND wrong about the
  // reason (measured 2026-09-04 on DICK). The suite is now DETECTED, and each of
  // the four outcomes gets its own refusal, because "we could not ask" and
  // "there is nothing here" must never read alike on a money path.
  let snapshot;
  try {
    snapshot = await readPoolsOnChainSnapshot(token);
  } catch (err) {
    return fail(
      `${TOOL_ID} could not reach the chain to find which pools.fun suite holds ${token} `
        + `(${poolsFailureDetail(TOOL_ID, err)}). Nothing was signed, and nothing about this token's fees was `
        + "established either way.",
    );
  }
  const registration = snapshot.locker;
  if (registration.status === "unavailable") {
    return fail(
      `${TOOL_ID} could not determine which pools.fun suite holds ${token}: ${registration.detail} `
        + "Nothing was signed. Retry before concluding anything about this token's fees.",
    );
  }
  if (registration.status === "ambiguous") {
    return fail(
      `${TOOL_ID} refuses to claim from ${token}: ${registration.detail} Vex will not pick one locker to send `
        + "a claim to when the chain does not agree which one owns the token. Nothing was signed.",
    );
  }
  if (registration.status === "unregistered") {
    return fail(
      `${TOOL_ID}: ${token} is ${POOLS_UNREGISTERED_SENTENCE}, so it has no creator fee stream Vex can claim. `
        + "A token from another launchpad on this chain keeps its fees in its own contracts. Nothing was signed.",
    );
  }
  const suite = registration.suite;
  const locker = suite.locker as Address;

  const contextRead = await readPoolsClaimContext(reader, token, walletAddress, suite);
  if (!contextRead.ok) {
    return fail(`${TOOL_ID} could not read this token's fee stream: ${contextRead.reason}. Nothing was signed.`);
  }
  const claimContext = contextRead.context;

  const simulation = await simulatePoolsClaim(reader, {
    account: walletAddress,
    token,
    blockNumber: claimContext.blockNumber,
    suite,
  });

  if (simulation.kind === "unavailable") {
    // NOT "nothing to claim". The two are different facts and collapsing them is
    // how a tool starts telling a user their fees are gone.
    return fail(
      `${TOOL_ID} could not simulate this claim (${simulation.reason}), so what it would pay is unknown. `
        + "Nothing was signed - this is not a statement that there is nothing to claim.",
    );
  }

  if (simulation.kind === "nothing_to_claim") {
    return ok({
      chain: POOLS_CHAIN_SLUG,
      chainId: POOLS_CHAIN_ID,
      tokenAddress: token,
      claimable: null,
      alreadyCollected: describeCollected(claimContext),
      note:
        `The locker itself reports nothing to claim for this token right now (${simulation.revert}). `
        + "Fees accrue as the pool trades, so this can change. Nothing was signed and no gas was spent.",
    });
  }

  const claimable = {
    tokenLeg: leg(token, simulation.tokenAmountRaw, claimContext.tokenDecimals),
    pairedLeg: leg(claimContext.pairedAsset, simulation.pairedAmountRaw, claimContext.pairedDecimals),
  };

  if (dryRun) {
    // The gas bound is what a claim would SIGN, headroomed exactly as the
    // broadcaster signs it - a ceiling, not an estimate to spend, and `null`
    // when the node will not price it rather than a guessed number.
    const gasLimit = await estimatePoolsClaimGas(reader, { account: walletAddress, token, locker });
    return ok({
      chain: POOLS_CHAIN_SLUG,
      chainId: POOLS_CHAIN_ID,
      tokenAddress: token,
      poolAddress: claimContext.poolAddress,
      wallet: walletAddress,
      feeRecipient: claimContext.feeRecipient,
      dryRun: true,
      claimable,
      alreadyCollected: describeCollected(claimContext),
      gasLimitBound: gasLimit === null ? null : gasLimit.toString(),
      blockNumber: claimContext.blockNumber.toString(),
      note:
        "SIMULATED at the block above by calling collectAndClaim as your wallet - this is what a claim would "
        + "pay right now, and it moves as the pool trades. The 'alreadyCollected' figures are fees the locker "
        + "has already swept in and not yet paid out; they are NOT a claimable total. Nothing was signed.",
    });
  }

  return executeClaim({
    token,
    walletAddress,
    sessionId,
    params,
    claimContext,
    claimable: { token: simulation.tokenAmountRaw, paired: simulation.pairedAmountRaw },
    publicClient: signing!.clients.publicClient,
    walletClient: signing!.clients.walletClient,
  });
}

/** The already-collected pair, always under its own label. */
function describeCollected(claimContext: PoolsClaimContext) {
  return {
    tokenLeg: leg(
      claimContext.alreadyCollected.token.assetAddress,
      claimContext.alreadyCollected.token.amountRaw,
      claimContext.alreadyCollected.token.decimals,
    ),
    pairedLeg: leg(
      claimContext.alreadyCollected.paired.assetAddress,
      claimContext.alreadyCollected.paired.amountRaw,
      claimContext.alreadyCollected.paired.decimals,
    ),
    note:
      "Fees ALREADY collected into the locker and not yet paid out. This is not what a claim would pay - the "
      + "simulation is.",
  };
}

interface ExecuteClaimInput {
  readonly token: Address;
  readonly walletAddress: Address;
  readonly sessionId: string;
  readonly params: Record<string, unknown>;
  readonly claimContext: PoolsClaimContext;
  readonly claimable: { readonly token: bigint; readonly paired: bigint };
  readonly publicClient: PublicClient<Transport, Chain>;
  readonly walletClient: Parameters<typeof signStageBroadcast>[1];
}

async function executeClaim(x: ExecuteClaimInput): Promise<ToolResult> {
  const calldata = encodeFunctionData({
    abi: PARTY_LOCKER_CLAIM_ABI,
    functionName: "collectAndClaim",
    args: [x.token],
  });

  // The durable row BEFORE anything is broadcast: a crash mid-flight must leave
  // a record, not an invisible transaction. ONE row, TWO output legs, no input.
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
          eventRole: "pools_claim",
          // ITS OWN KIND (migration 082, owner decision 2026-08-19). A claim is
          // not a launch: it signs its own transaction long afterwards, spends
          // nothing, and pays two assets out.
          kind: "claim",
          protocol: "pools",
          chainId: POOLS_CHAIN_ID,
          chainSlug: POOLS_CHAIN_SLUG,
          walletAddress: x.walletAddress,
          sessionId: x.sessionId,
          // The SIMULATED amounts are the row's PLANNED legs; the executed ones
          // are written from the receipt's own `Claimed` event.
          tokenOut: {
            tokenAddress: x.token,
            tokenSymbol: "",
            tokenDecimals: x.claimContext.tokenDecimals,
            amountHuman: formatUnits(x.claimable.token, x.claimContext.tokenDecimals),
            amountRaw: x.claimable.token.toString(),
          },
          tokenOut2: {
            tokenAddress: x.claimContext.pairedAsset,
            tokenSymbol: "",
            tokenDecimals: x.claimContext.pairedDecimals,
            amountHuman: formatUnits(x.claimable.paired, x.claimContext.pairedDecimals),
            amountRaw: x.claimable.paired.toString(),
          },
        },
      ],
    });
    executionId = created.executionId;
    rowId = created.events[0]!.id;
  } catch (err) {
    return fail(`${TOOL_ID} failed before broadcasting: ${poolsFailureDetail(TOOL_ID, err)}. Nothing was signed.`);
  }

  let signedLocally = false;
  let outcome: StagedBroadcastOutcome;
  try {
    outcome = await signStageBroadcast(
      x.publicClient,
      x.walletClient,
      { to: x.claimContext.suite.locker as Address, data: calldata, value: 0n },
      {
        onNonceReserved: (request) => reserveActivityEvmNonce(rowId, request),
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
          if (!res.applied) logger.warn("pools.claim_fees.broadcast_accept_miss", { id: rowId });
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
          + "network and no funds moved."
        : `${TOOL_ID}: the claim was refused before signing - ${detail}. Nothing was signed.`,
    );
  }

  if (outcome.kind === "ambiguous") {
    // NOTHING TERMINAL. A claim that may already have paid must not look failed,
    // because a failed-looking claim invites a retry that pays gas for nothing.
    await noteHandlerPendingReason(TOOL_ID, rowId, "broadcast_ambiguous_confirm");
    return {
      success: false,
      output:
        `${TOOL_ID}: the claim transaction (${outcome.txHash}) could not be confirmed yet - it may still `
        + "settle, and it may already have paid. DO NOT retry; this attempt is recorded as pending and "
        + "resolves automatically.",
      data: { _executionId: executionId, txHash: outcome.txHash, status: "pending" },
    };
  }

  if (outcome.kind === "reverted") {
    await failActivityEvent(rowId, {
      failureCode: "mined_revert",
      failureReason: "the claim transaction reverted on-chain",
    });
    return {
      success: false,
      output: `${TOOL_ID}: the claim transaction (${outcome.txHash}) reverted on-chain. Nothing was paid out.`,
      data: { _executionId: executionId, txHash: outcome.txHash, status: "reverted" },
    };
  }

  const decoded = decodePoolsClaimSettlement(
    outcome.receipt.logs.map((l) => ({ address: l.address, topics: l.topics as string[], data: l.data })),
    { account: x.walletAddress, tokenAddress: x.token },
    // The SAME locker the claim was simulated against and broadcast to. A
    // decoder pinned to a different suite would decline a real receipt.
    { locker: x.claimContext.suite.locker },
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
        + `PROVEN from the receipt: ${decoded.reason}. The amounts will be filled in automatically. DO NOT `
        + "claim again.",
      data: { _executionId: executionId, txHash: outcome.txHash, status: "confirmed_pending_amounts" },
    };
  }

  const paid = decoded.value;
  try {
    // BOTH legs, from the event, in one write: `pools_claim` is complete only
    // when each payout is proven, and a zero is a proven amount rather than a
    // missing one.
    await confirmActivityEvent(rowId, {
      executedAmountOutRaw: paid.tokenAmountRaw.toString(),
      executedAmountOutHuman: formatUnits(paid.tokenAmountRaw, x.claimContext.tokenDecimals),
      executedAmountOut2Raw: paid.pairedAmountRaw.toString(),
      executedAmountOut2Human: formatUnits(paid.pairedAmountRaw, x.claimContext.pairedDecimals),
    });
  } catch (err) {
    // The claim DID happen; a bookkeeping failure must not be reported as a
    // failed claim. The repair lane reconciles the row.
    logger.warn("pools.claim_fees.confirm_failed", { executionId, error: poolsFailureDetail(TOOL_ID, err) });
  }

  const data = {
    summary:
      `Claimed creator fees for ${x.token}: ${formatUnits(paid.tokenAmountRaw, x.claimContext.tokenDecimals)} `
      + `of the token and ${formatUnits(paid.pairedAmountRaw, x.claimContext.pairedDecimals)} of the paired `
      + `asset. Tx: ${outcome.txHash}`,
    chain: POOLS_CHAIN_SLUG,
    chainId: POOLS_CHAIN_ID,
    txHash: outcome.txHash,
    tokenAddress: x.token,
    claimed: {
      tokenLeg: leg(x.token, paid.tokenAmountRaw, x.claimContext.tokenDecimals),
      pairedLeg: leg(x.claimContext.pairedAsset, paid.pairedAmountRaw, x.claimContext.pairedDecimals),
    },
    /**
     * A 0/0 claim is a SUCCESS, not a failure: the pool had nothing to pay at
     * that block, which is a fact the receipt proved. Saying so stops the agent
     * reading an honest zero as a broken tool and retrying it.
     */
    paidNothing: paid.tokenAmountRaw === 0n && paid.pairedAmountRaw === 0n,
    status: "confirmed",
    _executionId: executionId,
  };
  return { success: true, output: JSON.stringify(data), data };
}

/** Gas the claim would sign, headroomed exactly as the broadcaster signs it. */
export async function estimatePoolsClaimGas(
  client: PublicClient<Transport, Chain>,
  input: { readonly account: Address; readonly token: Address; readonly locker: Address },
): Promise<bigint | null> {
  try {
    const estimate = await client.estimateGas({
      account: input.account,
      to: input.locker,
      data: encodeFunctionData({
        abi: PARTY_LOCKER_CLAIM_ABI,
        functionName: "collectAndClaim",
        args: [input.token],
      }),
    });
    return gasLimitWithHeadroom(estimate);
  } catch {
    return null;
  }
}
