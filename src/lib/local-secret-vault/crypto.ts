import { createCipheriv, createDecipheriv, randomBytes, type DecipherGCM } from "node:crypto";
import { z } from "zod";
import { scryptAsync } from "../../utils/scrypt-async.js";
import { isVaultSecretKey, type VaultSecretKey } from "../secret-keys.js";
import type { VaultKeyCacheOperation } from "./derived-key-cache.js";
import { LocalSecretVaultError } from "./status.js";
import type { LocalSecretVaultContents } from "./status.js";

export const VAULT_VERSION = 1;
/**
 * Current scrypt KDF parameters used when encrypting new vaults or rewriting
 * existing ones. N=131072 (2^17), r=8, p=1 is the OWASP Password Storage
 * scrypt recommendation (~128 MiB working set, ~400ms unlock on commodity
 * hardware) — a deliberate security/UX trade-off favouring OWASP compliance
 * for an at-rest secret vault.
 *
 * Vault files carry their own `kdf` block so older files remain decryptable
 * with their original params; `unlockSecretVault` opportunistically rewrites
 * them with `CURRENT_KDF_PARAMS` on a successful decrypt.
 */
export const CURRENT_KDF_PARAMS = {
  name: "scrypt",
  N: 131072, // 2^17 — OWASP scrypt minimum
  r: 8,
  p: 1,
  dkLen: 32,
} as const;

const vaultFileSchema = z
  .object({
    version: z.literal(VAULT_VERSION),
    kdf: z
      .object({
        name: z.literal("scrypt"),
        N: z.number().int().positive(),
        r: z.number().int().positive(),
        p: z.number().int().positive(),
        dkLen: z.literal(32),
      })
      .strict(),
    salt: z.string().min(1),
    iv: z.string().min(1),
    tag: z.string().min(1),
    ciphertext: z.string().min(1),
  })
  .strict();

/**
 * Forward-compatible decrypted-contents schema.
 *
 * - `version` is any positive int (not a pinned literal) so `decryptContents`
 *   can tell "too new for this build" (`incompatible`) apart from "wrong
 *   password" — see the version check below.
 * - `secrets` accepts any string key so an unknown key written by a newer
 *   build does not fail a correct password; unrecognised keys are split into
 *   `extraSecrets` below and round-tripped on the next write.
 */
const vaultContentsSchema = z
  .object({
    version: z.number().int().positive(),
    secrets: z.record(z.string(), z.string().min(1)).default({}),
  })
  .strict();

export type VaultFile = z.infer<typeof vaultFileSchema>;

// ── Envelope validation (runs BEFORE any crypto) ────────────────────────────
//
// The vault file is untrusted on-disk input: a bit-flipped, truncated, or
// hand-edited file must never reach scrypt/AES-GCM and must never be
// reported as `invalid_password` (that advances the unlock throttle and can
// steer a user with a CORRECT password toward wiping their keystores).

const IV_BYTES = 12; // matches encryptContents's randomBytes(12)
const TAG_BYTES = 16; // GCM auth tag is always 16 bytes
const MIN_SALT_BYTES = 16; // matches encryptContents's randomBytes(16)
const MAX_SALT_BYTES = 64; // generous ceiling; anything past this is not a real vault
const MIN_CIPHERTEXT_BYTES = 1; // JSON.stringify(contents) is never empty
const MAX_CIPHERTEXT_BYTES = 10 * 1024 * 1024; // 10 MiB — a real vault holds small API secrets only

/**
 * A base64 string is "canonical" when it round-trips through Node's own
 * encoder byte-for-byte. `Buffer.from(str, "base64")` is lenient (it ignores
 * invalid characters and tolerates missing padding), so decoding alone cannot
 * distinguish a tampered/malformed field from a legitimately encoded one.
 * Re-encoding and comparing closes that gap.
 */
function isCanonicalBase64(value: string): boolean {
  if (value.length === 0 || value.length % 4 !== 0) return false;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;
  return Buffer.from(value, "base64").toString("base64") === value;
}

