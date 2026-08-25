import { getAddress } from "viem";

import { getLighterClient, type LighterClient } from "@tools/lighter/client.js";
import type { LighterTradingCredentialVaultReference } from "@tools/lighter/trading-credentials.js";
import { defaultLighterTradingVaultCredentialId } from "@tools/lighter/trading-credentials.js";
import type {
  ForgetLighterCredentialConnectionInput,
  ForgetLighterCredentialConnectionResult,
  InspectLighterCredentialConnectionsResult,
  LighterCredentialConnection,
  LighterCredentialScope,
} from "@shared/schemas/lighter-integration.js";
import { getPrimaryEvmAddress } from "@vex-lib/wallet.js";
import { getSecretSessionStatus } from "../secrets/session.js";
import {
  deleteUnlockedLighterTradingApiPrivateKeys,
  listUnlockedLighterTradingCredentialScopes,
  listUnlockedManagedLighterTradingCredentialScopes,
  type UnlockedLighterTradingCredentialScope,
} from "../secrets/lighter-trading-credential.js";

export type LighterCredentialCleanupFailure =
  | "vault_locked"
  | "primary_wallet_unavailable"
  | "provider_unavailable"
  | "protected_wallet"
  | "connection_not_found"
  | "state_changed"
  | "vault_write_failed";

export class LighterCredentialCleanupError extends Error {
  constructor(readonly reason: LighterCredentialCleanupFailure) {
    super(reason);
    this.name = "LighterCredentialCleanupError";
  }
}

interface LighterCredentialConnectionCleanupDeps {
  readonly client: Pick<LighterClient, "getAccount">;
  readonly isVaultUnlocked: () => boolean;
  readonly listScopes: () => readonly UnlockedLighterTradingCredentialScope[];
  readonly listManagedScopes: () => readonly UnlockedLighterTradingCredentialScope[];
  readonly getPrimaryEvmAddress: () => string | null;
  readonly deleteCredentials: (
    references: readonly LighterTradingCredentialVaultReference[],
  ) => void;
}

const productionDeps: LighterCredentialConnectionCleanupDeps = {
  client: getLighterClient(),
  isVaultUnlocked: () => getSecretSessionStatus().unlocked,
  listScopes: () => listUnlockedLighterTradingCredentialScopes(),
  listManagedScopes: () => listUnlockedManagedLighterTradingCredentialScopes(),
  getPrimaryEvmAddress: () => getPrimaryEvmAddress(),
  deleteCredentials: (references) => {
    deleteUnlockedLighterTradingApiPrivateKeys(references);
  },
};

interface OwnedScope {
  readonly walletAddress: string;
  readonly scope: LighterCredentialScope;
}

function scopeKey(scope: {
  readonly environment: "core" | "rhc";
  readonly accountIndex: number;
  readonly apiKeyIndex: number;
}): string {
  return `${scope.environment}:${scope.accountIndex}:${scope.apiKeyIndex}`;
}

function compareScopes(left: LighterCredentialScope, right: LighterCredentialScope): number {
  return left.environment.localeCompare(right.environment)
    || left.accountIndex - right.accountIndex
    || left.apiKeyIndex - right.apiKeyIndex;
}

function canonicalAddress(value: string): string {
  try {
    return getAddress(value);
  } catch {
    throw new LighterCredentialCleanupError("provider_unavailable");
  }
}

function accountIndexOf(account: {
  readonly index?: number;
  readonly account_index?: number;
}): number | null {
  const value = account.index ?? account.account_index;
  return Number.isSafeInteger(value) && value !== undefined && value >= 0
    ? value
    : null;
}

async function resolveOwnedScope(
  rawScope: UnlockedLighterTradingCredentialScope,
  managedKeys: ReadonlySet<string>,
  deps: LighterCredentialConnectionCleanupDeps,
): Promise<OwnedScope> {
  let response: Awaited<ReturnType<LighterCredentialConnectionCleanupDeps["client"]["getAccount"]>>;
  try {
    response = await deps.client.getAccount(rawScope.environment, {
      by: "index",
      value: rawScope.accountIndex,
    });
  } catch {
    throw new LighterCredentialCleanupError("provider_unavailable");
  }

  const matches = response.accounts.filter(
    (account) => accountIndexOf(account) === rawScope.accountIndex,
  );
  if (
    response.code !== 200
    || matches.length !== 1
    || typeof matches[0]?.l1_address !== "string"
  ) {
    throw new LighterCredentialCleanupError("provider_unavailable");
  }

  return {
    walletAddress: canonicalAddress(matches[0].l1_address),
    scope: {
      environment: rawScope.environment,
      accountIndex: rawScope.accountIndex,
      apiKeyIndex: rawScope.apiKeyIndex,
      managed: managedKeys.has(scopeKey(rawScope)),
    },
  };
}

