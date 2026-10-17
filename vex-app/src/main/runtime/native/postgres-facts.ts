/**
 * What the supervisor reads back from Postgres, as pure functions over text.
 *
 * READINESS (Phase 0, 15.4 item 1). With `logging_collector = on`, stderr
 * carries only "redirecting log output to logging collector process"; the
 * ready line and bind errors go to `log/`. So readiness is `postmaster.pid`:
 * line 1 is the postmaster's PID and line 8 its status (`starting`,
 * `stopping`, `ready`, `standby`), the field `pg_ctl -w` waits on. Line 1 must
 * be the PID we spawned: a SIGKILLed postmaster leaves its file behind still
 * saying `ready`.
 *
 * FAILED STARTS. Where the reason lands depends on when the postmaster died:
 * before the collector starts (lock file held, old shared memory still
 * attached) it is on stderr; after (port taken, disk full) it is in the
 * newest file in `log/`, on lines carrying the postmaster's `[pid]`
 * (`log_line_prefix = '%m [%p] '`, pinned in `postgres-conf.ts`). The caller
 * passes both, already narrowed to that PID.
 */

/** postmaster.pid, line by line (PG 18 `pidfile.h`). */
export interface PostmasterPidFile {
  readonly pid: number;
  readonly dataDir: string;
  readonly port: number | null;
  readonly status: string | null;
}

export function parsePostmasterPid(text: string): PostmasterPidFile | null {
  const lines = text.split("\n").map((line) => line.replace(/\r$/, ""));
  const pid = Number(lines[0]);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const dataDir = lines[1] ?? "";
  if (dataDir.length === 0) return null;
  const port = Number(lines[3]);
  const status = lines[7]?.trim();
  return {
    pid,
    dataDir,
    port: Number.isInteger(port) && port > 0 ? port : null,
    status: status === undefined || status.length === 0 ? null : status,
  };
}

/** Ready means: this file names `spawnedPid`, and says `ready`. */
export function isReadyFor(text: string | null, spawnedPid: number): boolean {
  if (text === null) return false;
  const parsed = parsePostmasterPid(text);
  return parsed !== null && parsed.pid === spawnedPid && parsed.status === "ready";
}

/** The lines of a server log written by `pid` (its own and its HINT/DETAIL). */
export function logLinesForPid(logText: string, pid: number): string[] {
  const marker = `[${String(pid)}] `;
  return logText.split("\n").filter((line) => line.includes(marker));
}

/**
 * - `port_in_use`: the bind failed; retry with another port.
 * - `disk_full`: the volume holding the data dir is full.
 * - `data_dir_busy`: a previous postmaster's lock file or shared memory is
 *   still held, which is what a just-crashed postmaster's exiting children
 *   look like; retry shortly (Phase 0 measured recovery within ~200 ms).
 * - `other`: anything else; the start failed.
 */
export type StartFailureReason = "port_in_use" | "disk_full" | "data_dir_busy" | "other";

export function classifyStartFailure(text: string): StartFailureReason {
  if (/No space left on device|\bENOSPC\b|not enough space on the disk/i.test(text)) return "disk_full";
  // The Windows text is the system message for WSAEADDRINUSE (untested).
  if (/could not bind IPv[46] address .*(Address already in use|Only one usage of each socket address)/.test(text)) {
    return "port_in_use";
  }
  if (/pre-existing shared memory block .* is still in use|lock file ".*" already exists/.test(text)) {
    return "data_dir_busy";
  }
  return "other";
}

/** The first FATAL/PANIC line, for a failure message a person can act on. */
export function firstFatalLine(text: string): string | null {
  const line = text.split("\n").find((l) => /\b(FATAL|PANIC):/.test(l));
  return line === undefined ? null : line.replace(/^.*?\b(FATAL|PANIC):\s*/, "").trim();
}

/** `Database system identifier:  7697...` from `pg_controldata` output. */
export function parseControldataSystemIdentifier(stdout: string): string | null {
  const match = /^Database system identifier:\s+(\d+)\s*$/m.exec(stdout);
  return match?.[1] ?? null;
}
