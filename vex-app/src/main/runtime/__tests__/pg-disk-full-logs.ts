/**
 * What Postgres 18.6 prints when its volume fills, captured verbatim on
 * darwin-arm64 (2026-10-17) with the bundled release tree
 * (native-runtime-2026.10.17-1) and the Vex conf block's logging settings
 * (`logging_collector = on`, `log_line_prefix = '%m [%p] '`, `lc_messages = 'C'`):
 *
 *   - INITDB: initdb into a 30 MB APFS disk image.
 *   - RUNNING: a cluster on a 120 MB image, filled by INSERTs from a client.
 *     The backend PANICs on its WAL write, the postmaster reinitializes, crash
 *     recovery (the startup process) cannot write WAL either, and the
 *     postmaster shuts itself down: a running server that fills its disk
 *     EXITS, so the supervisor sees an unexpected exit.
 *   - RESTART: `postgres -D` on that same full volume. stderr carries only
 *     the collector redirect; the ENOSPC is the startup process's line, not
 *     the postmaster's.
 *   - The client's view of the RUNNING failure (node-postgres error fields).
 *
 * The ENOSPC look-alikes that are NOT a full disk are quoted from the PG 18.6
 * sources (src/backend/port/sysv_shmem.c, sysv_sema.c): SysV limits report
 * ENOSPC too, and Postgres' own hint says it is not the disk.
 */

export const INITDB_DISK_FULL_OUTPUT = [
  "running bootstrap script ... ok",
  "performing post-bootstrap initialization ... 2026-10-17 20:51:53.761 WAT [54742] FATAL:  could not write to file \"base/4/2615_fsm\": No space left on device",
  "2026-10-17 20:51:53.761 WAT [54742] STATEMENT:  CREATE DATABASE template0 IS_TEMPLATE = true ALLOW_CONNECTIONS = false OID = 4 STRATEGY = file_copy;",
  "\t",
  "child process exited with exit code 1",
  "initdb: removing data directory \"m30/pg18.initdb\"",
].join("\n");

/** Postmaster 55388; backend 55629; startup process 55639. */
export const RUNNING_DISK_FULL_LOG = [
  "2026-10-17 19:52:19.158 UTC [55388] LOG:  starting PostgreSQL 18.6 on aarch64-darwin, compiled by clang-17.0.0, 64-bit",
  "2026-10-17 19:52:19.158 UTC [55388] LOG:  listening on IPv4 address \"127.0.0.1\", port 55999",
  "2026-10-17 19:52:19.174 UTC [55397] LOG:  database system was shut down at 2026-10-17 19:52:02 UTC",
  "2026-10-17 19:52:19.201 UTC [55388] LOG:  database system is ready to accept connections",
  "2026-10-17 19:52:30.010 UTC [55629] PANIC:  could not write to file \"pg_wal/xlogtemp.55629\": No space left on device",
  "2026-10-17 19:52:30.010 UTC [55629] STATEMENT:  INSERT INTO fill (payload) SELECT md5(random()::text) || repeat('x', 900) FROM generate_series(1, 5000)",
  "2026-10-17 19:52:30.030 UTC [55388] LOG:  client backend (PID 55629) was terminated by signal 6: Abort trap: 6",
  "2026-10-17 19:52:30.030 UTC [55388] DETAIL:  Failed process was running: INSERT INTO fill (payload) SELECT md5(random()::text) || repeat('x', 900) FROM generate_series(1, 5000)",
  "2026-10-17 19:52:30.030 UTC [55388] LOG:  terminating any other active server processes",
  "2026-10-17 19:52:30.031 UTC [55388] LOG:  all server processes terminated; reinitializing",
  "2026-10-17 19:52:30.054 UTC [55639] LOG:  database system was interrupted; last known up at 2026-10-17 19:52:19 UTC",
  "2026-10-17 19:52:30.154 UTC [55639] LOG:  database system was not properly shut down; automatic recovery in progress",
  "2026-10-17 19:52:30.161 UTC [55639] LOG:  redo starts at 0/1711CE0",
  "2026-10-17 19:52:30.210 UTC [55639] LOG:  redo done at 0/3FFFBC0 system usage: CPU: user: 0.02 s, system: 0.01 s, elapsed: 0.04 s",
  "2026-10-17 19:52:30.535 UTC [55639] FATAL:  could not write to file \"pg_wal/xlogtemp.55639\": No space left on device",
  "2026-10-17 19:52:30.536 UTC [55388] LOG:  startup process (PID 55639) exited with exit code 1",
  "2026-10-17 19:52:30.536 UTC [55388] LOG:  terminating any other active server processes",
  "2026-10-17 19:52:30.537 UTC [55388] LOG:  shutting down due to startup process failure",
  "2026-10-17 19:52:30.539 UTC [55388] LOG:  database system is shut down",
  "",
].join("\n");

