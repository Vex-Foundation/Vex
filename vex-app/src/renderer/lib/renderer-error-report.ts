/**
 * THE RENDERER'S CRASH-EVIDENCE PATH, in one owner.
 *
 * Every renderer failure - a React boundary catch, a window `error`, an
 * `unhandledrejection`, a React recoverable error, an async controller
 * rejection - describes itself here and leaves through the ONE existing IPC
 * sink (`window.vex.telemetry.reportRendererError`). Before B0.2 the shape of
 * a report was spelled at each call site in `main.tsx`, which is why the
 * boundary-less renderer had no evidence to send in the first place.
 *
 * ## What crosses the boundary, and what never does
 *
 * The renderer is untrusted and its strings are user data, so a report carries
 * DESCRIPTION, never payload: the error name, the message, a bounded list of
 * structured stack frames, and the React component stack. Frame locations are
 * sanitized to `scheme//host/pathname` or the last two path segments, so an
 * absolute user path (`/home/<name>/...`, `C:\Users\<name>\...`) cannot ride
 * along even when a bundler baked one into a stack.
 *
 * ## Bounds report themselves
 *
 * A stack is cut by FRAMES, not by characters, and the digest carries the
 * original frame count, the original byte count and an explicit `truncated`
 * flag (owner decree: a bound that cannot be told from the whole is forbidden
 * truncation). The message and component stack are bounded the same way, each
 * paired with the byte count of the full text.
 *
 * ## It can never make things worse
 *
 * Reporting is fire-and-forget and every failure path is swallowed: a report
 * that itself threw would raise another `unhandledrejection`, which would
 * report again, which is the loop this module exists inside the crash path to
 * avoid. It never throws and it never returns a promise callers must handle.
 */

import {
  TELEMETRY_COMPONENT_STACK_LIMIT,
  TELEMETRY_MESSAGE_LIMIT,
  TELEMETRY_STACK_FRAME_LIMIT,
} from "@shared/schemas/telemetry.js";
import type {
  TelemetryReportInput,
  TelemetryStackDigest,
  TelemetryStackFrame,
} from "@shared/types/bridge/common.js";

/** Bytes of a string as UTF-8, which is what the byte counts in a report mean. */
function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

interface BoundedText {
  readonly text: string;
  readonly byteCount: number;
  readonly truncated: boolean;
}

function boundText(text: string, limit: number): BoundedText {
  const byteCount = byteLength(text);
  if (text.length <= limit) return { text, byteCount, truncated: false };
  return { text: text.slice(0, limit), byteCount, truncated: true };
}

/**
 * Reduce a frame location to something that carries no absolute user path.
 *
 * A bundle URL (`app://vex/assets/index-abc.js`, the dev server's
 * `http://127.0.0.1:5173/src/...`) keeps scheme, host and pathname and loses
 * query and hash. Anything else is treated as a filesystem path and reduced to
 * its last two segments behind an ellipsis, which is enough to name a module
 * and not enough to name a person.
 */
export function sanitizeFrameFile(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === "" || trimmed === "<anonymous>") return null;
  // The scheme must be at least TWO characters and be followed by `//`.
  // `new URL` alone is not that test: it happily parses
  // `C:\Users\<name>\...` as scheme `c:` and hands the whole absolute user
  // path back as a "URL", which is precisely the leak this function exists to
  // prevent (caught by its own test, not by review).
  if (/^[a-zA-Z][a-zA-Z0-9+.-]+:\/\//.test(trimmed)) {
    try {
      const url = new URL(trimmed);
      return `${url.protocol}//${url.host}${url.pathname}`;
    } catch {
      // Falls through to the path reduction below.
    }
  }
  const segments = trimmed.split(/[/\\]/).filter((s) => s !== "");
  if (segments.length <= 2) return segments.join("/");
  return `…/${segments.slice(-2).join("/")}`;
}

/**
 * Parse ONE V8 stack line into a frame.
 *
 * Accepts both spellings V8 emits: `at fn (loc:line:col)` and the bare
 * `at loc:line:col`. A line that is neither (the `Error: message` head, a
 * `[native code]` marker) returns null and is not counted as a frame.
 */
export function parseStackLine(line: string): TelemetryStackFrame | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("at ")) return null;
  let rest = trimmed.slice(3).trim();
  let fn: string | null = null;
  const open = rest.lastIndexOf(" (");
  if (open !== -1 && rest.endsWith(")")) {
    fn = rest.slice(0, open).trim();
    if (fn === "") fn = null;
    rest = rest.slice(open + 2, -1);
  }
  const located = /^(.*):(\d+):(\d+)$/.exec(rest);
  if (located === null) {
    const file = sanitizeFrameFile(rest);
    if (fn === null && file === null) return null;
    return { fn, file, line: null, column: null };
  }
  return {
    fn,
    file: sanitizeFrameFile(located[1] ?? ""),
    line: Number(located[2]),
    column: Number(located[3]),
  };
}

