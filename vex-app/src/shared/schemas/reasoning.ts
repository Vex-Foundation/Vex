/**
 * Shared reasoning-effort transport contract (S6 reasoning-selector).
 *
 * Extracted out of `chat.ts` so BOTH `chat.ts` (submit input) and
 * `sessions.ts` (`SessionModelDto`) can import it without creating a
 * `chat.ts` <-> `sessions.ts` circular import (chat.ts already imports
 * `INITIAL_GOAL_MAX_LENGTH` from sessions.ts).
 *
 * Transport enum is the FULL OpenRouter effort range (verified against the
 * live `/models` catalog — see the reasoning-selector harness plan), wider
 * than what any single model actually supports. Per-model support is
 * expressed by `ReasoningCapability`, resolved by
 * `main/onboarding/provider-model-catalog.ts` from the same catalog fetch
 * and normalized here via `normalizeReasoningCapability`.
 */

import { z } from "zod";

export const REASONING_EFFORT_VALUES = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export const reasoningEffortSchema = z.enum(REASONING_EFFORT_VALUES);
export type ReasoningEffort = z.infer<typeof reasoningEffortSchema>;

function isKnownReasoningEffort(value: string): value is ReasoningEffort {
  return (REASONING_EFFORT_VALUES as readonly string[]).includes(value);
}

// Canonical POSITIVE-effort order used ONLY when the upstream catalog
// reports `supported_efforts: null` (explicit "no restriction" — every
// positive effort OpenRouter defines is allowed). "none" is never part of
// this list: whether "none" (Off) belongs in the FINAL selectable set is
// governed exclusively by `mandatory` (see `normalizeReasoningCapability`
// step 3), never by whether upstream happens to list it.
const CANONICAL_POSITIVE_EFFORT_ORDER: readonly ReasoningEffort[] = [
  "max",
  "xhigh",
  "high",
  "medium",
  "low",
  "minimal",
];

/**
 * Per-model reasoning capability surfaced on `SessionModelDto.reasoning`.
 * `supportedEfforts` is the FINAL, already-normalized selectable set
 * (includes "none"/Off iff the model is not mandatory) — never the raw
 * upstream array. `mandatory` is non-nullable: absent upstream means "not
 * mandatory" (false), same as every other reasoning-capable model.
 */
export const reasoningCapabilitySchema = z
  .object({
    supportedEfforts: z.array(reasoningEffortSchema).readonly(),
    defaultEffort: reasoningEffortSchema.nullable(),
    defaultEnabled: z.boolean().nullable(),
    mandatory: z.boolean(),
  })
  .strict();
export type ReasoningCapability = z.infer<typeof reasoningCapabilitySchema>;

/**
 * Raw upstream reasoning capability, already validated shape-wise by the
 * catalog's narrow row schema (`provider-model-reasoning-hook.ts`) — this
 * type only describes the VALUES this function normalizes, not JSON
 * validation. `undefined` fields mean "key omitted upstream"; `null` means
 * "key present with an explicit null" (OpenRouter's own "no restriction"
 * signal for `supportedEfforts`).
 */
export interface RawReasoningCapability {
  readonly supportedEfforts: ReadonlyArray<string> | null | undefined;
  readonly defaultEffort: string | null | undefined;
  readonly defaultEnabled: boolean | null | undefined;
  readonly mandatory: boolean | null | undefined;
}

/**
 * D3 + D4-set: normalize a model's raw upstream reasoning capability into
 * the FINAL selectable set (or `null` when there is nothing to select).
 *
 * `raw === undefined` means the model's `reasoning` key was absent upstream
 * entirely (non-reasoning model) — no selector, independent of anything
 * below. When `raw` IS present, `supportedEfforts` has 3 distinct upstream
 * states (D3, verbatim):
 *  - OMITTED (`undefined`) → `reasoning: null`. A `reasoning` object present
 *    without its `supported_efforts` field is treated conservatively as "we
 *    don't actually know the selectable set", NOT as "no restriction" —
 *    that stronger claim is reserved for an EXPLICIT `null`.
 *  - `null` → the full POSITIVE canonical set (OpenRouter's own
 *    "no restriction" signal).
 *  - array → D4-set below.
 *
 * Steps for the array/null case (mirror the plan's D4-set algorithm):
 *  1. Positive efforts in provider order — `supportedEfforts: null` uses the
 *     canonical order; an explicit array preserves upstream order.
 *  2. Drop "none" and unrecognized values from that list, then dedupe
 *     (first occurrence wins).
 *  3. If the positive set is empty (empty array / all-unknown /
 *     ["none"]-only) → whole capability normalizes to `null` (never an
 *     Off-only selector).
 *  4. `mandatory` → "none" is NEVER appended, even when upstream's raw
 *     array inconsistently lists it (mandatory strips it regardless).
 *     Otherwise append EXACTLY ONE "none" (Off).
 *  5. `defaultEffort` is clamped to the FINAL set — an upstream default
 *     that isn't a member (e.g. mandatory + `default_effort: "none"`)
 *     normalizes to `null` rather than surfacing an invalid default.
 */
