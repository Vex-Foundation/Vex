/**
 * Internal IPC dispatch helpers for the preload bridge.
 *
 * Centralises the three primitives every per-domain bridge file
 * needs:
 *
 *   - `invokeWithSchema` — typed `ipcRenderer.invoke` with optional
 *     preload-side Zod validation. Generates a fresh correlationId so
 *     validation errors and main-side errors share the same id.
 *   - `abortableInvoke` — same as above, returns an `Abortable<T>` so
 *     the renderer can cancel the in-flight call by firing
 *     `vex:cancel` with the same correlationId.
 *   - `subscribe` — domain-namespaced event subscription with Zod
 *     validation on every emitted payload.
 *
 * Leading underscore + `_dispatch.ts` filename signals "internal
 * helper, never appears as a `window.vex.*` namespace". The bridge
 * surface tests under `preload/__tests__/` pin this — the file is
 * scanned recursively, but no namespace-shaped object lives here.
 */

import { ipcRenderer } from "electron";
import type { z } from "zod";
import { CH } from "../shared/ipc/channels.js";
import { err, type Result, type VexError } from "../shared/ipc/result.js";
import type { AbortableInvocation } from "../shared/types/bridge/common.js";

function newRequestId(): string {
  return crypto.randomUUID();
}

function preloadValidationError(correlationId: string): Result<never, VexError> {
  return err({
    code: "validation.invalid_input",
    domain: "preload",
    message: "Invalid input rejected by preload boundary.",
    retryable: false,
    userActionable: false,
    redacted: true,
    correlationId,
  });
}

export async function invokeWithSchema<T, I = unknown>(
  channel: string,
  payload: I,
  inputSchema?: z.ZodType<I>
): Promise<Result<T, VexError>> {
  // Generate the correlation id up front so validation errors carry it too.
  const requestId = newRequestId();
  if (inputSchema) {
    const parsed = inputSchema.safeParse(payload);
    if (!parsed.success) {
      return preloadValidationError(requestId) as Result<T, VexError>;
    }
  }
  return (await ipcRenderer.invoke(channel, {
    requestId,
    payload: payload ?? {},
  })) as Result<T, VexError>;
}

/**
 * Abortable invocation. Bridge files that wrap a cancellable channel
 * (`settings.lighterPoints`, `chat.submit`) call this. The returned shape
 * matches `AbortableInvocation<T>` exported from `bridge/common.js`.
 *
 * The cancelled outcome is handler-specific: `settings.lighterPoints`
 * answers an abort with `err(internal.cancelled)`, while
 * `chat.submit` (9-5b) returns the persisted partial normally → `promise`
 * resolves to `ok(... stopReason:"user_stopped" ...)`. See
 * `AbortableInvocation` for the full contract.
 *
 * NOTE: this helper is NOT exposed as a `window.vex.*` method. Doing so
 * would let the renderer cancel arbitrary IPC requests, including ones
 * whose handlers don't opt in to cancellation. Instead, individual
 * bridge files declare their own cancellable methods that route
 * through here.
 */
export function abortableInvoke<T, I = unknown>(
  channel: string,
  payload: I,
  inputSchema?: z.ZodType<I>
): AbortableInvocation<T> {
  const requestId = newRequestId();
  if (inputSchema) {
    const parsed = inputSchema.safeParse(payload);
    if (!parsed.success) {
      return {
        promise: Promise.resolve(
          preloadValidationError(requestId) as Result<T, VexError>
        ),
        cancel: () => {},
      };
    }
  }
  const promise = ipcRenderer.invoke(channel, {
    requestId,
    payload: payload ?? {},
  }) as Promise<Result<T, VexError>>;
  let cancelSent = false;
  const cancel = (): void => {
    if (cancelSent) return;
    cancelSent = true;
    // Fire-and-forget. Catch the promise so a rejected `vex:cancel`
    // (e.g. main tearing down on app quit) does not surface as an
    // unhandled rejection. The original `promise` is what carries the
    // cancellation outcome back to the renderer.
    void ipcRenderer
      .invoke(CH.cancel, {
        requestId: newRequestId(),
        payload: { correlationId: requestId },
      })
      .catch(() => undefined);
  };
  return { promise, cancel };
}

/**
 * Domain-namespaced event subscription. Renderer never sees raw
 * channel strings — every subscription comes through a typed bridge
 * method (e.g. `vex.system.onRuntimeProgress`) that calls into this.
 * Payload is Zod-validated at the preload boundary so a misbehaving
 * main never injects unexpected shapes into renderer state.
 */
export function subscribe<T>(
  channel: string,
  schema: z.ZodType<T>,
  cb: (payload: T) => void
): () => void {
  const handler = (_event: unknown, raw: unknown): void => {
    const parsed = schema.safeParse(raw);
    if (parsed.success) cb(parsed.data);
  };
  ipcRenderer.on(channel, handler);
  return () => {
    ipcRenderer.removeListener(channel, handler);
  };
}
