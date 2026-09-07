import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";
import type { Result } from "@shared/ipc/result.js";
import type { SuperboardKeyStatus } from "@shared/schemas/superboard-key.js";
import { superboardKeyKeys } from "./queryKeys.js";

export function useSuperboardKey(): UseQueryResult<Result<SuperboardKeyStatus>> {
  return useQuery({
    queryKey: superboardKeyKeys.status(),
    queryFn: () => window.vex.settings.getSuperboardKey(),
  });
}

function useSuperboardKeyMutation(
  mutate: () => Promise<Result<SuperboardKeyStatus>>,
): UseMutationResult<Result<SuperboardKeyStatus>, Error, void> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: mutate,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: superboardKeyKeys.status() });
    },
  });
}

export function useGenerateSuperboardKey(): UseMutationResult<
  Result<SuperboardKeyStatus>,
  Error,
  void
> {
  return useSuperboardKeyMutation(() => window.vex.settings.generateSuperboardKey());
}

export function useRegenerateSuperboardKey(): UseMutationResult<
  Result<SuperboardKeyStatus>,
  Error,
  void
> {
  return useSuperboardKeyMutation(() => window.vex.settings.regenerateSuperboardKey());
}
