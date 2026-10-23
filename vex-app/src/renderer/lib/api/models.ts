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
import type { ModelsListAvailableResult } from "@shared/schemas/models.js";
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
