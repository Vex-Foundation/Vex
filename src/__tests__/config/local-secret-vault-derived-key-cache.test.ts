import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * VAULT_DERIVED_KEY_CACHE proof suite (fastLighterClick FLC-0), against the
 * REAL scrypt KDF and real vault files.
 *
 * `node:crypto` is a passthrough whose async `scrypt` (the vault's KDF) is
 * counted, so every case can state exactly how many derives ran. The forging
 * helpers below use `scryptSync`, which is not counted.
 */
const kdf = { calls: 0 };
vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return {
    ...actual,
    scrypt: (
      password: string,
      salt: Uint8Array,
      keylen: number,
      options: import("node:crypto").ScryptOptions,
      callback: (err: Error | null, derivedKey: Buffer) => void,
    ) => {
      kdf.calls += 1;
      actual.scrypt(password, salt, keylen, options, callback);
    },
  };
});

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applySecretVaultToProcessEnv,
  createSecretVault,
  CURRENT_KDF_PARAMS,
  LocalSecretVaultError,
  unlockSecretVault,
  verifySecretVaultPassword,
  writeSecretVaultExtraSecrets,
  writeSecretVaultSecrets,
  type LocalSecretVaultContents,
  type LocalSecretVaultOptions,
} from "../../lib/local-secret-vault.js";
import {
  VaultDerivedKeyCache,
  type LocalSecretVaultCacheOptions,
  type VaultTimingRecord,
} from "../../lib/local-secret-vault/derived-key-cache.js";
import { requireValue } from "../helpers/require-value.js";

const PASSWORD = "correct-horse-battery-staple";
const WRONG_PASSWORD = "correct-horse-battery-stapler";
const EXTRA_KEY = "lighter/rhc/account-42/api-key-7";
const EXTRA_VALUE = `0x${"1".repeat(80)}`;

let testDir = "";
let vaultFile = "";

beforeEach(() => {
  testDir = join(tmpdir(), `vex-vault-key-cache-${Date.now()}-${Math.random()}`);
  mkdirSync(testDir, { recursive: true });
  vaultFile = join(testDir, "secrets.vault.json");
  kdf.calls = 0;
  delete process.env.OPENROUTER_API_KEY;
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
  delete process.env.OPENROUTER_API_KEY;
  vi.restoreAllMocks();
});

/** Run `fn` and return its result with the number of scrypt derives it ran. */
async function counted<T>(fn: () => Promise<T>): Promise<{ readonly value: T; readonly derives: number }> {
  const before = kdf.calls;
  const value = await fn();
  return { value, derives: kdf.calls - before };
}

/** Capture the classified failure of a vault call (class, code, message). */
async function failureOf(fn: () => Promise<unknown>): Promise<{
  readonly name: string;
  readonly code: string;
  readonly message: string;
  readonly derives: number;
}> {
  const before = kdf.calls;
  try {
    await fn();
  } catch (error) {
    if (error instanceof LocalSecretVaultError) {
      return { name: error.name, code: error.code, message: error.message, derives: kdf.calls - before };
    }
    throw error;
  }
  throw new Error("expected the vault call to fail");
}

async function seedVault(): Promise<void> {
  await createSecretVault(PASSWORD, { filePath: vaultFile });
  await writeSecretVaultSecrets(PASSWORD, { OPENROUTER_API_KEY: "sk-or-test" }, { filePath: vaultFile });
  await writeSecretVaultExtraSecrets(PASSWORD, { [EXTRA_KEY]: EXTRA_VALUE }, { filePath: vaultFile });
}

interface RawVaultFile {
  version: number;
  kdf: { name: string; N: number; r: number; p: number; dkLen: number };
  salt: string;
  iv: string;
  tag: string;
  ciphertext: string;
}

function readRaw(): RawVaultFile {
  return JSON.parse(readFileSync(vaultFile, "utf8")) as RawVaultFile;
}

