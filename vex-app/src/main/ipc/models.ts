/**
 * Models IPC handler — the model list a session can pick from (F06).
 *
 * Reads `AGENT_PROVIDER` + `AGENT_MODEL` from `process.env` (populated
 * after vault unlock per the onboarding flow) for the configured default,
 * then the ACTIVE backend's keyless catalogue (`loadProviderModelCatalog`,
 * `source` = the mode the engine talks to): the tool-capable rows with their
 * window and exact prices. The default is marked `isDefault` and listed
 * FIRST, so a reader that still takes `models[0]` gets the default. Its
 * reasoning capability comes from the SAME neutral resolver
 * `sessions.getModel` uses (`reasoning-capability-resolver.ts`) — one
 * resolver, two channels, so both stay in lockstep for the same model id;
 * every other row reads the same catalogue snapshot's capability map.
 *
 * When the catalogue cannot be read the list degrades to today's single
 * default option (`source: "global_default"`). When the env vars are missing
 * the handler returns `{source: "unconfigured", models: [], fetchedAt: null}`
 * — empty list, never an error toast.
 */

import { CH } from "@shared/ipc/channels.js";
import { ok, type Result } from "@shared/ipc/result.js";
import {
  modelsListAvailableInputSchema,
  modelsListAvailableResultSchema,
  type ModelOptionDto,
  type ModelsListAvailableResult,
} from "@shared/schemas/models.js";
import type { ProviderModelOption } from "@shared/schemas/provider.js";
import { log } from "../logger/index.js";
import { registerHandler } from "./register-handler.js";
import { resolveReasoningCapability } from "./reasoning-capability-resolver.js";
import { activeInferenceProviderMode } from "../vex-cloud/active-mode.js";

const MODEL_ID_MAX = 200;
const PROVIDER_ID_MAX = 64;

function readEnvDefault(): {
  readonly provider: string | null;
  readonly model: string | null;
} {
  const rawProvider = process.env["AGENT_PROVIDER"];
  const rawModel = process.env["AGENT_MODEL"];
  const provider =
    typeof rawProvider === "string" && rawProvider.trim().length > 0
      ? rawProvider.trim()
      : null;
  const model =
    typeof rawModel === "string" && rawModel.trim().length > 0
      ? rawModel.trim()
      : null;
  if (provider !== null && provider.length > PROVIDER_ID_MAX) return { provider: null, model };
  if (model !== null && model.length > MODEL_ID_MAX) return { provider, model: null };
  return { provider, model };
}

/** One catalogue row as a pickable option on the active backend. */
function catalogOption(
  row: ProviderModelOption,
  backend: string,
  reasoning: ModelOptionDto["reasoning"],
  isDefault: boolean,
): ModelOptionDto {
  return {
    providerId: backend,
    modelId: row.modelId,
    displayName: row.displayName,
    brand: row.providerId,
    contextLength: row.contextLength,
    pricingInputPerMillion: row.pricingInputPerMillion,
    pricingOutputPerMillion: row.pricingOutputPerMillion,
    reasoning,
    isDefault,
  };
}

/** Today's single env-derived option: the fallback when no catalogue is readable. */
function envOption(
  provider: string,
  model: string,
  reasoning: ModelOptionDto["reasoning"],
): ModelOptionDto {
  return {
    providerId: provider,
    modelId: model,
    displayName: model,
    brand: provider,
    contextLength: null,
    pricingInputPerMillion: null,
    pricingOutputPerMillion: null,
    reasoning,
    isDefault: true,
  };
}

async function buildResult(signal: AbortSignal): Promise<ModelsListAvailableResult> {
  const { provider, model } = readEnvDefault();
  if (provider === null || model === null) {
    return { source: "unconfigured", models: [], fetchedAt: null };
  }
  const { reasoning: defaultReasoning } = await resolveReasoningCapability(model, signal);
  const backend = activeInferenceProviderMode();

  let rows: readonly ProviderModelOption[];
  let capabilityOf: (modelId: string) => Promise<ModelOptionDto["reasoning"]>;
  try {
    const { loadProviderModelCatalog, getModelReasoningCapability } = await import(
      "../onboarding/provider-model-catalog.js"
    );
    rows = (await loadProviderModelCatalog({ source: backend, signal })).models;
    // The same snapshot the list came from: a cached map read per row.
    capabilityOf = async (modelId) =>
      (await getModelReasoningCapability(modelId, { source: backend, signal }))?.reasoning ?? null;
  } catch (cause) {
    if (cause instanceof Error && cause.name === "AbortError") throw cause;
    log.warn("[ipc:vex:models:listAvailable] catalogue unavailable; default only", cause);
    return {
      source: "global_default",
      models: [envOption(provider, model, defaultReasoning)],
      fetchedAt: null,
    };
  }

  const defaultRow = rows.find((row) => row.modelId === model);
  const others: ModelOptionDto[] = [];
  for (const row of rows) {
    if (row.modelId === model) continue;
    others.push(catalogOption(row, backend, await capabilityOf(row.modelId), false));
  }
  // The default first, from its catalogue row when listed; a default the
  // catalogue no longer lists still shows (the engine names it when it fails).
  const first =
    defaultRow === undefined
      ? envOption(backend, model, defaultReasoning)
      : catalogOption(defaultRow, backend, defaultReasoning, true);
  return {
    source: "catalog",
    models: [first, ...others],
    fetchedAt: new Date().toISOString(),
  };
}

export function registerModelsHandlers(): ReadonlyArray<() => void> {
  return [
    registerHandler({
      channel: CH.models.listAvailable,
      domain: "models",
      inputSchema: modelsListAvailableInputSchema,
      outputSchema: modelsListAvailableResultSchema,
      handle: async (
        _input,
        ctx,
      ): Promise<Result<ModelsListAvailableResult>> => {
        const result = await buildResult(ctx.signal);
        log.info(
          `[ipc:vex:models:listAvailable] ok source=${result.source} ` +
            `count=${result.models.length} correlationId=${ctx.requestId}`,
        );
        return ok(result);
      },
    }),
  ];
}
