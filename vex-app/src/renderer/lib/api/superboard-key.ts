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
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
}

function useSuperboardKeyMutation(
  mutate: () => Promise<Result<SuperboardKeyStatus>>,
): UseMutationResult<Result<SuperboardKeyStatus>, Error, void> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: mutate,
    // A stale in-flight `get` must not overwrite the status this mutation
    // is about to produce.
    onMutate: async () => {
      await queryClient.cancelQueries({ queryKey: superboardKeyKeys.status() });
    },
    onSuccess: (result) => {
      // The mutation result IS the post-attempt status: publish it directly.
      // The status key is deliberately never invalidated - a refetch here
      // would re-run the bind or rotation the mutation just attempted.
      if (result.ok) {
        queryClient.setQueryData(superboardKeyKeys.status(), result);
      }
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

export function useRotateSuperboardKey(): UseMutationResult<
  Result<SuperboardKeyStatus>,
  Error,
  void
> {
  return useSuperboardKeyMutation(() => window.vex.settings.rotateSuperboardKey());
}
