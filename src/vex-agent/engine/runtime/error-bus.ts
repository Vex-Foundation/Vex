/**
 * In-process engine-error event bus.
 *
 * Cloned from `control-bus.ts` (which mirrors `transcript-bus.ts`): a
 * `Set<listener>`, idempotent unsubscribe, misbehaving-listener isolation.
 * A separate module rather than another topic on the control bus, for the
 * same reason the mission bus is separate — different producers, different
 * subscribers, and a shared file would make either one's blast radius the
 * other's.
 *
 * WHY THIS EXISTS. Before it, a whole class of failures had no path to the UI
 * at all: a background mission continuation, a wake tick, a compact job or an
 * approval resume that threw was written to a log and nothing else, and a
 * provider 429 surfaced to the user as "Unable to process the message". This
 * bus is the engine end of the channel that makes those visible.
 *
 * BOUNDED CODES, NEVER PROSE. The payload carries ids, enums, a status number
 * and a retry hint — no provider message, no `stop_summary`, no exception
 * text. That is the repo's pinned doctrine (`memory_jobs.last_error` is
 * excluded from every DTO as untrusted free text, with a test asserting the
 * omission); `stop_summary` is the same class of data. The human-readable
 * error message stays server-side in the logs and in mission evidence.
 *
 * The `category` is deliberately NOT computed here. Classification into the
 * user-facing vocabulary is the app's job and lives in ONE place on the
 * `vex-app` side (`shared/engine-error-classification.ts`), fed by the raw
 * bounded signals below. The engine reports what happened; the app decides how
 * to say it.
 */

export const ENGINE_ERROR_EVENT_TYPE = "engine.runtime.error" as const;

/**
 * Which part of the runtime failed. Drives the renderer's framing ("this turn
 * failed" vs "your mission stopped") and nothing else — it is not a retry
 * policy.
 */
export type EngineErrorScope =
  /** A conversational turn (chat or agent session). */
  | "turn"
  /** A mission run start / recover / continuation. */
  | "mission"
  /** A scheduled wake tick. */
  | "wake"
  /** A compaction job that permanently failed. Session-scoped. */
  | "compact"
  /**
   * A memory-manager job that permanently failed. ALWAYS session-less:
   * `memory_jobs` has no `session_id` column because consolidation and
   * reconcile are global maintenance over `knowledge_entries`, not work done
   * on behalf of one conversation.
   */
  | "memory"
  /** An approval resume (explicit decision, TTL sweep, or policy drift). */
  | "approval";

export interface EngineErrorEvent {
  readonly type: typeof ENGINE_ERROR_EVENT_TYPE;
  /**
   * Owning session, or `null` for GLOBAL failures that belong to no
   * conversation (memory maintenance).
   *
   * A null here is not "unknown" — it is a positive statement that the failure
   * is system-wide. Session-scoped consumers must therefore IGNORE null rather
   * than treat it as a wildcard: a global failure rendered inside one
   * session's banner would tell the user their conversation broke when it did
   * not. The global surface is the only consumer that reads these.
   */
  readonly sessionId: string | null;
  /** `null` for failures with no mission run in scope (chat turns, memory jobs). */
  readonly missionRunId: string | null;
  readonly scope: EngineErrorScope;
  /**
   * OpenRouter's canonical `ApiErrorType`. An OPEN enum carried VERBATIM —
   * every consumer needs a total default branch. Present only on the stream
   * path; thrown SDK errors never carry it.
   */
  readonly errorType: string | null;
  /**
   * SDK error class name from the CLOSED dictionary in
   * `inference/openrouter/error-class.ts`. The only discriminator for the six
   * status-less SDK shapes.
   */
  readonly errorClass: string | null;
  readonly statusCode: number | null;
  /** Errno-shaped transport code (`ECONNRESET`, `UND_ERR_SOCKET`, …). */
  readonly causeCode: string | null;
  /** Provider retry hint in whole seconds, already bounded. */
  readonly retryAfterSeconds: number | null;
  readonly occurredAt: string;
  readonly correlationId: string | null;
}

export type EngineErrorListener = (event: EngineErrorEvent) => void;

export class EngineErrorBus {
  private readonly listeners = new Set<EngineErrorListener>();

  emit(event: EngineErrorEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // a misbehaving listener must not poison the rest of the bus
      }
    }
  }

  subscribe(listener: EngineErrorListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  size(): number {
    return this.listeners.size;
  }

  clear(): void {
    this.listeners.clear();
  }
}

