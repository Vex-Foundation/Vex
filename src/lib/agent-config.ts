/**
 * Agent core tuning — single source of truth (M9).
 *
 * Owns field metadata (key/min/max/default) AND the parse pipeline
 * that turns env strings into validated effective values. Two
 * consumers, two contracts:
 *
 *  - Engine (`src/vex-agent/inference/config.ts`) imports field
 *    constants and `parseAgentEnv`. AGENT_* invalid values throw a
 *    combined error (existing engine behavior).
 *
 *  - vex-app (`vex-app/src/main/onboarding/agent-core-writer.ts`)
 *    uses the same helpers but enforces strict validation at the
 *    write boundary: any AGENT parse error blocks the write with
 *    `validation.invalid_input`.
 *
 * Both consumers share the exact range/default constants — no
 * duplicated literals, no drift.
 *
 * Pure module: no fs, no DB, no Electron, no logger. Safe to import
 * from `src/shared/*` and from vex-app preload contexts.
 *
 * The optional helper-agent tuning fields were removed in the S1a cut
 * (2026-07-22); only the AGENT_* fields remain.
 */

export type FieldKind = "int" | "float";

export interface FieldBase {
  readonly key: string;
  readonly kind: FieldKind;
  readonly min: number;
  readonly max: number;
}

export interface FieldWithDefault extends FieldBase {
  readonly default: number | null;
}

export type AgentField = FieldWithDefault;

export const AGENT_CONTEXT_LIMIT: FieldWithDefault = {
  key: "AGENT_CONTEXT_LIMIT",
  kind: "int",
  min: 1000,
  max: 2_000_000,
  default: 256_000,
};

export const AGENT_MAX_OUTPUT_TOKENS: FieldWithDefault = {
  key: "AGENT_MAX_OUTPUT_TOKENS",
  kind: "int",
  min: 256,
  max: 128_000,
  default: 16_384,
};

export const AGENT_TEMPERATURE: FieldWithDefault = {
  key: "AGENT_TEMPERATURE",
  kind: "float",
  min: 0,
  max: 2,
  default: null,
};

export const AGENT_FIELDS = [
  AGENT_CONTEXT_LIMIT,
  AGENT_MAX_OUTPUT_TOKENS,
  AGENT_TEMPERATURE,
] as const;

// ── Kairos stream bounds (Phase 2B) ─────────────────────────────
//
// Wall-clock bounds on ONE model inference round, in milliseconds. `0`
// disables a bound. They never apply to a tool dispatch. The defaults are the
// owner's conservative 2026-09-27 values (2-6x the worst observed live gaps),
// to be tightened from the representative baseline. The ceiling (1 h) is a
// sanity bound, not a recommendation.

const STREAM_BOUND_MAX_MS = 3_600_000;

/** Request start → first chunk of any type. */
export const AGENT_FIRST_CHUNK_TIMEOUT_MS: FieldWithDefault = {
  key: "AGENT_FIRST_CHUNK_TIMEOUT_MS",
  kind: "int",
  min: 0,
  max: STREAM_BOUND_MAX_MS,
  default: 90_000,
};

/** Longest silence allowed between two chunks after the first. */
export const AGENT_STREAM_IDLE_TIMEOUT_MS: FieldWithDefault = {
  key: "AGENT_STREAM_IDLE_TIMEOUT_MS",
  kind: "int",
  min: 0,
  max: STREAM_BOUND_MAX_MS,
  default: 60_000,
};

/** First reasoning chunk → first content or tool-call delta. */
export const AGENT_REASONING_ONLY_TIMEOUT_MS: FieldWithDefault = {
  key: "AGENT_REASONING_ONLY_TIMEOUT_MS",
  kind: "int",
  min: 0,
  max: STREAM_BOUND_MAX_MS,
  default: 150_000,
};

/**
 * TOTAL wall clock for one inference round, including SDK retries, endpoint
 * failover backoff and the buffered fallback.
 */
