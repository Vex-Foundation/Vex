import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Passthrough mock of node:crypto with a ONE-SHOT forced scryptSync failure —
// simulates an allocation/crypto-runtime error during key derivation so the
// classifier's "setup failure with a CORRECT password is `unavailable`
// (retryable), never invalid_password and never corrupt" contract is
// testable. Every other call passes through.
const forcedScryptFailure = { armed: false };
vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return {
    ...actual,
    scryptSync: (...args: Parameters<typeof actual.scryptSync>) => {
      if (forcedScryptFailure.armed) {
        forcedScryptFailure.armed = false;
        throw new Error("forced scrypt allocation failure (test)");
      }
      return actual.scryptSync(...args);
    },
  };
});
import {
  createCipheriv,
  randomBytes,
  scryptSync,
} from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  applySecretVaultToProcessEnv,
  createSecretVault,
  CURRENT_KDF_PARAMS,
  LocalSecretVaultError,
  secretVaultExists,
  stripManagedSecretsFromDotenvFile,
  unlockSecretVault,
  verifySecretVaultPassword,
  writeSecretVaultExtraSecrets,
  writeSecretVaultSecrets,
} from "../../lib/local-secret-vault.js";
import {
  MANAGED_SECRET_ENV_KEYS,
  RETIRED_SECRET_ENV_KEYS,
  VAULT_SECRET_KEYS,
} from "../../lib/secret-keys.js";

let testDir = "";
let vaultFile = "";
let envFile = "";
const EXTRA_SECRET_KEY = "lighter/rhc/account-42/api-key-7";
const EXTRA_SECRET_VALUE = `0x${"1".repeat(80)}`;

beforeEach(() => {
  testDir = join(tmpdir(), `vex-secret-vault-${Date.now()}-${Math.random()}`);
  mkdirSync(testDir, { recursive: true });
  vaultFile = join(testDir, "secrets.vault.json");
  envFile = join(testDir, ".env");
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.JUPITER_API_KEY;
  delete process.env[EXTRA_SECRET_KEY];
});

