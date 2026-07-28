/**
 * Schemas for `vex.onboarding.providerPersist` — Wizard Step 6 (M10).
 *
 * Single IPC that does verify-then-persist atomically (codex turn 2
 * RED #1): handler tests the OpenRouter key+model via a 1-shot chat
 * completion, then stores OPENROUTER_API_KEY in the encrypted vault
 * and writes non-secret AGENT_MODEL + AGENT_PROVIDER=openrouter to
 * `.env`. If verify fails, no persist happens.
 *
 * Input validation:
 *   - `.trim().min(1).max(200)` for apiKey + model (codex turn 1 RED #4
 *     — whitespace-only bypass on plain `.min(1)`).
 *   - `provider` literal "openrouter" only.
 *
 * Output:
 *   - `fieldsWritten` in canonical order (matches engine resolution
 *     precedence in `src/vex-agent/inference/registry.ts:41-108` —
 *     explicit AGENT_PROVIDER overrides fallback).
 *   - `verifiedLatencyMs` from the verify step, surfaced in the
 *     success card.
 */

import { z } from "zod";

export const providerNameSchema = z.enum(["openrouter"]);
export type ProviderName = z.infer<typeof providerNameSchema>;

const trimmedSecret = z.string().trim().min(1).max(200);

export const providerPersistInputSchema = z
  .object({
    provider: z.literal("openrouter"),
    /**
     * OPTIONAL (delta-save). Present ⇒ rotate: this value is verified and
     * becomes the new vault entry. ABSENT ⇒ keep the currently stored key:
     * main loads it from the encrypted vault, verifies `{storedKey, model}`
     * with it, and leaves the vault entry untouched. If no key is stored and
     * none is supplied, main rejects BY NAME (`provider.api_key_required`) —
     * there is no silent fallback to an unverified configuration.
     *
     * Still `.trim().min(1)` when present, so a whitespace-only string is a
     * validation error rather than an accidental "keep existing" — the
     * renderer must OMIT the field to mean "keep".
     */
    apiKey: trimmedSecret.optional(),
    model: trimmedSecret,
    /**
     * Optional pinned OpenRouter endpoint `tag` (wizard provider select).
     * Omitted/undefined ⇒ "Auto (recommended)" — no pin, and the writer
     * REMOVES any previously persisted pin. UNTRUSTED: the handler verifies
     * the tag belongs to the selected model's tool-capable endpoint list
     * before anything is written.
     */
    endpointTag: z
      .string()
      .trim()
      .min(1)
      .max(200)
      // Closed charset matching live tags (`anthropic`, `anthropic/2`,
      // `google-vertex/global`, `amazon-bedrock/eu-west-1`). Bounds what the
      // rejection message may echo back and what may reach `.env`.
      .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/)
      .optional(),
  })
  .strict();

export type ProviderPersistInput = z.infer<typeof providerPersistInputSchema>;

/**
 * Canonical fields reported by `providerPersist` (M10). Order
 * matches the deterministic persist order in `provider-writer.ts`.
 * Engine resolution precedence (`registry.ts:41-108`):
 *   1. Explicit `AGENT_PROVIDER` value
 *   2. `OPENROUTER_API_KEY` + `AGENT_MODEL` present → openrouter
 * The API key is stored in the encrypted vault; provider/model selection
 * stays in `.env` so the GUI's wizard choice is unambiguous even when
 * stale `AGENT_PROVIDER` lines exist from manual edits.
 */
export const PROVIDER_PERSIST_CANONICAL_ORDER = [
  "OPENROUTER_API_KEY",
  "AGENT_MODEL",
  "AGENT_PROVIDER",
] as const;

/**
 * `.env` key holding the optional pinned endpoint tag. Written ONLY when the
 * operator picks an explicit provider; "Auto" removes it. Reported in
 * `fieldsWritten` only when actually written, so the success summary never
 * claims a key that is absent from disk.
 */
export const PROVIDER_ENDPOINT_TAG_ENV_KEY = "OPENROUTER_ENDPOINT_TAG";

export const providerPersistFieldNameSchema = z.enum([
  ...PROVIDER_PERSIST_CANONICAL_ORDER,
  PROVIDER_ENDPOINT_TAG_ENV_KEY,
]);

export type ProviderPersistFieldName = z.infer<
  typeof providerPersistFieldNameSchema
>;

export const providerPersistResultSchema = z
  .object({
    fieldsWritten: z.array(providerPersistFieldNameSchema).readonly(),
    verifiedLatencyMs: z.number().int().nonnegative(),
  })
  .strict();

export type ProviderPersistResult = z.infer<typeof providerPersistResultSchema>;

export const PROVIDER_MODEL_CATALOG_MAX = 1_000;

export const providerModelOptionSchema = z
  .object({
    modelId: z.string().trim().min(1).max(200),
    displayName: z.string().trim().min(1).max(200),
    providerId: z.string().trim().min(1).max(64),
    contextLength: z.number().int().positive().nullable(),
    pricingInputPerMillion: z.number().finite().nonnegative().nullable(),
    pricingOutputPerMillion: z.number().finite().nonnegative().nullable(),
    /**
     * Unix seconds the model was published (`Model.created`). OPTIONAL and
     * additive: an older cached payload, or a future catalogue row that stops
     * reporting it, simply sorts LAST instead of breaking the schema.
     */
    created: z.number().int().positive().optional(),
  })
  .strict();

export type ProviderModelOption = z.infer<typeof providerModelOptionSchema>;

export const providerListModelsInputSchema = z.object({}).strict();
export type ProviderListModelsInput = z.infer<
  typeof providerListModelsInputSchema
>;

export const providerListModelsResultSchema = z
  .object({
    models: z
      .array(providerModelOptionSchema)
      .max(PROVIDER_MODEL_CATALOG_MAX)
      .readonly(),
  })
  .strict();

export type ProviderListModelsResult = z.infer<
  typeof providerListModelsResultSchema
>;
