/**
 * Forward-execution guard for the migration chain.
 *
 * A CHECK constraint or an index that references a column the table never
 * declares is not a style problem: `ALTER TABLE ... ADD CONSTRAINT ... CHECK
 * (tx_hash IS NULL)` raises `column "tx_hash" does not exist` and the whole
 * migration aborts on a CLEAN database — while every mocked unit test in this
 * repo stays green, because none of them execute SQL (see
 * `agent-activity-launch-check-shapes.test.ts`, which asserts on file text).
 * That is exactly how 062 shipped a chain that could not be applied.
 *
 * This test statically re-derives, in migration order, which columns each table
 * has at the moment a constraint or index is created, and fails when an
 * expression names a column that does not exist yet. It is a static guard, not
 * a substitute for applying the chain to a real Postgres, but it is the
 * strongest check that runs with no container and no database.
 */

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS_DIR = join(process.cwd(), "src/vex-agent/db/migrations");

/** SQL words and functions that may legally appear inside an expression. */
const SQL_WORDS = new Set([
  "and",
  "any",
  "array",
  "as",
  "asc",
  "between",
  "bigint",
  "boolean",
  "by",
  "case",
  "cast",
  "check",
  "coalesce",
  "date",
  "desc",
  "distinct",
  "double",
  "else",
  "end",
  "exists",
  "false",
  "first",
  "from",
  "in",
  "int",
  "integer",
  "interval",
  "is",
  "jsonb",
  "key",
  "last",
  "like",
  "not",
  "null",
  "nulls",
  "numeric",
  "on",
  "or",
  "precision",
  "select",
  "similar",
  "smallint",
  "text",
  "then",
  "timestamptz",
  "true",
  "unknown",
  "using",
  "value",
  "varchar",
  "when",
  "where",
  "with",
]);

/** Strips `--` comments, `/* *​/` comments and single-quoted literals. */
function stripNoise(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/'(?:[^']|'')*'/g, " ");
}

/** Returns the text inside the parentheses that start at `openIndex`. */
function readBalanced(sql: string, openIndex: number): { body: string; end: number } {
  let depth = 0;
  for (let i = openIndex; i < sql.length; i += 1) {
    const ch = sql[i];
    if (ch === "(") depth += 1;
    if (ch === ")") {
      depth -= 1;
      if (depth === 0) return { body: sql.slice(openIndex + 1, i), end: i };
    }
  }
  throw new Error(`Unbalanced parentheses at offset ${openIndex}`);
}

function splitTopLevel(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of body) {
    if (ch === "(") depth += 1;
    if (ch === ")") depth -= 1;
    if (ch === "," && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim() !== "") parts.push(current);
  return parts;
}

const NON_COLUMN_SEGMENT = /^(constraint|primary|unique|check|foreign|exclude|like)\b/i;

