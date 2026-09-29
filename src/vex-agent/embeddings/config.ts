/**
 * Embeddings configuration — ENV validation at startup.
 *
 * Loads `EMBEDDING_*` env vars and validates them. Fail-fast on missing/invalid.
 *
 * Default runtime: standalone `llama.cpp:server` (provisioned by the vex-app
 * Compose stack) serving `ai/embeddinggemma:300M-Q8_0`, exposed on
 * http://127.0.0.1:27134/v1.
 *
 * EMBEDDING_DIM is config-driven. The schema's `vector` column has no typmod,
 * so any positive integer in [MIN_EMBEDDING_DIM, MAX_EMBEDDING_DIM] is accepted.
 * The actual response length is what gets stamped on each row's `embedding_dim`
 * audit column at write time, and recall filters on it.
 *
 * @see Team Standards §16.1 Config as code, §16.2 Validation at startup
 */

import logger from "@utils/logger.js";
import type { EmbeddingCallPolicy } from "./call-policy.js";

/** Minimum sane embedding dimension (rejects 0 / negative). */
export const MIN_EMBEDDING_DIM = 1;

/** Maximum sane embedding dimension (rejects unrealistic dims; covers Qwen3-8B 8192). */
export const MAX_EMBEDDING_DIM = 8192;

export interface EmbeddingConfig {
  /** Base URL of the embeddings provider. Client appends `/embeddings`. */
  baseUrl: string;
  /** Model identifier passed in the `model` field of every request. */
  model: string;
  /** Vector dimension. Must match what the provider actually returns at runtime. */
  dim: number;
  /** Provider tag for logging/observability. Free-form (e.g. "local", "openrouter"). */
  provider: string;
}

/**
 * Load and validate all embedding ENV variables.
 * Throws if any required value is missing or invalid.
 */
export function loadEmbeddingConfig(): EmbeddingConfig {
  const errors: string[] = [];

  const baseUrl = (process.env.EMBEDDING_BASE_URL ?? "").trim();
  if (!baseUrl) {
    errors.push("EMBEDDING_BASE_URL is required (e.g. http://127.0.0.1:27134/v1)");
  } else if (!baseUrl.startsWith("http://") && !baseUrl.startsWith("https://")) {
    errors.push(`EMBEDDING_BASE_URL="${baseUrl}" must start with http:// or https://`);
  }

  const model = (process.env.EMBEDDING_MODEL ?? "").trim();
  if (!model) {
    errors.push("EMBEDDING_MODEL is required (e.g. ai/embeddinggemma:300M-Q8_0)");
  }

  const rawDim = (process.env.EMBEDDING_DIM ?? "").trim();
  let dim = 0;
  if (!rawDim) {
    errors.push(
      `EMBEDDING_DIM is required (positive integer in [${MIN_EMBEDDING_DIM}, ${MAX_EMBEDDING_DIM}], must match what your model returns)`,
    );
  } else {
    const parsed = Number(rawDim);
    if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
      errors.push(`EMBEDDING_DIM="${rawDim}" must be a positive integer`);
    } else if (parsed < MIN_EMBEDDING_DIM || parsed > MAX_EMBEDDING_DIM) {
      errors.push(
        `EMBEDDING_DIM=${parsed} is out of range [${MIN_EMBEDDING_DIM}, ${MAX_EMBEDDING_DIM}]. ` +
          `If your model genuinely needs a larger dim, raise MAX_EMBEDDING_DIM in src/vex-agent/embeddings/config.ts.`,
      );
    } else {
      dim = parsed;
    }
  }

  const provider = (process.env.EMBEDDING_PROVIDER ?? "").trim();
  if (!provider) {
    errors.push("EMBEDDING_PROVIDER is required (e.g. local)");
  }

  if (errors.length > 0) {
    for (const err of errors) {
      logger.error("embeddings.config.validation_failed", { error: err });
    }
    throw new Error(`Embedding config validation failed:\n${errors.join("\n")}`);
  }

  return {
    baseUrl: baseUrl.replace(/\/$/, ""),
    model,
    dim,
    provider,
  };
}

// ── Internal constants (not from ENV — technical invariants) ─────

/** HTTP request timeout for embeddings calls (30s). */
export const EMBEDDING_REQUEST_TIMEOUT_MS = 30_000;

/** Max retry attempts on retryable errors (5xx, 429, transport). */
export const EMBEDDING_MAX_RETRIES = 2;

/** Initial backoff delay between retries. */
export const EMBEDDING_BASE_DELAY_MS = 1000;

/** Max backoff delay. */
export const EMBEDDING_MAX_DELAY_MS = 5000;

/**
 * The default for every caller that does not choose: memory and knowledge
 * writes, recall, re-embed jobs, health probes. Unchanged values (30 s per
 * attempt, 2 retries) - these paths prefer a slow answer to a missing vector.
 */
export const BACKGROUND_EMBEDDING_POLICY: EmbeddingCallPolicy = {
  attemptTimeoutMs: EMBEDDING_REQUEST_TIMEOUT_MS,
  maxRetries: EMBEDDING_MAX_RETRIES,
  baseDelayMs: EMBEDDING_BASE_DELAY_MS,
  maxDelayMs: EMBEDDING_MAX_DELAY_MS,
  jitter: true,
};
