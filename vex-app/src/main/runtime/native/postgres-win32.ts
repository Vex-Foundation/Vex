/**
 * The Windows half of the Postgres lifecycle, through `pg_ctl` (plan 6.5).
 *
 * UNTESTED: written to the plan with no Windows machine or CI available
 * (Phase 0, 15.6). Kept in its own module so the untested surface is exactly
 * this file.
 *
 * Why `pg_ctl` and not a direct spawn: `postgres.exe` refuses to run with
 * administrator rights, and `pg_ctl` drops them through a restricted token
 * before it starts the postmaster. So main does not own the postmaster's
 * process handle here; it reads the PID from `postmaster.pid` and polls it.
 *
 * Settings stay in `postgresql.conf`; `-o` carries only `-p <port>`, which
 * has no path in it to be misquoted.
 */

import type { PgRunTool } from "./postgres-supervisor.js";

const START_TIMEOUT_S = 60;
const IMMEDIATE_TIMEOUT_S = 5;

export interface PgCtlContext {
  readonly pgCtl: string;
  readonly dataDir: string;
  /** pg_ctl's own `-l` file: what the postmaster prints before the collector starts. */
  readonly startupLog: string;
  readonly env: Readonly<Record<string, string>>;
  readonly runTool: PgRunTool;
}

/** `pg_ctl start -w`: resolves once the server is ready or pg_ctl gave up. */
export async function pgCtlStart(
  ctx: PgCtlContext,
  port: number,
): Promise<{ readonly ok: boolean; readonly output: string }> {
  const result = await ctx.runTool(
    ctx.pgCtl,
    ["start", "-w", "-t", String(START_TIMEOUT_S), "-D", ctx.dataDir, "-l", ctx.startupLog, "-o", `-p ${String(port)}`],
    { env: ctx.env, timeoutMs: (START_TIMEOUT_S + 10) * 1_000 },
  );
  return { ok: result.code === 0, output: `${result.stdout}${result.stderr}` };
}

/**
 * `pg_ctl stop -m fast -w`, then `-m immediate` (crash recovery next start,
 * no data loss). Never TerminateProcess: that is the Windows SIGKILL.
 */
export async function pgCtlStop(
  ctx: PgCtlContext,
  deadlineMs: number,
): Promise<{ readonly mode: "fast" | "immediate" | null; readonly output: string }> {
  const fastSeconds = Math.max(1, Math.ceil(deadlineMs / 1_000));
  const fast = await ctx.runTool(
    ctx.pgCtl,
    ["stop", "-D", ctx.dataDir, "-m", "fast", "-w", "-t", String(fastSeconds)],
    { env: ctx.env, timeoutMs: (fastSeconds + 5) * 1_000 },
  );
  if (fast.code === 0) return { mode: "fast", output: fast.stdout };
  const immediate = await ctx.runTool(
    ctx.pgCtl,
    ["stop", "-D", ctx.dataDir, "-m", "immediate", "-w", "-t", String(IMMEDIATE_TIMEOUT_S)],
    { env: ctx.env, timeoutMs: (IMMEDIATE_TIMEOUT_S + 5) * 1_000 },
  );
  return {
    mode: immediate.code === 0 ? "immediate" : null,
    output: `${fast.stdout}${fast.stderr}${immediate.stdout}${immediate.stderr}`,
  };
}
