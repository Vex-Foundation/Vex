/**
 * Vitest globalSetup for integration tests.
 *
 * Spins up an ephemeral Postgres (pgvector) container via testcontainers,
 * wires `VEX_DB_URL`, and runs the full migration chain. The Gemma
 * embeddings endpoint is NOT managed here: `EMBEDDING_BASE_URL` must name a
 * running OpenAI-compatible /v1 server for `ai/embeddinggemma:300M-Q8_0`
 * (768 dims), with `EMBEDDING_API_KEY` when it wants one. The desktop app's
 * own server picks its port and key per launch, so start one yourself: the
 * bundled llama-server command is in vex-app/docs/LOCAL_RUNTIME.md
 * ("Embeddings for the integration suite"). No CI lane runs this suite; the
 * required Studio lane uses `setupPostgresWithoutEmbeddings`. A reachability
 * probe fails fast with an actionable message so tests don't hang on first
 * embed.
 *
 * Dynamic imports are deliberate: the db client pool singleton reads
 * `VEX_DB_URL` on first `getPool()` call, so we MUST set the env var
 * BEFORE any repo module resolves `client.js`.
 *
 * `VEX_TEST_PG=native` runs the same suites against the bundled native
 * Postgres instead of the container (see `native-postgres.ts`).
 */

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { startNativePostgres, type NativePostgres } from "./native-postgres.js";

let container: StartedPostgreSqlContainer | null = null;
let native: NativePostgres | null = null;

const PGVECTOR_IMAGE = "pgvector/pgvector:0.8.2-pg18-trixie";
const FALLBACK_EMBED_MODEL = "ai/embeddinggemma:300M-Q8_0";

export async function setup(): Promise<void> {
  await startPostgres();
  await assertEmbeddingsReachable();
  await migratePostgres();
}

/** Studio's required CI lane needs PostgreSQL and migrations, not embeddings. */
export async function setupPostgresWithoutEmbeddings(): Promise<void> {
  await startPostgres();
  await migratePostgres();
}

async function startPostgres(): Promise<void> {
  if (process.env.VEX_TEST_PG === "native") {
    native = await startNativePostgres("vex_test");
    process.env.VEX_DB_URL = native.url;
    return;
  }
  try {
    container = await new PostgreSqlContainer(PGVECTOR_IMAGE)
      .withDatabase("vex_test")
      .withUsername("vex")
      .withPassword("vex")
      .start();
  } catch (err) {
    throw new Error(
      `Failed to start pgvector container (image=${PGVECTOR_IMAGE}). ` +
        `Is Docker running? Underlying error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  process.env.VEX_DB_URL = container.getConnectionUri();
}

async function migratePostgres(): Promise<void> {
  const { runMigrations } = await import("@vex-agent/db/migrate.js");
  await runMigrations();
}

export async function teardown(): Promise<void> {
  try {
    const { closePool } = await import("@vex-agent/db/client.js");
    await closePool();
  } catch {
    // Best-effort — pool teardown errors shouldn't mask container.stop().
  }
  if (native) {
    await native.stop();
    native = null;
  }
  if (container) {
    await container.stop();
    container = null;
  }
}

const EMBEDDINGS_HOWTO =
  "Start the bundled llama-server with the pinned model (vex-app/docs/LOCAL_RUNTIME.md, " +
  '"Embeddings for the integration suite") and set EMBEDDING_BASE_URL to its /v1 URL, or point it at any ' +
  "OpenAI-compatible /v1 endpoint serving that model (EMBEDDING_API_KEY if it needs a key).";

async function assertEmbeddingsReachable(): Promise<void> {
  const baseUrl = process.env.EMBEDDING_BASE_URL;
  if (!baseUrl) {
    throw new Error(
      `EMBEDDING_BASE_URL is not set. The integration suite needs a live embeddings endpoint. ${EMBEDDINGS_HOWTO}`,
    );
  }
  const model = process.env.EMBEDDING_MODEL ?? FALLBACK_EMBED_MODEL;
  const apiKey = (process.env.EMBEDDING_API_KEY ?? "").trim();
  try {
    const res = await fetch(`${baseUrl}/embeddings`, {
      method: "POST",
      // The same bearer the engine's client sends (src/vex-agent/embeddings/client.ts).
      headers: { "content-type": "application/json", ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
      body: JSON.stringify({ model, input: "probe" }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
  } catch (err) {
    throw new Error(
      `Embeddings endpoint unreachable at ${baseUrl} (model=${model}). ${EMBEDDINGS_HOWTO} ` +
        `Underlying error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
