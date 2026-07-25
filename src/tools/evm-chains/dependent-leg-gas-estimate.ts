/**
 * Gas estimation for an EVM leg that DEPENDS on a leg the same plan already
 * confirmed on-chain (the approval → swap/deposit shape).
 *
 * This is a read-after-write consistency policy, not a venue detail, so it
 * lives beside `gas-limit-headroom.ts` and is reached by every venue that
 * signs a multi-leg EVM plan: KyberSwap and Relay through
 * `kyberswap/evm/staged-broadcast.ts`'s `signStageBroadcast`, Khalani through
 * `khalani/bridge-executor.ts`'s `signStageEvmLeg`, Uniswap through
 * `uniswap/execute.ts`'s `signUniswapTransaction`.
 *
 * WHY IT EXISTS — live 2026-07-24/25, real funds, two independent venues.
 * Once the gas-headroom fix (`gas-limit-headroom.ts`) made every leg's
 * `eth_estimateGas` EXPLICIT, the estimate for the leg that follows an
 * approval started running against a node that had not yet applied that
 * approval, even though its receipt was already confirmed:
 *   - Khalani Base→Arbitrum: allowance `0x2445ce73…` CONFIRMED, deposit
 *     refused with `ERC20: transfer amount exceeds allowance`; an immediate
 *     retry with nothing changed succeeded (`0xcef2a865…`).
 *   - Relay Base→Arbitrum: allowance `0x68dec753…` CONFIRMED, deposit refused
 *     with `Execution reverted for an unknown reason`; immediate retry
 *     succeeded (`0xc96bfee1…`).
 * The retry is the discriminator: nothing about the transaction changed, only
 * that the estimating node had caught up. Before the headroom fix the venues
 * that supplied `tx.gas` skipped estimation entirely, so this path could not
 * fail — the regression is ours.
 *
 * WHAT IT DOES NOT DO. It never widens what gets signed: a leg whose estimate
 * never succeeds is still refused BEFORE signing, exactly as today. Retrying
 * is bounded (`DEPENDENT_LEG_ESTIMATE_ATTEMPTS`) and is attempted ONLY when a
 * prior leg of the same plan is known to have confirmed — with no such leg,
 * an estimate failure is a first-touch revert with no state of ours behind it,
 * so it fails on the first attempt with the original error untouched.
 *
 * WHY THE ANCHOR IS THE PRIOR LEG'S RECEIPT BLOCK, NOT A REVERT-STRING MATCH.
 * The two live failures produced completely different node text (one named the
 * allowance, one had no reason at all), so classifying by message would have
 * caught one venue and missed the other. Plan structure is the reliable
 * signal, and it is the same signal that makes the retry safe: our own
 * confirmed write is the only reason to doubt the node's answer.
 */

import type { Account, Address, Chain, Hex, PublicClient, Transport } from "viem";

/**
 * A leg of the SAME plan that is already confirmed on-chain and whose state
 * the leg being estimated depends on (in practice: the ERC-20 approval).
 * `blockNumber` comes from that leg's own receipt.
 */
export interface ConfirmedPriorLeg {
  readonly blockNumber: bigint;
}

/** The call to price — the same `to`/`data`/`value` that will actually be signed. */
export interface PlanLegCall {
  readonly account: Account;
  readonly to: Address;
  readonly data?: Hex;
  readonly value: bigint;
}

/**
 * Total `eth_estimateGas` attempts for a leg that follows a confirmed prior
 * leg — the first attempt plus two retries. Bounded on purpose: a genuinely
 * reverting leg must still be refused pre-sign within a few seconds, and an
 * unbounded loop would turn a real revert into a hang while the quote it was
 * priced against goes stale.
 */
export const DEPENDENT_LEG_ESTIMATE_ATTEMPTS = 3;

/** Backoff before retry N (1.5s, then 3s) — a lagging node needs wall-clock time, not more requests. */
const RETRY_BACKOFF_STEP_MS = 1_500;

/** Head-height poll budget inside ONE retry: at most 3 reads, 500ms apart. */
const HEAD_POLL_ATTEMPTS = 3;
const HEAD_POLL_INTERVAL_MS = 500;

/**
 * Machine-greppable marker opening the error message, so the durable
 * `failure_reason` a venue records (via its existing scrub → `abortPlannedEvents`
 * path) distinguishes this class from a genuine revert WITHOUT growing the
 * closed `AgentActivityFailureCode` enum.
 */
export const DEPENDENT_LEG_ESTIMATE_MARKER = "estimate_unavailable_after_confirmed_leg";

/**
 * Every bounded attempt to estimate a leg that follows a confirmed prior leg
 * failed. NOTHING was signed, staged, or broadcast — this error is always
 * raised from the pre-sign estimate, so the "never sign a transaction we know
 * will revert" guarantee is intact. The distinction it carries is honest and
 * narrow: we could not obtain an estimate, and one reason we might not have is
 * that the estimating node had not applied our own just-confirmed leg.
 */
export class DependentLegGasEstimateError extends Error {
  readonly attempts: number;
  readonly priorLegBlockNumber: bigint;
  /** Highest block the estimating client reported, or `null` if it never answered. */
  readonly observedHeadBlock: bigint | null;

