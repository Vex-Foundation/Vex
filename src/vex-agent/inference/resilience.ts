/**
 * Retry and timeout utilities for inference-adjacent calls.
 *
 * Consumed only by `embeddings/client.ts` (idempotent embedding reads). The
 * OpenRouter provider does NOT use these — its retry/backoff/timeout are
 * handled by the `@openrouter/sdk` client config.
 * Never used for writes or streaming — only idempotent reads.
 */

import logger from "@utils/logger.js";

// ── Retry ────────────────────────────────────────────────────────

export interface RetryOptions {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs?: number;
  jitter?: boolean;
  /** Only retry if this returns true. Default: retry all errors. */
  shouldRetry?: (err: Error) => boolean;
}

export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  opts: RetryOptions,
  label?: string,
): Promise<T> {
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt === opts.maxRetries) break;
      if (opts.shouldRetry && !opts.shouldRetry(lastError)) break;

      const delay = Math.min(
        opts.baseDelayMs * Math.pow(2, attempt)
          + (opts.jitter ? Math.random() * opts.baseDelayMs : 0),
        opts.maxDelayMs ?? 30_000,
      );

      if (label) {
        logger.debug("inference.retry", {
          label,
          attempt: attempt + 1,
          delayMs: Math.round(delay),
          error: lastError.message,
        });
      }

      await new Promise((r) => setTimeout(r, delay));
    }
  }

  throw lastError!;
}

// ── Error classification ─────────────────────────────────────────

/**
 * Classify an error as retryable (transport/server) vs non-retryable (client/logic).
 * Retryable: 5xx, 429, transport errors (ETIMEDOUT, ECONNRESET, ECONNREFUSED).
 * Non-retryable: 4xx (except 429), AbortError.
 */
export function isRetryableError(err: Error): boolean {
  if (err.name === "AbortError") return false;

  if ("code" in err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ETIMEDOUT" || code === "ECONNRESET" || code === "ECONNREFUSED") return true;
  }

  const msg = err.message;
  if (msg.includes("returned 502") || msg.includes("returned 503") || msg.includes("returned 429")) return true;
  if (msg.includes("returned 5")) return true;
  if (msg.includes("returned 4")) return false;

  return true;
}
