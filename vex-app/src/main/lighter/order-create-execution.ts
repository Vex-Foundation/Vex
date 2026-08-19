import { getLighterClient } from "@tools/lighter/client.js";
import {
  buildLighterAccountAuthSigningInputForScope,
  createLighterAccountAuthWithAdapter,
} from "@tools/lighter/signer-adapter.js";
import {
  createLighterSignerBinaryAdapter,
  createLighterOrderLifecycleSignerBinary,
  createLighterWithdrawalSignerBinary,
} from "@tools/lighter/signer-binary-adapter.js";
import { readLighterCoreWithdrawalPreflight } from "@tools/lighter/withdrawal/core-preflight.js";
import { readLighterRhcWithdrawalPreflight } from "@tools/lighter/withdrawal/rhc-preflight.js";
import { loadLighterTradingSecretMaterial } from "@tools/lighter/trading-secret.js";
import {
  configureLighterCreateOrderExecutionDeps,
  defaultLighterCreateOrderExecutionDeps,
} from "@vex-agent/tools/protocols/lighter/order-create-execution.js";
import {
  configureLighterOrderLifecycleExecutionDeps,
  defaultLighterOrderLifecycleExecutionDeps,
} from "@vex-agent/tools/protocols/lighter/order-lifecycle.js";
import { configureLighterRepairPrivilegedAccountAuthResolver } from "@vex-agent/tools/protocols/lighter/order-repair.js";
import { configureLighterReadOnlyAccountAuthResolver } from "@vex-agent/tools/protocols/lighter/read-account-auth.js";
import { configureLighterTradingCredentialScopeResolver } from "@vex-agent/tools/protocols/lighter/trading-credential-scope.js";
import { configureLighterManagedTradingReadinessResolver } from "@vex-agent/tools/protocols/lighter/managed-trading-readiness.js";
import { getLighterReadOnlyCredentialStatus } from "@tools/lighter/credentials.js";
import {
  defaultLighterTradingVaultCredentialId,
  type LighterTradingCredentialVaultReference,
} from "@tools/lighter/trading-credentials.js";
import type { LighterPrivilegedAccountAuth } from "@tools/lighter/client.js";
import type { LighterSignerAdapter } from "@tools/lighter/signer-adapter.js";
import type { LighterTradingSecretReader } from "@tools/lighter/trading-secret.js";
import {
  createUnlockedVaultLighterTradingSecretReader,
  listUnlockedLighterTradingCredentialScopes,
} from "../secrets/lighter-trading-credential.js";
import { resolveManagedLighterTradingReadiness } from "./managed-trading-readiness.js";
import { installLighterOrderStreamSupervisor } from "./order-stream.js";
import {
  configureLighterCoreWithdrawalExecutionDeps,
  defaultLighterCoreWithdrawalExecutionDeps,
} from "@vex-agent/tools/protocols/lighter/withdrawal-execution.js";
import { getUniswapDeployment } from "@tools/uniswap/deployments.js";
import { getUniswapPublicClient } from "@tools/uniswap/evm-client.js";
import { ErrorCodes, VexError } from "../../../../src/errors.js";

// Short-lived account-auth token lifetime for read-only reconciliation reads.
const REPAIR_ACCOUNT_AUTH_TTL_SECONDS = 10 * 60;

// Derives a short-lived READ-ONLY account auth token from a saved trading key
// for account reads only (never signing or sendTx). Shared by stuck-order
// repair and authenticated account reads so a single trading key covers both
// trading and read access. Returns null when the token cannot be minted (locked
// vault, signer unavailable, unknown scope).
export async function deriveLighterReadOnlyAccountAuth(
  reference: LighterTradingCredentialVaultReference,
  secretReader: LighterTradingSecretReader,
  signer: LighterSignerAdapter,
): Promise<LighterPrivilegedAccountAuth | null> {
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
}

