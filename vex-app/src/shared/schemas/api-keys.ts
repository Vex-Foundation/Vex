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
 *   - RELAY_API_KEY (optional) — bridging works fully WITHOUT it; a key only
 *     raises Relay's rate limits. It is deliberately not a tool prerequisite,
 *     so no relay manifest declares it as a required env.
 *   - LIGHTER_*_READ_ONLY_AUTH_TOKEN (optional) — read-only account tokens
 *     used by Lighter account reads and order previews. These are not trading
 *     API private keys and cannot sign or submit orders.
 */

import { z } from "zod";

const optionalSecret = z.string().min(1).optional();

export const apiKeysSetInputSchema = z
  .object({
    jupiterApiKey: optionalSecret,
    tavilyApiKey: optionalSecret,
    rettiwtApiKey: optionalSecret,
    relayApiKey: optionalSecret,
    lighterCoreReadOnlyToken: optionalSecret,
    lighterRhcReadOnlyToken: optionalSecret,
  })
  .strict();

export type ApiKeysSetInput = z.infer<typeof apiKeysSetInputSchema>;

/**
 * Canonical .env key names that may appear in `fieldsWritten` — order
 * matches the deterministic write order in `api-keys-writer.ts`.
 */
export const API_KEYS_CANONICAL_ORDER = [
  "JUPITER_API_KEY",
  "TAVILY_API_KEY",
  "RETTIWT_API_KEY",
  "RELAY_API_KEY",
  "LIGHTER_CORE_READ_ONLY_AUTH_TOKEN",
  "LIGHTER_RHC_READ_ONLY_AUTH_TOKEN",
] as const;

export const apiKeysFieldNameSchema = z.enum(API_KEYS_CANONICAL_ORDER);

export const apiKeysSetResultSchema = z
  .object({
    fieldsWritten: z.array(apiKeysFieldNameSchema).readonly(),
  })
  .strict();

export type ApiKeysSetResult = z.infer<typeof apiKeysSetResultSchema>;
