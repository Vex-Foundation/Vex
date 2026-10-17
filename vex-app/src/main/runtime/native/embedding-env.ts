/**
 * Points the engine's embeddings at the native llama-server.
 *
 * The engine reads `process.env.EMBEDDING_*` on every call
 * (`src/vex-agent/embeddings/config.ts`). For the native runtime, main writes
 * the LIVE endpoint there: the server listens on a port chosen at launch and
 * takes a per-launch key, so neither may ever be persisted to `.env`. The
 * file keeps the bundled tuple setup wrote, which names the same model.
 *
 * Only while the user is on the bundled embeddings: a configured remote
 * provider (any other provider tag or model) is left untouched. With nothing
 * configured yet (first run, before setup writes the bundled tuple) the
 * bundled engine is what the app uses, so it is applied too.
 *
 * `applyNativeEmbeddingEnv()` re-applies the live endpoint; the onboarding
 * paths that reload `.env` with overwrite call it right after, otherwise the
 * file's default URL would replace the live one.
 */

import { EMBEDDING_DIM, EMBEDDING_MODEL_ALIAS, EMBEDDING_PROVIDER } from "@shared/embedding-defaults.js";
import type { RuntimeEndpoints } from "../provider.js";

type EmbeddingsEndpoint = RuntimeEndpoints["embeddings"];

let live: EmbeddingsEndpoint | null = null;

export function isBundledEmbeddingSelection(env: NodeJS.ProcessEnv): boolean {
  const provider = env["EMBEDDING_PROVIDER"];
  const model = env["EMBEDDING_MODEL"];
  if (!env["EMBEDDING_BASE_URL"] && !provider && !model) return true;
  return provider === EMBEDDING_PROVIDER && model === EMBEDDING_MODEL_ALIAS;
}

/**
 * The endpoint the runtime host last published: the live llama-server URL
 * and its per-launch key, or null while the server is down or not started.
 * The embedding status probe reads it in native mode instead of `.env`, whose
 * URL only names the bundled default and never the live port.
 */
export function liveNativeEmbeddings(): EmbeddingsEndpoint | null {
  return live;
}

/** The runtime host's onEmbeddings publisher. */
export function publishNativeEmbeddings(
  endpoint: EmbeddingsEndpoint | null,
  env: NodeJS.ProcessEnv = process.env,
): void {
  live = endpoint;
  applyNativeEmbeddingEnv(env);
}

export function applyNativeEmbeddingEnv(env: NodeJS.ProcessEnv = process.env): void {
  if (!isBundledEmbeddingSelection(env)) return;
  if (live === null) {
    // The server is down or restarting: its key is dead, the URL stays so a
    // request fails as unreachable (and retries) rather than as unconfigured.
    delete env["EMBEDDING_API_KEY"];
    return;
  }
  env["EMBEDDING_BASE_URL"] = live.baseUrl;
  env["EMBEDDING_MODEL"] = EMBEDDING_MODEL_ALIAS;
  env["EMBEDDING_DIM"] = String(EMBEDDING_DIM);
  env["EMBEDDING_PROVIDER"] = EMBEDDING_PROVIDER;
  if (live.apiKey === null) delete env["EMBEDDING_API_KEY"];
  else env["EMBEDDING_API_KEY"] = live.apiKey;
}