export const engineErrorBus = new EngineErrorBus();

/**
 * BOUNDS MIRRORED FROM THE IPC SCHEMA (`shared/schemas/engine-error.ts`).
 *
 * WHY THEY LIVE HERE. The main-side bridge validates the whole event with a
 * STRICT parse, so ONE out-of-range OPTIONAL field used to drop the ENTIRE
 * notification: a permanent failure reported with a nonsense status (a
 * provider returning `0`, an errno mistaken for a status) told the user
 * nothing at all instead of "this failed, cause unknown". The base failure
 * notification is the truthful part and must always survive.
 *
 * So every optional is normalized to `null` HERE, at the single funnel every
 * emit site goes through, rather than at each caller or by loosening the
 * schema. `null` means "the provider reported nothing usable about this",
 * which is exactly what an unusable value tells us. The schema stays strict:
 * it is still the authority, and anything reaching it is now guaranteed to
 * satisfy it.
 *
 * Deliberately NOT fixed in `readMissionErrorSignal`: that reader also feeds
 * the mission auto-retry classifier, and narrowing its `status` would change
 * retry behaviour to fix a reporting bug.
 */
function boundedStatusCode(value: number | null | undefined): number | null {
  if (typeof value !== "number" || !Number.isInteger(value)) return null;
  return value >= 100 && value <= 599 ? value : null;
}

/** Whole seconds, 1..24h — mirrors the schema and `retry-after.ts`. */
function boundedRetryAfterSeconds(value: number | null | undefined): number | null {
  if (typeof value !== "number" || !Number.isInteger(value)) return null;
  return value >= 1 && value <= 86_400 ? value : null;
}

/**
 * `ApiErrorType` is an OPEN enum carried verbatim, but the label still has to
 * LOOK like an enum member. `readMissionErrorSignal` only length-caps it, so a
 * provider sending `"Rate Limit Exceeded"` would have failed the schema's
 * lower_snake_case regex and taken the whole event down with it.
 */
const ENUM_LABEL_SHAPE = /^[a-z][a-z0-9_]*$/;

function boundedErrorTypeLabel(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  return value.length >= 1 && value.length <= 64 && ENUM_LABEL_SHAPE.test(value)
    ? value
    : null;
}

/** Errno shape — mirrors the schema exactly. */
const ERRNO_SHAPE = /^[A-Z][A-Z0-9_]{2,59}$/;

function boundedCauseCode(value: string | null | undefined): string | null {
  return typeof value === "string" && ERRNO_SHAPE.test(value) ? value : null;
}

/** Closed SDK class dictionary is enforced by the schema; shape-check here. */
const CLASS_NAME_SHAPE = /^[A-Z][A-Za-z0-9]{2,63}$/;

function boundedErrorClassName(value: string | null | undefined): string | null {
  return typeof value === "string" && CLASS_NAME_SHAPE.test(value) ? value : null;
}

/**
 * Producer-side convenience so every emit site stamps `type` and `occurredAt`
 * identically and cannot accidentally widen the payload. Callers pass the
 * signals they already read off the thrown value (via `readMissionErrorSignal`
 * or `MissionRunPausedError`'s own fields) — never the error object itself.
 */
export function emitEngineError(input: {
  /** `null` for a global, session-less failure — see `EngineErrorEvent`. */
  readonly sessionId: string | null;
  readonly missionRunId?: string | null;
  readonly scope: EngineErrorScope;
  readonly errorType?: string | null;
  readonly errorClass?: string | null;
  readonly statusCode?: number | null;
  readonly causeCode?: string | null;
  readonly retryAfterSeconds?: number | null;
  readonly correlationId?: string | null;
}): void {
  engineErrorBus.emit({
    type: ENGINE_ERROR_EVENT_TYPE,
    sessionId: input.sessionId,
    missionRunId: input.missionRunId ?? null,
    scope: input.scope,
    // Normalized, never merely defaulted — see the bounds block above. An
    // unusable optional becomes `null` so the base failure notification
    // survives the boundary intact.
    errorType: boundedErrorTypeLabel(input.errorType),
    errorClass: boundedErrorClassName(input.errorClass),
    statusCode: boundedStatusCode(input.statusCode),
    causeCode: boundedCauseCode(input.causeCode),
    retryAfterSeconds: boundedRetryAfterSeconds(input.retryAfterSeconds),
    occurredAt: new Date().toISOString(),
    correlationId: input.correlationId ?? null,
  });
}
