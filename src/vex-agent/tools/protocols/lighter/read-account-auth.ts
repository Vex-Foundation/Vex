import type { LighterPrivilegedAccountAuth } from "@tools/lighter/client.js";
import type { LighterEnvironment } from "@tools/lighter/constants.js";

/**
 * Derives a short-lived READ-ONLY account auth token from the saved trading key
 * so authenticated account reads (open orders, order history, trades) work on a
 * single-key setup. The derived token authorizes account reads only — it is
 * never used to sign or submit an order.
 *
 * Installed by the main process only; agent code never sees key material. The
 * resolver returns null when it should not or cannot mint a token — for example
 * when the vault is locked, the signer is unavailable, or no trading scope is
 * saved for the account. A null result leaves the authenticated read unavailable;
 * there is no standalone-token fallback.
 */
export type LighterReadOnlyAccountAuthResolver = (
  environment: LighterEnvironment,
  accountIndex: number,
) => Promise<LighterPrivilegedAccountAuth | null>;

let configuredResolver: LighterReadOnlyAccountAuthResolver | null = null;

export function configureLighterReadOnlyAccountAuthResolver(
  resolver: LighterReadOnlyAccountAuthResolver | null,
): () => void {
  configuredResolver = resolver;
  return () => {
    if (configuredResolver === resolver) configuredResolver = null;
  };
}

export async function resolveLighterReadOnlyAccountAuth(
  environment: LighterEnvironment,
  accountIndex: number,
): Promise<LighterPrivilegedAccountAuth | null> {
  return configuredResolver ? configuredResolver(environment, accountIndex) : null;
}
