/**
 * Pending-activity FAST LANE (Wave P) — the real-time half of the
 * pending-transaction resolver.
 *
 * ## What problem this solves
 *
 * The global sweeps (`agent-activity-repair.ts`, `solana-activity-repair.ts`,
 * `bridge-activity-repair.ts`) are periodic and fair: they rotate a bounded
 * window over every pending row so nothing starves. That makes them an
 * excellent SAFETY NET and a poor real-time resolver — a freshly abandoned row
 * waits for the 30 s executor tick floor plus whatever work is queued ahead of
 * it, and the bridge job only fires every 120 s.
 *
 * The fast lane is the complement, not the replacement: when a broadcast is
 * accepted, the repo CAS emits `armed` on `pending-activity-bus`, and this
 * module watches THAT ROW specifically until it terminalizes. The sweeps keep
 * running untouched and still own every row the fast lane never saw, dropped, or
 * aged out.
 *
 * ## It duplicates NO terminality policy
 *
 * Every question is asked through the sweeps' own extracted per-row resolvers —
 * `resolveEvmPendingRow` and `resolveSolanaPendingRows` — using the sweeps' own
 * production deps. This module decides only WHEN to look. What an observation
 * MEANS stays in exactly one place, because a second implementation of "may this
 * observation terminalize a money row" is precisely the thing that drifts.
 *
 * ## THE 90 s GATE IS PRESERVED, NOT DELETED
 *
 * `REPAIR_CANDIDATE_AGE_MS` exists because a broadcast handler spends the first
 * seconds after submit decoding its own receipt, and a status-only confirm that
 * wins the CAS against that in-flight strict confirm permanently forfeits the
 * executed amounts — a money-truth regression, not a latency win. So an EVM
 * lane's FIRST check is scheduled at the gate rather than before it (cheaper
 * than looking and discarding), and a hard guard re-checks the row's own
 * `submit_attempted_at` immediately before resolution, which also covers lanes
 * re-armed from the DB at startup. Solana carries no such gate — its sweep never
 * had one, because a Solana handler does not decode amounts from a receipt.
 *
 * The win is therefore determinism, not gate-jumping: an abandoned EVM row
 * resolves at ~90-102 s instead of 90-135 s, and a Solana row within ~12 s.
 *
 * ## Load discipline
 *
 * - one wheel timer, not one timer per lane;
 * - per-lane jitter so N lanes never fire in lockstep against one RPC;
 * - the EVM lane bounds its own in-flight lookups (`EVM_LANE_MAX_CONCURRENCY`,
 *   `agent-activity-repair.ts`) because the DB pool is `max: 10` and the sweeps
 *   share it;
 * - Solana lanes coalesce into ONE `getSignatureStatuses` per cycle;
 * - EVM lanes share one memoized per-chain client per cycle;
 * - provider-status legs (Khalani/Relay) run at 30 s, NOT 12 s, and as one
 *   bounded sweep run rather than per-lane polls — a 12 s per-row provider poll
 *   would multiply bridge API load roughly tenfold;
 * - `FAST_LANE_MAX_ACTIVE` caps the registry. Overflow is NOT an error and the
 *   row is NOT dropped: it simply is not armed, and the global sweep owns it
 *   exactly as it did before this module existed.
 */

import {
  listPendingByIds,
  listPendingOlderThan,
  listPendingProviderLogical,
  type AgentActivityEvent,
} from "@vex-agent/db/repos/agent-activity.js";
import {
  pendingActivityBus,
  type PendingActivityChainFamily,
  type PendingActivityEvent,
  type PendingActivityLane,
} from "@vex-agent/events/pending-activity-bus.js";
import { describeFailureForLog } from "@vex-agent/tools/protocols/runtime/errors.js";
import logger from "@utils/logger.js";

// ── Tunables ──────────────────────────────────────────────────────────────

/** On-chain verification cadence — the owner's 10-15 s real-time window. */
export const FAST_LANE_INTERVAL_MS = 12_000;

/** ± jitter applied to every lane's next due time, so lanes never fire in lockstep. */
export const FAST_LANE_JITTER_MS = 2_000;

/**
 * Provider-status cadence (Khalani/Relay order status), deliberately SLOWER than
 * the on-chain leg. Coordinator ruling: 12 s against a bridge provider would
 * multiply that API's load by ~10 for no verification benefit, because the
 * forever-pending bridge stall is an on-chain verification problem
 * (`no_safe_rpc`, `receipt_unavailable`), not a provider-poll problem.
 */
