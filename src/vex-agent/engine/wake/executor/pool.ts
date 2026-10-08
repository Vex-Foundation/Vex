/**
 * The concurrent wake pool (Kairos S-3): claiming keeps going while slices run.
 *
 * The serial executor (`tick.ts`) claims one candidate, runs its whole slice,
 * and only then claims the next, so one slow slice holds every other
 * session's wake. The pool keeps up to `concurrency` slices in flight: a pass
 * lists the due candidates exactly like `tick` (mission rows, then session
 * rows) and STARTS each admissible one without awaiting its slice. Every slot
 * runs the same `runWakeCandidate` the serial pass runs, so the claim, the
 * lease, the banner, the release and the error reporting are unchanged.
 *
 * ## What is never run together
 *
 *   - Two slices of ONE SESSION. The session lease (Phase 3 claim tokens,
 *     taken inside the atomic claim under the session control lock) already
 *     guarantees it across processes; a second claim meets `lease_busy` or
 *     `run_active` and is deferred. The pool additionally never even TRIES a
 *     candidate whose session has a slice in flight here, so the lease-busy
 *     backoff (which pushes the row out by up to 60 s) is not spent on a wake
 *     the serial executor would simply have claimed after the slice.
 *   - Two slices whose sessions select ONE WALLET. The durable locks only
 *     cover narrow steps (EVM nonce allocation, the Lighter nonce CAS and
 *     capital admission); nothing spans a slice's balance read, preparation
 *     and broadcast. A candidate sharing a wallet key (`wallet-keys.ts`) with
 *     a slice in flight is left pending, untouched, and admitted by a later
 *     pass once that slice settles.
 *
 * A skipped candidate is only ever NOT CLAIMED: nothing is written, its row
 * stays pending and due, and crash safety is exactly the serial executor's:
 * each row is consumed only in the transaction that gives a runner its lease.
 *
 * If the wallet lookup fails the candidate is skipped too (fail closed) and
 * retried by the next pass.
 */

import type { LoopWakeRequest } from "@vex-agent/db/repos/loop-wake.js";
import logger from "@utils/logger.js";

import type { WakeDeps } from "./deps.js";
import { runWakeCandidate, type ClaimedWake } from "./tick.js";
import type { WalletKeysFor } from "./wallet-keys.js";

export interface WakePoolOptions {
  readonly concurrency: number;
  readonly limit: number;
  readonly deps: WakeDeps;
  readonly walletKeysFor: WalletKeysFor;
  /** Called once per started slice with its outcome. Must not throw. */
  readonly onSettled?: (result: ClaimedWake) => void;
}

export type WakePoolSkipReason = "session_in_flight" | "wallet_in_flight" | "wallet_lookup_failed";

export interface WakePoolPassResult {
  /** Candidates whose claim + slice this pass started. */
  readonly started: readonly LoopWakeRequest[];
  /** Candidates left pending, untouched, with the reason. */
  readonly skipped: readonly { readonly wake: LoopWakeRequest; readonly reason: WakePoolSkipReason }[];
}

export interface WakePool {
  /** List due candidates and start every admissible one. Never awaits a slice. */
  pass(now: Date): Promise<WakePoolPassResult>;
  /** Resolves once every slice in flight has settled. */
  drain(): Promise<void>;
  /** Slices in flight right now. */
  inFlightCount(): number;
}

interface InFlightSlice {
  readonly sessionId: string;
  readonly walletKeys: readonly string[];
  readonly settled: Promise<void>;
}

const EMPTY_PASS: WakePoolPassResult = { started: [], skipped: [] };

export function createWakePool(options: WakePoolOptions): WakePool {
  if (!Number.isSafeInteger(options.concurrency) || options.concurrency < 1) {
    throw new Error("wake pool: concurrency must be a positive integer");
  }
  const { concurrency, limit, deps, walletKeysFor, onSettled } = options;
  const inFlight = new Map<string, InFlightSlice>();

  const sessionBusy = (sessionId: string): boolean => {
    for (const slice of inFlight.values()) {
      if (slice.sessionId === sessionId) return true;
    }
    return false;
  };

  const walletBusy = (keys: readonly string[]): boolean => {
    if (keys.length === 0) return false;
    for (const slice of inFlight.values()) {
      if (slice.walletKeys.some((key) => keys.includes(key))) return true;
    }
    return false;
  };

  const start = (wake: LoopWakeRequest, walletKeys: readonly string[], now: Date): void => {
    const startedAt = Date.now();
    const settled = runWakeCandidate(wake, deps, now).then(
      (result) => {
        logger.info("wake.executor.slice_settled", {
          wakeId: wake.id,
          sessionId: wake.sessionId,
          outcome: result.outcome.kind,
          durationMs: Date.now() - startedAt,
        });
        try {
          onSettled?.(result);
        } catch {
          // An observer must never take a slot down with it.
        }
      },
      // `runWakeCandidate` reports every failure as an outcome; this only
      // guards the slot bookkeeping against the impossible.
      (err: unknown) => {
        logger.error("wake.executor.slice_rejected", {
          wakeId: wake.id,
          errorClass: err instanceof Error ? err.constructor.name : typeof err,
        });
      },
    ).finally(() => {
      inFlight.delete(wake.id);
    });
    inFlight.set(wake.id, { sessionId: wake.sessionId, walletKeys, settled });
  };

  return {
    async pass(now: Date): Promise<WakePoolPassResult> {
      // The same pre-claim provider gate as `tick`.
      if (!deps.isProviderReady()) return EMPTY_PASS;
      if (inFlight.size >= concurrency) return EMPTY_PASS;

      const candidates = [
        ...await deps.listDueMissionWakes(now, limit),
        ...await deps.listDueSessionWakes(now, limit),
      ];
      const started: LoopWakeRequest[] = [];
      const skipped: { wake: LoopWakeRequest; reason: WakePoolSkipReason }[] = [];

      for (const wake of candidates) {
        if (inFlight.size >= concurrency) break;
        // A row listed while its own claim is still in flight, or any other
        // row of a session that has a slice here.
        if (inFlight.has(wake.id) || sessionBusy(wake.sessionId)) {
          skipped.push({ wake, reason: "session_in_flight" });
          continue;
        }
        let walletKeys: readonly string[];
        try {
          walletKeys = await walletKeysFor(wake.sessionId);
        } catch (err) {
          logger.warn("wake.executor.wallet_lookup_failed", {
            wakeId: wake.id,
            sessionId: wake.sessionId,
            errorClass: err instanceof Error ? err.constructor.name : typeof err,
          });
          skipped.push({ wake, reason: "wallet_lookup_failed" });
          continue;
        }
        // Re-checked after the await: only this pass starts slices, but one
        // may have settled meanwhile, and the session check must see the
        // same state the wallet check does.
        if (inFlight.size >= concurrency) break;
        if (sessionBusy(wake.sessionId)) {
          skipped.push({ wake, reason: "session_in_flight" });
          continue;
        }
        if (walletBusy(walletKeys)) {
          logger.info("wake.executor.wallet_busy_skipped", {
            wakeId: wake.id,
            sessionId: wake.sessionId,
          });
          skipped.push({ wake, reason: "wallet_in_flight" });
          continue;
        }
        start(wake, walletKeys, now);
        started.push(wake);
      }
      return { started, skipped };
    },

    async drain(): Promise<void> {
      while (inFlight.size > 0) {
        await Promise.allSettled([...inFlight.values()].map((slice) => slice.settled));
      }
    },

    inFlightCount(): number {
      return inFlight.size;
    },
  };
}
