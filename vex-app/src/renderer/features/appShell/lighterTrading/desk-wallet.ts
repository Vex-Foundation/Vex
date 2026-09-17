/**
 * Which saved wallet the desk's Lighter account belongs to.
 *
 * The account read carries the account index but no wallet, and every Settings
 * leverage hook is scoped by `{ environment, walletAddress }` (main resolves
 * the account index from the wallet again before it signs). So the desk finds
 * the wallet the same way Settings lists it: the stored credential connections,
 * matched on the environment and the account index the desk is bound to.
 */

import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import type { Result } from "@shared/ipc/result.js";
import type {
  InspectLighterCredentialConnectionsResult,
  LighterIntegrationEnvironment,
} from "@shared/schemas/lighter-integration.js";
import { inspectStoredLighterConnections } from "../../../lib/api/lighter-integration.js";

export function walletForLighterAccount(
  connections: InspectLighterCredentialConnectionsResult["connections"],
  environment: LighterIntegrationEnvironment,
  accountIndex: number,
): string | null {
  for (const connection of connections) {
    const bound = connection.scopes.some(
      (scope) => scope.environment === environment && scope.accountIndex === accountIndex,
    );
    if (bound) return connection.walletAddress;
  }
  return null;
}

/** The stored connections, read only while the leverage sheet is open. */
export function useLighterStoredConnections(
  enabled: boolean,
): UseQueryResult<Result<InspectLighterCredentialConnectionsResult>> {
  return useQuery({
    queryKey: ["lighterTrading", "storedConnections"],
    queryFn: () => inspectStoredLighterConnections(),
    enabled,
    staleTime: 30_000,
  });
}