export const FAST_LANE_PROVIDER_INTERVAL_MS = 30_000;

/** After this, hand the row back to the global sweep — it is no longer "fresh". */
export const FAST_LANE_MAX_AGE_MS = 15 * 60_000;

/** Rows tracked at once. Overflow falls back to the sweep, which is built to absorb it. */
export const FAST_LANE_MAX_ACTIVE = 12;

/** How often the wheel wakes to look for due lanes. */
const WHEEL_INTERVAL_MS = 2_000;

// ── Lane state ────────────────────────────────────────────────────────────

/**
 * Which leg resolves this row — the bus's own discriminator, set by the arming
 * CAS. This module NEVER re-derives it: the logical bridge row carries a
 * non-null DESTINATION chain id, so any payload-shaped inference routes it into
 * the on-chain leg, which then disarms it for lacking a hash it can never have.
 */
type LaneLeg = PendingActivityLane;

interface Lane {
  readonly activityId: number;
  readonly chainFamily: PendingActivityChainFamily;
  readonly leg: LaneLeg;
  readonly armedAt: number;
  nextDueAt: number;
  attempts: number;
}

export interface FastLaneHandle {
  /** Unsubscribe from the bus, stop the wheel, and clear every lane. */
  stop(): void;
  /** Lanes currently armed — for tests and diagnostics. */
  size(): number;
}

/**
 * The external reads a fast-lane cycle may perform. Every one is satisfied in
 * production by the corresponding SWEEP's own module, so the fast lane holds no
 * provider knowledge and — like the sweeps — no signer, ever.
 */
export interface FastLaneDeps {
  /**
   * Run ONE pass of the EVM pending lane — a claim of every DUE row, wherever it
   * came from, whether or not this process ever armed a lane for it.
   *
   * Deliberately NOT a per-row call. The registry used to read its own armed ids
   * through a non-claiming query, which meant the registry and the sweep could
   * observe the same row concurrently, and a row this process never saw (a
   * restart, an overflowed registry) had no fast owner at all. The claimant is
   * the single scheduler: its SQL due predicate IS the cadence contract.
   */
  readonly runEvmPendingLane: () => Promise<void>;
  /** Resolve due Solana lanes as ONE batched call. */
  readonly resolveSolanaRows: (rows: readonly AgentActivityEvent[]) => Promise<void>;
  /** Run one bounded bridge provider sweep. Called at most once per provider interval. */
  readonly runBridgeSweep: () => Promise<void>;
}

// ── Public entry point ────────────────────────────────────────────────────

export interface FastLaneOptions {
  readonly deps?: FastLaneDeps;
  /** Test seam: deterministic "jitter". Defaults to `Math.random`. */
  readonly random?: () => number;
}

/**
 * Start the fast lane. Owned by `startSyncExecutor`, which is what keeps the
 * "the sync layer owns real-time resolution, the turn loop does not" decision
 * structurally true: the turn loop holds no reference to this and cannot be
 * blocked by it.
 */
