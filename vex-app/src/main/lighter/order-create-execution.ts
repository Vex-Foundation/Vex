import { getLighterClient } from "@tools/lighter/client.js";
import {
  buildLighterAccountAuthSigningInputForScope,
  createLighterAccountAuthWithAdapter,
} from "@tools/lighter/signer-adapter.js";
import { createLighterSignerBinaryAdapter } from "@tools/lighter/signer-binary-adapter.js";
import { loadLighterTradingSecretMaterial } from "@tools/lighter/trading-secret.js";
import {
  configureLighterLiveTradingReleaseGate,
  isLighterLiveTradingEnabled,
} from "@vex-agent/tools/protocols/lighter/execution-boundary.js";
import {
  configureLighterCreateOrderExecutionDeps,
  defaultLighterCreateOrderExecutionDeps,
} from "@vex-agent/tools/protocols/lighter/order-create-execution.js";
import { configureLighterRepairPrivilegedAccountAuthResolver } from "@vex-agent/tools/protocols/lighter/order-repair.js";
import { configureLighterTradingCredentialScopeResolver } from "@vex-agent/tools/protocols/lighter/trading-credential-scope.js";
import {
  createUnlockedVaultLighterTradingSecretReader,
  listUnlockedLighterTradingCredentialScopes,
} from "../secrets/lighter-trading-credential.js";
import { readLighterLiveTradingReleaseGateStatus } from "./live-trading-release-gate.js";

// Short-lived account-auth token lifetime for read-only reconciliation reads.
const REPAIR_ACCOUNT_AUTH_TTL_SECONDS = 10 * 60;

export function installLighterOrderCreateExecutionDeps(): () => void {
  const secretReader = createUnlockedVaultLighterTradingSecretReader();
  const signer = createLighterSignerBinaryAdapter();
  const uninstallReleaseGate = configureLighterLiveTradingReleaseGate(
    readLighterLiveTradingReleaseGateStatus,
  );
  const uninstallExecutionDeps = configureLighterCreateOrderExecutionDeps(
    defaultLighterCreateOrderExecutionDeps({
      liveTradingEnabled: isLighterLiveTradingEnabled,
      secretReader,
      signer,
      client: getLighterClient(),
    }),
  );
  // Lets lighter.order.status reconcile a stranded order from account evidence
  // even when only a trading key is saved, by deriving a short-lived read-only
  // account auth token. The token authorizes account reads only.
  const uninstallRepairAuth = configureLighterRepairPrivilegedAccountAuthResolver(
    async (reference) => {
      try {
        const secret = await loadLighterTradingSecretMaterial(reference, secretReader);
        const auth = await createLighterAccountAuthWithAdapter(
          buildLighterAccountAuthSigningInputForScope({
            environment: reference.environment,
            accountIndex: reference.accountIndex,
            apiKeyIndex: reference.apiKeyIndex,
            secret,
            deadlineUnixSeconds: Math.floor(Date.now() / 1_000) + REPAIR_ACCOUNT_AUTH_TTL_SECONDS,
          }),
          signer,
        );
        return { token: auth.authToken, accountIndex: reference.accountIndex };
      } catch {
        return null;
      }
    },
  );
  const uninstallScopeResolver = configureLighterTradingCredentialScopeResolver({
    findSavedScope: (environment, accountIndex) =>
      listUnlockedLighterTradingCredentialScopes(environment)
        .find((scope) => scope.accountIndex === accountIndex) ?? null,
    findDefaultScope: (environment) =>
      listUnlockedLighterTradingCredentialScopes(environment)[0] ?? null,
    // Expose the full list so preview resolution refuses to guess when more than
    // one account is configured, instead of silently picking the lowest index.
    listScopes: (environment) => listUnlockedLighterTradingCredentialScopes(environment),
  });
  return () => {
    uninstallRepairAuth();
    uninstallScopeResolver();
    uninstallExecutionDeps();
    uninstallReleaseGate();
  };
}
