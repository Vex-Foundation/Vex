/**
 * Offline privileged signing of one TxType 20 leverage change.
 *
 * The executor has already reserved the nonce durably and persisted the wire
 * expiry before this runs, so an interrupted attempt is strictly
 * reconciliation-only. This module re-derives the key from the vault and refuses
 * if it is not the key the proposal was bound to: a credential swapped between
 * consent and signing must not sign.
 *
 * NOTHING SENSITIVE ESCAPES. A failure is re-thrown as a sanitized error that
 * carries only the signer child's END STATE, because the executor decides on
 * that whether the reserved nonce may be released. Helper stderr, the private
 * key and the signed payload never leave this function.
 */

import { app } from "electron";
import {
  buildLighterUpdateLeverageSigningInput,
  type LighterLeverageSignerAdapter,
  type LighterUpdateLeverageSignerResult,
} from "@tools/lighter/signer-leverage.js";
import {
  carryLighterSignerChildState,
  createLighterApiKeyGeneratorBinary,
  createLighterLeverageSignerBinary,
} from "@tools/lighter/signer-binary-adapter.js";
import {
  defaultLighterTradingVaultCredentialId,
  type LighterTradingCredentialVaultReference,
} from "@tools/lighter/trading-credentials.js";
import { loadLighterTradingSecretMaterial } from "@tools/lighter/trading-secret.js";
import type { LighterLeverageIntentRow } from "@vex-agent/db/repos/lighter-leverage-intents.js";
import {
  createUnlockedVaultLighterTradingSecretReader,
  getUnlockedLighterTradingCredentialRegistrationState,
  LIGHTER_TRADING_CREDENTIAL_ACTIVE_STATE,
} from "../secrets/lighter-trading-credential.js";

export interface LighterLeverageSigningDeps {
  readonly readVaultRegistrationState: typeof getUnlockedLighterTradingCredentialRegistrationState;
  readonly loadSecret: typeof loadLighterTradingSecretMaterial;
  readonly keyGenerator: ReturnType<typeof createLighterApiKeyGeneratorBinary>;
  readonly signer: LighterLeverageSignerAdapter;
}

export function defaultLighterLeverageSigningDeps(): LighterLeverageSigningDeps {
  return {
    readVaultRegistrationState: getUnlockedLighterTradingCredentialRegistrationState,
    loadSecret: loadLighterTradingSecretMaterial,
    keyGenerator: createLighterApiKeyGeneratorBinary({
      allowBinaryPathOverride: !app.isPackaged,
    }),
    signer: createLighterLeverageSignerBinary({
      allowBinaryPathOverride: !app.isPackaged,
    }),
  };
}

export async function signConfirmedLighterLeverage(
  input: { readonly intent: LighterLeverageIntentRow },
  deps: LighterLeverageSigningDeps = defaultLighterLeverageSigningDeps(),
): Promise<LighterUpdateLeverageSignerResult> {
  const { intent } = input;
  try {
    if (
      intent.executionState !== "signing"
      || intent.consentedAt === null
      || intent.nonceValue === null
      || intent.txExpiryMs === null
    ) {
      throw new Error("The leverage intent is not in a signable state.");
    }
    const reference: LighterTradingCredentialVaultReference = {
      kind: "encrypted_vault_reference",
      environment: intent.environment,
      accountIndex: intent.accountIndex,
      apiKeyIndex: intent.apiKeyIndex,
      vaultCredentialId: defaultLighterTradingVaultCredentialId(intent),
    };
    if (
      deps.readVaultRegistrationState(reference) !== LIGHTER_TRADING_CREDENTIAL_ACTIVE_STATE
    ) {
      throw new Error("The Lighter trading credential is not active.");
    }
    const secret = await deps.loadSecret(
      reference,
      createUnlockedVaultLighterTradingSecretReader(),
    );
    if ((await deps.keyGenerator.derivePublicKey(secret)) !== intent.observedBefore.publicKey) {
      throw new Error("The local trading key differs from the key this change was bound to.");
    }
    return await deps.signer.signUpdateLeverage(
      buildLighterUpdateLeverageSigningInput({
        environment: intent.environment,
        accountIndex: intent.accountIndex,
        apiKeyIndex: intent.apiKeyIndex,
        nonce: intent.nonceValue,
        expiredAt: String(intent.txExpiryMs),
        marketIndex: intent.marketIndex,
        initialMarginFraction: intent.requestedInitialMarginFraction,
        marginMode: intent.requestedMarginMode,
        secret,
      }),
    );
  } catch (error) {
    throw carryLighterSignerChildState(
      error,
      new Error(
        "The confirmed leverage change could not be signed locally. Reconcile its status before trying again.",
      ),
    );
  }
}
