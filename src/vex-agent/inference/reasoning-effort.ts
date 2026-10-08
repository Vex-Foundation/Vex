/**
 * Reasoning effort per path (Kairos E-1): what the model supports, how a
 * requested effort is clamped to it, and the effort background calls use.
 *
 * Three paths, three owners:
 *
 *   - Chat: the operator's per-session composer pick (unchanged; never clamped
 *     here, the composer only offers what the model supports).
 *   - Missions: the accepted contract's `reasoningEffort` (default `high`),
 *     raised to a supported level by {@link raiseReasoningEffort}. See
 *     `engine/mission/reasoning-effort.ts`.
 *   - Background calls (compaction summary and chunker, memory judge, entity
 *     extraction, regime worker): {@link withAuxReasoningEffort}, driven by the
 *     one `AUX_REASONING_EFFORT` agent-config field.
 *
 * Whether an effort reaches the wire at all is still decided in ONE place,
 * `buildOpenRouterParams`: nothing is sent unless the model advertises the
 * reasoning parameter (`config.supportsReasoningEffort`).
 */

import {
  AUX_REASONING_EFFORT_DEFAULT,
  parseAuxReasoningEffortEnv,
  type AuxReasoningEffortSetting,
} from "../../lib/agent-config.js";
import type { InferenceConfig, ReasoningEffort, ReasoningEffortSupport } from "./types.js";

/** Every effort, lowest first. Written out so a new level is a compile error in the rank map. */
export const REASONING_EFFORTS: readonly ReasoningEffort[] = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

const EFFORT_RANK: Readonly<Record<ReasoningEffort, number>> = {
  none: 0,
  minimal: 1,
  low: 2,
  medium: 3,
  high: 4,
  xhigh: 5,
  max: 6,
};

/** The effort used for a background call when the model's supported set is unknown. */
export const AUX_FALLBACK_REASONING_EFFORT: ReasoningEffort = "low";

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return typeof value === "string" && (REASONING_EFFORTS as readonly string[]).includes(value);
}

export function reasoningEffortRank(effort: ReasoningEffort): number {
  return EFFORT_RANK[effort];
}

/**
 * Normalize the `/models` catalog row's `reasoning` block (untrusted provider
 * data) into the set of efforts the model accepts, mirroring the host's
 * `normalizeReasoningCapability` so the engine and the composer agree:
 *
 *   - no block, or a block without `supportedEfforts` -> `null` (unknown; the
 *     engine then never clamps, it cannot know better than the request);
 *   - `supportedEfforts: null` -> every positive effort (OpenRouter's
 *     "no allowlist" signal);
 *   - an array -> its known positive members.
 *
 * `none` (reasoning off) is a member exactly when the model is not
 * `mandatory`. A block with no positive effort is unknown (`null`).
 */
export function normalizeReasoningSupport(raw: unknown): ReasoningEffortSupport | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const block = raw as Record<string, unknown>;
  if (!("supportedEfforts" in block) || block.supportedEfforts === undefined) return null;
  const listed = block.supportedEfforts;
  let positive: ReasoningEffort[];
  if (listed === null) {
    positive = REASONING_EFFORTS.filter((e) => e !== "none");
  } else if (Array.isArray(listed)) {
    positive = REASONING_EFFORTS.filter((e) => e !== "none" && listed.includes(e));
  } else {
    return null;
  }
  if (positive.length === 0) return null;
  const mandatory = block.mandatory === true;
  const efforts: ReasoningEffort[] = mandatory ? positive : ["none", ...positive];
  return { efforts };
}

/**
 * Clamp a requested effort to the model's supported set: the request itself
 * when supported, else the NEAREST LOWER supported effort, so a clamp never
 * spends more reasoning than was asked for. Only when the model supports
 * nothing at or below the request is the lowest supported effort used, the
 * closest value the model accepts at all. Unknown support leaves the request
 * unchanged.
 */
export function clampReasoningEffort(
  requested: ReasoningEffort,
  support: ReasoningEffortSupport | null | undefined,
): ReasoningEffort {
  if (support === null || support === undefined || support.efforts.length === 0) return requested;
  if (support.efforts.includes(requested)) return requested;
  const rank = EFFORT_RANK[requested];
  let lower: ReasoningEffort | null = null;
  let lowest: ReasoningEffort | null = null;
  for (const effort of support.efforts) {
    const r = EFFORT_RANK[effort];
    if (r < rank && (lower === null || r > EFFORT_RANK[lower])) lower = effort;
    if (lowest === null || r < EFFORT_RANK[lowest]) lowest = effort;
  }
  return lower ?? lowest ?? requested;
}

