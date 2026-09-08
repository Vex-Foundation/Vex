/**
 * Waiting for the Virtuals keeper to execute `launch(token)` - by OBSERVATION,
 * never by acting.
 *
 * ## Why Vex never calls `launch()` itself
 *
 * `launch(address)` is permissionless (`BondingV5.sol:579-592`: no `onlyOwner`,
 * no privileged-launcher check outside the special modes), so calling it is
 * technically possible and was tried. It was a defect. On 2026-09-04 our own
 * `launch()` on Robinhood (tx `0x17e401b9`) pre-empted the keeper for token
 * `0xd1eF7097` and `api.virtuals.io` never indexed the agent; the Base agent
 * whose `launch()` the KEEPER ran (tx `0x9eca4cb5`, from `0x81f7ca6a...`) was
 * indexed as id 139289 within minutes. The keeper's transaction is what the
 * platform's own pipeline is watching. Winning that race destroys the listing
 * the user launched the agent for.
 *
 * So this module reads. It never writes, it holds no signer, and its only
 * outputs are "observed", "not observed yet" and "could not tell".
 *
 * ## The three answers, and why the middle one is not a failure
 *
 *   `observed`      the `Launched` log exists. The agent is live and the fee
 *                   leg (owner F3) becomes collectible.
 *   `not_observed`  the bounded wait elapsed with no log. NOT a failure: the
 *                   pre-launch succeeded, the creator's VIRTUAL is inside
 *                   BondingV5, and the keeper very probably will act. The
 *                   caller records `awaiting_keeper` and waives the fee.
 *   `cancelled`     a `CancelledLaunch` log for this token appeared instead.
 *
 * MetaMask's `PendingTransactionTracker` turns a not-found timeout into
 * `#failTransaction(..., 'Transaction not found on network after timeout')`
 * (`PendingTransactionTracker.ts:490-495`); our wallet-reference audit records
 * that as an explicit REJECTION and this lane keeps it rejected - an elapsed
 * wait is a statement about our patience, not about the chain. Rabby's
 * `transactionWatcher` is the pattern that IS adopted: the poll interval comes
 * from the chain's block time clamped to a sane band
 * (`transactionWatcher.ts:18-44`) and a failed RPC read is `null`, never a
 * verdict (`checkStatus`'s `.catch(() => null)`).
 */

import { type AbiEvent, type Address, type Chain, type Hex, type PublicClient, type Transport } from "viem";

import type { VirtualsCurveDeployment } from "../curve/deployments.js";
import { BONDING_V5_LAUNCH_ABI } from "./abi.js";
import { decodeCancelledLaunch, decodeLaunched, type DecodedCancelledLaunch, type DecodedLaunched } from "./receipt-decoder.js";

/**
 * How long the handler waits, in milliseconds, before recording
 * `awaiting_keeper`.
 *
 * Three minutes. The measured keeper latency on Base was about a minute
 * (`preLaunch` at 15:47, `Launched` at 15:52 on the two runs archived under
 * `virtuals-contracts-2026-09-04/live-launch/`), and this is that with room for
 * a congested block, bounded well inside any sane tool timeout. Longer would
 * hold a signer open for no additional certainty: the sweep reconciles anything
 * slower without one.
 */
export const KEEPER_WAIT_MS = 180_000;

/** Rabby's band: never hammer faster than 2 s, never sleep longer than 5 s. */
const MIN_POLL_MS = 2_000;
const MAX_POLL_MS = 5_000;

export type KeeperObservation =
  | { readonly kind: "observed"; readonly launched: DecodedLaunched; readonly txHash: Hex; readonly blockNumber: bigint }
  | { readonly kind: "cancelled"; readonly cancelled: DecodedCancelledLaunch; readonly txHash: Hex }
  | {
      readonly kind: "not_observed";
      /** How long the wait actually ran, for the reply to state honestly. */
      readonly waitedMs: number;
      /** The last read error, when every attempt failed. `null` when the chain simply had no log. */
      readonly lastReadError: string | null;
    };

/**
 * The ONLY client surface this module needs: one filtered log read.
 *
 * A narrow structural interface rather than viem's `PublicClient`, and the
 * narrowness is the point rather than a convenience. It makes the central rule
 * of this lane STRUCTURAL: a future edit that tried to send `launch(token)`
 * from here would have nothing to send it with and would not compile. It also
 * lets the tests drive the three answers with a plain object instead of a cast.
 */
export interface KeeperLogRow {
  readonly address: string;
  readonly topics: readonly string[];
  readonly data: string;
  readonly transactionHash: Hex;
  readonly blockNumber: bigint;
}

export interface KeeperLogReader {
  getLogs(args: {
    readonly address: Address;
    readonly event: AbiEvent;
    readonly args: { readonly token: Address };
    readonly fromBlock: bigint;
    readonly toBlock: bigint | "latest";
  }): Promise<readonly KeeperLogRow[]>;
}

