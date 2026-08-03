/**
 * Strict param-boundary validation (B-002) for protocol `execute_tool`.
 *
 * Extracted verbatim from `../runtime.ts` as part of a façade-preserving
 * structural split. The runtime owns `executeProtocolTool`; this module owns
 * the untrusted-param boundary so the boundary stays in exactly one place.
 */

import { z } from "zod";

import type { ProtocolParamDef, ProtocolToolManifest } from "../types.js";
import { CHAIN_VALUE_PARAM_KEYS } from "../conventions.js";
import { checkBpsParam } from "./bps-param.js";

// ── Strict param-boundary validation (B-002) ─────────────────────
//
// The protocol param surface is an UNTRUSTED boundary: `execute_tool` params
// come straight from the LLM. Pre-B-002 the runtime only checked declared
// params for `required` presence + `typeof`; it let UNKNOWN/extra keys flow
// into handlers untouched and never rejected nested shape drift. This closes
// the boundary with manifest-derived Zod schemas (rule 20 §2): every declared
// key is type-validated by `primitiveSchema(...).safeParse`, and an explicit
// strict-key pass REJECTS any undeclared key with a defined value (the
// `.strict()` equivalent)
// before the handler is invoked. We keep the strict-key + required checks
// separate from Zod's per-field parse so the exact pre-B-002 messages and the
// "empty-string/null = missing" semantics are preserved byte-for-byte.
//
// Manifest params are primitive-only today (`string | number | boolean`), so
// the generated schemas are flat. `primitiveSchema` is deliberately written
// with an exhaustiveness guard so a future manifest declaring a nested
// `object`/`array` param must map to a recursive Zod schema HERE rather than
// fall through — the boundary stays at runtime.ts and never silently passes
// nested/extra keys.

/** Runtime-owned control keys recognised regardless of manifest declaration. */
//
// `dryRun` is read by the runtime ITSELF (`isPreviewExecution`) before the
// handler runs, so it is part of the runtime contract, not a per-handler param.
// Every production tool that supports preview ALSO declares `dryRun` in its
// manifest; this set only guarantees the runtime's own control key is never
// rejected as "unknown" even for a manifest that omits the declaration.
export const RESERVED_RUNTIME_PARAM_KEYS: ReadonlySet<string> = new Set(["dryRun"]);

/** Map a primitive `ProtocolParamDef.type` to its base Zod schema. */
export function primitiveSchema(type: ProtocolParamDef["type"]): z.ZodTypeAny {
  switch (type) {
    case "string":
      return z.string();
    case "number":
      return z.number();
    case "boolean":
      return z.boolean();
    case "object":
      return z.record(z.string(), z.unknown());
    default:
      // Exhaustiveness guard — a new param `type` must extend this mapping
      // (e.g. nested object/array → recursive schema) rather than fall through.
      return assertNeverParamType(type);
  }
}

export function assertNeverParamType(value: never): never {
  throw new Error(`Unhandled protocol param type: ${String(value)}`);
}

/**
 * The `acceptsStringArray` branch of the type gate — VALIDATION ONLY.
 *
 * Returns a rejection reason, or `null` when the value is an acceptable array.
 * It deliberately does NOT transform: the handler keeps receiving the params
 * object exactly as the model sent it, so a downstream reader (and anything that
 * hashes or captures the call) sees one untouched input rather than a shape this
 * gate silently rewrote.
 *
 * A non-string member is named BY POSITION. "chainIds must be strings" leaves an
 * agent re-sending the same 12-element array with the same mistake in it.
 */
function checkStringArrayParam(
  toolId: string,
  key: string,
  value: readonly unknown[],
): string | null {
  if (value.length === 0) {
    return `Parameter "${key}" for ${toolId} was an empty array. Supply at least one value, `
      + "or omit the parameter — an empty list cannot mean both 'none' and 'no filter'.";
  }
  for (const [index, member] of value.entries()) {
    if (typeof member !== "string") {
      return `Parameter "${key}" for ${toolId} accepts a string or an array of strings, but the `
        + `item at index ${index} is ${member === null ? "null" : typeof member}.`;
    }
  }
  return null;
}

