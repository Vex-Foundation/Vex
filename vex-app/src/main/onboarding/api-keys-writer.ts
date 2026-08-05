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
import {
  API_KEYS_CANONICAL_ORDER,
  type ApiKeysSetInput,
  type ApiKeysSetResult,
} from "@shared/schemas/api-keys.js";
import { log } from "../logger/index.js";
import { writeUnlockedSecrets } from "../secrets/session.js";

export interface ApiKeysWriterOptions {
  /** Override `ENV_FILE` for tests; production callers omit. */
  readonly envFile?: string;
}

type CanonicalKey = (typeof API_KEYS_CANONICAL_ORDER)[number];

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