function decodeCanonicalBase64Field(value: string, field: string): Buffer {
  if (!isCanonicalBase64(value)) {
    throw new LocalSecretVaultError(
      `Secret vault field "${field}" is not valid base64.`,
      "corrupt",
    );
  }
  return Buffer.from(value, "base64");
}

interface VaultEnvelope {
  readonly salt: Buffer;
  readonly iv: Buffer;
  readonly tag: Buffer;
  readonly ciphertext: Buffer;
}

/**
 * Validate the envelope's binary fields BEFORE any crypto runs. Any failure
 * here is a structurally invalid file — always `corrupt`, never
 * `invalid_password` — because a wrong password can never explain a
 * malformed base64 string or a wrong-length iv/tag.
 */
function validateVaultEnvelope(file: VaultFile): VaultEnvelope {
  const salt = decodeCanonicalBase64Field(file.salt, "salt");
  const iv = decodeCanonicalBase64Field(file.iv, "iv");
  const tag = decodeCanonicalBase64Field(file.tag, "tag");
  const ciphertext = decodeCanonicalBase64Field(file.ciphertext, "ciphertext");

  if (iv.length !== IV_BYTES) {
    throw new LocalSecretVaultError(
      `Secret vault "iv" must decode to ${IV_BYTES} bytes.`,
      "corrupt",
    );
  }
  if (tag.length !== TAG_BYTES) {
    throw new LocalSecretVaultError(
      `Secret vault "tag" must decode to ${TAG_BYTES} bytes.`,
      "corrupt",
    );
  }
  if (salt.length < MIN_SALT_BYTES || salt.length > MAX_SALT_BYTES) {
    throw new LocalSecretVaultError('Secret vault "salt" length is out of bounds.', "corrupt");
  }
  if (ciphertext.length < MIN_CIPHERTEXT_BYTES || ciphertext.length > MAX_CIPHERTEXT_BYTES) {
    throw new LocalSecretVaultError(
      'Secret vault "ciphertext" length is out of bounds.',
      "corrupt",
    );
  }

  return { salt, iv, tag, ciphertext };
}

// ── KDF bounds validation (runs BEFORE the scrypt derivation) ───────────────
//
// Historically emitted/supported scrypt profiles for this vault (see git log
// on this file): N=2^16 (65536, the original CURRENT_KDF_PARAMS) and N=2^17
// (131072, current since the F10-OWASP bump); the KDF-upgrade test fixture
// additionally exercises N=2^14 (16384) as an older still-decryptable
// profile. r=8 and p=1 have never varied. A `kdf` block outside this envelope
// did not come from a real Vex build — treat it as `corrupt`, not a password
// guess, and reject before paying for a scrypt derive (a corrupt
// N that still passes Node's own memory ceiling would otherwise run to
// completion, or throw and get mislabeled `invalid_password`).
const MIN_SUPPORTED_KDF_N = 2 ** 14;
const MAX_SUPPORTED_KDF_N = 2 ** 17;
const SUPPORTED_KDF_R = 8;
const SUPPORTED_KDF_P = 1;
const SUPPORTED_KDF_DKLEN = 32;
// Mirrors deriveKey's own maxmem ceiling so an out-of-range N/r combination
// can never reach scrypt even if a future edit raises MAX_SUPPORTED_KDF_N
// without also raising maxmem.
const KDF_MAXMEM_BYTES = 256 * 1024 * 1024;

function isPowerOfTwo(value: number): boolean {
  return Number.isInteger(value) && value > 0 && (value & (value - 1)) === 0;
}

