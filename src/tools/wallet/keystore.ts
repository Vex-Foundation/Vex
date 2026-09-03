import { randomBytes, scryptSync, createCipheriv, createDecipheriv } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync, chmodSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Hex } from "viem";
import { KEYSTORE_FILE } from "../../config/paths.js";
import { ensureConfigDir } from "../../config/store.js";
import { VexError, ErrorCodes } from "../../errors.js";
import { minLogger as logger } from "../../utils/logger-shim.js";

export interface KeystoreV1 {
  version: 1;
  ciphertext: string; // base64
  iv: string; // base64, 12 bytes
  salt: string; // base64, 32 bytes
  tag: string; // base64, 16 bytes (GCM auth tag)
  kdf: {
    name: "scrypt";
    N: number;
    r: number;
    p: number;
    dkLen: number;
  };
}

const KDF_PARAMS = {
  name: "scrypt" as const,
  N: 2 ** 17, // 131072 — OWASP scrypt minimum, vault parity (src/lib/local-secret-vault.ts).
  // Bumped from 2^16 to 2^17 in lockstep with the vault (F10-OWASP). ~128 MiB working set,
  // ~400ms per derive — a deliberate security/UX trade-off for at-rest key material.
  r: 8,
  p: 1,
  dkLen: 32,
};

function deriveKey(password: string, salt: Uint8Array, dkLen: number, params = KDF_PARAMS): Buffer {
  // Node's scrypt enforces a soft memory cap of 32 MiB by default; once N exceeds
  // 2^15 (with r=8, p=1) the buffer requirement (128*N*r bytes) passes that cap and
  // the call fails with `memory limit exceeded`. Raise the ceiling to 256 MiB — our
  // target N=2^17 needs ~128 MiB, so this leaves headroom while staying reasonable for
  // a desktop unlock. (N=2^18 sits at the ceiling and Node rejects it with
  // ERR_CRYPTO_INVALID_SCRYPT_PARAMS, so do not raise N past 2^17 without also raising
  // maxmem.) Mirrors local-secret-vault.ts deriveKey. Applied in this shared helper so it
  // covers encrypt AND decrypt; decrypt passes the file's own `kdf` params, so keystores
  // written at any supported N still open.
  const maxmem = 256 * 1024 * 1024;
  return scryptSync(password, salt, dkLen, {
    N: params.N,
    r: params.r,
    p: params.p,
    maxmem,
  });
}

export function normalizePrivateKey(pk: string): Hex {
  // Remove 0x prefix if present
  const cleaned = pk.startsWith("0x") ? pk.slice(2) : pk;

  // Validate hex format and length (32 bytes = 64 hex chars)
  if (!/^[0-9a-fA-F]{64}$/.test(cleaned)) {
    throw new Error("Invalid private key: must be 32 bytes hex");
  }

  return `0x${cleaned.toLowerCase()}` as Hex;
}

export function encryptPrivateKey(plainPk: string, password: string): KeystoreV1 {
  const normalizedPk = normalizePrivateKey(plainPk);
  return encryptSecretBytes(Buffer.from(normalizedPk.slice(2), "hex"), password);
}

export function encryptSecretBytes(secret: Uint8Array, password: string): KeystoreV1 {
  const secretBuffer = Buffer.from(secret);

  // Generate random salt and IV
  const salt = randomBytes(32);
  const iv = randomBytes(12); // 96 bits for GCM

  // Derive key using scrypt
  const key = deriveKey(password, salt, KDF_PARAMS.dkLen);

  // Encrypt with AES-256-GCM
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(secretBuffer), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    version: 1,
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    salt: salt.toString("base64"),
    tag: tag.toString("base64"),
    kdf: KDF_PARAMS,
  };
}

export function decryptPrivateKey(keystore: KeystoreV1, password: string): Hex {
  const decrypted = decryptSecretBytes(keystore, password);
  return `0x${Buffer.from(decrypted).toString("hex")}` as Hex;
}

export function decryptSecretBytes(keystore: KeystoreV1, password: string): Uint8Array {
  if (keystore.version !== 1) {
    throw new Error(`Unsupported keystore version: ${keystore.version}`);
  }

  const salt = Buffer.from(keystore.salt, "base64");
  const iv = Buffer.from(keystore.iv, "base64");
  const ciphertext = Buffer.from(keystore.ciphertext, "base64");
  const tag = Buffer.from(keystore.tag, "base64");

  // Derive key using scrypt
  const key = deriveKey(password, salt, keystore.kdf.dkLen, keystore.kdf);

  // Decrypt with AES-256-GCM
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);

  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch (err) {
    throw new VexError(ErrorCodes.KEYSTORE_DECRYPT_FAILED, "Decryption failed: wrong password or corrupted keystore");
  }
}

export function saveKeystore(keystore: KeystoreV1): void {
  saveKeystoreFile(KEYSTORE_FILE, keystore);
}

export function loadKeystore(): KeystoreV1 | null {
  return loadKeystoreFile(KEYSTORE_FILE);
}

export function keystoreExists(): boolean {
  return keystoreFileExists(KEYSTORE_FILE);
}

