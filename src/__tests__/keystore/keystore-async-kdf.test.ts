/**
 * The keystore KDF runs OFF the calling thread.
 *
 * Every EVM/Solana signature decrypts the keystore with scrypt N=2^17 (~128 MiB,
 * hundreds of ms). In the desktop app that call happens on the Electron main
 * process, which also hosts the agent engine and every IPC handler, so a
 * synchronous derive froze the whole app for its duration. These tests pin the
 * fix: while a derive is in flight, timers keep firing; and the async derive
 * produces exactly the bytes the synchronous one did, so every keystore written
 * before the change (at any supported N) still opens.
 */
import { createCipheriv, randomBytes, scryptSync } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  decryptPrivateKey,
  decryptSecretBytes,
  encryptPrivateKey,
  type KeystoreV1,
} from "@tools/wallet/keystore.js";
import { scryptAsync } from "../../utils/scrypt-async.js";

const PK = "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const PASSWORD = "event-loop-password";
const MAXMEM = 256 * 1024 * 1024;

/**
 * Count timer callbacks that run while `work` is pending. A synchronous derive
 * holds the thread from the moment `work()` is called until its promise
 * settles, so no timer can fire in between and the count stays 0.
 */
async function timerTicksDuring<T>(work: () => Promise<T>): Promise<{ value: T; ticks: number }> {
  let ticks = 0;
  let running = true;
  let handle: NodeJS.Timeout | null = null;
  const tick = (): void => {
    if (!running) return;
    ticks += 1;
    handle = setTimeout(tick, 1);
  };
  handle = setTimeout(tick, 1);
  try {
    const value = await work();
    return { value, ticks };
  } finally {
    running = false;
    if (handle !== null) clearTimeout(handle);
  }
}

function forgeKeystoreAtN(pk: string, password: string, n: number): KeystoreV1 {
  const keyBytes = Buffer.from(pk.slice(2), "hex");
  const salt = randomBytes(32);
  const iv = randomBytes(12);
  const kdf = { name: "scrypt" as const, N: n, r: 8, p: 1, dkLen: 32 };
  // Written with the SYNCHRONOUS KDF on purpose: this is what every keystore on
  // disk before the async change was produced by.
  const derived = scryptSync(password, salt, kdf.dkLen, { N: kdf.N, r: kdf.r, p: kdf.p, maxmem: MAXMEM });
  const cipher = createCipheriv("aes-256-gcm", derived, iv);
  const ciphertext = Buffer.concat([cipher.update(keyBytes), cipher.final()]);
  return {
    version: 1,
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    salt: salt.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    kdf,
  };
}

describe("keystore KDF does not block the event loop", () => {
  it("keeps firing timers while encryptPrivateKey derives at N=2^17", async () => {
    const { value: keystore, ticks } = await timerTicksDuring(() => encryptPrivateKey(PK, PASSWORD));
    expect(keystore.kdf.N).toBe(2 ** 17);
    expect(ticks).toBeGreaterThan(0);
  });

  it("keeps firing timers while decryptPrivateKey derives at N=2^17", async () => {
    const keystore = await encryptPrivateKey(PK, PASSWORD);
    const { value: decrypted, ticks } = await timerTicksDuring(() => decryptPrivateKey(keystore, PASSWORD));
    expect(decrypted).toBe(PK);
    expect(ticks).toBeGreaterThan(0);
  });
});

describe("async KDF is the same computation as the synchronous one", () => {
  it.each([2 ** 14, 2 ** 16, 2 ** 17])("scryptAsync matches scryptSync byte for byte at N=%i", async (n) => {
    const salt = randomBytes(32);
    const options = { N: n, r: 8, p: 1, maxmem: MAXMEM };
    const expected = scryptSync(PASSWORD, salt, 32, options);
    const actual = await scryptAsync(PASSWORD, salt, 32, options);
    expect(actual.equals(expected)).toBe(true);
  });

  it.each([2 ** 14, 2 ** 16, 2 ** 17])("opens a keystore written by the sync KDF at N=%i", async (n) => {
    const keystore = forgeKeystoreAtN(PK, PASSWORD, n);
    await expect(decryptPrivateKey(keystore, PASSWORD)).resolves.toBe(PK);
  });

  it("rejects (never throws synchronously) on a wrong password with the same error", async () => {
    const keystore = forgeKeystoreAtN(PK, PASSWORD, 2 ** 14);
    let syncThrow: unknown = null;
    let pending: Promise<Uint8Array> | null = null;
    try {
      pending = decryptSecretBytes(keystore, "wrong-password");
    } catch (err) {
      syncThrow = err;
    }
    expect(syncThrow).toBeNull();
    await expect(pending).rejects.toThrow("Decryption failed: wrong password or corrupted keystore");
  });

  it("rejects with the scrypt parameter error that scryptSync would throw", async () => {
    const salt = randomBytes(32);
    const bad = { N: 3, r: 8, p: 1, maxmem: MAXMEM };
    let syncMessage = "";
    try {
      scryptSync(PASSWORD, salt, 32, bad);
    } catch (err) {
      syncMessage = err instanceof Error ? err.message : String(err);
    }
    expect(syncMessage).not.toBe("");
    await expect(scryptAsync(PASSWORD, salt, 32, bad)).rejects.toThrow(syncMessage);
  });
});
