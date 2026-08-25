import { describe, expect, it, vi } from "vitest";

import {
  forgetLighterCredentialConnection,
  inspectLighterCredentialConnections,
} from "../credential-connection-cleanup.js";

const PRIMARY = "0x1111111111111111111111111111111111111111";
const STRAY = "0x2222222222222222222222222222222222222222";

const PRIMARY_SCOPES = [
  { environment: "core" as const, accountIndex: 737810, apiKeyIndex: 4 },
  { environment: "rhc" as const, accountIndex: 10231, apiKeyIndex: 4 },
];
const STRAY_SCOPES = [
  { environment: "core" as const, accountIndex: 736778, apiKeyIndex: 7 },
  { environment: "rhc" as const, accountIndex: 1171, apiKeyIndex: 7 },
];

function setup(overrides: Record<string, unknown> = {}) {
  const owners = new Map<number, string>([
    [737810, PRIMARY],
    [10231, PRIMARY],
    [736778, STRAY],
    [1171, STRAY],
  ]);
  const deleteCredentials = vi.fn();
  const deps = {
    client: {
      getAccount: vi.fn(async (_environment: "core" | "rhc", query: { value: number | string }) => ({
        code: 200,
        accounts: [{
          index: Number(query.value),
          l1_address: owners.get(Number(query.value)),
        }],
      })),
    },
    isVaultUnlocked: () => true,
    listScopes: () => [...PRIMARY_SCOPES, ...STRAY_SCOPES],
    listManagedScopes: () => [...PRIMARY_SCOPES, ...STRAY_SCOPES],
    getPrimaryEvmAddress: () => PRIMARY,
    deleteCredentials,
    ...overrides,
  };
  return { deps, deleteCredentials };
}

describe("Lighter credential connection cleanup", () => {
  it("groups scopes by live owner and protects only the current primary Vex wallet", async () => {
    const { deps } = setup();

    await expect(inspectLighterCredentialConnections(deps)).resolves.toEqual({
      connections: [
        {
          walletAddress: PRIMARY,
          protected: true,
          scopes: PRIMARY_SCOPES.map((scope) => ({ ...scope, managed: true })),
        },
        {
          walletAddress: STRAY,
          protected: false,
          scopes: STRAY_SCOPES.map((scope) => ({ ...scope, managed: true })),
        },
      ],
    });
  });

  it("derives protection from the installation's current primary wallet", async () => {
    const { deps } = setup({ getPrimaryEvmAddress: () => STRAY });

    const result = await inspectLighterCredentialConnections(deps);

    expect(result.connections).toEqual([
      expect.objectContaining({ walletAddress: STRAY, protected: true }),
      expect.objectContaining({ walletAddress: PRIMARY, protected: false }),
    ]);
  });

  it("fails closed when the installation has no primary EVM wallet", async () => {
    const { deps, deleteCredentials } = setup({ getPrimaryEvmAddress: () => null });

    await expect(inspectLighterCredentialConnections(deps)).rejects.toMatchObject({
      reason: "primary_wallet_unavailable",
    });
    expect(deleteCredentials).not.toHaveBeenCalled();
  });

  it("refuses to forget the primary wallet before any vault write", async () => {
    const { deps, deleteCredentials } = setup();

    await expect(forgetLighterCredentialConnection({
      walletAddress: PRIMARY,
      scopes: PRIMARY_SCOPES.map((scope) => ({ ...scope, managed: true })),
    }, deps)).rejects.toMatchObject({
      reason: "protected_wallet",
    });
    expect(deleteCredentials).not.toHaveBeenCalled();
  });

  it("rechecks which wallet is primary immediately before deletion", async () => {
    const getPrimary = vi.fn()
      .mockReturnValueOnce(PRIMARY)
      .mockReturnValueOnce(STRAY);
    const { deps, deleteCredentials } = setup({ getPrimaryEvmAddress: getPrimary });
    const reviewedScopes = STRAY_SCOPES.map((scope) => ({ ...scope, managed: true }));

    await inspectLighterCredentialConnections(deps);
    await expect(forgetLighterCredentialConnection({
      walletAddress: STRAY,
      scopes: reviewedScopes,
    }, deps)).rejects.toMatchObject({ reason: "protected_wallet" });
    expect(deleteCredentials).not.toHaveBeenCalled();
  });

  it("removes only the reverified stray wallet scopes in one vault call", async () => {
    const { deps, deleteCredentials } = setup();
    const reviewedScopes = STRAY_SCOPES.map((scope) => ({ ...scope, managed: true }));

    await expect(forgetLighterCredentialConnection({
      walletAddress: STRAY,
      scopes: reviewedScopes,
    }, deps)).resolves.toEqual({
      walletAddress: STRAY,
      removedScopes: reviewedScopes,
    });
    expect(deleteCredentials).toHaveBeenCalledTimes(1);
    expect(deleteCredentials).toHaveBeenCalledWith([
      expect.objectContaining({
        environment: "core",
        accountIndex: 736778,
        apiKeyIndex: 7,
        vaultCredentialId: "lighter/core/account-736778/api-key-7",
      }),
      expect.objectContaining({
        environment: "rhc",
        accountIndex: 1171,
        apiKeyIndex: 7,
        vaultCredentialId: "lighter/rhc/account-1171/api-key-7",
      }),
    ]);
  });

  it("fails closed when reviewed scopes drift before confirmation", async () => {
    const { deps, deleteCredentials } = setup();

    await expect(forgetLighterCredentialConnection({
      walletAddress: STRAY,
      scopes: [{ ...STRAY_SCOPES[0]!, managed: true }],
    }, deps)).rejects.toMatchObject({
      reason: "state_changed",
    });
    expect(deleteCredentials).not.toHaveBeenCalled();
  });

  it("fails closed when any live owner read is unavailable", async () => {
    const { deps, deleteCredentials } = setup({
      client: {
        getAccount: vi.fn(async () => {
          throw new Error("provider detail must stay redacted");
        }),
      },
    });

    await expect(inspectLighterCredentialConnections(deps)).rejects.toMatchObject({
      reason: "provider_unavailable",
    });
    expect(deleteCredentials).not.toHaveBeenCalled();
  });

  it("requires the local vault to be unlocked", async () => {
    const { deps, deleteCredentials } = setup({ isVaultUnlocked: () => false });

    await expect(inspectLighterCredentialConnections(deps)).rejects.toMatchObject({
      reason: "vault_locked",
    });
    expect(deleteCredentials).not.toHaveBeenCalled();
  });
});
