/**
 * Eval globalSetup (Phase 0 live-LLM harness).
 *
 * Order is critical and intentional:
 *   1. Map the OpenRouter "vault" key out of `memory-system/.env`. That key is a
 *      MANAGED_SECRET_ENV_KEY which `src/providers/env-resolution.ts` deliberately
 *      SKIPS, so a generic dotenv loader will NOT populate it — we parse and
 *      assign `process.env.OPENROUTER_API_KEY` directly. Also default the judge
 *      model and the Gemma embedding model/dim/provider env (only if unset;
 *      EMBEDDING_BASE_URL must be set by the caller).
 *   2. If the key is STILL absent → log a skip notice and RETURN before touching
 *      testcontainers or probing embeddings. A keyless run is a clean no-op.
 *   3. If present → DELEGATE to the existing integration globalSetup (one Postgres
 *      via testcontainers + the embeddings reachability probe + migrations). Eval
 *      teardown calls the integration teardown ONLY if integration setup ran.
 *
 * The key is NEVER printed. Any log masks it.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(__dirname, "..");
const ENV_PATH = resolve(ROOT, "memory-system/.env");

/** Module flag: did the integration globalSetup actually run? (teardown guard) */
let integrationSetupRan = false;

/**
 * Parse a single `KEY=value` line out of an unmanaged dotenv file. Returns the
 * trimmed value (double/single quotes stripped) or null. We do a minimal parse
 * rather than importing the app dotenv loader: the OpenRouter key is a managed
 * secret that loader skips by contract.
 */
function readRawDotenvValue(key: string, path: string): string | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    if (trimmed.slice(0, eq).trim() !== key) continue;
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    return value.length > 0 ? value : null;
  }
  return null;
}

/** Mask a secret for logging — never reveal more than a 4-char fingerprint. */
function mask(secret: string): string {
  if (secret.length <= 8) return "****";
  return `${secret.slice(0, 4)}…(${secret.length} chars)`;
}

export async function setup(): Promise<void> {
  // ── Step 0: clean-slate the report-card sidecar (a disk-backed accumulator
  // shared across per-file worker module instances — the threads pool does NOT
  // share module singletons across files, and env mutations here do not reliably
  // reach worker threads, so the sidecar path is FIXED and we delete it ONCE
  // here in the main process so no prior run's data leaks into this one). ──
  try {
    const { rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    rmSync(resolve(tmpdir(), "vex-eval-report-card.json"), { force: true });
  } catch {
    // Best-effort — a missing sidecar is the normal case.
  }

  // ── Step 1: map the vault key + default the live endpoints ──────────────
  if (!process.env.OPENROUTER_API_KEY) {
    const fromVault = readRawDotenvValue("OPEN_ROUTER", ENV_PATH);
    if (fromVault) process.env.OPENROUTER_API_KEY = fromVault;
  }
  if (!process.env.AGENT_MODEL) {
    process.env.AGENT_MODEL = "deepseek/deepseek-v4-flash";
  }
  // No EMBEDDING_BASE_URL default: the desktop app's embeddings server picks
  // its port and key per launch, so no fixed URL is ever right. Unset, the
  // integration setup below fails with how to start one.
  if (!process.env.EMBEDDING_MODEL) {
    process.env.EMBEDDING_MODEL = "ai/embeddinggemma:300M-Q8_0";
  }
  if (!process.env.EMBEDDING_DIM) {
    process.env.EMBEDDING_DIM = "768";
  }
  if (!process.env.EMBEDDING_PROVIDER) {
    process.env.EMBEDDING_PROVIDER = "local";
  }

  // ── Step 2: keyless run = clean no-op (BEFORE testcontainers / probe) ────
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) {
    // eslint-disable-next-line no-console
    console.log(
      "[eval] eval requires live judge — skipping (no OPENROUTER_API_KEY).",
    );
    return;
  }
  // eslint-disable-next-line no-console
  console.log(
    `[eval] live judge enabled (model=${process.env.AGENT_MODEL}, key=${mask(key)}); ` +
      `embeddings=${process.env.EMBEDDING_BASE_URL ?? "(unset)"} model=${process.env.EMBEDDING_MODEL} dim=${process.env.EMBEDDING_DIM}.`,
  );

  // ── Step 3: delegate to the integration globalSetup (Postgres + probe) ──
  const integration = await import(
    "../src/__tests__/integration/setup/globalSetup.js"
  );
  await integration.setup();
  integrationSetupRan = true;
}

export async function teardown(): Promise<void> {
  if (!integrationSetupRan) return;
  const integration = await import(
    "../src/__tests__/integration/setup/globalSetup.js"
  );
  await integration.teardown();
  integrationSetupRan = false;
}
