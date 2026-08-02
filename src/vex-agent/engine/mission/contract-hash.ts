/**
 * Mission contract hash — canonical, deterministic SHA-256 of the
 * runtime-relevant portion of a mission draft.
 *
 * Why a custom canonicalizer:
 *
 *   `JSON.stringify(obj, Object.keys(obj).sort())` only sorts keys at
 *   one depth (replacer signature is `(key, value)` per recursion
 *   level, not "sort everything"). For puzzle 04 the canonical contract
 *   material happens to be flat, but the helper below recurses through
 *   nested objects anyway so the function is safe if/when we widen the
 *   shape (e.g. structured `capitalSource`). RFC 8785 / JCS would be
 *   the official spec; we ship a minimal version sufficient for this
 *   contract.
 *
 * What goes into the hash:
 *
 *   - runtime-affecting fields only: goal, capitalSource, startingCapital,
 *     riskProfile, deadline, allowedWallets, allowedChains, allowedProtocols,
 *     successCriteria, stopConditions
 *   - the version literal `v: 1` so future shape migrations get a new
 *     `contract_hash_version` without quietly producing matching hashes
 *
 * What does NOT go into the hash:
 *
 *   - `title` (display-only; renaming should not invalidate acceptance)
 *   - `approvedAt` (mutable, written by the legacy `setApprovedAt` path)
 *   - mission row metadata (`id`, `rootSessionId`, timestamps)
 *   - raw `capitalSourceJson` blob — only the derived `capitalSource`
 *     + `startingCapital` strings (per codex review on the canonical
 *     contract material)
 *
 * Version history (Agent Scan Phase 3 — Hyperliquid removal):
 *
 *   - v1 — the original shape above, no Hyperliquid material.
 *   - v2 — added a `hyperliquidRisk` envelope while Hyperliquid mutations
 *     were live. FROZEN, never produced for a new draft: the shape and
 *     normalization now live in `contract-hash-legacy-v2.ts`, a standalone
 *     module with zero imports from any live Hyperliquid code. It exists
 *     ONLY so a mission accepted while v2 was current still reproduces its
 *     original hash (`buildContractMaterial`'s `legacyHyperliquidRisk` param,
 *     sourced from `mapper.extractLegacyHyperliquidRiskV2` — `MissionDraft`
 *     itself no longer carries the field).
 *   - v3 — FROZEN. Identical to v1's shape; the version bump existed only so
 *     a mission accepted under v2 is never silently reinterpreted as v3.
 *   - v4 — CURRENT (Trench Express launch, contract C6). Adds the enforceable
 *     autonomous-launch spend ceiling `maxLaunchValueRaw` +
 *     `maxLaunchValueDecimals` to the canonical shape. The bump is MANDATORY,
 *     not cosmetic: without it a v3-accepted mission and a v4 draft carrying a
 *     ceiling would hash identically, so the ceiling would not be bound to
 *     what the user accepted and could be changed without dirtying acceptance.
 *     v4 is declared as its OWN schema rather than by extending
 *     `CanonicalContractMaterialV1Schema`, because v3 derives from that same
 *     V1 schema — extending it would have silently changed BOTH frozen
 *     versions and broken every stored hash.
 *     The ceiling is normalized as a PAIR: unless BOTH parts are well-formed
 *     (raw digits-only string + integer decimals) both hash as `null`, so a
 *     half-written ceiling can never hash as if a limit were in force.
 *
 * Normalization rules:
 *
 *   - whitespace is trimmed; empty strings collapse to `null` (so
 *     "  " and "" and `null` and `undefined` all hash identically)
 *   - `allowedChains` is lowercased + sorted (chain ids are
 *     case-insensitive in repo convention; their order does not affect
 *     runtime)
 *   - `allowedWallets` and `allowedProtocols` are trimmed + sorted
 *     (the set is what matters, not the order)
 *   - `successCriteria` and `stopConditions` preserve user-given
 *     order — they are sequential rules / commitments and reordering
 *     changes intent
 *   - `startingCapital` accepts string only — numeric coercion is
 *     intentionally rejected to avoid lossy float→string conversion
 *     (e.g. `1.0` → `"1"` losing user-meaningful precision). The
 *     `MissionDraft` type already declares the field as `string | null`.
 */

