import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { normalizePrivateKey, encryptPrivateKey } from "@tools/wallet/keystore.js";

const TEST_PK = "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const TEST_PK_NO_PREFIX = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const TEST_PASSWORD = "testpassword12345678";

describe("normalizePrivateKey", () => {
  it("should accept valid 0x-prefixed key", () => {
    const result = normalizePrivateKey(TEST_PK);
    expect(result).toBe(TEST_PK.toLowerCase());
  });

  it("should accept valid key without 0x prefix", () => {
    const result = normalizePrivateKey(TEST_PK_NO_PREFIX);
    expect(result).toBe(TEST_PK.toLowerCase());
  });

  it("should lowercase uppercase hex", () => {
    const upper = "0x0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF";
    const result = normalizePrivateKey(upper);
    expect(result).toBe(upper.toLowerCase());
  });

  it("should throw on invalid hex characters", () => {
    expect(() => normalizePrivateKey("0xGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGG")).toThrow(
      "Invalid private key"
    );
  });

  it("should throw on too short key", () => {
    expect(() => normalizePrivateKey("0x1234")).toThrow("Invalid private key");
  });

  it("should throw on too long key", () => {
    const longKey = "0x" + "a".repeat(128);
    expect(() => normalizePrivateKey(longKey)).toThrow("Invalid private key");
  });

  it("should throw on empty string", () => {
    expect(() => normalizePrivateKey("")).toThrow("Invalid private key");
  });

  it("should throw on random text", () => {
    expect(() => normalizePrivateKey("not a key at all")).toThrow("Invalid private key");
  });
});

describe("wallet import flow (unit)", () => {
  it("should encrypt a normalized key and produce valid keystore", () => {
    const normalized = normalizePrivateKey(TEST_PK);
    const keystore = encryptPrivateKey(normalized, TEST_PASSWORD);

    expect(keystore.version).toBe(1);
    expect(keystore.ciphertext).toBeTruthy();
    expect(keystore.salt).toBeTruthy();
    expect(keystore.iv).toBeTruthy();
    expect(keystore.tag).toBeTruthy();
  });

  it("should produce different ciphertexts for same key (random salt)", () => {
    const normalized = normalizePrivateKey(TEST_PK);
    const k1 = encryptPrivateKey(normalized, TEST_PASSWORD);
    const k2 = encryptPrivateKey(normalized, TEST_PASSWORD);

    expect(k1.ciphertext).not.toBe(k2.ciphertext);
    expect(k1.salt).not.toBe(k2.salt);
  });
});