export const AGENT_INFERENCE_ROUND_DEADLINE_MS: FieldWithDefault = {
  key: "AGENT_INFERENCE_ROUND_DEADLINE_MS",
  kind: "int",
  min: 0,
  max: STREAM_BOUND_MAX_MS,
  default: 300_000,
};

export const AGENT_STREAM_BOUND_FIELDS = [
  AGENT_FIRST_CHUNK_TIMEOUT_MS,
  AGENT_STREAM_IDLE_TIMEOUT_MS,
  AGENT_REASONING_ONLY_TIMEOUT_MS,
  AGENT_INFERENCE_ROUND_DEADLINE_MS,
] as const;

/** Effective stream bounds, in ms; `0` means the bound is disabled. */
export interface AgentStreamBounds {
  readonly firstChunkTimeoutMs: number;
  readonly streamIdleTimeoutMs: number;
  readonly reasoningOnlyTimeoutMs: number;
  readonly inferenceRoundDeadlineMs: number;
}

// ── Kairos DB bounds (Phase 3, S-4) ─────────────────────────────
//
// Bounds on the engine's own Postgres pools, in milliseconds (the control
// pool size is a connection count). Always enforced: every minimum is above
// zero, so no value turns a bound off. A statement that legitimately runs
// longer (migrations, compaction commits) raises its own limit with
// `SET LOCAL statement_timeout` to AGENT_DB_LONG_STATEMENT_TIMEOUT_MS.

const DB_BOUND_MAX_MS = 3_600_000;

/** Server-side cap on one SQL statement on the engine pools. */
export const AGENT_DB_STATEMENT_TIMEOUT_MS: FieldWithDefault = {
  key: "AGENT_DB_STATEMENT_TIMEOUT_MS",
  kind: "int",
  min: 1_000,
  max: DB_BOUND_MAX_MS,
  default: 30_000,
};

/** Cap on waiting for a pooled connection (pool full or server slow to accept). */
export const AGENT_DB_CONNECTION_TIMEOUT_MS: FieldWithDefault = {
  key: "AGENT_DB_CONNECTION_TIMEOUT_MS",
  kind: "int",
  min: 1_000,
  max: 300_000,
  default: 10_000,
};

/** Server ends a session that sits idle inside an open transaction this long. */
export const AGENT_DB_IDLE_IN_TRANSACTION_TIMEOUT_MS: FieldWithDefault = {
  key: "AGENT_DB_IDLE_IN_TRANSACTION_TIMEOUT_MS",
  kind: "int",
  min: 1_000,
  max: DB_BOUND_MAX_MS,
  default: 60_000,
};

/** The raised per-transaction cap for known long statements. */
export const AGENT_DB_LONG_STATEMENT_TIMEOUT_MS: FieldWithDefault = {
  key: "AGENT_DB_LONG_STATEMENT_TIMEOUT_MS",
  kind: "int",
  min: 1_000,
  max: DB_BOUND_MAX_MS,
  default: 300_000,
};

/** Connections in the reserved control pool (Stop, lease renewal/release, reconciliation). */
export const AGENT_DB_CONTROL_POOL_MAX: FieldWithDefault = {
  key: "AGENT_DB_CONTROL_POOL_MAX",
  kind: "int",
  min: 1,
  max: 5,
  default: 2,
};

export const AGENT_DB_BOUND_FIELDS = [
  AGENT_DB_STATEMENT_TIMEOUT_MS,
  AGENT_DB_CONNECTION_TIMEOUT_MS,
  AGENT_DB_IDLE_IN_TRANSACTION_TIMEOUT_MS,
  AGENT_DB_LONG_STATEMENT_TIMEOUT_MS,
  AGENT_DB_CONTROL_POOL_MAX,
] as const;

/** Effective DB bounds. Every value is positive; none can be disabled. */
export interface AgentDbBounds {
  readonly statementTimeoutMs: number;
  readonly connectionTimeoutMs: number;
  readonly idleInTransactionTimeoutMs: number;
  readonly longStatementTimeoutMs: number;
  readonly controlPoolMax: number;
}

