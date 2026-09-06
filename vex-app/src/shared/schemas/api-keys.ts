/**
 * Schemas for `vex.onboarding.apiKeysSet` (M9 Step 3).
 *
 * Field set:
 *   - JUPITER_API_KEY (optional in input — user may already have it
 *     set; the wizard's Step-3 skip-card uses the
 *     envState `apiKeys.jupiterConfigured` boolean to decide whether
 *     to show the form at all).
 *   - TAVILY_API_KEY (optional)
 *   - RETTIWT_API_KEY (optional)
 *   - RELAY_API_KEY (optional) - bridging works WITHOUT it: a key raises
 *     Relay's per-key rate limits and, measured 2026-09-04 against
 *     `POST api.relay.link/quote/v2`, is what lets a quote carry Relay's
 *     `referrer` attribution field (a keyless body claiming one is answered
 *     401 UNAUTHORIZED_QUOTE, so keyless quotes are sent without it - see
 *     `src/tools/relay/client.ts`). Attribution is the only thing a keyless
 *     deployment gives up; it is deliberately not a tool prerequisite, so no
 *     relay manifest declares it as a required env.
 *   - LIGHTER_*_TRADING_API_PRIVATE_KEY (optional) — one-time import fields
 *     for Lighter credentials. This is the normal one-key Lighter setup:
 *     previews stay read-only, and approval/execution paths remain gated.
 *     These keys are stored only as encrypted-vault extra secrets under an
 *     opaque local reference, never as env keys.
 */

import { z } from "zod";

const optionalSecret = z.string().min(1).optional();
const optionalNonNegativeInteger = z.number().int().nonnegative().optional();
const optionalApiKeyIndex = z.number().int().min(4).max(254).optional();
const optionalBoolean = z.boolean().optional();

export const apiKeysSetInputSchema = z
  .object({
    jupiterApiKey: optionalSecret,
    tavilyApiKey: optionalSecret,
    rettiwtApiKey: optionalSecret,
    relayApiKey: optionalSecret,
    lighterCoreTradingAccountIndex: optionalNonNegativeInteger,
    lighterCoreTradingApiKeyIndex: optionalApiKeyIndex,
    lighterCoreTradingApiPrivateKey: optionalSecret,
    lighterCoreTradingRemove: optionalBoolean,
    lighterRhcTradingAccountIndex: optionalNonNegativeInteger,
    lighterRhcTradingApiKeyIndex: optionalApiKeyIndex,
    lighterRhcTradingApiPrivateKey: optionalSecret,
    lighterRhcTradingRemove: optionalBoolean,
  })
  .strict();

export type ApiKeysSetInput = z.infer<typeof apiKeysSetInputSchema>;

export const MANAGED_API_KEYS_CANONICAL_ORDER = [
  "JUPITER_API_KEY",
  "TAVILY_API_KEY",
  "RETTIWT_API_KEY",
  "RELAY_API_KEY",
] as const;

/**
 * Canonical field names that may appear in `fieldsWritten` — order matches the
 * deterministic write order in `api-keys-writer.ts`. Trading credential fields
 * are local vault extra-secret actions, not process env keys.
 */
export const API_KEYS_CANONICAL_ORDER = [
  ...MANAGED_API_KEYS_CANONICAL_ORDER,
  "LIGHTER_CORE_TRADING_API_PRIVATE_KEY",
  "LIGHTER_RHC_TRADING_API_PRIVATE_KEY",
] as const;

export const apiKeysFieldNameSchema = z.enum(API_KEYS_CANONICAL_ORDER);

export const apiKeysSetResultSchema = z
  .object({
    fieldsWritten: z.array(apiKeysFieldNameSchema).readonly(),
  })
  .strict();

export type ApiKeysSetResult = z.infer<typeof apiKeysSetResultSchema>;