function writeRaw(file: RawVaultFile): void {
  writeFileSync(vaultFile, `${JSON.stringify(file, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

function flipFirstByte(base64: string): string {
  const bytes = Buffer.from(base64, "base64");
  bytes[0] = (bytes[0] ?? 0) ^ 0x01;
  return bytes.toString("base64");
}

function cachedOptions(
  cache: VaultDerivedKeyCache,
  label = "test_read",
): LocalSecretVaultCacheOptions {
  return { filePath: vaultFile, derivedKeyCache: cache, timingLabel: label };
}

describe("VAULT_DERIVED_KEY_CACHE: cached reads", () => {
  it("a warm read skips the derive and returns exactly the uncached contents", async () => {
    await seedVault();
    const cache = new VaultDerivedKeyCache();

    const uncached = await counted(() => unlockSecretVault(PASSWORD, { filePath: vaultFile }));
    const cold = await counted(() => unlockSecretVault(PASSWORD, cachedOptions(cache)));
    const warm = await counted(() => unlockSecretVault(PASSWORD, cachedOptions(cache)));
    const warmAgain = await counted(() => unlockSecretVault(PASSWORD, cachedOptions(cache)));

    expect(uncached.derives).toBe(1);
    expect(cold.derives).toBe(1);
    expect(warm.derives).toBe(0);
    expect(warmAgain.derives).toBe(0);
    expect(cold.value).toEqual(uncached.value);
    expect(warm.value).toEqual(uncached.value);
    expect(warm.value.extraSecrets?.[EXTRA_KEY]).toBe(EXTRA_VALUE);
    expect(cache.size).toBe(1);
  });

  it("N concurrent cold reads derive once", async () => {
    await seedVault();
    const cache = new VaultDerivedKeyCache();

    const reads = await counted(() =>
      Promise.all(Array.from({ length: 6 }, () => unlockSecretVault(PASSWORD, cachedOptions(cache)))),
    );

    expect(reads.derives).toBe(1);
    for (const contents of reads.value) {
      expect(contents.secrets.OPENROUTER_API_KEY).toBe("sk-or-test");
    }
  });

  it("the cache's own derive is single flight and hands every caller a private copy", async () => {
    const cache = new VaultDerivedKeyCache();
    const salt = randomBytes(16);
    let runs = 0;
    let release: (key: Buffer) => void = () => {};
    const derive = (): Promise<Buffer> => {
      runs += 1;
      return new Promise<Buffer>((resolve) => {
        release = resolve;
      });
    };

    const pending = Array.from({ length: 5 }, () =>
      cache.derive(vaultFile, salt, CURRENT_KDF_PARAMS, PASSWORD, derive),
    );
    release(Buffer.alloc(32, 7));
    const results = await Promise.all(pending);

    expect(runs).toBe(1);
    expect(results.filter((result) => result.started)).toHaveLength(1);
    const first = requireValue(results[0]).key;
    for (const result of results) {
      expect(result.key.equals(Buffer.alloc(32, 7))).toBe(true);
    }
    first.fill(0);
    expect(requireValue(results[1]).key.equals(Buffer.alloc(32, 7))).toBe(true);
  });
});

describe("VAULT_DERIVED_KEY_CACHE: authentication paths never use it", () => {
  it("a wrong password never succeeds with a warm cache, and leaves the good entry alone", async () => {
    await seedVault();
    const cache = new VaultDerivedKeyCache();
    await unlockSecretVault(PASSWORD, cachedOptions(cache));
    const before = readFileSync(vaultFile, "utf8");

    const read = await failureOf(() => unlockSecretVault(WRONG_PASSWORD, cachedOptions(cache)));
    const write = await failureOf(() =>
      writeSecretVaultSecrets(WRONG_PASSWORD, { JUPITER_API_KEY: "jup" }, cachedOptions(cache)),
    );
    const apply = await failureOf(() => applySecretVaultToProcessEnv(WRONG_PASSWORD, cachedOptions(cache)));

    for (const failure of [read, write, apply]) {
      expect(failure.code).toBe("invalid_password");
      expect(failure.derives).toBe(1);
    }
    expect(readFileSync(vaultFile, "utf8")).toBe(before);
    expect(process.env.OPENROUTER_API_KEY).toBeUndefined();
    expect(cache.size).toBe(1);
    const stillWarm = await counted(() => unlockSecretVault(PASSWORD, cachedOptions(cache)));
    expect(stillWarm.derives).toBe(0);
  });

  it("verify, an uncached unlock and create always run the full KDF, even with a warm cache", async () => {
    await seedVault();
    const cache = new VaultDerivedKeyCache();
    await unlockSecretVault(PASSWORD, cachedOptions(cache));
    // A caller could hand these a cache-bearing options object (it is a
    // structural superset); they must still never consult it.
    const widened: LocalSecretVaultOptions = cachedOptions(cache);

    const verifyRight = await counted(() => verifySecretVaultPassword(PASSWORD, widened));
    const verifyRightAgain = await counted(() => verifySecretVaultPassword(PASSWORD, widened));
    const verifyWrong = await failureOf(() => verifySecretVaultPassword(WRONG_PASSWORD, widened));
    const unlockUncached = await counted(() => unlockSecretVault(PASSWORD, { filePath: vaultFile }));
    const createExisting = await counted(() => createSecretVault(PASSWORD, widened));

    expect(verifyRight.derives).toBe(1);
    expect(verifyRightAgain.derives).toBe(1);
    expect(verifyWrong).toMatchObject({ code: "invalid_password", derives: 1 });
    expect(unlockUncached.derives).toBe(1);
    expect(createExisting.derives).toBe(1);
  });
});

describe("VAULT_DERIVED_KEY_CACHE: drop and generation", () => {
  it("clear() drops every key and the next cached read derives again", async () => {
    await seedVault();
    const cache = new VaultDerivedKeyCache();
    await unlockSecretVault(PASSWORD, cachedOptions(cache));
    expect(cache.size).toBe(1);

    cache.clear();

    expect(cache.size).toBe(0);
    const afterClear = await counted(() => unlockSecretVault(PASSWORD, cachedOptions(cache)));
    expect(afterClear.derives).toBe(1);
  });

  it("a clear that lands while a cached read or write is in flight stops it storing a key", async () => {
    await seedVault();
    const cache = new VaultDerivedKeyCache();

    const read = unlockSecretVault(PASSWORD, cachedOptions(cache));
    cache.clear();
    await read;
    expect(cache.size).toBe(0);

    const write = writeSecretVaultSecrets(PASSWORD, { JUPITER_API_KEY: "jup" }, cachedOptions(cache));
    cache.clear();
    await write;
    expect(cache.size).toBe(0);

    // Requested after the clears: a normal cold read that stores again.
    const fresh = await counted(() => unlockSecretVault(PASSWORD, cachedOptions(cache)));
    expect(fresh.derives).toBe(1);
    expect(fresh.value.secrets.JUPITER_API_KEY).toBe("jup");
    expect(cache.size).toBe(1);
  });
});

describe("VAULT_DERIVED_KEY_CACHE: writes rotate the salt", () => {
  it("a write uses a fresh salt, keeps the new key, and the old key never opens the new file", async () => {
    await seedVault();
    const cache = new VaultDerivedKeyCache();
    await unlockSecretVault(PASSWORD, cachedOptions(cache));
    const oldFile = readRaw();
    const oldKey = scryptSync(PASSWORD, Buffer.from(oldFile.salt, "base64"), 32, {
      N: oldFile.kdf.N,
      r: oldFile.kdf.r,
      p: oldFile.kdf.p,
      maxmem: 256 * 1024 * 1024,
    });

    const write = await counted(() =>
      writeSecretVaultSecrets(PASSWORD, { JUPITER_API_KEY: "jup" }, cachedOptions(cache, "test_write")),
    );
    const newFile = readRaw();
    const read = await counted(() => unlockSecretVault(PASSWORD, cachedOptions(cache)));

    // The read inside the write was a hit; only the fresh-salt encryption derived.
    expect(write.derives).toBe(1);
    expect(newFile.salt).not.toBe(oldFile.salt);
    expect(read.derives).toBe(0);
    expect(read.value.secrets.JUPITER_API_KEY).toBe("jup");

    const decipher = createDecipheriv("aes-256-gcm", oldKey, Buffer.from(newFile.iv, "base64"));
    decipher.setAuthTag(Buffer.from(newFile.tag, "base64"));
    decipher.update(Buffer.from(newFile.ciphertext, "base64"));
    expect(() => decipher.final()).toThrow();
  });

  it("an uncached write by someone else is simply a miss for the new salt", async () => {
    await seedVault();
    const cache = new VaultDerivedKeyCache();
    await unlockSecretVault(PASSWORD, cachedOptions(cache));

    await writeSecretVaultSecrets(PASSWORD, { JUPITER_API_KEY: "outside" }, { filePath: vaultFile });
    const read = await counted(() => unlockSecretVault(PASSWORD, cachedOptions(cache)));

    expect(read.derives).toBe(1);
    expect(read.value.secrets.JUPITER_API_KEY).toBe("outside");
  });

  it("a KDF-upgrade rewrite keeps the key for the upgraded file", async () => {
    const salt = randomBytes(16);
    const iv = randomBytes(12);
    const legacy = { name: "scrypt", N: 16384, r: 8, p: 1, dkLen: 32 } as const;
    const key = scryptSync(PASSWORD, salt, 32, { N: legacy.N, r: legacy.r, p: legacy.p });
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const ciphertext = Buffer.concat([
      cipher.update(Buffer.from(JSON.stringify({ version: 1, secrets: { OPENROUTER_API_KEY: "sk-legacy" } }))),
      cipher.final(),
    ]);
    writeRaw({
      version: 1,
      kdf: legacy,
      salt: salt.toString("base64"),
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64"),
    });
    const cache = new VaultDerivedKeyCache();

    const upgrade = await counted(() => unlockSecretVault(PASSWORD, cachedOptions(cache)));
    const after = await counted(() => unlockSecretVault(PASSWORD, cachedOptions(cache)));

    expect(upgrade.derives).toBe(2);
    expect(readRaw().kdf.N).toBe(CURRENT_KDF_PARAMS.N);
    expect(after.derives).toBe(0);
    expect(after.value.secrets.OPENROUTER_API_KEY).toBe("sk-legacy");
  });
});

describe("VAULT_DERIVED_KEY_CACHE: tampering fails exactly as today", () => {
  const TAMPERS: ReadonlyArray<{
    readonly name: string;
    readonly tamper: (file: RawVaultFile) => RawVaultFile;
    readonly sameSalt: boolean;
  }> = [
    { name: "ciphertext bit flip", tamper: (f) => ({ ...f, ciphertext: flipFirstByte(f.ciphertext) }), sameSalt: true },
    { name: "auth tag bit flip", tamper: (f) => ({ ...f, tag: flipFirstByte(f.tag) }), sameSalt: true },
    { name: "iv bit flip", tamper: (f) => ({ ...f, iv: flipFirstByte(f.iv) }), sameSalt: true },
    { name: "salt replaced by another valid salt", tamper: (f) => ({ ...f, salt: randomBytes(16).toString("base64") }), sameSalt: false },
    { name: "salt bit flip", tamper: (f) => ({ ...f, salt: flipFirstByte(f.salt) }), sameSalt: false },
    { name: "salt not base64", tamper: (f) => ({ ...f, salt: "not-base64-!!" }), sameSalt: false },
    { name: "salt too short", tamper: (f) => ({ ...f, salt: Buffer.alloc(4).toString("base64") }), sameSalt: false },
    { name: "KDF N changed within bounds", tamper: (f) => ({ ...f, kdf: { ...f.kdf, N: 65536 } }), sameSalt: false },
  ];

  for (const { name, tamper, sameSalt } of TAMPERS) {
    it(`${name}: same failure as the uncached read, with a warm cache`, async () => {
      await seedVault();
      const records: VaultTimingRecord[] = [];
      const cache = new VaultDerivedKeyCache({ onTiming: (record) => records.push(record) });
      await unlockSecretVault(PASSWORD, cachedOptions(cache));
      writeRaw(tamper(readRaw()));
      records.length = 0;

      const uncached = await failureOf(() => unlockSecretVault(PASSWORD, { filePath: vaultFile }));
      const cached = await failureOf(() => unlockSecretVault(PASSWORD, cachedOptions(cache)));

      expect({ ...cached, derives: 0 }).toEqual({ ...uncached, derives: 0 });
      // A same-salt tamper hits the cached key, fails its GCM tag, drops it
      // and derives once from scratch: the same one derive the uncached read
      // paid. Anything else misses (or is rejected before any crypto).
      expect(cached.derives).toBe(uncached.derives);
      const record = requireValue(records[0]);
      expect(record.tagRetry).toBe(sameSalt ? 1 : 0);
      expect(record.cacheHit).toBe(sameSalt ? 1 : 0);
      if (sameSalt) expect(cache.size).toBe(0);
    });
  }
});

describe("VAULT_DERIVED_KEY_CACHE: OFF is today's path", () => {
  /**
   * The same scripted sequence with no cache (OFF) and with one (ON). OFF
   * must show today's derive counts; ON must return the same results and
   * the same failures, with fewer derives only on cached reads and writes.
   */
  async function script(cache: VaultDerivedKeyCache | null): Promise<{
    readonly results: unknown[];
    readonly derives: number[];
  }> {
    const opts: LocalSecretVaultCacheOptions = cache === null
      ? { filePath: vaultFile }
      : { filePath: vaultFile, derivedKeyCache: cache };
    const results: unknown[] = [];
    const derives: number[] = [];
    const step = async (fn: () => Promise<unknown>): Promise<void> => {
      const before = kdf.calls;
      try {
        results.push({ ok: await fn() });
      } catch (error) {
        results.push({
          error: error instanceof LocalSecretVaultError ? [error.code, error.message] : String(error),
        });
      }
      derives.push(kdf.calls - before);
    };

    await step(() => createSecretVault(PASSWORD, { filePath: vaultFile }));
    await step(() => writeSecretVaultSecrets(PASSWORD, { OPENROUTER_API_KEY: "sk-1" }, opts));
    await step(() => unlockSecretVault(PASSWORD, opts));
    await step(() => unlockSecretVault(PASSWORD, opts));
    await step(() => writeSecretVaultExtraSecrets(PASSWORD, { [EXTRA_KEY]: EXTRA_VALUE }, opts));
    await step(() => applySecretVaultToProcessEnv(PASSWORD, opts));
    await step(() => unlockSecretVault(WRONG_PASSWORD, opts));
    await step(() => verifySecretVaultPassword(PASSWORD, { filePath: vaultFile }));
    await step(() => unlockSecretVault(PASSWORD, opts));
    return { results, derives };
  }

  it("OFF reproduces today's derive counts and ON returns identical results", async () => {
    const off = await script(null);
    rmSync(vaultFile, { force: true });
    delete process.env.OPENROUTER_API_KEY;
    const on = await script(new VaultDerivedKeyCache());

    // Today: create 1, write 2 (unlock + encrypt), unlock 1, unlock 1,
    // write 2, apply 1, wrong password 1, verify 1, unlock 1.
    expect(off.derives).toEqual([1, 2, 1, 1, 2, 1, 1, 1, 1]);
    // ON: the write's read misses once (cold), then everything hits; each
    // write still derives for its fresh salt; a wrong password and verify
    // still derive.
    expect(on.derives).toEqual([1, 2, 0, 0, 1, 0, 1, 1, 0]);
    expect(on.results).toEqual(off.results);
  });
});

describe("VAULT_DERIVED_KEY_CACHE: [vault-timing] records", () => {
  it("carry numbers, the operation kind and the caller label only", async () => {
    await seedVault();
    const records: VaultTimingRecord[] = [];
    const cache = new VaultDerivedKeyCache({ onTiming: (record) => records.push(record) });

    await unlockSecretVault(PASSWORD, cachedOptions(cache, "cold_read"));
    await unlockSecretVault(PASSWORD, cachedOptions(cache, "warm_read"));
    await writeSecretVaultSecrets(PASSWORD, { JUPITER_API_KEY: "jup" }, cachedOptions(cache, "write"));
    await expect(unlockSecretVault(WRONG_PASSWORD, cachedOptions(cache, "wrong"))).rejects.toThrow();

    expect(records.map(({ op, label, cacheHit, cacheMiss, tagRetry, derives }) => ({
      op, label, cacheHit, cacheMiss, tagRetry, derives,
    }))).toEqual([
      { op: "read", label: "cold_read", cacheHit: 0, cacheMiss: 1, tagRetry: 0, derives: 1 },
      { op: "read", label: "warm_read", cacheHit: 1, cacheMiss: 0, tagRetry: 0, derives: 0 },
      { op: "write", label: "write", cacheHit: 1, cacheMiss: 0, tagRetry: 0, derives: 1 },
      { op: "read", label: "wrong", cacheHit: 0, cacheMiss: 1, tagRetry: 0, derives: 1 },
    ]);
    const file = readRaw();
    for (const record of records) {
      expect(Object.keys(record).sort()).toEqual([
        "cacheHit", "cacheMiss", "deriveMs", "derives", "label", "lockWaitMs", "op", "tagRetry", "totalMs",
      ]);
      for (const field of ["cacheHit", "cacheMiss", "deriveMs", "derives", "lockWaitMs", "tagRetry", "totalMs"] as const) {
        expect(Number.isInteger(record[field])).toBe(true);
      }
      const serialized = JSON.stringify(record);
      expect(serialized).not.toContain(PASSWORD);
      expect(serialized).not.toContain(file.salt);
      expect(serialized).not.toContain(vaultFile);
    }
    expect(requireValue(records[0]).deriveMs).toBeGreaterThan(0);
  });

  it("a throwing timing sink never fails the vault operation", async () => {
    await seedVault();
    const cache = new VaultDerivedKeyCache({
      onTiming: () => {
        throw new Error("sink down");
      },
    });

    const contents: LocalSecretVaultContents = await unlockSecretVault(PASSWORD, cachedOptions(cache));

    expect(contents.secrets.OPENROUTER_API_KEY).toBe("sk-or-test");
  });

  it("the cache never exposes a key, fingerprint or path when serialised or inspected", async () => {
    await seedVault();
    const cache = new VaultDerivedKeyCache();
    await unlockSecretVault(PASSWORD, cachedOptions(cache));

    expect(JSON.stringify(cache)).toBe("{}");
    const inspected = (await import("node:util")).inspect(cache, { depth: 5, showHidden: true });
    expect(inspected).not.toContain(vaultFile);
    expect(inspected).not.toMatch(/[0-9a-f]{2} [0-9a-f]{2} [0-9a-f]{2}/);
  });
});
