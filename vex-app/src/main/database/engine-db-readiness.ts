/**
 * THE ONE OWNER of "is the engine's database usable in this process yet?".
 *
 * ## Why it exists
 *
 * The engine's pool is lazy and reads `process.env.VEX_DB_URL` at first use;
 * with that variable unset it falls back to a development URL
 * (`src/vex-agent/db/client.ts`) and every query fails against a database
 * nobody runs. So main must POINT the pool at the compose-managed Postgres
 * before any engine code touches it. That fact used to be resolved lazily by
 * whichever caller happened to need it first, from two copy-pasted
 * implementations (`ipc/runtime/_ensure-engine-db-url.ts` and
 * `ipc/chat/engine-db-url.ts`), which meant a caller that ran BEFORE any of
 * them - the unlock's Studio generation advance - silently used the fallback.
 *
 * ## The two facts, and why waiting is a first-class operation
 *
 * A start-up consumer needs more than "the URL resolves": it needs the schema
 * this build ships. Those are two separate facts and they arrive in this order:
 *
 *   1. THE URL. `buildPoolConfig()` answers only after compose has written its
 *      connection state and password file, which on a cold start happens when
 *      the renderer asks for Docker - ten to twenty seconds after `whenReady`.
 *   2. THE MIGRATIONS. `migrationsApplied()` (see `migrations-applied.ts`) is
 *      the process-wide latch the migrate runner sets.
 *
 * `whenEngineDbReady` waits for BOTH and NEVER gives up on its own. A boot-time
 * consumer that gave up after a fixed number of attempts would be deciding, on
 * the user's behalf, that a database which is merely slow to come up is a
 * database that is never coming - which is exactly the defect that left Vex
 * Studio unavailable for a whole session on a machine where Docker took 15 s.
 * The only way out of the wait is the caller's own `AbortSignal`, which its
 * lifecycle owner aborts at teardown.
 *
 * ## Ownership of the poll
 *
 * ONE timer for the whole process, shared by every waiter (single-flight), held
 * in a module binding so it can actually be cleared rather than merely
 * neutered, `unref`'d so a wait never holds the process open, and stopped the
 * moment the last waiter resolves or aborts. Each waiter owns exactly one abort
 * listener and removes it on settlement.
 */

import { URL } from "node:url";
import { err, ok, type Result, type VexError } from "@shared/ipc/result.js";
import { log } from "../logger/index.js";
import { buildPoolConfig } from "./db-config.js";
import { migrationsApplied } from "./migrations-applied.js";

/** Default cadence of the readiness poll. */
const DEFAULT_POLL_MS = 1_000;

/**
 * Whether `ensureEngineDbUrl` has successfully pointed the engine pool at the
 * app-managed Postgres in this process. Written only by a successful ensure.
 */
let engineDbUrlApplied = false;

/** Rejection handed to a waiter whose owner aborted the wait. */
export class EngineDbWaitAbortedError extends Error {
  constructor() {
    super("engine database wait aborted");
    this.name = "EngineDbWaitAbortedError";
  }
}

export function engineDbUnavailableError(correlationId: string): VexError {
  return {
    code: "internal.unexpected",
    domain: "database",
    message: "Database unavailable. Verify services are running and retry.",
    retryable: true,
    userActionable: true,
    redacted: true,
    correlationId,
  };
}

function makePostgresUrl(args: {
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly user: string;
  readonly password: string;
}): string {
  const url = new URL(`postgresql://${args.host}:${args.port}/${args.database}`);
  url.username = args.user;
  url.password = args.password;
  return url.toString();
}

/**
 * Point the engine's lazy pool at the app-managed Postgres.
 *
 * Mutates `process.env.VEX_DB_URL` and recycles the pool when the resolved URL
 * differs from the one already in effect; `closePool` is idempotent, so
 * concurrent callers converge on the same URL and at most one drain.
 *
 * The pool module is reached through a DYNAMIC import, and only on the path
 * that actually recycles it. This module is now read at BOOT - the settlement
 * bridge and the secret session both wait on it - and a static import would put
 * `pg` into main's load path, which is exactly what the bridge's own dynamic
 * imports exist to avoid.
 */
