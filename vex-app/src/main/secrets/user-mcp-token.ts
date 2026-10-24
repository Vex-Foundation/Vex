/**
 * Bearer tokens for the user's own MCP servers (F12), in the encrypted vault.
 *
 * Each token is an `extraSecrets` entry under `user-mcp-token:<serverId>`,
 * written and read only here, in main, with the session's own held password,
 * and refused while the vault is locked. A token is never returned to the
 * renderer and never logged; the engine reads it per operation through the
 * seam `registerUserMcpTokenReader`.
 */

import { unlockSecretVault, writeSecretVaultExtraSecrets } from "@vex-lib/local-secret-vault.js";
import type { UserMcpTokenRead } from "@vex-agent/user-mcp/token-reader.js";
import { requireUnlockedMasterPassword } from "./session.js";
import { unlockedSessionVaultOptions } from "./vault-key-cache.js";

const KEY_PREFIX = "user-mcp-token:";
const SERVER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class UserMcpTokenLockedError extends Error {
  override readonly name = "UserMcpTokenLockedError";
  constructor() {
    super("The vault is locked, so the MCP server token cannot be changed.");
  }
}

function keyFor(serverId: string): string {
  if (!SERVER_ID.test(serverId)) throw new Error("invalid MCP server id");
  return `${KEY_PREFIX}${serverId.toLowerCase()}`;
}

let mutationTail: Promise<unknown> = Promise.resolve();

function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const result = mutationTail.then(fn, fn);
  mutationTail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

/** Store a token, or remove it with `null`. Throws `UserMcpTokenLockedError` while locked. */
export function writeUserMcpToken(serverId: string, token: string | null): Promise<void> {
  const key = keyFor(serverId);
  return serialize(async () => {
    const password = requireUnlockedMasterPassword();
    if (!password.ok) throw new UserMcpTokenLockedError();
    await writeSecretVaultExtraSecrets(
      password.data,
      { [key]: token !== null && token.length > 0 ? token : null },
      unlockedSessionVaultOptions("secrets_write"),
    );
  });
}

export function deleteUserMcpToken(serverId: string): Promise<void> {
  return writeUserMcpToken(serverId, null);
}

/** The engine-facing reader: `locked` while the vault is locked or unreadable. */
export async function readUserMcpTokenFromVault(serverId: string): Promise<UserMcpTokenRead> {
  const key = keyFor(serverId);
  const password = requireUnlockedMasterPassword();
  if (!password.ok) return { kind: "locked" };
  try {
    const contents = await unlockSecretVault(password.data, unlockedSessionVaultOptions("secret_read"));
    const value = contents.extraSecrets?.[key];
    return typeof value === "string" && value.length > 0 ? { kind: "token", token: value } : { kind: "none" };
  } catch {
    return { kind: "locked" };
  }
}

/** Whether a vault entry exists for this server (for tests and the remove check). */
export async function hasUserMcpTokenInVault(serverId: string): Promise<boolean | null> {
  const read = await readUserMcpTokenFromVault(serverId);
  return read.kind === "locked" ? null : read.kind === "token";
}