export function startFastLane(options: FastLaneOptions = {}): FastLaneHandle {
  const deps = options.deps ?? buildProductionFastLaneDeps();
  const random = options.random ?? Math.random;
  const lanes = new Map<number, Lane>();

  let stopped = false;
  let cycleInFlight = false;
  let lastProviderRunAt = 0;

  const jitteredNextDue = (intervalMs: number): number =>
    Date.now() + intervalMs + Math.round((random() * 2 - 1) * FAST_LANE_JITTER_MS);

  const arm = (
    activityId: number,
    chainFamily: PendingActivityChainFamily,
    leg: LaneLeg,
    armedAt: number,
  ): void => {
    if (stopped) return;
    // EVM ON-CHAIN ROWS ARE NOT REGISTRY WORK ANY MORE. The claimant observes
    // every due EVM row every cycle, from age zero, whether or not it was ever
    // armed — so a lane here would be a second owner with a weaker guarantee
    // (capped at 12, lost on restart, and reading through a NON-claiming query
    // that let it race the sweep on the same row). The bus event still matters
    // for `resolved`: that is what disarms and enqueues the snapshot.
    if (leg === "onchain" && chainFamily === "eip155") return;
    // Per-row dedup: a second arm for the same row is a no-op, mirroring the
    // sweeps' `duplicate_cas_miss` posture.
    if (lanes.has(activityId)) return;
    if (lanes.size >= FAST_LANE_MAX_ACTIVE) {
      // NOT an error and NOT a dropped row — the row is in the DB and the global
      // sweep owns it, which is exactly the state of the world before this
      // module existed.
      logger.debug("sync.fast_lane.capacity_reached", { activityId, active: lanes.size });
      return;
    }
    // Solana has no handler window to respect; the bridge provider leg starts at
    // its own slower interval.
    const firstDelayMs = leg === "provider"
      ? FAST_LANE_PROVIDER_INTERVAL_MS
      : FAST_LANE_INTERVAL_MS;
    lanes.set(activityId, {
      activityId,
      chainFamily,
      leg,
      armedAt,
      nextDueAt: Date.now() + firstDelayMs,
      attempts: 0,
    });
  };

  const onBusEvent = (event: PendingActivityEvent): void => {
    if (event.kind === "resolved") {
      // Disarm on terminalization — whoever won, the row is done.
      lanes.delete(event.activityId);
      void enqueueSnapshotAfterTerminalization(event.activityId);
      return;
    }
    arm(event.activityId, event.chainFamily, event.lane, Date.now());
  };

  const unsubscribe = pendingActivityBus.subscribe(onBusEvent);

  const runCycle = async (): Promise<void> => {
    if (stopped || cycleInFlight) return;
    cycleInFlight = true;
    try {
      await executeCycle();
    } catch (err) {
      logger.warn("sync.fast_lane.cycle_failed", {
        // THE CANONICAL SCRUB BOUNDARY, not `err.message`. A cycle failure is
        // the one place in this module where a PROVIDER error reaches a log, and
        // a raw provider message can carry the RPC URL, its embedded
        // credentials, an Authorization header and a response body — none of
        // which `redact()`'s secret-SHAPE detection alone removes.
        error: describeFailureForLog(err),
      });
    } finally {
      cycleInFlight = false;
    }
  };

  const executeCycle = async (): Promise<void> => {
    const now = Date.now();

    // THE EVM LANE IS REGISTRY-INDEPENDENT. It runs every cycle and claims
    // whatever SQL says is due, so a restart with an empty registry, a row that
    // overflowed `FAST_LANE_MAX_ACTIVE`, and a row this process never armed all
    // still hold their cadence. The claim's phase interval — 5 s for the row's
    // first 10 minutes, then 30 s, measured from its own immutable
    // `submit_attempted_at` — is the whole schedule; the wheel only decides how
    // often we ASK, which is why it ticks faster than the shortest interval.
    await deps.runEvmPendingLane();

    // Age-out first: a lane older than the max age is no longer "fresh", and the
    // global sweep is the right owner for a long-lived stuck row.
    for (const lane of [...lanes.values()]) {
      if (now - lane.armedAt >= FAST_LANE_MAX_AGE_MS) {
        logger.info("sync.fast_lane.aged_out", {
          activityId: lane.activityId,
          attempts: lane.attempts,
          hint: "handed back to the global sweep — never auto-failed",
        });
        lanes.delete(lane.activityId);
      }
    }

    const due = [...lanes.values()].filter((lane) => lane.nextDueAt <= now);
    if (due.length === 0) return;

    for (const lane of due) {
      lane.attempts++;
      lane.nextDueAt = jitteredNextDue(
        lane.leg === "provider" ? FAST_LANE_PROVIDER_INTERVAL_MS : FAST_LANE_INTERVAL_MS,
      );
    }

    await runSolanaLeg(due);
    await runProviderLeg(due, now);
  };

  const runSolanaLeg = async (due: readonly Lane[]): Promise<void> => {
    const solanaIds = due.filter((l) => l.leg === "onchain" && l.chainFamily === "solana")
      .map((l) => l.activityId);

    if (solanaIds.length > 0) {
      const rows = await listPendingByIds(solanaIds, "solana");
      disarmVanished(solanaIds, rows);
      if (rows.length > 0) await deps.resolveSolanaRows(rows);
    }
  };

  const runProviderLeg = async (due: readonly Lane[], now: number): Promise<void> => {
    if (!due.some((lane) => lane.leg === "provider")) return;
    if (now - lastProviderRunAt < FAST_LANE_PROVIDER_INTERVAL_MS) return;
    lastProviderRunAt = now;
    // ONE bounded sweep run for every due bridge lane, not one poll per lane.
    // The sweep already batches, orders fairly, and caps itself; calling it more
    // often is a 4x cadence change (120 s → 30 s), where per-lane polling would
    // have been a ~10x load change.
    await deps.runBridgeSweep();
  };

  /** A row that is no longer pending (or no longer has a staged hash) has been resolved by someone else. */
  const disarmVanished = (
    requestedIds: readonly number[],
    stillPending: readonly AgentActivityEvent[],
  ): void => {
    const alive = new Set(stillPending.map((row) => row.id));
    for (const id of requestedIds) {
      if (!alive.has(id)) lanes.delete(id);
    }
  };

  const timer = setInterval(() => {
    void runCycle();
  }, WHEEL_INTERVAL_MS);
  // The wheel must never hold the process open on its own.
  timer.unref?.();

  logger.info("sync.fast_lane.started", {
    intervalMs: FAST_LANE_INTERVAL_MS,
    providerIntervalMs: FAST_LANE_PROVIDER_INTERVAL_MS,
    maxActive: FAST_LANE_MAX_ACTIVE,
  });

  return {
    stop(): void {
      stopped = true;
      clearInterval(timer);
      unsubscribe();
      lanes.clear();
      logger.info("sync.fast_lane.stopped");
    },
    size(): number {
      return lanes.size;
    },
  };
}