import { createHash } from "node:crypto";
import { z } from "zod";

import type { MissionDraft } from "../types.js";
import {
  CanonicalContractMaterialLegacyV2Schema,
  normalizeLegacyHyperliquidRiskV2,
  type CanonicalContractMaterialLegacyV2,
} from "./contract-hash-legacy-v2.js";

/** Bumped when the canonical shape or hashing rules change. Produced for every new draft. */
export const CONTRACT_HASH_VERSION = 4;
export const LEGACY_CONTRACT_HASH_VERSION = 1;
/**
 * Frozen historical version — see the "Version history" note above. Accepted
 * ONLY for verifying/renewing a mission that was accepted while it was
 * current; `buildContractMaterial` never produces it for a new draft.
 */
export const LEGACY_V2_CONTRACT_HASH_VERSION = 2;
/**
 * Frozen historical version — the pre-C6 shape, structurally identical to v1.
 * Still produced for verifying/renewing a mission accepted while it was
 * current; never produced for a new draft.
 */
export const LEGACY_V3_CONTRACT_HASH_VERSION = 3;
export type ContractHashVersion =
  | typeof LEGACY_CONTRACT_HASH_VERSION
  | typeof LEGACY_V2_CONTRACT_HASH_VERSION
  | typeof LEGACY_V3_CONTRACT_HASH_VERSION
  | typeof CONTRACT_HASH_VERSION;

const CanonicalContractMaterialV1Schema = z.object({
  v: z.literal(LEGACY_CONTRACT_HASH_VERSION),
  goal: z.string().nullable(),
  capitalSource: z.string().nullable(),
  startingCapital: z.string().nullable(),
  riskProfile: z.string().nullable(),
  deadline: z.string().nullable(),
  allowedWallets: z.array(z.string()),
  allowedChains: z.array(z.string()),
  allowedProtocols: z.array(z.string()),
  successCriteria: z.array(z.string()),
  stopConditions: z.array(z.string()),
}).strict();

const CanonicalContractMaterialV3Schema = CanonicalContractMaterialV1Schema.omit({ v: true }).extend({
  v: z.literal(LEGACY_V3_CONTRACT_HASH_VERSION),
}).strict();

/**
 * v4 — v3's fields plus the C6 launch ceiling. Built by `.extend()` on the V1
 * base's FIELDS (never by mutating that schema object), so v1/v3 stay
 * byte-reproducible.
 */
const CanonicalContractMaterialV4Schema = CanonicalContractMaterialV1Schema.omit({ v: true }).extend({
  v: z.literal(CONTRACT_HASH_VERSION),
  maxLaunchValueRaw: z.string().nullable(),
  maxLaunchValueDecimals: z.number().int().nullable(),
}).strict();

export type CanonicalContractMaterial =
  | z.infer<typeof CanonicalContractMaterialV1Schema>
  | CanonicalContractMaterialLegacyV2
  | z.infer<typeof CanonicalContractMaterialV3Schema>
  | z.infer<typeof CanonicalContractMaterialV4Schema>;

