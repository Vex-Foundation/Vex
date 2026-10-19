# Scaling — pgvector ANN migration plan

The vex-app knowledge store today uses pgvector's brute-force cosine-distance
scan (`<=>`) on a typmod-free `vector` column. This is accurate to the bit and
trivial to operate, but cost grows linearly with row count. This doc captures
when and how we migrate to an approximate-nearest-neighbour (ANN) index.

Owner: vex-app/main (DB layer).

## Current state

| Aspect | Today |
|---|---|
| Vector column | `embedding vector` (typmod-free — dimension stored row-by-row) |
| Active model filter | `WHERE embedding_model = $1 AND embedding_dim = $2` |
| Index | none (brute-force seq-scan on the table) |
| Migration shape | each SQL file wrapped in a single transaction by the runner |

Brute force comfortably serves the demo / early-adopter scale (a few thousand
entries). It hits a wall when query latency starts being dominated by the
scan itself.

## Migration trigger

We do NOT pre-emptively add an ANN index. Two signals together (or either at
the high end) gate the migration:

| Signal | Threshold | How to measure |
|---|---|---|
| p95 query latency | > 200 ms sustained over a 24h window | Postgres `pg_stat_statements` or app-side timing on the embedding search IPC handler |
| Row count for the active `(embedding_model, embedding_dim)` slice | 50 000 – 100 000 entries | `SELECT count(*) FROM knowledge_entries WHERE embedding_model = $1 AND embedding_dim = $2` |

Cross the latency line OR settle into the 50–100k row range and we
re-evaluate. Don't add an index just to "be safe" — HNSW recall tuning is
its own operational burden and the cost is not free at write time either.

## HNSW — the chosen approach

Among pgvector's two index families, HNSW is the right pick for our workload:

- Workload is read-heavy (search) with bursts of writes (knowledge ingest);
  HNSW handles incremental inserts gracefully.
- We need high recall (we're returning context to an LLM, missed-neighbour
  cost is bad). HNSW tunes for higher recall than IVFFlat at comparable
  speed.
- We do NOT want a separate `ANALYZE`-style training step. IVFFlat needs
  one (the centroids); HNSW does not.

HNSW does **not** use `lists` (that is IVFFlat). The tunables we care about:

| Parameter | Default | Where it lives | Effect |
|---|---|---|---|
| `m` | 16 | `CREATE INDEX ... WITH (m = N)` | Graph density. Higher = better recall, slower build, more memory. Raise to 32 for higher recall when memory budget allows. |
| `ef_construction` | 64 | `CREATE INDEX ... WITH (ef_construction = N)` | Build-time search depth. Higher = better recall, slower build. Raise to 128 if measured recall is below target. |
| `hnsw.ef_search` | 40 | `SET hnsw.ef_search = N` (session GUC) | Query-time search depth. Higher = better recall, slower query. Tune this FIRST when chasing recall. |

## Dimension constraint — partial-index approach

Our `embedding` column is typmod-free (`vector` with no explicit dimension),
because we support multiple embedding models with different output dims.
ANN indexes in pgvector require a **fixed dimension** at index time.

The migration plan: a **partial index per active model**, casting the
column to the model's known dim.

```sql
-- Example for a model whose embeddings are 768-dimensional.
-- Replace `'active-model-name'` with the actual value from
--   SELECT DISTINCT embedding_model, embedding_dim FROM knowledge_entries
-- on the live install. The configured default in vex-app is
-- `ai/embeddinggemma:300M-Q8_0`, but stored rows may use a provider-reported
-- alias depending on which embeddings runtime served them.
CREATE INDEX knowledge_entries_embedding_active_hnsw
  ON knowledge_entries
  USING hnsw ((embedding::vector(768)) vector_cosine_ops)
  WITH (m = 16, ef_construction = 64)
  WHERE embedding_model = 'active-model-name'
    AND embedding_dim = 768;
```

This:
- Lets the planner use the index for the active model only — other rows are
  served by the brute-force fallback, which is fine because they're rare or
  legacy.
- Forces the cast at index-create time, satisfying the fixed-dim requirement.
- Stays a single SQL statement (no schema column split, no data migration).
- Survives a model change: drop the old partial index, build a new one for
  the new `(model, dim)`. Brute force serves searches during the gap.

### Query must mirror the index expression

The app's similarity query MUST use the exact same cast expression and
predicates that the index was built with, or the planner will fall back to
the seq-scan. Example:

