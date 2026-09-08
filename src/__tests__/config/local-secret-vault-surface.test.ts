/**
 * Compatibility-façade surface test for `local-secret-vault.ts` after the
 * structural split into `./local-secret-vault/` modules (crypto / status /
 * lifecycle / env).
 *
 * Pins the EXACT runtime export set of the façade + each export's typeof, so a
 * caller importing from the old path (`../../lib/local-secret-vault.js`,
 * re-exported via @vex-lib and consumed by 13 importers across tools/engine and
 * the vex-app main process) sees no difference. Type-only imports of the
 * exported types must also compile against the façade.
 */

import { describe, expect, it } from "vitest";
import * as vaultMod from "../../lib/local-secret-vault.js";

// Type-only imports of the 3 exported types must compile against the façade.
type _Options = import("../../lib/local-secret-vault.js").LocalSecretVaultOptions;
type _Status = import("../../lib/local-secret-vault.js").LocalSecretVaultStatus;
type _Contents = import("../../lib/local-secret-vault.js").LocalSecretVaultContents;

describe("local-secret-vault façade surface", () => {
  it("exposes exactly the expected runtime exports with correct typeof", () => {
    // The exact set of RUNTIME export keys (the 3 types are erased at runtime).
    const keys = Object.keys(vaultMod).sort();
    expect(keys).toEqual([
      "CURRENT_KDF_PARAMS",
      "LocalSecretVaultError",
      "applySecretVaultToProcessEnv",
      "createSecretVault",
      "getSecretVaultStatus",
      "secretVaultExists",
      "stripManagedSecretsFromDotenvFile",
      "unlockSecretVault",
      "verifySecretVaultPassword",
      // Lighter trading-credential boundary: non-env extra secrets stored in
      // the same encrypted vault file, never mirrored into process env.
      "writeSecretVaultExtraSecrets",
      "writeSecretVaultSecrets",
    ]);

    expect(typeof vaultMod.CURRENT_KDF_PARAMS).toBe("object");
    expect(typeof vaultMod.LocalSecretVaultError).toBe("function");
    expect(typeof vaultMod.secretVaultExists).toBe("function");
    expect(typeof vaultMod.getSecretVaultStatus).toBe("function");
    expect(typeof vaultMod.createSecretVault).toBe("function");
    expect(typeof vaultMod.verifySecretVaultPassword).toBe("function");
    expect(typeof vaultMod.unlockSecretVault).toBe("function");
    expect(typeof vaultMod.writeSecretVaultSecrets).toBe("function");
    expect(typeof vaultMod.writeSecretVaultExtraSecrets).toBe("function");
    expect(typeof vaultMod.applySecretVaultToProcessEnv).toBe("function");
    expect(typeof vaultMod.stripManagedSecretsFromDotenvFile).toBe("function");

    // Keep the type-only imports referenced so they are not elided as unused.
    const _typeProbe: ReadonlyArray<_Options | _Status | _Contents> = [];
    void _typeProbe;
  });
});
