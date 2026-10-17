/**
 * AgentCoreStep form-state helpers - extracted from
 * `AgentCoreStep.tsx` to keep the screen file under the 400-LOC
 * scalability ceiling (V2 refactor).
 *
 * The form models each tunable field as a discriminated union:
 *
 *   - `{ kind: "unchanged" }` - no edit; .env keeps its current value
 *   - `{ kind: "set", raw: string }` - submitted as a parsed number
 *   - `{ kind: "clear" }` - submitted as `null`, REMOVED from .env
 *     (engine falls back to its compile-time default)
 *
 * The distinction matters: a parse failure must NOT silently turn
 * into a `null` (which would CLEAR the key - codex DRIFT #1).
 * `fieldToPayload` returns `ok: false` on parse failure so the
 * caller surfaces a validation error instead of submitting.
 *
 * Pure module - no React imports, fully unit-testable, no JSX.
 */

import type { AgentCoreConfigureInput } from "@shared/schemas/agent-core.js";

export type FieldState =
  | { readonly kind: "unchanged" }
  | { readonly kind: "set"; readonly raw: string }
  | { readonly kind: "clear" };

export interface FormState {
  contextLimit: FieldState;
  maxOutputTokens: FieldState;
  temperature: FieldState;
}

export const INITIAL_FORM_STATE: FormState = {
  contextLimit: { kind: "unchanged" },
  maxOutputTokens: { kind: "unchanged" },
  temperature: { kind: "unchanged" },
};

type FieldOutcome =
  | { ok: true; value: number | null | undefined }
  | { ok: false };

function fieldToPayload(
  state: FieldState,
  parser: (raw: string) => number | null,
): FieldOutcome {
  if (state.kind === "unchanged") return { ok: true, value: undefined };
  if (state.kind === "clear") return { ok: true, value: null };
  const parsed = parser(state.raw.trim());
  if (parsed === null) return { ok: false };
  return { ok: true, value: parsed };
}

export function parseInteger(raw: string): number | null {
  if (!/^-?\d+$/.test(raw)) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
}

export function parseFloatStrict(raw: string): number | null {
  if (raw.length === 0) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

export type BuildResult =
  | { ok: true; input: AgentCoreConfigureInput }
  | { ok: false; invalidLabels: string[] };

export const FIELD_LABELS: Record<keyof FormState, string> = {
  contextLimit: "Agent context limit",
  maxOutputTokens: "Agent max output tokens",
  temperature: "Agent temperature",
};

export function buildPayload(form: FormState): BuildResult {
  const invalid: string[] = [];

  const collect = <K extends keyof FormState>(
    key: K,
    parser: (raw: string) => number | null,
  ): number | null | undefined => {
    const outcome = fieldToPayload(form[key], parser);
    if (!outcome.ok) {
      invalid.push(FIELD_LABELS[key]);
      return undefined;
    }
    return outcome.value;
  };

  const ctxLimit = collect("contextLimit", parseInteger);
  const maxOut = collect("maxOutputTokens", parseInteger);
  const temp = collect("temperature", parseFloatStrict);

  if (invalid.length > 0) return { ok: false, invalidLabels: invalid };

  const input: AgentCoreConfigureInput = {
    ...(ctxLimit !== undefined ? { contextLimit: ctxLimit } : {}),
    ...(maxOut !== undefined ? { maxOutputTokens: maxOut } : {}),
    ...(temp !== undefined ? { temperature: temp } : {}),
  };
  return { ok: true, input };
}

export function pendingSummary(form: FormState): {
  sets: number;
  clears: number;
} {
  let sets = 0;
  let clears = 0;
  for (const state of Object.values(form)) {
    if (state.kind === "set" && state.raw.trim().length > 0) sets += 1;
    else if (state.kind === "clear") clears += 1;
  }
  return { sets, clears };
}
