import logger from "@utils/logger.js";
import type { LighterPrivilegedAccountAuth } from "@tools/lighter/client.js";
import type { LighterEnvironment } from "@tools/lighter/constants.js";
import { getLighterFeePolicy } from "@tools/lighter/fee-policy.js";
import type { LighterOrderFeeClient } from "./order-fees.js";

/**
 * SWITCH `LIGHTER_LIFECYCLE_PARALLEL_READS` (deps override `lifecycleParallelReads`).
 *
 * ON starts the provider READS an approved close, modify, cancel or cancel-all
 * revalidates with together, at the point today's first read starts, and an
 * OCO's credential read beside its revalidation:
 *
 * - close: the fee check's four reads, `/apikeys` and `/nextNonce` beside the
 *   (account, market, book) batch;
 * - modify: active orders, the fee check's four reads, `/apikeys` and
 *   `/nextNonce` beside the market read;
 * - cancel one and cancel all: active orders, `/apikeys` and `/nextNonce`;
 * - OCO: the registered key and `/nextNonce` beside the whole revalidation.
 *
 * Nothing else moves. Every result is still judged in today's order, each read
 * awaited exactly where today's code issues it, so a read that fails refuses
 * where, and with what, it refuses today, and a later read's failure never
 * overtakes an earlier refusal. A read never judged because an earlier check
 * refused is discarded. The fee check's trader account stays its own `fresh`
 * read, never the batch's account. The signing secret loads where it loads
 * today, and the nonce observation, reservation, signing and send are
 * untouched: `/nextNonce` is a plain provider read, and nothing is reserved
 * until the reservation transaction.
 *
 * ON for the owner's live check; `false` is the rollback and today's path. The
 * risk is the one `LIGHTER_ORDER_PARALLEL_PREFLIGHT` carries: `/nextNonce` is
 * read earlier, by at most the longest read beside it. A concurrent Vex action
 * on the same API key that consumes a nonce inside that window leaves this
 * action signed with a stale nonce, which Lighter refuses (recorded ambiguous
 * and reconciled, never resent). A refusal also spends the reads that today
 * would never have been issued.
 */
export const LIGHTER_LIFECYCLE_PARALLEL_READS = true;

export function lighterLifecycleParallelReads(override: boolean | undefined): boolean {
  return override ?? LIGHTER_LIFECYCLE_PARALLEL_READS;
}

/**
 * One provider read. OFF issues it at the moment it is first awaited, exactly
 * where today's code issues it. ON starts it now and hands the same promise to
 * that await; its rejection is marked handled here, so a read nobody awaits
 * (because an earlier check refused) is never an unhandled rejection, while
 * the await still receives it. A start that throws synchronously becomes that
 * rejection too, so it surfaces at today's point and nowhere earlier.
 */
export function lifecycleRead<T>(parallel: boolean, start: () => Promise<T>): () => Promise<T> {
  if (!parallel) return start;
  let started: Promise<T>;
  try {
    started = Promise.resolve(start());
  } catch (error) {
    started = Promise.reject(error);
  }
  started.catch(() => undefined);
  return () => started;
}

/**
 * The fee check's four reads, started now (ON) with exactly the arguments
 * `resolveLighterOrderFees` issues them with when the caller supplies its own
 * auth: a `fresh` system config, a `fresh` collector account, a `fresh` trader
 * account and the account limits under that auth. The returned client hands
 * each started read to the one fee-check call with the same method and
 * arguments; any other call reaches the real client, so a drift in the fee
 * check's reads costs a read, never a different answer. The fee check itself
 * runs unchanged over that client, at today's point, with today's refusals.
 *
 * Nothing starts (the real client comes back) when OFF, and whenever today's
 * fee check would read nothing or fail before reading: fee collection off for
 * the environment, a client without the fee reads, or a fee policy error,
 * which the fee check raises itself at today's point.
 */
export function prefetchLighterLifecycleFeeReads(input: {
  readonly parallel: boolean;
  readonly client: LighterOrderFeeClient;
  readonly environment: LighterEnvironment;
  readonly accountIndex: number;
  readonly auth: LighterPrivilegedAccountAuth;
}): LighterOrderFeeClient {
  const { client, environment } = input;
  if (!input.parallel) return client;
  let collectorAccountIndex: number;
  try {
    const policy = getLighterFeePolicy(environment);
    if (policy === null) return client;
    collectorAccountIndex = policy.collectorAccountIndex;
  } catch {
    return client;
  }
  if (client.getAccount === undefined || client.getSystemConfig === undefined || client.getAccountLimits === undefined) {
    return client;
  }
  // Bound, so a class-instance client keeps its receiver.
  const getAccount = client.getAccount.bind(client);
  const getSystemConfig = client.getSystemConfig.bind(client);
  const getAccountLimits = client.getAccountLimits.bind(client);
  const fresh = { fresh: true } as const;
  // Today's fee check issues these four in one Promise.all, in this order.
  const systemConfig = [prefetched(getSystemConfig, [environment, fresh])];
  const accounts = [
    prefetched(getAccount, [environment, { by: "index", value: collectorAccountIndex }, fresh]),
    prefetched(getAccount, [environment, { by: "index", value: input.accountIndex }, fresh]),
  ];
  const limits = [prefetched(getAccountLimits, [environment, { accountIndex: input.accountIndex }, input.auth])];
  return {
    getSystemConfig: (...args) => take(systemConfig, args) ?? getSystemConfig(...args),
    getAccount: (...args) => take(accounts, args) ?? getAccount(...args),
    getAccountLimits: (...args) => take(limits, args) ?? getAccountLimits(...args),
  };
}

