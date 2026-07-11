/**
 * OpenRouter model-catalogue loader for the onboarding picker.
 *
 * The SDK request runs in Electron main, never in the renderer. Only text
 * models that advertise tool support are projected because Vex's agent loop
 * depends on tool calls. The last successful catalogue is cached for an hour;
 * once stale, a failed refresh serves that last-good copy so setup remains
 * usable during a transient OpenRouter metadata outage.
 */

import { OpenRouter } from "@vex-lib/openrouter-client.js";
import type {
  ProviderListModelsResult,
  ProviderModelOption,
} from "@shared/schemas/provider.js";

const CATALOG_TTL_MS = 3_600_000;
const CATALOG_TIMEOUT_MS = 15_000;

const NOOP_LOGGER = {
  group: () => {},
  groupEnd: () => {},
  log: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

type ModelsClient = Pick<OpenRouter["models"], "list">;

export interface LoadProviderModelCatalogOptions {
  readonly signal?: AbortSignal;
  readonly now?: () => number;
  readonly clientFactory?: () => { readonly models: ModelsClient };
}

let cached: ProviderListModelsResult | null = null;
let cachedAtMs = 0;
let inFlight: Promise<ProviderListModelsResult> | null = null;

function defaultClientFactory(): OpenRouter {
  return new OpenRouter({
    httpReferer: "https://vexlabs.ai",
    appTitle: "Vex Agent",
    timeoutMs: CATALOG_TIMEOUT_MS,
    retryConfig: { strategy: "none" },
    debugLogger: NOOP_LOGGER,
  });
}

function parsePricePerMillion(raw: unknown): number | null {
  if (raw === undefined || raw === null || raw === "") return null;
  const perToken = Number(raw);
  if (!Number.isFinite(perToken) || perToken < 0) return null;
  const perMillion = perToken * 1_000_000;
  return Number.isFinite(perMillion) ? perMillion : null;
}

function providerIdFor(modelId: string): string {
  const slash = modelId.indexOf("/");
  const raw = slash > 0 ? modelId.slice(0, slash) : "openrouter";
  return raw.replace(/^~/, "").slice(0, 64) || "openrouter";
}

function isSafeCatalogueString(value: string): boolean {
  return value.trim().length > 0 && value.length <= 200;
}

function compareModels(a: ProviderModelOption, b: ProviderModelOption): number {
  const byProvider = a.providerId.localeCompare(b.providerId, undefined, {
    sensitivity: "base",
  });
  if (byProvider !== 0) return byProvider;
  return a.displayName.localeCompare(b.displayName, undefined, {
    sensitivity: "base",
  });
}

async function fetchCatalogue(
  options: LoadProviderModelCatalogOptions,
): Promise<ProviderListModelsResult> {
  const client = (options.clientFactory ?? defaultClientFactory)();
  const response = await client.models.list(
    {
      outputModalities: "text",
      supportedParameters: "tools",
    },
    {
      signal: options.signal,
      timeoutMs: CATALOG_TIMEOUT_MS,
      retries: { strategy: "none" },
    },
  );

  const models = response.data
    .filter(
      (model) =>
        model.supportedParameters.includes("tools") &&
        isSafeCatalogueString(model.id) &&
        isSafeCatalogueString(model.name),
    )
    .map<ProviderModelOption>((model) => ({
      modelId: model.id.trim(),
      displayName: model.name.trim(),
      providerId: providerIdFor(model.id),
      contextLength:
        typeof model.contextLength === "number" &&
        Number.isInteger(model.contextLength) &&
        model.contextLength > 0
          ? model.contextLength
          : null,
      pricingInputPerMillion: parsePricePerMillion(model.pricing.prompt),
      pricingOutputPerMillion: parsePricePerMillion(model.pricing.completion),
    }))
    .sort(compareModels);

  return {
    models,
    fetchedAt: new Date((options.now ?? Date.now)()).toISOString(),
  };
}

export async function loadProviderModelCatalog(
  options: LoadProviderModelCatalogOptions = {},
): Promise<ProviderListModelsResult> {
  const now = (options.now ?? Date.now)();
  if (cached !== null && now - cachedAtMs < CATALOG_TTL_MS) return cached;
  if (inFlight !== null) return inFlight;

  inFlight = fetchCatalogue(options)
    .then((result) => {
      cached = result;
      cachedAtMs = (options.now ?? Date.now)();
      return result;
    })
    .catch((error: unknown) => {
      if (cached !== null) return cached;
      throw error;
    })
    .finally(() => {
      inFlight = null;
    });

  return inFlight;
}

export function __resetProviderModelCatalogForTests(): void {
  cached = null;
  cachedAtMs = 0;
  inFlight = null;
}
