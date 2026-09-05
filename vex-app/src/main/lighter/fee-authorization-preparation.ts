import { randomUUID } from "node:crypto";
import { getAddress } from "viem";
import {
  getLighterClient,
  type LighterClient,
  type LighterPrivilegedAccountAuth,
} from "@tools/lighter/client.js";
import {
  assertLighterFeeAllowance,
  assertLighterFeePolicyLive,
  getLighterFeePolicy,
  LIGHTER_FEE_AUTHORIZATION_DURATION_MS,
  type LighterFeePolicy,
} from "@tools/lighter/fee-policy.js";
import {
  buildLighterAccountAuthSigningInputForScope,
  createLighterAccountAuthWithAdapter,
} from "@tools/lighter/signer-adapter.js";
import { createLighterSignerBinaryAdapter } from "@tools/lighter/signer-binary-adapter.js";
import {
  defaultLighterTradingVaultCredentialId,
  type LighterTradingCredentialVaultReference,
} from "@tools/lighter/trading-credentials.js";
import { loadLighterTradingSecretMaterial } from "@tools/lighter/trading-secret.js";
import { readUniqueLighterMasterAccount } from "@tools/lighter/wallet-funding/account-ownership.js";
import type {
  LighterAccount,
  LighterAccountLimitsResponse,
} from "@tools/lighter/types.js";
import * as intents from "@vex-agent/db/repos/lighter-fee-authorization-intents.js";
import { isLighterIntegrationEnabled } from "@vex-agent/db/repos/lighter-integration-settings.js";
import { withSessionControlLock } from "@vex-agent/engine/runtime/lease-and-status/session-control-lock.js";
import { resolveSelectedAddress } from "@vex-agent/tools/internal/wallet/resolve.js";
import type {
  LighterFeeAuthorizationSetupInput,
  LighterFeeAuthorizationReadiness,
} from "@vex-agent/tools/protocols/lighter/fee-authorization-execution.js";
import {
  createUnlockedVaultLighterTradingSecretReader,
  listUnlockedManagedLighterTradingCredentialScopes,
} from "../secrets/lighter-trading-credential.js";

export interface LighterFeeAuthorizationPreparationDeps {
  readonly client: Pick<
    LighterClient,
    | "getAccountsByL1Address"
    | "getAccount"
    | "getAccountLimits"
    | "getSystemConfig"
    | "getApiKeys"
  >;
  readonly policy: typeof getLighterFeePolicy;
  readonly listScopes: typeof listUnlockedManagedLighterTradingCredentialScopes;
  readonly integrationEnabled: typeof isLighterIntegrationEnabled;
  readonly auth: typeof deriveFeeAuthorizationAccountAuth;
  readonly now: () => number;
}
export interface LighterFeeAuthorizationObserved {
  readonly walletAddress: string;
  readonly accountIndex: number;
  readonly apiKeyIndex: number;
  readonly publicKey: string;
  readonly account: LighterAccount;
  readonly limits: LighterAccountLimitsResponse;
  readonly auth: LighterPrivilegedAccountAuth;
  readonly policy: LighterFeePolicy;
}

export function defaultLighterFeeAuthorizationPreparationDeps(): LighterFeeAuthorizationPreparationDeps {
  return {
    client: getLighterClient(),
    policy: getLighterFeePolicy,
    listScopes: listUnlockedManagedLighterTradingCredentialScopes,
    integrationEnabled: isLighterIntegrationEnabled,
    auth: deriveFeeAuthorizationAccountAuth,
    now: Date.now,
  };
}

async function deriveFeeAuthorizationAccountAuth(
  reference: LighterTradingCredentialVaultReference,
): Promise<{ auth: LighterPrivilegedAccountAuth; publicKey: string }> {
  try {
    const secret = await loadLighterTradingSecretMaterial(
      reference,
      createUnlockedVaultLighterTradingSecretReader(),
    );
    const signed = await createLighterAccountAuthWithAdapter(
      buildLighterAccountAuthSigningInputForScope({
        ...reference,
        secret,
        deadlineUnixSeconds: Math.floor(Date.now() / 1000) + 600,
      }),
      createLighterSignerBinaryAdapter(),
    );
    return {
      auth: { token: signed.authToken, accountIndex: reference.accountIndex },
      publicKey: signed.publicKey,
    };
  } catch {
    throw new Error(
      "Unlock the local Lighter trading credential before checking fee setup.",
    );
  }
}

