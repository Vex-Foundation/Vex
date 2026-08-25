/**
 * Vitest globalSetup for integration tests.
 *
 * Spins up an ephemeral Postgres (pgvector) container via testcontainers,
 * wires `VEX_DB_URL`, and runs the full migration chain. The Gemma
 * embeddings endpoint is NOT managed here — it's the standalone
 * `llama.cpp:server` provisioned by the vex-app Compose stack (default
 * http://127.0.0.1:27134/v1) and must be running independently. A
 * reachability probe fails fast with an actionable message so tests don't
 * hang on first embed.
 *
 * Dynamic imports are deliberate: the db client pool singleton reads
 * `VEX_DB_URL` on first `getPool()` call, so we MUST set the env var
 * BEFORE any repo module resolves `client.js`.
 */

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";

let container: StartedPostgreSqlContainer | null = null;

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
  if (container) {
    await container.stop();
    container = null;
  }
}

async function assertEmbeddingsReachable(): Promise<void> {
  const baseUrl = process.env.EMBEDDING_BASE_URL;
  if (!baseUrl) {
    throw new Error(
      "EMBEDDING_BASE_URL is not set. Integration suite needs a live embeddings endpoint. " +
        "Launch the Vex desktop app once so its Compose stack's llama.cpp embeddings runtime is up " +
        "(default http://127.0.0.1:27134/v1), or point EMBEDDING_BASE_URL at any OpenAI-compatible /v1 endpoint.",
    );
  }
  const model = process.env.EMBEDDING_MODEL ?? FALLBACK_EMBED_MODEL;
  try {
    const res = await fetch(`${baseUrl}/embeddings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, input: "probe" }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
  } catch (err) {
    throw new Error(
      `Embeddings endpoint unreachable at ${baseUrl} (model=${model}). ` +
        `Start the vex-app Compose stack's llama.cpp embeddings runtime (or whatever serves this URL). ` +
        `Underlying error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
