/**
 * Provider configuration writer (M10 Step 6).
 *
 * Stores the OpenRouter API key in the encrypted local secret vault and
 * writes only non-secret provider selection to `.env`.
 *
 * Returns fields in canonical UI order:
 *   1. OPENROUTER_API_KEY      (stored in the encrypted vault)
 *   2. AGENT_MODEL            (stored in `.env`)
 *   3. AGENT_PROVIDER=openrouter
 *
 * Caller (IPC handler) wraps this in `withEnvWriteLock`.
 *
 * Logging: only canonical key NAMES + correlationId via the caller.
 * The writer itself logs only the file path on success. NEVER logs
 * apiKey value, length, model value, or any prefix/suffix preview.
 */

import { appendMultipleToDotenvFile } from "@vex-lib/dotenv.js";
import { err, ok, type Result } from "@shared/ipc/result.js";
import {
  PROVIDER_PERSIST_BASE_FIELDS,
  PROVIDER_PERSIST_CANONICAL_ORDER,
  PROVIDER_PERSIST_FALLBACK_FIELDS,
  type ProviderPersistInput,
} from "@shared/schemas/provider.js";
import { ENV_FILE } from "../paths/config-dir.js";
import { log } from "../logger/index.js";
import { writeUnlockedSecrets } from "../secrets/session.js";
import { stripManagedSecretsFromDotenvFile } from "@vex-lib/local-secret-vault.js";

export interface ProviderWriterOptions {
  /** Override `ENV_FILE` for tests; production callers omit. */
  readonly envFile?: string;
}

type CanonicalKey = (typeof PROVIDER_PERSIST_CANONICAL_ORDER)[number];

const PROVIDER_AGENT_VALUE = "openrouter";

export interface ProviderWriteResult {
  readonly fieldsWritten: ReadonlyArray<CanonicalKey>;
}

/**
 * Persists the provider secret plus non-secret provider selection. Returns
 * the full canonical fieldsWritten array on success so the renderer can
 * keep the existing completion summary.
 */
export async function writeProvider(
  input: ProviderPersistInput,
  options: ProviderWriterOptions = {},
): Promise<Result<ProviderWriteResult>> {
  const targetFile = options.envFile ?? ENV_FILE;

  // Both-or-neither is enforced by the input schema; read as a single unit.
  const fallback =
    input.fallbackApiKey !== undefined && input.fallbackModel !== undefined
      ? { apiKey: input.fallbackApiKey, model: input.fallbackModel }
      : null;

  try {
    // `null` CLEARS. A reconfigure that omits the fallback must remove any
    // previously stored one — otherwise a stale key/model pair would keep
    // silently serving as the failover target after the operator dropped it.
    const secretWrite = writeUnlockedSecrets({
      OPENROUTER_API_KEY: input.apiKey,
      OPENROUTER_API_KEY_FALLBACK: fallback?.apiKey ?? null,
    });
    if (!secretWrite.ok) return secretWrite;
    stripManagedSecretsFromDotenvFile(targetFile);
    appendMultipleToDotenvFile(
      {
        OPENROUTER_API_KEY: null,
        AGENT_MODEL: input.model,
        AGENT_PROVIDER: PROVIDER_AGENT_VALUE,
        OPENROUTER_API_KEY_FALLBACK: null,
        AGENT_MODEL_FALLBACK: fallback?.model ?? null,
      },
      targetFile,
    );
  } catch (cause) {
    log.error(
      `[provider-writer] failed to persist provider keys to ${targetFile}`,
      cause,
    );
    return err({
      code: "onboarding.env_persist_failed",
      domain: "onboarding",
      message:
        "Couldn't save provider configuration to disk. Check disk space and permissions, then retry.",
      retryable: true,
      userActionable: true,
      redacted: true,
      details: { verified: true, partialFieldsWritten: [] },
    });
  }

  log.info(
    `[provider-writer] persisted provider keys to ${targetFile} ` +
      `fallbackConfigured=${fallback !== null}`,
  );
  return ok({
    fieldsWritten: (fallback !== null
      ? [...PROVIDER_PERSIST_BASE_FIELDS, ...PROVIDER_PERSIST_FALLBACK_FIELDS]
      : [...PROVIDER_PERSIST_BASE_FIELDS]) as ReadonlyArray<CanonicalKey>,
  });
}