/**
 * Turn a raw stack string into the bounded digest that crosses IPC.
 *
 * The frames kept are the SHALLOWEST ones - frame 0 is the throwing site, and
 * that is the frame the report exists for. A stack with no parseable frame
 * still produces a digest (`frameCount: 0`), because "the stack carried no
 * frames" is itself evidence and must not read as "no stack was sent".
 */
export function digestStack(stack: string | undefined): TelemetryStackDigest | null {
  if (stack === undefined || stack === "") return null;
  const parsed: TelemetryStackFrame[] = [];
  for (const line of stack.split("\n")) {
    const frame = parseStackLine(line);
    if (frame !== null) parsed.push(frame);
  }
  const frames = parsed.slice(0, TELEMETRY_STACK_FRAME_LIMIT);
  return {
    frames,
    frameCount: parsed.length,
    byteCount: byteLength(stack),
    truncated: frames.length < parsed.length,
  };
}

export interface DescribedError {
  readonly name: string;
  readonly message: string;
  readonly stack: string | undefined;
}

/** Describe any thrown value, including the non-Errors JavaScript permits. */
export function describeThrown(error: unknown): DescribedError {
  if (error instanceof Error) {
    return { name: error.name, message: error.message, stack: error.stack };
  }
  return { name: "NonError", message: String(error), stack: undefined };
}

/**
 * A correlation id the user can read off the recovery surface and quote.
 *
 * `crypto.randomUUID` is present in Electron's renderer and in jsdom's crypto
 * shim under a secure context; the counter fallback exists so a boundary can
 * still name its failure in an environment that lacks it, never so an id is
 * silently absent.
 */
let fallbackCounter = 0;
export function newCorrelationId(): string {
  const cryptoApi: Crypto | undefined = globalThis.crypto;
  if (typeof cryptoApi?.randomUUID === "function") return cryptoApi.randomUUID();
  fallbackCounter += 1;
  return `renderer-${String(Date.now())}-${String(fallbackCounter)}`;
}

export interface RendererFailure {
  /**
   * Which renderer surface failed - `"app"`, `"studio.workspace"`,
   * `"studio.workspace.restore"`, `"window"`. It rides IN the message rather
   * than as its own IPC field: the sink's contract is a description, and one
   * more optional string field would be one more thing to keep in sync across
   * five files for no reader that treats it differently.
   */
  readonly surface: string;
  readonly kind: TelemetryReportInput["kind"];
  readonly error: unknown;
  readonly componentStack?: string | null;
  /** Reuse the id already shown to the user instead of minting a second one. */
  readonly correlationId?: string;
}

/**
 * Send one failure. Returns the correlation id it reported under, so a caller
 * that shows a recovery surface displays the SAME id the log carries.
 *
 * Never throws, never rejects: the bridge may be absent (an early boot frame,
 * a test), the preload validator may reject, main may be gone.
 */
export function reportRendererFailure(failure: RendererFailure): string {
  const correlationId = failure.correlationId ?? newCorrelationId();
  try {
    const described = describeThrown(failure.error);
    const message = boundText(
      `[${failure.surface}] ${described.name}: ${described.message}`,
      TELEMETRY_MESSAGE_LIMIT,
    );
    const componentStack =
      failure.componentStack === undefined || failure.componentStack === null
        ? null
        : boundText(failure.componentStack, TELEMETRY_COMPONENT_STACK_LIMIT);
    const input: TelemetryReportInput = {
      kind: failure.kind,
      message: message.text,
      messageBytes: message.byteCount,
      messageTruncated: message.truncated,
      componentStack: componentStack?.text ?? null,
      componentStackBytes: componentStack?.byteCount,
      componentStackTruncated: componentStack?.truncated,
      correlationId,
      errorName: described.name,
      stack: digestStack(described.stack),
    };
    // Developer-visible too: a local run must show the failure in the console
    // at the moment it happens, not only in a log file read afterwards.
    console.error(`[vex] ${message.text} (${correlationId})`, failure.error);
    void window.vex?.telemetry
      ?.reportRendererError(input)
      .catch(() => undefined);
  } catch {
    // The report path itself failed. Swallowed deliberately: rethrowing here
    // lands inside the crash we are describing, and the console.error above
    // has already run in every case that can reach this catch.
  }
  return correlationId;
}