/**
 * THE KEYSTORE RENAME CONTENTION POLICY (rule 04's explicit shape).
 *
 * ELIGIBLE FAILURE CLASSES: `EPERM`, `EACCES`, `EBUSY` from `renameSync` alone.
 * ATTEMPTS: the first plus at most three retries. BACKOFF: 20ms, 45ms, 90ms,
 * jittered by +/-25%, so under 200ms of added latency in the worst case.
 * IDEMPOTENCY: repeating `rename(temp, target)` is safe - the failure means it
 * did not happen, and the temp file is still exactly the bytes we wrote.
 * AFTER EXHAUSTION: a NAMED `KEYSTORE_WRITE_LOCKED` refusal, never another
 * attempt. The existing keystore is untouched, so nothing was lost.
 *
 * WHY IT IS NEEDED AT ALL: on Windows a keystore file that another process has
 * open without `FILE_SHARE_DELETE` cannot be renamed over, and the processes
 * that open a file in the Vex config directory are backup agents, file-syncing
 * clients and antivirus scanners - all of which let go within milliseconds. A
 * single attempt turns that into a failed wallet import the user cannot act on.
 *
 * WHY THE SLEEP IS `Atomics.wait`: this function is SYNCHRONOUS by contract
 * (every keystore caller is), so there is no event loop to yield to. `Atomics.
 * wait` blocks the thread for a bounded interval without the CPU burn of a spin
 * loop. The total block is under 200ms and only on a path that is already
 * failing.
 */
const KEYSTORE_RENAME_RETRY_DELAYS_MS: readonly number[] = [20, 45, 90];

function isRenameContention(cause: unknown): boolean {
  if (typeof cause !== "object" || cause === null) return false;
  const code = (cause as { code?: unknown }).code;
  return code === "EPERM" || code === "EACCES" || code === "EBUSY";
}

/** Bounded synchronous sleep. See the policy note above for why it is sync. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function renameWithContentionRetry(tmpFile: string, path: string): void {
  for (let attempt = 0; attempt <= KEYSTORE_RENAME_RETRY_DELAYS_MS.length; attempt++) {
    try {
      renameSync(tmpFile, path);
      return;
    } catch (cause) {
      if (!isRenameContention(cause)) throw cause;
      const wait = KEYSTORE_RENAME_RETRY_DELAYS_MS[attempt];
      if (wait === undefined) {
        throw new VexError(
          ErrorCodes.KEYSTORE_WRITE_LOCKED,
          "The keystore file could not be replaced: another program is holding it open, or the "
            + "Vex config folder is not writable. Your existing keystore was NOT changed.",
          "Close anything that may have the file open (a backup or file-syncing client, an "
            + "antivirus scanner, an editor, or another Vex window), then try again.",
        );
      }
      sleepSync(Math.round(wait * (0.75 + Math.random() * 0.5)));
    }
  }
}

export function saveKeystoreFile(path: string, keystore: KeystoreV1): void {
  ensureConfigDir();

  const dir = dirname(path);
  const baseName = basename(path).replace(/\.json$/, "");
  const tmpFile = join(dir, `.${baseName}.tmp.${Date.now()}.json`);

  try {
    writeFileSync(tmpFile, JSON.stringify(keystore, null, 2), "utf-8");
    if (process.platform !== "win32") {
      try { chmodSync(tmpFile, 0o600); } catch { /* non-fatal on platforms without POSIX perms */ }
    }
    renameWithContentionRetry(tmpFile, path);
    logger.debug(`Keystore saved to ${path}`);
  } catch (err) {
    try {
      if (existsSync(tmpFile)) {
        unlinkSync(tmpFile);
      }
    } catch {
      // Ignore cleanup errors
    }
    throw err;
  }
}

function validateKeystoreShape(parsed: unknown, path: string): KeystoreV1 {
  if (parsed === null || typeof parsed !== "object") {
    throw new VexError(ErrorCodes.KEYSTORE_CORRUPT, `Keystore at ${path} is not a valid JSON object.`);
  }

  const obj = parsed as Record<string, unknown>;
  const requiredFields: Array<[string, string]> = [
    ["version", "number"],
    ["salt", "string"],
    ["iv", "string"],
    ["tag", "string"],
    ["ciphertext", "string"],
  ];

  for (const [field, expectedType] of requiredFields) {
    if (!(field in obj) || typeof obj[field] !== expectedType) {
      throw new VexError(
        ErrorCodes.KEYSTORE_CORRUPT,
        `Keystore at ${path} is missing or has invalid field "${field}".`,
        "Re-import your private key or restore from backup.",
      );
    }
  }

  return parsed as KeystoreV1;
}

export function loadKeystoreFile(path: string): KeystoreV1 | null {
  if (!existsSync(path)) {
    return null;
  }

  let parsed: unknown;
  try {
    const raw = readFileSync(path, "utf-8");
    parsed = JSON.parse(raw);
  } catch (err) {
    logger.error(`Failed to parse keystore ${path}: ${err}`);
    throw new VexError(
      ErrorCodes.KEYSTORE_CORRUPT,
      `Keystore at ${path} contains invalid JSON.`,
      "Re-import your private key or restore from backup.",
    );
  }

  return validateKeystoreShape(parsed, path);
}

export function keystoreFileExists(path: string): boolean {
  return existsSync(path);
}
