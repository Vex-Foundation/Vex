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
  PROVIDER_ENDPOINT_TAG_ENV_KEY,
  PROVIDER_PERSIST_CANONICAL_ORDER,
  type ProviderPersistFieldName,
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
  readonly fieldsWritten: ReadonlyArray<ProviderPersistFieldName>;
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

  // Delta-save: an ABSENT `apiKey` means "keep the stored key". The vault
  // entry is then left completely untouched — we do not read-then-rewrite it,
  // so a keep-key model change cannot corrupt or re-encrypt a working secret.
  // The caller has already verified the selection against the stored key.
  const rotatedApiKey = input.apiKey;

  const updates: Record<Exclude<CanonicalKey, "OPENROUTER_API_KEY">, string> = {
    AGENT_MODEL: input.model,
    AGENT_PROVIDER: PROVIDER_AGENT_VALUE,
  };

  // "Auto (recommended)" is the ABSENCE of a pin, so it must actively erase a
  // previous one: `null` deletes the key from `.env` in the same atomic
  // read-replace-rename as the model/provider write. A file-only delete is
  // not enough — `loadProviderDotenv` (which the caller runs next) only SETS
  // keys the file contains, so a pin already resident in `process.env` from a
  // prior configuration would survive reconfiguration and keep routing to the
  // old endpoint. Deleting it here, inside the env-write lock, closes that.
  const endpointTag = input.endpointTag?.trim();
  const pinnedTag =
    endpointTag !== undefined && endpointTag.length > 0 ? endpointTag : null;

  try {
    if (rotatedApiKey !== undefined) {
      const secretWrite = writeUnlockedSecrets({
        OPENROUTER_API_KEY: rotatedApiKey,
      });
      if (!secretWrite.ok) return secretWrite;
    }
    // Runs on BOTH paths: any plaintext managed secret left in `.env` by a
    // manual edit is scrubbed even when this save rotates nothing.
    stripManagedSecretsFromDotenvFile(targetFile);
    appendMultipleToDotenvFile(
      {
        OPENROUTER_API_KEY: null,
        AGENT_MODEL: updates.AGENT_MODEL,
        AGENT_PROVIDER: updates.AGENT_PROVIDER,
        [PROVIDER_ENDPOINT_TAG_ENV_KEY]: pinnedTag,
      },
      targetFile,
    );
    if (pinnedTag === null) {
      delete process.env[PROVIDER_ENDPOINT_TAG_ENV_KEY];
    }
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

  log.info(`[provider-writer] persisted provider keys to ${targetFile}`);
  // Report only what this save actually wrote, in canonical order. The vault
  // key is omitted on a keep-key delta save and the pin key on "Auto" — both
  // are absent from THIS write, and claiming them would be a lie.
  const fieldsWritten: ReadonlyArray<ProviderPersistFieldName> = [
    ...PROVIDER_PERSIST_CANONICAL_ORDER.filter(
      (field) => field !== "OPENROUTER_API_KEY" || rotatedApiKey !== undefined,
    ),
    ...(pinnedTag !== null ? ([PROVIDER_ENDPOINT_TAG_ENV_KEY] as const) : []),
  ];
  return ok({ fieldsWritten });
}