/**
 * Raise a requested effort to the model's supported set: the request itself
 * when supported, else the NEAREST HIGHER supported effort, so a mission never
 * thinks less than its contract asked for. Only when the model supports
 * nothing at or above the request is its highest supported effort used, the
 * closest value the model accepts at all. Unknown support leaves the request
 * unchanged. The mission path uses this; background calls keep
 * {@link clampReasoningEffort}, where spending less is the point.
 */
export function raiseReasoningEffort(
  requested: ReasoningEffort,
  support: ReasoningEffortSupport | null | undefined,
): ReasoningEffort {
  if (support === null || support === undefined || support.efforts.length === 0) return requested;
  if (support.efforts.includes(requested)) return requested;
  const rank = EFFORT_RANK[requested];
  let higher: ReasoningEffort | null = null;
  let highest: ReasoningEffort | null = null;
  for (const effort of support.efforts) {
    const r = EFFORT_RANK[effort];
    if (r > rank && (higher === null || r < EFFORT_RANK[higher])) higher = effort;
    if (highest === null || r > EFFORT_RANK[highest]) highest = effort;
  }
  return higher ?? highest ?? requested;
}

/**
 * The lowest effort the model accepts: `none` only where the model allows
 * reasoning to be switched off, otherwise its lowest positive effort. With an
 * unknown set, {@link AUX_FALLBACK_REASONING_EFFORT}.
 */
export function lowestSupportedReasoningEffort(
  support: ReasoningEffortSupport | null | undefined,
): ReasoningEffort {
  if (support === null || support === undefined || support.efforts.length === 0) {
    return AUX_FALLBACK_REASONING_EFFORT;
  }
  let lowest = support.efforts[0] ?? AUX_FALLBACK_REASONING_EFFORT;
  for (const effort of support.efforts) {
    if (EFFORT_RANK[effort] < EFFORT_RANK[lowest]) lowest = effort;
  }
  return lowest;
}

/**
 * The effort a background call sends for `setting`, or `undefined` for
 * "send none, the provider default applies" (`provider`, or a model that does
 * not advertise the reasoning parameter).
 */
export function resolveAuxReasoningEffort(
  config: Pick<InferenceConfig, "supportsReasoningEffort" | "reasoningSupport">,
  setting: AuxReasoningEffortSetting,
): ReasoningEffort | undefined {
  if (!config.supportsReasoningEffort) return undefined;
  if (setting === "provider") return undefined;
  if (setting === "lowest") return lowestSupportedReasoningEffort(config.reasoningSupport);
  return clampReasoningEffort(setting, config.reasoningSupport);
}

/** Read the `AUX_REASONING_EFFORT` setting; an invalid value falls back to the default (startup validation reports it). */
export function readAuxReasoningEffortSetting(
  env: Readonly<Record<string, string | undefined>> = process.env,
): AuxReasoningEffortSetting {
  const parsed = parseAuxReasoningEffortEnv(env);
  return parsed.error === null ? parsed.value : AUX_REASONING_EFFORT_DEFAULT;
}

function carriesReasoningGate(value: unknown): value is InferenceConfig {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Partial<InferenceConfig>).supportsReasoningEffort === "boolean"
  );
}

/**
 * A copy of `config` carrying the background-call effort. Every background
 * caller routes its config through here right before the provider call, so
 * the aux effort is one decision, not five.
 *
 * Generic over the value because the background workers' structural provider
 * interfaces type the loaded config as `unknown`: a value that is not an
 * inference config (a test double) is returned unchanged.
 */
export function withAuxReasoningEffort<T>(
  config: T,
  setting: AuxReasoningEffortSetting = readAuxReasoningEffortSetting(),
): T {
  if (!carriesReasoningGate(config)) return config;
  const effort = resolveAuxReasoningEffort(config, setting);
  const copy = { ...config };
  if (effort === undefined) {
    delete copy.reasoningEffort;
  } else {
    copy.reasoningEffort = effort;
  }
  return copy;
}
