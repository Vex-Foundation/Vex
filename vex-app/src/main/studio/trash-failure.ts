import type { ProjectTrashFailure } from "@shared/schemas/project-cleanup.js";

/** Electron's aborted flag does not distinguish a lock from a non-recyclable item. */
export function classifyTrashFailure(
  cause: unknown,
  absolutePath: string,
  platform: NodeJS.Platform = process.platform,
): ProjectTrashFailure {
  const error = typeof cause === "object" && cause !== null ? cause : {};
  const code = "code" in error ? error.code : undefined;
  const message = "message" in error && typeof error.message === "string" ? error.message : "";
  if (code === "EBUSY" || code === "ETXTBSY" || code === "ERROR_SHARING_VIOLATION"
    || /being used by another process|sharing violation/i.test(message)) return "busy";
  if (code === "EACCES" || code === "EPERM" || code === "EROFS") return "permission_denied";
  if (message === "Failed to parse path" || code === "EINVAL") return "invalid_path";
  if (message === "Operation was aborted" || code === "ABORT_ERR") {
    // Extended drive paths (\\?\C:\...) are local; extended UNC is not.
    if (platform === "win32" && (/^\\\\\?\\UNC\\/i.test(absolutePath)
      || (/^\\\\/.test(absolutePath) && !/^\\\\[?.]\\/.test(absolutePath)))) return "nonlocal_volume";
    return "aborted";
  }
  return "io_error";
}
