/**
 * Provider API (M10 Step 6).
 *
 * Secret handling — same rule as M9 Step 3 (api-keys): the IPC
 * payload carries the OPENROUTER_API_KEY secret. Routing it through
 * `useMutation` would park the secret in observer state for
 * staleness/devtools. So `persistProvider` is a plain async function.
 * Callers MUST:
 *   - read the apiKey from an UNCONTROLLED DOM ref at submit time,
 *   - clear `apiKeyRef.current.value = ""` synchronously BEFORE the
 *     await call,
 *   - drive pending state via local useState,
 *   - call `useInvalidateEnvStateAfterProviderWrite()` on success.
 *
 * The IPC handler does verify-then-persist atomically: it sends a
 * 16-token chat completion to OpenRouter to validate the (apiKey,
 * model) pair BEFORE writing the 3 .env keys.
 */

import {
  queryOptions,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from "@tanstack/react-query";
import type { Result } from "@shared/ipc/result.js";
import type {
  ProviderPersistInput,
  ProviderPersistResult,
  ProviderListModelsResult,
} from "@shared/schemas/provider.js";
import type { ProviderListEndpointsResult } from "@shared/schemas/provider-endpoints.js";
import { modelsKeys, onboardingKeys, sessionModelKeys } from "./queryKeys.js";

export async function persistProvider(
  input: ProviderPersistInput,
): Promise<Result<ProviderPersistResult>> {
  return window.vex.onboarding.providerPersist(input);
}

const PROVIDER_MODELS_STALE_MS = 3_600_000;

function providerModelsOptions(enabled: boolean) {
  return queryOptions({
    queryKey: onboardingKeys.providerModels(),
    queryFn: () => window.vex.onboarding.providerListModels({}),
    staleTime: PROVIDER_MODELS_STALE_MS,
    retry: false,
    enabled,
  });
}

export function useProviderModels(
  enabled: boolean = true,
): UseQueryResult<Result<ProviderListModelsResult>> {
  return useQuery(providerModelsOptions(enabled));
}

/**
 * Tool-capable endpoints ("providers") serving ONE model.
 *
 * Fetched once per SELECTED model, never per keystroke: the query is enabled
 * only when the caller passes a model id that came from an exact catalogue
 * selection. A typed-but-unlisted model id yields `null` here and the UI stays
 * Auto-only, so a partially-typed id can never spray requests at OpenRouter.
 */
export function useProviderEndpoints(
  modelId: string | null,
): UseQueryResult<Result<ProviderListEndpointsResult>> {
  return useQuery(
    queryOptions({
      queryKey: onboardingKeys.providerEndpoints(modelId ?? ""),
      queryFn: () =>
        window.vex.onboarding.providerListEndpoints({ modelId: modelId ?? "" }),
      staleTime: PROVIDER_MODELS_STALE_MS,
      retry: false,
      enabled: modelId !== null && modelId.length > 0,
    }),
  );
}

export function useInvalidateEnvStateAfterProviderWrite(): () => void {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({
      queryKey: onboardingKeys.envState(),
    });
    // Reconfigure staleness (S6 round 2): a provider/model write makes the
    // GLOBAL model query's cached reasoning capability wrong for the NEW
    // model. RESET (not merely invalidate) both caches sharing that global
    // fact so an immediate read after this write never flashes the OLD
    // model's capability while a background refetch is in flight —
    // `invalidateQueries` keeps serving the stale cache until the refetch
    // settles; `resetQueries` clears it first. `sessionModelKeys` still
    // needs the same reset even though `sessions.getModel` is no longer the
    // composer's capability source (SessionRuntimeBar reads it directly).
    void queryClient.resetQueries({ queryKey: modelsKeys.all });
    void queryClient.resetQueries({ queryKey: sessionModelKeys.all });
  };
}