function validateKdfParamsBounds(kdf: VaultFile["kdf"]): void {
  if (!isPowerOfTwo(kdf.N) || kdf.N < MIN_SUPPORTED_KDF_N || kdf.N > MAX_SUPPORTED_KDF_N) {
    throw new LocalSecretVaultError('Secret vault KDF parameter "N" is out of bounds.', "corrupt");
  }
  if (kdf.r !== SUPPORTED_KDF_R) {
    throw new LocalSecretVaultError('Secret vault KDF parameter "r" is out of bounds.', "corrupt");
  }
  if (kdf.p !== SUPPORTED_KDF_P) {
    throw new LocalSecretVaultError('Secret vault KDF parameter "p" is out of bounds.', "corrupt");
  }
  if (kdf.dkLen !== SUPPORTED_KDF_DKLEN) {
    throw new LocalSecretVaultError(
      'Secret vault KDF parameter "dkLen" is out of bounds.',
      "corrupt",
    );
  }
  if (KDF_MAXMEM_BYTES < 128 * kdf.N * kdf.r) {
    throw new LocalSecretVaultError(
      "Secret vault KDF memory requirement exceeds the safety ceiling.",
      "corrupt",
    );
  }
}

export async function deriveKey(
  password: string,
  salt: Buffer,
  params: VaultFile["kdf"],
): Promise<Buffer> {
  // Node's scrypt enforces a soft memory cap of 32 MiB by default; once N
  // exceeds 2^15 (with r=8, p=1) the buffer requirement passes that cap and
  // the call fails with `digital envelope routines::memory limit exceeded`.
  // Raise the ceiling to 256 MiB — our target N=2^17 needs ~128 MiB
  // (128*N*r), so this leaves headroom while staying reasonable for a desktop
  // unlock. (N=2^18 would sit at the ceiling and Node rejects it, so do not
  // raise N past 2^17 without also raising maxmem.)
  const maxmem = KDF_MAXMEM_BYTES;
  // Async (libuv threadpool) so the derive never blocks the main thread.
  return scryptAsync(password, salt, params.dkLen, {
    N: params.N,
    r: params.r,
    p: params.p,
    maxmem,
  });
}

export function emptyContents(): LocalSecretVaultContents {
  return { version: VAULT_VERSION, secrets: {} };
}

export function parseVaultFile(raw: string): VaultFile {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch (cause) {
    throw new LocalSecretVaultError("Secret vault file is corrupt.", "corrupt", cause);
  }
  // Outer-version gate BEFORE the strict shape parse: a vault written by a
  // newer build may change the envelope shape entirely (fields, KDF family),
  // so a too-new outer version must classify as `incompatible` — never as
  // `corrupt` via a strict-schema mismatch it was always going to fail.
  if (
    typeof parsedJson === "object" && parsedJson !== null &&
    "version" in parsedJson && typeof (parsedJson as { version: unknown }).version === "number" &&
    Number.isInteger((parsedJson as { version: number }).version) &&
    (parsedJson as { version: number }).version > VAULT_VERSION
  ) {
    throw new LocalSecretVaultError(
      "This vault was created by a newer version of Vex. Update Vex to open it.",
      "incompatible",
    );
  }
  try {
    return vaultFileSchema.parse(parsedJson);
  } catch (cause) {
    throw new LocalSecretVaultError("Secret vault file is corrupt.", "corrupt", cause);
  }
}

export async function encryptContents(
  contents: LocalSecretVaultContents,
  password: string,
): Promise<VaultFile> {
  return (await encryptContentsKeepingKey(contents, password)).file;
}

/**
 * `encryptContents`, also returning the key it derived for the fresh salt so a
 * cached write can keep it for the next read (`VAULT_DERIVED_KEY_CACHE`).
 */
