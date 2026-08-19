/**
 * PHASE 2's PRE-SIGN CHECK, RUN AGAINST A NODE THAT HAS SEEN THIS EXECUTION'S
 * OWN APPROVAL - and the honest classification for when that cannot be proven.
 *
 * ── THE DEFECT THIS EXISTS FOR (funded live audit, 2026-08-18, D1) ──────────
 *
 * The vault deposit broadcast its approval legs, awaited a definitive receipt
 * for each, and then rebuilt and SIMULATED the deposit against `latest`. The
 * simulating node had not applied the block the approval mined in, so the
 * simulation reverted on an allowance that was, on chain, already exactly right
 * (100000 raw). The handler terminalized that revert as "a definitive refusal
 * from the chain rather than a transient failure". The identical call minutes
 * later read none-needed and confirmed. The user paid for two approval
 * transactions and got no deposit, and the lane broke its own rule that
 * ambiguity is never terminalized by the handler.
 *
 * It is the SAME read-after-write lag `@tools/evm-chains/dependent-leg-gas-estimate.ts`
 * documents from two independent venues on real funds, arriving through the
 * other pre-sign check. That module fixed the gas estimate; the simulation had
 * no equivalent, which is why it is timing-dependent and intermittent: a market
 * supply needing one approval confirmed first try, while the deposit's
 * reset-then-approve pair gave the node more to catch up on.
 *
 * ── WHAT THIS DOES ─────────────────────────────────────────────────────────
 *
 * With no approval of ours behind the operation, nothing changes: one attempt,
 * and the original error propagates untouched. There is no stale-state
 * hypothesis to test, so a revert there is a first-touch revert and stays a
 * definitive one.
 *
 * With an approval of ours confirmed, the simulating client is given a bounded
 * chance to reach that receipt's block BEFORE each attempt, and a proven revert
 * is retried within the pre-signature window. Retrying costs nothing but time:
 * the rebuild and the simulation read state and spend neither gas nor a
 * signature.
 *
 * ── WHY A SURVIVING REVERT IS STILL NOT DEFINITIVE ─────────────────────────
 *
 * `eth_call` runs against `latest`, so Vex cannot PROVE which block answered it.
 * Reaching the head height is necessary and never sufficient - a pool that
 * round-robins requests can report a caught-up head and still serve the call
 * from a node that is behind, which is the reading the sibling module reached
 * from its own live evidence. So when this execution has just written an
 * allowance and the simulation still reverts, Vex does not know whether it is
 * looking at the chain or at a stale view of it, and the one thing it must not
 * do is convert that into a definitive refusal from the chain.
 *
 * NOTHING WAS SIGNED EITHER WAY, which is what makes the honest ending safe to
 * act on: the operation moved no funds, so re-running it cannot duplicate
 * anything, and the approval it needs is already standing. The message says
 * exactly that, states the node's own revert text so a genuine revert is still
 * visible, and caps the agent's retrying at one more attempt rather than
 * inviting a loop. Vex does NOT re-broadcast anything itself.
 */

import {
  DependentLegGasEstimateError,
  dependentLegEstimateGuidance,
  type ConfirmedPriorLeg,
} from "@tools/evm-chains/dependent-leg-gas-estimate.js";

import { VexError } from "../../../../../../errors.js";
import { morphoFailureDetail } from "../shared.js";

/**
 * Total pre-sign attempts once an approval of this execution has confirmed: the
 * first plus two retries. Bounded for the same reason the gas-estimate sibling
 * is - a genuinely reverting operation must still be refused within seconds,
 * and an unbounded loop turns a real revert into a hang while the quote it was
 * priced against goes stale.
 */
export const POST_APPROVAL_PREFLIGHT_ATTEMPTS = 3;

/** Backoff before retry N (1.5s, then 3s). A lagging node needs wall clock, not more requests. */
const RETRY_BACKOFF_STEP_MS = 1_500;

/** Head-height poll budget before ONE attempt: at most 3 reads, 500ms apart. */
const HEAD_POLL_ATTEMPTS = 3;
const HEAD_POLL_INTERVAL_MS = 500;

/** The one client action this needs. Narrow on purpose: any viem client satisfies it. */
export interface HeadReadingClient {
  getBlockNumber(args?: { cacheTime?: number }): Promise<bigint>;
}

/**
 * Every bounded pre-sign attempt reverted, AFTER this execution's own approval
 * confirmed on chain and while the simulating node could not be proven to have
 * applied it. NOTHING was signed, staged or broadcast.
 *
 * It is deliberately not a `VexError`: the whole point is that it carries no
 * provider verdict. Vex could not establish what the chain would do.
 */
export class MorphoPostApprovalRevertUnproven extends Error {
  readonly attempts: number;
  readonly approvalBlockNumber: bigint;
  /** Highest block the simulating client reported, or `null` if it never answered. */
  readonly observedHeadBlock: bigint | null;

  constructor(params: {
    readonly attempts: number;
    readonly approvalBlockNumber: bigint;
    readonly observedHeadBlock: bigint | null;
    readonly cause: unknown;
  }) {
    super(
      `post_approval_simulation_unproven attempts=${params.attempts}`
      + ` approval_block=${params.approvalBlockNumber}`
      + ` rpc_head=${params.observedHeadBlock ?? "unknown"} nothing_signed`,
      { cause: params.cause },
    );
    this.name = "MorphoPostApprovalRevertUnproven";
    this.attempts = params.attempts;
    this.approvalBlockNumber = params.approvalBlockNumber;
    this.observedHeadBlock = params.observedHeadBlock;
  }
}

