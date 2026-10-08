/**
 * Writes one `main_event_loop_samples` row (migration 175) per event loop
 * telemetry window (K-5, `../telemetry/event-loop-delay.ts`).
 *
 * Fire-and-forget and bounded like the engine's runtime-timings
 * `recordInBackground`: at most {@link MAX_IN_FLIGHT_EVENT_LOOP_WRITES} write
 * in flight; a window that arrives while one is pending is dropped and
 * counted. No DB connection yet (compose not up) means the row is skipped.
 * A failed write (including a database that predates migration 175) logs one
 * warning per error class and is dropped. Never throws, never rejects.
 *
 * Every column is a number; see the migration for what each one means.
 */

import type { Client } from "pg";

import { buildPoolConfig } from "./db-config.js";
import { runWithMainDbClient } from "./main-ipc-pg-pool.js";
import { log } from "../logger/index.js";
import type { EventLoopWindow } from "../telemetry/event-loop-delay.js";

const CONNECT_TIMEOUT_MS = 2_000;
const QUERY_TIMEOUT_MS = 5_000;

export const MAX_IN_FLIGHT_EVENT_LOOP_WRITES = 1;

let inFlight = 0;
let dropped = 0;
const warnedClasses = new Set<string>();

class ConnectFailed extends Error {
  constructor() {
    super("connect failed");
    this.name = "ConnectFailed";
  }
}

function errorClass(cause: unknown): string {
  if (typeof cause === "object" && cause !== null && "code" in cause) {
    const code = cause.code;
    if (typeof code === "string") return code;
  }
  return cause instanceof Error ? cause.name : typeof cause;
}

async function insertWindow(client: Client, window: EventLoopWindow): Promise<void> {
  await client.query(
    `INSERT INTO main_event_loop_samples
       (window_ms, sample_count, p50_ms, p99_ms, max_ms,
        stall_count, stall_threshold_ms, longest_stall_ms)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      window.windowMs,
      window.sampleCount,
      window.p50Ms,
      window.p99Ms,
      window.maxMs,
      window.stallCount,
      window.stallThresholdMs,
      window.longestStallMs,
    ],
  );
}

async function writeWindow(window: EventLoopWindow): Promise<void> {
  const cfg = await buildPoolConfig();
  if (cfg === null) return;
  await runWithMainDbClient(
    cfg,
    {
      logPrefix: "[event-loop-db]",
      timeouts: { connectTimeoutMs: CONNECT_TIMEOUT_MS, statementTimeoutMs: QUERY_TIMEOUT_MS },
      onConnectFailed: (): never => {
        throw new ConnectFailed();
      },
    },
    (client) => insertWindow(client, window),
  );
}

/** Records one window in the background. Returns synchronously. */
export function recordEventLoopWindow(
  window: EventLoopWindow,
  write: (window: EventLoopWindow) => Promise<void> = writeWindow,
): void {
  if (inFlight >= MAX_IN_FLIGHT_EVENT_LOOP_WRITES) {
    dropped += 1;
    return;
  }
  inFlight += 1;
  const settle = (): void => {
    inFlight = Math.max(0, inFlight - 1);
  };
  const onFailure = (cause: unknown): void => {
    settle();
    const cls = errorClass(cause);
    if (cls === "ConnectFailed" || warnedClasses.has(cls)) return;
    warnedClasses.add(cls);
    log.warn(`[event-loop-db] write failed errorClass=${cls} (dropped; logged once per class)`);
  };
  try {
    void write(window).then(settle, onFailure);
  } catch (cause) {
    onFailure(cause);
  }
}

/** Sanitised counters for tests and diagnostics. */
export function eventLoopWriteStats(): { readonly inFlight: number; readonly dropped: number } {
  return { inFlight, dropped };
}

/** Test seam. */
export function resetEventLoopWriteStateForTests(): void {
  inFlight = 0;
  dropped = 0;
  warnedClasses.clear();
}
