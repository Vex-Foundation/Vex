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
