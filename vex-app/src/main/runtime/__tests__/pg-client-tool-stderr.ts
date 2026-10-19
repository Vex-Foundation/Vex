/**
 * What the bundled pg_restore / pg_dump 18.6 print when they fail, captured
 * verbatim (2026-10-19) with the linux-x64 tree of native-runtime-2026.10.17-1
 * against a throwaway cluster made with the app's initdb flags and a synthetic
 * database (no user data). Each run used the flags the data move uses
 * (`--exit-on-error --single-transaction` for pg_restore, `-Fc` for pg_dump).
 *
 *   - CREATE_TABLE_EXISTS: restore into a database that already has the table.
 *     The error comes first and the whole statement after it, so the last
 *     lines are SQL. This is the shape of the first failed data move on
 *     Windows (2026-10-19), where only the statement's tail reached the user.
 *   - COPY_CHECK_VIOLATION: a data-only restore into a table whose CHECK the
 *     second row breaks. The server's DETAIL and CONTEXT quote the row.
 *   - SERVER_TERMINATED: `pg_ctl stop -m immediate` while the restore copied
 *     a large table.
 *   - CONNECTION_REFUSED: nothing listening on the port (libpq's tab-indented
 *     continuation line).
 *   - DUMP_MISSING_DATABASE / DUMP_PERMISSION_DENIED: pg_dump's connection and
 *     query failures; the second carries pg_dump's own `detail:` line.
 *
 * On Windows the same tools end each line with CRLF.
 */

export const RESTORE_CREATE_TABLE_EXISTS = [
  'pg_restore: error: could not execute query: ERROR:  relation "activity" already exists',
  "Command was: CREATE TABLE public.activity (",
  "    id bigint NOT NULL,",
  "    status text DEFAULT 'pending'::text NOT NULL,",
  "    amount_raw text,",
  "    token_address text,",
  "    note text,",
  "    CONSTRAINT activity_amount_has_token CHECK (((amount_raw IS NULL) OR (token_address IS NOT NULL))),",
  "    CONSTRAINT activity_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'confirmed'::text])))",
  ");",
  "",
  "",
].join("\n");

export const RESTORE_COPY_CHECK_VIOLATION = [
  'pg_restore: error: COPY failed for table "activity": ERROR:  new row for relation "activity" violates check constraint "activity_note_check"',
  "DETAIL:  Failing row contains (2, confirmed, 5, 0xabc, synthetic row two).",
  'CONTEXT:  COPY activity, line 2: "2\tconfirmed\t5\t0xabc\tsynthetic row two"',
  "",
].join("\n");

export const RESTORE_SERVER_TERMINATED = [
  "pg_restore: error: error returned by PQputCopyData: server closed the connection unexpectedly",
  "\tThis probably means the server terminated abnormally",
  "\tbefore or while processing the request.",
  "",
].join("\n");

export const RESTORE_CONNECTION_REFUSED = [
  'pg_restore: error: connection to server at "127.0.0.1", port 1 failed: Connection refused',
  "\tIs the server running on that host and accepting TCP/IP connections?",
  "",
].join("\n");

export const DUMP_MISSING_DATABASE =
  'pg_dump: error: connection to server at "127.0.0.1", port 55994 failed: FATAL:  database "nope" does not exist\n';

export const DUMP_PERMISSION_DENIED = [
  "pg_dump: error: query failed: ERROR:  permission denied for table activity",
  "pg_dump: detail: Query was: LOCK TABLE public.activity IN ACCESS SHARE MODE",
  "",
].join("\n");

export const toCrlf = (text: string): string => text.replaceAll("\n", "\r\n");
