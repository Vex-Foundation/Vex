/**
 * The local Postgres password, shared by every runtime provider.
 *
 * One secret per install, at `CONFIG_DIR/local-infra/secrets/pg_password`:
 * the compose stack mounts it as `POSTGRES_PASSWORD_FILE`, and the native
 * runtime hands it to `initdb --pwfile` and to `db-config.ts`. It lives here,
 * not with the compose renderer, because the native runtime must create and
 * read it with no container runtime installed at all.
 *
 * No Electron import here, so the compose renderer and tests stay pure;
 * production callers take their deps from `production-deps.ts`.
 */

import { randomBytes, randomUUID } from "node:crypto";
import path from "node:path";

export interface SecretAdapter {
  /** Returns the absolute path of the readable secret file. */
  readonly write: (
    targetPath: string,
    value: string
  ) => Promise<{ composePath: string }>;
  /** Reads back the (decrypted, if applicable) secret value. */
  readonly read: (targetPath: string) => Promise<string | null>;
  /** Best-effort cleanup of any transient/decrypted artifacts. */
  readonly cleanup: () => Promise<void>;
  /**
   * Boot-time cleanup of stale transient artifacts. The host can pass a
   * predicate that returns `true` if the corresponding compose project
   * is *running*; if not, the transient is removed.
   */
  readonly bootCleanup: (
    isProjectActive: () => Promise<boolean>
  ) => Promise<void>;
}

export interface RandomAdapter {
  readonly uuid: () => string;
  readonly randomBytes: (size: number) => Uint8Array;
}

export interface CryptoAdapter {
  readonly base64url: (input: Uint8Array) => string;
}

/** What the pg_password generator needs. */
export interface PgPasswordDeps {
  readonly userDataDir: string;
  readonly secretAdapter: SecretAdapter;
  readonly randomAdapter: RandomAdapter;
  readonly cryptoAdapter: CryptoAdapter;
}

export const SECRETS_DIR_NAME = path.join("local-infra", "secrets");
export const PG_PASSWORD_FILE_NAME = "pg_password";

export const nodeRandomAdapter: RandomAdapter = {
  uuid: () => randomUUID(),
  randomBytes: (size) => randomBytes(size),
};

export const nodeCryptoAdapter: CryptoAdapter = {
  base64url: (input) => Buffer.from(input).toString("base64url"),
};

/**
 * Read the install's Postgres password, creating it on first use (32 random
 * bytes, base64url). Returns the path of the readable secret file.
 */
export async function getPgPassword(
  deps: PgPasswordDeps
): Promise<{ composePath: string }> {
  const targetDir = path.join(deps.userDataDir, SECRETS_DIR_NAME);
  const targetPath = path.join(targetDir, PG_PASSWORD_FILE_NAME);

  const existing = await deps.secretAdapter.read(targetPath);
  if (existing !== null && existing.length > 0) {
    // Re-write so the secret adapter has a fresh transient file (the
    // previous transient may have been cleaned up by `bootCleanup`).
    return deps.secretAdapter.write(targetPath, existing);
  }

  const password = deps.cryptoAdapter.base64url(
    deps.randomAdapter.randomBytes(32)
  );
  return deps.secretAdapter.write(targetPath, password);
}
