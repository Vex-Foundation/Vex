/**
 * Shared `VexError` builders for the runtime IPC namespace.
 *
 * Extracted from the old `runtime.ts` so every per-handler module
 * can import the same definitions without duplicating the literal
 * shape. `correlationId` is set per-call by `registerHandler` if
 * the caller does not provide one; we set it explicitly so the
 * `VexError` envelope keeps stamping the requestId we already have.
 */

import type { VexError } from "@shared/ipc/result.js";

export function controlFailedError(correlationId: string): VexError {
  return {
    code: "internal.unexpected",
    domain: "runtime",
    message: "Unable to apply runtime control request.",
    retryable: true,
    userActionable: false,
    redacted: true,
    correlationId,
  };
}