  constructor(params: {
    readonly attempts: number;
    readonly priorLegBlockNumber: bigint;
    readonly observedHeadBlock: bigint | null;
    readonly cause: unknown;
  }) {
    super(
      `${DEPENDENT_LEG_ESTIMATE_MARKER} attempts=${params.attempts}`
        + ` prior_leg_block=${params.priorLegBlockNumber}`
        + ` rpc_head=${params.observedHeadBlock ?? "unknown"}`
        + ` nothing_signed — ${firstLineOf(params.cause)}`,
      { cause: params.cause },
    );
    this.name = "DependentLegGasEstimateError";
    this.attempts = params.attempts;
    this.priorLegBlockNumber = params.priorLegBlockNumber;
    this.observedHeadBlock = params.observedHeadBlock;
  }
}

/**
 * Agent-facing explanation for a leg refused this way. Deliberately does NOT
 * claim the leg would have succeeded — it states what is provable (nothing was
 * signed, so nothing can be duplicated), names the one benign explanation, and
 * caps the agent's own retrying at one more try.
 */
export function dependentLegEstimateGuidance(err: DependentLegGasEstimateError): string {
  return `Nothing was signed or broadcast for this step, so it moved no funds and re-running cannot duplicate it. `
    + `The gas estimate was attempted ${err.attempts} times after the previous step confirmed on-chain at block ${err.priorLegBlockNumber}, `
    + `and every attempt failed. The estimating RPC may simply not have applied that confirmed step yet, so running the same request once more is reasonable. `
    + `If it fails the same way again, treat this step as genuinely reverting and do not keep retrying.`;
}

/**
 * Narrow an RPC-reported receipt block into an anchor. Takes `unknown` on
 * purpose: the value arrives from a provider receipt, and a receipt without a
 * usable block number must degrade to "no anchor" (single attempt, today's
 * behavior) rather than to a bad anchor.
 */
export function priorLegAnchorFrom(blockNumber: unknown): ConfirmedPriorLeg | undefined {
  return typeof blockNumber === "bigint" ? { blockNumber } : undefined;
}

/**
 * Estimate gas for one leg of a plan. With no `priorLeg`, this is exactly a
 * single `publicClient.estimateGas` and the node's error propagates unchanged.
 * With a `priorLeg`, a failed estimate is retried up to
 * `DEPENDENT_LEG_ESTIMATE_ATTEMPTS` times before the leg is refused with a
 * `DependentLegGasEstimateError`.
 */
export async function estimateGasForPlanLeg(
  publicClient: PublicClient<Transport, Chain>,
  call: PlanLegCall,
  priorLeg: ConfirmedPriorLeg | undefined,
): Promise<bigint> {
  const estimateArgs = {
    account: call.account,
    to: call.to,
    ...(call.data === undefined ? {} : { data: call.data }),
    value: call.value,
  };

  try {
    return await publicClient.estimateGas(estimateArgs);
  } catch (firstError) {
    // No confirmed leg of ours behind this call — there is no stale-state
    // hypothesis to test, so this is a genuine revert and stays untouched.
    if (priorLeg === undefined) throw firstError;
    return retryEstimateAfterConfirmedPriorLeg(publicClient, estimateArgs, priorLeg, firstError);
  }
}

async function retryEstimateAfterConfirmedPriorLeg(
  publicClient: PublicClient<Transport, Chain>,
  estimateArgs: Parameters<PublicClient<Transport, Chain>["estimateGas"]>[0],
  priorLeg: ConfirmedPriorLeg,
  firstError: unknown,
): Promise<bigint> {
  let lastError = firstError;
  let observedHeadBlock: bigint | null = null;

  for (let attempt = 2; attempt <= DEPENDENT_LEG_ESTIMATE_ATTEMPTS; attempt++) {
    await delay(RETRY_BACKOFF_STEP_MS * (attempt - 1));
    observedHeadBlock = await waitForHeadAtLeast(publicClient, priorLeg.blockNumber);
    try {
      return await publicClient.estimateGas(estimateArgs);
    } catch (err) {
      lastError = err;
    }
  }

  throw new DependentLegGasEstimateError({
    attempts: DEPENDENT_LEG_ESTIMATE_ATTEMPTS,
    priorLegBlockNumber: priorLeg.blockNumber,
    observedHeadBlock,
    cause: lastError,
  });
}

/**
 * Bounded wait until the estimating client reports a head at or beyond the
 * prior leg's receipt block. `cacheTime: 0` is load-bearing — viem caches
 * `getBlockNumber` for the client's polling interval by default, and a cached
 * head would answer with the very view we are trying to outrun.
 *
 * Returns the last head observed (or `null` if the client never answered) as
 * EVIDENCE for the failure reason. It is deliberately not a gate: a pool that
 * round-robins requests can report a caught-up head and still serve the
 * estimate from a node that is behind, so reaching the height is necessary,
 * never sufficient — which is why the backoff above exists as well. A head
 * read that throws must never mask the estimate error the caller cares about.
 */
async function waitForHeadAtLeast(
  publicClient: PublicClient<Transport, Chain>,
  minBlockNumber: bigint,
): Promise<bigint | null> {
  let head: bigint | null = null;
  for (let poll = 1; poll <= HEAD_POLL_ATTEMPTS; poll++) {
    try {
      head = await publicClient.getBlockNumber({ cacheTime: 0 });
    } catch {
      return head;
    }
    if (head >= minBlockNumber) return head;
    if (poll < HEAD_POLL_ATTEMPTS) await delay(HEAD_POLL_INTERVAL_MS);
  }
  return head;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * viem error messages carry the short reason on the first line and then
 * multi-line request metadata; only the first line is useful once the venue's
 * 200-char scrub cap applies. The full error is preserved as `cause`.
 */
function firstLineOf(cause: unknown): string {
  const text = cause instanceof Error ? cause.message : String(cause);
  return text.split("\n", 1)[0]?.trim() || "no error text";
}
