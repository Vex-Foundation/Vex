import type { LighterEnvironment } from "@tools/lighter/constants.js";

export interface LighterSavedTradingCredentialScope {
  readonly environment: LighterEnvironment;
  readonly accountIndex: number;
  readonly apiKeyIndex: number;
}

// Async because the desktop resolver reads the encrypted vault, whose KDF runs
// off the main thread.
export interface LighterTradingCredentialScopeResolver {
  readonly findSavedScope: (
    environment: LighterEnvironment,
    accountIndex: number,
  ) => Promise<LighterSavedTradingCredentialScope | null>;
  readonly findDefaultScope?: (
    environment: LighterEnvironment,
  ) => Promise<LighterSavedTradingCredentialScope | null>;
  // Lists every saved trading scope for an environment. Preferred over
  // `findDefaultScope` because the caller can then refuse to guess when more
  // than one account is configured instead of silently picking one.
  readonly listScopes?: (
    environment: LighterEnvironment,
  ) => Promise<readonly LighterSavedTradingCredentialScope[]>;
}

const EMPTY_RESOLVER: LighterTradingCredentialScopeResolver = {
  findSavedScope: async () => null,
  findDefaultScope: async () => null,
  listScopes: async () => [],
};

let configuredResolver: LighterTradingCredentialScopeResolver = EMPTY_RESOLVER;

export function configureLighterTradingCredentialScopeResolver(
  resolver: LighterTradingCredentialScopeResolver,
): () => void {
  configuredResolver = resolver;
  return () => {
    if (configuredResolver === resolver) configuredResolver = EMPTY_RESOLVER;
  };
}

export function resolveSavedLighterTradingCredentialScope(
  environment: LighterEnvironment,
  accountIndex: number,
): Promise<LighterSavedTradingCredentialScope | null> {
  return configuredResolver.findSavedScope(environment, accountIndex);
}

export async function resolveDefaultLighterTradingCredentialScope(
  environment: LighterEnvironment,
): Promise<LighterSavedTradingCredentialScope | null> {
  return (await configuredResolver.findDefaultScope?.(environment)) ?? null;
}

export async function listLighterTradingCredentialScopes(
  environment: LighterEnvironment,
): Promise<readonly LighterSavedTradingCredentialScope[]> {
  return (await configuredResolver.listScopes?.(environment)) ?? [];
}