/**
 * Outcome of strict param validation. `ok` carries no payload — the runtime
 * keeps operating on the already-validated `params` object; this is a boundary
 * gate, not a transform.
 */
export type ParamValidation =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

/**
 * The missing-required rejection, in the shape the model can act on in ONE
 * retry (SPEC §1.5; `reports/model-research.md` §4.4).
 *
 * `Missing required parameter "query" for dexscreener.search` was true and
 * unusable: a model that had just sent `query` at the TOP level of the
 * envelope, not inside `params`, reads it as false and repeats the same call —
 * observed six times in a row. Naming the required keys, the optional keys, the
 * keys WE actually received, and a corrected minimal call ends the loop by
 * SHOWING the envelope instead of describing it.
 *
 * The example is built from the manifest's own authored `exampleParams`, so it
 * is a call that genuinely works; a required key the manifest forgot to
 * exemplify degrades to a typed placeholder rather than an invented value.
 *
 * KEYS ONLY, never values, on the "you sent" lane (rule 06): a param value can
 * carry untrusted or secret-adjacent content, a key name cannot.
 */
function describeMissingRequired(
  manifest: ProtocolToolManifest,
  param: ProtocolParamDef,
  params: Record<string, unknown>,
): string {
  const requiredParams = manifest.params.filter((p) => p.required === true);
  const optional = manifest.params.filter((p) => p.required !== true).map((p) => p.key);
  const sent = Object.keys(params).filter((key) => params[key] !== undefined);
  const example = JSON.stringify({
    toolId: manifest.toolId,
    params: Object.fromEntries(
      requiredParams.map((p) => [
        p.key,
        manifest.exampleParams[p.key] ?? `<${p.type}>`,
      ] as const),
    ),
  });
  return `Missing required parameter "${param.key}" (${param.type}) for ${manifest.toolId}. `
    + `Required: ${requiredParams.map((p) => p.key).join(", ")}. `
    + `Optional: ${optional.join(", ") || "(none)"}. `
    + `Send: ${example}. `
    + `You sent params keys: [${sent.join(", ")}]. `
    + `Do not repeat the previous call — add "${param.key}" inside "params" and call once.`;
}

/**
 * The one sentence a mutually exclusive param group is stated in — authored
 * HERE so the rule the model reads in `discover_tools` (`constraints`) and the
 * rule it is rejected by are word-for-word the same rule.
 */
export function describeExclusiveParamGroup(group: readonly string[]): string {
  return `Provide exactly one of: ${group.join(", ")}.`;
}

/** Every declared group of `manifest`, rendered. Empty when none are declared. */
export function describeExclusiveParamGroups(manifest: ProtocolToolManifest): string[] {
  return (manifest.exclusiveParamGroups ?? []).map(describeExclusiveParamGroup);
}

/**
 * Closed-value-set check. Names the ALLOWED values — a rejection that withholds
 * them costs the agent another call — and never echoes what was sent, which is
 * untrusted string content (rule 06). Arrays are checked member-wise, by
 * position, for the same reason `checkStringArrayParam` names the index.
 */
function checkEnumParam(
  toolId: string,
  param: ProtocolParamDef,
  value: unknown,
): string | null {
  const allowed = param.enum;
  if (!allowed || allowed.length === 0) return null;
  const suffix = `Allowed values for "${param.key}" on ${toolId}: ${allowed.join(", ")} `
    + "(exact match, case-sensitive).";

  if (Array.isArray(value)) {
    for (const [index, member] of value.entries()) {
      if (typeof member === "string" && allowed.includes(member)) continue;
      return `Parameter "${param.key}" for ${toolId} has an unsupported value at index ${index}. ${suffix}`;
    }
    return null;
  }
  if (typeof value === "string" && allowed.includes(value)) return null;
  return `Parameter "${param.key}" for ${toolId} has an unsupported value. ${suffix}`;
}

