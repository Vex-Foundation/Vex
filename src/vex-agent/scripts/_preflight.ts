/**
 * Shared pre-flight checks for maintenance scripts.
 *
 * These guards exist because the maintenance commands (knowledge-export,
 * knowledge-import, knowledge-reembed) operate on production data and a
 * wrong-DB or stale-schema run is essentially data loss. The runtime path
 * (desktop app, internal tools) keeps using getPool() with the dev fallback
 * for backwards compatibility — that's a separate audit item, not in scope
 * here. Maintenance scripts MUST be stricter than runtime.
 *
 * Two checks:
 *   1. assertExplicitDbUrl — VEX_DB_URL must be set (no silent fallback
 *      to vex_test). Operators backing up the wrong DB is a real
 *      data-loss scenario.
 *   2. assertSchemaUpToDate — knowledge_entries.supersedes_id column must
 *      exist (added by 006_knowledge_lifecycle.sql). migrate.ts is strictly
 *      forward-only, so this column is the canary for "runMigrations has been
 *      run against this volume on a build that includes 006". We check the
 *      most recently added column rather than an old one so future migrations
 *      can just update the canary instead of rewriting the guard logic.
 */

import { queryOne } from "@vex-agent/db/client.js";

/**
 * Refuses to proceed when VEX_DB_URL is unset / empty / whitespace.
 * Writes an actionable error to stderr and exits with code 2.
 */
export function assertExplicitDbUrl(commandName: string): void {
  const url = (process.env.VEX_DB_URL ?? "").trim();
  if (url.length === 0) {
    process.stderr.write(
      `${commandName}: VEX_DB_URL is required for maintenance commands.\n` +
        `Refusing to run with the dev fallback (vex_test) — operating on\n` +
        `the wrong DB silently produces/consumes data and breaks recovery.\n\n` +
        `Set it explicitly for the DB you intend to touch, for example:\n` +
        `  export VEX_DB_URL=postgresql://vex:<password>@127.0.0.1:<port>/vex\n` +
        `For the desktop app's own database (while the app runs), <port> is\n` +
        `pg.lastPort in runtime-state.json under <CONFIG_DIR>/runtime\n` +
        `(%LOCALAPPDATA%\\vex\\runtime on Windows) and <password> is in\n` +
        `<CONFIG_DIR>/local-infra/secrets/pg_password.\n`,
    );
    process.exit(2);
  }
}

/**
 * Verifies that the schema includes the most recently added lifecycle column.
 * Run AFTER runMigrations() so a fresh DB gets the schema applied; if it's
 * still missing after migrations, something went wrong applying 006.
 */
export async function assertSchemaUpToDate(): Promise<void> {
  const row = await queryOne<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_name = 'knowledge_entries' AND column_name = 'supersedes_id'
     ) AS exists`,
  );
  if (!row?.exists) {
    process.stderr.write(
      `knowledge_entries.supersedes_id column missing — migration 006_knowledge_lifecycle.sql\n` +
        `has not been applied to this DB. runMigrations should have picked it up\n` +
        `automatically on startup; if it did not, check the migration logs and\n` +
        `verify that the migrations directory is being read correctly.\n\n` +
        `If you are on an older build and need a clean wipe of the desktop app's\n` +
        `database, use Settings -> Local runtime -> Reset local data in the app.\n` +
        `For a scratch database you created yourself, drop and recreate it.\n\n` +
        `WARNING: this destroys all local data. Use 'pg_dump' MANUALLY first\n` +
        `if you need to preserve it — knowledge-export cannot run on a schema\n` +
        `missing the lifecycle columns.\n`,
    );
    process.exit(2);
  }
}
