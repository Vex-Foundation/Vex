/**
 * Strict param-boundary validation (B-002) for protocol `execute_tool`.
 *
 * Extracted verbatim from `../runtime.ts` as part of a façade-preserving
 * structural split. The runtime owns `executeProtocolTool`; this module owns
 * the untrusted-param boundary so the boundary stays in exactly one place.
 */

import { z } from "zod";

import type { ProtocolParamDef, ProtocolToolManifest } from "../types.js";

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
 * Outcome of strict param validation. `ok` carries no payload — the runtime
 * keeps operating on the already-validated `params` object; this is a boundary
 * gate, not a transform.
 */
export type ParamValidation =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

/**
 * Validate `params` against `manifest.params` at the trust boundary.
 *
 * Order (each fails closed BEFORE the handler runs):
 *  1. UNKNOWN keys — any key with a DEFINED value that is neither declared nor
 *     runtime-reserved is rejected. A key whose value is `undefined` is treated
 *     as absent (JSON/storage semantics) and skipped, not rejected.
 *  2. REQUIRED presence — `undefined | null | ""` for a required param is
 *     "missing" (preserves the pre-B-002 empty-string-as-absent semantics so
 *     an empty optional is allowed and an empty required is rejected).
 *  3. TYPE — a PRESENT param whose value fails its declared primitive schema is
 *     rejected. Missing optionals are not type-checked.
 *
 * Messages are agent-actionable and contain only the offending KEY + declared
 * type — never a value (which could carry untrusted/secret-adjacent content).
 */
export function validateProtocolParams(
  manifest: ProtocolToolManifest,
  params: Record<string, unknown>,
): ParamValidation {
  const declared = new Map(manifest.params.map((p) => [p.key, p] as const));

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
      return {
        ok: false,
        reason: `Missing required parameter "${param.key}" for ${manifest.toolId}`,
      };
    }
    if (missing) continue; // optional + absent — not type-checked

    const parsed = primitiveSchema(param.type).safeParse(value);
    if (!parsed.success) {
      return {
        ok: false,
        reason:
          `Parameter "${param.key}" for ${manifest.toolId} has invalid type: `
          + `expected ${param.type}, got ${typeof value}`,
      };
    }
  }

  return { ok: true };
}
