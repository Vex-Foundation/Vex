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
 * (`log_line_prefix = '%m [%p] '`, pinned in `postgres-conf.ts`), or the
 * `[pid]` of a child it names. A full disk is often the child's line: crash
 * recovery runs in the startup process, which logs the ENOSPC under its own
 * PID while the postmaster only says "startup process (PID n) exited with
 * exit code 1" (measured on PG 18.6, darwin-arm64, a 120 MB volume filled by
 * inserts). The caller passes both, narrowed by `logLinesForPostmaster`.
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
 * The postmaster's lines plus those of every child process it names in them
 * (`startup process (PID 56100) exited with exit code 1`): why a start failed
 * is often in the child's lines, not the postmaster's.
 */
export function logLinesForPostmaster(logText: string, pid: number): string[] {
  const pids = new Set([String(pid)]);
  for (const line of logLinesForPid(logText, pid)) {
    for (const match of line.matchAll(/\(PID (\d+)\)/g)) {
      if (match[1] !== undefined) pids.add(match[1]);
    }
  }
  return logText.split("\n").filter((line) => {
    const writer = /\[(\d+)\] /.exec(line)?.[1];
    return writer !== undefined && pids.has(writer);
  });
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

/** ENOSPC as Postgres prints it (`%m`), as Node names it, and Windows' own text. */
const NO_SPACE = /No space left on device|\bENOSPC\b|not enough space on the disk/i;
/**
 * ENOSPC that is NOT the disk: SysV shared memory and semaphores report their
 * kernel limits (SHMMNI, SEMMNI) as ENOSPC, and a full /dev/shm fails a POSIX
 * segment's resize the same way. Postgres says so itself (PG 18.6
 * sysv_shmem.c, sysv_sema.c: "This error does *not* mean that you have run
 * out of disk space"), and the remedy is a kernel limit, not freeing disk.
 */
const NOT_THE_DISK = /shared memory segment|could not create semaphores/i;
/**
 * A short write with no errno to print: md.c's "could not extend file ...:
 * wrote only 4096 of 8192 bytes at block N", hinted "Check free disk space.".
 */
const SHORT_WRITE = /could not extend file .*: wrote only \d+ of \d+ bytes|HINT:\s+Check free disk space\./;

/** True when some line says the volume ran out of space. */
export function isDiskFullText(text: string): boolean {
  return text
    .split("\n")
    .some((line) => (NO_SPACE.test(line) && !NOT_THE_DISK.test(line)) || SHORT_WRITE.test(line));
}

export function classifyStartFailure(text: string): StartFailureReason {
  if (isDiskFullText(text)) return "disk_full";
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
