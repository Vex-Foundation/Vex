/**
 * Models TanStack Query hook: the model list a session can pick from (F06).
 *
 * Read-only — `source: "catalog"` (the active backend's tool-capable
 * catalogue, the configured default first and marked `isDefault`),
 * `"global_default"` (the catalogue was unreadable: the single env-derived
 * option) or `"unconfigured"` (empty list). Main reads the keyless
 * catalogue; the renderer never calls a provider.
 */

import {
  queryOptions,
  useQuery,
  type UseQueryResult,
} from "@tanstack/react-query";
import type { Result } from "@shared/ipc/result.js";
import type { ModelOptionDto, ModelsListAvailableResult } from "@shared/schemas/models.js";
import { modelsKeys } from "./queryKeys.js";

const STALE_MS = 60_000;

function availableOptions() {
  return queryOptions({
    queryKey: modelsKeys.available(),
    queryFn: () => window.vex.models.listAvailable({}),
    staleTime: STALE_MS,
  });
}

export function useAvailableModels(): UseQueryResult<
  Result<ModelsListAvailableResult>
> {
  return useQuery(availableOptions());
}

/** The configured default (`AGENT_MODEL`) in a resolved list, else `null`. */
export function defaultModelOption(
  result: Result<ModelsListAvailableResult> | undefined,
): ModelOptionDto | null {
  if (result?.ok !== true) return null;
  return result.data.models.find((option) => option.isDefault) ?? null;
}

/** One model's row in a resolved list, else `null`. */
export function findModelOption(
  result: Result<ModelsListAvailableResult> | undefined,
  modelId: string | null,
): ModelOptionDto | null {
  if (result?.ok !== true || modelId === null) return null;
  return result.data.models.find((option) => option.modelId === modelId) ?? null;
}