export async function encryptContentsKeepingKey(
  contents: LocalSecretVaultContents,
  password: string,
): Promise<{ readonly file: VaultFile; readonly salt: Buffer; readonly key: Buffer }> {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = await deriveKey(password, salt, CURRENT_KDF_PARAMS);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  // Merge known + extra secrets into one on-disk map so keys this build does
  // not recognize (written by a newer build) survive a downgrade -> unlock ->
  // re-encrypt cycle instead of being silently dropped.
  const secretsOnDisk: Record<string, string> = { ...contents.secrets };
  if (contents.extraSecrets) {
    for (const [key, value] of Object.entries(contents.extraSecrets)) {
      if (!isVaultSecretKey(key)) secretsOnDisk[key] = value;
    }
  }
  const plaintext = Buffer.from(
    JSON.stringify({ version: VAULT_VERSION, secrets: secretsOnDisk }),
    "utf8",
  );
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    file: {
      version: VAULT_VERSION,
      kdf: CURRENT_KDF_PARAMS,
      salt: salt.toString("base64"),
      iv: iv.toString("base64"),
      tag: tag.toString("base64"),
      ciphertext: ciphertext.toString("base64"),
    },
    salt,
    key,
  };
}

export function vaultFileNeedsKdfUpgrade(file: VaultFile): boolean {
  return (
    file.kdf.N !== CURRENT_KDF_PARAMS.N ||
    file.kdf.r !== CURRENT_KDF_PARAMS.r ||
    file.kdf.p !== CURRENT_KDF_PARAMS.p ||
    file.kdf.dkLen !== CURRENT_KDF_PARAMS.dkLen
  );
}

/**
 * Decrypt a parsed vault file.
 *
 * `keyCache` is the opt-in `VAULT_DERIVED_KEY_CACHE` path, passed ONLY by an
 * unlocked-session read that uses the session's own held password. Without
 * it (every unlock attempt, password verification and vault creation) the key
 * is derived from scratch, exactly as before the cache existed.
 */
export async function decryptContents(
  file: VaultFile,
  password: string,
  keyCache?: VaultKeyCacheOperation,
): Promise<LocalSecretVaultContents> {
  // Phase 0: envelope + KDF-bounds validation. Both run BEFORE any crypto, so
  // a structurally invalid or out-of-bounds file is always `corrupt` and
  // never pays for (or is mislabeled by) a scrypt derivation.
  const envelope = validateVaultEnvelope(file);
  validateKdfParamsBounds(file.kdf);

  if (keyCache === undefined) {
    return decryptEnvelope(envelope, () => deriveKey(password, envelope.salt, file.kdf), false);
  }
  return decryptEnvelopeWithKeyCache(envelope, file.kdf, password, keyCache);
}

/**
 * The cached read. A hit skips the derive but still runs the full GCM
 * authentication below. A cached key that fails the tag (the file was
 * replaced or tampered under the same salt) is dropped and the read derives
 * ONCE from scratch, so it ends exactly where the uncached read would. Only
 * a key that has just opened this file (tag and contents both accepted) is
 * stored, and never after the cache was cleared.
 */
async function decryptEnvelopeWithKeyCache(
  envelope: VaultEnvelope,
  params: VaultFile["kdf"],
  password: string,
  op: VaultKeyCacheOperation,
): Promise<LocalSecretVaultContents> {
  const cached = op.current
    ? op.cache.lookup(op.filePath, envelope.salt, params, password)
    : null;
  if (cached === null) {
    op.cacheMiss += 1;
  } else {
    op.cacheHit += 1;
    try {
      return await decryptEnvelope(envelope, () => Promise.resolve(cached), true);
    } catch (error) {
      if (!(error instanceof LocalSecretVaultError) || error.code !== "invalid_password") {
        throw error;
      }
      op.cache.drop(op.filePath);
      op.tagRetry += 1;
    }
  }

  const derived: { key: Buffer | null } = { key: null };
  try {
    const contents = await decryptEnvelope(
      envelope,
      async () => {
        derived.key = await deriveForCachedOperation(op, envelope.salt, params, password);
        return derived.key;
      },
      false,
    );
    if (derived.key !== null && op.current) {
      op.cache.store(op.filePath, envelope.salt, params, password, derived.key, op.generation);
    }
    return contents;
  } finally {
    derived.key?.fill(0);
  }
}

