import type { LighterPrivilegedAccountAuth } from "@tools/lighter/client.js";
import type { LighterEnvironment } from "@tools/lighter/constants.js";

/**
 * Derives a short-lived READ-ONLY account auth token from the saved trading key
 * so authenticated account reads (open orders, order history, trades) work on a
 * single-key setup. The derived token authorizes account reads only - it is
 * never used to sign or submit an order.
 *
 * Installed by the main process only; agent code never sees key material.
 *
 * TWO SHAPES, ONE SLOT. The installed resolver reports either the auth or a
 * REASON it could not be minted. `resolveLighterReadOnlyAccountAuth` keeps the
 * auth-or-null contract the execution paths use, which only need to know
 * whether an authenticated read is possible; the surfaces that must TELL A
 * PERSON why call `resolveLighterReadOnlyAccountAuthOutcome`, because "null"
 * reads as "no Lighter account" to a user whose vault is merely locked. Both
 * read the same slot, so the two can never disagree.
 */
export type LighterReadOnlyAccountAuthUnavailableReason =
  /** No saved trading credential for that environment and account index. */
  | "no_credential"
  /** A credential may exist, but Vex is locked, so it cannot be read. */
  | "vault_locked"
  /** The credential was read and no token could be minted from it. */
  | "signer_failed"
  /**
   * A legacy auth-or-null resolver reported no authorization without saying
   * why. Never re-labelled as "not registered": that would be inference.
   */
  | "unknown";

export type LighterReadOnlyAccountAuthOutcome =
  | { readonly kind: "auth"; readonly auth: LighterPrivilegedAccountAuth }
  | {
      readonly kind: "unavailable";
      readonly reason: LighterReadOnlyAccountAuthUnavailableReason;
      readonly detail: string;
    };

export type LighterReadOnlyAccountAuthResolver = (
  environment: LighterEnvironment,
  accountIndex: number,
) => Promise<LighterPrivilegedAccountAuth | null>;

export type LighterReadOnlyAccountAuthOutcomeResolver = (
  environment: LighterEnvironment,
  accountIndex: number,
) => Promise<LighterReadOnlyAccountAuthOutcome>;

let configuredResolver: LighterReadOnlyAccountAuthOutcomeResolver | null = null;

/**
 * Install a resolver that reports its own reasons. The returned disposer
 * uninstalls only this resolver, exactly as the auth-or-null one does.
 */
export function configureLighterReadOnlyAccountAuthOutcomeResolver(
  resolver: LighterReadOnlyAccountAuthOutcomeResolver | null,
): () => void {
  configuredResolver = resolver;
  return () => {
    if (configuredResolver === resolver) configuredResolver = null;
  };
}

/**
 * Install an auth-or-null resolver. A null answer becomes `unknown`, never
 * `no_credential`: the resolver did not say which, and guessing would tell a
 * person with a locked vault that they have no Lighter account.
 */
export function configureLighterReadOnlyAccountAuthResolver(
  resolver: LighterReadOnlyAccountAuthResolver | null,
): () => void {
  if (resolver === null) return configureLighterReadOnlyAccountAuthOutcomeResolver(null);
  return configureLighterReadOnlyAccountAuthOutcomeResolver(
    async (environment, accountIndex) => {
      const auth = await resolver(environment, accountIndex);
      return auth === null
        ? {
            kind: "unavailable",
            reason: "unknown",
            detail: "The installed resolver reported no authorization and no reason.",
          }
        : { kind: "auth", auth };
    },
  );
}

export async function resolveLighterReadOnlyAccountAuthOutcome(
  environment: LighterEnvironment,
  accountIndex: number,
): Promise<LighterReadOnlyAccountAuthOutcome> {
  if (configuredResolver === null) {
    return {
      kind: "unavailable",
      reason: "unknown",
      detail: "No Lighter read-only authorization resolver is installed in this process.",
    };
  }
  return configuredResolver(environment, accountIndex);
}

export async function resolveLighterReadOnlyAccountAuth(
  environment: LighterEnvironment,
  accountIndex: number,
): Promise<LighterPrivilegedAccountAuth | null> {
  const outcome = await resolveLighterReadOnlyAccountAuthOutcome(environment, accountIndex);
  return outcome.kind === "auth" ? outcome.auth : null;
}
