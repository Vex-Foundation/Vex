/**
 * Bundled embedding env writer (M11.5.4).
 *
 * Writes the 4 EMBEDDING_* keys to `${CONFIG_DIR}/.env` ONLY when ALL
 * four are absent or empty (preserve-first). If even a single key is
 * present, the user has either:
 *   - completed Step 4 manually (don't overwrite their override), or
 *   - is mid-rotate via Settings (don't introduce inconsistency).
 * Either way, the wizard surface is responsible for repairing partial
 * state; this helper never overwrites.
 *
 * Distinguishing from `writeEmbeddingConfig` (Step 4 IPC handler):
 *   - No dim-lock check. Bundled defaults represent a fresh-setup
 *     intent — if `knowledge_entries` rows exist with a different
 *     dim, that's because the user already configured EMBEDDING_DIM
 *     to something else, which means we hit the preserve-first
 *     branch above and never reach the write path.
 *   - Atomic across all 4 keys (single read + atomic temp+rename via
 *     `appendMultipleToDotenvFile`). A crash mid-batch cannot leave
 *     a partial state that preserve-first would then refuse to repair
 *     (codex review round 2 YELLOW #1).
 *   - Idempotent: re-running after a previous write is a no-op
 *     (everything is already present → preserve branch).
 *
 * Called from `vex.database.migrate` IPC handler after the migrate
 * applied/noop success path so `knowledge_entries` is guaranteed to
 * exist by the time any downstream code consults it.
 */

import {
  appendMultipleToDotenvFile,
  readDotenvFileValue,
} from "@vex-lib/dotenv.js";
import { ENV_FILE } from "../paths/config-dir.js";
import { log } from "../logger/index.js";
import { withEnvWriteLock } from "./env-write-mutex.js";
import { defaultEmbeddingEnv } from "./embedding-defaults.js";
import { resolveEmbedPort } from "../paths/service-ports.js";

const EMBEDDING_KEYS = [
  "EMBEDDING_BASE_URL",
  "EMBEDDING_MODEL",
  "EMBEDDING_DIM",
  "EMBEDDING_PROVIDER",
] as const;

export interface EnsureEmbeddingDefaultsOptions {
  /**
   * Embed port published by the compose stack. Defaults to
   * `DEFAULT_EMBED_PORT` (27134). Phase 1 hardcodes this; Phase 2
   * may surface a Settings → Advanced override and call this with
   * the live `composeUp` result port.
   */
  readonly embedPort?: number;
  /** Override env file path (tests only). */
  readonly envFile?: string;
}

export type EnsureEmbeddingDefaultsKind = "written" | "preserved";

export interface EnsureEmbeddingDefaultsResult {
  readonly kind: EnsureEmbeddingDefaultsKind;
  /** Keys persisted in this call (empty array when `preserved`). */
  readonly writtenKeys: ReadonlyArray<string>;
}

function readKey(envFile: string, key: string): string | null {
  try {
    return readDotenvFileValue(key, envFile);
  } catch {
    return null;
  }
}

export async function ensureEmbeddingDefaults(
  options: EnsureEmbeddingDefaultsOptions = {}
): Promise<EnsureEmbeddingDefaultsResult> {
  const envFile = options.envFile ?? ENV_FILE;
  const embedPort = options.embedPort ?? resolveEmbedPort();

  return withEnvWriteLock(async () => {
    const existing = EMBEDDING_KEYS.map((k) => readKey(envFile, k));
    const anyPresent = existing.some((v) => v !== null && v.length > 0);

    if (anyPresent) {
      log.info(
        "[ensure-embedding-defaults] preserve-first: at least one EMBEDDING_* key already set, skipping bundled defaults write"
      );
      return { kind: "preserved", writtenKeys: [] };
    }

    // Single read + atomic temp+rename for all 4 keys at once. Codex
    // review turn 2 YELLOW #1 — a 4× per-key loop would leave a
    // partial state if the process crashed mid-batch, and the next
    // run's preserve-first check would refuse to repair it.
    const defaults = defaultEmbeddingEnv(embedPort);
    appendMultipleToDotenvFile(
      {
        EMBEDDING_BASE_URL: defaults.EMBEDDING_BASE_URL,
        EMBEDDING_MODEL: defaults.EMBEDDING_MODEL,
        EMBEDDING_DIM: defaults.EMBEDDING_DIM,
        EMBEDDING_PROVIDER: defaults.EMBEDDING_PROVIDER,
      },
      envFile
    );
    const writtenKeys: string[] = [...EMBEDDING_KEYS];

    log.info(
      `[ensure-embedding-defaults] wrote bundled defaults (port=${embedPort}, dim=${defaults.EMBEDDING_DIM})`
    );
    return { kind: "written", writtenKeys };
  });
}
