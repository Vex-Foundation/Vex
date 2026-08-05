/**
 * Verifies envStateSchema strictness — most importantly that walletStatus
 * collapses to `present|missing` (no `address` or `decryptedAt`-style
 * fields that would imply post-unlock data leaks).
 */

import { describe, expect, it } from "vitest";
import { envStateSchema, type EnvState } from "../onboarding.js";

const validState: EnvState = {
  hasKeystorePassword: true,
  hasJupiterApiKey: false,
  apiKeys: {
    jupiterConfigured: false,
    tavilyConfigured: false,
    rettiwtConfigured: false,
    relayConfigured: false,
  },
  embeddings: {
    configured: true,
    reachable: true,
    baseUrlRedacted: "http://127.0.0.1:12434",
    allFieldsConfigured: true,
    dbReachable: true,
  },
  walletStatus: {
    evm: "present",
    solana: "missing",
  },
  provider: {
    configured: false,
    name: null,
    modelLabel: null,
    endpointTag: null,
  },
  secrets: {
    vaultConfigured: true,
    unlocked: true,
  },
  setupCompleteFlag: false,
};

describe("envStateSchema", () => {
  it("accepts a fully populated valid state", () => {
    expect(envStateSchema.safeParse(validState).success).toBe(true);
  });

  it("accepts baseUrlRedacted = null when embeddings.configured = false", () => {
    const state: EnvState = {
      ...validState,
      embeddings: {
        configured: false,
        reachable: false,
        baseUrlRedacted: null,
        allFieldsConfigured: false,
        dbReachable: null,
      },
    };
    expect(envStateSchema.safeParse(state).success).toBe(true);
  });

  it("rejects unknown wallet status enum (no `decrypted` etc.)", () => {
    const result = envStateSchema.safeParse({
      ...validState,
      walletStatus: { evm: "decrypted" as never, solana: "missing" },
    });
    expect(result.success).toBe(false);
  });

  it("rejects unknown keys at top level (no leaked address/seed)", () => {
    const result = envStateSchema.safeParse({
      ...validState,
      walletAddress: "0xleaked",
    });
    expect(result.success).toBe(false);
  });

  it("rejects unknown keys in walletStatus (no nested address etc.)", () => {
    const result = envStateSchema.safeParse({
      ...validState,
      walletStatus: { evm: "present", solana: "missing", address: "0xleaked" },
    });
    expect(result.success).toBe(false);
  });

  it("accepts provider block with name=null/configured=false", () => {
    expect(envStateSchema.safeParse(validState).success).toBe(true);
  });

  it("accepts provider name='openrouter' with model label", () => {
    const state: EnvState = {
      ...validState,
      provider: {
        configured: true,
        name: "openrouter",
        modelLabel: "anthropic/claude-sonnet-4.5",
        endpointTag: null,
      },
    };
    expect(envStateSchema.safeParse(state).success).toBe(true);
  });

  it("rejects unknown provider name enum", () => {
    const result = envStateSchema.safeParse({
      ...validState,
      provider: {
        configured: true,
        name: "anthropic-direct" as never,
        modelLabel: null,
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects modelLabel > 200 chars", () => {
    const result = envStateSchema.safeParse({
      ...validState,
      provider: {
        configured: true,
        name: "openrouter",
        modelLabel: "a".repeat(201),
      },
    });
    expect(result.success).toBe(false);
  });
});