/**
 * Mutual exclusion, enforced once for the whole manifest instead of in each
 * handler that remembered to. Names the GROUP, not the offending key: an agent
 * told only that `tokenAddress` is unexpected cannot tell that `pairAddress`
 * was the alternative it should have kept.
 *
 * KEYS ONLY on the "you sent" lane (rule 06).
 */
function checkExclusiveParamGroups(
  manifest: ProtocolToolManifest,
  params: Record<string, unknown>,
): string | null {
  const groups = manifest.exclusiveParamGroups;
  if (!groups || groups.length === 0) return null;

  for (const group of groups) {
    const present = group.filter((key) => {
      const value = params[key];
      return value !== undefined && value !== null && value !== "";
    });
    if (present.length === 1) continue;
    const problem = present.length === 0
      ? `none of them is set`
      : `you sent ${present.length}: [${present.join(", ")}]`;
    return `Parameters ${group.map((key) => `"${key}"`).join(", ")} for ${manifest.toolId} `
      + `are mutually exclusive and ${problem}. ${describeExclusiveParamGroup(group)}`;
  }
  return null;
}

/**
 * W6f — a chain param that arrived as a JSON NUMBER becomes its decimal string.
 *
 * The ONLY normalization this gate performs, and deliberately the narrowest one
 * that closes a real failure: every chain-valued param advertises
 * "slug or the numeric chain id `token_find` returns" (see
 * `conventions.ts::CANONICAL_CHAIN_SENTENCE`), so a model that read the
 * description and sent `{chain: 8453}` wrote a legal value in the wrong JSON
 * type and was rejected for it.
 *
 * Bounded by the {@link CHAIN_VALUE_PARAM_KEYS} allowlist AND by the manifest's
 * own `type: "string"` declaration: every other param keeps strict typing, so a
 * number for a non-chain string param is still rejected. Amounts can never be
 * reached — they are not chain keys.
 *
 * It MUTATES the caller's params object on purpose: the handler, the capture
 * row, and this gate must all see one identical value. Returns the coerced keys
 * for the caller's log.
 */
function normalizeChainValueParams(
  manifest: ProtocolToolManifest,
  params: Record<string, unknown>,
): void {
  for (const param of manifest.params) {
    if (param.type !== "string") continue;
    if (!CHAIN_VALUE_PARAM_KEYS.includes(param.key)) continue;
    const value = params[param.key];
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) continue;
    params[param.key] = String(value);
  }
}

/**
 * Validate `params` against `manifest.params` at the trust boundary.
 *
 * Order (each fails closed BEFORE the handler runs):
 *  0. CHAIN normalization — the single transform in this gate; see
 *     `normalizeChainValueParams`.
 *  1. UNKNOWN keys — any key with a DEFINED value that is neither declared nor
 *     runtime-reserved is rejected. A key whose value is `undefined` is treated
 *     as absent (JSON/storage semantics) and skipped, not rejected.
 *  2. REQUIRED presence — `undefined | null | ""` for a required param is
 *     "missing" (preserves the pre-B-002 empty-string-as-absent semantics so
 *     an empty optional is allowed and an empty required is rejected).
 *  3. TYPE — a PRESENT param whose value fails its declared primitive schema is
 *     rejected. Missing optionals are not type-checked.
 *  4. ENUM — a param declaring a closed value set rejects anything off it,
 *     naming the allowed values.
 *  5. UNIT — a param declaring a domain unit (`unit: "bps"`) must additionally
 *     satisfy that unit's contract. `z.number()` accepts `0.5`, but a
 *     fractional basis-point value is meaningless at every venue and is
 *     actively dangerous at Jupiter (see `./bps-param.ts`). Runs after the type
 *     gate so the value is already proven to be a number.
 *  6. EXCLUSIVITY — each declared `exclusiveParamGroups` group must have exactly
 *     one member present. Runs LAST: a group is about the CALL, not a value.
 *
 * Messages are agent-actionable and contain only the offending KEY + declared
 * type — never a string value (which could carry untrusted/secret-adjacent
 * content). The `unit` rejection additionally echoes the offending NUMBER,
 * which is inert by construction; see `checkBpsParam`.
 */
