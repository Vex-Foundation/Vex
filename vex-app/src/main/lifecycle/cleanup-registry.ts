/**
 * CleanupRegistry per skill §11.
 *
 * Every external handle is a lease — timers, streams, IPC listeners, Docker logs,
 * pg clients, BrowserWindow refs. Each registers an idempotent cleanup task.
 * runAll() invoked on app quit; failures don't block other cleanups.
 *
 * EVERY TASK CARRIES A NAME AND A DEADLINE. The tasks run concurrently, so one
 * unbounded task used to hold `will-quit` open with nothing in the log to say
 * which one it was. A task that exceeds its deadline is abandoned and named;
 * the remaining tasks still settle.
 */

import { log } from "../logger/index.js";
import { QUIT_TASK_DEADLINE_MS, runQuitStage, type QuitStageOutcome } from "./quit-stage.js";

type Cleanup = () => void | Promise<void>;

interface Registration {
  readonly task: Cleanup;
  readonly name: string;
  readonly deadlineMs: number;
}

export interface CleanupTaskOptions {
  /**
   * This task's own budget. State one only when the task legitimately needs
   * longer than {@link QUIT_TASK_DEADLINE_MS}; the number belongs to the owner
   * that knows what the task waits for.
   */
  readonly deadlineMs?: number;
}

export class CleanupRegistry {
  private readonly tasks = new Set<Registration>();
  private running = false;

  /**
   * @param name identifies this task in the quit log. A hang names itself
   *   through it, so it is the owner's name and not the call site's shape.
   */
  add(task: Cleanup, name: string, options: CleanupTaskOptions = {}): () => Promise<void> {
    const registration: Registration = {
      task,
      name,
      deadlineMs: options.deadlineMs ?? QUIT_TASK_DEADLINE_MS,
    };
    this.tasks.add(registration);
    return async () => {
      this.tasks.delete(registration);
      await task();
    };
  }

  async runAll(): Promise<void> {
    if (this.running) return;
    this.running = true;
    const snapshot = [...this.tasks];
    this.tasks.clear();
    log.info(`[quit] cleanup registry: running ${String(snapshot.length)} tasks`);
    const started = Date.now();
    // `runQuitStage` never rejects, so `Promise.all` here settles exactly when
    // every task has finished, timed out, or failed - and each one has already
    // reported which of the three it was.
    const outcomes: QuitStageOutcome[] = await Promise.all(
      snapshot.map((entry) =>
        runQuitStage(`cleanup:${entry.name}`, entry.deadlineMs, entry.task),
      ),
    );
    this.running = false;
    const unfinished = outcomes.filter((outcome) => outcome.status !== "done");
    log.info(
      `[quit] cleanup registry: ${String(outcomes.length)} tasks in `
        + `${String(Date.now() - started)}ms; unfinished=`
        + (unfinished.length === 0
          ? "none"
          : unfinished.map((outcome) => `${outcome.name}(${outcome.status})`).join(", ")),
    );
  }

  size(): number {
    return this.tasks.size;
  }
}

export const globalCleanup = new CleanupRegistry();
