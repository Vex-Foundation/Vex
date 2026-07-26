/**
 * Schema for `vex.onboarding.getEnvState()` — presence-only checks
 * (codex turn 3 RED #3). MUST NOT decrypt keystores or expose private
 * key material before the wallet-unlock flow. Wallet status is
 * deliberately reduced to `present | missing` rather than the richer
 * decrypt-tested status the post-unlock helper returns. Presence is
 * derived from the multi-wallet inventory (`config.json wallet.evm[]` /
 * `wallet.solana[]`) plus the primary entry's keystore file existing on
 * disk — NOT from a fixed keystore filename alone (see env-state.ts).
 *
 * `embeddings` lives here (not in DockerStatus) because the endpoint is
 * user-configured via `EMBEDDING_BASE_URL` — it might be Docker Model
 * Runner, OpenRouter, or any custom OpenAI-compatible service.
 */

import { z } from "zod";

export const walletPresenceSchema = z.enum(["present", "missing"]);
export type WalletPresence = z.infer<typeof walletPresenceSchema>;

// Public PRIMARY addresses (index 0 per family) sourced from the
// `config.json` wallet inventory so the wizard can display them across
// sessions without the renderer talking to the keystore. NULL when the
// inventory has no wallet for that chain. Optional on the schema so
// existing M2/M7 tests + envState handling keep parsing without changes.
export const walletAddressesSchema = z
  .object({
    evm: z.string().nullable(),
    solana: z.string().nullable(),
  })
  .strict();

export type WalletAddresses = z.infer<typeof walletAddressesSchema>;

export const apiKeysStateSchema = z
  .object({
    jupiterConfigured: z.boolean(),
    tavilyConfigured: z.boolean(),
    rettiwtConfigured: z.boolean(),
  })
  .strict();

export type ApiKeysState = z.infer<typeof apiKeysStateSchema>;

/**
 * Provider env-state probe result (M10).
 *
 *   `name`        — effective provider after resolution per engine
 *                   precedence (`registry.ts:41-108`). Null when no
 *                   provider is configured.
 *   `configured`  — `name !== null` AND prerequisites met.
 *   `modelLabel`  — AGENT_MODEL for OpenRouter. Treat as a public
 *                   identifier — safe to render in the wizard skip card,
 *                   but NOT logged at the handler boundary (some custom
 *                   OpenRouter routes may encode organisation names).
 *                   Capped at 200 chars defensively against stale long
 *                   .env values.
 */
export const providerStateSchema = z
  .object({
    configured: z.boolean(),
    name: z.enum(["openrouter"]).nullable(),
    modelLabel: z.string().max(200).nullable(),
  })
  .strict();

export type ProviderState = z.infer<typeof providerStateSchema>;

export const envStateSchema = z
  .object({
    hasKeystorePassword: z.boolean(),
    /**
     * Deprecated alias for `apiKeys.jupiterConfigured` kept for M2/M7
     * back-compat. M9 added the per-field `apiKeys` block; future
     * milestones may drop this field once all callers migrate.
     */
    hasJupiterApiKey: z.boolean(),
    apiKeys: apiKeysStateSchema,
    secrets: z
      .object({
        vaultConfigured: z.boolean(),
        unlocked: z.boolean(),
      })
      .strict(),
    embeddings: z
      .object({
        configured: z.boolean(),
        reachable: z.boolean(),
        baseUrlRedacted: z.string().nullable(),
        /** M9: true iff all 4 EMBEDDING_* keys present + valid in .env. */
        allFieldsConfigured: z.boolean(),
        /**
         * M9: best-effort probe. `null` when the probe did not run /
         * timed out — UI must treat null as "unknown" and let the
         * write attempt surface the real status.
         */
        dbReachable: z.boolean().nullable(),
      })
      .strict(),
    walletStatus: z
      .object({
        evm: walletPresenceSchema,
        solana: walletPresenceSchema,
      })
      .strict(),
    walletAddresses: walletAddressesSchema.optional(),
    provider: providerStateSchema,
    setupCompleteFlag: z.boolean(),
  })
  .strict();

export type EnvState = z.infer<typeof envStateSchema>;
