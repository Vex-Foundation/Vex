/**
 * What the migration proves about a database before it trusts a copy of it:
 * the same facts are read from the old database (inside the snapshot the dump
 * was taken from) and from the restored one, and the copy counts only when
 * every fact matches (plan section 10 step 6).
 *
 *   schemaVersion   max(version) in schema_version, so the migration runner
 *                   resumes exactly where the old database stopped
 *   tables          for every table: the exact row count, and a digest of its
 *                   rows (md5 of each row's text, sorted, md5'd again), so a
 *                   single changed value in any column fails, not only a
 *                   missing row
 *   vectorColumns   for every `vector` column: the non-null count and a digest
 *                   of the BINARY form (`vector_send`) of every value, so a
 *                   vector that round-trips through text differently fails
 *   vectorSample    knowledge_entries' embedding, row by row, for a sample of
 *                   ids: sha256 of the binary form, byte-equal or nothing
 *   sequences       last_value of every sequence, so the next insert does not
 *                   collide with a migrated primary key
 *   indexes, constraints, extensions, largeObjects   what pg_restore created
 *
 * Text forms are made session-independent first (UTC, ISO dates, hex bytea),
 * and every sort that feeds a digest uses the C collation: the old cluster is
 * `en_US.utf8`, the new one builtin `C.UTF-8` (6.2), and a digest must not
 * depend on either.
 *
 * Read-only: every query runs in a READ ONLY transaction.
 */

import pg from "pg";
import { z } from "zod";
import { LOOPBACK_DB_HOST } from "../../database/connection-state.js";
import { VEX_DATABASE, VEX_ROLE } from "../native/pg-identity.js";

export interface TableFacts {
  readonly rows: number;
  /** null for an empty table. */
  readonly digest: string | null;
}

export interface VectorColumnFacts {
  readonly nonNull: number;
  readonly digest: string | null;
}

export interface DatabaseFacts {
  readonly schemaVersion: number | null;
  /** Keyed `schema.table`. */
  readonly tables: Readonly<Record<string, TableFacts>>;
  /** Keyed `schema.table.column`. */
  readonly vectorColumns: Readonly<Record<string, VectorColumnFacts>>;
  /** knowledge_entries id -> sha256 (hex) of the embedding's binary form. */
  readonly vectorSample: Readonly<Record<string, string>>;
  /** Keyed `schema.sequence`; null when the sequence was never used. */
  readonly sequences: Readonly<Record<string, string | null>>;
  readonly indexes: readonly string[];
  readonly constraints: readonly string[];
  readonly extensions: readonly string[];
  readonly largeObjects: number;
}

export const databaseFactsSchema = z.object({
  schemaVersion: z.number().int().nullable(),
  tables: z.record(z.string(), z.object({ rows: z.number().int().nonnegative(), digest: z.string().nullable() })),
  vectorColumns: z.record(z.string(), z.object({ nonNull: z.number().int().nonnegative(), digest: z.string().nullable() })),
  vectorSample: z.record(z.string(), z.string()),
  sequences: z.record(z.string(), z.string().nullable()),
  indexes: z.array(z.string()),
  constraints: z.array(z.string()),
  extensions: z.array(z.string()),
  largeObjects: z.number().int().nonnegative(),
});

/** How many knowledge_entries rows are compared vector by vector. */
export const VECTOR_SAMPLE_SIZE = 64;
const SAMPLE_TABLE = { schema: "public", table: "knowledge_entries", id: "id", vector: "embedding" } as const;

/** The session settings every text form is read under, on both sides. */
const SESSION_OPTIONS =
  "-c TimeZone=UTC -c DateStyle=ISO,MDY -c IntervalStyle=postgres -c bytea_output=hex -c extra_float_digits=1";

const USER_SCHEMA = `n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_%'`;
/** Objects an extension owns are re-created by CREATE EXTENSION, not restored. */
const NOT_EXTENSION_MEMBER = (oid: string): string =>
  `NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass AND d.objid = ${oid} AND d.deptype = 'e')`;

/** Byte order, so the result never depends on a locale (`localeCompare` would). */
function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

const quote = (identifier: string): string => pg.escapeIdentifier(identifier);

