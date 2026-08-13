/**
 * API keys writer (M9 Step 3).
 *
 * Writes API/provider secrets into the encrypted local secret vault.
 * `.env` is intentionally not used for any API key.
 *
 * Logging: only the canonical key NAMES being written get logged.
 * NEVER the value, the length, or any prefix/suffix preview. The
 * envelope returned to the renderer carries `fieldsWritten` in
 * canonical order so UI can render "Set: JUPITER_API_KEY, ..."
 * without secrets crossing the boundary.
 */

import { ok, type Result } from "@shared/ipc/result.js";
import { err } from "@shared/ipc/result.js";
import {
  API_KEYS_CANONICAL_ORDER,
  type ApiKeysSetInput,
  type ApiKeysSetResult,
} from "@shared/schemas/api-keys.js";
import { parseLighterReadOnlyAuthToken } from "@tools/lighter/auth-token.js";
import type { LighterEnvironment } from "@tools/lighter/constants.js";
import { log } from "../logger/index.js";
import { writeUnlockedSecrets } from "../secrets/session.js";

export interface ApiKeysWriterOptions {
  /** Override `ENV_FILE` for tests; production callers omit. */
  readonly envFile?: string;
}

type CanonicalKey = (typeof API_KEYS_CANONICAL_ORDER)[number];

const API_KEYS_WRITER_CORRELATION_ID = "api-keys-writer";

function validateLighterReadOnlyToken(
  environment: LighterEnvironment,
  token: string,
): Result<void> {
  try {
    const metadata = parseLighterReadOnlyAuthToken(environment, token);
    if (metadata.expired) {
      return err({
        code: "provider.invalid_api_key",
        domain: "onboarding",
        message: `The Lighter ${environment.toUpperCase()} read-only token is expired. Generate a fresh read-only token and try again.`,
        retryable: true,
        userActionable: true,
        redacted: true,
        correlationId: API_KEYS_WRITER_CORRELATION_ID,
      });
    }
    return ok(undefined);
  } catch {
    return err({
      code: "provider.invalid_api_key",
      domain: "onboarding",
      message: `The Lighter ${environment.toUpperCase()} credential must be a read-only token beginning with ro:. Do not paste a trading API private key here.`,
      retryable: true,
      userActionable: true,
      redacted: true,
      correlationId: API_KEYS_WRITER_CORRELATION_ID,
    });
  }
}

export async function writeApiKeys(
  input: ApiKeysSetInput,
  _options: ApiKeysWriterOptions = {},
): Promise<Result<ApiKeysSetResult>> {
  // Build the write plan in canonical order so fieldsWritten is
  // deterministic regardless of object iteration order.
  const writes: Array<{ key: CanonicalKey; value: string }> = [];
  if (input.jupiterApiKey !== undefined) {
    writes.push({ key: "JUPITER_API_KEY", value: input.jupiterApiKey });
  }
  if (input.tavilyApiKey !== undefined) {
    writes.push({ key: "TAVILY_API_KEY", value: input.tavilyApiKey });
  }
  if (input.rettiwtApiKey !== undefined) {
    writes.push({ key: "RETTIWT_API_KEY", value: input.rettiwtApiKey });
  }
  if (input.relayApiKey !== undefined) {
    writes.push({ key: "RELAY_API_KEY", value: input.relayApiKey });
  }
  if (input.lighterCoreReadOnlyToken !== undefined) {
    const validation = validateLighterReadOnlyToken("core", input.lighterCoreReadOnlyToken);
    if (!validation.ok) return validation;
    writes.push({
      key: "LIGHTER_CORE_READ_ONLY_AUTH_TOKEN",
      value: input.lighterCoreReadOnlyToken,
    });
  }
  if (input.lighterRhcReadOnlyToken !== undefined) {
    const validation = validateLighterReadOnlyToken("rhc", input.lighterRhcReadOnlyToken);
    if (!validation.ok) return validation;
    writes.push({
      key: "LIGHTER_RHC_READ_ONLY_AUTH_TOKEN",
      value: input.lighterRhcReadOnlyToken,
    });
  }

  if (writes.length === 0) {
    // Nothing to write — empty submission is a legal Continue.
    return ok({ fieldsWritten: [] });
  }

  const fieldsWritten: CanonicalKey[] = [];
  const updates: Partial<Record<CanonicalKey, string>> = {};
  for (const w of writes) {
    updates[w.key] = w.value;
    fieldsWritten.push(w.key);
  }

  const writeResult = writeUnlockedSecrets(updates);
  if (!writeResult.ok) return writeResult;

  log.info(
    `[api-keys-writer] persisted vault keys=${fieldsWritten.join(",")}`
  );
  return ok({ fieldsWritten });
}
