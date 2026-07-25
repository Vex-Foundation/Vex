/**
 * `agent_activity` token-leg construction for Solana/Jupiter mutations.
 *
 * ONE owner for the money convention an activity row must satisfy: the agent
 * reading its OWN feed has to see the token's `symbol`/`decimals` plus BOTH
 * the exact-decimal human amount AND its raw atomic sibling. A raw mint
 * string next to a bare integer is not readable provenance — verified live on
 * the owner's funded wallet, where lend rows carried only `tokenAddress` +
 * `amountRaw` ("500000") and the agent could not tell it had deposited
 * 0.5 USDC. The `agent_activity` repo stores `amountHuman` VERBATIM
 * (`repos/agent-activity/swap-intent.ts`: `input.tokenIn?.amountHuman ?? null`)
 * and derives nothing, so an omitted field is null forever.
 *
 * Two entry points, one rule:
 *   - `buildActivityTokenLeg` — the caller ALREADY holds the token's
 *     symbol/decimals (a swap's resolved `TokenMetadata`; a Borrow vault's own
 *     `supplyToken`/`borrowToken` descriptor, fetched before `/operate` runs).
 *   - `resolveActivityTokenLeg` — the caller holds only a mint (Lend Earn's
 *     `asset` param), so metadata is resolved through the Jupiter tokens
 *     service (well-known table → process token cache → tokens API).
 *
 * FAIL-SOFT, ALWAYS. Every call site sits on a real-funds signing path and
 * this metadata is provenance, not money movement: a lookup that throws,
 * hangs, or simply has no record of the mint NEVER propagates, never becomes
 * a failure code, and never blocks or meaningfully delays the mutation. The
 * leg degrades to exactly the pre-existing behaviour (`tokenAddress` +
 * `amountRaw`) and the miss is logged.
 *
 * String math only. `amountHuman` is formatted with
 * `atomicToExactDecimalString` (BigInt), never `Number`/`parseFloat`/
 * `tokenAmountToUi` — u64 amounts routinely exceed `Number.MAX_SAFE_INTEGER`
 * and a STORED money field must be exact, not approximate.
 */

import { resolveJupiterToken } from "@tools/solana-ecosystem/jupiter/jupiter-tokens/service.js";
import { atomicToExactDecimalString } from "@tools/solana-ecosystem/shared/solana-validation.js";
import type { TokenMetadata } from "@tools/solana-ecosystem/shared/types.js";
import type { AgentActivityLegInput } from "@vex-agent/db/repos/agent-activity.js";
import { summarizeProtocolError } from "@vex-agent/tools/protocols/runtime/errors.js";
import logger from "@utils/logger.js";

/**
 * A hung tokens API would otherwise hold an already-quoted, funded mutation
 * for the HTTP layer's full 30s default (`utils/http.ts`). The lookup gets its
 * own short deadline and degrades to "unknown metadata" when it expires; the
 * in-flight request is left to finish on its own, still warming the process
 * token cache for the next call.
 */
const METADATA_DEADLINE_MS = 1_500;

export interface ActivityTokenLegSource {
  readonly tokenAddress: string;
  readonly tokenSymbol?: string;
  readonly tokenDecimals?: number;
  /**
   * Atomic base units of the token's own `decimals`. Absent when the magnitude
   * is genuinely unknown in advance — a Borrow close-all/repay-all sentinel is
   * provider-computed, and a pre-broadcast failure may never have had one.
   */
  readonly amountRaw?: string;
}

function logMetadataUnavailable(mint: string, err: unknown): void {
  // `summarizeProtocolError` is the repo's ONE scrub boundary for provider
  // error text reaching a log (`protocols/runtime/errors.ts`).
  logger.warn("activity_token_leg.metadata_unavailable", {
    mint,
    error: summarizeProtocolError(err).message,
  });
}

/**
 * `undefined` when the pair cannot produce an EXACT decimal string. Both
 * inputs are untrusted at this point — `decimals` comes from a provider
 * payload and `amountRaw` may be a provider-computed string — so a bad pair
 * drops the human field rather than corrupting it or throwing.
 */
function exactAmountHuman(amountRaw: string, decimals: number): string | undefined {
  if (!Number.isInteger(decimals) || decimals < 0) return undefined;
  try {
    return atomicToExactDecimalString(BigInt(amountRaw), decimals);
  } catch {
    return undefined;
  }
}

/** Build the leg from metadata the caller already holds. Never throws. */
export function buildActivityTokenLeg(source: ActivityTokenLegSource): AgentActivityLegInput {
  const amountHuman = source.amountRaw !== undefined && source.tokenDecimals !== undefined
    ? exactAmountHuman(source.amountRaw, source.tokenDecimals)
    : undefined;

  return {
    tokenAddress: source.tokenAddress,
    ...(source.tokenSymbol !== undefined ? { tokenSymbol: source.tokenSymbol } : {}),
    ...(source.tokenDecimals !== undefined ? { tokenDecimals: source.tokenDecimals } : {}),
    ...(amountHuman !== undefined ? { amountHuman } : {}),
    ...(source.amountRaw !== undefined ? { amountRaw: source.amountRaw } : {}),
  };
}

async function resolveTokenMetadataWithinDeadline(mint: string): Promise<TokenMetadata | undefined> {
  // The lookup's own rejection is absorbed HERE rather than on the race, so a
  // deadline win can never leave it unhandled at the process level.
  const lookup = resolveJupiterToken(mint).catch((err: unknown) => {
    logMetadataUnavailable(mint, err);
    return undefined;
  });

  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      lookup,
      new Promise<undefined>((resolve) => {
        deadlineTimer = setTimeout(() => {
          logger.debug("activity_token_leg.metadata_deadline_exceeded", { mint });
          resolve(undefined);
        }, METADATA_DEADLINE_MS);
      }),
    ]);
  } finally {
    clearTimeout(deadlineTimer);
  }
}

/**
 * Resolve a mint's symbol/decimals, then build the leg. Never throws and never
 * rejects: an unresolvable mint yields exactly the leg the caller could have
 * built on its own.
 */
export async function resolveActivityTokenLeg(
  mint: string,
  amountRaw?: string,
): Promise<AgentActivityLegInput> {
  let token: TokenMetadata | undefined;
  try {
    token = await resolveTokenMetadataWithinDeadline(mint);
  } catch (err) {
    // Total containment: a cosmetic lookup must never fail a funded mutation.
    logMetadataUnavailable(mint, err);
  }

  return buildActivityTokenLeg({
    tokenAddress: mint,
    ...(token ? { tokenSymbol: token.symbol, tokenDecimals: token.decimals } : {}),
    ...(amountRaw !== undefined ? { amountRaw } : {}),
  });
}