// ── Kairos background-call reasoning effort (Phase 5, E-1) ──────
//
// The reasoning effort sent by background model calls (compaction summary and
// chunker, memory judge, entity extraction, regime worker). An enum, not a
// number, so it has its own parser.
//
//   lowest   (default) the lowest effort the model accepts: `none` where the
//            model allows reasoning off, else its lowest positive effort,
//            `low` when the supported set is unknown.
//   provider send no effort; the provider's model default applies (the
//            behaviour before this field existed).
//   <effort> that effort, clamped down to what the model supports.

export const AUX_REASONING_EFFORT_KEY = "AUX_REASONING_EFFORT";

export const AUX_REASONING_EFFORT_OPTIONS = [
  "lowest",
  "provider",
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type AuxReasoningEffortSetting = (typeof AUX_REASONING_EFFORT_OPTIONS)[number];

export const AUX_REASONING_EFFORT_DEFAULT: AuxReasoningEffortSetting = "lowest";

function isAuxReasoningEffortSetting(value: string): value is AuxReasoningEffortSetting {
  return (AUX_REASONING_EFFORT_OPTIONS as readonly string[]).includes(value);
}

/**
 * Parse `AUX_REASONING_EFFORT`. Blank = default; an unknown value is reported
 * in `error` and the default applies. Case-insensitive.
 */
export function parseAuxReasoningEffortEnv(env: EnvLike): {
  readonly value: AuxReasoningEffortSetting;
  readonly error: string | null;
} {
  const raw = env[AUX_REASONING_EFFORT_KEY];
  const trimmed = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (trimmed.length === 0) return { value: AUX_REASONING_EFFORT_DEFAULT, error: null };
  if (isAuxReasoningEffortSetting(trimmed)) return { value: trimmed, error: null };
  return {
    value: AUX_REASONING_EFFORT_DEFAULT,
    error: `${AUX_REASONING_EFFORT_KEY}=${JSON.stringify(trimmed)} is invalid. Must be one of: ${AUX_REASONING_EFFORT_OPTIONS.join(", ")}`,
  };
}

// ── Kairos tool read dispatch (Phase 5, T-1 + T-3) ──────────────
//
// How the engine runs the AUDITED parallel-safe reads
// (`src/vex-agent/tools/parallel-safe-reads.ts`). Nothing here ever applies
// to a call outside that allowlist: approval, wallet, signing and broadcast
// tools stay strictly serial and are never wrapped in a timeout.

/**
 * Most allowlisted reads one batch runs at once. `1` is the previous strictly
 * serial behaviour, exactly.
 */
export const AGENT_TOOL_READ_CONCURRENCY: FieldWithDefault = {
  key: "AGENT_TOOL_READ_CONCURRENCY",
  kind: "int",
  min: 1,
  max: 8,
  default: 3,
};

/** Wall-clock cap on one allowlisted read, in ms. `0` disables it. */
export const AGENT_TOOL_READ_TIMEOUT_MS: FieldWithDefault = {
  key: "AGENT_TOOL_READ_TIMEOUT_MS",
  kind: "int",
  min: 0,
  max: 600_000,
  default: 45_000,
};

/**
 * The same cap for the allowlisted reads that legitimately run longer (web
 * research, the multi-chain wallet scan), in ms. `0` disables it.
 */
export const AGENT_TOOL_READ_EXTENDED_TIMEOUT_MS: FieldWithDefault = {
  key: "AGENT_TOOL_READ_EXTENDED_TIMEOUT_MS",
  kind: "int",
  min: 0,
  max: 600_000,
  default: 120_000,
};

export const AGENT_TOOL_READ_FIELDS = [
  AGENT_TOOL_READ_CONCURRENCY,
  AGENT_TOOL_READ_TIMEOUT_MS,
  AGENT_TOOL_READ_EXTENDED_TIMEOUT_MS,
] as const;

/** Effective read-dispatch bounds. Timeouts of `0` are disabled. */
export interface AgentToolReadBounds {
  readonly readConcurrency: number;
  readonly readTimeoutMs: number;
  readonly extendedReadTimeoutMs: number;
}

// ── Kairos wake concurrency (Phase 6, S-3) ──────────────────────
//
// How many wake slices (mission resumes and Full-Autonomous session
// continuations) the wake executor runs at once
// (`src/vex-agent/engine/wake/executor.ts`).

/**
 * Most wake slices in flight at once. `1` is the previous strictly serial
 * executor, exactly: claim, run to the end of the slice, then the next. Above
 * 1, two slices of one session never overlap (the session lease) and two
 * slices whose sessions select the same wallet never overlap either (the
 * executor's per-wallet exclusion). The ceiling keeps the slices well inside
 * the main DB pool.
 */
export const AGENT_WAKE_CONCURRENCY: FieldWithDefault = {
  key: "AGENT_WAKE_CONCURRENCY",
  kind: "int",
  min: 1,
  max: 4,
  default: 1,
};

export const AGENT_WAKE_FIELDS = [AGENT_WAKE_CONCURRENCY] as const;

/** Effective wake executor bounds. */
export interface AgentWakeBounds {
  readonly wakeConcurrency: number;
}

export interface ParseError {
  readonly key: string;
  readonly raw: string;
  readonly reason: "not_a_number" | "out_of_range";
  readonly detail?: { readonly min?: number; readonly max?: number };
}

export interface AgentEffective {
  readonly contextLimit: number;
  readonly maxOutputTokens: number;
  readonly temperature: number | null;
}

export interface ParseResult<T> {
  readonly value: T;
  readonly errors: readonly ParseError[];
}

type EnvLike = Readonly<Record<string, string | null | undefined>>;

export function parseAgentEnv(env: EnvLike): ParseResult<AgentEffective> {
  const errors: ParseError[] = [];
  const contextLimit = parseFieldOrDefault(AGENT_CONTEXT_LIMIT, env[AGENT_CONTEXT_LIMIT.key], errors);
  const maxOutputTokens = parseFieldOrDefault(AGENT_MAX_OUTPUT_TOKENS, env[AGENT_MAX_OUTPUT_TOKENS.key], errors);
  const temperature = parseFieldOrDefault(AGENT_TEMPERATURE, env[AGENT_TEMPERATURE.key], errors);
  return {
    value: {
      contextLimit: contextLimit ?? AGENT_CONTEXT_LIMIT.default!,
      maxOutputTokens: maxOutputTokens ?? AGENT_MAX_OUTPUT_TOKENS.default!,
      temperature,
    },
    errors,
  };
}

/**
 * Parse the Kairos stream bounds. Kept apart from `parseAgentEnv` so the
 * wizard's agent-core writer, which validates only the fields it writes, is
 * unaffected. Same contract: blank = default, invalid = collected error and
 * the default applies.
 */
export function parseAgentStreamBoundsEnv(env: EnvLike): ParseResult<AgentStreamBounds> {
  const errors: ParseError[] = [];
  const read = (field: FieldWithDefault): number =>
    parseFieldOrDefault(field, env[field.key], errors) ?? field.default ?? 0;
  return {
    value: {
      firstChunkTimeoutMs: read(AGENT_FIRST_CHUNK_TIMEOUT_MS),
      streamIdleTimeoutMs: read(AGENT_STREAM_IDLE_TIMEOUT_MS),
      reasoningOnlyTimeoutMs: read(AGENT_REASONING_ONLY_TIMEOUT_MS),
      inferenceRoundDeadlineMs: read(AGENT_INFERENCE_ROUND_DEADLINE_MS),
    },
    errors,
  };
}

/**
 * Parse the Kairos DB bounds. Same contract as the stream bounds: blank =
 * default, invalid = collected error and the default applies. A long
 * statement budget below the ordinary statement cap is raised to it, so the
 * override can only ever widen the bound.
 */
export function parseAgentDbBoundsEnv(env: EnvLike): ParseResult<AgentDbBounds> {
  const errors: ParseError[] = [];
  const read = (field: FieldWithDefault): number =>
    parseFieldOrDefault(field, env[field.key], errors) ?? field.default ?? field.min;
  const statementTimeoutMs = read(AGENT_DB_STATEMENT_TIMEOUT_MS);
  return {
    value: {
      statementTimeoutMs,
      connectionTimeoutMs: read(AGENT_DB_CONNECTION_TIMEOUT_MS),
      idleInTransactionTimeoutMs: read(AGENT_DB_IDLE_IN_TRANSACTION_TIMEOUT_MS),
      longStatementTimeoutMs: Math.max(read(AGENT_DB_LONG_STATEMENT_TIMEOUT_MS), statementTimeoutMs),
      controlPoolMax: read(AGENT_DB_CONTROL_POOL_MAX),
    },
    errors,
  };
}

/**
 * Parse the Kairos read-dispatch bounds. Same contract as the stream bounds:
 * blank = default, invalid = collected error and the default applies.
 */
export function parseAgentToolReadEnv(env: EnvLike): ParseResult<AgentToolReadBounds> {
  const errors: ParseError[] = [];
  const read = (field: FieldWithDefault): number =>
    parseFieldOrDefault(field, env[field.key], errors) ?? field.default ?? field.min;
  return {
    value: {
      readConcurrency: read(AGENT_TOOL_READ_CONCURRENCY),
      readTimeoutMs: read(AGENT_TOOL_READ_TIMEOUT_MS),
      extendedReadTimeoutMs: read(AGENT_TOOL_READ_EXTENDED_TIMEOUT_MS),
    },
    errors,
  };
}

/**
 * Parse the Kairos wake executor bounds. Same contract as the stream bounds:
 * blank = default, invalid = collected error and the default applies.
 */
export function parseAgentWakeEnv(env: EnvLike): ParseResult<AgentWakeBounds> {
  const errors: ParseError[] = [];
  const wakeConcurrency =
    parseFieldOrDefault(AGENT_WAKE_CONCURRENCY, env[AGENT_WAKE_CONCURRENCY.key], errors)
    ?? AGENT_WAKE_CONCURRENCY.default
    ?? AGENT_WAKE_CONCURRENCY.min;
  return { value: { wakeConcurrency }, errors };
}

function parseFieldOrDefault(
  field: FieldWithDefault,
  raw: string | null | undefined,
  errors: ParseError[],
): number | null {
  if (raw === undefined || raw === null) return field.default;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return field.default;
  const parsed = parseAndValidate(field, trimmed, errors);
  return parsed ?? field.default;
}

function parseAndValidate(field: FieldBase, trimmed: string, errors: ParseError[]): number | null {
  let parsed: number;
  if (field.kind === "int") {
    if (!/^-?\d+$/.test(trimmed)) {
      errors.push({ key: field.key, raw: trimmed, reason: "not_a_number" });
      return null;
    }
    parsed = Number.parseInt(trimmed, 10);
  } else {
    parsed = Number(trimmed);
  }
  if (!Number.isFinite(parsed)) {
    errors.push({ key: field.key, raw: trimmed, reason: "not_a_number" });
    return null;
  }
  if (parsed < field.min || parsed > field.max) {
    errors.push({
      key: field.key,
      raw: trimmed,
      reason: "out_of_range",
      detail: { min: field.min, max: field.max },
    });
    return null;
  }
  return parsed;
}

export function formatParseErrors(prefix: string, errors: readonly ParseError[]): string {
  const lines = errors.map((e) => {
    if (e.reason === "out_of_range") {
      return `  ${e.key}=${JSON.stringify(e.raw)} out of range ${e.detail?.min}..${e.detail?.max}`;
    }
    return `  ${e.key}=${JSON.stringify(e.raw)} not a number`;
  });
  return `${prefix}\n${lines.join("\n")}`;
}
