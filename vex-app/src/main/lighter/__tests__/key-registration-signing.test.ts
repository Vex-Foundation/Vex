import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";
import { privateKeyToAccount } from "viem/accounts";

import type {
  LighterChangePubKeySignerAdapter,
  LighterChangePubKeySigningInput,
} from "@tools/lighter/change-pub-key.js";
import { materialFromSecret } from "@tools/lighter/trading-secret.js";
import type { EvmWallet } from "@tools/wallet/multi-auth.js";
import type { LighterKeyRegistrationReservationRow } from "@vex-agent/db/repos/lighter-key-registration-intents.js";
import {
  signApprovedLighterKeyRegistration,
  signLighterRegistrationWalletMessage,
  type SignApprovedLighterKeyRegistrationDeps,
} from "../key-registration-signing.js";

const NOW = new Date("2030-01-01T00:00:00.000Z");
const LIGHTER_PRIVATE_KEY = `0x${"1".repeat(80)}`;
const LIGHTER_PUBLIC_KEY = "ab".repeat(40);
const EVM_PRIVATE_KEY = `0x${"2".repeat(64)}` as const;
const EVM_ACCOUNT = privateKeyToAccount(EVM_PRIVATE_KEY);

function approvedIntent(): LighterKeyRegistrationReservationRow {
  return {
    intentId: "lighter-onboard-1",
    sessionId: "session-1",
    environment: "core",
    walletAddress: EVM_ACCOUNT.address,
    chainId: 1,
    accountIndex: 42,
    apiKeyIndex: 6,
    slotObservedAt: NOW,
    slotObservationHash: "a".repeat(64),
    approvalStatus: "approved",
    executionState: "approved",
    vaultCredentialId: "lighter/core/account-42/api-key-6",
    publicKey: LIGHTER_PUBLIC_KEY,
    publicKeyFingerprint: createHash("sha256")
      .update(Buffer.from(LIGHTER_PUBLIC_KEY, "hex"))
      .digest("hex"),
    keyGeneratedAt: NOW,
    registrationNonce: "0",
    registrationNonceObservedAt: NOW,
    registrationTxType: null,
    registrationTxHash: null,
    registrationTxExpiredAt: null,
    registrationTxStagedAt: null,
    registrationSubmittedTxHash: null,
    registrationSubmitCode: null,
    registrationPredictedExecutionTimeMs: null,
    registrationSubmitAcceptedAt: null,
    registrationAmbiguityReason: null,
    registrationKeyVerifiedAt: null,
    registrationClientCheckedAt: null,
    postRegistrationNonce: null,
    registrationNonceSynchronizedAt: null,
    registrationActivatedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    expiresAt: new Date("2030-01-01T01:00:00.000Z"),
  };
}

function wallet(): EvmWallet {
  return {
    family: "eip155",
    address: EVM_ACCOUNT.address,
    privateKey: EVM_PRIVATE_KEY,
  };
}

function signerResult(input: LighterChangePubKeySigningInput) {
  return {
    kind: "lighter_change_pub_key_signer_result" as const,
    environment: "core" as const,
    accountIndex: input.accountIndex,
    apiKeyIndex: input.apiKeyIndex,
    nonce: input.nonce,
    expiredAt: input.expiredAt,
    publicKey: input.publicKey,
    expectedL1Address: input.expectedL1Address,
    messageToSign: input.messageToSign,
    txType: 8 as const,
    txInfo: JSON.stringify({
      AccountIndex: input.accountIndex,
      ApiKeyIndex: input.apiKeyIndex,
      PubKey: Buffer.from(input.publicKey, "hex").toString("base64"),
      L1Sig: input.l1Signature,
      ExpiredAt: Number(input.expiredAt),
      Nonce: Number(input.nonce),
      Sig: Buffer.alloc(80, 1).toString("base64"),
      L2TxAttributes: null,
    }),
    txHash: "cd".repeat(40),
  };
}