/** Every fact, read on `client` inside whatever transaction it is in. */
export async function readDatabaseFacts(
  client: pg.ClientBase,
  options: { readonly sampleIds?: readonly string[] } = {},
): Promise<DatabaseFacts> {
  const tableRows = await client.query<{ schema: string; name: string }>(
    `SELECT n.nspname AS schema, c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind IN ('r', 'm') AND ${USER_SCHEMA} AND ${NOT_EXTENSION_MEMBER("c.oid")}`,
  );
  const tables: Record<string, TableFacts> = {};
  for (const { schema, name } of [...tableRows.rows].sort((a, b) => byCodePoint(`${a.schema}.${a.name}`, `${b.schema}.${b.name}`))) {
    // ROW(t.*), not `t`: a column named like the alias would win over the
    // whole-row reference.
    const result = await client.query<{ rows: string; digest: string | null }>(
      `SELECT count(*)::text AS rows, md5(string_agg(h, '' ORDER BY h)) AS digest
         FROM (SELECT md5(ROW(t.*)::text) COLLATE "C" AS h FROM ONLY ${quote(schema)}.${quote(name)} t) x`,
    );
    const row = result.rows[0];
    tables[`${schema}.${name}`] = { rows: Number(row?.rows ?? 0), digest: row?.digest ?? null };
  }

  const vectorSchema = await client.query<{ schema: string }>(
    `SELECT n.nspname AS schema FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace WHERE e.extname = 'vector'`,
  );
  const vectorNs = vectorSchema.rows[0]?.schema;
  const vectorColumns: Record<string, VectorColumnFacts> = {};
  const vectorSample: Record<string, string> = {};
  if (vectorNs !== undefined) {
    const send = `${quote(vectorNs)}.vector_send`;
    const columns = await client.query<{ schema: string; name: string; column: string }>(
      `SELECT n.nspname AS schema, c.relname AS name, a.attname AS column
         FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_type ty ON ty.oid = a.atttypid JOIN pg_namespace tn ON tn.oid = ty.typnamespace
        WHERE ty.typname = 'vector' AND tn.nspname = $1 AND a.attnum > 0 AND NOT a.attisdropped
          AND c.relkind = 'r' AND ${USER_SCHEMA}`,
      [vectorNs],
    );
    for (const { schema, name, column } of [...columns.rows].sort((a, b) =>
      byCodePoint(`${a.schema}.${a.name}.${a.column}`, `${b.schema}.${b.name}.${b.column}`),
    )) {
      const col = quote(column);
      const result = await client.query<{ n: string; digest: string | null }>(
        `SELECT count(*)::text AS n, md5(string_agg(h, '' ORDER BY h)) AS digest
           FROM (SELECT encode(sha256(${send}(${col})), 'hex') COLLATE "C" AS h
                   FROM ONLY ${quote(schema)}.${quote(name)} WHERE ${col} IS NOT NULL) x`,
      );
      const row = result.rows[0];
      vectorColumns[`${schema}.${name}.${column}`] = { nonNull: Number(row?.n ?? 0), digest: row?.digest ?? null };
    }

    const sampleKey = `${SAMPLE_TABLE.schema}.${SAMPLE_TABLE.table}.${SAMPLE_TABLE.vector}`;
    if (sampleKey in vectorColumns) {
      const from = `${quote(SAMPLE_TABLE.schema)}.${quote(SAMPLE_TABLE.table)}`;
      const id = quote(SAMPLE_TABLE.id);
      const select = `SELECT ${id}::text AS id, encode(sha256(${send}(${quote(SAMPLE_TABLE.vector)})), 'hex') AS h FROM ${from}`;
      // The old side picks the sample; the new side is asked for exactly those
      // ids, so a missing row is a missing key rather than a shifted sample.
      const result =
        options.sampleIds === undefined
          ? await client.query<{ id: string; h: string }>(
              `${select} ORDER BY md5(${id}::text) COLLATE "C" LIMIT ${String(VECTOR_SAMPLE_SIZE)}`,
            )
          : await client.query<{ id: string; h: string }>(`${select} WHERE ${id}::text = ANY($1::text[])`, [
              [...options.sampleIds],
            ]);
      for (const row of result.rows) vectorSample[row.id] = row.h;
    }
  }

  const sequences: Record<string, string | null> = {};
  const sequenceRows = await client.query<{ schema: string; name: string; last: string | null }>(
    `SELECT n.nspname AS schema, c.relname AS name, s.last_value::text AS last
       FROM pg_sequences s JOIN pg_namespace n ON n.nspname = s.schemaname
       JOIN pg_class c ON c.relname = s.sequencename AND c.relnamespace = n.oid
      WHERE ${USER_SCHEMA} AND ${NOT_EXTENSION_MEMBER("c.oid")}`,
  );
  for (const row of [...sequenceRows.rows].sort((a, b) => byCodePoint(`${a.schema}.${a.name}`, `${b.schema}.${b.name}`))) {
    sequences[`${row.schema}.${row.name}`] = row.last;
  }

  const names = async (sql: string): Promise<string[]> =>
    (await client.query<{ name: string }>(sql)).rows.map((r) => r.name).sort(byCodePoint);
  const indexes = await names(
    `SELECT n.nspname || '.' || c.relname AS name FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace WHERE ${USER_SCHEMA} AND ${NOT_EXTENSION_MEMBER("i.indrelid")}`,
  );
  const constraints = await names(
    `SELECT n.nspname || '.' || c.relname || '.' || co.conname || ':' || co.contype::text AS name
       FROM pg_constraint co JOIN pg_class c ON c.oid = co.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE ${USER_SCHEMA} AND ${NOT_EXTENSION_MEMBER("c.oid")}`,
  );
  const extensions = await names(`SELECT extname AS name FROM pg_extension`);
  const largeObjects = Number(
    (await client.query<{ n: string }>(`SELECT count(*)::text AS n FROM pg_largeobject_metadata`)).rows[0]?.n ?? 0,
  );

  let schemaVersion: number | null = null;
  const ledger = await client.query<{ present: boolean }>(`SELECT to_regclass('public.schema_version') IS NOT NULL AS present`);
  if (ledger.rows[0]?.present === true) {
    const max = await client.query<{ v: number | null }>(`SELECT max(version)::int AS v FROM public.schema_version`);
    schemaVersion = max.rows[0]?.v ?? null;
  }

  return { schemaVersion, tables, vectorColumns, vectorSample, sequences, indexes, constraints, extensions, largeObjects };
}