export const RESTART_POSTMASTER_PID = 56089;
export const RESTART_STARTUP_PID = 56100;

/** The restart's stderr: everything after this goes to log/. */
export const RESTART_DISK_FULL_STDERR = [
  "2026-10-17 19:52:42.022 UTC [56089] LOG:  redirecting log output to logging collector process",
  "2026-10-17 19:52:42.022 UTC [56089] HINT:  Future log output will appear in directory \"log\".",
  "",
].join("\n");

/** Postmaster 56089; startup process 56100. */
export const RESTART_DISK_FULL_LOG = [
  "2026-10-17 19:52:42.022 UTC [56089] LOG:  starting PostgreSQL 18.6 on aarch64-darwin, compiled by clang-17.0.0, 64-bit",
  "2026-10-17 19:52:42.023 UTC [56089] LOG:  listening on IPv4 address \"127.0.0.1\", port 55999",
  "2026-10-17 19:52:42.044 UTC [56100] LOG:  database system was interrupted while in recovery at 2026-10-17 19:52:30 UTC",
  "2026-10-17 19:52:42.044 UTC [56100] HINT:  This probably means that some data is corrupted and you will have to use the last backup for recovery.",
  "2026-10-17 19:52:42.193 UTC [56100] LOG:  database system was not properly shut down; automatic recovery in progress",
  "2026-10-17 19:52:42.200 UTC [56100] LOG:  redo starts at 0/1711CE0",
  "2026-10-17 19:52:42.777 UTC [56100] LOG:  redo done at 0/3FFFBC0 system usage: CPU: user: 0.02 s, system: 0.03 s, elapsed: 0.57 s",
  "2026-10-17 19:52:42.937 UTC [56100] FATAL:  could not write to file \"pg_wal/xlogtemp.56100\": No space left on device",
  "2026-10-17 19:52:42.938 UTC [56089] LOG:  startup process (PID 56100) exited with exit code 1",
  "2026-10-17 19:52:42.938 UTC [56089] LOG:  terminating any other active server processes",
  "2026-10-17 19:52:42.938 UTC [56089] LOG:  shutting down due to startup process failure",
  "2026-10-17 19:52:42.940 UTC [56089] LOG:  database system is shut down",
  "",
].join("\n");

/** node-postgres' error for the RUNNING case's INSERT, as the client received it. */
export const CLIENT_DISK_FULL_ERROR = {
  code: "53100",
  severity: "PANIC",
  message: "could not write to file \"pg_wal/xlogtemp.55629\": No space left on device",
} as const;

/** sysv_shmem.c: shmget hit SHMMNI or SHMALL. errno text is ENOSPC's. */
export const SHMGET_ENOSPC = [
  "2026-10-17 19:52:42.022 UTC [56089] FATAL:  could not create shared memory segment: No space left on device",
  "2026-10-17 19:52:42.022 UTC [56089] DETAIL:  Failed system call was shmget(key=97, size=56, 03600).",
  "2026-10-17 19:52:42.022 UTC [56089] HINT:  This error does *not* mean that you have run out of disk space.  It occurs either if all available shared memory IDs have been taken, in which case you need to raise the SHMMNI parameter in your kernel, or because the system's overall limit for shared memory has been reached.",
].join("\n");

/** sysv_sema.c: semget hit SEMMNI or SEMMNS. */
export const SEMGET_ENOSPC = [
  "2026-10-17 19:52:42.022 UTC [56089] FATAL:  could not create semaphores: No space left on device",
  "2026-10-17 19:52:42.022 UTC [56089] DETAIL:  Failed system call was semget(97, 17, 03600).",
  "2026-10-17 19:52:42.022 UTC [56089] HINT:  This error does *not* mean that you have run out of disk space.  It occurs when either the system limit for the maximum number of semaphore sets (SEMMNI), or the system wide maximum number of semaphores (SEMMNS), would be exceeded.",
].join("\n");
