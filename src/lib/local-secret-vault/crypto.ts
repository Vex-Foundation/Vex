import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { z } from "zod";
import { VAULT_SECRET_KEYS } from "../secret-keys.js";
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
 * Forward-compatible contents schema.
 *
 * - `version` is a positive int (not a pinned literal) so we can distinguish
 *   "too new" (`incompatible`) from "wrong password".
 * - `secrets` accepts any string keys so a newer build's unknown keys do not
 *   reject a correct password. Known keys are projected into `secrets`; the
 *   rest land in `extraSecrets` for round-trip.
 * - Extra top-level fields are ignored (not `.strict()`) so minor envelope
 *   growth from newer builds does not brick unlock.
 */
const vaultContentsSchema = z.object({
  version: z.number().int().positive(),
  secrets: z.record(z.string(), z.string().min(1)).default({}),
});

const KNOWN_SECRET_KEY_SET = new Set<string>(VAULT_SECRET_KEYS);

export type VaultFile = z.infer<typeof vaultFileSchema>;

export function deriveKey(password: string, salt: Buffer, params: VaultFile["kdf"]): Buffer {
  // Node's scrypt enforces a soft memory cap of 32 MiB by default; once N
  // exceeds 2^15 (with r=8, p=1) the buffer requirement passes that cap and
  // the call fails with `digital envelope routines::memory limit exceeded`.
  // Raise the ceiling to 256 MiB — our target N=2^17 needs ~128 MiB
  // (128*N*r), so this leaves headroom while staying reasonable for a desktop
  // unlock. (N=2^18 would sit at the ceiling and Node rejects it, so do not
  // raise N past 2^17 without also raising maxmem.)
  const maxmem = 256 * 1024 * 1024;
  return scryptSync(password, salt, params.dkLen, {
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
  try {
    return vaultFileSchema.parse(JSON.parse(raw));
  } catch (cause) {
    throw new LocalSecretVaultError("Secret vault file is corrupt.", "corrupt", cause);
  }
}

export function encryptContents(
  contents: LocalSecretVaultContents,
  password: string,
): VaultFile {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = deriveKey(password, salt, CURRENT_KDF_PARAMS);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  // Merge known + extra secrets into one on-disk map so unknown keys from a
  // newer build survive a downgrade → unlock → re-encrypt cycle.
  const secretsOnDisk: Record<string, string> = { ...contents.secrets };
  if (contents.extraSecrets) {
    for (const [k, v] of Object.entries(contents.extraSecrets)) {
      if (!KNOWN_SECRET_KEY_SET.has(k) && typeof v === "string" && v.length > 0) {
        secretsOnDisk[k] = v;
      }
    }
  }
  const plaintext = Buffer.from(
    JSON.stringify({ version: VAULT_VERSION, secrets: secretsOnDisk }),
    "utf8",
  );
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    version: VAULT_VERSION,
    kdf: CURRENT_KDF_PARAMS,
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
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

export function decryptContents(file: VaultFile, password: string): LocalSecretVaultContents {
  // ── Phase 1: cryptography. A failure here — wrong scrypt key or a failed
  //    AES-GCM auth-tag check — means the password is wrong (or the ciphertext
  //    was tampered with, which is indistinguishable). ONLY this phase may
  //    yield `invalid_password`. Never advance unlock throttle on later phases.
  let plaintext: string;
  try {
    const salt = Buffer.from(file.salt, "base64");
    const iv = Buffer.from(file.iv, "base64");
    const tag = Buffer.from(file.tag, "base64");
    const ciphertext = Buffer.from(file.ciphertext, "base64");
    const key = deriveKey(password, salt, file.kdf);
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    plaintext = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString("utf8");
  } catch (cause) {
    throw new LocalSecretVaultError(
      "Secret vault could not be unlocked.",
      "invalid_password",
      cause,
    );
  }

  // ── Phase 2: content parsing. GCM auth tag already verified → password is
  //    PROVEN correct. JSON/schema/version failures are data/compatibility
  //    problems and MUST NEVER be reported as `invalid_password` (F-03).
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
  if (parsed.version < 1) {
    throw new LocalSecretVaultError(
      "Secret vault contents are unreadable after decryption.",
      "corrupt",
    );
  }

  const secrets: Partial<Record<(typeof VAULT_SECRET_KEYS)[number], string>> = {};
  const extraSecrets: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed.secrets)) {
    if (KNOWN_SECRET_KEY_SET.has(key)) {
      secrets[key as (typeof VAULT_SECRET_KEYS)[number]] = value;
    } else {
      extraSecrets[key] = value;
    }
  }

  return {
    version: VAULT_VERSION,
    secrets,
    ...(Object.keys(extraSecrets).length > 0 ? { extraSecrets } : {}),
  };
}
