/**
 * FLC-6: the scrypt KDF can be started from a worker thread
 * (`SCRYPT_KDF_OFF_MAIN_THREAD`).
 *
 * In the Electron main process every `crypto.scrypt` call at N=2^17 froze the
 * calling thread for one full derive (Electron's BoringSSL runs the whole KDF
 * inside Node's parameter check). The switch moves that call to one resident
 * worker. Plain Node, where these tests run, has no such freeze, so the venue
 * is forced with `callerThreadRunsFullKdf: true` to exercise the real worker.
 *
 * What these tests pin, OFF against ON:
 *   - the same bytes for every input shape the vault and the keystore use;
 *   - the same error (class, code, message) for a bad parameter set;
 *   - every worker fault (cannot start, dies, crashes mid-derive) resolves
 *     through today's path with the right bytes, and three faults in a row
 *     retire the worker for good;
 *   - OFF, and plain Node by default, never create a worker;
 *   - the worker gets an empty env, is unref'd when idle and ref'd while a
 *     derive is in flight;
 *   - the vault still refuses a wrong password through the worker.
 */
import { randomBytes, scryptSync, type ScryptOptions } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker, type WorkerOptions } from "node:worker_threads";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  LocalSecretVaultError,
  createSecretVault,
  unlockSecretVault,
  writeSecretVaultSecrets,
} from "../../lib/local-secret-vault.js";
import { decryptPrivateKey, encryptPrivateKey } from "@tools/wallet/keystore.js";
import {
  SCRYPT_KDF_OFF_MAIN_THREAD,
  SCRYPT_KDF_WORKER_MAX_CONSECUTIVE_FAILURES,
  configureScryptAsyncDeps,
  scryptAsync,
  takeScryptKdfStats,
} from "../../utils/scrypt-async.js";

const MAXMEM = 256 * 1024 * 1024;
const FAST: ScryptOptions = { N: 2 ** 14, r: 8, p: 1, maxmem: MAXMEM };
const VAULT: ScryptOptions = { N: 2 ** 17, r: 8, p: 1, maxmem: MAXMEM };

interface CreatedWorker {
  readonly source: string;
  readonly options: WorkerOptions;
  readonly worker: Worker;
  readonly calls: string[];
}

/** A real worker factory that records what it was asked for and ref/unref calls. */
function recordingFactory(created: CreatedWorker[]): (source: string, options: WorkerOptions) => Worker {
  return (source, options) => {
    const worker = new Worker(source, options);
    const calls: string[] = [];
    const ref = worker.ref.bind(worker);
    const unref = worker.unref.bind(worker);
    worker.ref = () => {
      calls.push("ref");
      ref();
    };
    worker.unref = () => {
      calls.push("unref");
      unref();
    };
    created.push({ source, options, worker, calls });
    return worker;
  };
}

async function errorOf(work: () => Promise<unknown>): Promise<{ name: string; code: unknown; message: string }> {
  try {
    await work();
  } catch (error) {
    if (!(error instanceof Error)) return { name: typeof error, code: undefined, message: String(error) };
    return { name: error.name, code: "code" in error ? error.code : undefined, message: error.message };
  }
  throw new Error("expected a rejection");
}

let restore: (() => void) | null = null;

beforeEach(() => {
  takeScryptKdfStats();
});

afterEach(() => {
  restore?.();
  restore = null;
});

describe("FLC-6 switch and defaults", () => {
  it("is on by default and retires the worker after three faults in a row", () => {
    expect(SCRYPT_KDF_OFF_MAIN_THREAD).toBe(true);
    expect(SCRYPT_KDF_WORKER_MAX_CONSECUTIVE_FAILURES).toBe(3);
  });

  it("never creates a worker in plain Node by default (the caller is not blocked here)", async () => {
    const created: CreatedWorker[] = [];
    restore = configureScryptAsyncDeps({ createWorker: recordingFactory(created) });
    const salt = randomBytes(16);
    const key = await scryptAsync("pw", salt, 32, FAST);
    expect(key.equals(scryptSync("pw", salt, 32, FAST))).toBe(true);
    expect(created).toHaveLength(0);
    expect(takeScryptKdfStats()).toMatchObject({ derives: 1, offMainDerives: 0 });
  });

  it("OFF never creates a worker, even where the caller would be blocked", async () => {
    const created: CreatedWorker[] = [];
    restore = configureScryptAsyncDeps({
      offMainThread: false,
      callerThreadRunsFullKdf: true,
      createWorker: recordingFactory(created),
    });
    const salt = randomBytes(16);
    const key = await scryptAsync("pw", salt, 32, FAST);
    expect(Buffer.isBuffer(key)).toBe(true);
    expect(key.equals(scryptSync("pw", salt, 32, FAST))).toBe(true);
    expect(created).toHaveLength(0);
    expect(takeScryptKdfStats()).toMatchObject({ derives: 1, offMainDerives: 0 });
  });
});

