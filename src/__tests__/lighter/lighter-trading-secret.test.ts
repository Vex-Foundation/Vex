import { describe, expect, it, vi } from "vitest";

import {
  loadLighterTradingSecretMaterial,
  materialFromSecret,
  type LighterTradingSecretReader,
} from "@tools/lighter/trading-secret.js";
import type { LighterTradingCredentialVaultReference } from "@tools/lighter/trading-credentials.js";

const REFERENCE: LighterTradingCredentialVaultReference = {
  kind: "encrypted_vault_reference",
  environment: "rhc",
  accountIndex: 42,
  apiKeyIndex: 7,
  vaultCredentialId: "lighter/rhc/account-42/api-key-7",
};
const PRIVATE_KEY = `0x${"1".repeat(80)}`;

describe("Lighter trading secret boundary", () => {
  it("loads private-key material only through an injected privileged reader", async () => {
    const reader: LighterTradingSecretReader = {
      readTradingApiPrivateKey: vi.fn(async () => PRIVATE_KEY),
    };

    const material = await loadLighterTradingSecretMaterial(REFERENCE, reader);

    expect(reader.readTradingApiPrivateKey).toHaveBeenCalledWith(REFERENCE);
    expect(material.kind).toBe("lighter_api_private_key_secret");
    expect(material.privateKey).toBe(PRIVATE_KEY);
  });

  it("redacts private-key material from ordinary object serialization", () => {
    const material = materialFromSecret(PRIVATE_KEY);

    expect(material.privateKey).toBe(PRIVATE_KEY);
    expect(Object.keys(material)).toEqual(["kind"]);
    expect(JSON.stringify(material)).toBe(
      "{\"kind\":\"lighter_api_private_key_secret\",\"privateKey\":\"[redacted]\"}",
    );
  });

  it("fails closed without echoing secret material when the reader cannot read", async () => {
    const reader: LighterTradingSecretReader = {
      readTradingApiPrivateKey: vi.fn(async () => {
        throw new Error(`raw secret ${PRIVATE_KEY}`);
      }),
    };

    await expect(loadLighterTradingSecretMaterial(REFERENCE, reader))
      .rejects.toThrow("privileged vault boundary");
    await expect(loadLighterTradingSecretMaterial(REFERENCE, reader))
      .rejects.not.toThrow(PRIVATE_KEY);
  });

  it("rejects missing, incomplete, or read-only token material", async () => {
    await expect(loadLighterTradingSecretMaterial(REFERENCE, {
      readTradingApiPrivateKey: async () => null,
    })).rejects.toThrow("not present");
    expect(() => materialFromSecret("short")).toThrow("not usable");
    expect(() => materialFromSecret(`0x${"1".repeat(64)}`)).toThrow("not usable");
    expect(() => materialFromSecret("ro:42:single:4102444800:abcdef0123456789"))
      .toThrow("Read-only Lighter tokens cannot sign");
  });
});