function deps(overrides: Partial<SignApprovedLighterKeyRegistrationDeps> = {}) {
  const signer: LighterChangePubKeySignerAdapter = {
    source: "official_lighter_signer",
    signChangePubKey: vi.fn(async (input) => signerResult(input)),
  };
  return {
    readVaultPrivateKey: vi.fn().mockReturnValue(LIGHTER_PRIVATE_KEY),
    readVaultRegistrationState: vi.fn().mockReturnValue(
      "key_generated_pending_registration",
    ),
    keyGenerator: {
      source: "official_lighter_signer" as const,
      generate: vi.fn().mockResolvedValue({
        secret: materialFromSecret(LIGHTER_PRIVATE_KEY),
        publicKey: LIGHTER_PUBLIC_KEY,
      }),
      derivePublicKey: vi.fn().mockResolvedValue(LIGHTER_PUBLIC_KEY),
    },
    signer,
    signWalletMessage: signLighterRegistrationWalletMessage,
    now: () => NOW,
    ...overrides,
  } satisfies SignApprovedLighterKeyRegistrationDeps;
}

describe("Lighter Phase 3 privileged registration signing", () => {
  it("wallet-signs the exact approved message and returns only a verified TxType 8 payload", async () => {
    const testDeps = deps();
    const result = await signApprovedLighterKeyRegistration({
      sessionId: "session-1",
      intent: approvedIntent(),
      wallet: wallet(),
      revalidatedNonce: "0",
    }, testDeps);

    expect(result).toMatchObject({
      txType: 8,
      accountIndex: 42,
      apiKeyIndex: 6,
      nonce: "0",
      expiredAt: String(NOW.getTime() + 9 * 60 * 1_000),
      expectedL1Address: EVM_ACCOUNT.address,
      txHash: "cd".repeat(40),
    });
    expect(result.messageToSign).toContain("Register Lighter Account");
    expect(result.messageToSign).toContain("account index: 0x000000000000002a");
    expect(testDeps.keyGenerator.derivePublicKey).toHaveBeenCalledOnce();
    expect(testDeps.signer.signChangePubKey).toHaveBeenCalledOnce();
    expect(JSON.stringify(result)).not.toContain(LIGHTER_PRIVATE_KEY);
    expect(JSON.stringify(result)).not.toContain(EVM_PRIVATE_KEY);
    expect(JSON.stringify(result)).not.toContain("L1Sig");
    expect(result.txInfo).toContain("L1Sig");
  });

  it("refuses nonce drift before reading either secret", async () => {
    const testDeps = deps();
    await expect(signApprovedLighterKeyRegistration({
      sessionId: "session-1",
      intent: approvedIntent(),
      wallet: wallet(),
      revalidatedNonce: "1",
    }, testDeps)).rejects.toThrow("slot nonce changed");

    expect(testDeps.readVaultPrivateKey).not.toHaveBeenCalled();
    expect(testDeps.signer.signChangePubKey).not.toHaveBeenCalled();
  });

  it("refuses encrypted-key drift before wallet signing", async () => {
    const signWalletMessage = vi.fn<SignApprovedLighterKeyRegistrationDeps["signWalletMessage"]>();
    const testDeps = deps({
      keyGenerator: {
        source: "official_lighter_signer",
        generate: vi.fn(),
        derivePublicKey: vi.fn().mockResolvedValue("cd".repeat(40)),
      },
      signWalletMessage,
    });
    await expect(signApprovedLighterKeyRegistration({
      sessionId: "session-1",
      intent: approvedIntent(),
      wallet: wallet(),
      revalidatedNonce: "0",
    }, testDeps)).rejects.toThrow("does not match the approved public key");

    expect(signWalletMessage).not.toHaveBeenCalled();
    expect(testDeps.signer.signChangePubKey).not.toHaveBeenCalled();
  });

  it("refuses a different wallet before opening the Lighter credential vault", async () => {
    const testDeps = deps();
    const otherPrivateKey = `0x${"3".repeat(64)}` as const;
    const otherAccount = privateKeyToAccount(otherPrivateKey);
    await expect(signApprovedLighterKeyRegistration({
      sessionId: "session-1",
      intent: approvedIntent(),
      wallet: {
        family: "eip155",
        address: otherAccount.address,
        privateKey: otherPrivateKey,
      },
      revalidatedNonce: "0",
    }, testDeps)).rejects.toThrow("does not match the approved wallet");

    expect(testDeps.readVaultPrivateKey).not.toHaveBeenCalled();
    expect(testDeps.signer.signChangePubKey).not.toHaveBeenCalled();
  });
});
