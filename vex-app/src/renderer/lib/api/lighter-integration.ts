import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";
import type { Result } from "@shared/ipc/result.js";
import type {
  LighterIntegrationEnvironment,
  LighterIntegrationState,
  SetLighterIntegrationInput,
} from "@shared/schemas/lighter-integration.js";

const lighterIntegrationKey = (environment: LighterIntegrationEnvironment) =>
  ["settings", "lighterIntegration", environment] as const;

export function useLighterIntegration(
  environment: LighterIntegrationEnvironment,
): UseQueryResult<Result<LighterIntegrationState>> {
  return useQuery({
    queryKey: lighterIntegrationKey(environment),
    queryFn: () => window.vex.settings.getLighterIntegration({ environment }),
  });
}

export function useSetLighterIntegration(): UseMutationResult<
  Result<LighterIntegrationState>,
  Error,
  SetLighterIntegrationInput
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input) => window.vex.settings.setLighterIntegration(input),
    onSuccess: (_result, input) => {
      void queryClient.invalidateQueries({
        queryKey: lighterIntegrationKey(input.environment),
      });
    },
  });
}