/* ------------------------------------------------------------------ *
 * Comparison.
 * ------------------------------------------------------------------ */

export interface VerifyReport {
  readonly ok: boolean;
  readonly schemaVersion: number | null;
  readonly tables: number;
  readonly rows: number;
  readonly vectors: number;
  readonly sampledVectors: number;
  /** What differs, worded for a log or a support bundle; never row content. */
  readonly mismatches: readonly string[];
}

const MAX_REPORTED_MISMATCHES = 50;

function compareNameSets(label: string, before: readonly string[], after: readonly string[], out: string[]): void {
  const afterSet = new Set(after);
  const beforeSet = new Set(before);
  for (const name of before) if (!afterSet.has(name)) out.push(`${label} ${name} is missing from the new database`);
  for (const name of after) if (!beforeSet.has(name)) out.push(`${label} ${name} is in the new database only`);
}

/**
 * The verdict. `source` is what the old database held when it was dumped,
 * `target` what the new one holds now. Any difference fails the copy.
 *
 * Extensions are compared by name, not version: the dump's CREATE EXTENSION
 * creates the bundled pgvector (0.8.7) where the image had 0.8.2, by design.
 */
export function compareDatabaseFacts(source: DatabaseFacts, target: DatabaseFacts): VerifyReport {
  const mismatches: string[] = [];

  if (source.schemaVersion !== target.schemaVersion) {
    mismatches.push(
      `schema_version is ${String(source.schemaVersion)} in the old database and ${String(target.schemaVersion)} in the new one`,
    );
  }

  for (const [table, before] of Object.entries(source.tables)) {
    const after = target.tables[table];
    if (after === undefined) {
      mismatches.push(`table ${table} is missing from the new database`);
    } else if (after.rows !== before.rows) {
      mismatches.push(`table ${table} has ${String(before.rows)} rows in the old database and ${String(after.rows)} in the new one`);
    } else if (after.digest !== before.digest) {
      mismatches.push(`table ${table} has the same ${String(before.rows)} rows but different content`);
    }
  }
  for (const table of Object.keys(target.tables)) {
    if (!(table in source.tables)) mismatches.push(`table ${table} is in the new database only`);
  }

  for (const [column, before] of Object.entries(source.vectorColumns)) {
    const after = target.vectorColumns[column];
    if (after === undefined) {
      mismatches.push(`vector column ${column} is missing from the new database`);
    } else if (after.nonNull !== before.nonNull || after.digest !== before.digest) {
      mismatches.push(`vector column ${column}: the vectors are not byte-equal`);
    }
  }
  for (const column of Object.keys(target.vectorColumns)) {
    if (!(column in source.vectorColumns)) mismatches.push(`vector column ${column} is in the new database only`);
  }

  for (const [id, before] of Object.entries(source.vectorSample)) {
    const after = target.vectorSample[id];
    if (after === undefined) mismatches.push(`knowledge_entries id ${id} is missing from the new database`);
    else if (after !== before) mismatches.push(`knowledge_entries id ${id}: the embedding is not byte-equal`);
  }

  for (const [sequence, before] of Object.entries(source.sequences)) {
    if (!(sequence in target.sequences)) mismatches.push(`sequence ${sequence} is missing from the new database`);
    else if (target.sequences[sequence] !== before) {
      mismatches.push(
        `sequence ${sequence} is at ${String(before)} in the old database and ${String(target.sequences[sequence])} in the new one`,
      );
    }
  }
  for (const sequence of Object.keys(target.sequences)) {
    if (!(sequence in source.sequences)) mismatches.push(`sequence ${sequence} is in the new database only`);
  }

  compareNameSets("index", source.indexes, target.indexes, mismatches);
  compareNameSets("constraint", source.constraints, target.constraints, mismatches);
  compareNameSets("extension", source.extensions, target.extensions, mismatches);
  if (source.largeObjects !== target.largeObjects) {
    mismatches.push(
      `${String(source.largeObjects)} large objects in the old database and ${String(target.largeObjects)} in the new one`,
    );
  }

  const shown =
    mismatches.length > MAX_REPORTED_MISMATCHES
      ? [...mismatches.slice(0, MAX_REPORTED_MISMATCHES), `and ${String(mismatches.length - MAX_REPORTED_MISMATCHES)} more`]
      : mismatches;
  return {
    ok: mismatches.length === 0,
    schemaVersion: source.schemaVersion,
    tables: Object.keys(source.tables).length,
    rows: Object.values(source.tables).reduce((sum, t) => sum + t.rows, 0),
    vectors: Object.values(source.vectorColumns).reduce((sum, c) => sum + c.nonNull, 0),
    sampledVectors: Object.keys(source.vectorSample).length,
    mismatches: shown,
  };
}

