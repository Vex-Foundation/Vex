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

import { hyperliquidMissionRiskSchema, type HyperliquidMissionRisk } from "../../../lib/hyperliquid-policy.js";
import type { MissionDraft } from "../types.js";

/** Bumped when the canonical shape or hashing rules change. */
export const CONTRACT_HASH_VERSION = 2;
export const LEGACY_CONTRACT_HASH_VERSION = 1;
export type ContractHashVersion = typeof LEGACY_CONTRACT_HASH_VERSION | typeof CONTRACT_HASH_VERSION;

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

const CanonicalContractMaterialV2Schema = CanonicalContractMaterialV1Schema.omit({ v: true }).extend({
  v: z.literal(CONTRACT_HASH_VERSION),
  hyperliquidRisk: hyperliquidMissionRiskSchema.nullable(),
}).strict();

export type CanonicalContractMaterial = z.infer<typeof CanonicalContractMaterialV1Schema> | z.infer<typeof CanonicalContractMaterialV2Schema>;

function normalizeNullableString(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
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
    // A v1 contract cannot carry risk: accepting it would omit safety-critical
    // material from the hash. Existing accepted v1 rows have `null` by design.
    if (draft.hyperliquidRisk !== null && draft.hyperliquidRisk !== undefined) {
      throw new Error("Hyperliquid mission risk requires contract hash version 2.");
    }
    return CanonicalContractMaterialV1Schema.parse({ v: LEGACY_CONTRACT_HASH_VERSION, ...base });
  }
  return CanonicalContractMaterialV2Schema.parse({
    v: CONTRACT_HASH_VERSION,
    ...base,
    hyperliquidRisk: normalizeHyperliquidRisk(draft.hyperliquidRisk),
  });
}

function normalizeHyperliquidRisk(value: HyperliquidMissionRisk | null | undefined): HyperliquidMissionRisk | null {
  if (value === null || value === undefined) return null;
  const parsed = hyperliquidMissionRiskSchema.parse(value);
  return {
    ...parsed,
    ...(parsed.marketAllowlist === undefined
      ? {}
      : { marketAllowlist: [...new Set(parsed.marketAllowlist.map((coin) => coin.trim().toUpperCase()))].sort() }),
  };
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
): string {
  const material = buildContractMaterial(draft, version);
  const canonical = canonicalStringify(material);
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}
