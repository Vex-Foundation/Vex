/**
 * ONE SHUTDOWN PARTICIPANT: named, bounded, logged, and unable to throw.
 *
 * The quit path is a sequence of participants (`index.ts`'s ordered quit task)
 * plus a set of concurrent ones (`cleanup-registry.ts`). Before this module
 * both were awaited unbounded, so a participant whose promise never settled
 * held `will-quit` open for as long as the process lived, `app.exit(0)` was
 * never reached, and the only evidence left behind was the log line of the
 * participant BEFORE the wedged one. That is exactly how the Playwright e2e
 * fixture's `app.close()` came to exceed a 120 s teardown budget while the
 * spec's own assertions had already passed.
 *
 * Two properties make a repeat of that diagnosable and survivable:
 *
 *  - THE DEADLINE IS ARMED BEFORE THE PARTICIPANT IS INVOKED. A `run()` that
 *    blocks before its first await, or returns a promise that never settles,
 *    is bounded either way, because the timer already exists when the race is
 *    constructed. A deadline created after the await is not a bound.
 *  - EVERY PARTICIPANT NAMES ITSELF, on the way in and on the way out, with
 *    its duration. A future hang is then a `begin <name>` with no `end`,
 *    rather than a silence whose owner has to be guessed.
 *
 * A participant that exceeds its deadline is NOT cancelled - this module has
 * no authority over another owner's work - it is abandoned: the quit continues
 * without it and the log says so. The participant's own cleanup remains its
 * own responsibility.
 */

import { log as defaultLog } from "../logger/index.js";

/** How a participant left. `timed_out` means it was abandoned, not cancelled. */
export type QuitStageStatus = "done" | "failed" | "timed_out";

export interface QuitStageOutcome {
  readonly name: string;
  readonly status: QuitStageStatus;
  readonly durationMs: number;
}

/** Injected so the unit tests can drive the clock and read the log lines. */
export interface QuitStageDeps {
  readonly log: {
    info(...args: unknown[]): void;
    warn(...args: unknown[]): void;
    error(...args: unknown[]): void;
  };
  readonly now: () => number;
}

const productionDeps: QuitStageDeps = { log: defaultLog, now: () => Date.now() };

/**
 * The slack a stage's backstop adds on top of a participant that already owns
 * an honest internal bound. The backstop must never be the thing that cuts a
 * participant's own budget short; it exists for the case where that budget was
 * not respected at all.
 */
export const QUIT_STAGE_SLACK_MS = 1_000;

/**
 * The whole quit's backstop, applied to `globalCleanup.runAll()`.
 *
 * Past this the process exits with whatever is still unfinished abandoned and
 * NAMED in the log. Chosen so a user never waits longer than this to close the
 * app, and so an automated `app.close()` always returns: nothing on the quit
 * path commits money or durable authority after this point - the Studio
 * refusal pass, the terminal snapshots and the secret scrub all run earlier in
 * the ordered task, and a compose project left running is reconciled by
 * `cleanupOnBoot` on the next launch.
 */
export const QUIT_TOTAL_DEADLINE_MS = 45_000;

/** The default backstop for a cleanup task that does not state its own. */
export const QUIT_TASK_DEADLINE_MS = 5_000;

/**
 * The ordered quit task's budget, deliberately BELOW {@link QUIT_TOTAL_DEADLINE_MS}
 * so that when the sequence is the thing that wedged, the log carries the
 * ordered task's own timeout line - naming it - before the whole-quit backstop
 * fires.
 */
export const ORDERED_QUIT_DEADLINE_MS = 40_000;

/**
 * `docker compose stop` against a live Postgres is the one quit participant
 * that is legitimately slow: the database gets its own shutdown checkpoint.
 * The largest single budget on the quit path, and still bounded.
 */
export const COMPOSE_QUIT_DEADLINE_MS = 20_000;

/**
 * Run one shutdown participant under its own deadline.
 *
 * Never rejects: a participant that throws is reported as `failed` and the
 * quit continues, because one broken owner must not strand the user in an app
 * that cannot close.
 *
 * `run` may return anything - several participants answer with a count or a
 * handle - and the value is deliberately discarded: a quit stage is judged by
 * whether it FINISHED, not by what it returned.
 */
export async function runQuitStage(
  name: string,
  deadlineMs: number,
  run: () => unknown,
  deps: QuitStageDeps = productionDeps,
): Promise<QuitStageOutcome> {
  const started = deps.now();
  deps.log.info(`[quit] begin ${name} deadlineMs=${String(deadlineMs)}`);

  // ARMED FIRST, on purpose. See the file header.
  let releaseDeadline: () => void = () => undefined;
  const deadline = new Promise<"timed_out">((resolve) => {
    releaseDeadline = () => {
      resolve("timed_out");
    };
  });
  const timer = setTimeout(() => {
    releaseDeadline();
  }, deadlineMs);

  let status: QuitStageStatus;
  try {
    status = await Promise.race([
      (async (): Promise<"done"> => {
        await run();
        return "done";
      })(),
      deadline,
    ]);
  } catch (cause: unknown) {
    status = "failed";
    deps.log.error(`[quit] failed ${name}`, cause);
  } finally {
    clearTimeout(timer);
    // The deadline promise has one consumer and no other owner; resolving it
    // keeps a late awaiter from parking on a timer that is already cleared.
    releaseDeadline();
  }

  const durationMs = deps.now() - started;
  if (status === "timed_out") {
    deps.log.warn(
      `[quit] TIMED OUT ${name} after ${String(durationMs)}ms; `
        + "abandoning it and continuing the quit",
    );
  } else {
    deps.log.info(
      `[quit] end ${name} status=${status} durationMs=${String(durationMs)}`,
    );
  }
  return { name, status, durationMs };
}