export function installLighterOrderCreateExecutionDeps(): () => void {
  const secretReader = createUnlockedVaultLighterTradingSecretReader();
  const signer = createLighterSignerBinaryAdapter();
  const withdrawalSigner = createLighterWithdrawalSignerBinary();
  const lifecycleSigner = createLighterOrderLifecycleSignerBinary();
  const lighterClient = getLighterClient();
  const uninstallExecutionDeps = configureLighterCreateOrderExecutionDeps(
    defaultLighterCreateOrderExecutionDeps({
      secretReader,
      signer,
      client: lighterClient,
    }),
  );
  const uninstallLifecycleExecutionDeps = configureLighterOrderLifecycleExecutionDeps(
    defaultLighterOrderLifecycleExecutionDeps({
      secretReader,
      authSigner: signer,
      lifecycleSigner,
      client: lighterClient,
    }),
  );
  const uninstallWithdrawalExecutionDeps = configureLighterCoreWithdrawalExecutionDeps(
    defaultLighterCoreWithdrawalExecutionDeps({
      secretReader,
      authSigner: signer,
      withdrawalSigner,
      client: lighterClient,
      readPreflight: async (plan) => {
        const privilegedAuth = await deriveLighterReadOnlyAccountAuth(
          plan.credentialReference,
          secretReader,
          signer,
        );
        if (privilegedAuth === null) {
          throw new VexError(
            ErrorCodes.LIGHTER_INVALID_REQUEST,
            `${plan.environment.toUpperCase()} withdrawal revalidation could not derive bounded read-only account authorization.`,
            "Unlock the local vault and retry from a fresh approval. No withdrawal was signed.",
          );
        }
        const settlement = getUniswapDeployment(plan.settlementChainId);
        if (settlement === undefined) {
          throw new VexError(
            ErrorCodes.LIGHTER_INVALID_REQUEST,
            `${plan.environment.toUpperCase()} settlement deployment is unavailable for withdrawal revalidation.`,
            "No withdrawal was signed.",
          );
        }
        const preflightInput = {
          walletAddress: plan.walletAddress,
          accountIndex: plan.accountIndex,
          apiKeyIndex: plan.apiKeyIndex,
          amountUnits: BigInt(plan.amountUnits),
          client: lighterClient,
          privilegedAuth,
          publicClient: getUniswapPublicClient(settlement),
        };
        return plan.environment === "core"
          ? readLighterCoreWithdrawalPreflight(preflightInput)
          : readLighterRhcWithdrawalPreflight(preflightInput);
      },
    }),
  );
  const stopOrderStream = installLighterOrderStreamSupervisor({
    resolveAuth: (reference) =>
      deriveLighterReadOnlyAccountAuth(reference, secretReader, signer),
  });
  // Lets lighter.order.status reconcile a stranded order from account evidence
  // even when only a trading key is saved, by deriving a short-lived read-only
  // account auth token. The token authorizes account reads only.
  const uninstallRepairAuth = configureLighterRepairPrivilegedAccountAuthResolver(
    (reference) => deriveLighterReadOnlyAccountAuth(reference, secretReader, signer),
  );
  // Lets the authenticated account reads (open orders, order history, trades)
  // work on a single-key setup by deriving the same short-lived read-only token
  // from the saved trading key, instead of failing over to inference. Prefers a
  // separately configured read-only token when one exists.
  const uninstallReadAuth = configureLighterReadOnlyAccountAuthResolver(
    async (environment, accountIndex) => {
      if (getLighterReadOnlyCredentialStatus(environment).configured) return null;
      const scope = listUnlockedLighterTradingCredentialScopes(environment)
        .find((candidate) => candidate.accountIndex === accountIndex);
      if (scope === undefined) return null;
      const reference: LighterTradingCredentialVaultReference = {
        kind: "encrypted_vault_reference",
        environment: scope.environment,
        accountIndex: scope.accountIndex,
        apiKeyIndex: scope.apiKeyIndex,
        vaultCredentialId: defaultLighterTradingVaultCredentialId(scope),
      };
      return deriveLighterReadOnlyAccountAuth(reference, secretReader, signer);
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
  const uninstallReadinessResolver = configureLighterManagedTradingReadinessResolver({
    read: (environment, accountIndex) =>
      resolveManagedLighterTradingReadiness(environment, accountIndex),
  });
  return () => {
    stopOrderStream();
    uninstallRepairAuth();
    uninstallReadAuth();
    uninstallScopeResolver();
    uninstallReadinessResolver();
    uninstallWithdrawalExecutionDeps();
    uninstallLifecycleExecutionDeps();
    uninstallExecutionDeps();
  };
}