export function exactFeeAccount(
  response: Awaited<ReturnType<LighterClient["getAccount"]>>,
  accountIndex: number,
  walletAddress: string,
): LighterAccount {
  const matches = response.accounts.filter(
    (account) => (account.index ?? account.account_index) === accountIndex,
  );
  if (
    response.code !== 200 ||
    response.accounts.length !== 1 ||
    matches.length !== 1 ||
    getAddress(matches[0]!.l1_address ?? "") !== getAddress(walletAddress)
  ) {
    throw new Error(
      "The live Lighter account does not match the selected wallet.",
    );
  }
  return matches[0]!;
}

export async function readLighterFeeAuthorizationSetup(
  input: LighterFeeAuthorizationSetupInput,
  deps: LighterFeeAuthorizationPreparationDeps = defaultLighterFeeAuthorizationPreparationDeps(),
  storedIntent?: intents.LighterFeeAuthorizationIntentRow,
): Promise<LighterFeeAuthorizationObserved> {
  const policy = storedIntent
    ? feePolicyForStoredIntent(storedIntent)
    : deps.policy(input.environment);
  if (!policy)
    throw new Error(
      "VEX fee collection is not configured for this Lighter deployment.",
    );
  const walletAddress = getAddress(
    resolveSelectedAddress(
      input.walletResolution,
      input.walletPolicy,
      "eip155",
    ),
  );
  if (
    !storedIntent &&
    !(await deps.integrationEnabled(input.environment, walletAddress))
  )
    throw new Error("Enable Lighter for this wallet before fee setup.");
  const accountIndex = await readUniqueLighterMasterAccount(
    deps.client,
    input.environment,
    walletAddress,
  );
  if (
    storedIntent &&
    (storedIntent.environment !== input.environment ||
      storedIntent.accountIndex !== accountIndex ||
      getAddress(storedIntent.walletAddress) !== walletAddress)
  ) {
    throw new Error(
      "The previous fee approval does not belong to the selected wallet and deployment.",
    );
  }
  const scopes = deps
    .listScopes(input.environment)
    .filter((scope) => scope.accountIndex === accountIndex);
  if (scopes.length !== 1)
    throw new Error(
      "Complete secure Lighter trading-key setup before authorizing fees.",
    );
  const apiKeyIndex = scopes[0]!.apiKeyIndex;
  const reference: LighterTradingCredentialVaultReference = {
    kind: "encrypted_vault_reference",
    environment: input.environment,
    accountIndex,
    apiKeyIndex,
    vaultCredentialId: defaultLighterTradingVaultCredentialId({
      environment: input.environment,
      accountIndex,
      apiKeyIndex,
    }),
  };
  const keys = await deps.client.getApiKeys(
    input.environment,
    { accountIndex, apiKeyIndex },
    { fresh: true },
  );
  if (
    keys.code !== 200 ||
    keys.api_keys.length !== 1 ||
    keys.api_keys[0]!.account_index !== accountIndex ||
    keys.api_keys[0]!.api_key_index !== apiKeyIndex
  )
    throw new Error("The active Lighter trading key could not be verified.");
  const { auth, publicKey } = await deps.auth(reference);
  if (
    publicKey !== keys.api_keys[0]!.public_key.toLowerCase().replace(/^0x/, "")
  ) {
    throw new Error(
      "The local trading key does not match the live Lighter account.",
    );
  }
  const [response, collector, config, limits] = await Promise.all([
    deps.client.getAccount(
      input.environment,
      { by: "index", value: accountIndex },
      { fresh: true },
    ),
    deps.client.getAccount(
      input.environment,
      { by: "index", value: policy.collectorAccountIndex },
      { fresh: true },
    ),
    deps.client.getSystemConfig(input.environment, { fresh: true }),
    deps.client.getAccountLimits(input.environment, { accountIndex }, auth),
  ]);
  const account = exactFeeAccount(response, accountIndex, walletAddress);
  const collectorAccount = exactFeeAccount(
    collector,
    policy.collectorAccountIndex,
    policy.collectorL1Address,
  );
  if (!storedIntent)
    assertLighterFeePolicyLive(policy, {
      systemConfig: config,
      collectorAccount,
    });
  if (limits.code !== 200)
    throw new Error(
      "The account's Lighter tier and exchange fees could not be verified.",
    );
  return {
    walletAddress,
    accountIndex,
    apiKeyIndex,
    publicKey,
    account,
    limits,
    auth,
    policy,
  };
}

