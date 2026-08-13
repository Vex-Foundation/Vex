import { getLighterClient } from "@tools/lighter/client.js";
import { createLighterSignerBinaryAdapter } from "@tools/lighter/signer-binary-adapter.js";
import {
  configureLighterCreateOrderExecutionDeps,
  defaultLighterCreateOrderExecutionDeps,
} from "@vex-agent/tools/protocols/lighter/order-create-execution.js";
import { configureLighterTradingCredentialScopeResolver } from "@vex-agent/tools/protocols/lighter/trading-credential-scope.js";
import {
  createUnlockedVaultLighterTradingSecretReader,
  listUnlockedLighterTradingCredentialScopes,
} from "../secrets/lighter-trading-credential.js";

export function installLighterOrderCreateExecutionDeps(): () => void {
  const uninstallExecutionDeps = configureLighterCreateOrderExecutionDeps(
    defaultLighterCreateOrderExecutionDeps({
      secretReader: createUnlockedVaultLighterTradingSecretReader(),
      signer: createLighterSignerBinaryAdapter(),
      client: getLighterClient(),
    }),
  );
  const uninstallScopeResolver = configureLighterTradingCredentialScopeResolver({
    findSavedScope: (environment, accountIndex) =>
      listUnlockedLighterTradingCredentialScopes(environment)
        .find((scope) => scope.accountIndex === accountIndex) ?? null,
  });
  return () => {
    uninstallScopeResolver();
    uninstallExecutionDeps();
  };
}