interface PrefetchedFeeRead<R> {
  readonly key: string;
  readonly promise: Promise<R>;
  used: boolean;
}

function prefetched<A extends readonly unknown[], R>(
  read: (...args: A) => Promise<R>,
  args: A,
): PrefetchedFeeRead<R> {
  let promise: Promise<R>;
  try {
    promise = Promise.resolve(read(...args));
  } catch (error) {
    promise = Promise.reject(error);
  }
  promise.catch(() => undefined);
  return { key: canonicalArgs(args), promise, used: false };
}

/** The first unused started read with these exact arguments, at most once each. */
function take<R>(reads: readonly PrefetchedFeeRead<R>[], args: readonly unknown[]): Promise<R> | null {
  const key = canonicalArgs(args);
  const read = reads.find((candidate) => !candidate.used && candidate.key === key);
  if (read === undefined) return null;
  read.used = true;
  return read.promise;
}

/** Argument identity independent of object key order. */
function canonicalArgs(args: readonly unknown[]): string {
  return JSON.stringify(args, (_key, value: unknown) => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)));
  });
}

export type LighterLifecycleTimingAction = "cancel_one" | "modify" | "cancel_all" | "close_position" | "oco";

type LighterLifecycleTimingPhase =
  | "secretMs"
  | "authMs"
  | "readsMs"
  | "partialMinimumReadsMs"
  | "revalidationMs"
  | "credentialMs"
  | "capitalMs"
  | "persistMs"
  | "childCheckMs"
  | "nonceReserveMs"
  | "signMs"
  | "sendMs";

/**
 * `[lighter-lifecycle-timing]`: one line per approved close, modify, cancel,
 * cancel-all or OCO execution, refused or sent, with numbers only beside the
 * action and intent id (no prices, keys, tokens or other ids), so the owner can
 * compare phases before and after a speed switch. `readsMs` runs from the first
 * revalidation read to the last read judged; `reconcileMs` from API acceptance
 * to the result. Purely observational: nothing here can change or fail an
 * action.
 */
export class LighterLifecycleTiming {
  private readonly startedAt = performance.now();
  private readonly started = new Map<LighterLifecycleTimingPhase, number>();
  private readonly durations = new Map<LighterLifecycleTimingPhase, number>();
  private apiAcceptedAt: number | null = null;
  private decisionToApiAcceptedMs: number | null = null;

  constructor(
    private readonly action: LighterLifecycleTimingAction,
    /** The resolved `LIGHTER_LIFECYCLE_PARALLEL_READS` value this execution runs with. */
    readonly parallelReads: boolean,
  ) {}

  start(phase: LighterLifecycleTimingPhase): void {
    this.started.set(phase, performance.now());
  }

  stop(phase: LighterLifecycleTimingPhase): void {
    const started = this.started.get(phase);
    if (started !== undefined) this.durations.set(phase, Math.round(performance.now() - started));
  }

  async measure<T>(phase: LighterLifecycleTimingPhase, run: () => Promise<T>): Promise<T> {
    this.start(phase);
    const value = await run();
    this.stop(phase);
    return value;
  }

  /** `decidedAt` is the approval instant the intent row carries, when it has one. */
  recordApiAccepted(decidedAt: string | null): void {
    this.apiAcceptedAt = performance.now();
    const parsed = decidedAt === null ? Number.NaN : Date.parse(decidedAt);
    this.decisionToApiAcceptedMs = Number.isFinite(parsed) ? Date.now() - parsed : null;
  }

  log(intentId: string): void {
    try {
      const now = performance.now();
      logger.info("[lighter-lifecycle-timing]", {
        action: this.action,
        intentId,
        parallelReads: this.parallelReads ? 1 : 0,
        apiAccepted: this.apiAcceptedAt === null ? 0 : 1,
        ...Object.fromEntries(this.durations),
        ...(this.apiAcceptedAt === null ? {} : { reconcileMs: Math.round(now - this.apiAcceptedAt) }),
        ...(this.decisionToApiAcceptedMs === null ? {} : { decisionToApiAcceptedMs: this.decisionToApiAcceptedMs }),
        totalMs: Math.round(now - this.startedAt),
      });
    } catch {
      // A log sink failure must never change an action's outcome.
    }
  }
}