export async function inspectLighterFeeAuthorization(
  input: LighterFeeAuthorizationSetupInput,
  deps: LighterFeeAuthorizationPreparationDeps = defaultLighterFeeAuthorizationPreparationDeps(),
): Promise<LighterFeeAuthorizationReadiness> {
  if (!deps.policy(input.environment))
    return {
      status: "disabled",
      reason: "VEX fee collection is not enabled for this deployment.",
      accountIndex: null,
    };
  try {
    const observed = await readLighterFeeAuthorizationSetup(input, deps);
    try {
      assertLighterFeeAllowance(observed.policy, {
        account: observed.account,
        accountLimits: observed.limits,
        nowMs: deps.now(),
      });
      return {
        status: "ready",
        reason:
          "The trading account has a valid VEX spot and perpetual fee authorization.",
        accountIndex: observed.accountIndex,
      };
    } catch {
      const approved = observed.account.approved_integrators;
      if (!Array.isArray(approved))
        return {
          status: "blocked",
          reason: "Lighter did not return fee-authorization evidence.",
          accountIndex: observed.accountIndex,
        };
      if (
        !approved.some(
          (entry) =>
            entry.account_index === observed.policy.collectorAccountIndex,
        ) &&
        approved.filter((entry) => entry.approval_expiry > deps.now()).length >=
          4
      ) {
        return {
          status: "blocked",
          reason:
            "This Lighter account has no free integrator approval slot. Revoke an unused authorization before VEX fee setup.",
          accountIndex: observed.accountIndex,
        };
      }
      if (
        !["standard", "plus", "premium"].includes(
          observed.limits.user_tier.toLowerCase(),
        )
      ) {
        return {
          status: "blocked",
          reason:
            "This Lighter account tier is not supported for VEX fee setup.",
          accountIndex: observed.accountIndex,
        };
      }
      return {
        status: "needs_approval",
        reason:
          "Approve VEX's 0.1% perpetual and 0.25% spot trading fees during setup.",
        accountIndex: observed.accountIndex,
      };
    }
  } catch (error) {
    return {
      status: "blocked",
      reason:
        error instanceof Error
          ? error.message
          : "Lighter fee setup could not be verified.",
      accountIndex: null,
    };
  }
}

export function buildLighterFeeAuthorizationTerms(
  observed: LighterFeeAuthorizationObserved,
  revoke: boolean,
  nowMs: number,
): intents.LighterFeeAuthorizationTerms {
  const tier = observed.limits.user_tier.toLowerCase();
  const targetTier =
    !revoke && tier === "standard"
      ? observed.policy.environment === "core"
        ? "plus"
        : "premium"
      : null;
  // Published base fees are a ceiling; post-change authenticated limits must
  // stay within this exact approved ceiling before consent can be submitted.
  const targetFees =
    observed.policy.environment === "core"
      ? { maker: 50, taker: 50 }
      : { maker: 120, taker: 350 };
  return {
    collectorAccountIndex: observed.policy.collectorAccountIndex,
    collectorL1Address: observed.policy.collectorL1Address,
    maxPerpsMakerFee: revoke ? 0 : observed.policy.perpsMakerFee,
    maxPerpsTakerFee: revoke ? 0 : observed.policy.perpsTakerFee,
    maxSpotMakerFee: revoke ? 0 : observed.policy.spotMakerFee,
    maxSpotTakerFee: revoke ? 0 : observed.policy.spotTakerFee,
    authorizationExpiryMs: revoke
      ? 0
      : nowMs + LIGHTER_FEE_AUTHORIZATION_DURATION_MS,
    revoke,
    publicKey: observed.publicKey,
    currentTier: tier,
    targetTier,
    exchangeMakerFeeTick: targetTier
      ? targetFees.maker
      : observed.limits.current_maker_fee_tick,
    exchangeTakerFeeTick: targetTier
      ? targetFees.taker
      : observed.limits.current_taker_fee_tick,
  };
}

