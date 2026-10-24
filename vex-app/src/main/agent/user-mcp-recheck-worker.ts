/**
 * Main-side supervisor for the user MCP recheck worker (F12), shaped like
 * `setupWakeWorker`: it polls until the engine database is reachable and
 * migrated, then starts the engine executor once. Each notice the executor
 * raises is validated and broadcast as `EV.engine.userMcpChanged`; the
 * renderer turns it into a notification and refreshes Settings.
 */

import { randomUUID } from "node:crypto";
import type { UserMcpNotice, UserMcpRecheckHandle } from "@vex-agent/user-mcp/recheck-executor.js";
import { EV } from "@shared/ipc/channels.js";
import { userMcpChangedEventSchema } from "@shared/schemas/user-mcp.js";
import { ensureEngineDbUrl } from "../database/engine-db-readiness.js";
import { migrationsApplied } from "../database/migrations-applied.js";
import { broadcastToAllWindows } from "../lifecycle/broadcast.js";
import { log } from "../logger/index.js";

const SUPERVISOR_INTERVAL_MS = 30_000;

export interface UserMcpRecheckWorkerDeps {
  readonly ensureDbUrl: (correlationId: string) => Promise<{ readonly ok: boolean }>;
  readonly migrationsApplied: () => boolean;
  readonly startExecutor: (onNotice: (notice: UserMcpNotice) => void) => Promise<UserMcpRecheckHandle>;
  readonly broadcast: (notice: UserMcpNotice) => void;
  readonly intervalMs: number;
}

async function defaultStartExecutor(onNotice: (notice: UserMcpNotice) => void): Promise<UserMcpRecheckHandle> {
  const { startUserMcpRecheckExecutor } = await import("@vex-agent/user-mcp/recheck-executor.js");
  return startUserMcpRecheckExecutor({ onNotice });
}

function defaultBroadcast(notice: UserMcpNotice): void {
  const parsed = userMcpChangedEventSchema.safeParse({ ...notice, tools: [...notice.tools] });
  if (!parsed.success) {
    log.warn("[user-mcp-recheck] dropped an invalid notice");
    return;
  }
  broadcastToAllWindows(EV.engine.userMcpChanged, parsed.data);
}

export function setupUserMcpRecheckWorker(deps: Partial<UserMcpRecheckWorkerDeps> = {}): () => Promise<void> {
  const ensureDbUrl = deps.ensureDbUrl ?? ((id: string) => ensureEngineDbUrl(id));
  const applied = deps.migrationsApplied ?? migrationsApplied;
  const startExecutor = deps.startExecutor ?? defaultStartExecutor;
  const broadcast = deps.broadcast ?? defaultBroadcast;
  const intervalMs = deps.intervalMs ?? SUPERVISOR_INTERVAL_MS;

  let stopped = false;
  let handle: UserMcpRecheckHandle | null = null;
  let inFlight: Promise<void> | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;

  const clearTimer = (): void => {
    if (timer !== null) clearInterval(timer);
    timer = null;
  };

  const tick = async (): Promise<void> => {
    if (stopped || handle !== null) return;
    const db = await ensureDbUrl(`user-mcp-recheck-${randomUUID()}`);
    if (stopped || handle !== null || !db.ok || !applied()) return;
    const live = await startExecutor(broadcast);
    if (stopped) {
      await live.stop();
      return;
    }
    handle = live;
    clearTimer();
    log.info("[user-mcp-recheck] started");
  };

  const schedule = (): void => {
    if (stopped || handle !== null || inFlight !== null) return;
    inFlight = tick()
      .catch((err) => log.warn("[user-mcp-recheck] supervisor tick failed", err instanceof Error ? err.name : "non_error"))
      .finally(() => {
        inFlight = null;
      });
  };

  schedule();
  timer = setInterval(schedule, intervalMs);

  return async () => {
    stopped = true;
    clearTimer();
    if (inFlight !== null) await inFlight.catch(() => undefined);
    if (handle !== null) {
      const live = handle;
      handle = null;
      await live.stop();
    }
  };
}