describe("ON produces exactly the bytes OFF produces", () => {
  const cases: ReadonlyArray<{
    readonly label: string;
    readonly password: string;
    readonly salt: () => Uint8Array;
    readonly keylen: number;
    readonly options: ScryptOptions;
  }> = [
    { label: "vault parameters, N=2^17", password: "vault-password", salt: () => randomBytes(16), keylen: 32, options: VAULT },
    { label: "keystore salt length", password: "keystore-password", salt: () => randomBytes(32), keylen: 32, options: FAST },
    { label: "unicode password", password: "pässwörd ✓ 鍵", salt: () => randomBytes(16), keylen: 32, options: FAST },
    { label: "empty password", password: "", salt: () => randomBytes(16), keylen: 32, options: FAST },
    { label: "64-byte key", password: "pw", salt: () => randomBytes(16), keylen: 64, options: FAST },
    {
      label: "pooled Buffer view salt (vault base64 decode)",
      password: "pw",
      salt: () => Buffer.from(randomBytes(16).toString("base64"), "base64"),
      keylen: 32,
      options: FAST,
    },
    { label: "plain Uint8Array salt", password: "pw", salt: () => new Uint8Array(randomBytes(16)), keylen: 32, options: FAST },
    { label: "cost alias options", password: "pw", salt: () => randomBytes(16), keylen: 32, options: { cost: 2 ** 14, blockSize: 8, parallelization: 1, maxmem: MAXMEM } },
  ];

  it.each(cases)("$label", async ({ password, salt: makeSalt, keylen, options }) => {
    const salt = makeSalt();
    const offRestore = configureScryptAsyncDeps({ offMainThread: false, callerThreadRunsFullKdf: true });
    const off = await scryptAsync(password, salt, keylen, options);
    offRestore();

    const created: CreatedWorker[] = [];
    restore = configureScryptAsyncDeps({ callerThreadRunsFullKdf: true, createWorker: recordingFactory(created) });
    takeScryptKdfStats();
    const on = await scryptAsync(password, salt, keylen, options);

    expect(Buffer.isBuffer(on)).toBe(true);
    expect(on.length).toBe(keylen);
    expect(on.equals(off)).toBe(true);
    expect(on.equals(scryptSync(password, salt, keylen, options))).toBe(true);
    expect(created).toHaveLength(1);
    expect(takeScryptKdfStats()).toMatchObject({ derives: 1, offMainDerives: 1 });
  });

  it("serves many concurrent derives from one worker, each with its own bytes", async () => {
    const created: CreatedWorker[] = [];
    restore = configureScryptAsyncDeps({ callerThreadRunsFullKdf: true, createWorker: recordingFactory(created) });
    const inputs = Array.from({ length: 8 }, (_, i) => ({ password: `pw-${i}`, salt: randomBytes(16) }));
    const keys = await Promise.all(inputs.map(({ password, salt }) => scryptAsync(password, salt, 32, FAST)));
    keys.forEach((key, i) => {
      const input = inputs[i];
      expect(input).toBeDefined();
      if (input === undefined) return;
      expect(key.equals(scryptSync(input.password, input.salt, 32, FAST))).toBe(true);
    });
    expect(created).toHaveLength(1);
    expect(takeScryptKdfStats()).toMatchObject({ derives: 8, offMainDerives: 8 });
  });
});

describe("ON keeps today's errors", () => {
  const badParameters: ReadonlyArray<{ readonly label: string; readonly keylen: number; readonly options: ScryptOptions }> = [
    { label: "N not a power of two", keylen: 32, options: { N: 3, r: 8, p: 1, maxmem: MAXMEM } },
    { label: "N=2^17 without the raised memory ceiling", keylen: 32, options: { N: 2 ** 17, r: 8, p: 1 } },
    { label: "negative key length", keylen: -1, options: FAST },
  ];

  it.each(badParameters)("$label rejects exactly as OFF does", async ({ keylen, options }) => {
    const salt = randomBytes(16);
    const offRestore = configureScryptAsyncDeps({ offMainThread: false, callerThreadRunsFullKdf: true });
    const off = await errorOf(() => scryptAsync("pw", salt, keylen, options));
    offRestore();

    const created: CreatedWorker[] = [];
    restore = configureScryptAsyncDeps({ callerThreadRunsFullKdf: true, createWorker: recordingFactory(created) });
    takeScryptKdfStats();
    const on = await errorOf(() => scryptAsync("pw", salt, keylen, options));

    expect(on).toEqual(off);
    expect(off.message).not.toBe("");
    // The worker was asked and answered "no key"; today's path then produced
    // the error. Not a worker fault, so the worker stays in service.
    expect(takeScryptKdfStats()).toMatchObject({ derives: 1, offMainDerives: 0 });
    const salt2 = randomBytes(16);
    const next = await scryptAsync("pw", salt2, 32, FAST);
    expect(next.equals(scryptSync("pw", salt2, 32, FAST))).toBe(true);
    expect(created).toHaveLength(1);
  });
});

