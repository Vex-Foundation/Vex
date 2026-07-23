import { describe, it, expect } from "vitest";
import { randomBytes, scryptSync, createCipheriv } from "node:crypto";
import { encryptPrivateKey, decryptPrivateKey, type KeystoreV1 } from "@tools/wallet/keystore.js";

describe("keystore", () => {
  const testPrivateKey = "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  const testPassword = "testpassword123";

  describe("encryptPrivateKey", () => {
    it("should encrypt a private key with 0x prefix", () => {
      const keystore = encryptPrivateKey(testPrivateKey, testPassword);

      expect(keystore.version).toBe(1);
      expect(keystore.ciphertext).toBeTruthy();
      expect(keystore.iv).toBeTruthy();
      expect(keystore.salt).toBeTruthy();
      expect(keystore.tag).toBeTruthy();
      expect(keystore.kdf.name).toBe("scrypt");
    });

    it("uses scrypt N=131072 (2^17 OWASP, vault parity, FINDING F10)", () => {
      // Pins the KDF cost. The roundtrip tests below exercise this N end-to-end —
      // without the 256 MiB maxmem in deriveKey, scryptSync at N=131072 (~128 MiB)
      // would throw "memory limit exceeded" and these tests would fail. That is the
      // regression guard against re-introducing the wallet-bricking gap.
      const keystore = encryptPrivateKey(testPrivateKey, testPassword);
      expect(keystore.kdf.N).toBe(131072);
      expect(keystore.kdf.r).toBe(8);
      expect(keystore.kdf.p).toBe(1);
    });

    it("should encrypt a private key without 0x prefix", () => {
      const pkWithoutPrefix = testPrivateKey.slice(2);
      const keystore = encryptPrivateKey(pkWithoutPrefix, testPassword);

      expect(keystore.version).toBe(1);
      expect(keystore.ciphertext).toBeTruthy();
    });

    it("should throw on invalid private key format", () => {
      expect(() => encryptPrivateKey("not-a-valid-key", testPassword)).toThrow(
        "Invalid private key"
      );
    });

    it("should throw on too short private key", () => {
      expect(() => encryptPrivateKey("0x1234", testPassword)).toThrow("Invalid private key");
    });

    it("should throw on too long private key", () => {
      const longKey = "0x" + "a".repeat(128);
      expect(() => encryptPrivateKey(longKey, testPassword)).toThrow("Invalid private key");
    });
  });

  describe("decryptPrivateKey", () => {
    it("should decrypt an encrypted private key correctly", () => {
      const keystore = encryptPrivateKey(testPrivateKey, testPassword);
      const decrypted = decryptPrivateKey(keystore, testPassword);

      expect(decrypted).toBe(testPrivateKey.toLowerCase());
    });

    it("should fail with wrong password", () => {
      const keystore = encryptPrivateKey(testPrivateKey, testPassword);

      expect(() => decryptPrivateKey(keystore, "wrongpassword")).toThrow(
        "Decryption failed"
      );
    });

    it("decrypts a legacy N=16384 keystore (per-file KDF params, FINDING F10)", () => {
      // Forge a keystore at the OLD cost (N=16384) using the same scheme the
      // production code used before the bump, WITHOUT touching production exports.
      // decryptSecretBytes derives from the file's own kdf block, so a file written
      // at any supported N must still open — and the 256 MiB maxmem ceiling covers
      // both old and new N. (na czysto: dev keystores are wiped, but the per-file
      // param path must stay correct so a future N change is non-breaking.)
      const forgeLegacyKeystore = (pk: string, password: string): KeystoreV1 => {
        const keyBytes = Buffer.from(pk.slice(2), "hex");
        const salt = randomBytes(32);
        const iv = randomBytes(12);
        const kdf = { name: "scrypt" as const, N: 16384, r: 8, p: 1, dkLen: 32 };
        const derived = scryptSync(password, salt, kdf.dkLen, {
          N: kdf.N,
          r: kdf.r,
          p: kdf.p,
          maxmem: 256 * 1024 * 1024,
        });
        const cipher = createCipheriv("aes-256-gcm", derived, iv);
        const ciphertext = Buffer.concat([cipher.update(keyBytes), cipher.final()]);
        const tag = cipher.getAuthTag();
        return {
          version: 1,
          ciphertext: ciphertext.toString("base64"),
          iv: iv.toString("base64"),
          salt: salt.toString("base64"),
          tag: tag.toString("base64"),
          kdf,
        };
      };

      const legacy = forgeLegacyKeystore(testPrivateKey, testPassword);
      expect(legacy.kdf.N).toBe(16384);
      expect(decryptPrivateKey(legacy, testPassword)).toBe(testPrivateKey.toLowerCase());
    });

    it("should handle uppercase hex in private key", () => {
      const uppercasePk = "0x0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF";
      const keystore = encryptPrivateKey(uppercasePk, testPassword);
      const decrypted = decryptPrivateKey(keystore, testPassword);

      expect(decrypted).toBe(uppercasePk.toLowerCase());
    });

    it("should throw on unsupported keystore version", () => {
      const keystore = encryptPrivateKey(testPrivateKey, testPassword);
      const invalidKeystore = { ...keystore, version: 99 } as unknown as KeystoreV1;

      expect(() => decryptPrivateKey(invalidKeystore, testPassword)).toThrow(
        "Unsupported keystore version"
      );
    });
  });

  describe("roundtrip", () => {
    it("should survive multiple encrypt/decrypt cycles", () => {
      let currentPk = testPrivateKey;

      for (let i = 0; i < 3; i++) {
        const keystore = encryptPrivateKey(currentPk, testPassword);
        const decrypted = decryptPrivateKey(keystore, testPassword);
        expect(decrypted).toBe(testPrivateKey.toLowerCase());
        currentPk = decrypted;
      }
    });

    it("should produce different ciphertexts for same input (random salt/iv)", () => {
      const keystore1 = encryptPrivateKey(testPrivateKey, testPassword);
      const keystore2 = encryptPrivateKey(testPrivateKey, testPassword);

      expect(keystore1.ciphertext).not.toBe(keystore2.ciphertext);
      expect(keystore1.salt).not.toBe(keystore2.salt);
      expect(keystore1.iv).not.toBe(keystore2.iv);
    });
  });
});