function identifiersIn(expression: string): string[] {
  const withoutCasts = expression.replace(/::\s*[a-zA-Z_][a-zA-Z0-9_]*(\s*\[\s*\])?/g, " ");
  const found: string[] = [];
  const pattern = /[a-zA-Z_][a-zA-Z0-9_]*/g;
  let match = pattern.exec(withoutCasts);
  while (match !== null) {
    const word = match[0];
    const isCall = /^\s*\(/.test(withoutCasts.slice(match.index + word.length));
    const isQualified = withoutCasts[match.index - 1] === ".";
    if (!isCall && !isQualified && !SQL_WORDS.has(word.toLowerCase())) {
      found.push(word.toLowerCase());
    }
    match = pattern.exec(withoutCasts);
  }
  return found;
}

interface Reference {
  readonly table: string;
  readonly context: string;
  readonly columns: readonly string[];
}

/**
 * Walks one migration file, updating `columns` as tables are created/altered
 * and collecting every constraint/index reference in the order it executes.
 */
function analyseMigration(sql: string, columns: Map<string, Set<string>>): Reference[] {
  const references: Reference[] = [];
  const clean = stripNoise(sql);

  const createTable = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/gi;
  let match = createTable.exec(clean);
  while (match !== null) {
    const table = match[1]!.toLowerCase();
    const { body } = readBalanced(clean, match.index + match[0].length - 1);
    const declared = columns.get(table) ?? new Set<string>();
    const checks: string[] = [];
    for (const segment of splitTopLevel(body)) {
      const trimmed = segment.trim();
      if (trimmed === "") continue;
      if (!NON_COLUMN_SEGMENT.test(trimmed)) {
        declared.add(trimmed.split(/\s+/)[0]!.toLowerCase());
      }
      const checkAt = trimmed.search(/\bCHECK\s*\(/i);
      if (checkAt >= 0) {
        checks.push(readBalanced(trimmed, trimmed.indexOf("(", checkAt)).body);
      }
    }
    columns.set(table, declared);
    for (const check of checks) {
      references.push({ table, context: "CREATE TABLE CHECK", columns: identifiersIn(check) });
    }
    match = createTable.exec(clean);
  }

  // One ALTER TABLE may add several columns in a single statement
  // (`ADD COLUMN a, ADD COLUMN b`), so scan the whole statement, not the
  // first clause.
  const alterTable = /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?([a-zA-Z_][a-zA-Z0-9_]*)/gi;
  match = alterTable.exec(clean);
  while (match !== null) {
    const table = match[1]!.toLowerCase();
    const semicolon = clean.indexOf(";", match.index);
    const statement = clean.slice(match.index, semicolon < 0 ? clean.length : semicolon);
    const added = statement.matchAll(
      /ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-zA-Z_][a-zA-Z0-9_]*)/gi,
    );
    const declared = columns.get(table) ?? new Set<string>();
    for (const column of added) declared.add(column[1]!.toLowerCase());
    if (declared.size > 0) columns.set(table, declared);
    match = alterTable.exec(clean);
  }

  const addCheck =
    /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?([a-zA-Z_][a-zA-Z0-9_]*)\s+ADD\s+CONSTRAINT\s+([a-zA-Z_][a-zA-Z0-9_]*)\s+CHECK\s*\(/gi;
  match = addCheck.exec(clean);
  while (match !== null) {
    const { body } = readBalanced(clean, match.index + match[0].length - 1);
    references.push({
      table: match[1]!.toLowerCase(),
      context: `ADD CONSTRAINT ${match[2]}`,
      columns: identifiersIn(body),
    });
    match = addCheck.exec(clean);
  }

  const createIndex =
    /CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?([a-zA-Z_][a-zA-Z0-9_]*)\s+ON\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*(?:USING\s+[a-zA-Z_][a-zA-Z0-9_]*\s*)?\(/gi;
  match = createIndex.exec(clean);
  while (match !== null) {
    const table = match[2]!.toLowerCase();
    const { body, end } = readBalanced(clean, match.index + match[0].length - 1);
    const tail = clean.slice(end + 1, clean.indexOf(";", end) + 1);
    const whereAt = tail.search(/\bWHERE\b/i);
    const predicate = whereAt >= 0 ? tail.slice(whereAt + 5) : "";
    references.push({
      table,
      context: `INDEX ${match[1]}`,
      // Only the FIRST identifier of each index element is a column; what
      // follows is an operator class or a sort option (`refs jsonb_path_ops`,
      // `created_at DESC`).
      columns: [
        ...splitTopLevel(body).flatMap((element) => identifiersIn(element).slice(0, 1)),
        ...identifiersIn(predicate),
      ],
    });
    match = createIndex.exec(clean);
  }

  return references;
}

describe("vex-agent/db migrations: constraint and index column references", () => {
  it("never references a column its table has not declared yet", () => {
    const files = readdirSync(MIGRATIONS_DIR)
      .filter((name) => name.endsWith(".sql"))
      .sort();
    expect(files.length).toBeGreaterThan(0);

    const columns = new Map<string, Set<string>>();
    const undeclared: string[] = [];

    for (const file of files) {
      const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
      for (const reference of analyseMigration(sql, columns)) {
        const declared = columns.get(reference.table);
        if (declared === undefined) continue; // table created by an earlier, unparsed shape
        for (const column of reference.columns) {
          if (!declared.has(column)) {
            undeclared.push(`${file}: ${reference.table}.${column} (${reference.context})`);
          }
        }
      }
    }

    expect(undeclared).toEqual([]);
  });
});