```sql
SELECT id, /* ... */
FROM knowledge_entries
WHERE embedding_model = 'active-model-name'
  AND embedding_dim = 768
ORDER BY embedding::vector(768) <=> $query::vector(768)
LIMIT 10;
```

Both `embedding_model` and `embedding_dim` predicates are required to match
the partial-index `WHERE` clause. The `embedding::vector(768)` cast on the
ordering expression must match the indexed expression byte-for-byte (same
dimension literal, same operator class `vector_cosine_ops`).

If we later want to support several models concurrently with ANN, we add
one partial index per active `(model, dim)` pair. The planner picks the
matching one based on the predicate.

## Migration runner — transaction-wrap issue

The vex-app migration runner today wraps each migration file in a single
transaction. PostgreSQL refuses `CREATE INDEX CONCURRENTLY` inside a
transaction, and a regular `CREATE INDEX` takes an ACCESS EXCLUSIVE lock
that blocks all writes for the entire build duration (minutes on large
tables).

Two options for the ANN migration:

1. **Future runner extension (recommended)** — add a `noTransaction: true`
   per-migration flag to the runner so individual migrations can opt out of
   the auto-BEGIN/COMMIT wrap. The runner then runs the file's statements
   one-shot against the connection with autocommit. This keeps the migration
   shape ("here's a SQL file, here's its number") but lets ANN migrations
   use `CREATE INDEX CONCURRENTLY`.

   Not implemented yet. Lands when the trigger condition above forces our
   hand. Until then, ship the migration as option 2.

2. **Maintenance-window one-shot** — until the runner extension lands,
   apply the ANN index manually:

   ```bash
   # 1. Announce a brief read-only window to ourselves (no concurrent writes).
   # 2. Connect to the app's bundled Postgres while the app runs. Vex ships
   #    no psql; use any psql 13+ client. The port is pg.lastPort in
   #    runtime-state.json (RUNTIME_DIR: CONFIG_DIR/runtime, or
   #    %LOCALAPPDATA%\vex\runtime on Windows).
   PGPASSWORD="$(cat "$CONFIG_DIR/local-infra/secrets/pg_password")" \
     psql -h 127.0.0.1 -p <pg.lastPort> -U vex -d vex

   -- 3. Run the partial index creation without an explicit transaction.
   -- (psql autocommits between statements when run outside `\transaction`).
   CREATE INDEX CONCURRENTLY knowledge_entries_embedding_active_hnsw
     ON knowledge_entries
     USING hnsw ((embedding::vector(768)) vector_cosine_ops)
     WITH (m = 16, ef_construction = 64)
     WHERE embedding_model = 'active-model-name' AND embedding_dim = 768;

   -- 4. Verify it's valid:
   SELECT indexrelid::regclass, indisvalid
   FROM pg_index
   WHERE indrelid = 'knowledge_entries'::regclass;
   ```

   `CREATE INDEX CONCURRENTLY` does not block reads or writes during the
   build but DOES double the IO. Pick a low-traffic window.

   This bypass is a **deliberate operator action**, not part of the
   automated migration flow. Record it in the QA changelog so the next
   release notes the index is present.

## Recall validation after migration

Build a small ground-truth set first (one-time cost):

1. Pick 200 representative queries from real recent traffic (or a
   curated set).
2. Run each through the brute-force scan, save the top-10 IDs as
   "true neighbours".
3. After the index lands, run the same 200 queries against the indexed
   table.
4. Compute recall@10 = (#shared IDs) / 10 per query, average across the
   set.

Target: **recall@10 ≥ 95%**. If below, raise `hnsw.ef_search` first (no
rebuild needed), then `m` and `ef_construction` (rebuild needed).

## Rollback

Brute-force still works without the index. If the ANN migration causes
problems:

```sql
DROP INDEX CONCURRENTLY knowledge_entries_embedding_active_hnsw;
```

No data lost. Latency returns to brute-force levels. Investigate, retune,
retry.

## Out of scope here

- IVFFlat (chosen against — see "HNSW — the chosen approach").
- Hybrid search (full-text + vector). Separate decision when search quality,
  not just latency, becomes the bottleneck.
- Reranking / cross-encoder pass. Lives at the application layer, not the DB.
- The runner-side `noTransaction` flag implementation. Tracked as a future
  item under `#13` follow-ups; not implemented in this docs PR.
