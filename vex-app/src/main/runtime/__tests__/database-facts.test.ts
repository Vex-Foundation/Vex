/**
 * The verify rules: the copy counts only when every fact of the old database
 * holds in the new one. A single missing row, a single changed value or a
 * single changed vector must fail. (The SQL that reads the facts runs against
 * real servers in docker-to-native.real.test.ts.)
 */

import { describe, expect, it } from "vitest";
import { compareDatabaseFacts, type DatabaseFacts } from "../migration/database-facts.js";

function sourceFacts(): DatabaseFacts {
  return {
    schemaVersion: 177,
    tables: {
      "public.schema_version": { rows: 169, digest: "d-schema" },
      "public.sessions": { rows: 3, digest: "d-sessions" },
      "public.messages": { rows: 40, digest: "d-messages" },
      "public.knowledge_entries": { rows: 5, digest: "d-ke" },
      "public.empty_table": { rows: 0, digest: null },
    },
    vectorColumns: { "public.knowledge_entries.embedding": { nonNull: 5, digest: "v-ke" } },
    vectorSample: { "1": "aa", "2": "bb", "3": "cc", "4": "dd", "5": "ee" },
    sequences: { "public.knowledge_entries_id_seq": "5", "public.unused_seq": null },
    indexes: ["public.knowledge_entries_pkey", "public.messages_pkey"],
    constraints: ["public.knowledge_entries.ke_embedding_dim_matches_vector:c"],
    extensions: ["plpgsql", "vector"],
    largeObjects: 0,
  };
}

describe("compareDatabaseFacts", () => {
  it("identical facts pass, and the report says what was checked", () => {
    expect(compareDatabaseFacts(sourceFacts(), sourceFacts())).toEqual({
      ok: true,
      schemaVersion: 177,
      tables: 5,
      rows: 217,
      vectors: 5,
      sampledVectors: 5,
      mismatches: [],
    });
  });

  it.each<[string, (f: DatabaseFacts) => DatabaseFacts, string]>([
    ["one missing row", (f) => ({ ...f, tables: { ...f.tables, "public.sessions": { rows: 2, digest: "x" } } }),
      "table public.sessions has 3 rows in the old database and 2 in the new one"],
    ["same count, one value changed", (f) => ({ ...f, tables: { ...f.tables, "public.sessions": { rows: 3, digest: "x" } } }),
      "table public.sessions has the same 3 rows but different content"],
    ["a missing table", (f) => ({ ...f, tables: Object.fromEntries(Object.entries(f.tables).filter(([k]) => k !== "public.messages")) }),
      "table public.messages is missing from the new database"],
    ["an extra table", (f) => ({ ...f, tables: { ...f.tables, "public.intruder": { rows: 0, digest: null } } }),
      "table public.intruder is in the new database only"],
    ["another schema_version", (f) => ({ ...f, schemaVersion: 176 }),
      "schema_version is 177 in the old database and 176 in the new one"],
    ["a changed sample vector", (f) => ({ ...f, vectorSample: { ...f.vectorSample, "2": "b0" } }),
      "knowledge_entries id 2: the embedding is not byte-equal"],
    ["a missing sample row", (f) => ({ ...f, vectorSample: Object.fromEntries(Object.entries(f.vectorSample).filter(([k]) => k !== "5")) }),
      "knowledge_entries id 5 is missing from the new database"],
    ["a vector column whose bytes differ", (f) => ({ ...f, vectorColumns: { "public.knowledge_entries.embedding": { nonNull: 5, digest: "w" } } }),
      "vector column public.knowledge_entries.embedding: the vectors are not byte-equal"],
    ["a vector column that lost a value", (f) => ({ ...f, vectorColumns: { "public.knowledge_entries.embedding": { nonNull: 4, digest: "v-ke" } } }),
      "vector column public.knowledge_entries.embedding: the vectors are not byte-equal"],
    ["a sequence behind", (f) => ({ ...f, sequences: { ...f.sequences, "public.knowledge_entries_id_seq": "1" } }),
      "sequence public.knowledge_entries_id_seq is at 5 in the old database and 1 in the new one"],
    ["a missing sequence", (f) => ({ ...f, sequences: { "public.knowledge_entries_id_seq": "5" } }),
      "sequence public.unused_seq is missing from the new database"],
    ["a missing index", (f) => ({ ...f, indexes: ["public.messages_pkey"] }),
      "index public.knowledge_entries_pkey is missing from the new database"],
    ["a missing constraint", (f) => ({ ...f, constraints: [] }),
      "constraint public.knowledge_entries.ke_embedding_dim_matches_vector:c is missing from the new database"],
    ["a missing extension", (f) => ({ ...f, extensions: ["plpgsql"] }),
      "extension vector is missing from the new database"],
    ["a large-object count that differs", (f) => ({ ...f, largeObjects: 1 }),
      "0 large objects in the old database and 1 in the new one"],
  ])("fails on %s", (_label, mutate, expected) => {
    const report = compareDatabaseFacts(sourceFacts(), mutate(sourceFacts()));
    expect(report.ok).toBe(false);
    expect(report.mismatches).toEqual([expected]);
  });

  it("caps the reported list but not the verdict", () => {
    const many: Record<string, { rows: number; digest: string }> = {};
    for (let i = 0; i < 80; i++) many[`public.t${String(i)}`] = { rows: 1, digest: "a" };
    const report = compareDatabaseFacts({ ...sourceFacts(), tables: many }, { ...sourceFacts(), tables: {} });
    expect(report.ok).toBe(false);
    expect(report.mismatches).toHaveLength(51);
    expect(report.mismatches.at(-1)).toBe("and 30 more");
  });
});