describe("every worker fault resolves through today's path", () => {
  it("a worker that cannot be created falls back, and three in a row retire it", async () => {
    let attempts = 0;
    restore = configureScryptAsyncDeps({
      callerThreadRunsFullKdf: true,
      createWorker: () => {
        attempts += 1;
        throw new Error("no worker here");
      },
    });
    for (let i = 0; i < SCRYPT_KDF_WORKER_MAX_CONSECUTIVE_FAILURES + 2; i += 1) {
      const salt = randomBytes(16);
      const key = await scryptAsync("pw", salt, 32, FAST);
      expect(key.equals(scryptSync("pw", salt, 32, FAST))).toBe(true);
    }
    expect(attempts).toBe(SCRYPT_KDF_WORKER_MAX_CONSECUTIVE_FAILURES);
    expect(takeScryptKdfStats()).toMatchObject({ derives: 5, offMainDerives: 0 });
  });

  it("a worker that exits before answering falls back with the right bytes", async () => {
    let attempts = 0;
    restore = configureScryptAsyncDeps({
      callerThreadRunsFullKdf: true,
      createWorker: (_source, options) => {
        attempts += 1;
        return new Worker("process.exit(0)", options);
      },
    });
    for (let i = 0; i < SCRYPT_KDF_WORKER_MAX_CONSECUTIVE_FAILURES + 1; i += 1) {
      const salt = randomBytes(16);
      const key = await scryptAsync("pw", salt, 32, FAST);
      expect(key.equals(scryptSync("pw", salt, 32, FAST))).toBe(true);
    }
    expect(attempts).toBe(SCRYPT_KDF_WORKER_MAX_CONSECUTIVE_FAILURES);
    expect(takeScryptKdfStats()).toMatchObject({ offMainDerives: 0 });
  });

  it("a worker that crashes falls back for every waiting derive", async () => {
    restore = configureScryptAsyncDeps({
      callerThreadRunsFullKdf: true,
      createWorker: (_source, options) => new Worker('throw new Error("crash")', options),
    });
    const inputs = Array.from({ length: 3 }, (_, i) => ({ password: `pw-${i}`, salt: randomBytes(16) }));
    const keys = await Promise.all(inputs.map(({ password, salt }) => scryptAsync(password, salt, 32, FAST)));
    keys.forEach((key, i) => {
      const input = inputs[i];
      expect(input).toBeDefined();
      if (input === undefined) return;
      expect(key.equals(scryptSync(input.password, input.salt, 32, FAST))).toBe(true);
    });
  });

  it("a worker terminated mid-derive falls back, and the next derive gets a fresh worker", async () => {
    const created: CreatedWorker[] = [];
    restore = configureScryptAsyncDeps({ callerThreadRunsFullKdf: true, createWorker: recordingFactory(created) });
    const salt = randomBytes(16);
    const pending = scryptAsync("pw", salt, 32, VAULT);
    const first = created[0];
    expect(first).toBeDefined();
    await first?.worker.terminate();
    const key = await pending;
    expect(key.equals(scryptSync("pw", salt, 32, VAULT))).toBe(true);
    expect(takeScryptKdfStats()).toMatchObject({ derives: 1, offMainDerives: 0 });

    const salt2 = randomBytes(16);
    const next = await scryptAsync("pw", salt2, 32, FAST);
    expect(next.equals(scryptSync("pw", salt2, 32, FAST))).toBe(true);
    expect(created).toHaveLength(2);
    expect(takeScryptKdfStats()).toMatchObject({ derives: 1, offMainDerives: 1 });
  });
});

