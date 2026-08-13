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
}

const EMPTY_RESOLVER: LighterTradingCredentialScopeResolver = {
  findSavedScope: () => null,
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