/**
 * The agent-facing explanation. It states what is provable, names the benign
 * explanation without asserting it, repeats the node's own revert text so a real
 * revert is not hidden behind a hedge, and bounds the retrying.
 */
export function morphoPostApprovalUnprovenMessage(
  err: MorphoPostApprovalRevertUnproven,
  operationLabel: string,
): string {
  const cause = err.cause instanceof VexError
    ? err.cause.message
    : err.cause instanceof Error ? err.cause.message : String(err.cause);
  return (
    `the ${operationLabel} could not be proven safe to send. This execution's own approval CONFIRMED on chain at `
    + `block ${err.approvalBlockNumber}, and the simulation still reverted on all ${err.attempts} attempts after it `
    + `(the simulating RPC reported head ${err.observedHeadBlock ?? "unknown"}). A simulation runs against "latest" `
    + "and Vex cannot prove which block answered it, so this is NOT a definitive refusal from the chain: the node "
    + "may simply not have applied that confirmed approval yet. NOTHING was signed or sent for this step, so no gas "
    + "was spent on it and re-running cannot duplicate anything. The approval is already in place, so running the "
    + "same operation once more is reasonable and it consumes that standing allowance rather than granting a new "
    + `one. If it fails the same way again, treat the revert as genuine and stop retrying. The node said: ${cause}`
  );
}

/**
 * How a PRE-SIGNATURE failure is rendered for the agent, for both lanes.
 *
 * THE OTHER PRE-SIGN CHECK HAS THE SAME STALE-NODE PROBLEM, and it already
 * detects it: `estimateGasForPlanLeg` retries the gas estimate when a leg of the
 * same plan has confirmed, and raises `DependentLegGasEstimateError` when every
 * attempt failed. That error owns its own agent-facing guidance, which says one
 * more try is reasonable and names the caught-up-node explanation. Rendering it
 * through the ordinary path instead ended the sentence with "report it verbatim
 * rather than retrying blind" - the opposite instruction, on the one failure
 * class the repo has live evidence a single retry clears.
 */
export function morphoPreSignDetail(err: unknown): string {
  return err instanceof DependentLegGasEstimateError
    ? `[MORPHO_PRESIGN_ESTIMATE_UNPROVEN/transport]: ${err.message} - ${dependentLegEstimateGuidance(err)}`
    : morphoFailureDetail(err);
}

/**
 * Run a pre-sign build+simulate step, held to this execution's own approval
 * block when there is one.
 *
 * @param prepare the phase-2 rebuild that simulates. Read-only and safe to
 * repeat: it signs, stages and broadcasts nothing.
 * @param isProvenRevert narrows which throw is a PROVEN revert. Only that class
 * is retried and re-classified; every other failure propagates on the first
 * attempt, unchanged, because it carries no stale-approval hypothesis.
 * @throws {MorphoPostApprovalRevertUnproven} when every attempt reverted and an
 * approval of this execution had already confirmed.
 */
export async function prepareLegAfterApproval<T>(params: {
  readonly priorLeg: ConfirmedPriorLeg | undefined;
  readonly simulatingClient: HeadReadingClient;
  readonly prepare: () => Promise<T>;
  readonly isProvenRevert: (err: unknown) => boolean;
}): Promise<T> {
  const { priorLeg, simulatingClient, prepare, isProvenRevert } = params;
  if (priorLeg === undefined) return prepare();

  let lastError: unknown;
  let observedHeadBlock: bigint | null = null;
  for (let attempt = 1; attempt <= POST_APPROVAL_PREFLIGHT_ATTEMPTS; attempt += 1) {
    if (attempt > 1) await delay(RETRY_BACKOFF_STEP_MS * (attempt - 1));
    observedHeadBlock = await waitForHeadAtLeast(simulatingClient, priorLeg.blockNumber);
    try {
      return await prepare();
    } catch (err) {
      // A build failure, a policy refusal or an unanswered node is not the
      // stale-approval case and owns its own honest ending already.
      if (!isProvenRevert(err)) throw err;
      lastError = err;
    }
  }

  throw new MorphoPostApprovalRevertUnproven({
    attempts: POST_APPROVAL_PREFLIGHT_ATTEMPTS,
    approvalBlockNumber: priorLeg.blockNumber,
    observedHeadBlock,
    cause: lastError,
  });
}

/**
 * Bounded wait until the simulating client reports a head at or beyond the
 * approval's receipt block. `cacheTime: 0` is load-bearing: viem caches
 * `getBlockNumber` for the client's polling interval, and a cached head would
 * answer with the very view this is trying to outrun.
 *
 * The last head observed is returned as EVIDENCE for the failure text, never as
 * a gate - see this file's header for why reaching the height is necessary and
 * not sufficient. A head read that throws must not mask the revert the caller
 * cares about.
 */
async function waitForHeadAtLeast(client: HeadReadingClient, minBlockNumber: bigint): Promise<bigint | null> {
  let head: bigint | null = null;
  for (let poll = 1; poll <= HEAD_POLL_ATTEMPTS; poll += 1) {
    try {
      head = await client.getBlockNumber({ cacheTime: 0 });
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
