import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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
  writeSecretVaultSecrets,
} from "../../lib/local-secret-vault.js";

let testDir = "";
let vaultFile = "";
let envFile = "";

beforeEach(() => {
  testDir = join(tmpdir(), `vex-secret-vault-${Date.now()}-${Math.random()}`);
  mkdirSync(testDir, { recursive: true });
  vaultFile = join(testDir, "secrets.vault.json");
  envFile = join(testDir, ".env");
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.JUPITER_API_KEY;
});

afterEach(() => {
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.JUPITER_API_KEY;
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

  it("strips managed secrets from legacy dotenv files", () => {
    writeFileSync(
      envFile,
      [
        'OPENROUTER_API_KEY="legacy"',
        'VEX_KEYSTORE_PASSWORD="legacy-password"',
        'AGENT_MODEL="openai/test"',
      ].join("\n") + "\n",
    );

    stripManagedSecretsFromDotenvFile(envFile);
    const raw = readFileSync(envFile, "utf8");
    expect(raw).not.toContain("OPENROUTER_API_KEY");
    expect(raw).not.toContain("VEX_KEYSTORE_PASSWORD");
    expect(raw).toContain('AGENT_MODEL="openai/test"');
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

  /**
   * F-03: post-decrypt schema/version failures must NOT be labeled
   * `invalid_password` (that advances unlock throttle and misleads users).
   */
  describe("F-03 password vs incompatible vault classification", () => {
    const PASSWORD = "correct-horse-battery-staple";

    function writeForgedContentsVault(contents: unknown): void {
      const salt = randomBytes(16);
      const iv = randomBytes(12);
      const key = scryptSync(PASSWORD, salt, CURRENT_KDF_PARAMS.dkLen, {
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

    it("unlocks a vault that contains an unknown future secret key (correct password)", () => {
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

    it("throws incompatible (not invalid_password) for contents version > VAULT_VERSION", () => {
      writeForgedContentsVault({
        version: 2,
        secrets: { OPENROUTER_API_KEY: "sk-known" },
      });

      let caught: unknown = null;
      try {
        unlockSecretVault(PASSWORD, { filePath: vaultFile });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(LocalSecretVaultError);
      if (caught instanceof LocalSecretVaultError) {
        expect(caught.code).toBe("incompatible");
        expect(caught.code).not.toBe("invalid_password");
      }
    });

    it("still throws invalid_password for a genuinely wrong password", () => {
      createSecretVault(PASSWORD, { filePath: vaultFile });
      let caught: unknown = null;
      try {
        unlockSecretVault("WRONG-PASSWORD", { filePath: vaultFile });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(LocalSecretVaultError);
      if (caught instanceof LocalSecretVaultError) {
        expect(caught.code).toBe("invalid_password");
      }
    });

    it("round-trips unknown extra secrets through unlock + write", () => {
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