async function deriveForCachedOperation(
  op: VaultKeyCacheOperation,
  salt: Buffer,
  params: VaultFile["kdf"],
  password: string,
): Promise<Buffer> {
  const started = performance.now();
  try {
    if (!op.current) {
      op.derives += 1;
      return await deriveKey(password, salt, params);
    }
    const result = await op.cache.derive(op.filePath, salt, params, password, () =>
      deriveKey(password, salt, params),
    );
    if (result.started) op.derives += 1;
    return result.key;
  } finally {
    op.deriveMs += performance.now() - started;
  }
}

async function decryptEnvelope(
  envelope: VaultEnvelope,
  obtainKey: () => Promise<Buffer>,
  wipeKeyAfterSetup: boolean,
): Promise<LocalSecretVaultContents> {
  // Phase 1a: key derivation + decipher setup + ciphertext pass. NONE of
  // this authenticates the password — scrypt derives bytes from whatever
  // password it was given, and GCM's update() decrypts without verifying.
  // A failure here (allocation pressure, crypto-runtime error) with a
  // CORRECT password must therefore never read as a wrong password or
  // advance the unlock throttle: it maps to `unavailable` (retryable — the
  // vault file itself may be perfectly intact).
  let pending: Buffer;
  let decipherFinal: () => Buffer;
  try {
    const key = await obtainKey();
    let decipher: DecipherGCM;
    try {
      decipher = createDecipheriv("aes-256-gcm", key, envelope.iv);
    } finally {
      // The cipher holds its own copy of the key once it is set up.
      if (wipeKeyAfterSetup) key.fill(0);
    }
    decipher.setAuthTag(envelope.tag);
    pending = decipher.update(envelope.ciphertext);
    decipherFinal = () => decipher.final();
  } catch (cause) {
    throw new LocalSecretVaultError(
      "Secret vault could not be read (cryptographic runtime failure).",
      "unavailable",
      cause,
    );
  }

  // Phase 1b: the ONE password-authentication point. GCM authenticates at
  // final(): a tag mismatch here is the only signal that the password (or
  // the ciphertext integrity it proves) is wrong. ONLY this catch may yield
  // `invalid_password`; the unlock throttle must advance on nothing else —
  // even the concat/decode below sits OUTSIDE it, so an allocation failure
  // after successful authentication cannot masquerade as a wrong password.
  let finalBlock: Buffer;
  try {
    finalBlock = decipherFinal();
  } catch (cause) {
    throw new LocalSecretVaultError(
      "Secret vault could not be unlocked.",
      "invalid_password",
      cause,
    );
  }
  let plaintext: string;
  try {
    plaintext = Buffer.concat([pending, finalBlock]).toString("utf8");
  } catch (cause) {
    throw new LocalSecretVaultError(
      "Secret vault could not be read (post-authentication runtime failure).",
      "unavailable",
      cause,
    );
  }

  // Phase 2: content parsing. The GCM auth tag already verified — the
  // password is PROVEN correct. JSON/schema failures from here on are
  // data/compatibility problems and must never be reported as
  // `invalid_password`.
  let parsed: z.infer<typeof vaultContentsSchema>;
  try {
    parsed = vaultContentsSchema.parse(JSON.parse(plaintext));
  } catch (cause) {
    throw new LocalSecretVaultError(
      "Secret vault contents are unreadable after decryption.",
      "corrupt",
      cause,
    );
  }

  if (parsed.version > VAULT_VERSION) {
    throw new LocalSecretVaultError(
      "This vault was created by a newer version of Vex. Update Vex to open it.",
      "incompatible",
    );
  }

  const secrets: Partial<Record<VaultSecretKey, string>> = {};
  const extraSecrets: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed.secrets)) {
    if (isVaultSecretKey(key)) secrets[key] = value;
    else extraSecrets[key] = value;
  }

  return {
    version: VAULT_VERSION,
    secrets,
    ...(Object.keys(extraSecrets).length > 0 ? { extraSecrets } : {}),
  };
}
