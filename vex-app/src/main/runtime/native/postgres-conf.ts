/**
 * The server configuration Vex owns (plan 6.3 and 6.4). Pure: text in, text
 * out.
 *
 * `postgresql.conf` keeps initdb's file and gets ONE Vex block appended
 * between two marker lines. Postgres applies the last occurrence of a
 * setting, so the block overrides initdb's lines without editing them, and
 * rewriting it replaces the block in place: running it on every start keeps
 * an existing cluster in step with this build, and never stacks copies.
 *
 * `port` is deliberately absent: it is chosen at launch and passed as `-p`
 * (D5). Nothing goes through `pg_ctl -o` either, whose quoting breaks on
 * Windows paths with spaces.
 *
 * `pg_hba.conf` is REPLACED: two rules, the vex role over loopback TCP with
 * SCRAM. With `unix_socket_directories = ''` there is no local socket to
 * grant.
 */

/**
 * macOS: plain `fsync` does not flush the drive's write cache, so it is not
 * power-loss safe; `fsync_writethrough` is (F_FULLFSYNC), at ~3 ms per commit
 * versus 0.08 ms (Phase 0, 15.3). Owner decision pending: plan 13.2 item 5.
 * This constant is the single place that decision lands.
 */
export const DARWIN_WAL_SYNC_METHOD = "fsync_writethrough";

export const VEX_CONF_BEGIN = "# >>> Vex native runtime (managed by Vex; edits are overwritten) >>>";
export const VEX_CONF_END = "# <<< Vex native runtime <<<";

const SHARED_SETTINGS: readonly string[] = [
  "listen_addresses = '127.0.0.1'",
  "unix_socket_directories = ''",
  "password_encryption = scram-sha-256",
  "max_connections = 40",
  "superuser_reserved_connections = 2",
  "shared_buffers = 128MB",
  "work_mem = 8MB",
  "maintenance_work_mem = 128MB",
  "effective_cache_size = 1GB",
  "wal_level = minimal",
  "max_wal_senders = 0",
  "max_wal_size = 512MB",
  "min_wal_size = 80MB",
  "wal_compression = on",
  "checkpoint_timeout = 10min",
  "max_worker_processes = 4",
  "max_parallel_workers_per_gather = 1",
  "autovacuum_worker_slots = 4",
  "jit = off",
  "huge_pages = off",
  "timezone = 'UTC'",
  "log_timezone = 'UTC'",
  "lc_messages = 'C'",
  "logging_collector = on",
  "log_directory = 'log'",
  "log_rotation_size = 10MB",
  "log_truncate_on_rotation = on",
  // The supervisor attributes log lines to the postmaster it spawned by the
  // `[pid]` field, so the prefix is pinned rather than left to initdb's
  // default (which is the same text today).
  "log_line_prefix = '%m [%p] '",
  "fsync = on",
  "full_page_writes = on",
  "synchronous_commit = on",
];

/**
 * Linux keeps Postgres' default (`fdatasync`). Windows keeps its default
 * (`open_datasync`) until the Phase 0 Windows benchmark picks one (6.3).
 */
function platformSettings(platform: NodeJS.Platform): readonly string[] {
  return platform === "darwin" ? [`wal_sync_method = ${DARWIN_WAL_SYNC_METHOD}`] : [];
}

export function renderVexConfBlock(platform: NodeJS.Platform): string {
  return [VEX_CONF_BEGIN, ...SHARED_SETTINGS, ...platformSettings(platform), VEX_CONF_END, ""].join("\n");
}

/**
 * `existing` with the Vex block replaced, or appended when absent. A begin
 * marker without an end marker (a torn earlier write) is treated as a block
 * that runs to the end of the file, because the block is only ever appended.
 */
export function withVexConfBlock(existing: string, platform: NodeJS.Platform): string {
  const block = renderVexConfBlock(platform);
  const begin = existing.indexOf(VEX_CONF_BEGIN);
  if (begin === -1) {
    const separator = existing.length === 0 || existing.endsWith("\n") ? "" : "\n";
    return `${existing}${separator}\n${block}`;
  }
  const endMarker = existing.indexOf(VEX_CONF_END, begin);
  if (endMarker === -1) return `${existing.slice(0, begin)}${block}`;
  let after = endMarker + VEX_CONF_END.length;
  if (existing[after] === "\n") after += 1;
  return `${existing.slice(0, begin)}${block}${existing.slice(after)}`;
}

export const VEX_PG_HBA = [
  "# Managed by Vex: the vex role over loopback TCP, SCRAM only.",
  "host  all  vex  127.0.0.1/32  scram-sha-256",
  "host  all  vex  ::1/128       scram-sha-256",
  "",
].join("\n");
