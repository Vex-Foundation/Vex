/**
 * Embedding state probe (M9) — feeds `envStateSchema.embeddings`.
 *
 * Reads the 4 EMBEDDING_* keys from `${CONFIG_DIR}/.env` directly
 * (matches engine's runtime contract: `loadEmbeddingConfig()` reads
 * `process.env`, populated from .env via `loadDotenvFileIntoProcess`
 * at bootstrap — `.env.example` is a setup-time template, NOT a
 * runtime source). The probe says "configured" iff all four keys
 * resolve to valid values per engine validation rules.
 *
 * Reachability (HTTP probe to `${baseUrl}/models`) and dim-lock DB
 * reachability are best-effort signals exposed alongside.
 *
 * On the native runtime, while `.env` selects the bundled embeddings, the
 * endpoint probed and shown is the LIVE one the runtime host published (see
 * `nativeLiveEndpoint` below); `.env` is read, never written, here.
 */

import {
  MAX_EMBEDDING_DIM,
  MIN_EMBEDDING_DIM,
} from "@vex-lib/embedding.js";
import { readDotenvFileValue } from "@vex-lib/dotenv.js";
import { ENV_FILE } from "../paths/config-dir.js";
import { log } from "../logger/index.js";
import { probeDbReachable } from "../database/dim-lock.js";
import type { RuntimeEndpoints } from "../runtime/provider.js";
import { getRuntimeMode } from "../runtime/runtime-mode.js";
import { isBundledEmbeddingSelection, liveNativeEmbeddings } from "../runtime/native/embedding-env.js";

type RuntimeEmbeddings = RuntimeEndpoints["embeddings"];

const HTTP_PROBE_TIMEOUT_MS = 2_000;

export interface EmbeddingsProbe {
  readonly configured: boolean;
  readonly reachable: boolean;
  readonly baseUrlRedacted: string | null;
  readonly allFieldsConfigured: boolean;
  readonly dbReachable: boolean | null;
}

function isValidUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    if (u.hostname.length === 0) return false;
    return true;
  } catch {
    return false;
  }
}

function redactUrl(raw: string): string | null {
  try {
    const u = new URL(raw);
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}

function readResolvedFields(envFile: string): {
  baseUrl: string | null;
  model: string | null;
  dim: number | null;
  provider: string | null;
} {
  const safeRead = (key: string): string | null => {
    try {
      return readDotenvFileValue(key, envFile);
    } catch {
      return null;
    }
  };
  const baseUrl = safeRead("EMBEDDING_BASE_URL");
  const model = safeRead("EMBEDDING_MODEL");
  const dimRaw = safeRead("EMBEDDING_DIM");
  const provider = safeRead("EMBEDDING_PROVIDER");
  let dim: number | null = null;
  if (dimRaw !== null && /^\d+$/.test(dimRaw)) {
    const n = Number.parseInt(dimRaw, 10);
    if (Number.isFinite(n) && n >= MIN_EMBEDDING_DIM && n <= MAX_EMBEDDING_DIM) {
      dim = n;
    }
  }
  return { baseUrl, model, dim, provider };
}

async function probeReachable(baseUrl: string, apiKey: string | null = null): Promise<boolean> {
  // Same path-preserving probe shape used by env-state.ts (codex turn
  // 5 YELLOW #1): never use new URL("/v1/models", baseUrl) which would
  // drop the existing path.
  const url = `${baseUrl.replace(/\/$/, "")}/models`;
  const headers: Record<string, string> = { Accept: "application/json" };
  if (apiKey !== null) headers["Authorization"] = `Bearer ${apiKey}`;
  try {
    const res = await fetch(url, {
      method: "GET",
      signal: AbortSignal.timeout(HTTP_PROBE_TIMEOUT_MS),
      headers,
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * NATIVE RUNTIME. `.env` keeps the bundled tuple setup wrote, whose URL names
 * the default port; the bundled llama-server listens on a port chosen at
 * launch behind a per-launch key, which main publishes to the engine's
 * environment and never persists (`runtime/native/embedding-env.ts`). While
 * the file selects the bundled embeddings, the status therefore describes and
 * probes that LIVE endpoint, key included: `undefined` here means "not this
 * case, probe the file's URL as before" (any other runtime, or a remote
 * provider the user configured); null means the server is down right now.
 */
function nativeLiveEndpoint(fields: ReturnType<typeof readResolvedFields>): RuntimeEmbeddings | null | undefined {
  if (getRuntimeMode() !== "native") return undefined;
  const selection: NodeJS.ProcessEnv = {};
  if (fields.baseUrl !== null) selection["EMBEDDING_BASE_URL"] = fields.baseUrl;
  if (fields.provider !== null) selection["EMBEDDING_PROVIDER"] = fields.provider;
  if (fields.model !== null) selection["EMBEDDING_MODEL"] = fields.model;
  if (!isBundledEmbeddingSelection(selection)) return undefined;
  return liveNativeEmbeddings();
}

export async function probeEmbeddings(envFile: string = ENV_FILE): Promise<EmbeddingsProbe> {
  const fields = readResolvedFields(envFile);
  const allPresent =
    fields.baseUrl !== null &&
    fields.baseUrl.length > 0 &&
    fields.model !== null &&
    fields.model.length > 0 &&
    fields.dim !== null &&
    fields.provider !== null &&
    fields.provider.length > 0;
  const baseUrlValid = fields.baseUrl !== null && isValidUrl(fields.baseUrl);
  const allFieldsConfigured = allPresent && baseUrlValid;

  const live = allFieldsConfigured ? nativeLiveEndpoint(fields) : undefined;
  const [reachable, dbReachable] = await Promise.all([
    !allFieldsConfigured || live === null
      ? Promise.resolve(false)
      : live === undefined
        ? probeReachable(fields.baseUrl!)
        : probeReachable(live.baseUrl, live.apiKey),
    safeProbeDb(),
  ]);

  return {
    configured: allFieldsConfigured,
    reachable,
    baseUrlRedacted: !allFieldsConfigured
      ? null
      : live === undefined || live === null
        ? redactUrl(fields.baseUrl!)
        : redactUrl(live.baseUrl),
    allFieldsConfigured,
    dbReachable,
  };
}

async function safeProbeDb(): Promise<boolean | null> {
  try {
    return await probeDbReachable();
  } catch (cause) {
    log.warn("[embedding-state] probeDbReachable threw", cause);
    return null;
  }
}
