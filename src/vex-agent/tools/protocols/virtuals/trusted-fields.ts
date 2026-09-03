/**
 * Trusted-field validators for the Virtuals projector boundary.
 *
 * The tolerant client validation (`@tools/virtuals/validation.ts`) only
 * normalizes TYPES (string/number/null) - the VALUES are still untrusted
 * upstream data. This module narrows structural strings into TRUSTED SHAPES
 * before they are projected into model-facing tool output:
 *
 *   - enums (chain / agent status / factory) - closed allowlists; an unknown
 *     value becomes `null` (the projector adds a degrade note), NEVER a
 *     pass-through;
 *   - timestamps - must parse as a date and are RE-SERIALIZED to canonical
 *     ISO (the output string is ours, not upstream's);
 *   - addresses - EVM `0x` + 40 hex, or Solana base58 (32-44); else null;
 *   - identifiers (genesis ids/statuses) - strict `[A-Za-z0-9_-]` token;
 *   - URLs - https-only, bounded length, strict URI charset (no quotes,
 *     angle brackets, backticks, whitespace); invalid ⇒ dropped (null).
 *
 * Anything that fails validation is dropped to `null` - hostile payloads in
 * structural fields can never reach the model. Free-text fields are NOT
 * handled here; those go through `sanitizeForSystemPrompt` + hard caps in
 * `projectors.ts`.
 */

import { VIRTUALS_CHAINS, type VirtualsChain } from "@tools/virtuals/types.js";

// ── Closed enums (live-verified value sets) ─────────────────────────

export const TRUSTED_AGENT_STATUSES = ["UNDERGRAD", "AVAILABLE"] as const;
export type TrustedAgentStatus = (typeof TRUSTED_AGENT_STATUSES)[number];

export const TRUSTED_FACTORIES = ["BONDING_V5", "BONDING", "OLD"] as const;
export type TrustedFactory = (typeof TRUSTED_FACTORIES)[number];

/** Narrow to a member of a closed allowlist; unknown ⇒ null (never pass-through). */
export function trustedEnum<T extends string>(
  raw: string | null,
  allowed: readonly T[],
): T | null {
  return raw !== null && (allowed as readonly string[]).includes(raw) ? (raw as T) : null;
}

export function trustedChain(raw: string | null): VirtualsChain | null {
  return trustedEnum(raw, VIRTUALS_CHAINS);
}

export function trustedAgentStatus(raw: string | null): TrustedAgentStatus | null {
  return trustedEnum(raw, TRUSTED_AGENT_STATUSES);
}

export function trustedFactory(raw: string | null): TrustedFactory | null {
  return trustedEnum(raw, TRUSTED_FACTORIES);
}

// ── Timestamps ──────────────────────────────────────────────────────

/**
 * Validate + RE-SERIALIZE a timestamp. The returned string is produced by
 * `Date.toISOString()` - canonical shape, independent of the upstream bytes -
 * so even a leniently-parsed input cannot smuggle text through.
 */
export function trustedIsoTimestamp(raw: string | null): string | null {
  if (!raw || raw.length > 40) return null;
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

// ── Addresses ───────────────────────────────────────────────────────

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/; // base58, mint-length

/** EVM (0x + 40 hex) or Solana base58 address; anything else ⇒ null. */
export function trustedAddress(raw: string | null): string | null {
  if (!raw) return null;
  return EVM_ADDRESS.test(raw) || SOLANA_ADDRESS.test(raw) ? raw : null;
}

// ── Identifiers ─────────────────────────────────────────────────────

/** Strict token: letters/digits/underscore/hyphen, bounded. Else null. */
export function trustedIdentifier(raw: string | null, maxLen = 40): string | null {
  if (!raw || raw.length > maxLen) return null;
  return /^[A-Za-z0-9_-]+$/.test(raw) ? raw : null;
}

// ── URLs ────────────────────────────────────────────────────────────

const MAX_URL_LENGTH = 200;
/** Strict URI charset - no quotes, angle brackets, backticks, backslash, whitespace. */
const SAFE_URL_CHARS = /^[A-Za-z0-9._~:/?#[\]@!$&'()*+,;=%-]+$/;

/**
 * https-only, bounded, strict-charset URL. Invalid ⇒ null (dropped).
 * The charset excludes every character `sanitizeForSystemPrompt` would need
 * to neutralize, so a value passing here is injection-inert by construction.
 */
export function trustedHttpsUrl(raw: string | null): string | null {
  if (!raw || raw.length > MAX_URL_LENGTH) return null;
  if (!SAFE_URL_CHARS.test(raw)) return null;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  return parsed.protocol === "https:" ? raw : null;
}
