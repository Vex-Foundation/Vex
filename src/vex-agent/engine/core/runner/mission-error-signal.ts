/**
 * Own-property reader for a thrown mission/inference error's transport/HTTP
 * shape. `mission-error-classifier.ts` (auto-retry classification) reads
 * from this; `engine/types.ts` `MissionRunPausedError` intentionally does
 * NOT (that file stays dependency-light — see its own header comment — and
 * duplicates the same reader idiom locally instead of importing this module).
 *
 * Own-properties ONLY — this never walks `.cause`. The OpenRouter normalizer
 * contract (`inference/openrouter/errors.ts`) guarantees a normalized error
 * carries no `.cause` (walking would re-open the exact PII/body re-leak path
 * the normalizer exists to close), and walking an arbitrary caller's `.cause`
 * chain here would let something like `ABORT_ERR` buried at depth 1+ get
 * misread as the top-level signal for an error that is not actually an abort
 * at this layer.
 */

import { OPENROUTER_ERROR_CLASSES } from "../../../inference/openrouter/error-class.js";
import { boundedErrorType } from "../../../inference/openrouter/provider-signals.js";

/** Validated own-property signals read off a thrown value's transport shape. */
export interface MissionErrorSignal {
  readonly status: number | null;
  readonly code: string | null;
  readonly causeCode: string | null;
  readonly retryable: boolean | null;
  readonly name: string | null;
  /**
   * OpenRouter's canonical `ApiErrorType` (OPEN enum, carried verbatim) when
   * the failure came from a mid-stream error chunk. `null` on the throw path,
   * which never carries it — that asymmetry is why `errorClass` exists.
   */
  readonly errorType: string | null;
  /**
   * SDK error class name from the CLOSED dictionary in
   * `inference/openrouter/error-class.ts`. The only discriminator for the six
   * status-less SDK shapes, which would otherwise arrive here as `status:
   * null` and be indistinguishable from an unclassifiable failure.
   */
  readonly errorClass: string | null;
  /** Provider retry hint in whole seconds, bounded at the inference boundary. */
  readonly retryAfterSeconds: number | null;
}

const EMPTY_SIGNAL: MissionErrorSignal = {
  status: null,
  code: null,
  causeCode: null,
  retryable: null,
  name: null,
  errorType: null,
  errorClass: null,
  retryAfterSeconds: null,
};

/**
 * Read an arbitrary OWN-property off an Error (status/code/retryable live on
 * subclasses, not on the base type). The `unknown` hop is required because
 * `Error` has no index signature; it is read-only and locally contained here.
 * Own-property guard: ordinary indexing would also resolve inherited
 * prototype properties (e.g. `Error.prototype.name`), letting a caller
 * "read" a signal that was never actually attached to this value.
 */
function field(err: Error, key: string): unknown {
  if (!Object.prototype.hasOwnProperty.call(err, key)) return undefined;
  return (err as unknown as Record<string, unknown>)[key];
}

function numberField(err: Error, keys: readonly string[]): number | null {
  for (const key of keys) {
    const v = field(err, key);
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return null;
}

function stringField(err: Error, key: string): string | null {
  const v = field(err, key);
  return typeof v === "string" ? v : null;
}

/** Errno-shaped code guard — mirrors `lib/error-cause.ts` (not exported there; duplicated). */
const ERRNO_SHAPE = /^[A-Z][A-Z0-9_]{2,59}$/;

/**
 * `causeCode` is persisted into mission evidence / bug-report context, so it
 * must be shape-validated here (not just own-read) — an arbitrary attacker-
 * or provider-controlled string must never reach a persisted record under
 * this field.
 */
function causeCodeField(err: Error, key: string): string | null {
  const v = field(err, key);
  return typeof v === "string" && ERRNO_SHAPE.test(v) ? v : null;
}

/**
 * `errorClass` is a CLOSED dictionary, so an unknown value is rejected — the
 * opposite posture to `errorType`, whose open enum must survive verbatim.
 */
function boundedErrorClassName(value: unknown): string | null {
  return typeof value === "string" && OPENROUTER_ERROR_CLASSES.has(value)
    ? value
    : null;
}

/** Positive whole seconds only — the same bound the inference layer applied. */
function retryAfterSecondsField(err: Error, key: string): number | null {
  const v = field(err, key);
  return typeof v === "number" && Number.isInteger(v) && v > 0 ? v : null;
}

function booleanField(err: Error, key: string): boolean | null {
  const v = field(err, key);
  return typeof v === "boolean" ? v : null;
}

/**
 * Read the transport/HTTP own-properties off an unknown thrown value.
 * Non-Error inputs return all-null. Own-properties only — never follows
 * `.cause`.
 */
export function readMissionErrorSignal(err: unknown): MissionErrorSignal {
  if (!(err instanceof Error)) return EMPTY_SIGNAL;
  return {
    status: numberField(err, ["status", "statusCode"]),
    code: stringField(err, "code"),
    causeCode: causeCodeField(err, "causeCode"),
    retryable: booleanField(err, "retryable"),
    name: stringField(err, "name"),
    // Re-validated here rather than trusted: this reader is fed by arbitrary
    // thrown values, not only by `normalizeOpenRouterError` output.
    errorType: boundedErrorType(field(err, "errorType")),
    errorClass: boundedErrorClassName(field(err, "errorClass")),
    retryAfterSeconds: retryAfterSecondsField(err, "retryAfterSeconds"),
  };
}