afterEach(() => {
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.JUPITER_API_KEY;
  delete process.env[EXTRA_SECRET_KEY];
  rmSync(testDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/**
 * Forges a vault file using legacy KDF params (mirrors the pre-upgrade
 * format) so the opportunistic-rewrite branch in `unlockSecretVault` is
 * exercised end-to-end. The encryption mirrors `encryptContents` in
 * production code — kept duplicated here on purpose: importing private
 * helpers would couple the test to internals.
 */
interface LegacyKdfParams {
  readonly name: "scrypt";
  readonly N: number;
  readonly r: number;
  readonly p: number;
  readonly dkLen: 32;
}

function writeLegacyVault(
  path: string,
  password: string,
  secrets: Readonly<Record<string, string>>,
  params: LegacyKdfParams,
): void {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = scryptSync(password, salt, params.dkLen, {
    N: params.N,
    r: params.r,
    p: params.p,
  });
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const plaintext = Buffer.from(
    JSON.stringify({ version: 1, secrets }),
    "utf8",
  );
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  const file = {
    version: 1,
    kdf: params,
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

function readVaultKdf(path: string): { readonly N: number; readonly r: number; readonly p: number } {
  const raw = JSON.parse(readFileSync(path, "utf8")) as {
    kdf: { N: number; r: number; p: number };
  };
  return { N: raw.kdf.N, r: raw.kdf.r, p: raw.kdf.p };
}

describe("local secret vault", () => {
  it("creates an encrypted vault and unlocks stored secrets", () => {
    expect(secretVaultExists({ filePath: vaultFile })).toBe(false);

    createSecretVault("master-password", { filePath: vaultFile });
    writeSecretVaultSecrets(
      "master-password",
      {
        OPENROUTER_API_KEY: "sk-or-test",
        JUPITER_API_KEY: "jup-test",
      },
      { filePath: vaultFile },
    );

    const raw = readFileSync(vaultFile, "utf8");
    expect(raw).not.toContain("sk-or-test");
    expect(raw).not.toContain("jup-test");
    if (process.platform !== "win32") {
      expect(statSync(vaultFile).mode & 0o777).toBe(0o600);
    }

    const unlocked = unlockSecretVault("master-password", { filePath: vaultFile });
    expect(unlocked.secrets.OPENROUTER_API_KEY).toBe("sk-or-test");
    expect(unlocked.secrets.JUPITER_API_KEY).toBe("jup-test");
  });

  it("rejects the wrong password", () => {
    createSecretVault("master-password", { filePath: vaultFile });
    expect(() => unlockSecretVault("wrong-password", { filePath: vaultFile }))
      .toThrow(LocalSecretVaultError);
  });

  it("loads vault secrets into process.env only after unlock", () => {
    createSecretVault("master-password", { filePath: vaultFile });
    writeSecretVaultSecrets(
      "master-password",
      { OPENROUTER_API_KEY: "sk-or-test" },
      { filePath: vaultFile },
    );

    expect(process.env.OPENROUTER_API_KEY).toBeUndefined();
    applySecretVaultToProcessEnv("master-password", { filePath: vaultFile });
    expect(process.env.OPENROUTER_API_KEY).toBe("sk-or-test");
  });

  it("writes extra secrets without mirroring them to process.env", () => {
    createSecretVault("master-password", { filePath: vaultFile });
    writeSecretVaultSecrets(
      "master-password",
      { OPENROUTER_API_KEY: "sk-or-test" },
      { filePath: vaultFile },
    );

    writeSecretVaultExtraSecrets(
      "master-password",
      { [EXTRA_SECRET_KEY]: EXTRA_SECRET_VALUE },
      { filePath: vaultFile },
    );

    const raw = readFileSync(vaultFile, "utf8");
    expect(raw).not.toContain(EXTRA_SECRET_VALUE);
    const unlocked = unlockSecretVault("master-password", { filePath: vaultFile });
    expect(unlocked.secrets.OPENROUTER_API_KEY).toBe("sk-or-test");
    expect(unlocked.extraSecrets?.[EXTRA_SECRET_KEY]).toBe(EXTRA_SECRET_VALUE);

    applySecretVaultToProcessEnv("master-password", { filePath: vaultFile });
    expect(process.env.OPENROUTER_API_KEY).toBe("sk-or-test");
    expect(process.env[EXTRA_SECRET_KEY]).toBeUndefined();
  });

  it("deletes extra secrets without touching managed secrets or neighboring extras", () => {
    createSecretVault("master-password", { filePath: vaultFile });
    writeSecretVaultSecrets(
      "master-password",
      { JUPITER_API_KEY: "jup-test" },
      { filePath: vaultFile },
    );
    writeSecretVaultExtraSecrets(
      "master-password",
      {
        [EXTRA_SECRET_KEY]: EXTRA_SECRET_VALUE,
        "future/provider/key": "future-value",
      },
      { filePath: vaultFile },
    );

    writeSecretVaultExtraSecrets(
      "master-password",
      { [EXTRA_SECRET_KEY]: null },
      { filePath: vaultFile },
    );

    const unlocked = unlockSecretVault("master-password", { filePath: vaultFile });
    expect(unlocked.secrets.JUPITER_API_KEY).toBe("jup-test");
    expect(unlocked.extraSecrets?.[EXTRA_SECRET_KEY]).toBeUndefined();
    expect(unlocked.extraSecrets?.["future/provider/key"]).toBe("future-value");
  });

  it("strips managed secrets from legacy dotenv files", () => {
    writeFileSync(
      envFile,
      [
        'OPENROUTER_API_KEY="legacy"',
        'RELAY_API_KEY="legacy-relay-key"',
        'LIGHTER_CORE_READ_ONLY_AUTH_TOKEN="retired-core-token"',
        'LIGHTER_RHC_READ_ONLY_AUTH_TOKEN="retired-rhc-token"',
        'VEX_KEYSTORE_PASSWORD="legacy-password"',
        'AGENT_MODEL="openai/test"',
      ].join("\n") + "\n",
    );

    stripManagedSecretsFromDotenvFile(envFile);
    const raw = readFileSync(envFile, "utf8");
    expect(raw).not.toContain("OPENROUTER_API_KEY");
    expect(raw).not.toContain("RELAY_API_KEY");
    expect(raw).not.toContain("LIGHTER_CORE_READ_ONLY_AUTH_TOKEN");
    expect(raw).not.toContain("LIGHTER_RHC_READ_ONLY_AUTH_TOKEN");
    expect(raw).not.toContain("VEX_KEYSTORE_PASSWORD");
    expect(raw).toContain('AGENT_MODEL="openai/test"');
  });

  it("keeps retired Lighter tokens scrub-only and never vault-injected", () => {
    expect(RETIRED_SECRET_ENV_KEYS).toEqual([
      "LIGHTER_CORE_READ_ONLY_AUTH_TOKEN",
      "LIGHTER_RHC_READ_ONLY_AUTH_TOKEN",
    ]);
    for (const key of RETIRED_SECRET_ENV_KEYS) {
      expect(MANAGED_SECRET_ENV_KEYS).toContain(key);
      expect(VAULT_SECRET_KEYS).not.toContain(key);
    }
  });

  it("creates fresh vaults with CURRENT_KDF_PARAMS", () => {
    createSecretVault("master-password", { filePath: vaultFile });
    expect(readVaultKdf(vaultFile)).toEqual({
      N: CURRENT_KDF_PARAMS.N,
      r: CURRENT_KDF_PARAMS.r,
      p: CURRENT_KDF_PARAMS.p,
    });
    expect(CURRENT_KDF_PARAMS.N).toBe(131072); // 2^17 — OWASP scrypt minimum
  });

  it("opportunistically re-encrypts stale-KDF vaults on successful unlock", () => {
    // Forge a vault that mirrors the pre-upgrade N=16384 format.
    writeLegacyVault(
      vaultFile,
      "master-password",
      { OPENROUTER_API_KEY: "sk-or-test" },
      { name: "scrypt", N: 16384, r: 8, p: 1, dkLen: 32 },
    );
    expect(readVaultKdf(vaultFile).N).toBe(16384);

    const unlocked = unlockSecretVault("master-password", { filePath: vaultFile });
    expect(unlocked.secrets.OPENROUTER_API_KEY).toBe("sk-or-test");

    const afterKdf = readVaultKdf(vaultFile);
    expect(afterKdf.N).toBe(CURRENT_KDF_PARAMS.N);
    expect(afterKdf.r).toBe(CURRENT_KDF_PARAMS.r);
    expect(afterKdf.p).toBe(CURRENT_KDF_PARAMS.p);

    // Second unlock should succeed against the upgraded file too.
    const reUnlocked = unlockSecretVault("master-password", { filePath: vaultFile });
    expect(reUnlocked.secrets.OPENROUTER_API_KEY).toBe("sk-or-test");
  });

  // POSIX-only: simulating "write fails" via chmod on the directory.
  // Windows dir ACLs aren't honoured by chmodSync, so the rewrite would
  // still succeed and the assertion would be wrong. Skipping there is safer
  // than asserting platform-specific behavior; the production path itself
  // is cross-platform.
  it.skipIf(process.platform === "win32")(
    "returns decrypted secrets even when the KDF upgrade rewrite fails",
    () => {
      writeLegacyVault(
        vaultFile,
        "master-password",
        { JUPITER_API_KEY: "jup-test" },
        { name: "scrypt", N: 16384, r: 8, p: 1, dkLen: 32 },
      );
      // Capture the pre-unlock kdf so we can prove the rewrite did NOT happen.
      expect(readVaultKdf(vaultFile).N).toBe(16384);
      const originalRaw = readFileSync(vaultFile, "utf8");

      // Suppress process.emitWarning side effect so vitest doesn't choke on
      // an "unhandled" warning event in some node configurations.
      const warningSpy = vi
        .spyOn(process, "emitWarning")
        .mockImplementation((..._args: unknown[]): void => {});

      // Revoke write permissions on the containing directory so atomicWriteJson
      // fails to create its `.tmp` file. The encrypted payload is already in
      // memory by the time the rewrite runs, so decrypt still succeeds.
      chmodSync(testDir, 0o500);
      try {
        const unlocked = unlockSecretVault("master-password", { filePath: vaultFile });
        expect(unlocked.secrets.JUPITER_API_KEY).toBe("jup-test");
      } finally {
        // Restore write so afterEach cleanup can `rm -rf` the dir.
        chmodSync(testDir, 0o700);
      }

      expect(warningSpy).toHaveBeenCalled();
      // File should remain byte-identical (rewrite failed before disk).
      expect(readFileSync(vaultFile, "utf8")).toBe(originalRaw);
      expect(readVaultKdf(vaultFile).N).toBe(16384);
    },
  );

  it("does not rewrite when on-disk params already match CURRENT_KDF_PARAMS", () => {
    createSecretVault("master-password", { filePath: vaultFile });
    // Sanity: fresh vault is already at current params.
    expect(readVaultKdf(vaultFile).N).toBe(CURRENT_KDF_PARAMS.N);
    const beforeRaw = readFileSync(vaultFile, "utf8");

    unlockSecretVault("master-password", { filePath: vaultFile });

    // Byte-identity is the cleanest assertion here: opportunistic rewrite
    // regenerates salt+iv on every call, so any rewrite would change the
    // file content even when params already match.
    expect(readFileSync(vaultFile, "utf8")).toBe(beforeRaw);
  });

  describe("verifySecretVaultPassword", () => {
    it("returns undefined on correct password without throwing", () => {
      createSecretVault("master-password", { filePath: vaultFile });
      // The function signature is `void`; the runtime confirms no value
      // is returned even though the implementation discards decrypted secrets.
      const result: void = verifySecretVaultPassword("master-password", {
        filePath: vaultFile,
      });
      expect(result).toBeUndefined();
    });

    it("throws LocalSecretVaultError with code 'invalid_password' on wrong password", () => {
      createSecretVault("master-password", { filePath: vaultFile });
      let caught: unknown = null;
      try {
        verifySecretVaultPassword("wrong-password", { filePath: vaultFile });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(LocalSecretVaultError);
      if (caught instanceof LocalSecretVaultError) {
        expect(caught.code).toBe("invalid_password");
      }
    });

    it("throws with code 'missing' when the vault file does not exist", () => {
      // Don't create the vault.
      let caught: unknown = null;
      try {
        verifySecretVaultPassword("master-password", { filePath: vaultFile });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(LocalSecretVaultError);
      if (caught instanceof LocalSecretVaultError) {
        expect(caught.code).toBe("missing");
      }
    });

    it("throws with code 'corrupt' when the vault file is structurally invalid JSON", () => {
      writeFileSync(vaultFile, "{not valid json", {
        encoding: "utf8",
        mode: 0o600,
      });
      let caught: unknown = null;
      try {
        verifySecretVaultPassword("master-password", { filePath: vaultFile });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(LocalSecretVaultError);
      if (caught instanceof LocalSecretVaultError) {
        expect(caught.code).toBe("corrupt");
      }
    });

    it("does not rewrite the file on successful verify (no opportunistic upgrade)", () => {
      // Use a legacy-KDF vault — unlockSecretVault WOULD rewrite this on
      // successful unlock. verifySecretVaultPassword MUST NOT.
      writeLegacyVault(
        vaultFile,
        "master-password",
        { OPENROUTER_API_KEY: "sk-or-test" },
        { name: "scrypt", N: 16384, r: 8, p: 1, dkLen: 32 },
      );

      const beforeRaw = readFileSync(vaultFile, "utf8");
      const beforeMtime = statSync(vaultFile).mtimeMs;
      const beforeKdf = readVaultKdf(vaultFile);

      verifySecretVaultPassword("master-password", { filePath: vaultFile });

      // Disk write assertion: byte-identical + mtime unchanged + KDF unchanged.
      expect(readFileSync(vaultFile, "utf8")).toBe(beforeRaw);
      expect(statSync(vaultFile).mtimeMs).toBe(beforeMtime);
      expect(readVaultKdf(vaultFile)).toEqual(beforeKdf);
      // Sanity: legacy KDF still in place — proves the opportunistic upgrade
      // path that unlockSecretVault runs was NOT triggered here.
      expect(readVaultKdf(vaultFile).N).toBe(16384);
    });

    it("does not rewrite the file on wrong-password failure either", () => {
      createSecretVault("master-password", { filePath: vaultFile });
      const beforeRaw = readFileSync(vaultFile, "utf8");
      const beforeMtime = statSync(vaultFile).mtimeMs;

      expect(() =>
        verifySecretVaultPassword("wrong-password", { filePath: vaultFile }),
      ).toThrow(LocalSecretVaultError);

      expect(readFileSync(vaultFile, "utf8")).toBe(beforeRaw);
      expect(statSync(vaultFile).mtimeMs).toBe(beforeMtime);
    });
  });

  // ── Vault unlock error classification ──────────────────────────────────
  //
  // `decryptContents` used to wrap envelope decode + KDF derivation + AES-GCM
  // + JSON/schema parsing in ONE try/catch, so ANY failure after a correct
  // password — an unknown secret key, a too-new contents version, a
  // corrupted envelope field — was reported as `invalid_password`. That
  // advances the unlock throttle and can steer a user with a CORRECT
  // password toward wiping their keystores. These tests pin the fixed,
  // phase-split behavior: ONLY the GCM auth-tag failure at decipher.final()
  // may ever be `invalid_password` — scrypt/setup runtime failures are
  // `unavailable` (retryable), structural problems are `corrupt`.
  describe("vault unlock error classification", () => {
    const PASSWORD = "correct-horse-battery-staple";

    /**
     * Forges a vault file with an ARBITRARY (possibly type-illegal for
     * production) JSON contents payload, encrypted with CURRENT_KDF_PARAMS.
     * Mirrors `encryptContents` in production code — kept duplicated here on
     * purpose (see `writeLegacyVault` above): the production
     * `LocalSecretVaultContents` type pins `version` to the single literal
     * `VAULT_VERSION`, so testing a too-new version or an unknown secret key
     * needs a payload the production type cannot express.
     */
    function writeForgedContentsVault(contents: unknown, password = PASSWORD): void {
      const salt = randomBytes(16);
      const iv = randomBytes(12);
      const key = scryptSync(password, salt, CURRENT_KDF_PARAMS.dkLen, {
        N: CURRENT_KDF_PARAMS.N,
        r: CURRENT_KDF_PARAMS.r,
        p: CURRENT_KDF_PARAMS.p,
        maxmem: 256 * 1024 * 1024,
      });
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const ciphertext = Buffer.concat([
        cipher.update(Buffer.from(JSON.stringify(contents), "utf8")),
        cipher.final(),
      ]);
      const file = {
        version: 1,
        kdf: CURRENT_KDF_PARAMS,
        salt: salt.toString("base64"),
        iv: iv.toString("base64"),
        tag: cipher.getAuthTag().toString("base64"),
        ciphertext: ciphertext.toString("base64"),
      };
      writeFileSync(vaultFile, `${JSON.stringify(file, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
    }

    /** Reads back a real, valid vault file and overwrites specific fields. */
    function writeVaultWithFieldOverrides(
      overrides: Record<string, unknown>,
    ): void {
      createSecretVault(PASSWORD, { filePath: vaultFile });
      const file = JSON.parse(readFileSync(vaultFile, "utf8")) as Record<string, unknown>;
      const kdfOverrides = overrides.kdf as Record<string, unknown> | undefined;
      const merged = {
        ...file,
        ...overrides,
        ...(kdfOverrides
          ? { kdf: { ...(file.kdf as Record<string, unknown>), ...kdfOverrides } }
          : {}),
      };
      writeFileSync(vaultFile, `${JSON.stringify(merged, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
    }

    function expectCode(fn: () => void, code: string): void {
      let caught: unknown = null;
      try {
        fn();
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(LocalSecretVaultError);
      if (caught instanceof LocalSecretVaultError) expect(caught.code).toBe(code);
    }

    describe("envelope validation (corrupt, never invalid_password)", () => {
      it("rejects a non-canonical base64 iv", () => {
        writeVaultWithFieldOverrides({ iv: "not-valid-base64-!!!" });
        expectCode(() => unlockSecretVault(PASSWORD, { filePath: vaultFile }), "corrupt");
      });

      it("rejects an iv that decodes to the wrong byte length", () => {
        writeVaultWithFieldOverrides({ iv: Buffer.alloc(8).toString("base64") });
        expectCode(() => unlockSecretVault(PASSWORD, { filePath: vaultFile }), "corrupt");
      });

      it("rejects a tag that decodes to the wrong byte length", () => {
        writeVaultWithFieldOverrides({ tag: Buffer.alloc(4).toString("base64") });
        expectCode(() => unlockSecretVault(PASSWORD, { filePath: vaultFile }), "corrupt");
      });

      it("rejects a salt shorter than the minimum bound", () => {
        writeVaultWithFieldOverrides({ salt: Buffer.alloc(4).toString("base64") });
        expectCode(() => unlockSecretVault(PASSWORD, { filePath: vaultFile }), "corrupt");
      });

      it("rejects a ciphertext larger than the maximum bound", () => {
        // 10 MiB + 1 byte — a real vault (small API secrets) never gets close.
        writeVaultWithFieldOverrides({
          ciphertext: randomBytes(10 * 1024 * 1024 + 1).toString("base64"),
        });
        expectCode(() => unlockSecretVault(PASSWORD, { filePath: vaultFile }), "corrupt");
      });
    });

    describe("KDF bounds validation (corrupt, before scrypt runs)", () => {
      it("rejects N below the supported minimum", () => {
        writeVaultWithFieldOverrides({ kdf: { N: 2 ** 10 } });
        expectCode(() => unlockSecretVault(PASSWORD, { filePath: vaultFile }), "corrupt");
      });

      it("rejects N above the supported maximum", () => {
        writeVaultWithFieldOverrides({ kdf: { N: 2 ** 20 } });
        expectCode(() => unlockSecretVault(PASSWORD, { filePath: vaultFile }), "corrupt");
      });

      it("rejects a non-power-of-two N inside the numeric range", () => {
        writeVaultWithFieldOverrides({ kdf: { N: 100000 } });
        expectCode(() => unlockSecretVault(PASSWORD, { filePath: vaultFile }), "corrupt");
      });

      it("rejects r != 8", () => {
        writeVaultWithFieldOverrides({ kdf: { r: 16 } });
        expectCode(() => unlockSecretVault(PASSWORD, { filePath: vaultFile }), "corrupt");
      });

      it("rejects p != 1", () => {
        writeVaultWithFieldOverrides({ kdf: { p: 2 } });
        expectCode(() => unlockSecretVault(PASSWORD, { filePath: vaultFile }), "corrupt");
      });

      it("rejects an out-of-bounds N BEFORE the synchronous scrypt derivation runs (never invalid_password, even with the WRONG password)", () => {
        // If the bounds check ran after (or inside) the crypto try/catch, a
        // wrong password against this file would surface as
        // `invalid_password` once scrypt/AES-GCM failed. Getting `corrupt`
        // here — with a password that was never even tried — proves the
        // rejection happens strictly before any scrypt call.
        writeVaultWithFieldOverrides({ kdf: { N: 2 ** 22 } });
        expectCode(
          () => unlockSecretVault("definitely-the-wrong-password", { filePath: vaultFile }),
          "corrupt",
        );
      });
    });

    describe("contents version + unknown secret keys", () => {
      it("a scrypt derivation failure with a CORRECT password throws 'unavailable' (retryable) — never invalid_password, never corrupt", () => {
        // 'corrupt' would tell the user to restore from a backup; a transient
        // crypto-runtime failure needs a RETRY, so it gets its own code.
        writeForgedContentsVault({ version: 1, secrets: { OPENROUTER_API_KEY: "sk-known" } });
        forcedScryptFailure.armed = true; // arm AFTER the write (writing derives a key too)
        try {
          expectCode(
            () => unlockSecretVault(PASSWORD, { filePath: vaultFile }),
            "unavailable",
          );
        } finally {
          forcedScryptFailure.armed = false; // leak-proof: assertion failures must not poison later tests
        }
      });

      it("throws 'incompatible' (never invalid_password) when contents.version is newer than this build supports", () => {
        writeForgedContentsVault({
          version: 2,
          secrets: { OPENROUTER_API_KEY: "sk-known" },
        });
        expectCode(
          () => unlockSecretVault(PASSWORD, { filePath: vaultFile }),
          "incompatible",
        );
      });

      it("throws 'incompatible' (never corrupt) for a future OUTER envelope version, even with an unrecognized shape", () => {
        // A future build may change the envelope itself (fields, KDF family) —
        // the outer-version gate must classify BEFORE the strict shape parse,
        // or every outer-2 vault would misreport as corrupt.
        writeFileSync(
          vaultFile,
          JSON.stringify({ version: 2, kdf: { name: "argon2id" }, blob: "AAAA" }),
          "utf8",
        );
        expectCode(
          () => unlockSecretVault(PASSWORD, { filePath: vaultFile }),
          "incompatible",
        );
      });

      it("unlocks with a correct password despite an unknown secret key, preserving it as extraSecrets", () => {
        writeForgedContentsVault({
          version: 1,
          secrets: {
            OPENROUTER_API_KEY: "sk-known",
            FUTURE_SECRET_KEY_FROM_NEWER_BUILD: "future-value",
          },
        });

        const unlocked = unlockSecretVault(PASSWORD, { filePath: vaultFile });
        expect(unlocked.secrets.OPENROUTER_API_KEY).toBe("sk-known");
        expect(unlocked.extraSecrets?.FUTURE_SECRET_KEY_FROM_NEWER_BUILD).toBe(
          "future-value",
        );
      });

      it("still throws 'invalid_password' for a genuinely wrong password on an otherwise valid vault", () => {
        createSecretVault(PASSWORD, { filePath: vaultFile });
        expectCode(
          () => unlockSecretVault("wrong-password", { filePath: vaultFile }),
          "invalid_password",
        );
      });

      it("round-trips an unknown secret key through unlock + write + unlock again", () => {
        writeForgedContentsVault({
          version: 1,
          secrets: {
            OPENROUTER_API_KEY: "sk-known",
            FUTURE_SECRET_KEY_FROM_NEWER_BUILD: "future-value",
          },
        });

        writeSecretVaultSecrets(
          PASSWORD,
          { JUPITER_API_KEY: "jup-added" },
          { filePath: vaultFile },
        );

        const unlocked = unlockSecretVault(PASSWORD, { filePath: vaultFile });
        expect(unlocked.secrets.OPENROUTER_API_KEY).toBe("sk-known");
        expect(unlocked.secrets.JUPITER_API_KEY).toBe("jup-added");
        expect(unlocked.extraSecrets?.FUTURE_SECRET_KEY_FROM_NEWER_BUILD).toBe(
          "future-value",
        );
      });
    });
  });
});
