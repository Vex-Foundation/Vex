/**
 * User MCP tokens through the REAL encrypted vault on a temp file: written
 * under `user-mcp-token:<serverId>`, read back by the engine-facing reader,
 * refused while locked, and gone after removal. Only the session's password
 * holder and the vault path are stubbed.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const vaultDir = mkdtempSync(join(tmpdir(), "vex-user-mcp-vault-"));
const vaultFile = join(vaultDir, "secrets.vault");
const session = vi.hoisted(() => ({ unlocked: true }));

vi.mock("../session.js", () => ({
  requireUnlockedMasterPassword: () =>
    session.unlocked ? { ok: true, data: "correct horse battery staple" } : { ok: false, error: { code: "locked" } },
}));
vi.mock("../vault-key-cache.js", () => ({
  unlockedSessionVaultOptions: () => ({ filePath: vaultFile }),
}));

import { unlockSecretVault } from "@vex-lib/local-secret-vault.js";
import {
  deleteUserMcpToken,
  readUserMcpTokenFromVault,
  UserMcpTokenLockedError,
  writeUserMcpToken,
} from "../user-mcp-token.js";

const SERVER = "11111111-2222-4333-8444-555555555555";

beforeEach(() => {
  session.unlocked = true;
});
afterAll(() => rmSync(vaultDir, { recursive: true, force: true }));

describe("user MCP tokens in the vault", () => {
  it("writes, reads back, and keeps the token out of the file's plain text", async () => {
    await writeUserMcpToken(SERVER, "s3cret-token-value");
    expect(await readUserMcpTokenFromVault(SERVER)).toEqual({ kind: "token", token: "s3cret-token-value" });
    expect(readFileSync(vaultFile, "utf8")).not.toContain("s3cret-token-value");
    const contents = await unlockSecretVault("correct horse battery staple", { filePath: vaultFile });
    expect(contents.extraSecrets?.[`user-mcp-token:${SERVER}`]).toBe("s3cret-token-value");
  });

  it("refuses to write and answers locked while the vault is locked", async () => {
    session.unlocked = false;
    await expect(writeUserMcpToken(SERVER, "other")).rejects.toBeInstanceOf(UserMcpTokenLockedError);
    expect(await readUserMcpTokenFromVault(SERVER)).toEqual({ kind: "locked" });
  });

  it("removes the entry", async () => {
    await writeUserMcpToken(SERVER, "to-remove");
    await deleteUserMcpToken(SERVER);
    expect(await readUserMcpTokenFromVault(SERVER)).toEqual({ kind: "none" });
    const contents = await unlockSecretVault("correct horse battery staple", { filePath: vaultFile });
    expect(contents.extraSecrets?.[`user-mcp-token:${SERVER}`]).toBeUndefined();
  });

  it("refuses an id that is not a server id", async () => {
    await expect(writeUserMcpToken("../escape", "x")).rejects.toThrow(/invalid MCP server id/);
  });
});
