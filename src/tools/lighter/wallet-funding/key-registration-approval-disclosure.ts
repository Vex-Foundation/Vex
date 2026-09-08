import { createHash } from "node:crypto";

import type { LighterKeyRegistrationReservationRow } from "@vex-agent/db/repos/lighter-key-registration-intents.js";
import { ErrorCodes, VexError } from "../../../errors.js";
import { LIGHTER_SIGNER_CHAIN_IDS } from "../signer-adapter.js";
import { defaultLighterTradingVaultCredentialId } from "../trading-credentials.js";
import { getLighterFundingDeployment } from "./deployments.js";

export interface LighterKeyRegistrationApprovalDisclosure {
  readonly environmentLabel: string;
  readonly walletAddress: string;
  readonly ethereumChainId: number;
  readonly lighterChainId: number;
  readonly accountIndex: number;
  readonly apiKeyIndex: number;
  readonly registrationNonce: string;
  readonly publicKey: string;
  readonly publicKeyFingerprint: string;
  readonly publicKeyFingerprintDisplay: string;
  readonly vaultCredentialId: string;
  readonly authorityNote: string;
  readonly signatureNote: string;
  readonly scopeNote: string;
  readonly summary: string;
}

export function buildLighterKeyRegistrationApprovalDisclosure(
  intent: LighterKeyRegistrationReservationRow,
): LighterKeyRegistrationApprovalDisclosure {
  const deployment = getLighterFundingDeployment(intent.environment);
  if (intent.chainId !== deployment.settlementChainId) {
    throw unavailable("The key-registration settlement chain does not match its environment.");
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(intent.walletAddress)) {
    throw unavailable("The key-registration wallet address is invalid.");
  }
  if (intent.executionState === "slot_reserved") {
    throw unavailable("The key-registration intent is not ready for approval preparation.");
  }
  if (
    !Number.isSafeInteger(intent.accountIndex)
    || intent.accountIndex <= 0
    || !Number.isInteger(intent.apiKeyIndex)
    || intent.apiKeyIndex < 4
    || intent.apiKeyIndex > 254
  ) {
    throw unavailable("The key-registration account or API-key index is invalid.");
  }
  const publicKey = normalizePublicKey(intent.publicKey);
  const expectedFingerprint = createHash("sha256")
    .update(Buffer.from(publicKey, "hex"))
    .digest("hex");
  if (intent.publicKeyFingerprint !== expectedFingerprint) {
    throw unavailable("The key-registration public-key fingerprint is inconsistent.");
  }
  const expectedVaultCredentialId = defaultLighterTradingVaultCredentialId({
    environment: intent.environment,
    accountIndex: intent.accountIndex,
    apiKeyIndex: intent.apiKeyIndex,
  });
  if (intent.vaultCredentialId !== expectedVaultCredentialId) {
    throw unavailable("The encrypted credential reference does not match the approved scope.");
  }
  const registrationNonce = normalizeNonce(intent.registrationNonce);
  if (!(intent.registrationNonceObservedAt instanceof Date)) {
    throw unavailable("The public registration nonce observation is missing.");
  }
  if (!Number.isFinite(intent.registrationNonceObservedAt.getTime())) {
    throw unavailable("The public registration nonce observation time is invalid.");
  }

  const publicKeyFingerprintDisplay = expectedFingerprint.match(/.{1,8}/g)?.join(":")
    ?? expectedFingerprint;
  const authorityNote =
    "This registers one locally encrypted API credential on the selected Lighter account. "
    + "Lighter API credentials can authenticate account actions, including trading; Vex keeps "
    + "withdrawal and every trade behind separate approval paths.";
  const signatureNote =
    "Your Vex wallet will sign Lighter's human-readable Register Lighter Account message locally. "
    + "This is an off-chain EIP-191 signature and does not send a settlement-chain transaction or charge gas.";
  const scopeNote =
    "This approval authorizes only registering this exact public key at this exact account, API-key "
    + "index, and nonce. It does not authorize a deposit, order, transfer, or withdrawal.";

  return {
    environmentLabel: intent.environment === "core" ? "Lighter Core" : "Lighter on Robinhood Chain",
    walletAddress: intent.walletAddress,
    // Retain the established approval-contract field name for compatibility;
    // on RHC this contains settlement chain 4663, not the Lighter signer domain.
    ethereumChainId: deployment.settlementChainId,
    lighterChainId: LIGHTER_SIGNER_CHAIN_IDS[intent.environment],
    accountIndex: intent.accountIndex,
    apiKeyIndex: intent.apiKeyIndex,
    registrationNonce,
    publicKey,
    publicKeyFingerprint: expectedFingerprint,
    publicKeyFingerprintDisplay,
    vaultCredentialId: expectedVaultCredentialId,
    authorityNote,
    signatureNote,
    scopeNote,
    summary:
      `Register encrypted Vex trading key ${publicKeyFingerprintDisplay} at ${
        intent.environment === "core" ? "Lighter Core" : "Lighter RHC"
      } `
      + `account ${intent.accountIndex}, API-key index ${intent.apiKeyIndex}.`,
  };
}

function normalizePublicKey(value: string | null): string {
  const publicKey = value?.trim().toLowerCase().replace(/^0x/, "") ?? "";
  if (!/^[0-9a-f]{80}$/.test(publicKey)) {
    throw unavailable("The key-registration public key is missing or malformed.");
  }
  return publicKey;
}

function normalizeNonce(value: string | null): string {
  if (value === null || !/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw unavailable("The key-registration nonce is missing or malformed.");
  }
  const nonce = BigInt(value);
  if (nonce > (1n << 48n) - 1n) {
    throw unavailable("The key-registration nonce exceeds the official signer range.");
  }
  return nonce.toString();
}

function unavailable(message: string): VexError {
  return new VexError(
    ErrorCodes.LIGHTER_INVALID_REQUEST,
    message,
    "Prepare Lighter key registration again from a fresh account and API-key-slot read.",
  );
}