export function normalizeReasoningCapability(
  raw: RawReasoningCapability | undefined,
): ReasoningCapability | null {
  if (raw === undefined) return null;
  if (raw.supportedEfforts === undefined) return null;

  const positiveOrder: ReadonlyArray<string> =
    raw.supportedEfforts === null ? CANONICAL_POSITIVE_EFFORT_ORDER : raw.supportedEfforts;

  const positiveEfforts: ReasoningEffort[] = [];
  for (const value of positiveOrder) {
    if (value === "none") continue;
    if (!isKnownReasoningEffort(value)) continue;
    if (positiveEfforts.includes(value)) continue;
    positiveEfforts.push(value);
  }

  if (positiveEfforts.length === 0) return null;

  const mandatory = raw.mandatory ?? false;
  const supportedEfforts: ReasoningEffort[] = mandatory
    ? positiveEfforts
    : [...positiveEfforts, "none"];

  const defaultEffort =
    typeof raw.defaultEffort === "string" &&
    isKnownReasoningEffort(raw.defaultEffort) &&
    supportedEfforts.includes(raw.defaultEffort)
      ? raw.defaultEffort
      : null;

  return {
    supportedEfforts,
    defaultEffort,
    defaultEnabled: raw.defaultEnabled ?? null,
    mandatory,
  };
}

/**
 * D4 preselect: which effort the selector highlights by default, given a
 * normalized (non-null) capability. Consumed by the composer's selector
 * (W2) — kept here, alongside the normalization it depends on, so both the
 * backend DTO and the UI share ONE tested algorithm instead of
 * re-deriving it.
 *
 * Rules (in order):
 *  1. `defaultEnabled === false` AND not mandatory → preselect Off
 *     ("none"). Mandatory models can never preselect Off.
 *  2. Else the upstream `defaultEffort`, if it survived normalization.
 *  3. Else "medium", if the model supports it.
 *  4. Else the middle entry of the POSITIVE-effort set — never a
 *     synthetic Off.
 */
export function selectDefaultReasoningEffort(
  capability: ReasoningCapability,
): ReasoningEffort {
  const { supportedEfforts, defaultEffort, defaultEnabled, mandatory } = capability;

  if (defaultEnabled === false && !mandatory && supportedEfforts.includes("none")) {
    return "none";
  }
  if (defaultEffort !== null) {
    return defaultEffort;
  }
  if (supportedEfforts.includes("medium")) {
    return "medium";
  }

  const positiveEfforts = supportedEfforts.filter((effort) => effort !== "none");
  const middleIndex = Math.floor((positiveEfforts.length - 1) / 2);
  const middle = positiveEfforts[middleIndex] ?? positiveEfforts[0];
  if (middle !== undefined) return middle;

  // `normalizeReasoningCapability` never returns a capability with zero
  // positive efforts (it returns `null` instead), so a `ReasoningCapability`
  // reaching this function always has at least one. Fail loudly rather than
  // silently guessing if that invariant is ever violated.
  throw new Error(
    "selectDefaultReasoningEffort: capability has no positive efforts — " +
      "normalizeReasoningCapability invariant violated",
  );
}

/**
 * The effort a MISSION actually runs at on a model (Kairos E-1): the request
 * itself when the model supports it, else the nearest HIGHER supported effort,
 * else the model's highest. Mirrors the engine's `raiseReasoningEffort` so the
 * contract card shows exactly what the run will send. A mission never thinks
 * less than its contract asked for.
 */
export function missionRunReasoningEffort(
  requested: ReasoningEffort,
  capability: ReasoningCapability,
): ReasoningEffort {
  const supported = capability.supportedEfforts;
  if (supported.length === 0 || supported.includes(requested)) return requested;
  const rank = REASONING_EFFORT_VALUES.indexOf(requested);
  let higher: ReasoningEffort | null = null;
  let highest: ReasoningEffort | null = null;
  for (const effort of supported) {
    const r = REASONING_EFFORT_VALUES.indexOf(effort);
    if (r > rank && (higher === null || r < REASONING_EFFORT_VALUES.indexOf(higher))) higher = effort;
    if (highest === null || r > REASONING_EFFORT_VALUES.indexOf(highest)) highest = effort;
  }
  return higher ?? highest ?? requested;
}