export async function inspectLighterCredentialConnections(
  deps: LighterCredentialConnectionCleanupDeps = productionDeps,
): Promise<InspectLighterCredentialConnectionsResult> {
  if (!deps.isVaultUnlocked()) {
    throw new LighterCredentialCleanupError("vault_locked");
  }

  const rawScopes = deps.listScopes();
  if (rawScopes.length === 0) return { connections: [] };

  const managedKeys = new Set(deps.listManagedScopes().map(scopeKey));
  const ownedScopes = await Promise.all(
    rawScopes.map((scope) => resolveOwnedScope(scope, managedKeys, deps)),
  );
  const primaryAddress = deps.getPrimaryEvmAddress();
  if (primaryAddress === null) {
    throw new LighterCredentialCleanupError("primary_wallet_unavailable");
  }
  const protectedAddress = canonicalAddress(primaryAddress).toLowerCase();
  const groups = new Map<string, LighterCredentialConnection>();

  for (const owned of ownedScopes) {
    const key = owned.walletAddress.toLowerCase();
    const current = groups.get(key);
    if (current === undefined) {
      groups.set(key, {
        walletAddress: owned.walletAddress,
        protected: protectedAddress === key,
        scopes: [owned.scope],
      });
      continue;
    }
    groups.set(key, {
      ...current,
      scopes: [...current.scopes, owned.scope].sort(compareScopes),
    });
  }

  return {
    connections: [...groups.values()].sort((left, right) =>
      Number(right.protected) - Number(left.protected)
      || left.walletAddress.localeCompare(right.walletAddress),
    ),
  };
}

function scopesEqual(
  left: readonly LighterCredentialScope[],
  right: readonly LighterCredentialScope[],
): boolean {
  const a = [...left].sort(compareScopes);
  const b = [...right].sort(compareScopes);
  return a.length === b.length && a.every((scope, index) => {
    const candidate = b[index];
    return candidate !== undefined
      && scope.environment === candidate.environment
      && scope.accountIndex === candidate.accountIndex
      && scope.apiKeyIndex === candidate.apiKeyIndex
      && scope.managed === candidate.managed;
  });
}

function credentialReference(
  scope: LighterCredentialScope,
): LighterTradingCredentialVaultReference {
  return {
    kind: "encrypted_vault_reference",
    environment: scope.environment,
    accountIndex: scope.accountIndex,
    apiKeyIndex: scope.apiKeyIndex,
    vaultCredentialId: defaultLighterTradingVaultCredentialId(scope),
  };
}

export async function forgetLighterCredentialConnection(
  input: ForgetLighterCredentialConnectionInput,
  deps: LighterCredentialConnectionCleanupDeps = productionDeps,
): Promise<ForgetLighterCredentialConnectionResult> {
  const walletAddress = canonicalAddress(input.walletAddress);
  const inspection = await inspectLighterCredentialConnections(deps);
  const connection = inspection.connections.find(
    (candidate) => candidate.walletAddress.toLowerCase() === walletAddress.toLowerCase(),
  );
  if (connection === undefined) {
    throw new LighterCredentialCleanupError("connection_not_found");
  }
  if (connection.protected) {
    throw new LighterCredentialCleanupError("protected_wallet");
  }
  if (!scopesEqual(connection.scopes, input.scopes)) {
    throw new LighterCredentialCleanupError("state_changed");
  }

  try {
    deps.deleteCredentials(connection.scopes.map(credentialReference));
  } catch {
    throw new LighterCredentialCleanupError("vault_write_failed");
  }

  return {
    walletAddress: connection.walletAddress,
    removedScopes: connection.scopes,
  };
}
