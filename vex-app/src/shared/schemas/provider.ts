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
    apiKey: trimmedSecret,
    model: trimmedSecret,
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

export const providerPersistFieldNameSchema = z.enum(
  PROVIDER_PERSIST_CANONICAL_ORDER,
);

export const providerPersistResultSchema = z
  .object({
    fieldsWritten: z.array(providerPersistFieldNameSchema).readonly(),
    verifiedLatencyMs: z.number().int().nonnegative(),
  })
  .strict();

export type ProviderPersistResult = z.infer<typeof providerPersistResultSchema>;

// ── OpenRouter model catalogue ─────────────────────────────────────────────

/**
 * Public, renderer-safe projection of an OpenRouter catalogue entry. The main
 * process deliberately allow-lists only the metadata needed by the picker;
 * provider routing details and raw API payloads never cross IPC.
 */
export const providerModelOptionSchema = z
  .object({
    modelId: z.string().trim().min(1).max(200),
    displayName: z.string().trim().min(1).max(200),
    providerId: z.string().trim().min(1).max(64),
    contextLength: z.number().int().positive().nullable(),
    pricingInputPerMillion: z.number().finite().nonnegative().nullable(),
    pricingOutputPerMillion: z.number().finite().nonnegative().nullable(),
  })
  .strict();

export type ProviderModelOption = z.infer<typeof providerModelOptionSchema>;

export const providerListModelsInputSchema = z.object({}).strict();
export type ProviderListModelsInput = z.infer<
  typeof providerListModelsInputSchema
>;

export const providerListModelsResultSchema = z
  .object({
    models: z.array(providerModelOptionSchema).max(1_000).readonly(),
    fetchedAt: z.string().datetime({ offset: true }),
  })
  .strict();

export type ProviderListModelsResult = z.infer<
  typeof providerListModelsResultSchema
>;