describe("the worker's footprint", () => {
  it("starts with an empty env and no inherited exec flags, from inline source", async () => {
    const created: CreatedWorker[] = [];
    restore = configureScryptAsyncDeps({ callerThreadRunsFullKdf: true, createWorker: recordingFactory(created) });
    process.env.FLC6_SECRET_PROBE = "must-not-reach-the-worker";
    try {
      await scryptAsync("pw", randomBytes(16), 32, FAST);
    } finally {
      delete process.env.FLC6_SECRET_PROBE;
    }
    const only = created[0];
    expect(only).toBeDefined();
    expect(only?.options).toEqual({ eval: true, env: {}, execArgv: [] });
    expect(only?.source).toContain('require("node:crypto")');
    expect(only?.source).not.toContain("console");
  });

  it("is ref'd only while a derive is in flight", async () => {
    const created: CreatedWorker[] = [];
    restore = configureScryptAsyncDeps({ callerThreadRunsFullKdf: true, createWorker: recordingFactory(created) });
    await scryptAsync("pw", randomBytes(16), 32, FAST);
    await Promise.all([scryptAsync("a", randomBytes(16), 32, FAST), scryptAsync("b", randomBytes(16), 32, FAST)]);
    const only = created[0];
    expect(only).toBeDefined();
    // unref at start; ref/unref around the first derive; one ref/unref pair
    // around the two concurrent ones.
    expect(only?.calls).toEqual(["unref", "ref", "unref", "ref", "unref"]);
  });

  it("reports the calling-thread cost in numbers only and resets on take", async () => {
    restore = configureScryptAsyncDeps({ offMainThread: false, callerThreadRunsFullKdf: true });
    await scryptAsync("pw", randomBytes(16), 32, FAST);
    const stats = takeScryptKdfStats();
    expect(Object.keys(stats).sort()).toEqual(["callerBlockedMs", "derives", "offMainDerives"]);
    expect(stats.derives).toBe(1);
    expect(stats.callerBlockedMs).toBeGreaterThanOrEqual(0);
    expect(takeScryptKdfStats()).toEqual({ derives: 0, offMainDerives: 0, callerBlockedMs: 0 });
  });
});

describe("the real callers through the worker", () => {
  let dir = "";
  let filePath = "";

  beforeEach(() => {
    dir = join(tmpdir(), `vex-flc6-${Date.now()}-${Math.random()}`);
    mkdirSync(dir, { recursive: true });
    filePath = join(dir, "secrets.vault.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("the vault creates, writes, unlocks and still refuses a wrong password", async () => {
    restore = configureScryptAsyncDeps({ callerThreadRunsFullKdf: true });
    await createSecretVault("right-password", { filePath });
    await writeSecretVaultSecrets("right-password", { OPENROUTER_API_KEY: "sk-flc6" }, { filePath });
    const contents = await unlockSecretVault("right-password", { filePath });
    expect(contents.secrets.OPENROUTER_API_KEY).toBe("sk-flc6");

    const wrong = await unlockSecretVault("wrong-password", { filePath }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(wrong).toBeInstanceOf(LocalSecretVaultError);
    expect(wrong instanceof LocalSecretVaultError ? wrong.code : null).toBe("invalid_password");
    // create (1), write (unlock + encrypt, 2), unlock (1), wrong unlock (1):
    // every derive ran off the calling thread.
    expect(takeScryptKdfStats()).toMatchObject({ derives: 5, offMainDerives: 5 });
  });

  it("a vault written OFF opens ON and a vault written ON opens OFF", async () => {
    const offRestore = configureScryptAsyncDeps({ offMainThread: false, callerThreadRunsFullKdf: true });
    await writeSecretVaultSecrets("pw", { OPENROUTER_API_KEY: "written-off" }, { filePath });
    offRestore();

    restore = configureScryptAsyncDeps({ callerThreadRunsFullKdf: true });
    expect((await unlockSecretVault("pw", { filePath })).secrets.OPENROUTER_API_KEY).toBe("written-off");
    await writeSecretVaultSecrets("pw", { OPENROUTER_API_KEY: "written-on" }, { filePath });
    restore();
    restore = configureScryptAsyncDeps({ offMainThread: false, callerThreadRunsFullKdf: true });
    expect((await unlockSecretVault("pw", { filePath })).secrets.OPENROUTER_API_KEY).toBe("written-on");
  });

  it("the keystore round-trips a private key through the worker", async () => {
    restore = configureScryptAsyncDeps({ callerThreadRunsFullKdf: true });
    const pk = `0x${"ab".repeat(32)}`;
    const keystore = await encryptPrivateKey(pk, "keystore-password");
    await expect(decryptPrivateKey(keystore, "keystore-password")).resolves.toBe(pk);
    await expect(decryptPrivateKey(keystore, "wrong-password")).rejects.toThrow(
      "Decryption failed: wrong password or corrupted keystore",
    );
    expect(takeScryptKdfStats()).toMatchObject({ derives: 3, offMainDerives: 3 });
  });
});
