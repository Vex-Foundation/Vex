import { getAddress } from "viem";
import type { EvmWallet } from "@tools/wallet/multi-auth.js";
import {
  buildLighterApproveIntegratorSignatureBody,
  buildLighterApproveIntegratorSigningInput,
  signLighterApproveIntegratorWithAdapter,
} from "@tools/lighter/signer-integrator.js";
import {
  createLighterApiKeyGeneratorBinary,
  createLighterSignerBinaryApproveIntegratorAdapter,
} from "@tools/lighter/signer-binary-adapter.js";
import {
  defaultLighterTradingVaultCredentialId,
  type LighterTradingCredentialVaultReference,
} from "@tools/lighter/trading-credentials.js";
import { materialFromSecret } from "@tools/lighter/trading-secret.js";
import type { LighterFeeAuthorizationIntentRow } from "@vex-agent/db/repos/lighter-fee-authorization-intents.js";
import {
  getUnlockedLighterTradingCredentialRegistrationState,
  LIGHTER_TRADING_CREDENTIAL_ACTIVE_STATE,
  readUnlockedLighterTradingApiPrivateKey,
} from "../secrets/lighter-trading-credential.js";
import { signLighterRegistrationWalletMessage } from "./key-registration-signing.js";

export interface LighterFeeAuthorizationSigningDeps {
  readonly readVaultPrivateKey: typeof readUnlockedLighterTradingApiPrivateKey;
  readonly readVaultRegistrationState: typeof getUnlockedLighterTradingCredentialRegistrationState;
  readonly keyGenerator: ReturnType<typeof createLighterApiKeyGeneratorBinary>;
  readonly signer: ReturnType<
    typeof createLighterSignerBinaryApproveIntegratorAdapter
  >;
  readonly signWalletMessage: typeof signLighterRegistrationWalletMessage;
}

/** Offline privileged signing; the executor reserves the nonce durably first. */
export async function signApprovedLighterFeeAuthorization(
  input: {
    readonly intent: LighterFeeAuthorizationIntentRow;
    readonly wallet: EvmWallet;
  },
  deps: LighterFeeAuthorizationSigningDeps = {
    readVaultPrivateKey: readUnlockedLighterTradingApiPrivateKey,
    readVaultRegistrationState:
      getUnlockedLighterTradingCredentialRegistrationState,
    keyGenerator: createLighterApiKeyGeneratorBinary(),
    signer: createLighterSignerBinaryApproveIntegratorAdapter(),
    signWalletMessage: signLighterRegistrationWalletMessage,
  },
) {
  const { intent, wallet } = input;
  try {
    if (
      intent.approvalStatus !== "approved" ||
      intent.executionState !== "signing" ||
      intent.nonceValue === null ||
      intent.txExpiryMs === null ||
      getAddress(wallet.address) !== getAddress(intent.walletAddress)
    ) {
      throw new Error(
        "The local signing wallet or fee authorization no longer matches the approved intent.",
      );
    }
    const reference: LighterTradingCredentialVaultReference = {
      kind: "encrypted_vault_reference",
      environment: intent.environment,
      accountIndex: intent.accountIndex,
      apiKeyIndex: intent.apiKeyIndex,
      vaultCredentialId: defaultLighterTradingVaultCredentialId(intent),
    };
    if (
      deps.readVaultRegistrationState(reference) !==
      LIGHTER_TRADING_CREDENTIAL_ACTIVE_STATE
    ) {
      throw new Error("The Lighter trading credential is not active.");
    }
    const privateKey = deps.readVaultPrivateKey(reference);
    if (!privateKey)
      throw new Error(
        "Unlock the local trading credential before authorizing fees.",
      );
    const secret = materialFromSecret(privateKey);
    if (
      (await deps.keyGenerator.derivePublicKey(secret)) !==
      intent.terms.publicKey
    ) {
      throw new Error(
        "The local trading key differs from the approved account key.",
      );
    }
    const terms = {
      environment: intent.environment,
      accountIndex: intent.accountIndex,
      apiKeyIndex: intent.apiKeyIndex,
      nonce: intent.nonceValue,
      expiredAt: String(intent.txExpiryMs),
      integratorAccountIndex: intent.terms.collectorAccountIndex,
      maxPerpsMakerFee: intent.terms.maxPerpsMakerFee,
      maxPerpsTakerFee: intent.terms.maxPerpsTakerFee,
      maxSpotMakerFee: intent.terms.maxSpotMakerFee,
      maxSpotTakerFee: intent.terms.maxSpotTakerFee,
      approvalExpiry: intent.terms.authorizationExpiryMs,
    };
    const l1Signature = intent.terms.revoke
      ? ""
      : await deps.signWalletMessage(
          wallet,
          buildLighterApproveIntegratorSignatureBody(terms),
        );
    return await signLighterApproveIntegratorWithAdapter(
      buildLighterApproveIntegratorSigningInput({
        ...terms,
        expectedL1Address: intent.walletAddress,
        l1Signature,
        secret,
      }),
      deps.signer,
    );
  } catch {
    // Never return helper stderr, a private key, or a wallet signature upstream.
    throw new Error(
      "The approved fee authorization could not be signed locally. Reconcile its status before retrying.",
    );
  }
}