export async function ensureEngineDbUrl(
  correlationId: string,
): Promise<Result<void, VexError>> {
  try {
    const cfg = await buildPoolConfig();
    if (cfg === null) return err(engineDbUnavailableError(correlationId));
    const nextUrl = makePostgresUrl(cfg);
    if (process.env.VEX_DB_URL === nextUrl) {
      engineDbUrlApplied = true;
      return ok(undefined);
    }
    process.env.VEX_DB_URL = nextUrl;
    const { closePool } = await import("@vex-agent/db/client.js");
    await closePool();
    engineDbUrlApplied = true;
    log.info(
      `[engine-db] engine database connection refreshed correlationId=${correlationId}`,
    );
    return ok(undefined);
  } catch {
    return err(engineDbUnavailableError(correlationId));
  }
}

/**
 * Both facts, without touching the filesystem: the URL has been applied at
 * least once in this process AND the migrate runner reported success.
 */
export function isEngineDbReady(): boolean {
  return engineDbUrlApplied && migrationsApplied();
}

interface EngineDbWaiter {
  readonly resolve: () => void;
  readonly reject: (cause: Error) => void;
  readonly detach: () => void;
}

const waiters = new Set<EngineDbWaiter>();
let pollTimer: NodeJS.Timeout | null = null;
let pollInFlight = false;
let loggedWaiting = false;
let loggedReady = false;

function stopPollWhenIdle(): void {
  if (waiters.size > 0) return;
  if (pollTimer === null) return;
  clearInterval(pollTimer);
  pollTimer = null;
}

function settleReady(): void {
  if (!loggedReady) {
    loggedReady = true;
    log.info("[engine-db] engine database ready");
  }
  const settling = [...waiters];
  waiters.clear();
  stopPollWhenIdle();
  for (const waiter of settling) {
    waiter.detach();
    waiter.resolve();
  }
}

async function pollOnce(): Promise<void> {
  if (pollInFlight) return;
  pollInFlight = true;
  try {
    if (waiters.size === 0) return;
    if (!isEngineDbReady()) {
      await ensureEngineDbUrl("engine-db-readiness");
      if (waiters.size === 0) return;
      if (!isEngineDbReady()) return;
    }
    settleReady();
  } finally {
    pollInFlight = false;
  }
}

function ensurePollTimer(pollMs: number): void {
  if (pollTimer !== null) return;
  const timer = setInterval(() => {
    void pollOnce();
  }, pollMs);
  // A readiness wait must never hold the process open by itself.
  timer.unref?.();
  pollTimer = timer;
}

/**
 * Resolve once the engine database is usable: the URL is applied AND the
 * migrations this build ships have run.
 *
 * Never rejects for slowness - only for the caller's own abort, with
 * `EngineDbWaitAbortedError`. An already-aborted signal rejects without
 * arming anything.
 */
export function whenEngineDbReady(
  options: { readonly signal?: AbortSignal; readonly pollMs?: number } = {},
): Promise<void> {
  const { signal } = options;
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  if (signal?.aborted === true) {
    return Promise.reject(new EngineDbWaitAbortedError());
  }
  if (isEngineDbReady()) return Promise.resolve();
  if (!loggedWaiting) {
    loggedWaiting = true;
    log.info("[engine-db] waiting for the database");
  }
  return new Promise<void>((resolve, reject) => {
    let detached = false;
    const onAbort = (): void => {
      waiters.delete(waiter);
      waiter.detach();
      stopPollWhenIdle();
      reject(new EngineDbWaitAbortedError());
    };
    const waiter: EngineDbWaiter = {
      resolve,
      reject,
      detach: () => {
        if (detached) return;
        detached = true;
        signal?.removeEventListener("abort", onAbort);
      },
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    waiters.add(waiter);
    ensurePollTimer(pollMs);
    // The first probe happens now rather than one interval later: on a warm
    // start the database is already up and the caller should not pay a second.
    void pollOnce();
  });
}

/** Test seam: forget the applied URL, the waiters, the timer and the logs. */
export function resetEngineDbReadinessForTests(): void {
  for (const waiter of [...waiters]) {
    waiters.delete(waiter);
    waiter.detach();
    waiter.reject(new EngineDbWaitAbortedError());
  }
  if (pollTimer !== null) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  engineDbUrlApplied = false;
  pollInFlight = false;
  loggedWaiting = false;
  loggedReady = false;
}