// ── Post-terminalization snapshot ─────────────────────────────────────────

/**
 * Enqueue the `balances_snapshot` job for a row that just terminalized.
 *
 * ONE enqueue site, driven by the bus, rather than a hook in each of the three
 * sweeps plus every venue handler: the `resolved` event already fires from the
 * repo CAS for EVERY terminalization path, so this covers the handler's own
 * confirm, the fast lane, and all three global sweeps identically.
 *
 * Keyed by the row's `protocol_execution_id`, so migration 046's partial unique
 * index `idx_sync_runs_execution_dedup` collapses a duplicate enqueue for free —
 * a multi-leg execution whose legs terminalize one after another produces ONE
 * snapshot run, not one per leg.
 *
 * Best-effort by design: a failure here must never propagate into a CAS write's
 * caller. The periodic 300 s `balances` job remains the safety net, exactly as
 * before this wave.
 */
async function enqueueSnapshotAfterTerminalization(activityId: number): Promise<void> {
  try {
    const [{ getActivityEventById }, syncRepo] = await Promise.all([
      import("@vex-agent/db/repos/agent-activity.js"),
      import("@vex-agent/db/repos/sync.js"),
    ]);
    const row = await getActivityEventById(activityId);
    if (!row) return;
    const jobs = await syncRepo.getJobsForNamespace("_global");
    const job = jobs.find((candidate) => candidate.syncType === "balances_snapshot");
    if (!job) return;
    await syncRepo.enqueueRun(job.id, row.protocolExecutionId);
  } catch (err) {
    if (isUniqueViolation(err)) {
      // THE DEDUP WORKING, not a failure: migration 046's partial unique index
      // rejected a second enqueue for an execution that already has one pending.
      logger.debug("sync.fast_lane.snapshot_enqueue_deduped", { activityId });
      return;
    }
    logger.warn("sync.fast_lane.snapshot_enqueue_failed", {
      activityId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Postgres `unique_violation` (23505) — the shape migration 046's dedup index produces. */
function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null
    && (err as { code?: unknown }).code === "23505";
}

// ── Crash recovery ────────────────────────────────────────────────────────

/**
 * Re-arm lanes for rows that were already in flight when the process died.
 *
 * Called from `initSync`. Without it, a crash-restart silently drops every
 * in-flight fast lane and every one of those rows waits for the global sweep —
 * i.e. exactly the latency this wave exists to remove, on exactly the rows most
 * likely to be abandoned.
 *
 * TWO CANDIDATE SETS, because the two lanes have disjoint candidate predicates:
 *
 * - ON-CHAIN — the SWEEP's own `listPendingOlderThan` with a zero age bound:
 *   same fairness ordering, same "must have a staged hash" predicate, no new
 *   query to keep correct. Freshness is measured from `submit_attempted_at`.
 * - PROVIDER — `listPendingProviderLogical`, the bounded logical
 *   `bridge_fill_expected` set. Those rows have NO hash and NO
 *   `submit_attempted_at` — reusing the on-chain query would return none of
 *   them, which is precisely why the provider lane never survived a restart.
 *   Their freshness is measured from `created_at`, the only submission-shaped
 *   timestamp a not-yet-filled expectation has.
 *
 * The 90 s gate still applies at on-chain resolution time, so re-arming a row
 * younger than the gate is safe.
 *
 * THE RETURN IS LANES ACCEPTED, NOT CANDIDATES EMITTED. Arming goes through the
 * bus, so the registry may decline a candidate under its cap or its per-row
 * dedup — both normal, neither an error. Counting emissions overstated the
 * recovery: a restart that armed nothing because the cap was already full would
 * still report "12 re-armed", which is the wrong signal at exactly the moment
 * the cap is under pressure. `activeLaneCount` is the running registry's own
 * `size()`, injected by the caller that owns the handle; without it the count
 * falls back to candidates emitted, which is all a caller with no registry can
 * honestly know.
 */
export async function rearmPendingFastLanes(
  activeLaneCount?: () => number,
): Promise<number> {
  const before = activeLaneCount?.() ?? 0;
  let emitted = 0;
  // SOLANA ONLY. EVM pending rows no longer need re-arming at all: their
  // schedule lives in the durable claim, which selects every due row from the
  // database on the first cycle after a restart — including rows this process
  // has never seen. Re-arming them would create a second, weaker owner for
  // exactly the rows the claim already covers.
  for (const row of await listPendingOlderThan(0, FAST_LANE_MAX_ACTIVE, "solana")) {
    if (!isWithinFastLaneAge(row.submitAttemptedAt)) continue;
    emitRearm(row, "onchain");
    emitted++;
  }

  for (const row of await listPendingProviderLogical(FAST_LANE_MAX_ACTIVE)) {
    if (!isWithinFastLaneAge(row.createdAt)) continue;
    emitRearm(row, "provider");
    emitted++;
  }

  const armed = activeLaneCount ? activeLaneCount() - before : emitted;
  if (emitted > 0) logger.info("sync.fast_lane.rearmed", { rows: armed, candidates: emitted });
  return armed;
}

/**
 * Re-arming goes THROUGH THE BUS rather than through a private registry call, so
 * the cap, the dedup and the scheduling rules are the same ones a live broadcast
 * gets. There is exactly one arming path.
 */
function emitRearm(row: AgentActivityEvent, lane: LaneLeg): void {
  pendingActivityBus.emit({
    type: "sync.activity.pending",
    kind: "armed",
    activityId: row.id,
    chainFamily: row.chainFamily,
    chainId: row.chainId,
    lane,
    status: null,
    occurredAt: new Date().toISOString(),
  });
}

/** Still "fresh" enough for the fast lane, measured from the lane's own submission-shaped timestamp. */
function isWithinFastLaneAge(startedAt: string | null): boolean {
  if (!startedAt) return false;
  const startedMs = Date.parse(startedAt);
  if (Number.isNaN(startedMs)) return false;
  return Date.now() - startedMs < FAST_LANE_MAX_AGE_MS;
}

// ── Gate ──────────────────────────────────────────────────────────────────

// The 90 s money gate lives in its own leaf (`./handler-window.js`) because the
// pending lane needs the same predicate, and a copy in each module is how two
// money gates drift apart. Re-exported here so every existing caller's import is
// unchanged.
export { isPastHandlerWindow, REPAIR_CANDIDATE_AGE_MS } from "./handler-window.js";

// ── Production wiring ─────────────────────────────────────────────────────

/**
 * Every dep delegates to the corresponding SWEEP's own resolver and production
 * deps, built ONCE PER CYCLE so the per-chain client memo and the Solana
 * genesis health check are shared across every lane in that cycle — the same
 * economics the sweeps already get per run.
 */
export function buildProductionFastLaneDeps(): FastLaneDeps {
  return {
    runEvmPendingLane: async () => {
      const { repairPendingActivity, buildProductionRepairDeps } =
        await import("./agent-activity-repair.js");
      await repairPendingActivity(buildProductionRepairDeps());
    },

    resolveSolanaRows: async (rows) => {
      const { resolveSolanaPendingRows, buildProductionSolanaRepairDeps } =
        await import("./solana-activity-repair.js");
      // ONE batched `getSignatureStatuses` for the whole cycle — no semaphore
      // needed, because this is a single round trip regardless of lane count.
      await resolveSolanaPendingRows(rows, buildProductionSolanaRepairDeps(), Date.now());
    },

    runBridgeSweep: async () => {
      const { repairPendingBridges, buildProductionBridgeRepairDeps } =
        await import("./bridge-activity-repair.js");
      await repairPendingBridges(buildProductionBridgeRepairDeps());
    },
  };
}