export function validateProtocolParams(
  manifest: ProtocolToolManifest,
  params: Record<string, unknown>,
): ParamValidation {
  const declared = new Map(manifest.params.map((p) => [p.key, p] as const));

  // 0. Chain-key number→string normalization (W6f) — see the function's doc for
  // why this one transform lives inside an otherwise pure gate.
  normalizeChainValueParams(manifest, params);

  // 1. Strict unknown-key rejection.
  for (const key of Object.keys(params)) {
    // A key whose value is `undefined` is equivalent to an absent key: JSON
    // drops it, LLM tool-call params arrive via JSON.parse and never carry
    // `undefined`, and capture/storage already normalises `undefined` away.
    // Treat it as absent rather than an "unknown key"; a real unknown VALUE is
    // still rejected here, and a wrong-typed declared value is still rejected below.
    if (params[key] === undefined) continue;
    if (!declared.has(key) && !RESERVED_RUNTIME_PARAM_KEYS.has(key)) {
      return {
        ok: false,
        reason:
          `Unknown parameter "${key}" for ${manifest.toolId}. `
          + `Allowed parameters: ${manifest.params.map((p) => p.key).join(", ") || "(none)"}.`,
      };
    }
  }

  // 2 + 3. Per-declared-param required presence + strict type.
  for (const param of manifest.params) {
    const value = params[param.key];
    const missing = value === undefined || value === null || value === "";
    if (param.required && missing) {
      return { ok: false, reason: describeMissingRequired(manifest, param, params) };
    }
    if (missing) continue; // optional + absent — not type-checked

    if (Array.isArray(value)) {
      // `typeof [] === "object"`, so the generic message below would tell an
      // agent that sent a list that we expected a string and got an "object" —
      // true, unhelpful, and the exact wording that cost a call in the persona
      // gate. Both branches name the array explicitly.
      if (param.acceptsStringArray !== true) {
        return {
          ok: false,
          reason:
            `Parameter "${param.key}" for ${manifest.toolId} has invalid type: `
            + `expected ${param.type}, got array — this parameter takes a single value, not a list.`,
        };
      }
      const violation = checkStringArrayParam(manifest.toolId, param.key, value);
      if (violation) return { ok: false, reason: violation };
      const offList = checkEnumParam(manifest.toolId, param, value);
      if (offList) return { ok: false, reason: offList };
      continue; // validated as a list; the primitive schema does not apply
    }

    const parsed = primitiveSchema(param.type).safeParse(value);
    if (!parsed.success) {
      return {
        ok: false,
        reason:
          `Parameter "${param.key}" for ${manifest.toolId} has invalid type: `
          + `expected ${param.type}, got ${typeof value}`,
      };
    }

    // 4. Closed value set. Runs after the type gate so the value is already
    // proven to be a string.
    const offList = checkEnumParam(manifest.toolId, param, value);
    if (offList) return { ok: false, reason: offList };

    // 5. Domain-unit contract. `unit` is only meaningful on a numeric param;
    // the `typeof` guard keeps a mis-declared manifest from crashing the gate
    // (`protocol-manifest-bps-units.test.ts` fails the build for that case).
    if (param.unit === "bps" && typeof value === "number") {
      const violation = checkBpsParam(manifest.toolId, param.key, value);
      if (violation) return { ok: false, reason: violation };
    }
  }

  // 6. Cross-param exclusivity, once for the manifest.
  const exclusivityViolation = checkExclusiveParamGroups(manifest, params);
  if (exclusivityViolation) return { ok: false, reason: exclusivityViolation };

  return { ok: true };
}
