/**
 * Models schemas — the model list a session can pick from (F06).
 *
 * `vex:models:listAvailable` returns the ACTIVE inference backend's
 * tool-capable catalogue (the OpenRouter public catalogue in
 * bring-your-own-key mode, the Vex Inference allowlist in Vex Cloud mode),
 * with each model's window, exact prices and reasoning capability, and the
 * configured default (`AGENT_MODEL`) marked `isDefault` and listed FIRST.
 * A session may run any row; the default stays the model for new sessions
 * and for background work.
 *
 * When the catalogue cannot be read the list degrades to the single default
 * option (`source: "global_default"`), exactly as before the picker. When
 * `AGENT_PROVIDER` / `AGENT_MODEL` are absent the read-only handler resolves
 * to `models: []` with `source: "unconfigured"`; it never errors. The UI
 * surfaces "Model not configured" instead of an error toast.
 */

import { z } from "zod";
import { reasoningCapabilitySchema } from "./reasoning.js";
import { providerNameSchema } from "./provider.js";
import { USD_DECIMAL_PATTERN } from "../usd-per-million.js";

/**
 * A catalogue model id as a pick may carry it: the shape the catalogues
 * publish (`vendor/model`, an optional `:variant`), 1 to 200 characters.
 */
export const modelIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/);

/**
 * A session's model pick (F06): the inference backend it is made under and
 * the catalogue id. Main checks it against that backend's catalogue before
 * the engine sees it.
 */
export const sessionModelPickSchema = z
  .object({
    provider: providerNameSchema,
    modelId: modelIdSchema,
  })
  .strict();
export type SessionModelPick = z.infer<typeof sessionModelPickSchema>;

export const modelOptionDtoSchema = z
  .object({
    /** The inference backend serving the model (`openrouter` / `vexcloud`). */
    providerId: z.string().min(1).max(64),
    modelId: z.string().min(1).max(200),
    displayName: z.string().min(1).max(200),
    /**
     * Renderer-side brand identifier used by `ModelBrandIcon` /
     * `parseModelProvider`: the catalogue's vendor prefix (`anthropic`,
     * `openai`), or the backend for the single-option fallback.
     */
    brand: z.string().min(1).max(64),
    /** Context length in tokens, from the catalogue row. `null` when unreported. */
    contextLength: z.number().int().positive().nullable(),
    /**
     * USD per 1M input tokens as exact decimal text, never a float (for Vex
     * Inference it is the price charged, margin included). `null` when the
     * catalogue states none.
     */
    pricingInputPerMillion: z.string().regex(USD_DECIMAL_PATTERN).nullable(),
    pricingOutputPerMillion: z.string().regex(USD_DECIMAL_PATTERN).nullable(),
    /**
     * Per-model reasoning capability (S6), REQUIRED nullable — the SAME
     * D4-set-normalized shape as `SessionModelDto.reasoning`
     * (`shared/schemas/reasoning.ts`), resolved in main
     * (`main/ipc/models.ts`) via the SAME neutral resolver
     * `sessions.getModel` uses (`main/ipc/reasoning-capability-resolver.ts`)
     * — one resolver, two channels, never a second fallback chain. `null`
     * means "no selector" (non-reasoning model, unconfigured, or capability
     * data unavailable).
     */
    reasoning: reasoningCapabilitySchema.nullable(),
    /** The configured default (`AGENT_MODEL`): new sessions and background work run on it. */
    isDefault: z.boolean(),
  })
  .strict();
export type ModelOptionDto = z.infer<typeof modelOptionDtoSchema>;

export const modelsListAvailableInputSchema = z.object({}).strict();
export type ModelsListAvailableInput = z.infer<
  typeof modelsListAvailableInputSchema
>;

/**
 * `source` tells the renderer where the list came from: `"catalog"` (the
 * active backend's catalogue, default first), `"global_default"` (the
 * catalogue was unreadable; the single env-derived option) or
 * `"unconfigured"` (empty list).
 */
export const modelsListSourceSchema = z.enum([
  "catalog",
  "global_default",
  "unconfigured",
]);
export type ModelsListSource = z.infer<typeof modelsListSourceSchema>;

export const modelsListAvailableResultSchema = z
  .object({
    source: modelsListSourceSchema,
    models: z.array(modelOptionDtoSchema),
    fetchedAt: z.string().datetime({ offset: true }).nullable(),
  })
  .strict();
export type ModelsListAvailableResult = z.infer<
  typeof modelsListAvailableResultSchema
>;