export async function prepareLighterFeeAuthorization(
  input: LighterFeeAuthorizationSetupInput & { readonly revoke?: boolean },
  deps: LighterFeeAuthorizationPreparationDeps = defaultLighterFeeAuthorizationPreparationDeps(),
): Promise<intents.LighterFeeAuthorizationIntentRow> {
  let storedIntent: intents.LighterFeeAuthorizationIntentRow | undefined;
  if (input.revoke) {
    const wallet = resolveSelectedAddress(
      input.walletResolution,
      input.walletPolicy,
      "eip155",
    );
    const accountIndex = await readUniqueLighterMasterAccount(
      deps.client,
      input.environment,
      wallet,
    );
    storedIntent =
      (await intents.findLatestApprovedLighterFeeAuthorization(
        input.environment,
        accountIndex,
      )) ?? undefined;
    if (!storedIntent)
      throw new Error(
        "This wallet has no previous VEX fee approval to revoke.",
      );
  }
  const observed = await readLighterFeeAuthorizationSetup(
    input,
    deps,
    storedIntent,
  );
  const terms = buildLighterFeeAuthorizationTerms(
    observed,
    input.revoke === true,
    deps.now(),
  );
  await withSessionControlLock(input.sessionId, (client) =>
    intents.expirePendingLighterFeeAuthorizationWith(
      client,
      input.environment,
      observed.accountIndex,
    ),
  );
  const existing = await intents.findLiveLighterFeeAuthorizationIntent(
    input.environment,
    observed.accountIndex,
  );
  if (existing) {
    if (
      existing.sessionId !== input.sessionId ||
      existing.walletAddress.toLowerCase() !==
        observed.walletAddress.toLowerCase()
    ) {
      throw new Error(
        "An unfinished fee authorization belongs to another VEX session. Resolve that approval first.",
      );
    }
    if (
      existing.terms.revoke !== terms.revoke ||
      existing.terms.collectorAccountIndex !== terms.collectorAccountIndex ||
      existing.terms.collectorL1Address.toLowerCase() !==
        terms.collectorL1Address.toLowerCase() ||
      existing.terms.publicKey !== terms.publicKey ||
      existing.apiKeyIndex !== observed.apiKeyIndex ||
      existing.terms.maxPerpsMakerFee !== terms.maxPerpsMakerFee ||
      existing.terms.maxPerpsTakerFee !== terms.maxPerpsTakerFee ||
      existing.terms.maxSpotMakerFee !== terms.maxSpotMakerFee ||
      existing.terms.maxSpotTakerFee !== terms.maxSpotTakerFee
    ) {
      throw new Error(
        "Finish or reject the existing fee authorization before changing its terms.",
      );
    }
    if (
      (existing.executionState === "tier_ready" ||
        (existing.executionState === "approved" &&
          existing.expiresAt.getTime() <= deps.now())) &&
      existing.nonceValue === null &&
      existing.txHash === null
    ) {
      const retired = await withSessionControlLock(input.sessionId, (client) =>
        intents.retireUnsignedLighterFeeAuthorizationWith(client, existing),
      );
      if (!retired)
        throw new Error(
          "Fee setup advanced while its approval was being refreshed. Check its status.",
        );
    } else {
      return existing;
    }
  }
  return withSessionControlLock(input.sessionId, (client) =>
    intents.createLighterFeeAuthorizationIntentWith(client, {
      intentId: `lighter-fees-${randomUUID()}`,
      sessionId: input.sessionId,
      environment: input.environment,
      walletAddress: observed.walletAddress,
      accountIndex: observed.accountIndex,
      apiKeyIndex: observed.apiKeyIndex,
      terms,
      expiresAt: new Date(deps.now() + 15 * 60_000),
    }),
  );
}

export function feePolicyForStoredIntent(
  intent: intents.LighterFeeAuthorizationIntentRow,
): LighterFeePolicy {
  if (
    intent.approvalStatus !== "approved" ||
    !intent.approvalId ||
    !/^0x[0-9a-fA-F]{40}$/.test(intent.terms.collectorL1Address) ||
    !Number.isSafeInteger(intent.terms.collectorAccountIndex) ||
    intent.terms.collectorAccountIndex < 1 ||
    intent.terms.collectorAccountIndex >= 2 ** 48 - 1 ||
    (intent.environment !== "core" && intent.environment !== "rhc") ||
    intent.terms.maxPerpsMakerFee !== (intent.terms.revoke ? 0 : 1000) ||
    intent.terms.maxPerpsTakerFee !== (intent.terms.revoke ? 0 : 1000) ||
    intent.terms.maxSpotMakerFee !== (intent.terms.revoke ? 0 : 2500) ||
    intent.terms.maxSpotTakerFee !== (intent.terms.revoke ? 0 : 2500)
  ) {
    throw new Error(
      "The previous host-approved fee collector cannot be verified.",
    );
  }
  return {
    environment: intent.environment,
    collectorAccountIndex: intent.terms.collectorAccountIndex,
    collectorL1Address: intent.terms.collectorL1Address,
    perpsMakerFee: 1000,
    perpsTakerFee: 1000,
    spotMakerFee: 2500,
    spotTakerFee: 2500,
  };
}
