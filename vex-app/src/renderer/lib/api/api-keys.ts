/**
 * API keys API (M9 Step 3).
 *
 * IMPORTANT secret-handling rule (skill §14, mirrors M8 wallet
 * import pattern): the IPC payload carries SECRETS (Jupiter / Tavily
 * / Rettiwt). Routing it through `useMutation` would park the
 * variables in observer state for staleness/devtools.
 * So `setApiKeys` is a plain async function. Callers MUST:
 *   - read each secret from an UNCONTROLLED DOM ref at submit time,
 *   - clear `inputRef.current.value = ""` synchronously BEFORE the
 *     await call,
 *   - drive pending state via local useState,
 *   - call `useInvalidateEnvStateAfterApiKeysWrite()` on success.
 */

import { useQueryClient } from "@tanstack/react-query";
import type { Result } from "@shared/ipc/result.js";
import type {
  ApiKeysSetInput,
  ApiKeysSetResult,
} from "@shared/schemas/api-keys.js";
import { onboardingKeys } from "./queryKeys.js";

export async function setApiKeys(
  input: ApiKeysSetInput,
): Promise<Result<ApiKeysSetResult>> {
  return window.vex.onboarding.apiKeysSet(input);
}

export function useInvalidateEnvStateAfterApiKeysWrite(): () => void {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({
      queryKey: onboardingKeys.envState(),
    });
  };
}
