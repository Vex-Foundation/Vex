import { describe, expect, it } from "vitest";
import { ErrorCodes } from "../../errors.js";
import {
  evaluateLighterTradingCredentialReadiness,
  LIGHTER_SIGNER_SECRET_POLICY,
  requireLighterTradingCredentialReadiness,
} from "@tools/lighter/trading-credentials.js";

describe("Lighter trading credential boundary", () => {
  it("accepts only an opaque encrypted-vault reference for a trading API key", () => {
    const readiness = evaluateLighterTradingCredentialReadiness({
      environment: "core",
      accountIndex: 42,
      apiKeyIndex: 2,
      vaultCredentialId: "lighter/core/account-42/api-key-2",
    });

    expect(readiness).toEqual({
      ready: true,
      capability: "lighter_transaction_signing",
      reference: {
        kind: "encrypted_vault_reference",
        environment: "core",
        accountIndex: 42,
        apiKeyIndex: 2,
        vaultCredentialId: "lighter/core/account-42/api-key-2",
      },
      nonceScope: {
        environment: "core",
        accountIndex: 42,
        apiKeyIndex: 2,
      },
    });
  });

  it("blocks reserved API-key indexes before signer initialization", () => {
    for (const apiKeyIndex of [0, 1, 255, -1, 1.5]) {
      expect(evaluateLighterTradingCredentialReadiness({
        environment: "rhc",
        accountIndex: 7,
        apiKeyIndex,
        vaultCredentialId: "lighter/rhc/account-7/api-key-2",
      })).toEqual({
        ready: false,
        capability: "lighter_transaction_signing",
        code: "invalid_api_key_index",
        reason: "apiKeyIndex must be a trading API key index from 2 to 254.",
      });
    }
  });

  it("blocks raw secret-shaped values masquerading as vault references", () => {
    for (const vaultCredentialId of [
      "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      "ro:42:all:4102444800:abcdef0123456789",
      "lighter core secret",
    ]) {
      const readiness = evaluateLighterTradingCredentialReadiness({
        environment: "core",
        accountIndex: 42,
        apiKeyIndex: 2,
        vaultCredentialId,
      });

      expect(readiness.ready).toBe(false);
      if (!readiness.ready) {
        expect(readiness.code).toBe("unsafe_vault_reference");
        expect(JSON.stringify(readiness)).not.toContain("0123456789abcdef0123456789abcdef");
        expect(JSON.stringify(readiness)).not.toContain("abcdef0123456789");
      }
    }
  });

  it("throws a typed refusal without exposing credential material", () => {
    expect(() => requireLighterTradingCredentialReadiness({
      environment: "core",
      accountIndex: 42,
      apiKeyIndex: 2,
      vaultCredentialId: "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    })).toThrow(expect.objectContaining({
      code: ErrorCodes.LIGHTER_INVALID_REQUEST,
      message: "Lighter trading credential is not ready: vaultCredentialId must be an opaque local vault reference, not raw credential material.",
    }));
  });

  it("documents the non-negotiable secret handling policy in code", () => {
    expect(LIGHTER_SIGNER_SECRET_POLICY).toEqual({
      secretSource: "encrypted_vault_only",
      credentialMaterial: "lighter_api_private_key",
      forbiddenSinks: [
        "renderer",
        "preload",
        "agent_transcript",
        "logs",
        "telemetry",
        "cli_arguments",
        "provider_error_text",
      ],
      allowedApiKeyIndexes: {
        min: 2,
        max: 254,
      },
      reservedApiKeyIndexes: [0, 1, 255],
    });
  });
});
