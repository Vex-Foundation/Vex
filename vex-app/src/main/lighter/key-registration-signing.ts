import { createHash } from "node:crypto";
import { getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import {
  buildLighterChangePubKeySignatureBody,
  buildLighterChangePubKeySigningInput,
  signLighterChangePubKeyWithAdapter,
  type LighterChangePubKeySignerAdapter,
  type LighterChangePubKeySignerResult,
} from "@tools/lighter/change-pub-key.js";
import {
  createLighterApiKeyGeneratorBinary,
  createLighterChangePubKeySignerBinary,
  type LighterApiKeyGenerator,
} from "@tools/lighter/signer-binary-adapter.js";
import {
  assertLighterTradingApiKeyIndexAllowed,
  defaultLighterTradingVaultCredentialId,
  type LighterTradingCredentialVaultReference,
} from "@tools/lighter/trading-credentials.js";
import { materialFromSecret } from "@tools/lighter/trading-secret.js";
import type { EvmWallet } from "@tools/wallet/multi-auth.js";
import type { LighterKeyRegistrationReservationRow } from "@vex-agent/db/repos/lighter-key-registration-intents.js";
import { ErrorCodes, VexError } from "../../../../src/errors.js";
import {
  getUnlockedLighterTradingCredentialRegistrationState,
  LIGHTER_TRADING_CREDENTIAL_PENDING_REGISTRATION_STATE,
  readUnlockedLighterTradingApiPrivateKey,
} from "../secrets/lighter-trading-credential.js";

const SIGNED_TX_TTL_MS = 9 * 60 * 1_000;

export interface SignApprovedLighterKeyRegistrationDeps {
  readonly readVaultPrivateKey: (
    reference: LighterTradingCredentialVaultReference,
  ) => string | null;
  readonly readVaultRegistrationState: (
    reference: LighterTradingCredentialVaultReference,
  ) => string | null;
  readonly keyGenerator: LighterApiKeyGenerator;
  readonly signer: LighterChangePubKeySignerAdapter;
  readonly signWalletMessage: (wallet: EvmWallet, message: string) => Promise<string>;
  readonly now: () => Date;
}

/**
 * Privileged, offline signing seam. The caller must complete live pre-sign
 * revalidation first and persist the returned structural identity before it
 * may submit txInfo. Nothing in this function performs network I/O.
 */
export async function signApprovedLighterKeyRegistration(input: {
  readonly sessionId: string;
  readonly intent: LighterKeyRegistrationReservationRow;
  readonly wallet: EvmWallet;
  readonly revalidatedNonce: string;
}, deps: SignApprovedLighterKeyRegistrationDeps = defaultDeps()): Promise<
  LighterChangePubKeySignerResult
> {
  const { intent } = input;
  assertLighterTradingApiKeyIndexAllowed(intent.environment, intent.apiKeyIndex);
  if (
    intent.sessionId !== input.sessionId
    || intent.executionState !== "approved"
    || intent.registrationNonce === null
    || intent.publicKey === null
    || intent.publicKeyFingerprint === null
    || intent.vaultCredentialId === null
  ) {
    throw signingError("the approved key-registration intent is incomplete");
  }
  if (input.revalidatedNonce !== intent.registrationNonce) {
    throw signingError("the live slot nonce changed after approval");
  }
  if (getAddress(input.wallet.address) !== getAddress(intent.walletAddress)) {
    throw signingError("the unlocked signing wallet does not match the approved wallet");
  }
  const reference = credentialReference(intent);
  if (intent.vaultCredentialId !== reference.vaultCredentialId) {
    throw signingError("the encrypted credential reference changed after approval");
  }
  let privateKey: string | null;
  let registrationState: string | null;
  try {
    privateKey = deps.readVaultPrivateKey(reference);
    registrationState = deps.readVaultRegistrationState(reference);
  } catch {
    throw signingError("the encrypted credential could not be read");
  }
  if (
    privateKey === null
    || registrationState !== LIGHTER_TRADING_CREDENTIAL_PENDING_REGISTRATION_STATE
  ) {
    throw signingError("the encrypted credential is not pending registration");
  }
  const secret = materialFromSecret(privateKey);
  let publicKey: string;
  try {
    publicKey = await deps.keyGenerator.derivePublicKey(secret);
  } catch {
    throw signingError("the encrypted credential public key could not be re-derived");
  }
  const fingerprint = createHash("sha256")
    .update(Buffer.from(publicKey, "hex"))
    .digest("hex");
  if (publicKey !== intent.publicKey || fingerprint !== intent.publicKeyFingerprint) {
    throw signingError("the encrypted credential does not match the approved public key");
  }

  const expiredAt = String(deps.now().getTime() + SIGNED_TX_TTL_MS);
  const messageToSign = buildLighterChangePubKeySignatureBody({
    publicKey,
    nonce: intent.registrationNonce,
    accountIndex: intent.accountIndex,
    apiKeyIndex: intent.apiKeyIndex,
  });
  let l1Signature: string;
  try {
    l1Signature = await deps.signWalletMessage(input.wallet, messageToSign);
  } catch {
    throw signingError("the approved wallet could not sign the registration message");
  }
  const signingInput = buildLighterChangePubKeySigningInput({
    environment: intent.environment,
    accountIndex: intent.accountIndex,
    apiKeyIndex: intent.apiKeyIndex,
    nonce: intent.registrationNonce,
    expiredAt,
    publicKey,
    expectedL1Address: intent.walletAddress,
    l1Signature,
    secret,
  });
  if (signingInput.messageToSign !== messageToSign) {
    throw signingError("the registration message changed during signing");
  }
  return signLighterChangePubKeyWithAdapter(signingInput, deps.signer);
}

export async function signLighterRegistrationWalletMessage(
  wallet: EvmWallet,
  message: string,
): Promise<string> {
  const account = privateKeyToAccount(wallet.privateKey);
  if (account.address !== getAddress(wallet.address)) {
    throw signingError("the decrypted wallet key does not match the approved wallet");
  }
  return account.signMessage({ message });
}

function defaultDeps(): SignApprovedLighterKeyRegistrationDeps {
  return {
    readVaultPrivateKey: readUnlockedLighterTradingApiPrivateKey,
    readVaultRegistrationState: getUnlockedLighterTradingCredentialRegistrationState,
    keyGenerator: createLighterApiKeyGeneratorBinary(),
    signer: createLighterChangePubKeySignerBinary(),
    signWalletMessage: signLighterRegistrationWalletMessage,
    now: () => new Date(),
  };
}

function credentialReference(
  intent: LighterKeyRegistrationReservationRow,
): LighterTradingCredentialVaultReference {
  const scope = {
    environment: intent.environment,
    accountIndex: intent.accountIndex,
    apiKeyIndex: intent.apiKeyIndex,
  };
  return {
    kind: "encrypted_vault_reference",
    ...scope,
    vaultCredentialId: defaultLighterTradingVaultCredentialId(scope),
  };
}

function signingError(reason: string): VexError {
  return new VexError(
    ErrorCodes.LIGHTER_INVALID_REQUEST,
    `Lighter key registration signing refused: ${reason}.`,
    "Nothing was submitted. Reconcile the account, slot, encrypted key, wallet, and approval before retrying.",
  );
}
