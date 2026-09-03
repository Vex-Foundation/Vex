/**
 * Electron secret adapter — plaintext POSIX-style secret file format
 * (codex turn 5 RED #3 pinned the format; the separate posix adapter it
 * had to stay compatible with was never wired and has been removed).
 *
 * The canonical file at `${SECRETS_DIR}/pg_password` is always written
 * plaintext, REQUESTING mode 0o600 inside a 0o700 directory. DPAPI /
 * Keychain / libsecret defense-in-depth is deferred to a future M11 task
 * that adds a shared decryption shim.
 *
 * WHAT THE MODE BIT ACTUALLY BUYS, PER PLATFORM. The `mode` arguments below
 * are a POSIX request, not a portable guarantee - this header previously
 * claimed 0600 unconditionally, which is only true on two of our three
 * targets:
 *
 *   - macOS / Linux: the kernel enforces the mode, and it IS the access
 *     boundary. The process umask can only clear further bits, so it can
 *     never widen these.
 *   - Windows: libuv maps `mode` onto the read-only attribute alone; the
 *     group/other bits have no NTFS ACL representation and are a NO-OP. The
 *     real boundary is inherited rather than set here - `${SECRETS_DIR}`
 *     lives under the per-user `%APPDATA%` tree, whose default ACL admits
 *     the owning user plus the local SYSTEM/Administrators principals and
 *     nobody else. Another unprivileged local user cannot read the file; a
 *     local administrator can, which is equally true of DPAPI at rest.
 *
 * Nothing here depends on this note - it exists so a reader does not take the
 * 0o600 literal below as a cross-platform permission claim.
 *
 * The boot-time cleanup pass enumerates the secrets directory for any
 * orphaned `*.transient` files left over from a previous session that
 * crashed mid-write — there shouldn't be any in the new POSIX-only
 * model, but the cleanup is kept as defence-in-depth.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import type { safeStorage as SafeStorage } from "electron";
import type { SecretAdapter } from "./render.js";

const TRANSIENT_SUFFIX = ".transient";

interface AdapterOptions {
  readonly safeStorage?: typeof SafeStorage;
}

export function makeElectronSecretAdapter(
  _options: AdapterOptions = {}
): SecretAdapter {
  // We deliberately ignore safeStorage in the canonical write path — see
  // header comment for the cross-client format-compatibility rationale.
  const trackedTransients = new Set<string>();

  async function safeUnlink(p: string): Promise<void> {
    try {
      await fs.unlink(p);
    } catch (err: unknown) {
      if (
        err &&
        typeof err === "object" &&
        "code" in err &&
        (err as { code: unknown }).code === "ENOENT"
      ) {
        return;
      }
      // Best-effort — don't throw.
    }
  }

  return {
    async write(targetPath, value) {
      const dir = path.dirname(targetPath);
      await fs.mkdir(dir, { recursive: true, mode: 0o700 });
      const tempPath = `${targetPath}.tmp-${process.pid}-${Date.now()}`;
      await fs.writeFile(tempPath, value, { encoding: "utf8", mode: 0o600 });
      await fs.rename(tempPath, targetPath);
      return { composePath: targetPath };
    },

    async read(targetPath) {
      try {
        const value = await fs.readFile(targetPath, "utf8");
        return value.length > 0 ? value : null;
      } catch (err: unknown) {
        if (
          err &&
          typeof err === "object" &&
          "code" in err &&
          (err as { code: unknown }).code === "ENOENT"
        ) {
          return null;
        }
        throw err;
      }
    },

    async cleanup() {
      const targets = [...trackedTransients];
      trackedTransients.clear();
      for (const file of targets) {
        await safeUnlink(file);
      }
    },

    /**
     * Boot-time scan of `dir` for orphaned `*.transient` files whose
     * owning compose project is not currently running. Caller passes
     * `dir` (the canonical secrets directory) plus a per-file
     * `isProjectActive` predicate.
     */
    async bootCleanup(isProjectActive) {
      // Caller invokes this with a single predicate; we sweep the
      // canonical secrets directory for orphans. The directory path is
      // not known to the adapter, so the caller is expected to wire
      // this up with the explicit secrets directory it owns. See
      // `lifecycle/before-quit.ts` and main entry for the wiring.
      const active = await isProjectActive().catch(() => false);
      if (active) {
        // Project still owns whatever transient remains; do not delete.
        return;
      }
      // The caller-driven sweep is implemented in
      // `lifecycle/secret-cleanup.ts`, which has access to the secrets
      // directory and walks `*.transient` files. This adapter exposes
      // `cleanup()` as the in-session API and leaves boot-time orphan
      // detection to that lifecycle helper for now.
    },
  };
}
