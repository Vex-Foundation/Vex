import { getLighterClient } from "@tools/lighter/client.js";
import { createLighterSignerBinaryAdapter } from "@tools/lighter/signer-binary-adapter.js";
import {
  configureLighterLiveTradingReleaseGate,
  isLighterLiveTradingEnabled,
} from "@vex-agent/tools/protocols/lighter/execution-boundary.js";
import {
  configureLighterCreateOrderExecutionDeps,
  defaultLighterCreateOrderExecutionDeps,
} from "@vex-agent/tools/protocols/lighter/order-create-execution.js";
import { configureLighterTradingCredentialScopeResolver } from "@vex-agent/tools/protocols/lighter/trading-credential-scope.js";
import {
  createUnlockedVaultLighterTradingSecretReader,
  listUnlockedLighterTradingCredentialScopes,
} from "../secrets/lighter-trading-credential.js";
import { readLighterLiveTradingReleaseGateStatus } from "./live-trading-release-gate.js";

export function installLighterOrderCreateExecutionDeps(): () => void {
  const uninstallReleaseGate = configureLighterLiveTradingReleaseGate(
    readLighterLiveTradingReleaseGateStatus,
  );
  const uninstallExecutionDeps = configureLighterCreateOrderExecutionDeps(
    defaultLighterCreateOrderExecutionDeps({
      liveTradingEnabled: isLighterLiveTradingEnabled,
      secretReader: createUnlockedVaultLighterTradingSecretReader(),
      signer: createLighterSignerBinaryAdapter(),
      client: getLighterClient(),
    }),
  );
  const uninstallScopeResolver = configureLighterTradingCredentialScopeResolver({
    findSavedScope: (environment, accountIndex) =>
      listUnlockedLighterTradingCredentialScopes(environment)
        .find((scope) => scope.accountIndex === accountIndex) ?? null,
    findDefaultScope: (environment) =>
      listUnlockedLighterTradingCredentialScopes(environment)[0] ?? null,
  });
  return () => {
    uninstallScopeResolver();
    uninstallExecutionDeps();
    uninstallReleaseGate();
  };
}