/**
 * Adapt a viem public client to the narrow reader above.
 *
 * The adapter exists rather than widening the interface to viem's own
 * `getLogs` type because that type is a fourteen-parameter conditional whose
 * inference cannot be satisfied by a plain object - which would force every
 * test into a cast, and a cast on a money path's only chain read is exactly the
 * thing that hides a shape change.
 */
export function keeperLogReaderFrom(client: PublicClient<Transport, Chain>): KeeperLogReader {
  return {
    getLogs: async (args) => await client.getLogs({
      address: args.address,
      event: args.event,
      args: { token: args.args.token },
      fromBlock: args.fromBlock,
      toBlock: args.toBlock,
    }),
  };
}

export interface KeeperWaitClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

const REAL_CLOCK: KeeperWaitClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
};

/**
 * ONE read: has `Launched` (or `CancelledLaunch`) been emitted for this token
 * since `fromBlock`?
 *
 * Exported because the reconciliation sweep asks exactly the same question
 * later, without a signer and without a deadline, and two implementations of
 * "was this agent launched" would be two chances to disagree.
 */
export async function readKeeperOutcome(input: {
  readonly client: KeeperLogReader;
  readonly deployment: VirtualsCurveDeployment;
  readonly token: Address;
  readonly fromBlock: bigint;
  readonly toBlock?: bigint;
}): Promise<
  | { readonly kind: "observed"; readonly launched: DecodedLaunched; readonly txHash: Hex; readonly blockNumber: bigint }
  | { readonly kind: "cancelled"; readonly cancelled: DecodedCancelledLaunch; readonly txHash: Hex }
  | { readonly kind: "none" }
> {
  const range = {
    address: input.deployment.bondingV5,
    fromBlock: input.fromBlock,
    ...(input.toBlock === undefined ? { toBlock: "latest" as const } : { toBlock: input.toBlock }),
  };

  // `token` is the first indexed argument of both events, so the node does the
  // filtering. The decoder still re-checks the emitter and the token: a node
  // that widened the filter must not be able to name a different agent.
  const [launchedLogs, cancelledLogs] = await Promise.all([
    input.client.getLogs({ ...range, event: eventAbi("Launched"), args: { token: input.token } }),
    input.client.getLogs({ ...range, event: eventAbi("CancelledLaunch"), args: { token: input.token } }),
  ]);

  for (const log of launchedLogs) {
    const launched = decodeLaunched({
      logs: [{ address: log.address, topics: log.topics, data: log.data }],
      bondingV5: input.deployment.bondingV5,
      token: input.token,
    });
    if (launched !== null) {
      return { kind: "observed", launched, txHash: log.transactionHash, blockNumber: log.blockNumber };
    }
  }
  for (const log of cancelledLogs) {
    const cancelled = decodeCancelledLaunch({
      logs: [{ address: log.address, topics: log.topics, data: log.data }],
      bondingV5: input.deployment.bondingV5,
    });
    if (cancelled !== null && cancelled.token === input.token) {
      return { kind: "cancelled", cancelled, txHash: log.transactionHash };
    }
  }
  return { kind: "none" };
}

function eventAbi(name: "Launched" | "CancelledLaunch"): AbiEvent {
  const entry = BONDING_V5_LAUNCH_ABI.find((item) => item.type === "event" && item.name === name);
  if (entry === undefined || entry.type !== "event") {
    throw new Error(`virtuals launch ABI has no ${name} event`);
  }
  return entry;
}

/**
 * Poll until the keeper acts or the bounded wait elapses.
 *
 * A read that THROWS does not end the wait and does not decide anything: the
 * error is remembered and the loop sleeps again, so a single flaky RPC answer
 * cannot turn a launched agent into `awaiting_keeper`. Only the deadline ends
 * the loop.
 */
export async function waitForKeeperLaunch(input: {
  readonly client: KeeperLogReader;
  readonly deployment: VirtualsCurveDeployment;
  readonly token: Address;
  readonly fromBlock: bigint;
  readonly budgetMs?: number;
  readonly pollMs?: number;
  readonly clock?: KeeperWaitClock;
}): Promise<KeeperObservation> {
  const clock = input.clock ?? REAL_CLOCK;
  const budgetMs = input.budgetMs ?? KEEPER_WAIT_MS;
  const pollMs = Math.min(MAX_POLL_MS, Math.max(MIN_POLL_MS, input.pollMs ?? MAX_POLL_MS));
  const startedAt = clock.now();
  const deadline = startedAt + budgetMs;
  let lastReadError: string | null = null;

  for (;;) {
    try {
      const outcome = await readKeeperOutcome({
        client: input.client,
        deployment: input.deployment,
        token: input.token,
        fromBlock: input.fromBlock,
      });
      if (outcome.kind !== "none") return outcome;
      lastReadError = null;
    } catch (err) {
      lastReadError = err instanceof Error ? (err.message.split("\n")[0] ?? err.message) : String(err);
    }
    const now = clock.now();
    if (now >= deadline) {
      return { kind: "not_observed", waitedMs: now - startedAt, lastReadError };
    }
    await clock.sleep(Math.min(pollMs, deadline - now));
  }
}
