/**
 * Vex Cloud (phase 1): the renderer half of the `vex:vexCloud:*` contract.
 *
 * THE BOUNDARY LAW OF THIS FILE. The renderer holds no key, no session and no
 * message to sign. It sends the wallets the user saw beside the consent and
 * reads back public account facts. Every type is the inferred type of the
 * shared schema main validates with; nothing is re-declared here.
 *
 * `account` is a query (it is a read the screen polls while open); `signIn`
 * and `signOut` are plain calls driven by the component's own state, because
 * a sign-in that re-ran itself in the background would sign without a click.
 */

import { queryOptions, useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import type { Result } from "@shared/ipc/result.js";
import type {
  VexCloudAccountResult,
  VexCloudSignInInput,
  VexCloudSignInResult,
  VexCloudSignOutResult,
} from "@shared/schemas/vex-cloud.js";
import type { AbortableInvocation } from "@shared/types/bridge/common.js";
import type { VexCloudBridge } from "@shared/types/bridge/shell/vex-cloud.js";
import { onboardingKeys, vexCloudKeys } from "./queryKeys.js";

/**
 * The preload domain, or `null` when the running preload predates it (the
 * `?? null` is not redundant: `window.vex` is whatever preload actually loaded).
 */
function vexCloudBridge(): VexCloudBridge | null {
  return window.vex.vexCloud ?? null;
}

const BRIDGE_UNAVAILABLE: Result<never> = {
  ok: false,
  error: {
    code: "internal.contract_violation",
    domain: "system",
    message: "Vex Cloud isn't available in this build yet.",
    retryable: false,
    userActionable: false,
    redacted: true,
    correlationId: "renderer-local",
  },
};

/** How often an open Vex Cloud screen re-reads the balance (polling in v1, plan section 7). */
const ACCOUNT_POLL_MS = 30_000;

export function useVexCloudAccount(enabled: boolean = true): UseQueryResult<Result<VexCloudAccountResult>> {
  return useQuery(
    queryOptions({
      queryKey: vexCloudKeys.account(),
      queryFn: async () => {
        const bridge = vexCloudBridge();
        return bridge === null ? BRIDGE_UNAVAILABLE : bridge.account();
      },
      enabled,
      refetchInterval: ACCOUNT_POLL_MS,
      retry: false,
    }),
  );
}

/** Sign in with exactly the wallets shown beside the consent. Cancellable. */
export function signInToVexCloud(input: VexCloudSignInInput): AbortableInvocation<VexCloudSignInResult> {
  const bridge = vexCloudBridge();
  if (bridge === null) return { promise: Promise.resolve(BRIDGE_UNAVAILABLE), cancel: () => {} };
  return bridge.signIn(input);
}

export function signOutOfVexCloud(): Promise<Result<VexCloudSignOutResult>> {
  const bridge = vexCloudBridge();
  return bridge === null ? Promise.resolve(BRIDGE_UNAVAILABLE) : bridge.signOut();
}

/**
 * After a sign-in or sign-out: the account read and the provider setup state
 * (whose "configured" depends on the stored session) are both stale.
 */
export function useInvalidateVexCloudState(): () => void {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: vexCloudKeys.all });
    void queryClient.invalidateQueries({ queryKey: onboardingKeys.envState() });
  };
}