function normalizeNullableString(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * Normalize the C6 ceiling as an INSEPARABLE PAIR.
 *
 * A raw amount without its decimals cannot be compared to anything, so a
 * half-written pair must not hash as though a limit were in force. If either
 * part is missing or malformed, BOTH hash as `null` — the same material a
 * mission with no ceiling produces, which is the fail-closed state.
 *
 * `maxLaunchValueRaw` is kept as a STRING and never coerced through a number:
 * a wei ceiling exceeds `Number.MAX_SAFE_INTEGER`, and the same no-float-
 * coercion reasoning already applies to `startingCapital`.
 */
function normalizeLaunchCeiling(
  raw: string | null | undefined,
  decimals: number | null | undefined,
): { maxLaunchValueRaw: string | null; maxLaunchValueDecimals: number | null } {
  const absent = { maxLaunchValueRaw: null, maxLaunchValueDecimals: null };
  const normalizedRaw = normalizeNullableString(raw);
  if (normalizedRaw === null) return absent;
  if (typeof decimals !== "number" || !Number.isInteger(decimals)) return absent;
  if (!/^\d+$/.test(normalizedRaw)) return absent;
  return { maxLaunchValueRaw: normalizedRaw, maxLaunchValueDecimals: decimals };
}

function normalizeStringArray(values: readonly string[] | null | undefined): string[] {
  if (values === null || values === undefined) return [];
  if (!Array.isArray(values)) return [];
  const out: string[] = [];
  for (const raw of values) {
    if (typeof raw !== "string") continue;
    const trimmed = raw.trim();
    if (trimmed.length === 0) continue;
    out.push(trimmed);
  }
  return out;
}

function normalizeChainArray(values: readonly string[] | null | undefined): string[] {
  return normalizeStringArray(values).map((s) => s.toLowerCase());
}

/** Build canonical material for the recorded contract version, never silently upgrading v1. */
export function buildContractMaterial(
  draft: MissionDraft,
  version: ContractHashVersion = CONTRACT_HASH_VERSION,
  /**
   * Raw, untrusted legacy Hyperliquid risk material — consulted ONLY when
   * `version === LEGACY_V2_CONTRACT_HASH_VERSION`. Comes straight off the
   * mission row's `constraints_json` (see `mapper.extractLegacyHyperliquidRiskV2`);
   * `MissionDraft` no longer carries this field for any other version.
   */
  legacyHyperliquidRisk?: unknown,
): CanonicalContractMaterial {
  const base = {
    goal: normalizeNullableString(draft.goal),
    capitalSource: normalizeNullableString(draft.capitalSource),
    startingCapital: normalizeNullableString(draft.startingCapital),
    riskProfile: normalizeNullableString(draft.riskProfile),
    deadline: normalizeNullableString(draft.deadline),
    allowedWallets: [...normalizeStringArray(draft.allowedWallets)].sort(),
    allowedChains: [...normalizeChainArray(draft.allowedChains)].sort(),
    allowedProtocols: [...normalizeStringArray(draft.allowedProtocols)].sort(),
    // successCriteria + stopConditions intentionally preserve order.
    successCriteria: normalizeStringArray(draft.successCriteria),
    stopConditions: normalizeStringArray(draft.stopConditions),
  };
  if (version === LEGACY_CONTRACT_HASH_VERSION) {
    return CanonicalContractMaterialV1Schema.parse({ v: LEGACY_CONTRACT_HASH_VERSION, ...base });
  }
  if (version === LEGACY_V2_CONTRACT_HASH_VERSION) {
    return CanonicalContractMaterialLegacyV2Schema.parse({
      v: LEGACY_V2_CONTRACT_HASH_VERSION,
      ...base,
      hyperliquidRisk: normalizeLegacyHyperliquidRiskV2(legacyHyperliquidRisk),
    });
  }
  if (version === LEGACY_V3_CONTRACT_HASH_VERSION) {
    return CanonicalContractMaterialV3Schema.parse({ v: LEGACY_V3_CONTRACT_HASH_VERSION, ...base });
  }
  return CanonicalContractMaterialV4Schema.parse({
    v: CONTRACT_HASH_VERSION,
    ...base,
    ...normalizeLaunchCeiling(draft.maxLaunchValueRaw, draft.maxLaunchValueDecimals),
  });
}

/**
 * Deterministic JSON serialization: sorts object keys at every depth,
 * uses native `JSON.stringify` for primitives + arrays. Arrays are
 * serialized in given order (caller must pre-sort sets where order is
 * irrelevant — `buildContractMaterial` does so for chain/wallet/
 * protocol arrays).
 */
export function canonicalStringify(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalStringify).join(",") + "]";
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const parts = keys.map((k) => JSON.stringify(k) + ":" + canonicalStringify(obj[k]));
  return "{" + parts.join(",") + "}";
}

/**
 * SHA-256 hex of the canonical material. 64-char lowercase hex
 * string. Two drafts that differ only in whitespace, key ordering, or
 * set ordering produce the same hash; two drafts that differ in
 * runtime-affecting content produce different hashes.
 */
export function computeContractHash(
  draft: MissionDraft,
  version: ContractHashVersion = CONTRACT_HASH_VERSION,
  legacyHyperliquidRisk?: unknown,
): string {
  const material = buildContractMaterial(draft, version, legacyHyperliquidRisk);
  const canonical = canonicalStringify(material);
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}