/* ------------------------------------------------------------------ *
 * Sessions.
 * ------------------------------------------------------------------ */

export interface PgEndpoint {
  readonly port: number;
  readonly password: string;
}

/**
 * The old database, held at one snapshot: `snapshotId` is handed to
 * `pg_dump --snapshot`, and `readFacts` reads the same snapshot, so the facts
 * describe exactly the rows the dump holds.
 */
export interface SourceSnapshot {
  readonly snapshotId: string;
  readonly databaseBytes: number;
  readFacts(): Promise<DatabaseFacts>;
  /** Ends the transaction (releasing the snapshot) and the connection. */
  close(): Promise<void>;
}

export interface DatabaseFactsReader {
  openSource(endpoint: PgEndpoint): Promise<SourceSnapshot>;
  readTarget(endpoint: PgEndpoint, sampleIds: readonly string[]): Promise<DatabaseFacts>;
}

const CONNECT_TIMEOUT_MS = 10_000;

async function connect(endpoint: PgEndpoint): Promise<pg.Client> {
  // No query timeout: a large table's digest legitimately takes a while.
  const client = new pg.Client({
    host: LOOPBACK_DB_HOST,
    port: endpoint.port,
    user: VEX_ROLE,
    password: endpoint.password,
    database: VEX_DATABASE,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    options: SESSION_OPTIONS,
    application_name: "vex-migration",
  });
  // An idle-connection error must not crash main; the next query reports it.
  client.on("error", () => {});
  await client.connect();
  return client;
}

export const pgDatabaseFactsReader: DatabaseFactsReader = {
  async openSource(endpoint) {
    const client = await connect(endpoint);
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const snapshot = await client.query<{ id: string }>("SELECT pg_export_snapshot() AS id");
      const size = await client.query<{ bytes: string }>("SELECT pg_database_size(current_database())::text AS bytes");
      const snapshotId = snapshot.rows[0]?.id;
      if (snapshotId === undefined) throw new Error("pg_export_snapshot returned no snapshot");
      return {
        snapshotId,
        databaseBytes: Number(size.rows[0]?.bytes ?? 0),
        readFacts: () => readDatabaseFacts(client),
        async close() {
          await client.query("ROLLBACK").catch(() => {});
          await client.end().catch(() => {});
        },
      };
    } catch (error) {
      await client.end().catch(() => {});
      throw error;
    }
  },

  async readTarget(endpoint, sampleIds) {
    const client = await connect(endpoint);
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const facts = await readDatabaseFacts(client, { sampleIds });
      await client.query("ROLLBACK");
      return facts;
    } finally {
      await client.end().catch(() => {});
    }
  },
};
