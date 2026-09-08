import type { LighterEnvironment } from "@tools/lighter/constants.js";

export interface LighterSavedTradingCredentialScope {
  readonly environment: LighterEnvironment;
  readonly accountIndex: number;
  readonly apiKeyIndex: number;
}

export interface LighterTradingCredentialScopeResolver {
  readonly findSavedScope: (
    environment: LighterEnvironment,
    accountIndex: number,
  ) => LighterSavedTradingCredentialScope | null;
  readonly findDefaultScope?: (
    environment: LighterEnvironment,
  ) => LighterSavedTradingCredentialScope | null;
  // Lists every saved trading scope for an environment. Preferred over
  // `findDefaultScope` because the caller can then refuse to guess when more
  // than one account is configured instead of silently picking one.
  readonly listScopes?: (
    environment: LighterEnvironment,
  ) => readonly LighterSavedTradingCredentialScope[];
}

const EMPTY_RESOLVER: LighterTradingCredentialScopeResolver = {
  findSavedScope: () => null,
  findDefaultScope: () => null,
  listScopes: () => [],
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
): LighterSavedTradingCredentialScope | null {
  return configuredResolver.findSavedScope(environment, accountIndex);
}

export function resolveDefaultLighterTradingCredentialScope(
  environment: LighterEnvironment,
): LighterSavedTradingCredentialScope | null {
  return configuredResolver.findDefaultScope?.(environment) ?? null;
}

export function listLighterTradingCredentialScopes(
  environment: LighterEnvironment,
): readonly LighterSavedTradingCredentialScope[] {
  return configuredResolver.listScopes?.(environment) ?? [];
}
