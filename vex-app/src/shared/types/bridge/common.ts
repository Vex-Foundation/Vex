/**
 * Cross-domain bridge primitives.
 *
 * Types shared by both `shell/` (vex-app desktop integration) and `agent/`
 * (vex-agent runtime integration) bridge surfaces. Kept in a dedicated module
 * so neither group has to reach into the other for a shared shape.
 */

import type { Result } from "../../ipc/result.js";

/**
 * Shape returned by long-running bridge methods that support user
 * cancellation (PR3). Renderer holds onto `cancel`; calling it asks
 * main to abort the in-flight handler. `promise` resolves to the
 * handler's `Result` — cancellation is a normal Result outcome, not a
 * rejection.
 *
 * The cancelled outcome is handler-specific, NOT always an error:
 *   - `docker.composeUp` throws `AbortError` on abort → `promise`
 *     resolves to `err(internal.cancelled)`.
 *   - `chat.submit` (9-5b) returns the persisted partial normally on
 *     abort → `promise` resolves to `ok(... stopReason:"user_stopped" ...)`.
 * `register-handler` only rewrites a result to `internal.cancelled` when
 * the handler itself returned an error while the signal was aborted.
 *
 * `cancel` is idempotent: subsequent calls after the first are no-ops.
 */
export interface AbortableInvocation<T> {
  readonly promise: Promise<Result<T>>;
  readonly cancel: () => void;
}

/**
 * ONE frame of a renderer stack, already parsed and sanitized in the renderer.
 *
 * Structured rather than a raw stack string on purpose: a raw stack is a blob
 * that can only be shortened by cutting characters, and a cut blob tells the
 * reader nothing about what it lost. Frames are countable, so the payload can
 * carry a BOUND that reports itself - see `TelemetryStackDigest`.
 *
 * `file` never carries an absolute user path: the renderer reduces it to
 * `scheme//host/pathname` (bundle URLs) or the trailing path segments, and
 * drops query and hash.
 */
export interface TelemetryStackFrame {
  /** Function or method name as V8 spelled it; null for an anonymous frame. */
  readonly fn: string | null;
  /** Sanitized module location; null when the frame carried none. */
  readonly file: string | null;
  readonly line: number | null;
  readonly column: number | null;
}

/**
 * A renderer stack as evidence: the frames that fit, plus exactly what was
 * left out.
 *
 * `frames.length <= frameCount`. When `truncated` is true the omitted frames
 * are the DEEPEST ones (`frameCount - frames.length` of them); the throwing
 * site - the reason this payload exists - is frame 0 and is never dropped.
 * `byteCount` is the size of the original stack string, so a reader can tell
 * how much text the structured form stands for.
 */
export interface TelemetryStackDigest {
  readonly frames: readonly TelemetryStackFrame[];
  /** Frames the original stack carried, before the bound was applied. */
  readonly frameCount: number;
  /** UTF-8 bytes of the original stack string. */
  readonly byteCount: number;
  /** True exactly when `frames.length < frameCount`. */
  readonly truncated: boolean;
}

/**
 * Renderer-side telemetry input. Constrained shape so the preload boundary
 * can validate before crossing IPC.
 *
 * Everything past `componentStack` is ADDITIVE evidence (B0.2): the fields are
 * optional so an older producer still validates, and every bounded field is
 * paired with the count it was bounded against - a reader can always tell what
 * was left out rather than receiving a silently shortened string.
 */
export interface TelemetryReportInput {
  readonly kind: "caught" | "uncaught" | "boundary";
  readonly message: string;
  readonly componentStack?: string | null;
  /** Correlates the report with the id the recovery surface shows the user. */
  readonly correlationId?: string;
  /** `error.name` when the thrown value was an Error. */
  readonly errorName?: string;
  /** UTF-8 bytes of the FULL message; `message` carries fewer when truncated. */
  readonly messageBytes?: number;
  readonly messageTruncated?: boolean;
  /** UTF-8 bytes of the FULL component stack. */
  readonly componentStackBytes?: number;
  readonly componentStackTruncated?: boolean;
  readonly stack?: TelemetryStackDigest | null;
}
